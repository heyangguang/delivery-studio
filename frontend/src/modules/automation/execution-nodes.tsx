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
  IconArrowLeft,
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
  IconLink,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSafe,
  IconSearch,
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
  useMedia,
} from "../../shared/shared";
import { go } from "../../app/router";
import { Segmented, StatusBadge } from "../../design/ui";
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
  centerNav,
  fleet = "controllers",
}: {
  centerNav?: React.ReactNode;
  fleet?: FleetTab;
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
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [mobileDetail, setMobileDetail] = useState(false);
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

  const groupedAgents = useMemo(() => {
    const map = new Map<string, AutomationAgentView[]>();
    for (const a of agentRows) {
      const key = a.cluster || bi("未归属集群", "Unassigned");
      const list = map.get(key) || [];
      list.push(a);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [agentRows]);

  const activeNode = useMemo(() => {
    if (!rows.length) return null;
    return rows.find((n) => n.id === selectedNodeId) || rows[0];
  }, [rows, selectedNodeId]);

  const activeAgent = useMemo(() => {
    if (!agentRows.length) return null;
    return agentRows.find((a) => a.id === selectedAgentId) || agentRows[0];
  }, [agentRows, selectedAgentId]);

  const peerAgents = useMemo(() => {
    if (!activeAgent) return [];
    return allAgents.filter((a) => a.cluster === activeAgent.cluster);
  }, [allAgents, activeAgent]);

  const upgradeCmd = `# 1. 将新版执行器上传至控制机（点击上方按钮下载 Linux amd64 二进制）
sudo install -m 0755 middleware-store-linux-amd64 /usr/local/bin/middleware-store
sudo systemctl restart middleware-execution-node
sudo systemctl status middleware-execution-node --no-pager`;

  const showRail = !narrow || !mobileDetail;
  const showDetail = !narrow || mobileDetail;

  return (
    <>
      <div className="md-split">
      {showRail && (
        <aside
          className="md-list"
          aria-label={
            fleet === "controllers"
              ? bi("控制机执行节点列表", "Control host execution nodes")
              : bi("目标机直连 Agent 列表", "Direct target agents")
          }
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
                {canManage && fleet === "controllers" && (
                  <Button size="small" type="primary" icon={<IconPlus />} onClick={begin}>
                    {registration ? bi("继续", "Resume") : bi("接入", "Add")}
                  </Button>
                )}
              </div>
            </div>

            {centerNav}

            {fleet === "controllers" ? (
              <>
                <Input
                  prefix={<IconSearch />}
                  allowClear
                  value={query}
                  onChange={setQuery}
                  placeholder={bi("搜索节点名、IP 或集群", "Search node, IP, or cluster")}
                  aria-label={bi("搜索控制机节点", "Search control nodes")}
                />
                <div className="ec-rail-seg">
                  <Segmented<Filter>
                    size="sm"
                    label={bi("按节点状态筛选", "Filter control nodes")}
                    value={filter === "upgrade" ? "all" : filter}
                    onChange={setFilter}
                    options={[
                      { value: "all", label: bi("全部", "All"), count: counts.all },
                      { value: "online", label: bi("在线", "On"), count: counts.online },
                      { value: "offline", label: bi("离线", "Off"), count: counts.offline },
                      { value: "disabled", label: bi("停用", "Off"), count: counts.disabled },
                    ]}
                  />
                </div>
                {counts.upgrade > 0 && (
                  <button
                    type="button"
                    className={`ec-rail-upgrade-bar ${filter === "upgrade" ? "is-on" : ""}`}
                    onClick={() => setFilter(filter === "upgrade" ? "all" : "upgrade")}
                  >
                    <span>{bi(`${counts.upgrade} 台控制机可升级以支持演练`, `${counts.upgrade} node(s) upgradable`)}</span>
                    <span>{filter === "upgrade" ? bi("显示全部", "Show all") : bi("仅看可升级", "Filter")}</span>
                  </button>
                )}
              </>
            ) : (
              <>
                <Input
                  prefix={<IconSearch />}
                  allowClear
                  value={agentQuery}
                  onChange={setAgentQuery}
                  placeholder={bi("搜索主机名、IP 或所属集群", "Search host, IP, or cluster")}
                  aria-label={bi("搜索目标机 Agent", "Search target agents")}
                />
                <div className="ec-rail-seg">
                  <Segmented<AgentFilter>
                    size="sm"
                    label={bi("按 Agent 状态筛选", "Filter target agents")}
                    value={agentFilter}
                    onChange={setAgentFilter}
                    options={[
                      { value: "all", label: bi("全部", "All"), count: agentCounts.all },
                      { value: "online", label: bi("在线", "On"), count: agentCounts.online },
                      { value: "offline", label: bi("离线", "Off"), count: agentCounts.offline },
                      { value: "revoked", label: bi("撤销", "Rev"), count: agentCounts.revoked },
                    ]}
                  />
                </div>
              </>
            )}
          </div>

          <div className="list-body">
            {fleet === "controllers" ? (
              !nodes && !error ? (
                <div style={{ padding: 14 }}>
                  <Skeleton animation text={{ rows: 4 }} />
                </div>
              ) : rows.length > 0 ? (
                <div className="ec-rail-group">
                  {rows.map((node) => {
                    const st = nodeConnection(node);
                    const oldProto = needsUpgrade(node);
                    const selected = activeNode?.id === node.id;
                    return (
                      <button
                        key={node.id}
                        type="button"
                        className={`ec-rail-row ${selected ? "on" : ""}`}
                        onClick={() => {
                          setSelectedNodeId(node.id);
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
                            ) : (node.protocol || 0) >= 3 ? (
                              <span className="ec-micro-pill is-ok">
                                {bi("就绪", "Ready")}
                              </span>
                            ) : null}
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
              ) : (
                <div className="ec-rail-empty">
                  <IconDesktop />
                  <span>
                    {all.length === 0
                      ? bi("暂无控制机节点", "No control nodes yet")
                      : bi("没有匹配的控制机", "No matching nodes")}
                  </span>
                </div>
              )
            ) : !agents && !agentsError ? (
              <div style={{ padding: 14 }}>
                <Skeleton animation text={{ rows: 5 }} />
              </div>
            ) : groupedAgents.length > 0 ? (
              groupedAgents.map(([clusterName, list]) => (
                <div key={clusterName} className="ec-rail-group">
                  <div className="ec-rail-group-h">
                    <span className="mono">{clusterName}</span>
                    <em>{list.length}</em>
                  </div>
                  {list.map((ag) => {
                    const isRevoked = ag.desired !== "active";
                    const dotCls = isRevoked
                      ? "is-revoked"
                      : ag.online
                        ? "is-online"
                        : "is-offline";
                    const selected = activeAgent?.id === ag.id;
                    return (
                      <button
                        key={ag.id}
                        type="button"
                        className={`ec-rail-row ${selected ? "on" : ""}`}
                        onClick={() => {
                          setSelectedAgentId(ag.id);
                          setMobileDetail(true);
                        }}
                      >
                        <span className={`ec-state-dot ${dotCls}`} />
                        <div className="ec-rail-row-body">
                          <div className="ec-rail-row-top">
                            <b>{ag.host}</b>
                            <span
                              className={`ec-micro-pill ${ag.mode === "direct" ? "is-brand" : ""}`}
                            >
                              {ag.mode === "direct" ? bi("直连", "Direct") : bi("托管", "Trust")}
                            </span>
                          </div>
                          <div className="ec-rail-row-sub">
                            <code className="mono">{ag.ip}</code>
                            <span>
                              {isRevoked
                                ? bi("已撤销", "Revoked")
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
              ))
            ) : (
              <div className="ec-rail-empty">
                <IconLink />
                <span>
                  {allAgents.length === 0
                    ? bi("暂无目标机 Agent", "No target agents yet")
                    : bi("没有匹配的 Agent", "No matching agents")}
                </span>
              </div>
            )}
          </div>
        </aside>
      )}

      {showDetail && (
        <section className="md-detail" aria-live="polite">
          {fleet === "controllers" ? (
            <>
              {error && (
                <div className="detail enter ec-detail-article">
                  <div className="en-error" role="alert">
                    <IconExclamationCircle />
                    <div>
                      <b>{bi("节点状态未能更新", "Failed to refresh node status")}</b>
                      <p>{error}</p>
                    </div>
                    <Button size="small" onClick={() => void load(true)} loading={refreshing}>
                      {bi("重试", "Retry")}
                    </Button>
                  </div>
                </div>
              )}

              {registration && !open && (
                <div className="detail enter ec-detail-article" style={{ paddingBottom: 0 }}>
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
                          {bi("控制机列表", "Control Nodes")}
                        </Button>
                      )}
                      <header className="detail-head">
                        <div className="detail-title">
                          <h1>{activeNode.name}</h1>
                          <StatusBadge
                            state={badgeState}
                            label={nodeStatusLabel(st.key, st.label)}
                          />
                          <span className="ec-micro-pill">
                            {activeNode.kind === "independent"
                              ? bi("独立管理机", "Dedicated Control Host")
                              : bi("集群内执行机", "In-Cluster Host")}
                          </span>
                          {oldProto ? (
                            <span className="ec-micro-pill is-upgrade">
                              {bi("可升级", "Upgrade")}
                            </span>
                          ) : (activeNode.protocol || 0) >= 3 ? (
                            <span className="ec-micro-pill is-ok">
                              {bi("完整自动化就绪", "Full Automation Ready")}
                            </span>
                          ) : null}
                        </div>
                        <div className="detail-meta">
                          <code className="mono">{activeNode.controller_ip}</code>
                          {activeNode.version && (
                            <span className="mono">v{activeNode.version}</span>
                          )}
                          <span>
                            {activeNode.last_seen
                              ? bi(
                                  `最近心跳 ${fullTime(activeNode.last_seen)}`,
                                  `Last heartbeat ${fullTime(activeNode.last_seen)}`,
                                )
                              : bi("等待首次心跳", "Waiting for first heartbeat")}
                          </span>
                        </div>
                        <div className="detail-actions">
                          <Button
                            size="small"
                            icon={<IconBook />}
                            onClick={() => setGuide("install")}
                          >
                            {bi("接入指南", "Guide")}
                          </Button>
                          {canManage && (
                            <>
                              <Button
                                size="small"
                                loading={updating === activeNode.id}
                                disabled={!!updating && updating !== activeNode.id}
                                onClick={() => void toggle(activeNode)}
                              >
                                {activeNode.disabled
                                  ? bi("恢复接单", "Resume")
                                  : bi("暂停接单", "Pause")}
                              </Button>
                              <Tooltip content={bi("删除节点", "Delete node")}>
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
                            </>
                          )}
                        </div>
                      </header>

                      <div className="ec-detail-sections">
                        {oldProto && (
                          <div className="ec-upgrade-box">
                            <div className="ec-upgrade-head">
                              <div>
                                <b>
                                  {bi(
                                    "升级节点执行器以支持变更演练自动执行",
                                    "Upgrade Runner to Unlock Rehearsal Automation",
                                  )}
                                </b>
                                <p>
                                  {bi(
                                    "当前控制机运行旧版二进制，仅支持首次交付与只读探针；替换为新版二进制并重启 systemd 服务即可平滑升级（保留原有凭据）。",
                                    "Replace the runner binary and restart systemd to unlock automated rehearsal execution without re-enrolling.",
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

                        <section className="cx-spec-card">
                          <div className="cx-spec-card-head">
                            <h3>{bi("能力授权", "Capability Permissions")}</h3>
                          </div>
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
                                checked={activeNode.allow_delivery !== false}
                                loading={updating === activeNode.id}
                                disabled={!canManage || updating === activeNode.id}
                                onChange={(v) =>
                                  void updateNodeCap(activeNode, { allow_delivery: v })
                                }
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
                                checked={activeNode.allow_probe !== false}
                                loading={updating === activeNode.id}
                                disabled={!canManage || updating === activeNode.id}
                                onChange={(v) =>
                                  void updateNodeCap(activeNode, { allow_probe: v })
                                }
                              />
                            </div>

                            <div className="ec-cap-row">
                              <div className="ec-cap-row-l">
                                <b>{bi("变更演练步骤执行", "Rehearsal Step Execution")}</b>
                                <p>
                                  {bi(
                                    "允许在变更演练工作台执行变更写操作与回滚步骤（受集群生产门禁约束）。",
                                    "Allow executing mutating and rollback steps during rehearsals.",
                                  )}
                                </p>
                                {oldProto && (
                                  <span className="ec-cap-row-warn">
                                    {bi(
                                      "请先在上方升级节点执行器版本后再开启",
                                      "Upgrade the runner binary above before enabling",
                                    )}
                                  </span>
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

                        <section className="cx-spec-card">
                          <div className="cx-spec-card-head">
                            <h3>
                              <span>{bi("授权集群与目标主机", "Authorized Clusters & Hosts")}</span>
                              <span className="cx-card-cnt num">
                                {bi(
                                  `${activeNode.clusters.length} 集群 · ${activeNode.ips.length} 主机`,
                                  `${activeNode.clusters.length} cl · ${activeNode.ips.length} hosts`,
                                )}
                              </span>
                            </h3>
                          </div>
                          <div className="ec-scope-body">
                            <div className="ec-chip-wrap">
                              {activeNode.clusters.length === 0 ? (
                                <span style={{ fontSize: 12, color: "var(--faint)" }}>
                                  {bi(
                                    "尚未绑定集群；可在交付或集群「自动化」标签页选择此控制机。",
                                    "No clusters bound yet; select this node in a cluster's Automation tab.",
                                  )}
                                </span>
                              ) : (
                                activeNode.clusters.map((cid) => (
                                  <button
                                    key={cid}
                                    type="button"
                                    className="ec-cluster-link mono"
                                    onClick={() =>
                                      go({ name: "deliveries", id: cid, tab: "automation" })
                                    }
                                  >
                                    <span>{cid}</span>
                                    <IconRight />
                                  </button>
                                ))
                              )}
                            </div>
                            {activeNode.ips.length > 0 && (
                              <div className="ec-chip-wrap">
                                {activeNode.ips.map((ip) => (
                                  <span key={ip} className="ec-ip-chip mono">
                                    {ip}
                                    {ip === activeNode.controller_ip && (
                                      <small>{bi("控制", "Ctrl")}</small>
                                    )}
                                  </span>
                                ))}
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
                    </article>
                  );
                })()
              ) : (
                <div className="detail-none enter">
                  <IconDesktop style={{ fontSize: 28, color: "var(--faint)" }} />
                  <h2>
                    {all.length === 0
                      ? bi("连接第一台控制机执行节点", "Connect Your First Control Node")
                      : bi("没有符合筛选条件的控制机", "No Matching Control Nodes")}
                  </h2>
                  <p>
                    {all.length === 0
                      ? bi(
                          "在主控机安装 1 个轻量后台执行器，即可统一调度集群交付、只读探针采集与变更演练。",
                          "Install one background runner on a control host to orchestrate deliveries, probes, and rehearsals.",
                        )
                      : bi("调整左侧搜索或状态筛选条件以查看其他节点。", "Adjust the rail search or filter to view nodes.")}
                  </p>
                  {all.length === 0 && canManage ? (
                    <div className="ec-row-acts">
                      <Button type="primary" icon={<IconPlus />} onClick={begin}>
                        {bi("接入执行节点", "Add Control Node")}
                      </Button>
                      <Button icon={<IconBook />} onClick={() => setGuide("install")}>
                        {bi("接入指南", "Setup Guide")}
                      </Button>
                    </div>
                  ) : (
                    all.length > 0 && (
                      <Button
                        onClick={() => {
                          setQuery("");
                          setFilter("all");
                        }}
                      >
                        {bi("清除筛选", "Clear Filters")}
                      </Button>
                    )
                  )}
                </div>
              )}
            </>
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
                  <header className="detail-head">
                    <div className="detail-title">
                      <h1>{activeAgent.host}</h1>
                      <StatusBadge state={badgeState} label={badgeLabel} />
                      <span
                        className={`ec-micro-pill ${activeAgent.mode === "direct" ? "is-brand" : ""}`}
                      >
                        {activeAgent.mode === "direct"
                          ? bi("直连执行模式", "Direct Exec")
                          : bi("托管 SSH 信任", "SSH Trust")}
                      </span>
                    </div>
                    <div className="detail-meta">
                      <code className="mono">{activeAgent.ip}</code>
                      <span>{bi("集群", "Cluster")}: {activeAgent.cluster}</span>
                      {activeAgent.version && (
                        <span className="mono">v{activeAgent.version}</span>
                      )}
                      <span>
                        {activeAgent.last_seen
                          ? bi(
                              `最近心跳 ${fullTime(activeAgent.last_seen)}`,
                              `Last heartbeat ${fullTime(activeAgent.last_seen)}`,
                            )
                          : bi("尚未上报心跳", "No heartbeat yet")}
                      </span>
                    </div>
                    <div className="detail-actions">
                      <Button
                        size="small"
                        type="outline"
                        icon={<IconThunderbolt />}
                        onClick={() =>
                          go({
                            name: "deliveries",
                            id: activeAgent.cluster,
                            tab: "automation",
                          })
                        }
                      >
                        {bi("打开集群自动化", "Cluster Automation")}
                      </Button>
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
                    </div>
                  </header>

                  <div className="ec-detail-sections">
                    <section className="cx-spec-card">
                      <div className="cx-spec-card-head">
                        <h3>{bi("Agent 权限与连接信息", "Agent Permissions & Info")}</h3>
                      </div>
                      <div className="ec-kv-grid">
                        <div className="ec-kv">
                          <span>{bi("目标主机 IP", "Target IP")}</span>
                          <code className="mono">{activeAgent.ip}</code>
                        </div>
                        <div className="ec-kv">
                          <span>{bi("所属集群", "Cluster")}</span>
                          <button
                            type="button"
                            className="ec-cluster-link mono"
                            style={{ alignSelf: "flex-start" }}
                            onClick={() =>
                              go({
                                name: "deliveries",
                                id: activeAgent.cluster,
                                tab: "automation",
                              })
                            }
                          >
                            <span>{activeAgent.cluster}</span>
                            <IconRight />
                          </button>
                        </div>
                        <div className="ec-kv">
                          <span>{bi("签发时间", "Created")}</span>
                          <b>{activeAgent.created ? fullTime(activeAgent.created) : "—"}</b>
                        </div>
                        <div className="ec-kv">
                          <span>{bi("Agent 标识", "Agent ID")}</span>
                          <code className="mono">{activeAgent.id}</code>
                        </div>
                      </div>
                      <div className="ec-cap-row">
                        <div className="ec-cap-row-l">
                          <b>{bi("允许执行变更写操作", "Allow Mutating Steps")}</b>
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
                    </section>

                    {peerAgents.length > 1 && (
                      <section className="cx-spec-card">
                        <div className="cx-spec-card-head">
                          <h3>
                            <span>
                              {bi(
                                `同集群主机 Agent（${activeAgent.cluster}）`,
                                `Cluster Agents (${activeAgent.cluster})`,
                              )}
                            </span>
                            <span className="cx-card-cnt num">{peerAgents.length}</span>
                          </h3>
                        </div>
                        <div className="ec-peer-list">
                          {peerAgents.map((peer) => {
                            const pRev = peer.desired !== "active";
                            const pDot = pRev
                              ? "is-revoked"
                              : peer.online
                                ? "is-online"
                                : "is-offline";
                            return (
                              <div
                                key={peer.id}
                                className={`ec-peer-row ${peer.id === activeAgent.id ? "is-current" : ""}`}
                                onClick={() => setSelectedAgentId(peer.id)}
                              >
                                <div className="ec-peer-row-l">
                                  <span className={`ec-state-dot ${pDot}`} />
                                  <b>{peer.host}</b>
                                  <code className="mono">{peer.ip}</code>
                                </div>
                                <div className="ec-row-acts">
                                  <span className="ec-micro-pill">
                                    {pRev
                                      ? bi("已撤销", "Revoked")
                                      : peer.online
                                        ? bi("在线", "Online")
                                        : bi("离线", "Offline")}
                                  </span>
                                  <span className="ec-micro-pill">
                                    {peer.allow_mutating
                                      ? bi("允许写入", "RW")
                                      : bi("仅只读", "RO")}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    )}
                  </div>
                </article>
              );
            })()
          ) : (
            <div className="detail-none enter">
              <IconLink style={{ fontSize: 28, color: "var(--faint)" }} />
              <h2>
                {allAgents.length === 0
                  ? bi("暂无目标机直连 Agent", "No Target Agents Enrolled")
                  : bi("没有符合条件的 Agent", "No Matching Agents")}
              </h2>
              <p>
                {allAgents.length === 0
                  ? bi(
                      "当集群无 SSH 免密或无独立控制机时，前往任意集群的「自动化」标签页选择方式 B 即可生成轻量 Agent 安装包。",
                      "Enroll passwordless outbound Target Agents inside any cluster's Automation tab.",
                    )
                  : bi("调整左侧搜索或状态筛选条件以查看其他 Agent。", "Adjust the rail filter to view agents.")}
              </p>
              {allAgents.length === 0 ? (
                <Button type="outline" onClick={() => go({ name: "deliveries" })}>
                  {bi("前往集群列表", "Open Clusters")} <IconArrowRight />
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    setAgentQuery("");
                    setAgentFilter("all");
                  }}
                >
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
    </>
  );
}

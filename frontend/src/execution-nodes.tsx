import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Input,
  Message,
  Modal,
  Skeleton,
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
  IconSafe,
  IconSearch,
} from "@arco-design/web-react/icon";
import {
  api,
  authToken,
  cached,
  copy,
  csrfToken,
  fullTime,
  putCached,
} from "./shared";
import { Segmented } from "./ui";
import { bi, biv, getLang, useLang, withLang } from "./i18n";
import {
  ExecutionNode,
  isExecutionNodeOnline,
  nodeConnection,
} from "./execution-types";
import { AIHelpButton } from "./aichat";
import "./executions.css";

type Registration = { node: ExecutionNode; token: string };
type Guide = "install" | "maintain";
type Filter = "all" | "online" | "offline" | "disabled";

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
Description=Middleware Hub Execution Node
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
            <div className="en-downloads" style={{ margin: "12px 0" }}>
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

export function ExecutionNodes() {
  useLang();
  const [nodes, setNodes] = useState<ExecutionNode[] | null>(
    () => cached<ExecutionNode[]>("/api/settings/execution-nodes") ?? null,
  );
  const [bootInfo, setBootInfo] = useState<BootstrapInfo | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bundling, setBundling] = useState(false);
  const [bundleError, setBundleError] = useState("");
  const [updating, setUpdating] = useState("");
  const [open, setOpen] = useState(false);
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
  const mounted = useRef(true);

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const result = await api<ExecutionNode[]>(
        "/api/settings/execution-nodes",
      );
      putCached("/api/settings/execution-nodes", result);
      if (mounted.current) {
        setNodes(result);
        setError("");
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setRefreshing(false);
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
    const timer = setInterval(() => void load(), intervalMs);
    return () => clearInterval(timer);
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
    if (!registration) return;
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
        }
      },
    });
  };

  const counts = {
    all: all.length,
    online: all.filter(isExecutionNodeOnline).length,
    offline: all.filter((n) => !n.disabled && !isExecutionNodeOnline(n)).length,
    disabled: all.filter((n) => n.disabled).length,
  };
  const rows = all.filter(
    (n) =>
      (filter === "all" ||
        (filter === "online"
          ? isExecutionNodeOnline(n)
          : filter === "disabled"
            ? n.disabled
            : !n.disabled && !isExecutionNodeOnline(n))) &&
      [n.name, n.controller_ip, ...n.clusters, ...n.ips].some((s) =>
        s.toLowerCase().includes(query.trim().toLowerCase()),
      ),
  );

  return (
    <article className="sx-page st-main exec-settings enter">
      <header className="sx-page-h en-page-header">
        <div>
          <div className="en-title-row">
            <h1>{bi("执行节点", "Execution Nodes")}</h1>
            <AIHelpButton
              topic="execution-nodes-overview"
              title={bi("执行节点与自动化原理", "How Execution Nodes Work")}
              page={bi("设置 · 执行节点", "Settings · Execution Nodes")}
              summary={bi(
                `当前已登记 ${all.length} 台执行节点，${counts.online} 台在线`,
                `${all.length} enrolled execution nodes, ${counts.online} online`,
              )}
              prompt={bi(
                "请用最直观的话告诉我：执行节点（执行器）应该装在几台机器上？它和交付里的「已有 SSH」「目标 Agent」分别负责什么？",
                "Explain simply: how many hosts need the execution runner, and how does it relate to Existing SSH and Target Agent in deliveries?",
              )}
              tooltip={bi(
                "问 AI：执行器装在哪？和 SSH / 目标 Agent 什么关系？",
                "Ask AI: Where to install runner & SSH vs Target Agent",
              )}
            />
          </div>
          <p>
            {bi(
              "在主控机上安装 1 个后台执行器即可调度整个集群，业务机无需安装执行器。",
              "Install one background runner on your control host to orchestrate cluster deliveries—workload hosts do not need the runner.",
            )}
          </p>
        </div>
        <div className="exec-actions">
          <Button
            icon={<IconRefresh />}
            loading={refreshing}
            onClick={() => load(true)}
            aria-label={bi("刷新节点状态", "Refresh node status")}
          />
          <Button icon={<IconBook />} onClick={() => setGuide("install")}>
            {bi("接入指南", "Setup Guide")}
          </Button>
          {!!all.length && (
            <Button type="primary" icon={<IconPlus />} onClick={begin}>
              {registration
                ? bi("继续接入", "Continue Setup")
                : bi("接入节点", "Add Node")}
            </Button>
          )}
        </div>
      </header>
      <div className="en-content">
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
              page={bi("设置 · 执行节点", "Settings · Execution Nodes")}
              error={error}
              prompt={bi(
                `执行节点页面刷新状态报错：${error}，请帮我分析原因和排查方式。`,
                `Execution nodes page failed to load: ${error}. Help diagnose.`,
              )}
            />
            <Button onClick={() => load(true)} loading={refreshing}>
              {bi("重试", "Retry")}
            </Button>
          </div>
        )}
        {!nodes && !error && (
          <div
            className="en-loading"
            aria-label={bi("正在加载执行节点", "Loading execution nodes")}
          >
            <Skeleton
              animation
              text={{ rows: 4, width: ["35%", "70%", "60%", "90%"] }}
            />
          </div>
        )}
        {nodes && !all.length && (
          <section className="en-empty" aria-labelledby="en-empty-title">
            <div className="en-intro">
              <span className="en-hero-icon">
                <IconDesktop />
              </span>
              <h2 id="en-empty-title">
                {bi("连接第一台执行节点", "Connect Your First Execution Node")}
              </h2>
              <p>
                {bi(
                  "只需给 1 台主控机安装一键安装包（后台 systemd 运行）。业务机无需装执行器，SSH 免密或堡垒机目标 Agent 在交付页配置。",
                  "Install the one-command systemd bundle on one control host. Workload hosts stay clean—configure Existing SSH or Target Agent later inside each delivery.",
                )}
              </p>
              <Button
                type="primary"
                size="large"
                icon={<IconPlus />}
                onClick={begin}
              >
                {bi("接入节点", "Add Node")}
              </Button>
              <small>
                {bi(
                  "仅接入节点不会开始部署，目标授权在交付中完成",
                  "Enrolling a node does not deploy anything; targets are authorized per delivery",
                )}
              </small>
            </div>
            <ol className="en-onboarding">
              <li>
                <span>1</span>
                <div>
                  <h3>{bi("主控机装执行器（仅 1 台）", "Install Runner on 1 Control Host")}</h3>
                  <p>
                    {bi(
                      "下载自包含安装包，一条命令自动装成后台服务并自检连通性。",
                      "Download the self-contained bundle and run install.sh to start the background service.",
                    )}
                  </p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <h3>{bi("新建交付并选执行位置", "Create Delivery & Pick Placement")}</h3>
                  <p>
                    {bi(
                      "填写实际业务机器，指定由独立管理机或集群内机器执行。",
                      "Enter workload hosts and pick a dedicated control host or an in-cluster host.",
                    )}
                  </p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <h3>{bi("现场执行选 SSH 或目标 Agent", "Authorize & Connect Targets")}</h3>
                  <p>
                    {bi(
                      "已有免密直接预检开跑；无密码（堡垒机）再装目标 Agent 自动建免密。",
                      "Run pre-checks directly with Existing SSH, or install Target Agent to automate SSH trust.",
                    )}
                  </p>
                </div>
              </li>
            </ol>
          </section>
        )}
        {nodes && !!all.length && (
          <section
            className="en-flow-strip"
            aria-label={bi("自动化接入流程", "Automation workflow overview")}
          >
            <div className={`en-flow-item${counts.online > 0 ? " is-done" : ""}`}>
              <i>{counts.online > 0 ? <IconCheck /> : "1"}</i>
              <div>
                <div className="en-flow-title-row">
                  <b>{bi("主控机装执行器（仅 1 台）", "1 Control Host Runs Executor")}</b>
                  {counts.online > 0 && (
                    <em className="en-flow-done-tag num">
                      {bi(`${counts.online} 台在线`, `${counts.online} online`)}
                    </em>
                  )}
                </div>
                <span>
                  {bi(
                    "后台常驻领任务；业务机不要装执行器",
                    "Runs as systemd daemon; leave workload hosts clean",
                  )}
                </span>
              </div>
            </div>
            <span className="en-flow-arrow" aria-hidden>
              <span>
                <IconArrowRight />
              </span>
            </span>
            <div className="en-flow-item">
              <i>2</i>
              <div>
                <div className="en-flow-title-row">
                  <b>{bi("新建交付并授权节点", "Create Delivery & Authorize")}</b>
                </div>
                <span>
                  {bi(
                    "在交付的「现场执行」中选定本节点",
                    "Pick this node in the delivery's On-site Execution tab",
                  )}
                </span>
              </div>
            </div>
            <span className="en-flow-arrow" aria-hidden>
              <span>
                <IconArrowRight />
              </span>
            </span>
            <div className="en-flow-item">
              <i>3</i>
              <div>
                <div className="en-flow-title-row">
                  <b>{bi("目标接入二选一", "Choose Target Access")}</b>
                </div>
                <span>
                  {bi(
                    "已有免密直接预检；无密码（堡垒机）装目标 Agent",
                    "Existing SSH or Target Agent (for bastion hosts)",
                  )}
                </span>
              </div>
            </div>
          </section>
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
        {!!all.length && (
          <section
            className="en-list"
            aria-label={bi("已接入节点", "Enrolled nodes")}
          >
            <div className="en-list-heading">
              <div>
                <h2>
                  {bi("已接入节点", "Enrolled Nodes")} <span>{all.length}</span>
                </h2>
                <p>
                  <span
                    className={`en-live-dot${counts.online ? " connected" : ""}`}
                  />
                  {bi(
                    `${counts.online} 台已连接 · ${fastPoll ? "每 1.5 秒快速检测" : "每 10 秒更新状态"}`,
                    `${counts.online} connected · Updates every ${fastPoll ? "1.5s" : "10s"}`,
                  )}
                </p>
              </div>
              <Input
                prefix={<IconSearch />}
                allowClear
                value={query}
                onChange={setQuery}
                placeholder={bi(
                  "搜索名称、集群或 IP",
                  "Search name, cluster, or IP",
                )}
                aria-label={bi("搜索执行节点", "Search execution nodes")}
              />
            </div>
            <Segmented<Filter>
              label={bi("按节点状态筛选", "Filter by node status")}
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: bi("全部", "All"), count: counts.all },
                {
                  value: "online",
                  label: bi("已连接", "Connected"),
                  count: counts.online,
                },
                {
                  value: "offline",
                  label: bi("未连接", "Offline"),
                  count: counts.offline,
                },
                {
                  value: "disabled",
                  label: bi("已暂停", "Paused"),
                  count: counts.disabled,
                },
              ]}
            />
            <div className="en-nodes">
              {rows.map((node) => {
                const status = nodeConnection(node);
                return (
                  <article
                    className={`en-node en-node-${status.key}`}
                    key={node.id}
                  >
                    <header>
                      <span className="en-node-icon">
                        <IconDesktop />
                      </span>
                      <div className="en-node-title">
                        <div>
                          <h3>{node.name}</h3>
                          <span className={`en-status ${status.key}`}>
                            <i />
                            {nodeStatusLabel(status.key, status.label)}
                          </span>
                          {(status.key === "offline" ||
                            status.key === "waiting") && (
                            <AIHelpButton
                              topic={`node-offline-${node.id}`}
                              title={bi(
                                `排查节点「${node.name}」未连接`,
                                `Troubleshoot disconnected node “${node.name}”`,
                              )}
                              page={bi("设置 · 执行节点", "Settings · Execution Nodes")}
                              summary={bi(
                                `节点 ${node.name} (${node.controller_ip})，位置=${node.kind}，状态=${status.key}`,
                                `Node ${node.name} (${node.controller_ip}), kind=${node.kind}, state=${status.key}`,
                              )}
                              prompt={bi(
                                `执行节点「${node.name}」(${node.controller_ip}) 当前状态为「${nodeStatusLabel(status.key, status.label)}」，请帮我列出最快定位原因的检查命令和常见坑（比如平台地址、CA 证书、systemd 服务）。`,
                                `Execution node "${node.name}" (${node.controller_ip}) is ${status.key}. Give me the quickest commands to diagnose why it is not connecting.`,
                              )}
                              tooltip={bi(
                                "问 AI：为什么这台节点没连上？",
                                "Ask AI: Why is this node disconnected?",
                              )}
                            />
                          )}
                        </div>
                        <p>
                          {node.disabled
                            ? bi(
                                "停止领取新任务，已授权步骤仍可回传结果",
                                "New claims paused; authorized steps can still report",
                              )
                            : node.last_seen
                              ? bi(
                                  `最近联系 ${fullTime(node.last_seen)}${node.version ? " · v" + node.version : ""}`,
                                  `Last seen ${fullTime(node.last_seen)}${node.version ? " · v" + node.version : ""}`,
                                )
                              : bi(
                                  "在主控机运行 install.sh 启动后台服务后，这里会自动变为已连接",
                                  "Updates automatically once install.sh starts the background service",
                                )}
                        </p>
                      </div>
                      <div className="en-node-actions">
                        <Button
                          size="small"
                          loading={updating === node.id}
                          disabled={!!updating && updating !== node.id}
                          onClick={() => toggle(node)}
                        >
                          {node.disabled
                            ? bi("恢复接单", "Resume")
                            : bi("停止领取", "Pause")}
                        </Button>
                        <Tooltip content={bi("删除节点", "Delete node")}>
                          <Button
                            size="small"
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
                      </div>
                    </header>
                    <dl>
                      <div>
                        <dt>
                          {node.kind === "independent"
                            ? bi("独立管理机", "Dedicated Control Host")
                            : bi("集群内执行机", "In-Cluster Host")}
                        </dt>
                        <dd className="en-controller">
                          <code>{node.controller_ip}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>
                          {bi("授权集群", "Authorized Clusters")}{" "}
                          <span>{node.clusters.length}</span>
                        </dt>
                        <dd className="en-tags">
                          {!node.clusters.length && (
                            <span>
                              {bi("待在交付中授权", "Authorize in delivery")}
                            </span>
                          )}
                          {node.clusters.map((c) => (
                            <span key={c}>{c}</span>
                          ))}
                        </dd>
                      </div>
                      <div>
                        <dt>
                          {bi("目标机器", "Target Hosts")}{" "}
                          <span>{node.ips.length}</span>
                        </dt>
                        <dd className="en-tags en-ip-tags">
                          {!node.ips.length && (
                            <span>
                              {bi(
                                "随交付授权带入",
                                "Populated via delivery authorization",
                              )}
                            </span>
                          )}
                          {node.ips.map((ip) => (
                            <span key={ip}>
                              {ip}
                              {ip === node.controller_ip && (
                                <small>{bi("控制", "Ctrl")}</small>
                              )}
                            </span>
                          ))}
                        </dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
              {!rows.length && (
                <div className="en-no-match">
                  <IconSearch />
                  <b>{bi("没有符合条件的节点", "No matching nodes")}</b>
                  <Button
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
          </section>
        )}
        {nodes && (
          <section
            className="en-resources"
            aria-label={bi("执行节点帮助", "Execution node guides")}
          >
            <button onClick={() => setGuide("install")} type="button">
              <span className="en-resource-icon">
                <IconCommand />
              </span>
              <span>
                <b>{bi("安装与接入", "Install & Connect")}</b>
                <small>
                  {bi(
                    "一键后台安装、证书与 systemd 管理命令",
                    "One-command background install, CA cert & systemd commands",
                  )}
                </small>
              </span>
              <IconArrowRight />
            </button>
            <button onClick={() => setGuide("maintain")} type="button">
              <span className="en-resource-icon">
                <IconSafe />
              </span>
              <span>
                <b>{bi("维护与恢复", "Maintenance & Recovery")}</b>
                <small>
                  {bi(
                    "连通性自检、升级执行器、处理异常中断",
                    "Connectivity checks, runner upgrades, interruption recovery",
                  )}
                </small>
              </span>
              <IconArrowRight />
            </button>
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
                <div className="en-error" role="alert" style={{ marginBottom: 12 }}>
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

import React, { useEffect, useRef, useState } from "react";
import {
  Button,
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
import { api, cached, copy, fullTime, putCached } from "./shared";
import { Segmented } from "./ui";
import { bi, biv, useLang, withLang } from "./i18n";
import {
  ExecutionNode,
  isExecutionNodeOnline,
  nodeConnection,
} from "./execution-types";
import "./executions.css";

type Registration = { node: ExecutionNode; token: string };
type Guide = "install" | "maintain";
type Filter = "all" | "online" | "offline" | "disabled";
const splitValues = (value: string) => [
  ...new Set(value.split(/[\s,，]+/).filter(Boolean)),
];

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

const service = `[Unit]
Description=Middleware Hub execution node
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

function InstallGuide() {
  useLang();
  return (
    <ol className="en-guide-steps">
      <li>
        <span>1</span>
        <div>
          <h3>{bi("选择执行器的安装机器", "Choose an Execution Host")}</h3>
          <p>
            {bi(
              "可以使用独立管理机，也可以使用集群内机器。先接入节点，之后在交付中授权目标、检查材料和连接。已有 SSH 的目标无需安装 Agent；拿不到密码时可通过堡垒机安装目标 Agent。",
              "Use either a dedicated bastion/control host or an existing cluster node. Enroll the node first, then authorize targets, verify artifacts, and check connectivity inside a delivery. Hosts with existing SSH need no agent; if passwords are unavailable, install Target Agent via bastion.",
            )}
          </p>
        </div>
      </li>
      <li>
        <span>2</span>
        <div>
          <h3>{bi("保存程序和连接配置", "Save Binary & Config")}</h3>
          <p>
            {biv(
              <>
                下载执行器，以及接入节点后生成的 <code>execution-node.json</code>
                。将两个文件传到执行机器，在文件所在目录执行：
              </>,
              <>
                Download the runner binary and the generated{" "}
                <code>execution-node.json</code> config. Transfer both files to
                the execution host and run in that directory:
              </>,
            )}
          </p>
          <Button
            href={withLang("/api/settings/execution-nodes/binary")}
            icon={<IconDownload />}
          >
            {bi("下载执行器 · Linux x64", "Download Runner · Linux x64")}
          </Button>
          <Command title={bi("安装到约定位置", "Install to standard paths")}>{`install -m 0755 middleware-store-linux-amd64 /usr/local/bin/middleware-store
install -d -m 0700 /etc/middleware-execution
install -m 0600 execution-node.json /etc/middleware-execution/execution-node.json`}</Command>
          <p>
            {biv(
              <>
                配置里的 <code>root</code> 填已解包的交付目录，默认是{" "}
                <code>/root/middleware-automation</code>
                。独立管理机按各份交付手册解包，每个集群拥有自己的目录；在交付的准备检查中可查看具体路径。
                将这些路径加入配置的 <code>roots</code> 数组，程序按本集群路径和运行器摘要核对，避免串用其他集群的密码或环境。
              </>,
              <>
                Set <code>root</code> to your unpacked delivery directory
                (default: <code>/root/middleware-automation</code>). A dedicated
                control host unpacks each cluster into its own directory—check
                the exact path in delivery pre-checks and add those paths to{" "}
                <code>roots</code> so the runner verifies cluster paths and
                digests to prevent credential mix-ups.
              </>,
            )}
          </p>
          <div className="en-note">
            <IconSafe />
            <span>
              {biv(
                <>
                  使用企业或自签名 HTTPS 证书时，将管理员提供的 CA 公钥证书放到{" "}
                  <code>ca_file</code>{" "}
                  指定位置。使用系统已信任的证书时，可以移除这个字段。
                </>,
                <>
                  For enterprise or self-signed HTTPS certificates, place the CA
                  public certificate provided by your admin at{" "}
                  <code>ca_file</code>. Remove this field if the system already
                  trusts the platform certificate.
                </>,
              )}
            </span>
          </div>
        </div>
      </li>
      <li>
        <span>3</span>
        <div>
          <h3>{bi("启动并确认连接", "Start & Verify Connection")}</h3>
          <p>
            {bi(
              "先运行下面的命令。页面显示“已连接”后，就可以回到交付选择自动执行步骤。",
              "Run the command below first. Once the status shows “Connected”, return to your delivery to select automated steps.",
            )}
          </p>
          <Command title={bi("启动执行器", "Start runner")}>{`/usr/local/bin/middleware-store execution-node --config /etc/middleware-execution/execution-node.json`}</Command>
          <details className="en-service">
            <summary>
              {bi(
                "长期运行：配置 systemd 服务",
                "Run persistently: configure systemd service",
              )}
            </summary>
            <p>
              {biv(
                <>
                  结束上面的前台进程，再将以下内容保存为{" "}
                  <code>/etc/systemd/system/middleware-execution.service</code>
                  。安装位置不同时，请调整路径。
                </>,
                <>
                  Stop the foreground process above, then save the following unit
                  to <code>/etc/systemd/system/middleware-execution.service</code>
                  . Adjust paths if installed elsewhere.
                </>,
              )}
            </p>
            <Command title="middleware-execution.service">{service}</Command>
            <Command title={bi("启动服务", "Enable and start service")}>{`systemctl daemon-reload
systemctl enable --now middleware-execution
journalctl -u middleware-execution -f`}</Command>
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
            "确认配置中的平台地址和执行机器 IP 正确，CA 证书已放到指定位置。查看服务日志中的连接错误：",
            "Verify the platform URL and execution host IP in the config, and ensure the CA certificate is in place. Inspect service logs for connection errors:",
          )}
        </p>
        <Command title={bi("查看连接日志", "Inspect connection logs")}>
          {"journalctl -u middleware-execution -n 80 --no-pager"}
        </Command>
      </section>
      <section>
        <h3>{bi("更新执行器", "Upgrading the Runner")}</h3>
        <p>
          {bi(
            "先在节点卡片上“停止领取”，等待当前步骤结束，再停止服务、更换程序并启动。连接恢复后点击“恢复接单”。平台网页更新无需重启执行器。",
            "Click “Pause Claims” on the node card first, wait for running steps to finish, then stop the service, replace the binary, and restart. Click “Resume Claims” once reconnected. Web UI updates do not require restarting runners.",
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
            "The platform will not automatically rerun interrupted steps. Confirm tasks have stopped on both execution and target hosts, stop the node service, then acknowledge with the attempt ID and verification notes:",
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
        <p>
          {bi(
            "回传成功后重新启动服务，回到交付检查记录，再决定后续操作。",
            "After acknowledgement succeeds, restart the service and review the delivery logs before proceeding.",
          )}
        </p>
      </section>
      <section>
        <h3>{bi("现场无法连接平台", "Site cannot reach platform")}</h3>
        <p>
          {bi(
            "继续使用离线交付包，按手册执行并上传 logs 日志归档。离线执行不会显示实时进度。",
            "Continue using the offline delivery bundle, follow the runbook, and upload the logs archive. Offline execution does not report live progress.",
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
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState("");
  const [open, setOpen] = useState(false);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [downloaded, setDownloaded] = useState(false);
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
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  const begin = () => {
    if (!registration) {
      setName("");
      setKind("independent");
      setController("");
      setCreateError("");
    }
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
      void load();
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    if (!registration) return;
    const config = {
      url: location.origin,
      token: registration.token,
      root: "/root/middleware-automation",
      state: "/var/lib/middleware-execution",
      ca_file: "/etc/middleware-execution/platform-ca.pem",
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }),
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
  const all = nodes || [];
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
  const registeredNode = all.find((n) => n.id === registration?.node.id);

  return (
    <article className="sx-page st-main exec-settings enter">
      <header className="sx-page-h en-page-header">
        <div>
          <h1>{bi("执行节点", "Execution Nodes")}</h1>
          <p>
            {bi(
              "连接交付的执行机器，执行你授权的步骤，并将日志和检查结果回传到交付。",
              "Connect execution hosts to run authorized steps and stream logs and check results back to deliveries.",
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
                  "使用交付中的执行机器即可，无需给每台数据库安装代理。连接后，在交付页面选择需要自动执行的步骤。",
                  "Just install on the delivery control host—no agent is needed on every database host. Once connected, select steps to automate from any delivery.",
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
                  "仅接入节点不会开始部署",
                  "Enrolling a node does not start any deployment",
                )}
              </small>
            </div>
            <ol className="en-onboarding">
              <li>
                <span>1</span>
                <div>
                  <h3>{bi("登记授权范围", "Register Scope")}</h3>
                  <p>
                    {bi(
                      "指定执行机器、允许操作的集群和目标机器。",
                      "Specify the execution host, authorized clusters, and target hosts.",
                    )}
                  </p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <h3>{bi("安装并连接", "Install & Connect")}</h3>
                  <p>
                    {bi(
                      "下载连接配置，在执行机器上启动执行器。",
                      "Download the connection config and start the runner on the execution host.",
                    )}
                  </p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <h3>{bi("回到交付执行", "Run from Delivery")}</h3>
                  <p>
                    {bi(
                      "审核具体步骤后启动，结果自动进入交付报告。",
                      "Review steps and trigger execution; results flow into delivery reports automatically.",
                    )}
                  </p>
                </div>
              </li>
            </ol>
          </section>
        )}
        {registration && !open && (
          <div className="en-pending" role="status">
            <IconInfoCircle />
            <span>
              {biv(
                <>
                  <b>{registration.node.name}</b>{" "}
                  已登记，继续保存配置并完成连接。
                </>,
                <>
                  <b>{registration.node.name}</b> is registered—save the config
                  and finish connecting.
                </>,
              )}
            </span>
            <Button type="text" onClick={() => setOpen(true)}>
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
                    `${counts.online} 台已连接 · 每 10 秒更新状态`,
                    `${counts.online} connected · Updates every 10s`,
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
                                  "在执行机器启动执行器后，这里会自动更新",
                                  "Updates automatically once the runner starts on the host",
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
                    "下载执行器、准备证书、启动节点服务",
                    "Download runner, prepare CA cert, start node service",
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
                    "检查连接、升级执行器、处理异常中断",
                    "Troubleshoot connectivity, upgrade runner, recover from interruptions",
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
        style={{ width: 660, maxWidth: "calc(100vw - 32px)" }}
        maskClosable={false}
        onCancel={() => !busy && setOpen(false)}
        footer={
          registration ? (
            <>
              <span className="en-footer-note">
                {downloaded ? (
                  <>
                    <IconCheck /> {bi("连接配置已下载", "Config downloaded")}
                  </>
                ) : (
                  bi(
                    "先下载连接配置，再完成接入",
                    "Download the config file before finishing",
                  )
                )}
              </span>
              <Button type="primary" disabled={!downloaded} onClick={finish}>
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
          <span className={registration ? "current" : ""}>
            <i>2</i>
            {bi("安装并连接", "Install & Connect")}
          </span>
        </div>
        {!registration ? (
          <div className="en-form">
            <p className="en-lead">
              {bi(
                "先接入负责执行的机器。目标机器从交付中带入，由管理员在交付页授权，无需在这里重复填写。",
                "Register the host running the executor first. Target hosts are populated from deliveries and authorized per delivery.",
              )}
            </p>
            {createError && (
              <div className="en-error" role="alert">
                <IconExclamationCircle />
                <span>{createError}</span>
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
                    "例如：生产网络执行机",
                    "e.g., Prod Network Bastion",
                  )}
                  autoFocus
                />
                <small>
                  {bi(
                    "用于在交付中识别这台执行节点",
                    "Displayed when selecting an execution node in deliveries",
                  )}
                </small>
              </div>
              <div className="en-field">
                <label htmlFor="en-controller">
                  {bi("执行机器 IP", "Execution Host IP")}
                </label>
                <Input
                  id="en-controller"
                  value={controller}
                  onChange={setController}
                  placeholder={bi("例如：172.30.6.100", "e.g., 172.30.6.100")}
                />
                <small>
                  {bi(
                    "安装执行器的那台机器，不是所有目标机器的地址",
                    "IP of the host running the executor, not the database targets",
                  )}
                </small>
              </div>
              <div className="en-field en-field-wide">
                <span className="en-field-label" id="en-kind-label">
                  {bi("安装位置", "Deployment Placement")}
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
                          "不承载业务，每个集群使用独立目录，不占用业务节点",
                          "Dedicated host with isolated per-cluster directories, separate from workload hosts",
                        ),
                      },
                      {
                        value: "embedded",
                        title: bi("集群内机器", "In-Cluster Host"),
                        desc: bi(
                          "复用集群中的一台机器执行，同时承载业务",
                          "Runs directly on one of the cluster hosts alongside workloads",
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
                <small>
                  {bi(
                    "两种方式使用同一套任务和执行记录",
                    "Both modes share the same job queue and execution history",
                  )}
                </small>
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
                      执行机器 <code>{registration.node.controller_ip}</code> ·{" "}
                      {registration.node.clusters.length} 个集群 ·{" "}
                      {registration.node.ips.length} 台机器
                    </>,
                    <>
                      Execution host{" "}
                      <code>{registration.node.controller_ip}</code> ·{" "}
                      {registration.node.clusters.length} clusters ·{" "}
                      {registration.node.ips.length} hosts
                    </>,
                  )}
                </span>
              </div>
            </div>
            <section>
              <h3>
                {bi(
                  "1. 下载程序和连接配置",
                  "1. Download Runner & Connection Config",
                )}
              </h3>
              <p>
                {bi(
                  "将两个文件传到执行机器。连接配置包含专属凭据，请在离开此页面前保存。",
                  "Transfer both files to the execution host. The config contains a unique credential—download it before closing.",
                )}
              </p>
              <div className="en-downloads">
                <Button
                  href={withLang("/api/settings/execution-nodes/binary")}
                  icon={<IconDownload />}
                >
                  {bi("执行器 · Linux x64", "Runner · Linux x64")}
                </Button>
                <Button
                  type="primary"
                  icon={<IconDownload />}
                  onClick={download}
                >
                  {downloaded
                    ? bi("重新下载连接配置", "Re-download Config")
                    : bi("下载连接配置", "Download Config")}
                </Button>
              </div>
            </section>
            <section>
              <h3>
                {bi("2. 按接入指南启动", "2. Start Using the Setup Guide")}
              </h3>
              <p>
                {bi(
                  "准备交付运行环境、保存文件和 CA 证书后启动服务。这里会自动显示连接状态。",
                  "Prepare the runtime environment, save the files and CA cert, then start the service. Connection status updates automatically here.",
                )}
              </p>
              <Button
                type="text"
                icon={<IconBook />}
                onClick={() => setGuide("install")}
              >
                {bi("查看安装命令", "View Install Commands")} <IconArrowRight />
              </Button>
            </section>
            <div
              className={`en-connection ${registeredNode && isExecutionNodeOnline(registeredNode) ? "connected" : ""}`}
            >
              <span className="en-live-dot" />
              <b>
                {registeredNode && isExecutionNodeOnline(registeredNode)
                  ? bi(
                      "节点已连接，请回到交付授权并检查准备",
                      "Node connected! Return to your delivery to authorize and run pre-checks",
                    )
                  : bi(
                      "等待执行机器连接…",
                      "Waiting for execution host to connect…",
                    )}
              </b>
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
        focusLock
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
        {guide === "maintain" ? <MaintenanceGuide /> : <InstallGuide />}
      </Drawer>
    </article>
  );
}

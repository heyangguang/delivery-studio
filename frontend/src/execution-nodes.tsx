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
  return (
    <div className="exec-command">
      <div>
        <span>{title}</span>
        <Button
          type="text"
          size="mini"
          icon={<IconCopy />}
          onClick={() => copy(children)}
          aria-label={`复制${title}`}
        >
          复制
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
  return (
    <ol className="en-guide-steps">
      <li>
        <span>1</span>
        <div>
          <h3>选择执行器的安装机器</h3>
          <p>
            可以使用独立管理机，也可以使用集群内机器。先接入节点，之后在交付中授权目标、检查材料和连接。已有
            SSH 的目标无需安装 Agent；拿不到密码时可通过堡垒机安装目标 Agent。
          </p>
        </div>
      </li>
      <li>
        <span>2</span>
        <div>
          <h3>保存程序和连接配置</h3>
          <p>
            下载执行器，以及接入节点后生成的 <code>execution-node.json</code>
            。将两个文件传到执行机器，在文件所在目录执行：
          </p>
          <Button
            href="/api/settings/execution-nodes/binary"
            icon={<IconDownload />}
          >
            下载执行器 · Linux x64
          </Button>
          <Command title="安装到约定位置">{`install -m 0755 middleware-store-linux-amd64 /usr/local/bin/middleware-store
install -d -m 0700 /etc/middleware-execution
install -m 0600 execution-node.json /etc/middleware-execution/execution-node.json`}</Command>
          <p>
            配置里的 <code>root</code> 填已解包的交付目录，默认是{" "}
            <code>/root/middleware-automation</code>
            。独立管理机按各份交付手册解包，每个集群拥有自己的目录；在交付的准备检查中可查看具体路径。
            将这些路径加入配置的 <code>roots</code> 数组，程序按本集群路径和运行器摘要核对，避免串用其他集群的密码或环境。
          </p>
          <div className="en-note">
            <IconSafe />
            <span>
              使用企业或自签名 HTTPS 证书时，将管理员提供的 CA 公钥证书放到{" "}
              <code>ca_file</code>{" "}
              指定位置。使用系统已信任的证书时，可以移除这个字段。
            </span>
          </div>
        </div>
      </li>
      <li>
        <span>3</span>
        <div>
          <h3>启动并确认连接</h3>
          <p>
            先运行下面的命令。页面显示“已连接”后，就可以回到交付选择自动执行步骤。
          </p>
          <Command title="启动执行器">{`/usr/local/bin/middleware-store execution-node --config /etc/middleware-execution/execution-node.json`}</Command>
          <details className="en-service">
            <summary>长期运行：配置 systemd 服务</summary>
            <p>
              结束上面的前台进程，再将以下内容保存为{" "}
              <code>/etc/systemd/system/middleware-execution.service</code>
              。安装位置不同时，请调整路径。
            </p>
            <Command title="middleware-execution.service">{service}</Command>
            <Command title="启动服务">{`systemctl daemon-reload
systemctl enable --now middleware-execution
journalctl -u middleware-execution -f`}</Command>
          </details>
        </div>
      </li>
    </ol>
  );
}

function MaintenanceGuide() {
  return (
    <div className="en-maintenance">
      <section>
        <h3>节点一直没有连接</h3>
        <p>
          确认配置中的平台地址和执行机器 IP 正确，CA
          证书已放到指定位置。查看服务日志中的连接错误：
        </p>
        <Command title="查看连接日志">
          {"journalctl -u middleware-execution -n 80 --no-pager"}
        </Command>
      </section>
      <section>
        <h3>更新执行器</h3>
        <p>
          先在节点卡片上“停止领取”，等待当前步骤结束，再停止服务、更换程序并启动。连接恢复后点击“恢复接单”。平台网页更新无需重启执行器。
        </p>
      </section>
      <section>
        <h3>异常中断后的状态待核实</h3>
        <p>
          平台不会自动重跑这个步骤。先核实执行机器和目标机器上的任务均已停止，再停止节点服务，填写该次尝试编号和核实情况：
        </p>
        <Command title="回传核实结果">{`/usr/local/bin/middleware-store execution-node \
  --config /etc/middleware-execution/execution-node.json \
  --ack-stopped 尝试编号 --note "现场核实过程和结果"`}</Command>
        <p>回传成功后重新启动服务，回到交付检查记录，再决定后续操作。</p>
      </section>
      <section>
        <h3>现场无法连接平台</h3>
        <p>
          继续使用离线交付包，按手册执行并上传 logs
          日志归档。离线执行不会显示实时进度。
        </p>
      </section>
    </div>
  );
}

export function ExecutionNodes() {
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
          ? "已恢复领取任务"
          : "已停止领取新任务，已授权步骤仍可完成并回传结果",
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
      title: `删除执行节点「${node.name}」？`,
      content: (
        <div className="en-delete-confirm">
          <p>
            删除后，执行机器 <code>{node.controller_ip}</code>{" "}
            上的执行器将无法再连接平台，需要重新接入才能使用。
          </p>
          <p>已完成的执行记录和交付报告会保留。</p>
        </div>
      ),
      okText: "删除节点",
      cancelText: "取消",
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          await api("/api/settings/execution-nodes", {
            method: "DELETE",
            body: JSON.stringify({ id: node.id }),
          });
          Message.success(`已删除执行节点「${node.name}」`);
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
          <h1>执行节点</h1>
          <p>
            连接交付的执行机器，执行你授权的步骤，并将日志和检查结果回传到交付。
          </p>
        </div>
        <div className="exec-actions">
          <Button
            icon={<IconRefresh />}
            loading={refreshing}
            onClick={() => load(true)}
            aria-label="刷新节点状态"
          />
          <Button icon={<IconBook />} onClick={() => setGuide("install")}>
            接入指南
          </Button>
          {!!all.length && (
            <Button type="primary" icon={<IconPlus />} onClick={begin}>
              {registration ? "继续接入" : "接入节点"}
            </Button>
          )}
        </div>
      </header>
      <div className="en-content">
        {error && (
          <div className="en-error" role="alert">
            <IconExclamationCircle />
            <div>
              <b>节点状态未能更新</b>
              <p>{error}</p>
            </div>
            <Button onClick={() => load(true)} loading={refreshing}>
              重试
            </Button>
          </div>
        )}
        {!nodes && !error && (
          <div className="en-loading" aria-label="正在加载执行节点">
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
              <h2 id="en-empty-title">连接第一台执行节点</h2>
              <p>
                使用交付中的执行机器即可，无需给每台数据库安装代理。连接后，在交付页面选择需要自动执行的步骤。
              </p>
              <Button
                type="primary"
                size="large"
                icon={<IconPlus />}
                onClick={begin}
              >
                接入节点
              </Button>
              <small>仅接入节点不会开始部署</small>
            </div>
            <ol className="en-onboarding">
              <li>
                <span>1</span>
                <div>
                  <h3>登记授权范围</h3>
                  <p>指定执行机器、允许操作的集群和目标机器。</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <h3>安装并连接</h3>
                  <p>下载连接配置，在执行机器上启动执行器。</p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <h3>回到交付执行</h3>
                  <p>审核具体步骤后启动，结果自动进入交付报告。</p>
                </div>
              </li>
            </ol>
          </section>
        )}
        {registration && !open && (
          <div className="en-pending" role="status">
            <IconInfoCircle />
            <span>
              <b>{registration.node.name}</b> 已登记，继续保存配置并完成连接。
            </span>
            <Button type="text" onClick={() => setOpen(true)}>
              继续接入 <IconArrowRight />
            </Button>
          </div>
        )}
        {!!all.length && (
          <section className="en-list" aria-label="已接入节点">
            <div className="en-list-heading">
              <div>
                <h2>
                  已接入节点 <span>{all.length}</span>
                </h2>
                <p>
                  <span
                    className={`en-live-dot${counts.online ? " connected" : ""}`}
                  />
                  {counts.online} 台已连接 · 每 10 秒更新状态
                </p>
              </div>
              <Input
                prefix={<IconSearch />}
                allowClear
                value={query}
                onChange={setQuery}
                placeholder="搜索名称、集群或 IP"
                aria-label="搜索执行节点"
              />
            </div>
            <Segmented<Filter>
              label="按节点状态筛选"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "全部", count: counts.all },
                { value: "online", label: "已连接", count: counts.online },
                { value: "offline", label: "未连接", count: counts.offline },
                { value: "disabled", label: "已暂停", count: counts.disabled },
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
                            {status.label}
                          </span>
                        </div>
                        <p>
                          {node.disabled
                            ? "停止领取新任务，已授权步骤仍可回传结果"
                            : node.last_seen
                              ? `最近联系 ${fullTime(node.last_seen)}${node.version ? " · v" + node.version : ""}`
                              : "在执行机器启动执行器后，这里会自动更新"}
                        </p>
                      </div>
                      <div className="en-node-actions">
                        <Button
                          size="small"
                          loading={updating === node.id}
                          disabled={!!updating && updating !== node.id}
                          onClick={() => toggle(node)}
                        >
                          {node.disabled ? "恢复接单" : "停止领取"}
                        </Button>
                        <Tooltip content="删除节点">
                          <Button
                            size="small"
                            status="danger"
                            icon={<IconDelete />}
                            disabled={!!updating}
                            onClick={() => remove(node)}
                            aria-label={`删除执行节点 ${node.name}`}
                          />
                        </Tooltip>
                      </div>
                    </header>
                    <dl>
                      <div>
                        <dt>
                          {node.kind === "independent"
                            ? "独立管理机"
                            : "集群内执行机"}
                        </dt>
                        <dd className="en-controller">
                          <code>{node.controller_ip}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>
                          授权集群 <span>{node.clusters.length}</span>
                        </dt>
                        <dd className="en-tags">
                          {!node.clusters.length && <span>待在交付中授权</span>}
                          {node.clusters.map((c) => (
                            <span key={c}>{c}</span>
                          ))}
                        </dd>
                      </div>
                      <div>
                        <dt>
                          目标机器 <span>{node.ips.length}</span>
                        </dt>
                        <dd className="en-tags en-ip-tags">
                          {!node.ips.length && <span>随交付授权带入</span>}
                          {node.ips.map((ip) => (
                            <span key={ip}>
                              {ip}
                              {ip === node.controller_ip && <small>控制</small>}
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
                  <b>没有符合条件的节点</b>
                  <Button
                    type="text"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    清除筛选
                  </Button>
                </div>
              )}
            </div>
          </section>
        )}
        {nodes && (
          <section className="en-resources" aria-label="执行节点帮助">
            <button onClick={() => setGuide("install")} type="button">
              <span className="en-resource-icon">
                <IconCommand />
              </span>
              <span>
                <b>安装与接入</b>
                <small>下载执行器、准备证书、启动节点服务</small>
              </span>
              <IconArrowRight />
            </button>
            <button onClick={() => setGuide("maintain")} type="button">
              <span className="en-resource-icon">
                <IconSafe />
              </span>
              <span>
                <b>维护与恢复</b>
                <small>检查连接、升级执行器、处理异常中断</small>
              </span>
              <IconArrowRight />
            </button>
          </section>
        )}
      </div>
      <Modal
        className="exec-modal en-modal"
        title={registration ? "安装并连接节点" : "接入执行节点"}
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
                    <IconCheck /> 连接配置已下载
                  </>
                ) : (
                  "先下载连接配置，再完成接入"
                )}
              </span>
              <Button type="primary" disabled={!downloaded} onClick={finish}>
                完成
              </Button>
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button
                type="primary"
                loading={busy}
                disabled={!name.trim() || !controller.trim()}
                onClick={create}
              >
                下一步：安装并连接
              </Button>
            </>
          )
        }
      >
        <div className="en-setup-steps">
          <span className={registration ? "done" : "current"}>
            <i>{registration ? <IconCheck /> : 1}</i>登记执行机器
          </span>
          <span aria-hidden className="en-setup-line" />
          <span className={registration ? "current" : ""}>
            <i>2</i>安装并连接
          </span>
        </div>
        {!registration ? (
          <div className="en-form">
            <p className="en-lead">
              先接入负责执行的机器。目标机器从交付中带入，由管理员在交付页授权，无需在这里重复填写。
            </p>
            {createError && (
              <div className="en-error" role="alert">
                <IconExclamationCircle />
                <span>{createError}</span>
              </div>
            )}
            <div className="en-form-grid">
              <div className="en-field">
                <label htmlFor="en-name">节点名称</label>
                <Input
                  id="en-name"
                  value={name}
                  onChange={setName}
                  placeholder="例如：生产网络执行机"
                  autoFocus
                />
                <small>用于在交付中识别这台执行节点</small>
              </div>
              <div className="en-field">
                <label htmlFor="en-controller">执行机器 IP</label>
                <Input
                  id="en-controller"
                  value={controller}
                  onChange={setController}
                  placeholder="例如：172.30.6.100"
                />
                <small>安装执行器的那台机器，不是所有目标机器的地址</small>
              </div>
              <div className="en-field en-field-wide">
                <span className="en-field-label" id="en-kind-label">
                  安装位置
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
                        title: "独立管理机",
                        desc: "不承载业务，每个集群使用独立目录，不占用业务节点",
                      },
                      {
                        value: "embedded",
                        title: "集群内机器",
                        desc: "复用集群中的一台机器执行，同时承载业务",
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
                            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
                          ) {
                            e.preventDefault();
                            const next = o.value === "independent" ? "embedded" : "independent";
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
                <small>两种方式使用同一套任务和执行记录</small>
              </div>
            </div>
          </div>
        ) : (
          <div className="en-connect">
            <div className="en-registration">
              <IconCheckCircle />
              <div>
                <b>{registration.node.name} 已登记</b>
                <span>
                  执行机器 <code>{registration.node.controller_ip}</code> ·{" "}
                  {registration.node.clusters.length} 个集群 ·{" "}
                  {registration.node.ips.length} 台机器
                </span>
              </div>
            </div>
            <section>
              <h3>1. 下载程序和连接配置</h3>
              <p>
                将两个文件传到执行机器。连接配置包含专属凭据，请在离开此页面前保存。
              </p>
              <div className="en-downloads">
                <Button
                  href="/api/settings/execution-nodes/binary"
                  icon={<IconDownload />}
                >
                  执行器 · Linux x64
                </Button>
                <Button
                  type="primary"
                  icon={<IconDownload />}
                  onClick={download}
                >
                  {downloaded ? "重新下载连接配置" : "下载连接配置"}
                </Button>
              </div>
            </section>
            <section>
              <h3>2. 按接入指南启动</h3>
              <p>
                准备交付运行环境、保存文件和 CA
                证书后启动服务。这里会自动显示连接状态。
              </p>
              <Button
                type="text"
                icon={<IconBook />}
                onClick={() => setGuide("install")}
              >
                查看安装命令 <IconArrowRight />
              </Button>
            </section>
            <div
              className={`en-connection ${registeredNode && isExecutionNodeOnline(registeredNode) ? "connected" : ""}`}
            >
              <span className="en-live-dot" />
              <b>
                {registeredNode && isExecutionNodeOnline(registeredNode)
                  ? "节点已连接，请回到交付授权并检查准备"
                  : "等待执行机器连接…"}
              </b>
            </div>
          </div>
        )}
      </Modal>
      <Drawer
        title="执行节点指南"
        className="en-guide-drawer"
        visible={!!guide}
        width="min(660px, 100vw)"
        onCancel={() => setGuide(null)}
        footer={null}
        focusLock
      >
        <Segmented<Guide>
          label="指南内容"
          value={guide || "install"}
          onChange={setGuide}
          options={[
            { value: "install", label: "安装与接入" },
            { value: "maintain", label: "维护与恢复" },
          ]}
        />
        {guide === "maintain" ? <MaintenanceGuide /> : <InstallGuide />}
      </Drawer>
    </article>
  );
}

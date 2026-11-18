import React, { useEffect, useState, useRef } from "react";
import { Button, Modal, Radio, Message } from "@arco-design/web-react";
import { api, can, copy } from "./shared";
import { bi, biv, useLang, withLang } from "./i18n";
type Agent = {
  id: string;
  node: string;
  host: string;
  ip: string;
  last_seen?: string;
  expires: string;
  desired: string;
  applied?: string;
  message?: string;
};
export function TargetAgents({
  job,
  node,
  targets,
  executorIP,
  onChanged,
}: {
  job: string;
  node: string;
  targets: { name: string; ip: string }[];
  executorIP: string;
  onChanged: () => void;
}) {
  useLang();
  const [mode, setMode] = useState("ssh"),
    [agents, setAgents] = useState<Agent[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const [registration, setRegistration] = useState<{
      agent: Agent;
      enrollment_token: string;
    } | null>(null),
    [saved, setSaved] = useState(false);
  const initialized = useRef("");
  const load = async () => {
    try {
      const next = await api<Agent[]>(`/api/jobs/${job}/executions/agents`);
      setAgents(next);
      if (initialized.current !== node) {
        setMode(
          next.some((a) => a.node === node && a.desired === "active")
            ? "agent"
            : "ssh",
        );
        initialized.current = node;
      }
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    let dead = false;
    const refresh = () => {
      if (!dead) void load();
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [job, node]);
  const register = async (host: string) => {
    setBusy(host);
    try {
      const result = await api<{ agent: Agent; enrollment_token: string }>(
        `/api/jobs/${job}/executions/agents`,
        { method: "POST", body: JSON.stringify({ node, host }) },
      );
      setRegistration(result);
      setSaved(false);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const download = () => {
    if (!registration) return;
    const config = {
      url: location.origin,
      id: registration.agent.id,
      enrollment_token: registration.enrollment_token,
      ca_file: "/etc/middleware-execution/platform-ca.pem",
      state: `/var/lib/middleware-target/${registration.agent.id}`,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `target-agent-${registration.agent.host}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved(true);
  };
  const commands = registration
    ? [
        `install -m 0755 middleware-store-linux-amd64 /usr/local/bin/middleware-store`,
        `install -d -m 0700 /etc/middleware-execution`,
        `install -m 0600 target-agent-${registration.agent.host}.json /etc/middleware-execution/target-agent-${registration.agent.id}.json`,
        `/usr/local/bin/middleware-store target-agent --config /etc/middleware-execution/target-agent-${registration.agent.id}.json`,
      ].join(String.fromCharCode(10))
    : "";
  return (
    <div className="ex-agent-access">
      <h3>{bi("目标机器怎样接入", "Target Host Access")}</h3>
      <Radio.Group value={mode} onChange={setMode} type="button">
        <Radio value="ssh">{bi("已有 SSH", "Existing SSH")}</Radio>
        <Radio value="agent">{bi("堡垒机安装 Agent", "Bastion Agent Setup")}</Radio>
      </Radio.Group>
      {mode === "ssh" ? (
        <p className="ex-help">
          {agents.some((a) => a.node === node && a.desired === "active")
            ? bi(
                "本交付已有目标通过 Agent 管理 SSH 信任，检查时会继续使用该连接。切换到“堡垒机安装 Agent”可查看或撤销；切换这里的说明不会更改已建立的信任。",
                "Some targets in this delivery already manage SSH trust via an Agent and will continue using it during checks. Switch to “Bastion Agent Setup” to inspect or revoke; switching this view does not alter existing trust.",
              )
            : bi(
                "执行节点使用现场已有的 SSH 配置。检查会验证身份、主机指纹和 root 执行权限。",
                "The execution node uses the site's existing SSH configuration. Checks will verify identity, host fingerprint, and root privileges.",
              )}
        </p>
      ) : (
        <>
          <p className="ex-help">
            {bi(
              "拿不到登录密码时，通过堡垒机在目标机器安装 Agent。它仅为此执行机配置已授权的 SSH 公钥，保留其他登录方式。目标需能连接平台，且允许执行机连接目标 SSH。",
              "When login passwords are unavailable, install the Agent on targets via bastion. It configures only the authorized SSH public key for this execution host while preserving other access methods. Targets must reach the platform and allow SSH from the execution host.",
            )}
          </p>
          {targets.every((h) => h.ip === executorIP) && (
            <p className="ex-help">
              {bi(
                "本次只有执行机本身，无需安装目标 Agent。",
                "Only the execution host itself is targeted; no Target Agent installation is needed.",
              )}
            </p>
          )}
          <div className="ex-agent-list">
            {targets
              .filter((h) => h.ip !== executorIP)
              .map((h) => {
                const a =
                  agents.find(
                    (a) =>
                      a.node === node &&
                      a.host === h.name &&
                      a.desired === "active",
                  ) || agents.find((a) => a.node === node && a.host === h.name);
                const online =
                  a?.last_seen && Date.now() - Date.parse(a.last_seen) < 35000;
                return (
                  <div key={h.name}>
                    <div>
                      <b>{h.name}</b>
                      <code>{h.ip}</code>
                      <small>
                        {!a
                          ? bi("尚未接入", "Not enrolled")
                          : a.desired === "revoked"
                            ? a.applied === "revoked"
                              ? a.last_seen
                                ? bi("托管公钥已移除", "Managed key removed")
                                : bi("接入已取消", "Enrollment cancelled")
                              : bi("等待现场移除公钥", "Awaiting key removal")
                            : !a.last_seen
                              ? bi("等待通过堡垒机安装", "Awaiting bastion install")
                              : !online
                                ? bi("Agent 连接中断", "Agent disconnected")
                                : a.applied === "active"
                                  ? bi(
                                      "Agent 已连接 · 公钥已配置",
                                      "Agent connected · Key configured",
                                    )
                                  : bi(
                                      "Agent 已连接 · 等待公钥配置",
                                      "Agent connected · Configuring key",
                                    )}
                      </small>
                      {a?.message && <p>{a.message}</p>}
                    </div>
                    <div className="exec-actions">
                      {can("execution.manage") &&
                      (!a ||
                        (a.desired === "revoked" && a.applied === "revoked") ||
                        (!a.last_seen &&
                          Date.parse(a.expires) < Date.now())) ? (
                        <Button
                          size="small"
                          loading={busy === h.name}
                          onClick={() => register(h.name)}
                        >
                          {bi("获取接入配置", "Get Setup Config")}
                        </Button>
                      ) : can("execution.manage") &&
                        a &&
                        a.desired === "active" ? (
                        <Button
                          size="small"
                          onClick={() =>
                            Modal.confirm({
                              title: a.last_seen
                                ? bi(
                                    `撤销 ${h.name} 的托管信任`,
                                    `Revoke managed trust for ${h.name}`,
                                  )
                                : bi(
                                    `取消 ${h.name} 的接入`,
                                    `Cancel enrollment for ${h.name}`,
                                  ),
                              content: a.last_seen
                                ? bi(
                                    "目标 Agent 将移除本次添加的公钥。目标离线时保持待撤销，现存 SSH 会话需现场核实。",
                                    "The Target Agent will remove the added public key. If offline, revocation stays pending; verify any existing SSH sessions on site.",
                                  )
                                : bi(
                                    "这台机器尚未接入，取消后旧接入配置失效，可以重新获取配置。",
                                    "This host has not enrolled yet. Cancelling invalidates the previous config, and a new one can be generated.",
                                  ),
                              okText: a.last_seen
                                ? bi("撤销信任", "Revoke Trust")
                                : bi("取消接入", "Cancel Enrollment"),
                              cancelText: bi("取消", "Cancel"),
                              onOk: async () => {
                                try {
                                  await api(
                                    `/api/jobs/${job}/executions/agents`,
                                    {
                                      method: "PATCH",
                                      body: JSON.stringify({
                                        id: a.id,
                                        action: "revoke",
                                      }),
                                    },
                                  );
                                  await load();
                                  onChanged();
                                } catch (e) {
                                  Message.error((e as Error).message);
                                  throw e;
                                }
                              },
                            })
                          }
                        >
                          {a.last_seen
                            ? bi("撤销信任", "Revoke Trust")
                            : bi("取消接入", "Cancel")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
          </div>
          <p className="ex-help">
            {bi(
              "接入后点击下方“开始准备检查”：执行机会生成专用密钥，待 Agent 配置公钥后重新检查 SSH。连接检查通过才可执行部署。",
              "After enrolling, click “Run Pre-check” below: the execution host generates a dedicated key, and SSH is verified once the Agent installs the public key. Deployment requires passing connectivity checks.",
            )}
          </p>
        </>
      )}
      <details className="ex-access-limit">
        <summary>
          {bi(
            "客户禁止机器间 SSH，或目标无法连接平台？",
            "Host-to-host SSH forbidden, or targets cannot reach platform?",
          )}
        </summary>
        <p>
          {bi(
            "当前目标 Agent 提供 SSH 信任接入；无 SSH 的本机执行及现场中继尚未开放。这类环境继续使用离线交付与日志回传，不能把 Agent 已连接当作能够自动部署。",
            "Target Agent currently manages SSH trust enrollment; SSH-free local execution and on-site relay are not yet available. Continue using offline delivery and log upload in those environments—an Agent connection alone does not enable automated deployment.",
          )}
        </p>
      </details>
      {error && (
        <p role="alert" className="en-error">
          {error}
        </p>
      )}
      <Modal
        visible={!!registration}
        title={bi(
          `接入目标机器 · ${registration?.agent.host || ""}`,
          `Enroll Target Host · ${registration?.agent.host || ""}`,
        )}
        maskClosable={false}
        onCancel={() => {
          if (saved) setRegistration(null);
          else
            Modal.confirm({
              title: bi("接入配置还没有保存", "Setup config not saved yet"),
              content: bi(
                "关闭后无法再次下载这次配置，需要撤销后重新登记。",
                "Once closed, this setup config cannot be downloaded again; you will need to revoke and re-enroll.",
              ),
              okText: bi("关闭", "Close"),
              cancelText: bi("取消", "Cancel"),
              onOk: () => setRegistration(null),
            });
        }}
        footer={
          <Button
            type="primary"
            disabled={!saved}
            onClick={() => setRegistration(null)}
          >
            {bi("已保存，返回检查", "Saved, Back to Checks")}
          </Button>
        }
        className="exec-modal"
        style={{ width: 720, maxWidth: "96vw" }}
      >
        <div className="ex-setup-section">
          <p>
            {biv(
              <>
                通过现有堡垒机会话，以具备安装权限的 root 用户在{" "}
                <b>{registration?.agent.host}</b>（{registration?.agent.ip}
                ）上操作。先按交付环境准备手册核对主机名和
                IP；配置仅用于这台机器，30 分钟内完成首次接入。
              </>,
              <>
                Operate on <b>{registration?.agent.host}</b> (
                {registration?.agent.ip}) as root via your bastion session.
                Verify hostname and IP per the environment prep guide; this
                config is bound to this host and expires in 30 minutes if not
                enrolled.
              </>,
            )}
          </p>
          <div className="exec-actions">
            <Button href={withLang("/api/settings/execution-nodes/binary")}>
              {bi("下载执行器 · Linux x64", "Download Runner · Linux x64")}
            </Button>
            <Button type="primary" onClick={download}>
              {saved
                ? bi("重新下载配置", "Re-download Config")
                : bi("下载本机接入配置", "Download Host Config")}
            </Button>
          </div>
          <p>
            {biv(
              <>
                先放入管理员提供的 CA 公钥证书；平台证书已被系统信任时，删除配置中的{" "}
                <code>ca_file</code> 字段。
              </>,
              <>
                Place the CA certificate provided by your admin first; if the
                platform certificate is already trusted by the OS, remove the{" "}
                <code>ca_file</code> field from the config.
              </>,
            )}
          </p>
          <div className="exec-command">
            <div>
              <b>{bi("在目标机器安装并启动", "Install and start on target")}</b>
              <Button type="text" onClick={() => copy(commands)}>
                {bi("复制", "Copy")}
              </Button>
            </div>
            <pre>{commands}</pre>
          </div>
          <details>
            <summary>
              {bi(
                "保持 Agent 运行，以便后续撤销信任",
                "Keep Agent running for future trust revocation",
              )}
            </summary>
            <p>
              {biv(
                <>
                  将以下配置保存到 /etc/systemd/system/middleware-target-
                  {registration?.agent.id}.service。结束前台进程后，执行
                  systemctl daemon-reload，再启动并启用该服务。
                </>,
                <>
                  Save the unit below to /etc/systemd/system/middleware-target-
                  {registration?.agent.id}.service. Stop the foreground process,
                  then run systemctl daemon-reload and enable/start the service.
                </>,
              )}
            </p>
            <pre className="ex-service-code">
              {[
                "[Unit]",
                "Description=Middleware target trust agent",
                "After=network-online.target",
                "[Service]",
                "User=root",
                "UMask=0077",
                `ExecStart=/usr/local/bin/middleware-store target-agent --config /etc/middleware-execution/target-agent-${registration?.agent.id}.json`,
                "Restart=on-failure",
                "RestartSec=10",
                "[Install]",
                "WantedBy=multi-user.target",
              ].join(String.fromCharCode(10))}
            </pre>
          </details>
        </div>
      </Modal>
    </div>
  );
}

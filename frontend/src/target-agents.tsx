import React, { useEffect, useState, useRef } from "react";
import { Button, Modal, Radio, Message } from "@arco-design/web-react";
import { api, can, copy } from "./shared";
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
      <h3>目标机器怎样接入</h3>
      <Radio.Group value={mode} onChange={setMode} type="button">
        <Radio value="ssh">已有 SSH</Radio>
        <Radio value="agent">堡垒机安装 Agent</Radio>
      </Radio.Group>
      {mode === "ssh" ? (
        <p className="ex-help">
          {agents.some(a => a.node === node && a.desired === "active")
            ? "本交付已有目标通过 Agent 管理 SSH 信任，检查时会继续使用该连接。切换到“堡垒机安装 Agent”可查看或撤销；切换这里的说明不会更改已建立的信任。"
            : "执行节点使用现场已有的 SSH 配置。检查会验证身份、主机指纹和 root 执行权限。"}
        </p>
      ) : (
        <>
          <p className="ex-help">
            拿不到登录密码时，通过堡垒机在目标机器安装
            Agent。它仅为此执行机配置已授权的 SSH
            公钥，保留其他登录方式。目标需能连接平台，且允许执行机连接目标 SSH。
          </p>
          {targets.every((h) => h.ip === executorIP) && (
            <p className="ex-help">本次只有执行机本身，无需安装目标 Agent。</p>
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
                          ? "尚未接入"
                          : a.desired === "revoked"
                            ? a.applied === "revoked"
                              ? a.last_seen ? "托管公钥已移除" : "接入已取消"
                              : "等待现场移除公钥"
                            : !a.last_seen
                              ? "等待通过堡垒机安装"
                              : !online
                                ? "Agent 连接中断"
                                : a.applied === "active"
                                  ? "Agent 已连接 · 公钥已配置"
                                  : "Agent 已连接 · 等待公钥配置"}
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
                          获取接入配置
                        </Button>
                      ) : can("execution.manage") &&
                        a &&
                        a.desired === "active" ? (
                        <Button
                          size="small"
                          onClick={() =>
                            Modal.confirm({
                              title: a.last_seen ? `撤销 ${h.name} 的托管信任` : `取消 ${h.name} 的接入`,
                              content: a.last_seen
                                ? "目标 Agent 将移除本次添加的公钥。目标离线时保持待撤销，现存 SSH 会话需现场核实。"
                                : "这台机器尚未接入，取消后旧接入配置失效，可以重新获取配置。",
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
                          {a.last_seen ? "撤销信任" : "取消接入"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
          </div>
          <p className="ex-help">
            接入后点击下方“开始准备检查”：执行机会生成专用密钥，待 Agent
            配置公钥后重新检查 SSH。连接检查通过才可执行部署。
          </p>
        </>
      )}
      <details className="ex-access-limit">
        <summary>客户禁止机器间 SSH，或目标无法连接平台？</summary>
        <p>
          当前目标 Agent 提供 SSH 信任接入；无 SSH
          的本机执行及现场中继尚未开放。这类环境继续使用离线交付与日志回传，不能把
          Agent 已连接当作能够自动部署。
        </p>
      </details>
      {error && (
        <p role="alert" className="en-error">
          {error}
        </p>
      )}
      <Modal
        visible={!!registration}
        title={`接入目标机器 · ${registration?.agent.host || ""}`}
        maskClosable={false}
        onCancel={() => {
          if (saved) setRegistration(null);
          else
            Modal.confirm({
              title: "接入配置还没有保存",
              content: "关闭后无法再次下载这次配置，需要撤销后重新登记。",
              onOk: () => setRegistration(null),
            });
        }}
        footer={
          <Button
            type="primary"
            disabled={!saved}
            onClick={() => setRegistration(null)}
          >
            已保存，返回检查
          </Button>
        }
        className="exec-modal"
        style={{ width: 720, maxWidth: "96vw" }}
      >
        <div className="ex-setup-section">
          <p>
            通过现有堡垒机会话，以具备安装权限的 root 用户在{" "}
            <b>{registration?.agent.host}</b>（{registration?.agent.ip}
            ）上操作。先按交付环境准备手册核对主机名和
            IP；配置仅用于这台机器，30 分钟内完成首次接入。
          </p>
          <div className="exec-actions">
            <Button href="/api/settings/execution-nodes/binary">
              下载执行器 · Linux x64
            </Button>
            <Button type="primary" onClick={download}>
              {saved ? "重新下载配置" : "下载本机接入配置"}
            </Button>
          </div>
          <p>
            先放入管理员提供的 CA 公钥证书；平台证书已被系统信任时，删除配置中的
            ca_file 字段。
          </p>
          <div className="exec-command">
            <div>
              <b>在目标机器安装并启动</b>
              <Button type="text" onClick={() => copy(commands)}>
                复制
              </Button>
            </div>
            <pre>{commands}</pre>
          </div>
          <details>
            <summary>保持 Agent 运行，以便后续撤销信任</summary>
            <p>
              将以下配置保存到 /etc/systemd/system/middleware-target-
              {registration?.agent.id}.service。结束前台进程后，执行 systemctl
              daemon-reload，再启动并启用该服务。
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

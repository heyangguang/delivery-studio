import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Input, Modal, Select } from "@arco-design/web-react";
import {
  IconPlayArrow,
  IconPause,
  IconRefresh,
  IconDownload,
} from "@arco-design/web-react/icon";
import { api, can, err, fullTime } from "./shared";
import {
  ExecutionNode as Node,
  ExecutionPreparation,
  isExecutionNodeOnline as online,
} from "./execution-types";
import "./executions.css";
import { TargetAgents } from "./target-agents";

type Step = {
  id: string;
  key: string;
  title: string;
  hosts: string[];
  state: string;
  message?: string;
  started?: string;
  finished?: string;
  seq: number;
};
type Run = {
	 executor_name?: string;
	 executor_ip?: string;
	 executor_kind?: string;
	 access_mode?: string;
  id: string;
  node: string;
  by: string;
  created: string;
  updated: string;
  state: string;
  pause: boolean;
  snapshot: string;
  steps: Step[];
};
type Choice = {
  key: string;
  title: string;
  phase: string;
  hosts: string[];
  effect: string;
  state?: string;
  available: boolean;
  reason?: string;
};
type Data = {
  runs: Run[];
  nodes: Node[];
  steps: Choice[];
  revision: string;
  targets: { name: string; ip: string }[];
  executor: { ip: string; kind: string; runtime_root?: string };
  preparations: ExecutionPreparation[];
};
const labels: Record<string, string> = {
  queued: "等待执行节点领取",
  pending: "未执行",
  leased: "已授权，等待启动",
  running: "正在执行",
  paused: "已暂停",
  unknown: "现场状态待核实",
  succeeded: "检查通过",
  completed: "所选步骤已结束",
  failed: "失败，后续已停止",
  skipped: "未执行：条件不满足",
  closed: "已结束批次",
  interrupted: "已确认中断",
  blocked: "准备受阻，命令未启动",
};
const active = (r: Run) => !["completed", "failed", "closed"].includes(r.state);
const effects: Record<string, string> = {
  "read-only": "只读",
  change: "修改配置",
  disruptive: "会中断服务",
  destructive: "不可撤销",
};

export function ExecutionPanel({
  jobId,
  cluster,
}: {
  jobId: string;
  cluster: string;
}) {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [node, setNode] = useState(""),
    [keys, setKeys] = useState<string[]>([]),
    [confirm, setConfirm] = useState(""),
    [prepared, setPrepared] = useState(false);
  const [review, setReview] = useState<Data | null>(null);
  const [stage, setStage] = useState(0);
  const [setupError, setSetupError] = useState("");
  const selectedNode = data?.nodes.find((n) => n.id === node);
  const preparation = data?.preparations?.find(
    (p) => p.node === node && p.revision === review?.revision,
  );
  const ready =
    !error &&
    data?.revision === review?.revision &&
    preparation?.state === "ready" &&
    !preparation.invalidated &&
    !!preparation.finished &&
    Date.now() - Date.parse(preparation.finished) < 600000;
  const nodeOptions = useMemo(
    () =>
      (data?.nodes || []).map((n) => ({
        value: n.id,
        label: `${n.name} · ${n.controller_ip}${n.compatible === false ? " · " + n.reason : online(n) ? "" : " · 未连接"}`,
        disabled: n.compatible === false,
      })),
    [data],
  );
  const request = useRef(""),
    last = useRef(""),
    reviewRevision = useRef(""),
    current = useRef(jobId);
  current.current = jobId;
  const load = async () => {
    try {
      const d = await api<Data>(`/api/jobs/${jobId}/executions`);
      if (current.current !== jobId) return;
      setData(d);
      setError("");
      const fingerprint = JSON.stringify(d.runs.map((r) => [r.id, r.updated]));
      if (last.current && last.current !== fingerprint)
        window.dispatchEvent(
          new CustomEvent("execution-updated", { detail: { jobId } }),
        );
      last.current = fingerprint;
    } catch (e) {
      if (current.current === jobId) setError((e as Error).message);
    }
  };
  useEffect(() => {
    setData(null);
    setOpen(false);
    last.current = "";
    let dead = false;
    const tick = () => {
      if (!dead) void load();
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [jobId]);
  const action = async (r: Run, action: string) => {
    setBusy(true);
    try {
      await api(`/api/jobs/${jobId}/executions/${r.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          action,
          note: action === "close" ? "用户结束批次，后续由现场人员处理" : "",
        }),
      });
      await load();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!data) return;
    setBusy(true);
    try {
      await api(`/api/jobs/${jobId}/executions`, {
        method: "POST",
        body: JSON.stringify({
          node,
          keys,
          confirm,
          prepared,
          preparation: preparation?.id,
          revision: reviewRevision.current,
          request: request.current,
        }),
      });
      setOpen(false);
      await load();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const running = data?.runs.find(active);
  const available = data?.steps.filter((s) => s.available) || [];
  const picked = review?.steps.filter((s) => keys.includes(s.key)) || [];
  return (
    <div className="exec-panel">
      <div className="exec-heading">
        <div>
          <b>执行方式</b>
          <p>
            保留手动执行；自动执行会保存每次尝试、机器结果和日志，并汇入报告。
          </p>
        </div>
        <div className="exec-actions">
          <Button
            icon={<IconRefresh />}
            onClick={load}
            aria-label="刷新执行状态"
          />
          {can("delivery.execute") && (
            <Button
              type="primary"
              icon={<IconPlayArrow />}
              disabled={!data || !!running || !available.length}
              onClick={() => {
                setReview(data);
                setKeys([]);
                setConfirm("");
                setPrepared(false);
                setStage(0);
                setSetupError("");
                setNode("");
                request.current = crypto.randomUUID();
                reviewRevision.current = data!.revision;
                setOpen(true);
              }}
            >
              选择自动执行步骤
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="warn">
          执行状态加载失败：{error}
        </p>
      )}
      {data && !available.length && (
        <p className="exec-hint">
          这份交付仍使用手动执行。组件需要声明超时和完成检查，并发布“自动执行”能力，之后生成的新交付才能自动运行。
        </p>
      )}
      {data && available.length > 0 && !data.nodes.length && (
        <p className="exec-hint">
          还没有授权给这个集群的执行节点。
          {can("execution.manage") && (
            <Button
              type="text"
              href="/#/settings/execution-nodes"
              target="_blank"
              rel="noopener noreferrer"
            >
              接入执行节点
            </Button>
          )}
        </p>
      )}
      {(data?.runs || []).map((run, index) => {
        const n = data?.nodes.find((x) => x.id === run.node);
        const disconnected = active(run) && !n?.disabled && (!n || !online(n));
        const pending = run.steps.find((s) =>
          ["leased", "running", "unknown"].includes(s.state),
        );
        return (
          <details
            className="exec-run"
            key={run.id}
            open={index === 0 || active(run)}
          >
            <summary>
              <span className={`exec-status ${run.state}`}>
                {labels[run.state] || run.state}
              </span>
              <span>
                {run.steps.length} 个步骤 · {run.executor_name || n?.name || "执行节点"} ·{" "}
                {fullTime(run.created)}
              </span>
            </summary>
            <div className="exec-run-body">
              {run.executor_ip && <p className="ex-help">执行机 <code>{run.executor_ip}</code> · {run.executor_kind === "independent" ? "独立管理机" : "集群内执行机"} · {run.access_mode === "agent-trust" ? "Agent 配置 SSH 信任" : "已有 SSH"}</p>}
              {disconnected && (
                <p role="status" className="exec-warning">
                  暂未收到执行节点心跳，现场状态待核实。已授权的步骤可能还在运行；平台不会重新分配或自动重跑。
                </p>
              )}
              {pending && (
                <p className="exec-current">
                  <b>{labels[pending.state]}：</b>
                  {pending.title}
                  <span>{pending.hosts.join("、")}</span>
                </p>
              )}
              <div className="exec-actions">
                {can("delivery.execute") && active(run) && (
                  <>
                    {run.state === "paused" ? (
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => action(run, "resume")}
                        icon={<IconPlayArrow />}
                      >
                        继续后续步骤
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        disabled={busy || run.pause || run.state === "unknown"}
                        onClick={() => action(run, "pause")}
                        icon={<IconPause />}
                      >
                        {run.pause
                          ? "当前步骤结束后暂停"
                          : "完成当前步骤后暂停"}
                      </Button>
                    )}
                    {!run.steps.some((s) =>
                      ["leased", "running", "unknown"].includes(s.state),
                    ) && (
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => action(run, "close")}
                      >
                        结束批次，保留记录
                      </Button>
                    )}
                  </>
                )}
              </div>
              <ol className="exec-step-list">
                {run.steps.map((s) => (
                  <li key={s.id} className={s.state}>
                    <div>
                      <b>{s.title}</b>
                      <span className="exec-status">
                        {labels[s.state] || s.state}
                      </span>
                    </div>
                    <small>
                      {s.hosts.join("、")}
                      {s.started ? ` · 开始 ${fullTime(s.started)}` : ""}
                      {s.finished ? ` · 结束 ${fullTime(s.finished)}` : ""}
                    </small>
                    {s.message && <p>{s.message}</p>}
                    {s.seq > 0 && (
                      <ExecutionLog job={jobId} run={run.id} step={s} />
                    )}{" "}
                    {s.seq > 0 && (
                      <a
                        href={`/api/jobs/${jobId}/executions/${run.id}/logs/${s.id}`}
                        download
                      >
                        <IconDownload /> 下载执行日志
                      </a>
                    )}
                    {s.state === "unknown" && (
                      <p>
                        请在执行节点核实本机及远程任务已停止，再按节点接入说明回传核实结果。尝试编号：
                        <code>{s.id}</code>
                      </p>
                    )}
                  </li>
                ))}
              </ol>
              <div className="exec-evidence">
                发起人 {run.by} · 批次 <code>{run.id}</code> · 固定快照{" "}
                <code title={run.snapshot}>{run.snapshot.slice(0, 12)}</code>
              </div>
            </div>
          </details>
        );
      })}
      <Modal
        className="exec-modal"
        visible={open}
        title="准备自动执行"
        footer={
          <>
            <Button
              disabled={busy}
              onClick={() =>
                stage === 0 ? setOpen(false) : setStage(stage - 1)
              }
            >
              {stage === 0 ? "取消" : "上一步"}
            </Button>
            {stage < 2 ? (
              <Button
                type="primary"
                disabled={
                  !selectedNode ||
                  !selectedNode.authorized ||
                  !online(selectedNode) ||
                  (stage === 1 && !!selectedNode.kind && !ready)
                }
                onClick={() => setStage(stage + 1)}
              >
                {stage === 0 ? "下一步：检查准备" : "下一步：确认步骤"}
              </Button>
            ) : (
              <Button
                type="primary"
                loading={busy}
                disabled={
                  !!error ||
                  !selectedNode ||
                  !selectedNode.authorized ||
                  !online(selectedNode) ||
                  data?.revision !== review?.revision ||
                  !keys.length ||
                  confirm !== cluster ||
                  (!!selectedNode?.kind ? !ready : !prepared)
                }
                onClick={start}
              >
                授权执行 {keys.length} 个步骤
              </Button>
            )}
          </>
        }
        onCancel={() => !busy && setOpen(false)}
        style={{ width: 820, maxWidth: "96vw" }}
      >
        <div className="exec-modal-body">
          <nav className="ex-stage-nav" aria-label="自动执行准备进度">
            {["选择执行机器", "检查接入与材料", "确认执行范围"].map(
              (label, i) => (
                <span
                  key={label}
                  aria-current={stage === i ? "step" : undefined}
                  className={stage === i ? "current" : stage > i ? "done" : ""}
                >
                  <i>{stage > i ? "✓" : i + 1}</i>
                  {label}
                </span>
              ),
            )}
          </nav>
          {error && (
            <p role="alert" className="en-error">
              {error}
            </p>
          )}
          {data?.revision !== review?.revision && (
            <p role="alert" className="en-error">
              交付已更新，请关闭窗口并重新选择执行范围。
            </p>
          )}
          {setupError && (
            <div className="en-error" role="alert">
              {setupError}
            </div>
          )}
          {stage === 0 && (
            <div className="ex-setup-section">
              <header>
                <h3>谁负责执行</h3>
                <p>
                  本交付使用
                  {data?.executor?.kind === "independent"
                    ? "独立管理机"
                    : "集群内机器"}
                  ：<code>{data?.executor?.ip}</code>
                </p>
              </header>
              <Select
                aria-label="执行节点"
                value={node || undefined}
                onChange={setNode}
                placeholder="选择执行节点"
                options={nodeOptions}
              />
              {selectedNode && !online(selectedNode) && <p className="exec-warning" role="status">此执行节点尚未连接或已暂停，请在执行机器启动服务，连接后可继续。</p>}
              {selectedNode?.authorized && <p className="ex-ready">此节点已获准操作本次目标机器。</p>}
              {can("execution.manage") && (
                <a
                  href="/#/settings/execution-nodes"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  接入新的执行节点 ↗
                </a>
              )}
              <div>
                <h3>本次目标机器</h3>
                <p className="ex-help">
                  来自这份交付的配置，授权不会启动任务。
                </p>
                <div className="ex-target-list">
                  {(data?.targets || []).map((h) => (
                    <div key={h.name}>
                      <b>{h.name}</b>
                      <code>{h.ip}</code>
                    </div>
                  ))}
                </div>
              </div>
              {selectedNode && !selectedNode.authorized && (
                <div className="ex-authorization">
                  <p>这个节点还没有获准操作上述机器。</p>
                  {can("execution.manage") ? (
                    <Button
                      loading={busy}
                      onClick={async () => {
                        setBusy(true);
                        setSetupError("");
                        try {
                          await api(`/api/jobs/${jobId}/executions/authorize`, {
                            method: "POST",
                            body: JSON.stringify({
                              node,
                              revision: reviewRevision.current,
                            }),
                          });
                          await load();
                        } catch (e) {
                          setSetupError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      授权此节点操作本交付目标
                    </Button>
                  ) : (
                    <p>请联系执行节点管理员授权。</p>
                  )}
                </div>
              )}
            </div>
          )}
          {stage === 1 && (
            <div className="ex-setup-section">
              <header>
                <h3>连接和材料是否齐全</h3>
                <p>
                  检查执行机器、目标身份、SSH 权限和交付材料。
                  使用 Agent 时会配置已授权的 SSH 公钥；检查不会启动部署任务。
                </p>
              </header>
              {data?.executor.runtime_root && <details className="ex-access-limit">
                <summary>本交付的运行环境放在哪里？</summary>
                <p>先按“环境准备”上传、解包，再完成离线运行环境安装。执行器配置的 root 或 roots 需要包含以下目录：</p>
                <code>{data.executor.runtime_root}</code>
                <p>修改执行器配置前先停止领取任务，当前步骤结束后再重启服务。独立管理机上各集群使用各自目录。</p>
              </details>}
              <TargetAgents
                job={jobId}
                node={node}
                targets={data?.targets || []}
                executorIP={data?.executor.ip || ""}
                onChanged={load}
              />
              <Button
                type="primary"
                loading={busy || preparation?.state === "pending"}
                onClick={async () => {
                  setBusy(true);
                  setSetupError("");
                  try {
                    await api(`/api/jobs/${jobId}/executions/prepare`, {
                      method: "POST",
                      body: JSON.stringify({
                        node,
                        revision: reviewRevision.current,
                      }),
                    });
                    await load();
                  } catch (e) {
                    setSetupError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {preparation ? "重新检查" : "开始准备检查"}
              </Button>
              {preparation?.state === "pending" && (
                <p role="status">
                  等待执行节点检查并回传结果，可以保留此窗口或稍后回来。
                </p>
              )}
              {!!preparation?.checks.length && (
                <div className="ex-check-list">
                  {preparation.checks.map((c) => (
                    <div key={c.id} className={c.state}>
                      <span className="ex-check-mark">
                        {c.state === "passed" ? "✓" : "!"}
                      </span>
                      <div>
                        <b>
                          {c.host ? c.host + " · " : ""}
                          {c.title}
                        </b>
                        <p>{c.message}</p>
                      </div>
                      <span>{c.state === "passed" ? "通过" : "待处理"}</span>
                    </div>
                  ))}
                </div>
              )}
              {preparation?.state === "expired" && (
                <p role="status" className="exec-warning">
                  准备检查已过期或接入信息发生变化，请重新检查。
                </p>
              )}
              {ready && (
                <p className="ex-ready">
                  准备检查已通过，请继续选择本次要执行的步骤。检查结果有效期为
                  10 分钟。
                </p>
              )}
              {!selectedNode?.kind && (
                <p className="ex-help">
                  这是旧版接入节点，保持原授权方式。重新接入新版节点后可强制使用准备检查。
                </p>
              )}
            </div>
          )}
          {stage === 2 && (
            <>
              <div className="exec-review">
                <p>
                  只执行下方勾选的步骤，按原手册顺序运行。失败后停止，不自动重试；已有完成记录不会阻止你主动重跑。
                </p>
                <div className="ex-executor-summary">
                  <b>{selectedNode?.name}</b>
                  <code>{selectedNode?.controller_ip}</code>
                  <span>
                    {selectedNode?.kind === "independent"
                      ? "独立管理机"
                      : "集群内执行机"}
                  </span>
                </div>
                <div className="exec-choices">
                  {(review?.steps || []).map((s) => (
                    <label className="exec-choice" key={s.key}>
                      <Checkbox
                        checked={keys.includes(s.key)}
                        disabled={!s.available}
                        onChange={(v) =>
                          setKeys((k) =>
                            v ? [...k, s.key] : k.filter((x) => x !== s.key),
                          )
                        }
                      />
                      <span>
                        <b>{s.title}</b>
                        <small>
                          {s.phase} · {s.hosts.join("、")} ·{" "}
                          {effects[s.effect] || "修改"}
                          {s.state === "done" ? " · 已有完成记录" : ""}
                        </small>
                        {s.reason && <small>{s.reason}</small>}
                      </span>
                    </label>
                  ))}
                </div>
                {picked.some((s) =>
                  ["disruptive", "destructive"].includes(s.effect),
                ) && (
                  <p className="exec-warning">
                    所选步骤包含中断服务或不可撤销的操作。请按现场维护窗口安排，并核对备份和目标设备。
                  </p>
                )}
                {!selectedNode?.kind && (
                  <Checkbox checked={prepared} onChange={setPrepared}>
                    环境准备已完成：交付包、离线运行器、SSH 信任和所需材料已就绪
                  </Checkbox>
                )}
                <label>
                  <span>
                    输入集群名称 <b>{cluster}</b> 确认
                  </span>
                  <Input
                    value={confirm}
                    onChange={setConfirm}
                    aria-label="确认集群名称"
                    placeholder={cluster}
                  />
                </label>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}

function ExecutionLog({
  job,
  run,
  step,
}: {
  job: string;
  run: string;
  step: Step;
}) {
  const [open, setOpen] = useState(false),
    [text, setText] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let dead = false;
    const load = async () => {
      try {
        const response = await fetch(
          "/api/jobs/" +
            job +
            "/executions/" +
            run +
            "/logs/" +
            step.id +
            "?tail=1",
        );
        if (!response.ok) throw new Error("日志暂时无法读取");
        const value = await response.text();
        if (!dead) {
          setText(value);
          setError("");
        }
      } catch (e) {
        if (!dead) setError((e as Error).message);
      }
    };
    load();
    const id = setInterval(load, 4000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [open, job, run, step.id]);
  return (
    <details
      className="exec-log"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>查看最近输出</summary>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <pre>{text || "等待执行节点回传日志…"}</pre>
      )}
    </details>
  );
}

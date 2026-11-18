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
import { bi, getLang, useLang, withLang } from "./i18n";

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
  get queued() { return bi("等待执行节点领取", "Waiting for execution node"); },
  get pending() { return bi("未执行", "Pending"); },
  get leased() { return bi("已授权，等待启动", "Authorized, starting"); },
  get running() { return bi("正在执行", "Running"); },
  get paused() { return bi("已暂停", "Paused"); },
  get unknown() { return bi("现场状态待核实", "State unknown"); },
  get succeeded() { return bi("检查通过", "Checks passed"); },
  get completed() { return bi("所选步骤已结束", "Steps completed"); },
  get failed() { return bi("失败，后续已停止", "Failed, stopped"); },
  get skipped() { return bi("未执行：条件不满足", "Skipped (condition unmet)"); },
  get closed() { return bi("已结束批次", "Closed"); },
  get interrupted() { return bi("已确认中断", "Interrupted"); },
  get blocked() { return bi("准备受阻，命令未启动", "Blocked before start"); },
};
const active = (r: Run) => !["completed", "failed", "closed"].includes(r.state);
const effects: Record<string, string> = {
  get "read-only"() { return bi("只读", "Read-only"); },
  get change() { return bi("修改配置", "Config change"); },
  get disruptive() { return bi("会中断服务", "Disruptive"); },
  get destructive() { return bi("不可撤销", "Destructive"); },
};

export function ExecutionPanel({
  jobId,
  cluster,
}: {
  jobId: string;
  cluster: string;
}) {
  const lang = useLang();
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
        label: `${n.name} · ${n.controller_ip}${n.compatible === false ? " · " + n.reason : online(n) ? "" : bi(" · 未连接", " · Offline")}`,
        disabled: n.compatible === false,
      })),
    [data, lang],
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
          note: action === "close" ? bi("用户结束批次，后续由现场人员处理", "Closed by operator; remaining steps handled on-site") : "",
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
          <b>{bi("执行方式", "Execution mode")}</b>
          <p>
            {bi(
              "保留手动执行；自动执行会保存每次尝试、机器结果和日志，并汇入报告。",
              "Manual execution remains supported; automated runs record every attempt, host result, and log into reports.",
            )}
          </p>
        </div>
        <div className="exec-actions">
          <Button
            icon={<IconRefresh />}
            onClick={load}
            aria-label={bi("刷新执行状态", "Refresh execution status")}
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
              {bi("选择自动执行步骤", "Select Steps to Auto-run")}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="warn">
          {bi("执行状态加载失败：", "Failed to load execution status: ")}{error}
        </p>
      )}
      {data && !available.length && (
        <p className="exec-hint">
          {bi(
            "这份交付仍使用手动执行。组件需要声明超时和完成检查，并发布“自动执行”能力，之后生成的新交付才能自动运行。",
            "This delivery uses manual execution. Components must declare timeouts and completion checks and publish auto-execution capability for new deliveries.",
          )}
        </p>
      )}
      {data && available.length > 0 && !data.nodes.length && (
        <p className="exec-hint">
          {bi("还没有授权给这个集群的执行节点。", "No execution nodes authorized for this cluster yet.")}
          {can("execution.manage") && (
            <Button
              type="text"
              href="/#/settings/execution-nodes"
              target="_blank"
              rel="noopener noreferrer"
            >
              {bi("接入执行节点", "Connect Execution Node")}
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
                {run.steps.length === 1
                  ? bi("1 个步骤", "1 step")
                  : bi(`${run.steps.length} 个步骤`, `${run.steps.length} steps`)}{" "}
                · {run.executor_name || n?.name || bi("执行节点", "Execution node")} ·{" "}
                {fullTime(run.created)}
              </span>
            </summary>
            <div className="exec-run-body">
              {run.executor_ip && (
                <p className="ex-help">
                  {bi("执行机", "Executor")} <code>{run.executor_ip}</code> ·{" "}
                  {run.executor_kind === "independent"
                    ? bi("独立管理机", "Standalone")
                    : bi("集群内执行机", "In-cluster")}{" "}
                  ·{" "}
                  {run.access_mode === "agent-trust"
                    ? bi("Agent 配置 SSH 信任", "Agent-configured SSH trust")
                    : bi("已有 SSH", "Existing SSH")}
                </p>
              )}
              {disconnected && (
                <p role="status" className="exec-warning">
                  {bi(
                    "暂未收到执行节点心跳，现场状态待核实。已授权的步骤可能还在运行；平台不会重新分配或自动重跑。",
                    "No heartbeat from execution node; on-site state needs verification. Authorized steps may still be running and will not be reassigned or auto-retried.",
                  )}
                </p>
              )}
              {pending && (
                <p className="exec-current">
                  <b>{labels[pending.state]}{bi("：", ": ")}</b>
                  {pending.title}
                  <span>{pending.hosts.join(bi("、", ", "))}</span>
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
                        {bi("继续后续步骤", "Resume")}
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        disabled={busy || run.pause || run.state === "unknown"}
                        onClick={() => action(run, "pause")}
                        icon={<IconPause />}
                      >
                        {run.pause
                          ? bi("当前步骤结束后暂停", "Pausing after current step")
                          : bi("完成当前步骤后暂停", "Pause after current step")}
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
                        {bi("结束批次，保留记录", "Close batch & keep records")}
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
                      {s.hosts.join(bi("、", ", "))}
                      {s.started ? bi(` · 开始 ${fullTime(s.started)}`, ` · Started ${fullTime(s.started)}`) : ""}
                      {s.finished ? bi(` · 结束 ${fullTime(s.finished)}`, ` · Finished ${fullTime(s.finished)}`) : ""}
                    </small>
                    {s.message && <p>{s.message}</p>}
                    {s.seq > 0 && (
                      <ExecutionLog job={jobId} run={run.id} step={s} />
                    )}{" "}
                    {s.seq > 0 && (
                      <a
                        href={withLang(`/api/jobs/${jobId}/executions/${run.id}/logs/${s.id}`)}
                        download
                      >
                        <IconDownload /> {bi("下载执行日志", "Download log")}
                      </a>
                    )}
                    {s.state === "unknown" && (
                      <p>
                        {bi(
                          "请在执行节点核实本机及远程任务已停止，再按节点接入说明回传核实结果。尝试编号：",
                          "Verify on the execution node that local and remote tasks have stopped, then report per node onboarding docs. Attempt ID: ",
                        )}
                        <code>{s.id}</code>
                      </p>
                    )}
                  </li>
                ))}
              </ol>
              <div className="exec-evidence">
                {bi("发起人", "Initiated by")} {run.by} · {bi("批次", "Batch")} <code>{run.id}</code> · {bi("固定快照", "Snapshot")}{" "}
                <code title={run.snapshot}>{run.snapshot.slice(0, 12)}</code>
              </div>
            </div>
          </details>
        );
      })}
      <Modal
        className="exec-modal"
        visible={open}
        title={bi("准备自动执行", "Prepare Automated Execution")}
        footer={
          <>
            <Button
              disabled={busy}
              onClick={() =>
                stage === 0 ? setOpen(false) : setStage(stage - 1)
              }
            >
              {stage === 0 ? bi("取消", "Cancel") : bi("上一步", "Back")}
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
                {stage === 0
                  ? bi("下一步：检查准备", "Next: Pre-flight Checks")
                  : bi("下一步：确认步骤", "Next: Confirm Steps")}
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
                {keys.length === 1
                  ? bi("授权执行 1 个步骤", "Authorize 1 Step")
                  : bi(`授权执行 ${keys.length} 个步骤`, `Authorize ${keys.length} Steps`)}
              </Button>
            )}
          </>
        }
        onCancel={() => !busy && setOpen(false)}
        style={{ width: 820, maxWidth: "96vw" }}
      >
        <div className="exec-modal-body">
          <nav className="ex-stage-nav" aria-label={bi("自动执行准备进度", "Automated execution wizard")}>
            {[
              bi("选择执行机器", "Select Executor"),
              bi("检查接入与材料", "Verify Access & Artifacts"),
              bi("确认执行范围", "Confirm Scope"),
            ].map(
              (label, i) => (
                <span
                  key={i}
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
              {bi("交付已更新，请关闭窗口并重新选择执行范围。", "Delivery has been updated; close and reopen to select scope.")}
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
                <h3>{bi("谁负责执行", "Who runs the execution")}</h3>
                <p>
                  {bi("本交付使用", "This delivery uses ")}
                  {data?.executor?.kind === "independent"
                    ? bi("独立管理机", "standalone host")
                    : bi("集群内机器", "in-cluster host")}
                  {bi("：", ": ")}<code>{data?.executor?.ip}</code>
                </p>
              </header>
              <Select
                aria-label={bi("执行节点", "Execution node")}
                value={node || undefined}
                onChange={setNode}
                placeholder={bi("选择执行节点", "Select execution node")}
                options={nodeOptions}
              />
              {selectedNode && !online(selectedNode) && (
                <p className="exec-warning" role="status">
                  {bi(
                    "此执行节点尚未连接或已暂停，请在执行机器启动服务，连接后可继续。",
                    "This execution node is offline or paused; start the agent on the executor host to continue.",
                  )}
                </p>
              )}
              {selectedNode?.authorized && (
                <p className="ex-ready">
                  {bi("此节点已获准操作本次目标机器。", "This node is authorized for the target hosts.")}
                </p>
              )}
              {can("execution.manage") && (
                <a
                  href="/#/settings/execution-nodes"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {bi("接入新的执行节点 ↗", "Connect new execution node ↗")}
                </a>
              )}
              <div>
                <h3>{bi("本次目标机器", "Target hosts")}</h3>
                <p className="ex-help">
                  {bi("来自这份交付的配置，授权不会启动任务。", "From this delivery's configuration; authorizing does not start tasks.")}
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
                  <p>{bi("这个节点还没有获准操作上述机器。", "This node is not yet authorized for these hosts.")}</p>
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
                      {bi("授权此节点操作本交付目标", "Authorize Node for Targets")}
                    </Button>
                  ) : (
                    <p>{bi("请联系执行节点管理员授权。", "Contact an execution node administrator for authorization.")}</p>
                  )}
                </div>
              )}
            </div>
          )}
          {stage === 1 && (
            <div className="ex-setup-section">
              <header>
                <h3>{bi("连接和材料是否齐全", "Connectivity & artifacts")}</h3>
                <p>
                  {bi(
                    "检查执行机器、目标身份、SSH 权限和交付材料。使用 Agent 时会配置已授权的 SSH 公钥；检查不会启动部署任务。",
                    "Checks executor host, target identity, SSH access, and delivery artifacts. Authorized SSH keys are configured when using Agents; checks do not start deployment.",
                  )}
                </p>
              </header>
              {data?.executor.runtime_root && <details className="ex-access-limit">
                <summary>{bi("本交付的运行环境放在哪里？", "Where is the runtime located?")}</summary>
                <p>{bi("先按“环境准备”上传、解包，再完成离线运行环境安装。执行器配置的 root 或 roots 需要包含以下目录：", "Upload, unpack, and install the offline runtime per Environment Prep first. The executor's root or roots config must include:")}</p>
                <code>{data.executor.runtime_root}</code>
                <p>{bi("修改执行器配置前先停止领取任务，当前步骤结束后再重启服务。独立管理机上各集群使用各自目录。", "Pause task polling before updating executor config and restart after current steps finish. Each cluster uses an isolated directory on standalone hosts.")}</p>
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
                {preparation ? bi("重新检查", "Re-run Checks") : bi("开始准备检查", "Run Pre-flight Checks")}
              </Button>
              {preparation?.state === "pending" && (
                <p role="status">
                  {bi(
                    "等待执行节点检查并回传结果，可以保留此窗口或稍后回来。",
                    "Waiting for execution node results; you may keep this dialog open or check back later.",
                  )}
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
                      <span>{c.state === "passed" ? bi("通过", "Passed") : bi("待处理", "Pending")}</span>
                    </div>
                  ))}
                </div>
              )}
              {preparation?.state === "expired" && (
                <p role="status" className="exec-warning">
                  {bi("准备检查已过期或接入信息发生变化，请重新检查。", "Pre-flight check expired or access changed; please re-run.")}
                </p>
              )}
              {ready && (
                <p className="ex-ready">
                  {bi(
                    "准备检查已通过，请继续选择本次要执行的步骤。检查结果有效期为 10 分钟。",
                    "Pre-flight checks passed; proceed to select steps. Results remain valid for 10 minutes.",
                  )}
                </p>
              )}
              {!selectedNode?.kind && (
                <p className="ex-help">
                  {bi(
                    "这是旧版接入节点，保持原授权方式。重新接入新版节点后可强制使用准备检查。",
                    "Legacy node keeping original authorization. Re-onboard with a current agent to enforce pre-flight checks.",
                  )}
                </p>
              )}
            </div>
          )}
          {stage === 2 && (
            <>
              <div className="exec-review">
                <p>
                  {bi(
                    "只执行下方勾选的步骤，按原手册顺序运行。失败后停止，不自动重试；已有完成记录不会阻止你主动重跑。",
                    "Only checked steps will run, in runbook order. Stops on failure without auto-retry; completed records do not block manual re-runs.",
                  )}
                </p>
                <div className="ex-executor-summary">
                  <b>{selectedNode?.name}</b>
                  <code>{selectedNode?.controller_ip}</code>
                  <span>
                    {selectedNode?.kind === "independent"
                      ? bi("独立管理机", "Standalone")
                      : bi("集群内执行机", "In-cluster")}
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
                          {s.phase} · {s.hosts.join(bi("、", ", "))} ·{" "}
                          {effects[s.effect] || bi("修改", "Change")}
                          {s.state === "done" ? bi(" · 已有完成记录", " · Previously completed") : ""}
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
                    {bi(
                      "所选步骤包含中断服务或不可撤销的操作。请按现场维护窗口安排，并核对备份和目标设备。",
                      "Selected steps include disruptive or irreversible actions. Schedule within a maintenance window and verify backups and target devices.",
                    )}
                  </p>
                )}
                {!selectedNode?.kind && (
                  <Checkbox checked={prepared} onChange={setPrepared}>
                    {bi(
                      "环境准备已完成：交付包、离线运行器、SSH 信任和所需材料已就绪",
                      "Environment prep complete: packages, offline runner, SSH trust, and artifacts are ready",
                    )}
                  </Checkbox>
                )}
                <label>
                  <span>
                    {bi("输入集群名称", "Type cluster name")} <b>{cluster}</b> {bi("确认", "to confirm")}
                  </span>
                  <Input
                    value={confirm}
                    onChange={setConfirm}
                    aria-label={bi("确认集群名称", "Confirm cluster name")}
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
  useLang();
  const [open, setOpen] = useState(false),
    [text, setText] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let dead = false;
    const load = async () => {
      try {
        const response = await fetch(
          withLang(
            "/api/jobs/" +
              job +
              "/executions/" +
              run +
              "/logs/" +
              step.id +
              "?tail=1",
          ),
          { headers: { "X-Lang": getLang() } },
        );
        if (!response.ok) throw new Error(bi("日志暂时无法读取", "Unable to load log"));
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
      <summary>{bi("查看最近输出", "View recent output")}</summary>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <pre>{text || bi("等待执行节点回传日志…", "Waiting for execution node logs…")}</pre>
      )}
    </details>
  );
}

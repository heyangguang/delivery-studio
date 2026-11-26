import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Drawer, Input, Modal, Select, Tooltip } from "@arco-design/web-react";
import {
  IconCheck,
  IconCheckCircleFill,
  IconCloseCircleFill,
  IconCopy,
  IconDown,
  IconDownload,
  IconExclamationCircleFill,
  IconLaunch,
  IconLoading,
  IconPlayArrow,
  IconPause,
  IconRefresh,
  IconRight,
  IconSettings,
} from "@arco-design/web-react/icon";
import { go } from "../../app/router";
import { api, ApiError, can, copy, err, fullTime } from "../../shared/shared";
import {
  ExecutionNode as Node,
  ExecutionPreparation,
  isExecutionNodeOnline as online,
} from "./execution-types";
import "./executions.css";
import { TargetAgents } from "./target-agents";
import {
  consumeExecLaunchIntent,
  ExecLaunchIntent,
} from "../projects/stephotfix";
import { bi, getLang, useLang, withLang } from "../../app/i18n";
import { AIHelpButton } from "../ai/aichat";

type StepRecap = {
  host?: string;
  ok?: number;
  changed?: number;
  skipped?: number;
  failed?: number;
  unreachable?: number;
};
type Step = {
  id: string;
  key: string;
  title: string;
  hosts: string[];
  state: string;
  message?: string;
  started?: string;
  finished?: string;
  exit_code?: number;
  recap?: StepRecap[];
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
  patched_files?: string[];
  sync_version?: number;
  safety_confirmed?: boolean;
  safety_warnings?: string[];
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
  env_hash?: string;
  patches?: { id: string; path: string; reason?: string; by: string; at: string }[];
  sync_count?: number;
  data_warnings?: string[];
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

function fmtDur(started?: string, finished?: string): string {
  if (!started || !finished) return "";
  const a = Date.parse(started);
  const b = Date.parse(finished);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return "";
  const sec = Math.max(0, Math.round((b - a) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

function AttemptLogDrawer({
  jobId,
  item,
  laterPassed,
  onClose,
  onFocusStep,
}: {
  jobId: string;
  item: { run: Run; runNum: number; step: Step } | null;
  laterPassed: boolean;
  onClose: () => void;
  onFocusStep: (stepKey: string) => void;
}) {
  useLang();
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [showFullLog, setShowFullLog] = useState(false);
  const copyTimerRef = useRef<number>(0);

  const run = item?.run;
  const step = item?.step;
  const hasLog = Boolean(run && step && step.seq > 0);
  const logUrl =
    run && step
      ? `/api/jobs/${jobId}/executions/${run.id}/logs/${step.id}`
      : "";

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setText(null);
    setLoadErr("");
    setCopied(false);
    setShowFullLog(false);
    if (!hasLog || !logUrl) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetch(withLang(logUrl), {
      headers: { "X-Lang": getLang() },
      signal: ctrl.signal,
    })
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.text();
      })
      .then((t) => {
        if (!ctrl.signal.aborted) setText(t);
      })
      .catch((e) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
          return;
        }
        setLoadErr(
          bi(
            `加载该次尝试日志失败：${err(e)}`,
            `Failed to load attempt log: ${err(e)}`,
          ),
        );
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [hasLog, logUrl]);

  const dur = fmtDur(step?.started, step?.finished);
  const isStepFail = Boolean(
    step && ["failed", "interrupted", "blocked", "unknown"].includes(step.state),
  );

  return (
    <Drawer
      className="exec-log-drawer"
      width="min(680px, 100vw)"
      visible={Boolean(item)}
      onCancel={onClose}
      footer={null}
      title={
        item ? (
          <div className="exec-drawer-title">
            <span>{step!.title}</span>
            <span className={`exec-status ${step!.state}`}>
              {labels[step!.state] || step!.state}
            </span>
            {isStepFail && laterPassed && (
              <span className="exec-status recovered">
                {bi("后续批次已通过", "Passed in later batch")}
              </span>
            )}
          </div>
        ) : null
      }
    >
      {item && run && step && (
        <div className="exec-drawer-body">
          <div className="exec-drawer-meta">
            <span>
              <b>{bi(`第 ${item.runNum} 批`, `Batch #${item.runNum}`)}</b>{" "}
              <code className="mono">{run.id.slice(0, 12)}</code>
            </span>
            <span>
              {bi("快照", "Snapshot")}{" "}
              <code className="mono" title={run.snapshot}>
                {run.snapshot.slice(0, 12)}
              </code>
            </span>
            <span>
              {bi("发起人", "By")} {run.by}
            </span>
            {run.executor_name && (
              <span>
                {run.executor_name}
                {run.executor_ip ? ` (${run.executor_ip})` : ""}
              </span>
            )}
            {step.started && (
              <span>
                {bi("开始", "Started")} {fullTime(step.started)}
              </span>
            )}
            {dur && (
              <span className="num">
                {bi("耗时", "Took")} {dur}
              </span>
            )}
            {typeof step.exit_code === "number" && (
              <span className={step.exit_code !== 0 ? "exec-exit-bad num" : "num"}>
                exit {step.exit_code}
              </span>
            )}
          </div>

          {step.message && (
            <div className={`exec-drawer-msg ${isStepFail ? "bad" : ""}`}>
              {step.message}
            </div>
          )}

          {step.recap && step.recap.length > 0 && (
            <div className="exec-drawer-recap">
              {step.recap.map((raw, idx) => {
                const h = raw as StepRecap & {
                  Host?: string;
                  OK?: number;
                  Changed?: number;
                  Skipped?: number;
                  Failed?: number;
                  Unreachable?: number;
                };
                const host = h.host ?? h.Host ?? "";
                const ok = h.ok ?? h.OK ?? 0;
                const changed = h.changed ?? h.Changed ?? 0;
                const skipped = h.skipped ?? h.Skipped ?? 0;
                const failed = h.failed ?? h.Failed ?? 0;
                const unreachable = h.unreachable ?? h.Unreachable ?? 0;
                const bad = failed > 0 || unreachable > 0;
                return (
                  <span
                    key={host || idx}
                    className={`exec-recap-chip${bad ? " bad" : ""}`}
                  >
                    <b>{host}</b>
                    <span>
                      ok={ok} changed={changed}
                      {skipped > 0 ? ` skipped=${skipped}` : ""}
                      {failed > 0 ? ` failed=${failed}` : ""}
                      {unreachable > 0 ? ` unreachable=${unreachable}` : ""}
                    </span>
                  </span>
                );
              })}
            </div>
          )}

          <div className="exec-drawer-actions">
            {hasLog && (
              <>
                <Button
                  size="small"
                  icon={copied ? <IconCheck /> : <IconCopy />}
                  disabled={!text}
                  onClick={() => {
                    copy(text || "");
                    setCopied(true);
                    if (copyTimerRef.current) {
                      window.clearTimeout(copyTimerRef.current);
                    }
                    copyTimerRef.current = window.setTimeout(
                      () => setCopied(false),
                      1400,
                    );
                  }}
                >
                  {copied ? bi("已复制", "Copied") : bi("复制完整日志", "Copy log")}
                </Button>
                <Button
                  size="small"
                  icon={<IconDownload />}
                  href={withLang(logUrl)}
                  download={`execution-${step.id}.log`}
                >
                  {bi("下载日志", "Download")}
                </Button>
              </>
            )}
            <Button
              size="small"
              type="outline"
              icon={<IconLaunch />}
              onClick={() => {
                onClose();
                go({ name: "executions", id: jobId, run: run.id, step: step.id });
              }}
            >
              {bi("在实时监控台打开", "Open in Live Monitor")}
            </Button>
            <Button
              size="small"
              type="outline"
              onClick={() => {
                onClose();
                onFocusStep(step.key);
              }}
            >
              {bi("定位到手册该步骤", "Jump to step in runbook")}
            </Button>
          </div>

          <div className="exec-drawer-log">
            {!hasLog ? (
              <p className="muted small">
                {step.state === "pending"
                  ? bi(
                      "本批次因前面步骤失败而中止，该步骤在此次批次中尚未启动。",
                      "This batch stopped after an earlier failure; this step did not start in this batch.",
                    )
                  : bi("该次尝试暂无终端输出日志。", "No terminal output recorded for this attempt.")}
              </p>
            ) : loadErr ? (
              <p className="bad small">{loadErr}</p>
            ) : loading && text === null ? (
              <p className="faint small">
                {bi("正在加载该次执行的完整日志…", "Loading execution log…")}
              </p>
            ) : (
              <>
                {text && text.length > 120_000 && !showFullLog && (
                  <div className="exec-log-window-bar">
                    <span>
                      {bi(
                        `日志较长（约 ${Math.round(text.length / 1024)} KB），当前仅展示末尾片段以保持流畅`,
                        `Large log (~${Math.round(text.length / 1024)} KB); showing tail excerpt for smooth scrolling`,
                      )}
                    </span>
                    <Button
                      size="mini"
                      type="outline"
                      onClick={() => setShowFullLog(true)}
                    >
                      {bi("显示完整日志", "Show full log")}
                    </Button>
                  </div>
                )}
                <pre className="mono">
                  {text
                    ? text.length > 120_000 && !showFullLog
                      ? `…\n${text.slice(-120_000)}`
                      : text
                    : bi("（暂无输出）", "(No output)")}
                </pre>
              </>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

export function ExecutionPanel({
  jobId,
  cluster,
  deliveryMode,
}: {
  jobId: string;
  cluster: string;
  deliveryMode?: string;
}) {
  const lang = useLang();
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [node, setNode] = useState(""),
    [keys, setKeys] = useState<string[]>([]),
    [confirm, setConfirm] = useState(""),
    [safeConfirmed, setSafeConfirmed] = useState(false),
    [safetyConfirmed, setSafetyConfirmed] = useState(false),
    [serverSafetyWarnings, setServerSafetyWarnings] = useState<string[]>([]),
    [prepared, setPrepared] = useState(false);
  const [review, setReview] = useState<Data | null>(null);
  const [setupError, setSetupError] = useState("");
  const [accessOpen, setAccessOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [collapsedPhases, setCollapsedPhases] = useState<Record<string, boolean>>({});
  const [batchesOpen, setBatchesOpen] = useState(false);
  const [batchFilter, setBatchFilter] = useState<"all" | "failed">("all");
  const [inspect, setInspect] = useState<{
    run: Run;
    runNum: number;
    step: Step;
  } | null>(null);
  const selectedNode = data?.nodes.find((n) => n.id === node);
  const preparation = data?.preparations?.find(
    (p) =>
      p.node === node &&
      (p.revision === review?.revision || (!!p.env_hash && !!p.env_match)),
  );
  const prepMaxMs = preparation?.env_hash ? 3600000 : 600000;
  const prepExpiresInMin =
    preparation?.finished && preparation.state === "ready" && !preparation.invalidated
      ? Math.max(0, Math.ceil((prepMaxMs - (Date.now() - Date.parse(preparation.finished))) / 60000))
      : 0;
  const ready =
    !error &&
    data?.revision === review?.revision &&
    preparation?.state === "ready" &&
    !preparation.invalidated &&
    !!preparation.finished &&
    Date.now() - Date.parse(preparation.finished) < prepMaxMs;
  const prepReused = Boolean(
    ready && preparation && preparation.revision !== review?.revision && preparation.env_match,
  );
  const prepFailed = Boolean(
    preparation &&
      (preparation.state === "blocked" ||
        preparation.checks.some((c) => c.state !== "passed")),
  );
  const nodeOptions = useMemo(
    () =>
      (data?.nodes || []).map((n) => ({
        value: n.id,
        label: `${n.name} · ${n.controller_ip}${n.compatible === false ? " · " + n.reason : online(n) ? (n.authorized ? "" : bi(" · 待授权", " · Needs auth")) : bi(" · 未连接", " · Offline")}`,
        disabled: n.compatible === false,
      })),
    [data, lang],
  );
  const request = useRef(""),
    last = useRef(""),
    reviewRevision = useRef(""),
    busyLockRef = useRef(false),
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
      if (!dead && document.visibilityState === "visible") void load();
    };
    void load();
    const id = window.setInterval(tick, 5000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      dead = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [jobId]);
  // Speed up polling to 2s while pre-flight check is actively running in the modal
  useEffect(() => {
    if (!open || preparation?.state !== "pending") return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 2000);
    return () => clearInterval(id);
  }, [open, preparation?.state, jobId]);
  // Auto-open check details when a pre-flight check fails so root cause is immediately visible
  useEffect(() => {
    if (open && prepFailed) setChecksOpen(true);
  }, [open, prepFailed]);
  const action = async (r: Run, action: string) => {
    if (busyLockRef.current) return;
    busyLockRef.current = true;
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
      busyLockRef.current = false;
      setBusy(false);
    }
  };
  const authorizeNode = async () => {
    if (!node || busyLockRef.current) return;
    busyLockRef.current = true;
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
      busyLockRef.current = false;
      setBusy(false);
    }
  };
  const runPrecheck = async () => {
    if (!node || busyLockRef.current) return;
    busyLockRef.current = true;
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
      busyLockRef.current = false;
      setBusy(false);
    }
  };
  const openLaunchModal = (
    source: Data,
    preset?: Pick<ExecLaunchIntent, "mode" | "stepKey">,
  ) => {
    setReview(source);
    // Smart auto-pick best execution node
    const compat = source.nodes.filter((n) => n.compatible !== false);
    const lastRunNodeId = source.runs[0]?.node;
    const bestNode =
      compat.find((n) => n.id === lastRunNodeId && online(n)) ||
      compat.find((n) => online(n) && n.authorized) ||
      compat.find((n) => online(n)) ||
      compat[0];
    setNode(bestNode?.id || "");

    const availSteps = source.steps.filter((s) => s.available);
    const isDone = (st?: string) =>
      ["done", "resolved", "skipped"].includes(st || "");
    let defaultKeys: string[] = [];

    if (preset?.stepKey && (preset.mode === "single" || preset.mode === "from")) {
      const target = availSteps.find((s) => s.key === preset.stepKey);
      if (target) {
        if (preset.mode === "single") {
          defaultKeys = [target.key];
        } else {
          const ph = target.key.split("/", 1)[0];
          const inPhase = availSteps.filter((s) => s.key.split("/", 1)[0] === ph);
          const idx = inPhase.findIndex((s) => s.key === target.key);
          const tail = inPhase.slice(Math.max(0, idx));
          const todoTail = tail.filter((s) => s.key === target.key || !isDone(s.state));
          defaultKeys = (todoTail.length > 0 ? todoTail : tail).map((s) => s.key);
        }
      }
    }

    if (defaultKeys.length === 0) {
      const firstFail = availSteps.find((s) => s.state === "failed");
      if (firstFail) {
        const failPhase = firstFail.key.split("/", 1)[0];
        const inPhase = availSteps.filter(
          (s) => s.key.split("/", 1)[0] === failPhase,
        );
        const idx = inPhase.findIndex((s) => s.key === firstFail.key);
        defaultKeys = inPhase
          .slice(Math.max(0, idx))
          .filter((s) => !isDone(s.state))
          .map((s) => s.key);
      } else {
        const firstTodo = availSteps.find((s) => !isDone(s.state));
        if (firstTodo) {
          const todoPhase = firstTodo.key.split("/", 1)[0];
          defaultKeys = availSteps
            .filter(
              (s) =>
                s.key.split("/", 1)[0] === todoPhase && !isDone(s.state),
            )
            .map((s) => s.key);
        }
      }
    }
    setKeys(defaultKeys);

    // Auto-collapse phases that are 100% completed unless selected
    const phaseMap = new Map<string, Choice[]>();
    for (const s of source.steps) {
      const p = s.key.split("/", 1)[0];
      const list = phaseMap.get(p) || [];
      list.push(s);
      phaseMap.set(p, list);
    }
    const nextCollapsed: Record<string, boolean> = {};
    const selectedSet = new Set(defaultKeys);
    phaseMap.forEach((list, p) => {
      const allFinished = list.every((s) => isDone(s.state));
      const hasSelected = list.some((s) => selectedSet.has(s.key));
      nextCollapsed[p] = allFinished && !hasSelected;
    });
    setCollapsedPhases(nextCollapsed);

    setConfirm("");
    setSafeConfirmed(true);
    setSafetyConfirmed(false);
    setServerSafetyWarnings([]);
    setPrepared(false);
    setAccessOpen(false);
    setChecksOpen(false);
    setSetupError("");
    request.current = crypto.randomUUID();
    reviewRevision.current = source.revision;
    setOpen(true);
  };

  // Refresh data immediately when hotfix patches or component syncs update this delivery
  useEffect(() => {
    const onPatched = (ev: Event) => {
      const det = (ev as CustomEvent<{ jobId?: string }>).detail;
      if (!det?.jobId || det.jobId === jobId) void load();
    };
    window.addEventListener("mh-delivery-patched", onPatched);
    return () => window.removeEventListener("mh-delivery-patched", onPatched);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Listen for direct step-retry / resume-from-step presets (from StepHotfixDrawer or Monitor)
  useEffect(() => {
    const handlePreset = (ev: Event) => {
      const det = (ev as CustomEvent<ExecLaunchIntent>).detail;
      if (!det || det.jobId !== jobId || !can("delivery.execute")) return;
      void api<Data>(`/api/jobs/${jobId}/executions`)
        .then((fresh) => {
          if (current.current !== jobId) return;
          setData(fresh);
          if (fresh.runs.some(active)) return;
          openLaunchModal(fresh, { mode: det.mode, stepKey: det.stepKey });
        })
        .catch(err);
    };
    window.addEventListener("mh-execution-launch-preset", handlePreset);
    return () =>
      window.removeEventListener("mh-execution-launch-preset", handlePreset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Consume cross-page launch intent (e.g. navigated from Live Execution Monitor)
  useEffect(() => {
    if (!data || !can("delivery.execute") || data.runs.some(active)) return;
    const intent = consumeExecLaunchIntent(jobId);
    if (intent) {
      openLaunchModal(data, { mode: intent.mode, stepKey: intent.stepKey });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, jobId]);

  const start = async () => {
    if (!data || busyLockRef.current) return;
    const hasRisky = picked.some((s) =>
      ["disruptive", "destructive"].includes(s.effect),
    );
    const effectiveConfirm = hasRisky ? confirm : safeConfirmed ? cluster : "";
    busyLockRef.current = true;
    setBusy(true);
    try {
      const created = await api<Run>(`/api/jobs/${jobId}/executions`, {
        method: "POST",
        body: JSON.stringify({
          node,
          keys,
          confirm: effectiveConfirm,
          confirm_safety: safetyConfirmed,
          prepared,
          preparation: preparation?.id,
          revision: reviewRevision.current,
          request: request.current,
        }),
      });
      setOpen(false);
      window.dispatchEvent(
        new CustomEvent("execution-updated", { detail: { jobId } }),
      );
      if (created?.id) {
        go({ name: "executions", id: jobId, run: created.id });
      } else {
        await load();
      }
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        e.body?.need_safety_confirm
      ) {
        setServerSafetyWarnings(
          Array.isArray(e.body.safety_warnings) ? e.body.safety_warnings : [],
        );
        setSafetyConfirmed(false);
        setSetupError(e.message);
      } else {
        err(e);
      }
    } finally {
      busyLockRef.current = false;
      setBusy(false);
    }
  };
  const running = data?.runs.find(active);
  const available = data?.steps.filter((s) => s.available) || [];
  const picked = review?.steps.filter((s) => keys.includes(s.key)) || [];
  const hasRiskyPicked = picked.some((s) =>
    ["disruptive", "destructive"].includes(s.effect),
  );
  const safetyWarnings = useMemo(() => {
    const out: string[] = [];
    const push = (m: string) => {
      if (m && !out.includes(m)) out.push(m);
    };
    const anyDone = (review?.steps || []).some((s) =>
      ["done", "resolved"].includes(s.state || ""),
    );
    let hasMutating = false;
    for (const s of picked) {
      const risky = s.effect === "destructive" || s.effect === "disruptive";
      if (s.effect !== "read-only") hasMutating = true;
      if (risky && ["done", "resolved"].includes(s.state || "")) {
        push(
          bi(
            `步骤「${s.title}」此前已执行通过，且属于高风险操作（${effects[s.effect] || s.effect}），重复执行可能覆盖已有数据或中断服务`,
            `Step "${s.title}" already passed earlier and is ${s.effect}; re-running may overwrite data or disrupt service.`,
          ),
        );
      } else if (s.effect === "destructive" && anyDone) {
        push(
          bi(
            `本交付已在目标机器执行过前置步骤（可能已有初始化数据），即将执行不可撤销步骤「${s.title}」`,
            `Earlier steps already ran on target hosts; about to execute destructive step "${s.title}".`,
          ),
        );
      }
    }
    if (hasMutating) {
      const prepWarnings =
        preparation?.checks?.flatMap((c) => c.warnings || []) ||
        data?.data_warnings ||
        [];
      prepWarnings.forEach(push);
    }
    serverSafetyWarnings.forEach(push);
    return out;
  }, [picked, review?.steps, preparation?.checks, data?.data_warnings, serverSafetyWarnings]);
  const safetySig = safetyWarnings.join("\n");
  useEffect(() => {
    setSafetyConfirmed(false);
  }, [safetySig]);
  const confirmValid =
    (hasRiskyPicked ? confirm === cluster : safeConfirmed) &&
    (safetyWarnings.length === 0 || safetyConfirmed);
  const focusStep = (stepKey: string) => {
    window.dispatchEvent(
      new CustomEvent("mh-runbook-focus", { detail: { key: stepKey } }),
    );
  };
  // Pure offline deliveries without automated history stay focused on manual execution.
  if (deliveryMode === "offline" && data && data.runs.length === 0) {
    return null;
  }
  const totalAutoSteps = (data?.runs || []).reduce(
    (sum, r) => sum + r.steps.length,
    0,
  );
  const onlineNodes = (data?.nodes || []).filter(
    (n) => n.compatible !== false && online(n),
  );
  const finalStateByKey = new Map<string, string>(
    (data?.steps || []).map((s) => [s.key, s.state || ""]),
  );
  const isStepSettled = (key: string) =>
    ["done", "resolved", "skipped"].includes(finalStateByKey.get(key) || "");
  const allSteps = data?.steps || [];
  const allDoneCount = allSteps.filter((s) =>
    ["done", "resolved", "skipped"].includes(s.state || ""),
  ).length;
  const stillFailedCount = allSteps.filter((s) => s.state === "failed").length;
  const runs = data?.runs || [];
  const isRunRecovered = (run: Run) => {
    if (run.state !== "failed") return false;
    const failedSteps = run.steps.filter((s) =>
      ["failed", "interrupted", "blocked", "unknown"].includes(s.state),
    );
    return (
      failedSteps.length > 0 && failedSteps.every((s) => isStepSettled(s.key))
    );
  };
  const failedRunsCount = runs.filter((r) => r.state === "failed").length;
  const recoveredRunsCount = runs.filter(isRunRecovered).length;
  const visibleRuns =
    batchFilter === "failed"
      ? runs.filter((r) => r.state === "failed")
      : runs;
  const phaseLabel = (key: string) => {
    const p = key.split("/", 1)[0];
    return p === "deploy"
      ? bi("部署", "Deploy")
      : p === "tests"
        ? bi("功能测试", "Tests")
        : p === "endpoint"
          ? bi("入口测试", "Endpoint")
          : p === "cleanup"
            ? bi("清理", "Cleanup")
            : p === "prepare"
              ? bi("环境准备", "Prepare")
              : p;
  };
  return (
    <div className="exec-panel exec-compact">
      <div className="exec-bar">
        <div className="exec-bar-info">
          {data ? (
            <span className={`exec-node-pill ${onlineNodes.length ? "on" : ""}`}>
              <i aria-hidden />
              {onlineNodes.length > 0
                ? bi(
                    `${onlineNodes.length} 台执行节点在线`,
                    `${onlineNodes.length} runner online`,
                  )
                : bi("执行节点未连接", "No runner online")}
            </span>
          ) : (
            <span className="exec-node-pill">
              <i aria-hidden />
              {bi("正在读取执行节点…", "Checking runners…")}
            </span>
          )}
          {data && allSteps.length > 0 && !running && (
            stillFailedCount > 0 ? (
              <span className="exec-summary-pill bad num">
                {bi(
                  `当前 ${stillFailedCount} 步失败待处理`,
                  `${stillFailedCount} failed`,
                )}
              </span>
            ) : allDoneCount === allSteps.length ? (
              <span className="exec-summary-pill ok num">
                {bi(
                  `当前最终态：全部 ${allSteps.length} 步已通过`,
                  `Current: all ${allSteps.length} steps passed`,
                )}
              </span>
            ) : allDoneCount > 0 ? (
              <span className="exec-summary-pill num">
                {bi(
                  `已通过 ${allDoneCount} / ${allSteps.length} 步`,
                  `${allDoneCount} / ${allSteps.length} passed`,
                )}
              </span>
            ) : null
          )}
          {runs.length > 0 ? (
            <button
              type="button"
              className={`exec-batch-toggle ${batchesOpen ? "open" : ""}`}
              aria-expanded={batchesOpen}
              onClick={() => setBatchesOpen((v) => !v)}
            >
              <span>
                {bi(
                  `历史执行 ${runs.length} 批次（${totalAutoSteps} 步）`,
                  `${runs.length} ${runs.length === 1 ? "batch" : "batches"} (${totalAutoSteps} steps)`,
                )}
              </span>
              {failedRunsCount > 0 && (
                <em
                  className={`exec-batch-hint ${recoveredRunsCount === failedRunsCount ? "recovered" : "bad"}`}
                >
                  {recoveredRunsCount === failedRunsCount
                    ? bi(
                        `含 ${failedRunsCount} 次历史失败，已全部恢复`,
                        `${failedRunsCount} earlier failed, all recovered`,
                      )
                    : bi(
                        `含 ${failedRunsCount - recoveredRunsCount} 次未恢复失败`,
                        `${failedRunsCount - recoveredRunsCount} unresolved`,
                      )}
                </em>
              )}
              <IconDown />
            </button>
          ) : (
            <span className="exec-bar-note">
              {bi(
                "执行状态与完整日志直接回传至下方步骤",
                "Step results & full logs appear inline below",
              )}
            </span>
          )}
        </div>
        <div className="exec-actions">
          {runs.length > 0 && (
            <Button
              size="small"
              type={running ? "primary" : "outline"}
              icon={<IconLaunch />}
              onClick={() =>
                go({
                  name: "executions",
                  id: jobId,
                  run: running?.id,
                })
              }
            >
              {running
                ? bi("实时监控台（运行中）", "Live Monitor (Running)")
                : bi("实时监控台", "Execution Monitor")}
            </Button>
          )}
          <Button
            size="small"
            icon={<IconRefresh />}
            onClick={load}
            aria-label={bi("刷新执行状态", "Refresh execution status")}
          />
          {can("delivery.execute") && (
            <Button
              size="small"
              type="primary"
              icon={<IconPlayArrow />}
              disabled={!data || !!running || !available.length}
              onClick={() => {
                if (!data) return;
                openLaunchModal(data);
              }}
            >
              {stillFailedCount > 0
                ? bi("续跑 / 自动执行", "Resume / Auto-run")
                : bi("自动执行", "Auto-run")}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <div role="alert" className="exec-inline-error">
          {bi("执行状态加载失败：", "Failed to load execution status: ")}{error}
        </div>
      )}
      {data && !available.length && (
        <p className="exec-hint">
          <span>
            {bi(
              "当前交付的组件版本暂未声明自动执行契约，请按下方手册手动执行。",
              "Component revisions in this delivery do not declare automated execution contracts; follow the manual runbook below.",
            )}
          </span>
        </p>
      )}
      {data && available.length > 0 && !data.nodes.length && (
        <p className="exec-hint">
          <span>
            {bi("还没有授权给这个集群的执行节点。", "No execution nodes authorized for this cluster yet.")}
          </span>
          {can("execution.manage") && (
            <Button
              size="small"
              type="text"
              href="#/executions/nodes"
              target="_blank"
              rel="noopener noreferrer"
            >
              {bi("接入执行节点", "Connect Execution Node")}
            </Button>
          )}
        </p>
      )}
      {running && (() => {
        const n = data?.nodes.find((x) => x.id === running.node);
        const disconnected = !n?.disabled && (!n || !online(n));
        const curStep =
          running.steps.find((s) =>
            ["running", "leased", "unknown"].includes(s.state),
          ) || running.steps.find((s) => s.state === "pending");
        const doneCount = running.steps.filter((s) =>
          ["succeeded", "skipped"].includes(s.state),
        ).length;
        return (
          <div className="exec-active-strip" role="status">
            <div className="exec-active-main">
              <span className={`exec-status ${running.state}`}>
                {labels[running.state] || running.state}
              </span>
              <b>
                {curStep
                  ? `${curStep.title} (${doneCount}/${running.steps.length})`
                  : bi(
                      `已完成 ${doneCount}/${running.steps.length} 步`,
                      `${doneCount}/${running.steps.length} steps done`,
                    )}
              </b>
              {curStep && (
                <button
                  type="button"
                  className="link small"
                  onClick={() => focusStep(curStep.key)}
                >
                  {bi("定位到此步骤", "Jump to step")}
                </button>
              )}
              <button
                type="button"
                className="link small"
                onClick={() =>
                  go({
                    name: "executions",
                    id: jobId,
                    run: running.id,
                    step: curStep?.id,
                  })
                }
              >
                {bi("打开实时监控台 →", "Open Live Monitor →")}
              </button>
            </div>
            {disconnected && (
              <p className="exec-warning">
                {bi(
                  "暂未收到执行节点心跳，现场状态待核实。已授权的步骤可能还在运行；平台不会自动重跑。",
                  "No heartbeat from execution node; verify on-site state before retrying.",
                )}
              </p>
            )}
            <div className="exec-actions">
              {can("delivery.execute") && (
                <>
                  {running.state === "paused" ? (
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => action(running, "resume")}
                      icon={<IconPlayArrow />}
                    >
                      {bi("继续后续步骤", "Resume")}
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      disabled={busy || running.pause || running.state === "unknown"}
                      onClick={() => action(running, "pause")}
                      icon={<IconPause />}
                    >
                      {running.pause
                        ? bi("当前步骤结束后暂停", "Pausing after current step")
                        : bi("完成当前步骤后暂停", "Pause after current step")}
                    </Button>
                  )}
                  {!running.steps.some((s) =>
                    ["leased", "running", "unknown"].includes(s.state),
                  ) && (
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => action(running, "close")}
                    >
                      {bi("结束批次，保留记录", "Close batch & keep records")}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })()}
      {batchesOpen && runs.length > 0 && (
        <div className="exec-batches-list">
          <div className="exec-batches-toolbar">
            <span className="faint small">
              {bi(
                "按时间倒序列出每次历史批次；点击任意步骤胶囊可直接查看当次尝试的原始日志。",
                "Newest batches first. Click any step pill to inspect that exact attempt's log.",
              )}
            </span>
            {failedRunsCount > 0 && (
              <span className="exec-batch-filters" role="group">
                <button
                  type="button"
                  className={batchFilter === "all" ? "on" : ""}
                  onClick={() => setBatchFilter("all")}
                >
                  {bi("全部批次", "All")} <em className="num">{runs.length}</em>
                </button>
                <button
                  type="button"
                  className={batchFilter === "failed" ? "on" : ""}
                  onClick={() => setBatchFilter("failed")}
                >
                  {bi("含失败批次", "With failures")}{" "}
                  <em className="num">{failedRunsCount}</em>
                </button>
              </span>
            )}
          </div>
          {visibleRuns.map((run) => {
            const runNum = runs.length - runs.indexOf(run);
            const n = data?.nodes.find((x) => x.id === run.node);
            const recovered = isRunRecovered(run);
            const batchTone = recovered ? "recovered" : run.state;
            const batchLabel = recovered
              ? bi("历史失败 · 后续已通过", "Failed earlier · now passed")
              : labels[run.state] || run.state;
            const phases = Array.from(
              new Set(run.steps.map((s) => phaseLabel(s.key))),
            );
            const firstStart = run.steps.find((s) => s.started)?.started || run.created;
            const lastEnd =
              [...run.steps].reverse().find((s) => s.finished)?.finished ||
              run.updated;
            const dur = fmtDur(firstStart, lastEnd);
            return (
              <div
                className={`exec-batch-card ${recovered ? "is-recovered" : ""}`}
                key={run.id}
              >
                <div className="exec-batch-head">
                  <span className="exec-batch-num num">#{runNum}</span>
                  <span className={`exec-status ${batchTone}`}>
                    {batchLabel}
                  </span>
                  <b>
                    {phases.join(" / ")} ·{" "}
                    {run.steps.length === 1
                      ? bi("1 步", "1 step")
                      : bi(`${run.steps.length} 步`, `${run.steps.length} steps`)}
                  </b>
                  {dur && <span className="faint small num">{dur}</span>}
                  <span className="faint small">
                    {run.executor_name || n?.name || bi("执行节点", "Execution node")}
                    {run.executor_ip ? ` (${run.executor_ip})` : ""} ·{" "}
                    {run.access_mode === "agent-trust"
                      ? bi("Agent 托管 SSH", "Agent-trusted SSH")
                      : bi("已有 SSH", "Existing SSH")}{" "}
                    · {fullTime(run.created)}
                  </span>
                  <button
                    type="button"
                    className="link small"
                    style={{ marginLeft: "auto" }}
                    onClick={() =>
                      go({ name: "executions", id: jobId, run: run.id })
                    }
                  >
                    {bi("在监控台查看 →", "Open in monitor →")}
                  </button>
                </div>
                <div className="exec-batch-chips">
                  {run.steps.map((s) => {
                    const stepFailedHere = [
                      "failed",
                      "interrupted",
                      "blocked",
                      "unknown",
                    ].includes(s.state);
                    const laterOk = stepFailedHere && isStepSettled(s.key);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className={`exec-step-jump ${s.state}${laterOk ? " later-ok" : ""}`}
                        title={
                          (s.message || labels[s.state] || s.state) +
                          (laterOk
                            ? bi("（已在后续批次重跑通过；点击查看当次失败日志）", " (passed in a later batch; click to view failure log)")
                            : bi("（点击查看当次尝试日志）", " (click to inspect log)"))
                        }
                        onClick={() => setInspect({ run, runNum, step: s })}
                      >
                        <i aria-hidden />
                        <span>{s.title}</span>
                        {laterOk && (
                          <em className="exec-chip-recov">
                            {bi("已恢复", "fixed")}
                          </em>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="exec-evidence">
                  {bi("发起人", "Initiated by")} {run.by} · {bi("批次", "Batch")}{" "}
                  <code>{run.id}</code> · {bi("固定快照", "Snapshot")}{" "}
                  <code title={run.snapshot}>{run.snapshot.slice(0, 12)}</code>
                  {(run.patched_files?.length || 0) > 0 && (
                    <>
                      {" · "}
                      <span className="ex-patch-inline">
                        {bi(
                          `自动下发 ${run.patched_files!.length} 个热修文件`,
                          `${run.patched_files!.length} hotfix files pushed`,
                        )}
                      </span>
                    </>
                  )}
                  {(run.sync_version || 0) > 0 && (
                    <>
                      {" · "}
                      <span className="ex-patch-inline">
                        {bi(
                          `同步版本 #${run.sync_version}`,
                          `Sync #${run.sync_version}`,
                        )}
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <AttemptLogDrawer
        jobId={jobId}
        item={inspect}
        laterPassed={inspect ? isStepSettled(inspect.step.key) : false}
        onClose={() => setInspect(null)}
        onFocusStep={focusStep}
      />
      <Modal
        className="exec-modal ex-launch-modal"
        visible={open}
        title={
          <div className="ex-launch-title">
            <span>{bi("自动执行", "Automated Execution")}</span>
            <code className="ex-launch-cluster">{cluster}</code>
            {(data?.targets?.length || 0) > 0 && (
              <Tooltip
                content={(data?.targets || [])
                  .map((h) => `${h.name} (${h.ip})`)
                  .join(" · ")}
                mini
              >
                <span className="ex-launch-hosts-pill num">
                  {bi(
                    `${data!.targets.length} 台目标机`,
                    `${data!.targets.length} hosts`,
                  )}
                </span>
              </Tooltip>
            )}
          </div>
        }
        footer={(() => {
          const needAuth = Boolean(
            selectedNode && online(selectedNode) && !selectedNode.authorized,
          );
          const needPrecheck = Boolean(
            selectedNode &&
              online(selectedNode) &&
              selectedNode.authorized &&
              selectedNode.kind &&
              !ready,
          );
          const precheckPending = preparation?.state === "pending";
          const canLaunchNow =
            !error &&
            !!selectedNode &&
            selectedNode.authorized &&
            online(selectedNode) &&
            data?.revision === review?.revision &&
            keys.length > 0 &&
            confirmValid &&
            (selectedNode.kind ? ready : prepared);
          return (
            <div className="ex-launch-footer">
              <div className="ex-launch-confirm">
                {keys.length > 0 && hasRiskyPicked ? (
                  <label className="ex-confirm-risky">
                    <IconExclamationCircleFill />
                    <span>
                      {bi("含中断/不可撤销步骤，请输入", "Disruptive step — type")}{" "}
                      <code>{cluster}</code>
                    </span>
                    <Input
                      size="small"
                      className="ex-confirm-input"
                      value={confirm}
                      onChange={setConfirm}
                      aria-label={bi("确认集群名称", "Confirm cluster name")}
                      placeholder={cluster}
                    />
                  </label>
                ) : keys.length > 0 ? (
                  <Checkbox
                    checked={safeConfirmed}
                    onChange={setSafeConfirmed}
                    className="ex-confirm-safe"
                  >
                    <span>
                      {bi("确认在集群", "Confirm run on")}{" "}
                      <code>{cluster}</code>{" "}
                      {bi("按序执行（失败即止）", "(fail-fast)")}
                    </span>
                  </Checkbox>
                ) : (
                  <span className="faint small">
                    {bi("请至少勾选 1 个步骤", "Select at least 1 step")}
                  </span>
                )}
              </div>
              <div className="ex-launch-btns">
                <Button disabled={busy} onClick={() => setOpen(false)}>
                  {bi("取消", "Cancel")}
                </Button>
                {needAuth && can("execution.manage") ? (
                  <Button
                    type="primary"
                    loading={busy}
                    onClick={authorizeNode}
                  >
                    {bi("授权此执行节点", "Authorize Runner")}
                  </Button>
                ) : needPrecheck ? (
                  <Button
                    type="primary"
                    loading={busy || precheckPending}
                    disabled={data?.revision !== review?.revision}
                    onClick={runPrecheck}
                  >
                    {precheckPending
                      ? bi("预检中…", "Checking…")
                      : bi("先执行预检", "Run Pre-flight Check")}
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    icon={<IconPlayArrow />}
                    loading={busy}
                    disabled={!canLaunchNow}
                    onClick={start}
                  >
                    {keys.length > 0
                      ? bi(`开始执行 ${keys.length} 步`, `Run ${keys.length} Steps`)
                      : bi("开始执行", "Start Execution")}
                  </Button>
                )}
              </div>
            </div>
          );
        })()}
        onCancel={() => !busy && setOpen(false)}
        style={{ width: 780, maxWidth: "95vw" }}
      >
        {(() => {
          const allReviewSteps = review?.steps || [];
          const availReviewSteps = allReviewSteps.filter((s) => s.available);
          const isDone = (st?: string) =>
            ["done", "resolved", "skipped"].includes(st || "");
          const phaseOrder = ["prepare", "deploy", "tests", "endpoint", "cleanup"];
          const groupMap = new Map<string, Choice[]>();
          for (const s of allReviewSteps) {
            const p = s.key.split("/", 1)[0];
            const arr = groupMap.get(p) || [];
            arr.push(s);
            groupMap.set(p, arr);
          }
          const orderedPhases = [
            ...phaseOrder.filter((p) => groupMap.has(p)),
            ...[...groupMap.keys()].filter((p) => !phaseOrder.includes(p)),
          ];

          // Compute quick-select presets
          const failedResumeKeys = (() => {
            const f = availReviewSteps.find((s) => s.state === "failed");
            if (!f) return [] as string[];
            const ph = f.key.split("/", 1)[0];
            const list = availReviewSteps.filter(
              (s) => s.key.split("/", 1)[0] === ph,
            );
            const idx = list.findIndex((s) => s.key === f.key);
            return list
              .slice(Math.max(0, idx))
              .filter((s) => !isDone(s.state))
              .map((s) => s.key);
          })();
          const nextTodoPhase = (() => {
            const first = availReviewSteps.find((s) => !isDone(s.state));
            if (!first) return null;
            const ph = first.key.split("/", 1)[0];
            const list = availReviewSteps
              .filter((s) => s.key.split("/", 1)[0] === ph && !isDone(s.state))
              .map((s) => s.key);
            return { phase: ph, label: phaseLabel(ph), keys: list };
          })();
          const allTodoKeys = availReviewSteps
            .filter((s) => !isDone(s.state))
            .map((s) => s.key);

          const applyPreset = (nextKeys: string[]) => {
            setKeys(nextKeys);
            const nextSet = new Set(nextKeys);
            setCollapsedPhases((prev) => {
              const copyMap = { ...prev };
              orderedPhases.forEach((p) => {
                if ((groupMap.get(p) || []).some((s) => nextSet.has(s.key))) {
                  copyMap[p] = false;
                }
              });
              return copyMap;
            });
          };

          const precheckPending = preparation?.state === "pending";
          const passedChecks = (preparation?.checks || []).filter(
            (c) => c.state === "passed",
          ).length;
          const totalChecks = preparation?.checks?.length || 0;

          return (
            <div className="ex-launch-body">
              {error && (
                <p role="alert" className="en-error">
                  {error}
                </p>
              )}
              {data?.revision !== review?.revision && (
                <p role="alert" className="en-error">
                  {bi(
                    "交付配置已更新，请关闭窗口重新打开。",
                    "Delivery changed; close and reopen to refresh steps.",
                  )}
                </p>
              )}
              {setupError && (
                <div className="en-error" role="alert">
                  {setupError}
                </div>
              )}

              {/* Zone 1: Compact Unified Readiness Strip */}
              <section className="ex-ready-card">
                <div className="ex-ready-row">
                  <div className="ex-ready-node">
                    <span className="ex-ready-k">{bi("执行节点", "Runner")}</span>
                    <Select
                      size="small"
                      className="ex-ready-select"
                      aria-label={bi("执行节点", "Execution node")}
                      value={node || undefined}
                      onChange={(v) => {
                        setNode(v);
                        setSetupError("");
                      }}
                      placeholder={bi("选择执行节点", "Select runner")}
                      options={nodeOptions}
                    />
                    {can("execution.manage") && (
                      <a
                        className="ex-ready-link"
                        href="#/executions/nodes"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {bi("节点管理 ↗", "Nodes ↗")}
                      </a>
                    )}
                  </div>

                  <div className="ex-ready-state">
                    {!selectedNode ? (
                      <span className="ex-pill warn">
                        {bi("未选执行节点", "No runner")}
                      </span>
                    ) : !online(selectedNode) ? (
                      <span className="ex-pill bad">
                        {bi("节点离线，请先启动服务", "Runner offline")}
                      </span>
                    ) : !selectedNode.authorized ? (
                      <>
                        <span className="ex-pill warn">
                          {bi("未授权目标机", "Not authorized")}
                        </span>
                        {can("execution.manage") && (
                          <Button
                            size="mini"
                            type="outline"
                            loading={busy}
                            onClick={authorizeNode}
                          >
                            {bi("一键授权", "Authorize")}
                          </Button>
                        )}
                      </>
                    ) : !selectedNode.kind ? (
                      <Checkbox
                        checked={prepared}
                        onChange={setPrepared}
                        className="ex-legacy-check"
                      >
                        {bi("环境与 SSH 已就绪", "Prep & SSH ready")}
                      </Checkbox>
                    ) : precheckPending ? (
                      <span className="ex-pill run">
                        <IconLoading spin />
                        {bi("预检进行中…", "Checking…")}
                      </span>
                    ) : ready ? (
                      <>
                        <span className="ex-pill ok">
                          <IconCheckCircleFill />
                          {prepReused
                            ? bi(
                                `预检已复用（热修/同步免复检）· 剩 ${prepExpiresInMin}m`,
                                `Prep reused · ${prepExpiresInMin}m`,
                              )
                            : bi(
                                `预检通过 · 剩 ${prepExpiresInMin}m`,
                                `Ready · ${prepExpiresInMin}m`,
                              )}
                        </span>
                        <Button
                          size="mini"
                          type="text"
                          loading={busy}
                          onClick={runPrecheck}
                        >
                          {bi("复检", "Re-check")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className={`ex-pill ${prepFailed ? "bad" : "warn"}`}>
                          <IconExclamationCircleFill />
                          {prepFailed
                            ? bi(
                                `预检未通过 (${passedChecks}/${totalChecks})`,
                                `Check failed (${passedChecks}/${totalChecks})`,
                              )
                            : preparation?.state === "expired"
                              ? bi("预检已过期", "Check expired")
                              : bi("待预检连通性与材料", "Pre-check needed")}
                        </span>
                        <Button
                          size="mini"
                          type="outline"
                          loading={busy}
                          onClick={runPrecheck}
                        >
                          {bi("立即预检", "Pre-check")}
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {/* Secondary strip: target chips + compact expandable drawers for Check Details & SSH/Agent */}
                <div className="ex-ready-sub">
                  <div className="ex-target-chips">
                    <span className="ex-target-lead">
                      <span className="ex-target-cap">
                        {data?.executor?.kind === "independent"
                          ? bi("独立管理机", "Standalone")
                          : bi("集群内执行机", "In-cluster")}{" "}
                        <code>{data?.executor?.ip}</code>
                      </span>
                      <span className="ex-target-sep" aria-hidden>→</span>
                    </span>
                    <div className="ex-host-chip-list">
                      {(data?.targets || []).map((h) => (
                        <span key={h.name} className="ex-host-chip">
                          <b>{h.name}</b>
                          <code>{h.ip}</code>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="ex-ready-toggles">
                    {totalChecks > 0 && (
                      <button
                        type="button"
                        className={`ex-mini-toggle ${checksOpen ? "on" : ""} ${prepFailed ? "bad" : ""}`}
                        onClick={() => setChecksOpen((v) => !v)}
                      >
                        <span>
                          {bi(
                            `预检明细 ${passedChecks}/${totalChecks}`,
                            `Checks ${passedChecks}/${totalChecks}`,
                          )}
                        </span>
                        <IconDown />
                      </button>
                    )}
                    {selectedNode && (
                      <button
                        type="button"
                        className={`ex-mini-toggle ${accessOpen ? "on" : ""}`}
                        onClick={() => setAccessOpen((v) => !v)}
                      >
                        <IconSettings />
                        <span>{bi("目标接入 (SSH / Agent)", "Access (SSH / Agent)")}</span>
                        <IconDown />
                      </button>
                    )}
                    <AIHelpButton
                      topic="target-access-modes"
                      title={bi("目标接入方式（已有 SSH vs 目标 Agent）", "Target Access: Existing SSH vs Target Agent")}
                      page={bi("现场执行 · 准备与接入", "On-site Execution · Access")}
                      summary={bi(
                        `执行机 ${data?.executor?.ip || ""} 连接目标机 ${(data?.targets || []).map((t) => `${t.name}(${t.ip})`).join(", ")}`,
                        `Executor ${data?.executor?.ip || ""} to targets ${(data?.targets || []).map((t) => `${t.name}(${t.ip})`).join(", ")}`,
                      )}
                      prompt={bi(
                        "请简明说明「已有 SSH」和「目标 Agent」两种接入方式怎么选：我有密码和没密码（堡垒机）时分别该怎么做？",
                        "Explain when to choose Existing SSH vs Target Agent, both when I have root passwords and when I only have bastion access.",
                      )}
                      tooltip={bi("问 AI：已有 SSH 和目标 Agent 怎么选？", "Ask AI: Existing SSH vs Target Agent")}
                    />
                  </div>
                </div>

                {/* Collapsible Pre-flight Check Details */}
                {checksOpen && totalChecks > 0 && (
                  <div className="ex-tray">
                    <div className="ex-check-compact">
                      {preparation!.checks.map((c) => (
                        <div key={c.id} className={`ex-ck-item ${c.state}`}>
                          <span className="ex-ck-ic">
                            {c.state === "passed" ? (
                              <IconCheckCircleFill />
                            ) : (
                              <IconCloseCircleFill />
                            )}
                          </span>
                          <div className="ex-ck-main">
                            <div className="ex-ck-head">
                              <b>
                                {c.host ? `${c.host} · ` : ""}
                                {c.title}
                              </b>
                              {c.state !== "passed" && (
                                <AIHelpButton
                                  variant="pill"
                                  topic={`precheck-${c.id}`}
                                  title={bi(
                                    `预检失败：${c.host ? `${c.host} · ` : ""}${c.title}`,
                                    `Pre-check failed: ${c.host ? `${c.host} · ` : ""}${c.title}`,
                                  )}
                                  page={bi("现场执行 · 预检明细", "On-site Execution · Pre-checks")}
                                  error={c.message}
                                  summary={bi(
                                    `检查项 ${c.id}，执行机 ${data?.executor?.ip || ""}，运行目录 ${data?.executor?.runtime_root || ""}`,
                                    `Check ${c.id}, executor ${data?.executor?.ip || ""}, root ${data?.executor?.runtime_root || ""}`,
                                  )}
                                  prompt={bi(
                                    `现场执行预检「${c.host ? `${c.host} · ` : ""}${c.title}」未通过，报错信息如下：\n${c.message || "未通过"}\n请直接告诉我根因和在执行机或目标机上要执行的修复命令。`,
                                    `Pre-check "${c.host ? `${c.host} · ` : ""}${c.title}" failed with:\n${c.message || "failed"}\nPlease explain the root cause and give the exact fix commands.`,
                                  )}
                                  label={bi("问 AI 修复", "Fix with AI")}
                                />
                              )}
                            </div>
                            {c.message && <span>{c.message}</span>}
                            {c.warnings && c.warnings.length > 0 && (
                              <div className="ex-ck-warns">
                                {c.warnings.map((w, wi) => (
                                  <span key={wi} className="ex-ck-warn-line">
                                    ⚠ {w}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Collapsible Target Access (SSH / Bastion Agent + Runtime Root) */}
                {accessOpen && selectedNode && (
                  <div className="ex-tray">
                    <TargetAgents
                      job={jobId}
                      node={node}
                      targets={data?.targets || []}
                      executorIP={data?.executor.ip || ""}
                      onChanged={load}
                    />
                    {data?.executor.runtime_root && (
                      <p className="ex-runtime-note">
                        {bi("离线运行目录：", "Runtime root: ")}
                        <code>{data.executor.runtime_root}</code>
                      </p>
                    )}
                  </div>
                )}
              </section>

              {/* Auto-Push Patch / Component Sync Strip */}
              {((data?.patches?.length || 0) > 0 || (data?.sync_count || 0) > 0) && (
                <div className="ex-autopush-strip">
                  <IconCheckCircleFill />
                  <span>
                    {bi(
                      `本次启动将自动向执行节点推送最新脚本快照${
                        (data?.patches?.length || 0) > 0
                          ? `（含 ${new Set(data!.patches!.map((p) => p.path)).size} 个本交付热修文件`
                          : "（"
                      }${
                        (data?.sync_count || 0) > 0
                          ? `${(data?.patches?.length || 0) > 0 ? "、" : ""}第 ${data!.sync_count} 次更新`
                          : ""
                      }），无需手工拷贝。`,
                      `Latest patched/synced scripts will auto-push to the execution node on launch.`,
                    )}
                  </span>
                </div>
              )}

              {/* Zone 2: Smart Phase-Grouped Step Selector */}
              <section className="ex-scope-card">
                <div className="ex-scope-bar">
                  <div className="ex-scope-presets">
                    <span className="ex-scope-k">{bi("快捷勾选", "Quick select")}</span>
                    <div className="ex-scope-preset-list">
                      {failedResumeKeys.length > 0 && (
                        <button
                          type="button"
                          className={`ex-preset-pill bad ${
                            keys.length === failedResumeKeys.length &&
                            failedResumeKeys.every((k) => keys.includes(k))
                              ? "on"
                              : ""
                          }`}
                          onClick={() => applyPreset(failedResumeKeys)}
                        >
                          {bi(
                            `从失败处续跑 (${failedResumeKeys.length})`,
                            `Resume failed (${failedResumeKeys.length})`,
                          )}
                        </button>
                      )}
                      {nextTodoPhase &&
                        (failedResumeKeys.length === 0 ||
                          nextTodoPhase.keys.join(",") !==
                            failedResumeKeys.join(",")) && (
                          <button
                            type="button"
                            className={`ex-preset-pill ${
                              keys.length === nextTodoPhase.keys.length &&
                              nextTodoPhase.keys.every((k) => keys.includes(k))
                                ? "on"
                                : ""
                            }`}
                            onClick={() => applyPreset(nextTodoPhase.keys)}
                          >
                            {bi(
                              `${nextTodoPhase.label}未完成 (${nextTodoPhase.keys.length})`,
                              `${nextTodoPhase.label} remaining (${nextTodoPhase.keys.length})`,
                            )}
                          </button>
                        )}
                      {allTodoKeys.length > 0 && (
                        <button
                          type="button"
                          className={`ex-preset-pill ${
                            keys.length === allTodoKeys.length &&
                            allTodoKeys.every((k) => keys.includes(k))
                              ? "on"
                              : ""
                          }`}
                          onClick={() => applyPreset(allTodoKeys)}
                        >
                          {bi(
                            `全部未完成 (${allTodoKeys.length})`,
                            `All remaining (${allTodoKeys.length})`,
                          )}
                        </button>
                      )}
                      {keys.length > 0 && (
                        <button
                          type="button"
                          className="ex-preset-pill ghost"
                          onClick={() => setKeys([])}
                        >
                          {bi("清空", "Clear")}
                        </button>
                      )}
                    </div>
                  </div>
                  <span className="ex-scope-count num">
                    {bi(
                      `已选 ${keys.length} / ${availReviewSteps.length} 步`,
                      `${keys.length} / ${availReviewSteps.length} selected`,
                    )}
                  </span>
                </div>

                <div className="ex-phase-list">
                  {orderedPhases.map((phase) => {
                    const list = groupMap.get(phase) || [];
                    const availInPhase = list.filter((s) => s.available);
                    const pickedCount = availInPhase.filter((s) =>
                      keys.includes(s.key),
                    ).length;
                    const doneCount = list.filter((s) => isDone(s.state)).length;
                    const failCount = list.filter(
                      (s) => s.state === "failed",
                    ).length;
                    const allChecked =
                      availInPhase.length > 0 &&
                      pickedCount === availInPhase.length;
                    const someChecked = pickedCount > 0 && !allChecked;
                    const collapsed = !!collapsedPhases[phase];

                    return (
                      <div key={phase} className="ex-phase-group">
                        <div
                          className="ex-phase-head"
                          onClick={() =>
                            setCollapsedPhases((m) => ({
                              ...m,
                              [phase]: !m[phase],
                            }))
                          }
                        >
                          <span
                            className="ex-phase-check"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Checkbox
                              checked={allChecked}
                              indeterminate={someChecked}
                              disabled={!availInPhase.length}
                              onChange={(checked) => {
                                const phaseKeys = availInPhase.map(
                                  (s) => s.key,
                                );
                                const phaseSet = new Set(phaseKeys);
                                setKeys((prev) =>
                                  checked
                                    ? [
                                        ...prev.filter((k) => !phaseSet.has(k)),
                                        ...phaseKeys,
                                      ]
                                    : prev.filter((k) => !phaseSet.has(k)),
                                );
                              }}
                            />
                          </span>
                          <IconRight
                            className={`ex-phase-chev ${collapsed ? "" : "open"}`}
                          />
                          <b className="ex-phase-name">{phaseLabel(phase)}</b>
                          <div className="ex-phase-tags">
                            {pickedCount > 0 && (
                              <span className="ex-ptag brand num">
                                {bi(`已选 ${pickedCount}`, `${pickedCount} picked`)}
                              </span>
                            )}
                            {failCount > 0 ? (
                              <span className="ex-ptag bad num">
                                {bi(`${failCount} 步失败`, `${failCount} failed`)}
                              </span>
                            ) : doneCount === list.length ? (
                              <span className="ex-ptag ok num">
                                {bi(`全部通过 ${doneCount}/${list.length}`, `All done ${doneCount}/${list.length}`)}
                              </span>
                            ) : (
                              <span className="ex-ptag num">
                                {doneCount}/{list.length}
                              </span>
                            )}
                          </div>
                        </div>

                        {!collapsed && (
                          <div className="ex-phase-rows">
                            {list.map((s) => {
                              const checked = keys.includes(s.key);
                              const stepDone = isDone(s.state);
                              const stepFail = s.state === "failed";
                              const risky =
                                s.effect === "disruptive" ||
                                s.effect === "destructive";
                              return (
                                <label
                                  key={s.key}
                                  className={`ex-step-row ${checked ? "on" : ""} ${!s.available ? "disabled" : ""}`}
                                >
                                  <Checkbox
                                    checked={checked}
                                    disabled={!s.available}
                                    onChange={(v) =>
                                      setKeys((prev) =>
                                        v
                                          ? prev.includes(s.key)
                                            ? prev
                                            : [...prev, s.key]
                                          : prev.filter((x) => x !== s.key),
                                      )
                                    }
                                  />
                                  <span
                                    className={`ex-step-st ${stepFail ? "bad" : stepDone ? "ok" : "todo"}`}
                                    aria-hidden
                                  >
                                    {stepFail ? (
                                      <IconCloseCircleFill />
                                    ) : stepDone ? (
                                      <IconCheckCircleFill />
                                    ) : (
                                      <i />
                                    )}
                                  </span>
                                  <span className="ex-step-main">
                                    <span className="ex-step-title">
                                      {s.title}
                                    </span>
                                    {s.reason && (
                                      <small className="ex-step-reason">
                                        {s.reason}
                                      </small>
                                    )}
                                  </span>
                                  <span className="ex-step-right">
                                    {s.available && (
                                      <span
                                        className="ex-step-quick"
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                        }}
                                      >
                                        <button
                                          type="button"
                                          className="ex-step-qbtn"
                                          title={bi(
                                            "仅勾选并执行这一步",
                                            "Select only this step",
                                          )}
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            applyPreset([s.key]);
                                          }}
                                        >
                                          {bi("仅此步", "Only")}
                                        </button>
                                        <button
                                          type="button"
                                          className="ex-step-qbtn"
                                          title={bi(
                                            "从此步起按序勾选本阶段后续未完成步骤",
                                            "Select from this step onward in phase",
                                          )}
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            const idx = availInPhase.findIndex(
                                              (x) => x.key === s.key,
                                            );
                                            const tail = availInPhase.slice(
                                              Math.max(0, idx),
                                            );
                                            const todoTail = tail.filter(
                                              (x) =>
                                                x.key === s.key ||
                                                !isDone(x.state),
                                            );
                                            applyPreset(
                                              (todoTail.length > 0
                                                ? todoTail
                                                : tail
                                              ).map((x) => x.key),
                                            );
                                          }}
                                        >
                                          {bi("从此步起", "From here")}
                                        </button>
                                      </span>
                                    )}
                                    {stepFail && (
                                      <span className="ex-stag bad">
                                        {bi("上次失败", "Failed")}
                                      </span>
                                    )}
                                    {risky && (
                                      <span
                                        className={`ex-stag ${s.effect === "destructive" ? "bad" : "warn"}`}
                                      >
                                        {effects[s.effect]}
                                      </span>
                                    )}
                                    {s.hosts.length > 0 && (
                                      <Tooltip
                                        content={s.hosts.join(bi("、", ", "))}
                                        mini
                                      >
                                        <span className="ex-stag mute num">
                                          {bi(
                                            `${s.hosts.length} 节点`,
                                            `${s.hosts.length}h`,
                                          )}
                                        </span>
                                      </Tooltip>
                                    )}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Secondary Safety Confirmation Gate (re-running completed risky steps OR live target data/services detected) */}
              {safetyWarnings.length > 0 && keys.length > 0 && (
                <section className="ex-safety-box" role="alert">
                  <div className="ex-safety-head">
                    <IconExclamationCircleFill />
                    <b>
                      {bi(
                        "二次安全确认：检测到已有数据/运行服务或重跑已完成高风险步骤",
                        "Secondary Safety Confirmation Required",
                      )}
                    </b>
                  </div>
                  <ul className="ex-safety-list">
                    {safetyWarnings.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                  <Checkbox
                    checked={safetyConfirmed}
                    onChange={setSafetyConfirmed}
                    className="ex-safety-check"
                  >
                    <span>
                      {bi(
                        "我已核实目标机器数据、服务状态与所选步骤影响范围，确认放行本次执行",
                        "I have verified target host data/service state and confirm running these steps",
                      )}
                    </span>
                  </Checkbox>
                </section>
              )}
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}

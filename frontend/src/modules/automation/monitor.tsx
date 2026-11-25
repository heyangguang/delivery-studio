import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Input, Message, Modal, Popover, Tooltip } from "@arco-design/web-react";
import {
  IconAlignLeft,
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconCheckCircleFill,
  IconClose,
  IconCloseCircleFill,
  IconCode,
  IconCopy,
  IconDown,
  IconDownload,
  IconEdit,
  IconExclamationCircleFill,
  IconInfoCircle,
  IconLaunch,
  IconList,
  IconLoading,
  IconMenuFold,
  IconMinusCircle,
  IconPause,
  IconPlayArrow,
  IconRecordStop,
  IconRefresh,
  IconRight,
  IconSearch,
  IconSync,
  IconThunderbolt,
  IconToBottom,
} from "@arco-design/web-react/icon";
import { AIDock, Spark, useAIDock } from "../ai/aichat";
import {
  ExecutionNode,
  isExecutionNodeOnline,
} from "./execution-types";
import { bi, getLang, useLang, withLang } from "../../app/i18n";
import { go } from "../../app/router";
import {
  ago,
  api,
  cached,
  can,
  clock,
  copy,
  dayLabel,
  err,
  fullTime,
  putCached,
  useAIStatus,
  useMedia,
} from "../../shared/shared";
import { AppGlyph, Segmented, StatusBadge, StatusDot } from "../../design/ui";
import { dispatchExecLaunchIntent, StepHotfixDrawer } from "../projects/stephotfix";
import "./monitor.css";

/* ---------- Types ---------- */

export type MonitorListItem = {
  job_id: string;
  cluster: string;
  app_id: string;
  app_name: string;
  version: string;
  delivery_mode: string;
  state: string;
  active: boolean;
  active_run_id?: string;
  latest_run_id: string;
  running_step_key?: string;
  running_step_title?: string;
  running_step_state?: string;
  done_steps: number;
  failed_steps: number;
  total_steps: number;
  batch_count: number;
  failed_batches: number;
  recovered_batches: number;
  executor_name?: string;
  executor_ip?: string;
  runner_online: boolean;
  by: string;
  created: string;
  updated: string;
};

export type MonitorListPayload = {
  items: MonitorListItem[];
  active_count: number;
  online_runners: number;
  total_runners: number;
};

type StepRecapRaw = {
  host?: string;
  ok?: number;
  changed?: number;
  skipped?: number;
  failed?: number;
  unreachable?: number;
  Host?: string;
  OK?: number;
  Changed?: number;
  Skipped?: number;
  Failed?: number;
  Unreachable?: number;
};

type StepRecap = {
  host: string;
  ok: number;
  changed: number;
  skipped: number;
  failed: number;
  unreachable: number;
};

type ExecStep = {
  id: string;
  key: string;
  title: string;
  effect?: string;
  hosts: string[];
  playbook?: string;
  timeout?: number;
  state: string;
  seq: number;
  started?: string;
  finished?: string;
  message?: string;
  exit_code?: number;
  recap?: StepRecapRaw[];
  runtime?: string;
  returned?: string;
};

type ExecRun = {
  id: string;
  job: string;
  cluster: string;
  node: string;
  executor_name?: string;
  executor_ip?: string;
  executor_kind?: string;
  access_mode?: string;
  by: string;
  created: string;
  updated: string;
  state: string;
  pause: boolean;
  snapshot: string;
  revision: string;
  patched_files?: string[];
  sync_version?: number;
  steps: ExecStep[];
  note?: string;
};

type ExecChoice = {
  key: string;
  title: string;
  phase: string;
  hosts: string[];
  effect: string;
  state?: string;
  available: boolean;
};

type ExecDetailData = {
  runs: ExecRun[];
  nodes: ExecutionNode[];
  steps: ExecChoice[];
  revision: string;
  patches?: { id: string; path: string; reason?: string; by: string; at: string }[];
  sync_count?: number;
  targets: { name: string; ip: string }[];
  executor: { ip: string; kind: string; runtime_root?: string };
};

type AttemptRef = {
  run: ExecRun;
  runNum: number;
  step: ExecStep;
};

type PipelineRow = {
  key: string;
  phase: string;
  title: string;
  hosts: string[];
  state: string;
  run: ExecRun;
  runNum: number;
  step: ExecStep;
  attempts: AttemptRef[];
  priorFailCount: number;
  haltedAfterFailure: boolean;
};

type StreamEvent =
  | { id: string; kind: "batch"; run: ExecRun; runNum: number }
  | { id: string; kind: "phase-start"; phase: string; stepCount: number; runNum: number }
  | {
      id: string;
      kind: "phase-end";
      phase: string;
      passed: number;
      total: number;
      failed: boolean;
      durText: string;
      runNum: number;
    }
  | {
      id: string;
      kind: "step";
      evType: "started" | "finished";
      run: ExecRun;
      runNum: number;
      step: ExecStep;
      ts: string;
      tag: string;
      tagClass: string;
      detail: string;
      durText: string;
      failed: boolean;
    };

type FailureDiag = {
  componentId: string;
  componentLabel: string;
  failedTask: string;
  failedHosts: string[];
  errorDetail: string;
  category: "env" | "component";
  firstErrorLine: number | null;
};

/* ---------- Formatting & Classification Helpers ---------- */

const isActiveRun = (r: ExecRun) =>
  !["completed", "failed", "closed"].includes(r.state);

const isStepFail = (st: string) =>
  ["failed", "interrupted", "blocked", "unknown"].includes(st);

const isStepSettled = (st: string) => st === "succeeded" || st === "skipped";

const isStepLive = (st: string) =>
  st === "running" || st === "leased" || st === "unknown";

const isStepExecuted = (st: ExecStep) =>
  st.state !== "pending" || st.seq > 0 || Boolean(st.started);

function pickDefaultStepForRun(run: ExecRun): ExecStep | null {
  return (
    run.steps.find((s) => isStepLive(s.state)) ||
    run.steps.find((s) => isStepFail(s.state)) ||
    [...run.steps].reverse().find(isStepExecuted) ||
    run.steps[0] ||
    null
  );
}

const PHASE_ORDER = ["prepare", "deploy", "tests", "endpoint", "cleanup"];

function phaseOfKey(key: string): string {
  const idx = key.indexOf("/");
  return idx > 0 ? key.slice(0, idx) : "deploy";
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "prepare":
      return bi("环境准备", "Prepare");
    case "deploy":
      return bi("部署", "Deploy");
    case "tests":
      return bi("功能测试", "Tests");
    case "endpoint":
      return bi("入口测试", "Endpoint");
    case "cleanup":
      return bi("清理", "Cleanup");
    default:
      return phase;
  }
}

function stepStateLabel(st: string): string {
  switch (st) {
    case "queued":
      return bi("排队等待执行节点", "Queued");
    case "pending":
      return bi("未执行", "Pending");
    case "leased":
      return bi("已授权，启动中", "Starting");
    case "running":
      return bi("正在执行", "Running");
    case "paused":
      return bi("已暂停", "Paused");
    case "unknown":
      return bi("状态待核实", "State unknown");
    case "succeeded":
      return bi("通过", "Passed");
    case "completed":
      return bi("全部通过", "Completed");
    case "failed":
      return bi("执行失败", "Failed");
    case "skipped":
      return bi("已跳过", "Skipped");
    case "closed":
      return bi("已结束", "Closed");
    case "interrupted":
      return bi("已中断", "Interrupted");
    case "blocked":
      return bi("前置受阻", "Blocked");
    default:
      return st;
  }
}

function shortStateTag(st: string): string {
  switch (st) {
    case "running":
      return bi("[运行中 ]", "[running  ]");
    case "leased":
      return bi("[启动中 ]", "[leased   ]");
    case "succeeded":
      return bi("[通过   ]", "[succeeded]");
    case "failed":
      return bi("[失败   ]", "[failed   ]");
    case "skipped":
      return bi("[跳过   ]", "[skipped  ]");
    case "blocked":
      return bi("[受阻   ]", "[blocked  ]");
    case "interrupted":
      return bi("[已中断 ]", "[stopped  ]");
    case "unknown":
      return bi("[待核实 ]", "[unknown  ]");
    default:
      return `[${st}]`;
  }
}

function normRecap(raw?: StepRecapRaw[]): StepRecap[] {
  if (!raw || !raw.length) return [];
  return raw.map((h) => ({
    host: h.host ?? h.Host ?? "",
    ok: h.ok ?? h.OK ?? 0,
    changed: h.changed ?? h.Changed ?? 0,
    skipped: h.skipped ?? h.Skipped ?? 0,
    failed: h.failed ?? h.Failed ?? 0,
    unreachable: h.unreachable ?? h.Unreachable ?? 0,
  }));
}

function fmtDurMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const mRem = min % 60;
  return `${hr}h ${mRem}m`;
}

function fmtStepDur(step: ExecStep, nowMs: number): string {
  if (!step.started) return "";
  const a = Date.parse(step.started);
  if (!Number.isFinite(a)) return "";
  if (step.finished) {
    const b = Date.parse(step.finished);
    return Number.isFinite(b) ? fmtDurMs(b - a) : "";
  }
  if (isStepLive(step.state)) {
    return fmtDurMs(Math.max(0, nowMs - a));
  }
  return "";
}

function fmtClock(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

type LineKind =
  | "play"
  | "task"
  | "ok"
  | "changed"
  | "skip"
  | "err"
  | "result-ok"
  | "result-bad"
  | "plain";

type ParsedLine = {
  num: number;
  text: string;
  stripped: string;
  kind: LineKind;
  isErr: boolean;
};

function stripTimestamp(line: string): string {
  return line.trimStart().replace(/^\d{2}:\d{2}:\d{2}\s+/, "");
}

function classifyLogLine(line: string): LineKind {
  const s = stripTimestamp(line);
  if (!s) return "plain";
  if (s.startsWith("STEP_RESULT ")) {
    if (/\bPASSED\b|"status"\s*:\s*"(passed|succeeded|ok)"/i.test(s))
      return "result-ok";
    if (/\bFAILED\b|"status"\s*:\s*"(failed|error|interrupted|blocked)"/i.test(s))
      return "result-bad";
    return "play";
  }
  if (/^RESULT\s+PASSED\b/.test(s)) return "result-ok";
  if (/^RESULT\s+(FAILED|ERROR)\b/.test(s)) return "result-bad";
  if (
    s.startsWith("PLAY [") ||
    s.startsWith("PLAY RECAP") ||
    s === "RECAP" ||
    /^RECAP\b/.test(s)
  ) {
    return "play";
  }
  if (
    s.startsWith("TASK [") ||
    s.startsWith("RUNNING HANDLER [") ||
    /^TASK\s+/.test(s)
  ) {
    return "task";
  }
  if (
    s.startsWith("fatal:") ||
    s.startsWith("failed:") ||
    /^FAILED\b/.test(s) ||
    /^UNREACHABLE\b/.test(s) ||
    s.startsWith("ERROR!") ||
    s.startsWith("[ERROR]") ||
    s.includes("FAILED! =>") ||
    s.includes("UNREACHABLE! =>") ||
    /failed=[1-9]/.test(s) ||
    /unreachable=[1-9]/.test(s)
  ) {
    return "err";
  }
  if (s.startsWith("changed:") || /^changed\s+/.test(s)) return "changed";
  if (s.startsWith("ok:") || /^ok\s+/.test(s)) return "ok";
  if (
    s.startsWith("skipping:") ||
    s.startsWith("included:") ||
    /^(skipped|retrying)\s+/.test(s)
  ) {
    return "skip";
  }
  return "plain";
}

function isGenuineErrorLine(kind: LineKind, stripped: string): boolean {
  if (kind === "err" || kind === "result-bad") return true;
  // Never match blank "stderr:" lines emitted by Ansible on clean commands!
  if (/^stderr:\s*$/i.test(stripped)) return false;
  if (/^stderr:\s+\S/i.test(stripped)) return true;
  if (/\b(traceback|exception:)\b/i.test(stripped)) return true;
  return false;
}

/** Infer which catalog component owns a step so operators can open Component Workbench directly. */
function inferComponentId(
  step: ExecStep,
  failedTask: string,
  appId?: string,
): { id: string; label: string } {
  const key = step.key || "";
  const pb = step.playbook || "";
  const taskLow = failedTask.toLowerCase();
  const titleLow = (step.title || "").toLowerCase();

  if (key.includes("/platform/") || pb.includes("/platform/") || /^task\s+mw_/.test(taskLow)) {
    return { id: "platform-shared", label: bi("平台公共流程 (platform-shared)", "Platform Shared (platform-shared)") };
  }
  if (/patroni\s*[:\[]/.test(taskLow) || titleLow.includes("patroni") || titleLow.includes("tde")) {
    return { id: "patroni", label: "Patroni (patroni)" };
  }
  if (/etcd\s*[:\[]/.test(taskLow) || key.includes("-dcs/") || key.includes("/etcd/")) {
    return { id: "etcd", label: "etcd (etcd)" };
  }
  if (/haproxy\s*[:\[]/.test(taskLow) || titleLow.includes("haproxy")) {
    return { id: "haproxy", label: "HAProxy (haproxy)" };
  }
  if (/nginx\s*[:\[]/.test(taskLow) || titleLow.includes("nginx")) {
    return { id: "nginx", label: "Nginx (nginx)" };
  }
  if (/keepalived\s*[:\[]/.test(taskLow) || titleLow.includes("keepalived") || key.includes("-vip/")) {
    return { id: "keepalived", label: "Keepalived (keepalived)" };
  }
  if (/redis\s*[:\[]/.test(taskLow) || key.includes("redis")) {
    return { id: "redis", label: "Redis (redis)" };
  }
  if (/postgres|pgbackrest/.test(taskLow) || key.includes("instance-pg") || key.includes("/pg/")) {
    return { id: "postgresql", label: "PostgreSQL (postgresql)" };
  }
  const fallback = appId || "platform-shared";
  return { id: fallback, label: fallback };
}

/** Parse structured root-cause details from a failed step's log lines. */
function extractFailureDiag(
  lines: ParsedLine[],
  step: ExecStep,
  appId?: string,
): FailureDiag {
  let failedTask = "";
  let currentTask = "";
  let firstErrorLine: number | null = null;
  const detailLines: string[] = [];
  const hostSet = new Set<string>();

  for (const h of normRecap(step.recap)) {
    if (h.failed > 0 || h.unreachable > 0) hostSet.add(h.host);
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind === "task") {
      currentTask = l.stripped.replace(/^TASK\s+/i, "").replace(/^\[\s*|\s*\]\s*\*+$/g, "").trim();
      continue;
    }
    if (
      firstErrorLine === null &&
      (l.kind === "err" ||
        l.stripped.startsWith("FAILED ") ||
        l.stripped.startsWith("fatal:") ||
        l.stripped.startsWith("UNREACHABLE"))
    ) {
      // Prefer an actual task FAILED/fatal/UNREACHABLE over a summary RECAP line if possible
      if (!/failed=[1-9]/.test(l.stripped) || detailLines.length === 0) {
        firstErrorLine = l.num;
        failedTask = currentTask;
        const mHost = /^(?:FAILED|UNREACHABLE)\s+(\S+)/.exec(l.stripped);
        if (mHost) hostSet.add(mHost[1]);
        const mFatal = /^fatal:\s*\[([^\]]+)\]/.exec(l.stripped);
        if (mFatal) hostSet.add(mFatal[1]);

        // Collect immediate indented msg:/stderr:/stdout: explanation lines right below FAILED
        for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
          const next = lines[j];
          if (
            next.kind === "task" ||
            next.kind === "play" ||
            next.kind === "ok" ||
            next.kind === "changed" ||
            next.stripped === ""
          ) {
            break;
          }
          if (/^stderr:\s*$/i.test(next.stripped)) continue;
          if (/^(msg|stderr|stdout|cmd|rc):/i.test(next.stripped) || detailLines.length < 3) {
            detailLines.push(next.stripped);
          }
        }
        if (!/failed=[1-9]/.test(l.stripped)) break;
      }
    }
  }

  const errorDetail =
    detailLines.join("\n").trim() ||
    step.message ||
    bi("执行进程返回失败，请展开下方完整日志查看上下文。", "Process exited with failure; inspect full log below.");

  const joined = `${failedTask} ${errorDetail}`.toLowerCase();
  const isEnv =
    /(unreachable|connection refused|timed out|no space left|permission denied|address already in use|could not resolve|ssh|authentication failed|disk full)/.test(
      joined,
    );

  const comp = inferComponentId(step, failedTask, appId);
  return {
    componentId: comp.id,
    componentLabel: comp.label,
    failedTask,
    failedHosts: [...hostSet],
    errorDetail,
    category: isEnv ? "env" : "component",
    firstErrorLine,
  };
}

/** Build a clean "Errors Only" slice: only real failure blocks + their single preceding TASK header + failed RECAP lines. */
function filterErrorLines(lines: ParsedLine[]): ParsedLine[] {
  const keep = new Set<number>();
  let lastTaskIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind === "task") {
      lastTaskIdx = i;
      continue;
    }
    if (l.isErr) {
      if (lastTaskIdx >= 0) keep.add(lastTaskIdx);
      keep.add(i);
      // Include up to 5 non-empty explanation lines right below a FAILED/fatal line
      if (/^(FAILED|UNREACHABLE|fatal:|ERROR!)/i.test(l.stripped)) {
        for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
          const n = lines[j];
          if (n.stripped === "" || n.kind === "task" || n.kind === "play" || n.kind === "ok") break;
          if (/^stderr:\s*$/i.test(n.stripped)) continue;
          keep.add(j);
        }
      }
    }
  }
  return lines.filter((_, idx) => keep.has(idx));
}

function renderHighlightedText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let pos = 0;
  let idx = lower.indexOf(qLower, pos);
  let k = 0;
  while (idx !== -1) {
    if (idx > pos) parts.push(text.slice(pos, idx));
    parts.push(
      <mark key={k++} className="mon-hl">
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    pos = idx + query.length;
    idx = lower.indexOf(qLower, pos);
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return parts.length ? parts : text;
}

/** Launch Component Workbench in a new tab with AI prefill context (identical to aichat.tsx handoff). */
function openComponentWorkbenchWithAI(
  componentId: string,
  clusterName: string,
  step: ExecStep,
  diag: FailureDiag,
) {
  const child = window.open("about:blank", "_blank");
  if (!child) {
    Message.warning(
      bi(
        "浏览器拦截了新标签页，请允许弹出窗口后重试。",
        "Pop-up blocked by browser; please allow pop-ups and retry.",
      ),
    );
    return;
  }
  const text = bi(
    [
      `集群 ${clusterName} 自动执行步骤「${step.title}」(${step.key}) 失败，请协助排查并修复组件。`,
      step.playbook ? `剧本：${step.playbook}` : "",
      diag.failedTask ? `失败任务：${diag.failedTask}` : "",
      diag.failedHosts.length ? `异常主机：${diag.failedHosts.join("、")}` : "",
      `报错详情：\n${diag.errorDetail}`,
      "请先读取该组件的相关任务和模板文件，判断是否为组件剧本问题；如确需修复，请用最小改动起草修改并通过平台检查（不要直接发布，由我确认后发布并同步到交付）。",
    ]
      .filter(Boolean)
      .join("\n"),
    [
      `Cluster ${clusterName} automated step "${step.title}" (${step.key}) failed. Please investigate and draft a component fix.`,
      step.playbook ? `Playbook: ${step.playbook}` : "",
      diag.failedTask ? `Failed task: ${diag.failedTask}` : "",
      diag.failedHosts.length ? `Affected hosts: ${diag.failedHosts.join(", ")}` : "",
      `Error detail:\n${diag.errorDetail}`,
      "Please read the relevant component tasks/templates, propose minimal edits passing platform checks, and wait for my confirmation to publish and sync.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  try {
    child.sessionStorage.setItem(
      "mh-wb-prefill",
      JSON.stringify({ name: componentId, text }),
    );
  } catch {
    /* ignore storage limits */
  }
  child.location.href = `${location.origin}${location.pathname}#/components/${encodeURIComponent(componentId)}/edit/files`;
}

/* ---------- Incremental Live Step Log Hook ---------- */

function useLiveStepLog(
  jobId: string,
  runId: string,
  stepId: string,
  stepSeq: number,
  stepState: string,
) {
  const [text, setText] = useState("");
  const [byteSize, setByteSize] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const offsetRef = useRef(0);
  const keyRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const reqKey = jobId && runId && stepId ? `${jobId}/${runId}/${stepId}` : "";

  const fetchChunk = useCallback(
    async (reset: boolean) => {
      if (!reqKey) return;
      if (stepSeq <= 0 && !isStepLive(stepState)) {
        if (reset) {
          setText("");
          setByteSize(0);
          offsetRef.current = 0;
          setLoading(false);
          setLoadErr("");
        }
        return;
      }
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const startOffset = reset ? 0 : offsetRef.current;
      const url = `/api/jobs/${encodeURIComponent(jobId)}/executions/${encodeURIComponent(runId)}/logs/${encodeURIComponent(stepId)}${startOffset > 0 ? `?offset=${startOffset}` : ""}`;
      if (reset) setLoading(true);
      try {
        const resp = await fetch(withLang(url), {
          headers: { "X-Lang": getLang() },
          signal: ctrl.signal,
        });
        if (keyRef.current !== reqKey || ctrl.signal.aborted) return;
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const chunk = await resp.text();
        if (keyRef.current !== reqKey || ctrl.signal.aborted) return;
        const sizeHdr = Number(resp.headers.get("X-Log-Size") || "");
        if (reset) {
          setText(chunk);
          const nextSize =
            Number.isFinite(sizeHdr) && sizeHdr >= 0
              ? sizeHdr
              : new Blob([chunk]).size;
          offsetRef.current = nextSize;
          setByteSize(nextSize);
        } else if (chunk.length > 0) {
          setText((prev) => prev + chunk);
          const nextSize =
            Number.isFinite(sizeHdr) && sizeHdr >= startOffset
              ? sizeHdr
              : startOffset + new Blob([chunk]).size;
          offsetRef.current = nextSize;
          setByteSize(nextSize);
        } else if (Number.isFinite(sizeHdr) && sizeHdr > offsetRef.current) {
          offsetRef.current = sizeHdr;
          setByteSize(sizeHdr);
        }
        setLoadErr("");
      } catch (e) {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
          return;
        }
        if (keyRef.current === reqKey) {
          const msg = e instanceof Error ? e.message : String(e);
          setLoadErr(bi(`日志读取失败：${msg}`, `Failed to load log: ${msg}`));
        }
      } finally {
        if (keyRef.current === reqKey && !ctrl.signal.aborted) setLoading(false);
      }
    },
    [reqKey, jobId, runId, stepId, stepSeq, stepState],
  );

  useEffect(() => {
    keyRef.current = reqKey;
    offsetRef.current = 0;
    setText("");
    setByteSize(0);
    setLoadErr("");
    if (!reqKey) return;
    void fetchChunk(true);
    return () => {
      abortRef.current?.abort();
    };
  }, [reqKey]);

  useEffect(() => {
    if (!reqKey || stepSeq <= 0) return;
    if (offsetRef.current > 0) void fetchChunk(false);
    else void fetchChunk(true);
  }, [reqKey, stepSeq, stepState, fetchChunk]);

  useEffect(() => {
    if (!reqKey || !isStepLive(stepState)) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void fetchChunk(offsetRef.current === 0);
      }
    }, 1200);
    return () => clearInterval(id);
  }, [reqKey, stepState, fetchChunk]);

  return { text, byteSize, loading, loadErr, reload: () => fetchChunk(true) };
}

/* ---------- Isolated 1s Elapsed Clock Leaves (prevents MonitorWorkspace & Log DOM re-renders!) ---------- */

function useLiveSecond(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function LiveStepDur({
  step,
  prefix = "",
  wrapParen = false,
  className,
}: {
  step: ExecStep;
  prefix?: string;
  wrapParen?: boolean;
  className?: string;
}) {
  const now = useLiveSecond(isStepLive(step.state));
  const dur = fmtStepDur(step, now);
  if (!dur) return null;
  const content = `${prefix}${wrapParen ? `(${dur})` : dur}`;
  return className ? <span className={className}>{content}</span> : <>{content}</>;
}

function LivePhaseDur({
  rows,
  live,
}: {
  rows: PipelineRow[];
  live: boolean;
}) {
  const now = useLiveSecond(live);
  let totalMs = 0;
  for (const x of rows) {
    if (x.step.started) {
      const a = Date.parse(x.step.started);
      const b = x.step.finished
        ? Date.parse(x.step.finished)
        : isStepLive(x.state)
          ? now
          : NaN;
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) totalMs += b - a;
    }
  }
  if (totalMs <= 0) return null;
  return <span>{fmtDurMs(totalMs)}</span>;
}

function LiveTotalDur({
  scopedRun,
  runsChrono,
  active,
}: {
  scopedRun?: ExecRun;
  runsChrono: ExecRun[];
  active: boolean;
}) {
  useLang();
  const now = useLiveSecond(active);
  let ms = 0;
  const targetRuns = scopedRun ? [scopedRun] : runsChrono;
  for (const r of targetRuns) {
    for (const st of r.steps) {
      if (!st.started) continue;
      const a = Date.parse(st.started);
      const b = st.finished
        ? Date.parse(st.finished)
        : isStepLive(st.state)
          ? now
          : NaN;
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) ms += b - a;
    }
  }
  if (ms <= 0) return null;
  return (
    <span className={`mon-kpi ${active ? "run" : ""}`}>
      {bi("耗时", "Elapsed")}
      <b>{fmtDurMs(ms)}</b>
    </span>
  );
}

const LOG_WINDOW_STEP = 1500;

const MemoLogLines = React.memo(function MemoLogLines({
  lines,
  query,
  searchMatches,
  activeMatchLine,
  focusedLine,
  isTaskOutline,
  onSelectTaskLine,
}: {
  lines: ParsedLine[];
  query: string;
  searchMatches: number[];
  activeMatchLine?: number;
  focusedLine: number | null;
  isTaskOutline: boolean;
  onSelectTaskLine: (lineNum: number) => void;
}) {
  const matchSet = useMemo(
    () => (query ? new Set(searchMatches) : null),
    [query, searchMatches],
  );
  return (
    <>
      {lines.map((l) => {
        const isMatch = matchSet?.has(l.num);
        const isActiveMatch =
          activeMatchLine === l.num || focusedLine === l.num;
        return (
          <div
            key={l.num}
            data-line={l.num}
            className={`mon-line k-${l.kind}${isTaskOutline ? " clickable" : ""}${isMatch ? " is-match" : ""}${isActiveMatch ? " is-active-match" : ""}`}
            onClick={isTaskOutline ? () => onSelectTaskLine(l.num) : undefined}
          >
            <span className="mon-ln">{l.num}</span>
            <span className="mon-lt">
              {query ? renderHighlightedText(l.text, query) : l.text || " "}
            </span>
          </div>
        );
      })}
    </>
  );
});

/* ---------- AI Diagnose Trigger (inside AIDock) ---------- */

function AIDiagnoseButton({
  step,
  runNum,
  diag,
  logText,
  clusterName,
  label,
  size = "default",
}: {
  step?: ExecStep;
  runNum?: number;
  diag?: FailureDiag;
  logText?: string;
  clusterName: string;
  label?: string;
  size?: "small" | "default";
}) {
  useLang();
  const dock = useAIDock();
  const aiStatus = useAIStatus();
  if (!aiStatus.enabled || !dock) return null;
  const targetKey = step ? `step:${step.key}` : "review";
  if (!dock.available(targetKey)) return null;

  return (
    <Button
      shape="round"
      size={size}
      className="ai-pill"
      icon={<Spark size={size === "small" ? 13 : 14} rainbow />}
      onClick={() => {
        if (step && diag) {
          const rawTail = logText
            ? logText.split(/\r?\n/).slice(-55).join("\n")
            : "";
          const tail =
            rawTail.length > 4500
              ? rawTail.slice(rawTail.length - 4500)
              : rawTail;
          const prompt = bi(
            [
              `集群 ${clusterName} 在第 #${runNum || 1} 批自动执行步骤「${step.title}」(${step.key}) 时失败（exit ${step.exit_code ?? "?"}）。`,
              `所属组件：${diag.componentLabel}`,
              step.playbook ? `执行剧本：${step.playbook}` : "",
              diag.failedTask ? `失败任务：${diag.failedTask}` : "",
              diag.failedHosts.length
                ? `异常主机：${diag.failedHosts.join("、")}`
                : "",
              `核心报错：\n${diag.errorDetail}`,
              "请帮我判断：1）这是目标主机/现场环境问题，还是组件脚本/断言问题？2）若属于组件脚本/断言问题，请先通过 component_sync_status 核对当前已发布组件和草稿是否已经修复、本次交付能否直接「同步组件更新」：如果当前组件已经没问题，直接告诉我无需再去组件工作台修改，以及同步并重跑前需要核对的现场前置状态；只有确认当前组件尚未修复时，再给出组件工作台的最小修改方案。",
              tail ? `\n最近终端日志：\n\`\`\`\n${tail}\n\`\`\`` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            [
              `Cluster ${clusterName} failed in batch #${runNum || 1} step "${step.title}" (${step.key}), exit ${step.exit_code ?? "?"}.`,
              `Component: ${diag.componentLabel}`,
              step.playbook ? `Playbook: ${step.playbook}` : "",
              diag.failedTask ? `Failed task: ${diag.failedTask}` : "",
              diag.failedHosts.length
                ? `Affected hosts: ${diag.failedHosts.join(", ")}`
                : "",
              `Error:\n${diag.errorDetail}`,
              "Please diagnose: (1) whether this is an environment/host issue or a component playbook/assertion issue; (2) if it is a component issue, FIRST call component_sync_status to check whether the latest published component or draft has already fixed it and whether this delivery can simply click 'Sync Fix' — tell me clearly if no component edit is needed (plus any host state to verify before rerunning), and only suggest component workbench edits if the current component is still unfixed.",
              tail ? `\nRecent log output:\n\`\`\`\n${tail}\n\`\`\`` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          );
          dock.open({
            key: `step:${step.key}`,
            title: step.title,
            context: bi(
              `执行排障 · ${clusterName} · 第 #${runNum || 1} 批`,
              `Execution troubleshooting · ${clusterName} · Batch #${runNum || 1}`,
            ),
            step: {
              key: step.key,
              title: step.title,
              phase: phaseLabel(phaseOfKey(step.key)),
              playbook: step.playbook,
              state: step.state,
              exit_code: step.exit_code,
              component: diag.componentId,
              failed_task: diag.failedTask,
              failed_hosts: diag.failedHosts,
            },
            prefill: prompt,
          });
        } else {
          dock.open({
            key: "review",
            title: bi("执行诊断助手", "Execution Diagnostics"),
            context: clusterName,
          });
        }
      }}
    >
      {label || bi("AI 一键诊断", "AI Diagnose")}
    </Button>
  );
}

/* ---------- Step Status Glyph ---------- */

function StepGlyph({ state }: { state: string }) {
  if (state === "running" || state === "leased") {
    return (
      <span className={`mon-step-glyph ${state}`}>
        <IconLoading spin />
      </span>
    );
  }
  if (state === "succeeded") {
    return (
      <span className="mon-step-glyph succeeded">
        <IconCheckCircleFill />
      </span>
    );
  }
  if (state === "failed" || state === "interrupted" || state === "blocked") {
    return (
      <span className={`mon-step-glyph ${state}`}>
        <IconCloseCircleFill />
      </span>
    );
  }
  if (state === "unknown") {
    return (
      <span className="mon-step-glyph unknown">
        <IconExclamationCircleFill />
      </span>
    );
  }
  if (state === "skipped") {
    return (
      <span className="mon-step-glyph skipped">
        <IconMinusCircle />
      </span>
    );
  }
  return (
    <span className="mon-step-glyph pending">
      <span className="mon-step-ring" />
    </span>
  );
}

/* ---------- Main Execution Monitor Page ---------- */

type RailStatusFilter = "all" | "active" | "failed" | "done";

const MONITOR_LIST_URL = "/api/executions/runs";
const execDetailUrl = (jobId: string) =>
  `/api/jobs/${encodeURIComponent(jobId)}/executions`;
const execDetailInflight = new Map<string, Promise<ExecDetailData | null>>();

function prefetchExecDetail(jobId: string): Promise<ExecDetailData | null> {
  if (!jobId) return Promise.resolve(null);
  const url = execDetailUrl(jobId);
  const hit = cached<ExecDetailData>(url);
  if (hit) return Promise.resolve(hit);
  const existing = execDetailInflight.get(url);
  if (existing) return existing;
  const p = api<ExecDetailData>(url)
    .then((d) => {
      putCached(url, d);
      return d;
    })
    .catch(() => null)
    .finally(() => {
      execDetailInflight.delete(url);
    });
  execDetailInflight.set(url, p);
  return p;
}

export function ExecutionMonitorPage({
  selectedJob,
  initialRun,
  initialStep,
}: {
  selectedJob?: string;
  initialRun?: string;
  initialStep?: string;
}) {
  useLang();
  const [listData, setListData] = useState<MonitorListPayload | null>(
    () => cached<MonitorListPayload>(MONITOR_LIST_URL) ?? null,
  );
  const [listLoading, setListLoading] = useState(
    () => !cached<MonitorListPayload>(MONITOR_LIST_URL),
  );
  const narrow = useMedia("(max-width: 900px)");
  const compact = useMedia("(max-width: 1100px)");
  const [railHidden, setRailHidden] = useState(() => compact);
  const prevCompactRef = useRef(compact);
  const prevNarrowRef = useRef(narrow);
  const [railSearch, setRailSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<RailStatusFilter>("all");
  const [appFilter, setAppFilter] = useState<string>("all");
  const listBodyRef = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ y: number; h: number } | null>(null);

  useEffect(() => {
    // Auto-collapse rail when resizing into narrow/compact viewports; auto-restore above 1100px.
    if (narrow && !prevNarrowRef.current) {
      setRailHidden(true);
    } else if (compact !== prevCompactRef.current) {
      setRailHidden(compact);
    }
    prevCompactRef.current = compact;
    prevNarrowRef.current = narrow;
  }, [compact, narrow]);

  useEffect(() => {
    if (!narrow || railHidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRailHidden(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, railHidden]);

  const loadList = useCallback(async () => {
    try {
      const res = await api<MonitorListPayload>(MONITOR_LIST_URL);
      putCached(MONITOR_LIST_URL, res);
      setListData(res);
    } catch {
      /* keep last known list */
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const hasAnyActive = (listData?.active_count || 0) > 0;
  useEffect(() => {
    const ms = hasAnyActive ? 3000 : 12000;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadList();
    }, ms);
    const onUpdated = () => void loadList();
    window.addEventListener("execution-updated", onUpdated);
    return () => {
      clearInterval(id);
      window.removeEventListener("execution-updated", onUpdated);
    };
  }, [hasAnyActive, loadList]);

  const items = listData?.items || [];
  const activeJobId = selectedJob || items[0]?.job_id || "";
  const activeSummary = useMemo(
    () => items.find((it) => it.job_id === activeJobId),
    [items, activeJobId],
  );

  useEffect(() => {
    if (!selectedJob && items.length > 0) {
      go({ name: "executions", id: items[0].job_id }, { replace: true, instant: true });
    }
  }, [selectedJob, items]);

  const statusCounts = useMemo(() => {
    let active = 0;
    let failed = 0;
    let done = 0;
    for (const it of items) {
      if (it.active) active++;
      else if (it.state === "failed") failed++;
      else done++;
    }
    return { all: items.length, active, failed, done };
  }, [items]);

  const appCounts = useMemo(() => {
    const m = new Map<string, { id: string; name: string; count: number }>();
    for (const it of items) {
      const id = it.app_id || it.app_name;
      const cur = m.get(id);
      if (cur) cur.count++;
      else m.set(id, { id, name: it.app_name || id, count: 1 });
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = railSearch.trim().toLowerCase();
    return items.filter((it) => {
      if (statusFilter === "active" && !it.active) return false;
      if (statusFilter === "failed" && it.state !== "failed") return false;
      if (statusFilter === "done" && (it.active || it.state === "failed")) return false;
      if (appFilter !== "all" && (it.app_id || it.app_name) !== appFilter) return false;
      if (!q) return true;
      return (
        it.cluster.toLowerCase().includes(q) ||
        it.app_name.toLowerCase().includes(q) ||
        (it.executor_name || "").toLowerCase().includes(q)
      );
    });
  }, [items, statusFilter, appFilter, railSearch]);

  const canManageNodes = can("execution.manage");

  const summaryById = useMemo(() => {
    const m = new Map<string, MonitorListItem>();
    for (const it of items) m.set(it.job_id, it);
    return m;
  }, [items]);

  // Warm the first few visible clusters so switching is instant even before hover.
  useEffect(() => {
    if (!filteredItems.length) return;
    const targets = filteredItems
      .slice(0, 4)
      .filter((it) => it.job_id !== activeJobId);
    const id = window.setTimeout(() => {
      targets.forEach((it) => {
        void prefetchExecDetail(it.job_id);
      });
    }, 180);
    return () => window.clearTimeout(id);
  }, [filteredItems, activeJobId]);

  // Sliding selection card (.row-indicator) — identical spring physics to Deliveries.
  useLayoutEffect(() => {
    const el = activeJobId
      ? document.getElementById(`mon-row-${activeJobId}`)
      : null;
    const container = listBodyRef.current;
    const measure = () =>
      setInd(
        el && container?.contains(el)
          ? { y: el.offsetTop, h: el.offsetHeight }
          : null,
      );
    measure();
    if (!container || !el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    container
      .querySelectorAll('[role="group"]')
      .forEach((group) => observer.observe(group));
    return () => observer.disconnect();
  }, [activeJobId, filteredItems, railHidden]);

  // ArrowUp / ArrowDown keyboard switching across visible clusters (matching Deliveries).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          t.closest(".arco-modal,.arco-drawer"))
      )
        return;
      if (!filteredItems.length) return;
      e.preventDefault();
      const idx = filteredItems.findIndex((x) => x.job_id === activeJobId);
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next =
        filteredItems[
          Math.max(0, Math.min(filteredItems.length - 1, idx < 0 ? 0 : idx + step))
        ];
      if (!next || next.job_id === activeJobId) return;
      go({ name: "executions", id: next.job_id }, { replace: !!selectedJob });
      document
        .getElementById(`mon-row-${next.job_id}`)
        ?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filteredItems, activeJobId, selectedJob]);

  return (
    <div className={`md-split mon-split ${railHidden ? "mon-rail-hidden" : ""}`}>
      {narrow && !railHidden && (
        <div
          className="mon-rail-backdrop"
          onClick={() => setRailHidden(true)}
          aria-hidden
        />
      )}
      {/* Native 304px (--rail-w) Left Cluster Rail (slide-over drawer on <=900px) */}
      <aside
        className="md-list"
        aria-label={bi("自动化执行列表", "Automated executions")}
        aria-hidden={railHidden || undefined}
      >
        <div className="list-head">
          <div className="list-title">
            <h1>{bi("执行监控", "Executions")}</h1>
            <div className="mon-list-title-right">
              {listData && (
                <Tooltip
                  content={bi(
                    `在线执行节点 ${listData.online_runners} / ${listData.total_runners}${canManageNodes ? " · 点击管理执行节点" : ""}`,
                    `${listData.online_runners} / ${listData.total_runners} runners online`,
                  )}
                  mini
                >
                  <button
                    type="button"
                    className={`mon-runner-pill num ${listData.online_runners > 0 ? "on" : ""} ${canManageNodes ? "clickable" : ""}`}
                    onClick={() =>
                      canManageNodes && go({ name: "settings", id: "execution-nodes" })
                    }
                  >
                    <i aria-hidden />
                    {bi(
                      `在线节点 ${listData.online_runners}/${listData.total_runners}`,
                      `${listData.online_runners}/${listData.total_runners} online`,
                    )}
                  </button>
                </Tooltip>
              )}
              {narrow && (
                <Button
                  size="mini"
                  type="text"
                  className="mon-rail-close"
                  icon={<IconClose />}
                  onClick={() => setRailHidden(true)}
                  aria-label={bi("收起集群列表", "Close cluster list")}
                />
              )}
            </div>
          </div>

          <Input
            prefix={<IconSearch />}
            allowClear
            value={railSearch}
            onChange={setRailSearch}
            placeholder={bi("搜索集群、组件或节点", "Search clusters, apps, runners")}
            aria-label={bi("搜索集群", "Search clusters")}
          />

          <div className="mon-status-seg">
            <Segmented<RailStatusFilter>
              size="sm"
              label={bi("按执行状态筛选", "Filter by execution status")}
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "all", label: bi("全部", "All"), count: statusCounts.all },
                { value: "active", label: bi("运行", "Live"), count: statusCounts.active },
                { value: "failed", label: bi("失败", "Fail"), count: statusCounts.failed },
                { value: "done", label: bi("通过", "Pass"), count: statusCounts.done },
              ]}
            />
          </div>

          {appCounts.length > 1 && (
            <div
              className="mon-app-strip"
              role="group"
              aria-label={bi("按组件快捷筛选", "Quick filter by component")}
            >
              <button
                type="button"
                className={`mon-app-chip ${appFilter === "all" ? "on" : ""}`}
                onClick={() => setAppFilter("all")}
              >
                {bi("全部", "All")}
              </button>
              {appCounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`mon-app-chip ${appFilter === a.id ? "on" : ""}`}
                  onClick={() => setAppFilter(appFilter === a.id ? "all" : a.id)}
                >
                  <span>{a.name}</span>
                  <em className="num">{a.count}</em>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="list-body" ref={listBodyRef} role="listbox" aria-label={bi("集群", "Clusters")}>
          {ind && (
            <span
              className="row-indicator"
              style={{ transform: `translateY(${ind.y}px)`, height: ind.h }}
              aria-hidden
            />
          )}
          {listLoading && !listData ? (
            <div className="list-state">
              <IconLoading spin /> {bi("正在读取执行记录…", "Loading executions…")}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="list-state">
              <p className="muted small">
                {items.length === 0
                  ? bi(
                      "暂无自动化执行记录。在任意交付的部署页发起自动执行后，将在此实时呈现。",
                      "No automated runs yet. Authorize a run from any delivery to watch it live here.",
                    )
                  : bi("没有符合当前筛选条件的集群", "No matching clusters")}
              </p>
              {(statusFilter !== "all" || appFilter !== "all" || railSearch) && (
                <Button
                  size="small"
                  onClick={() => {
                    setStatusFilter("all");
                    setAppFilter("all");
                    setRailSearch("");
                  }}
                >
                  {bi("重置筛选", "Reset filters")}
                </Button>
              )}
            </div>
          ) : (
            (() => {
              const groups: { key: string; items: MonitorListItem[] }[] = [];
              for (const it of filteredItems) {
                const key = dayLabel(it.updated);
                let g = groups[groups.length - 1];
                if (!g || g.key !== key) {
                  g = { key, items: [] };
                  groups.push(g);
                }
                g.items.push(it);
              }
              return groups.map((g) => (
                <div key={g.key} role="group" aria-label={g.key}>
                  <div className="list-day">{g.key}</div>
                  {g.items.map((it) => {
                    const pct =
                      it.total_steps > 0
                        ? Math.round((it.done_steps / it.total_steps) * 100)
                        : 0;
                    const isSelected = it.job_id === activeJobId;
                    const dotState = it.active
                      ? "running"
                      : it.state === "failed"
                        ? "failed"
                        : "done";
                    const fracCls = it.active
                      ? "is-live"
                      : it.state === "failed"
                        ? "is-failed"
                        : "";
                    const fracTip =
                      it.state === "failed"
                        ? bi(
                            `已完成 ${it.done_steps}/${it.total_steps} 步 · ${it.failed_steps} 步失败`,
                            `${it.done_steps}/${it.total_steps} steps · ${it.failed_steps} failed`,
                          )
                        : bi(
                            `已完成 ${it.done_steps}/${it.total_steps} 步`,
                            `${it.done_steps}/${it.total_steps} steps`,
                          );
                    return (
                      <button
                        key={it.job_id}
                        id={`mon-row-${it.job_id}`}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`row row-dlv mon-row-btn ${isSelected ? "on" : ""} ${it.active ? "is-live" : ""}`}
                        onPointerEnter={() => void prefetchExecDetail(it.job_id)}
                        onFocus={() => void prefetchExecDetail(it.job_id)}
                        onClick={() => {
                          go(
                            { name: "executions", id: it.job_id },
                            { replace: !!selectedJob },
                          );
                          if (narrow) setRailHidden(true);
                        }}
                      >
                        <span className="row-ico">
                          <AppGlyph id={it.app_id} size={30} />
                          <StatusDot state={dotState} />
                        </span>
                        <div className="row-main">
                          <div className="row-top">
                            <span className="row-name" title={it.cluster}>
                              {it.cluster}
                            </span>
                            <span
                              className="row-time num"
                              title={fullTime(it.updated)}
                            >
                              {clock(it.updated)}
                            </span>
                          </div>
                          <div className="row-sub-line">
                            {it.active && it.running_step_title ? (
                              <div
                                className="mon-row-live"
                                title={it.running_step_title}
                              >
                                ▸ {it.running_step_title}
                              </div>
                            ) : (
                              <div className="row-sub">
                                {it.app_name}
                                {it.version ? ` ${it.version}` : ""} ·{" "}
                                {bi(`${it.batch_count} 批`, `${it.batch_count} runs`)}
                              </div>
                            )}
                            <span className="mon-row-tags">
                              {it.state === "recovered" && (
                                <span
                                  className="mon-row-flag warn"
                                  title={bi("包含重试恢复的步骤", "Contains retried steps")}
                                >
                                  {bi("重跑", "Retry")}
                                </span>
                              )}
                              <span
                                className={`mon-row-frac-pill num ${fracCls}`}
                                title={fracTip}
                              >
                                {it.done_steps}/{it.total_steps}
                              </span>
                            </span>
                          </div>
                        </div>
                        {it.active && (
                          <span className="mon-row-live-track" aria-hidden>
                            <i style={{ width: `${pct}%` }} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ));
            })()
          )}
        </div>
      </aside>

      {/* Main Telemetry Workspace */}
      {activeJobId ? (
        <AIDock
          scope={{ kind: "job", jobId: activeJobId }}
          start={{
            key: "review",
            title: bi("执行诊断助手", "Execution Assistant"),
            context: activeSummary
              ? `${activeSummary.cluster} · ${activeSummary.app_name}`
              : activeJobId,
          }}
        >
          <MonitorWorkspace
            jobId={activeJobId}
            summary={activeSummary}
            summaryById={summaryById}
            initialRun={initialRun}
            initialStep={initialStep}
            railHidden={railHidden}
            onToggleRail={() => setRailHidden((v) => !v)}
            onListRefresh={loadList}
          />
        </AIDock>
      ) : (
        <div className="mon-main">
          <div className="mon-empty-canvas">
            <div className="mon-empty-icon">
              <IconThunderbolt />
            </div>
            <h2>{bi("实时自动化执行监控台", "Real-Time Execution Monitor")}</h2>
            <p>
              {bi(
                "当任意集群通过执行节点发起自动部署或测试时，这里会实时展示阶段进度、完整事件流与增量终端日志，并集成 AI 一键排障与组件热修复闭环。",
                "Watch live deployment pipelines, streaming Ansible logs, and AI-assisted troubleshooting & component fix workflows.",
              )}
            </p>
            <Button type="primary" onClick={() => go({ name: "deliveries" })}>
              {bi("前往交付列表", "Go to Deliveries")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Per-Job Telemetry Workspace ---------- */

type LogViewMode = "full" | "errors" | "tasks";

function MonitorWorkspace({
  jobId,
  summary,
  summaryById,
  initialRun,
  initialStep,
  railHidden,
  onToggleRail,
  onListRefresh,
}: {
  jobId: string;
  summary?: MonitorListItem;
  summaryById: Map<string, MonitorListItem>;
  initialRun?: string;
  initialStep?: string;
  railHidden: boolean;
  onToggleRail: () => void;
  onListRefresh: () => Promise<void>;
}) {
  useLang();
  const [view, setView] = useState<{
    jobId: string;
    data: ExecDetailData | null;
  }>(() => ({
    jobId,
    data: cached<ExecDetailData>(execDetailUrl(jobId)) ?? null,
  }));
  const data = view.data;
  const shownJobId = view.data ? view.jobId : jobId;
  const shownSummary = summaryById.get(shownJobId) || summary;
  const [switching, setSwitching] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  const [scope, setScope] = useState<string>(() => {
    const init = cached<ExecDetailData>(execDetailUrl(jobId));
    if (!init) return initialRun || "";
    if (initialRun && init.runs.some((r) => r.id === initialRun)) return initialRun;
    const act = init.runs.find(isActiveRun);
    return act ? act.id : "all";
  });
  const [consoleMode, setConsoleMode] = useState<"stream" | "log">(
    initialStep ? "log" : "stream",
  );
  const [pipeHidden, setPipeHidden] = useState(false);
  const [pipeFilter, setPipeFilter] = useState<"all" | "running" | "failed">("all");
  const [followLive, setFollowLive] = useState(true);
  const [collapsedPhases, setCollapsedPhases] = useState<Record<string, boolean>>({});

  const [selectedRef, setSelectedRef] = useState<{
    runId: string;
    stepId: string;
    stepKey: string;
  } | null>(null);

  const [search, setSearch] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [logView, setLogView] = useState<LogViewMode>("full");
  const [streamFilter, setStreamFilter] = useState<"all" | "issues">("all");
  const [wrapLines, setWrapLines] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [focusedLine, setFocusedLine] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [diagCollapsed, setDiagCollapsed] = useState(false);
  const [logTailLimit, setLogTailLimit] = useState(LOG_WINDOW_STEP);
  const [resizingPipe, setResizingPipe] = useState(false);
  const [hotfixStep, setHotfixStep] = useState<{
    key: string;
    title: string;
  } | null>(null);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const termBodyRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<number>(0);
  const busyLockRef = useRef(false);
  const syncLockRef = useRef(false);
  const syncConfirmLockRef = useRef(false);
  const pipeResizeCleanupRef = useRef<(() => void) | null>(null);
  const suppressScrollUntilRef = useRef(0);
  const scopeInitializedRef = useRef(Boolean(view.data && !initialStep));
  const reqSeqRef = useRef(0);
  const shownJobRef = useRef(shownJobId);
  shownJobRef.current = shownJobId;

  const commitClusterSwitch = useCallback(
    (
      targetJobId: string,
      nextData: ExecDetailData,
      wantRun?: string,
      wantStep?: string,
    ) => {
      const matchedRun = wantRun
        ? nextData.runs.find((r) => r.id === wantRun)
        : undefined;
      const nextActive = nextData.runs.find(isActiveRun);
      const nextScope = matchedRun
        ? matchedRun.id
        : nextActive
          ? nextActive.id
          : "all";

      let nextSel: { runId: string; stepId: string; stepKey: string } | null = null;
      let nextMode: "stream" | "log" = "stream";
      if (wantStep) {
        const searchRuns = matchedRun
          ? [matchedRun, ...nextData.runs.filter((r) => r.id !== matchedRun.id)]
          : nextData.runs;
        for (const r of searchRuns) {
          const st = r.steps.find((s) => s.id === wantStep || s.key === wantStep);
          if (st) {
            nextSel = { runId: r.id, stepId: st.id, stepKey: st.key };
            nextMode = "log";
            break;
          }
        }
      }

      scopeInitializedRef.current = true;
      setView({ jobId: targetJobId, data: nextData });
      setLoadErr("");
      setScope(nextScope);
      setSelectedRef(nextSel);
      setConsoleMode(nextMode);
      setPipeFilter("all");
      setFollowLive(true);
      setCollapsedPhases({});
      setSearch("");
      setMatchIdx(0);
      setLogView("full");
      setStreamFilter("all");
      setFocusedLine(null);
      setDiagCollapsed(false);
      setHotfixStep(null);
      setAutoScroll(true);
    },
    [],
  );

  const loadDetail = useCallback(async () => {
    const target = jobId;
    const seq = reqSeqRef.current;
    try {
      const d = await api<ExecDetailData>(execDetailUrl(target));
      putCached(execDetailUrl(target), d);
      if (seq !== reqSeqRef.current) return;
      if (shownJobRef.current !== target) {
        commitClusterSwitch(target, d, initialRun, initialStep);
      } else {
        setView({ jobId: target, data: d });
        setLoadErr("");
      }
    } catch (e) {
      if (seq !== reqSeqRef.current) return;
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === reqSeqRef.current) setSwitching(false);
    }
  }, [jobId, initialRun, initialStep, commitClusterSwitch]);

  useEffect(() => {
    const seq = ++reqSeqRef.current;
    const hit = cached<ExecDetailData>(execDetailUrl(jobId));
    if (hit) {
      // Cache hit: transition synchronously on the next frame with zero blank flash,
      // then quietly revalidate fresh telemetry in the background.
      if (shownJobRef.current !== jobId || !scopeInitializedRef.current) {
        commitClusterSwitch(jobId, hit, initialRun, initialStep);
      }
      setSwitching(false);
      void api<ExecDetailData>(execDetailUrl(jobId))
        .then((fresh) => {
          putCached(execDetailUrl(jobId), fresh);
          if (seq !== reqSeqRef.current) return;
          setView({ jobId, data: fresh });
          setLoadErr("");
        })
        .catch(() => {
          /* keep cached telemetry visible */
        });
      return;
    }

    // Cold miss: keep the currently displayed cluster smoothly visible (NEVER flash white!)
    // while showing a 2px shimmer hairline until the new cluster arrives.
    if (shownJobRef.current && view.data) {
      setSwitching(true);
    }
    void prefetchExecDetail(jobId).then((fetched) => {
      if (seq !== reqSeqRef.current) return;
      if (fetched) {
        commitClusterSwitch(jobId, fetched, initialRun, initialStep);
        setSwitching(false);
      } else {
        // Fallback direct call to surface real error text if needed
        void loadDetail();
      }
    });
  }, [jobId, initialRun, initialStep]); // eslint-disable-line react-hooks/exhaustive-deps

  const runsNewest = data?.runs || [];
  const runsChrono = useMemo(
    () =>
      [...runsNewest].sort((a, b) =>
        a.created !== b.created
          ? a.created.localeCompare(b.created)
          : a.id.localeCompare(b.id),
      ),
    [runsNewest],
  );
  const runNumById = useMemo(() => {
    const m = new Map<string, number>();
    runsChrono.forEach((r, idx) => m.set(r.id, idx + 1));
    return m;
  }, [runsChrono]);

  const activeRun = useMemo(() => runsNewest.find(isActiveRun), [runsNewest]);

  useEffect(() => {
    const ms = activeRun ? 1500 : 10000;
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadDetail();
    };
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadDetail();
    }, ms);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeRun, loadDetail]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      pipeResizeCleanupRef.current?.();
    };
  }, []);

  const startPipeResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !workspaceRef.current) return;
    e.preventDefault();
    pipeResizeCleanupRef.current?.();
    const ws = workspaceRef.current;
    const pipeEl = ws.querySelector<HTMLElement>(".mon-pipeline");
    const startX = e.clientX;
    const startW = pipeEl ? pipeEl.getBoundingClientRect().width : 332;
    let rafId = 0;
    let latestW = startW;

    setResizingPipe(true);
    document.body.classList.add("is-resizing-pane");

    const onMove = (ev: PointerEvent) => {
      const wsRect = ws.getBoundingClientRect();
      const maxW = Math.max(260, Math.min(540, wsRect.width - 360));
      latestW = Math.round(Math.max(220, Math.min(maxW, startW + (ev.clientX - startX))));
      if (!rafId) {
        rafId = window.requestAnimationFrame(() => {
          rafId = 0;
          ws.style.setProperty("--mon-pipe-w", `${latestW}px`);
        });
      }
    };

    const cleanup = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      document.body.classList.remove("is-resizing-pane");
      setResizingPipe(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("blur", cleanup);
      pipeResizeCleanupRef.current = null;
    };

    pipeResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("blur", cleanup);
  }, []);

  useEffect(() => {
    if (!data || scopeInitializedRef.current) return;
    scopeInitializedRef.current = true;
    const matchedInitialRun = initialRun
      ? data.runs.find((r) => r.id === initialRun)
      : undefined;
    if (matchedInitialRun) {
      setScope(matchedInitialRun.id);
    } else if (activeRun) {
      setScope(activeRun.id);
    } else {
      setScope("all");
    }
    if (initialStep) {
      const searchRuns = matchedInitialRun
        ? [matchedInitialRun, ...data.runs.filter((r) => r.id !== matchedInitialRun.id)]
        : data.runs;
      for (const r of searchRuns) {
        const st = r.steps.find(
          (s) => s.id === initialStep || s.key === initialStep,
        );
        if (st) {
          setSelectedRef({ runId: r.id, stepId: st.id, stepKey: st.key });
          setConsoleMode("log");
          break;
        }
      }
    }
  }, [data, initialRun, initialStep, activeRun]);

  const latestStateByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of runsChrono) {
      for (const st of r.steps) {
        if (st.state !== "pending" || !m.has(st.key)) {
          m.set(st.key, st.state);
        }
      }
    }
    return m;
  }, [runsChrono]);

  const attemptsByKey = useMemo(() => {
    const m = new Map<string, AttemptRef[]>();
    for (const r of runsChrono) {
      const runNum = runNumById.get(r.id) || 1;
      for (const st of r.steps) {
        if (!m.has(st.key)) m.set(st.key, []);
        m.get(st.key)!.push({ run: r, runNum, step: st });
      }
    }
    return m;
  }, [runsChrono, runNumById]);

  const executedAttemptsByKey = useMemo(() => {
    const m = new Map<string, AttemptRef[]>();
    for (const r of runsChrono) {
      const runNum = runNumById.get(r.id) || 1;
      for (const st of r.steps) {
        if (!isStepExecuted(st)) continue;
        if (!m.has(st.key)) m.set(st.key, []);
        m.get(st.key)!.push({ run: r, runNum, step: st });
      }
    }
    return m;
  }, [runsChrono, runNumById]);

  /** For a historically failed batch, find the later batch that re-ran and passed its failed step(s). */
  const findLaterPassingRun = useCallback(
    (run: ExecRun): { run: ExecRun; runNum: number } | null => {
      if (run.state !== "failed") return null;
      const failedSteps = run.steps.filter((s) => isStepFail(s.state));
      if (!failedSteps.length) return null;
      if (!failedSteps.every((s) => isStepSettled(latestStateByKey.get(s.key) || ""))) {
        return null;
      }
      // Find the passing attempt for the first failed step after this run
      const firstFailedKey = failedSteps[0].key;
      const atts = executedAttemptsByKey.get(firstFailedKey) || [];
      const curNum = runNumById.get(run.id) || 0;
      const later = atts.find(
        (a) => a.runNum > curNum && isStepSettled(a.step.state),
      );
      return later ? { run: later.run, runNum: later.runNum } : null;
    },
    [latestStateByKey, executedAttemptsByKey, runNumById],
  );

  const effectiveScope = scope || (activeRun ? activeRun.id : "all");
  const scopedRun = useMemo(
    () =>
      effectiveScope !== "all"
        ? runsNewest.find((r) => r.id === effectiveScope)
        : undefined,
    [effectiveScope, runsNewest],
  );

  const selectScope = useCallback(
    (nextScope: string) => {
      setScope(nextScope);
      if (nextScope === "all") {
        setSelectedRef((prev) => {
          if (!prev) return prev;
          const prevRun = runsNewest.find((r) => r.id === prev.runId);
          const prevStep = prevRun?.steps.find((s) => s.id === prev.stepId);
          if (prevStep && isStepExecuted(prevStep)) return prev;
          const execAtts = executedAttemptsByKey.get(prev.stepKey);
          if (execAtts && execAtts.length > 0) {
            const latest = execAtts[execAtts.length - 1];
            return {
              runId: latest.run.id,
              stepId: latest.step.id,
              stepKey: latest.step.key,
            };
          }
          return prev;
        });
        return;
      }

      const targetRun = runsNewest.find((r) => r.id === nextScope);
      if (!targetRun) return;
      if (!activeRun || targetRun.id !== activeRun.id) {
        setFollowLive(false);
      }
      setSelectedRef((prev) => {
        if (
          prev &&
          prev.runId === targetRun.id &&
          targetRun.steps.some((s) => s.id === prev.stepId)
        ) {
          return prev;
        }
        if (prev) {
          const sameKey = targetRun.steps.find(
            (s) => s.key === prev.stepKey && isStepExecuted(s),
          );
          if (sameKey) {
            return {
              runId: targetRun.id,
              stepId: sameKey.id,
              stepKey: sameKey.key,
            };
          }
        }
        const best = pickDefaultStepForRun(targetRun);
        return best
          ? { runId: targetRun.id, stepId: best.id, stepKey: best.key }
          : null;
      });
    },
    [runsNewest, activeRun, executedAttemptsByKey],
  );

  const pipelineRows = useMemo<PipelineRow[]>(() => {
    if (scopedRun) {
      const runNum = runNumById.get(scopedRun.id) || 1;
      let sawFailure = false;
      return scopedRun.steps.map((st) => {
        const execAtts = executedAttemptsByKey.get(st.key) || [];
        const haltedAfterFailure = sawFailure && st.state === "pending";
        if (isStepFail(st.state)) sawFailure = true;
        return {
          key: st.key,
          phase: phaseOfKey(st.key),
          title: st.title,
          hosts: st.hosts || [],
          state: st.state,
          run: scopedRun,
          runNum,
          step: st,
          attempts: execAtts,
          priorFailCount: execAtts.filter((a) => isStepFail(a.step.state)).length,
          haltedAfterFailure,
        };
      });
    }
    const orderKeys: string[] = [];
    const seen = new Set<string>();
    for (const ch of data?.steps || []) {
      if (attemptsByKey.has(ch.key) && !seen.has(ch.key)) {
        seen.add(ch.key);
        orderKeys.push(ch.key);
      }
    }
    for (const r of runsChrono) {
      for (const st of r.steps) {
        if (!seen.has(st.key)) {
          seen.add(st.key);
          orderKeys.push(st.key);
        }
      }
    }
    let sawUnresolvedFail = false;
    return orderKeys.map((key) => {
      const atts = attemptsByKey.get(key) || [];
      const execAtts = executedAttemptsByKey.get(key) || [];
      let chosen = atts[atts.length - 1];
      for (let i = atts.length - 1; i >= 0; i--) {
        if (isStepExecuted(atts[i].step)) {
          chosen = atts[i];
          break;
        }
      }
      const haltedAfterFailure =
        sawUnresolvedFail && chosen.step.state === "pending";
      if (isStepFail(chosen.step.state)) sawUnresolvedFail = true;
      return {
        key,
        phase: phaseOfKey(key),
        title: chosen.step.title,
        hosts: chosen.step.hosts || [],
        state: chosen.step.state,
        run: chosen.run,
        runNum: chosen.runNum,
        step: chosen.step,
        attempts: execAtts,
        priorFailCount: execAtts.filter((a) => isStepFail(a.step.state)).length,
        haltedAfterFailure,
      };
    });
  }, [
    scopedRun,
    runNumById,
    attemptsByKey,
    executedAttemptsByKey,
    data?.steps,
    runsChrono,
  ]);

  const liveRunningRef = useMemo(() => {
    if (!activeRun) return null;
    const st =
      activeRun.steps.find((s) => isStepLive(s.state)) ||
      activeRun.steps.find((s) => s.state === "pending");
    if (!st) return null;
    return { run: activeRun, step: st };
  }, [activeRun]);

  useEffect(() => {
    if (!followLive || !liveRunningRef) return;
    if (scopedRun && scopedRun.id !== liveRunningRef.run.id) return;
    setSelectedRef((prev) => {
      if (
        prev &&
        prev.runId === liveRunningRef.run.id &&
        prev.stepId === liveRunningRef.step.id
      ) {
        return prev;
      }
      return {
        runId: liveRunningRef.run.id,
        stepId: liveRunningRef.step.id,
        stepKey: liveRunningRef.step.key,
      };
    });
  }, [followLive, liveRunningRef, scopedRun]);

  const activeStepRef = useMemo<AttemptRef | null>(() => {
    if (scopedRun) {
      const runNum = runNumById.get(scopedRun.id) || 1;
      if (selectedRef) {
        if (selectedRef.runId === scopedRun.id) {
          const step = scopedRun.steps.find((s) => s.id === selectedRef.stepId);
          if (step) return { run: scopedRun, runNum, step };
        }
        const sameKey = scopedRun.steps.find(
          (s) => s.key === selectedRef.stepKey && isStepExecuted(s),
        );
        if (sameKey) return { run: scopedRun, runNum, step: sameKey };
      }
      if (liveRunningRef && liveRunningRef.run.id === scopedRun.id) {
        return {
          run: liveRunningRef.run,
          runNum,
          step: liveRunningRef.step,
        };
      }
      const failedRow = pipelineRows.find((r) => isStepFail(r.state));
      if (failedRow) {
        return { run: failedRow.run, runNum: failedRow.runNum, step: failedRow.step };
      }
      const lastExecuted = [...pipelineRows]
        .reverse()
        .find((r) => isStepExecuted(r.step));
      if (lastExecuted) {
        return {
          run: lastExecuted.run,
          runNum: lastExecuted.runNum,
          step: lastExecuted.step,
        };
      }
      if (pipelineRows.length > 0) {
        const first = pipelineRows[0];
        return { run: first.run, runNum: first.runNum, step: first.step };
      }
      return null;
    }

    if (selectedRef) {
      const run = runsNewest.find((r) => r.id === selectedRef.runId);
      const step = run?.steps.find((s) => s.id === selectedRef.stepId);
      if (run && step) {
        return { run, runNum: runNumById.get(run.id) || 1, step };
      }
    }
    if (liveRunningRef) {
      return {
        run: liveRunningRef.run,
        runNum: runNumById.get(liveRunningRef.run.id) || 1,
        step: liveRunningRef.step,
      };
    }
    const failedRow = pipelineRows.find((r) => isStepFail(r.state));
    if (failedRow) {
      return { run: failedRow.run, runNum: failedRow.runNum, step: failedRow.step };
    }
    const lastExecuted = [...pipelineRows]
      .reverse()
      .find((r) => isStepExecuted(r.step));
    if (lastExecuted) {
      return {
        run: lastExecuted.run,
        runNum: lastExecuted.runNum,
        step: lastExecuted.step,
      };
    }
    if (pipelineRows.length > 0) {
      const first = pipelineRows[0];
      return { run: first.run, runNum: first.runNum, step: first.step };
    }
    return null;
  }, [scopedRun, selectedRef, runsNewest, runNumById, liveRunningRef, pipelineRows]);

  // First unresolved failed step across the entire delivery (for header AI Diagnose CTA)
  const primaryFailedAttempt = useMemo<AttemptRef | null>(() => {
    const failedInScope = pipelineRows.find((r) => isStepFail(r.state));
    if (failedInScope) {
      return {
        run: failedInScope.run,
        runNum: failedInScope.runNum,
        step: failedInScope.step,
      };
    }
    for (let i = runsChrono.length - 1; i >= 0; i--) {
      const r = runsChrono[i];
      const st = r.steps.find(
        (s) => isStepFail(s.state) && !isStepSettled(latestStateByKey.get(s.key) || ""),
      );
      if (st) return { run: r, runNum: runNumById.get(r.id) || 1, step: st };
    }
    return null;
  }, [pipelineRows, runsChrono, latestStateByKey, runNumById]);

  const activeStepAttempts = useMemo(
    () =>
      activeStepRef
        ? executedAttemptsByKey.get(activeStepRef.step.key) || []
        : [],
    [activeStepRef, executedAttemptsByKey],
  );
  const showActiveStepAttemptPills = Boolean(
    activeStepRef &&
      activeStepAttempts.length > 1 &&
      activeStepAttempts.some((a) => a.step.id === activeStepRef.step.id),
  );

  const {
    text: logText,
    byteSize: logBytes,
    loading: logLoading,
    loadErr: logErr,
    reload: reloadLog,
  } = useLiveStepLog(
    shownJobId,
    activeStepRef?.run.id || "",
    activeStepRef?.step.id || "",
    activeStepRef?.step.seq || 0,
    activeStepRef?.step.state || "",
  );

  const parsedLines = useMemo<ParsedLine[]>(() => {
    if (!logText) return [];
    const raw = logText.replace(/\r\n/g, "\n").split("\n");
    if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
    return raw.map((text, idx) => {
      const stripped = stripTimestamp(text);
      const kind = classifyLogLine(text);
      return {
        num: idx + 1,
        text,
        stripped,
        kind,
        isErr: isGenuineErrorLine(kind, stripped),
      };
    });
  }, [logText]);

  const errorOnlyLines = useMemo(() => filterErrorLines(parsedLines), [parsedLines]);
  const taskOutlineLines = useMemo(
    () =>
      parsedLines.filter(
        (l) =>
          l.kind === "play" ||
          l.kind === "task" ||
          l.kind === "result-ok" ||
          l.kind === "result-bad" ||
          (l.kind === "err" && /^(FAILED|UNREACHABLE|fatal:)/i.test(l.stripped)),
      ),
    [parsedLines],
  );

  const visibleLogLines = useMemo(() => {
    if (logView === "errors") return errorOnlyLines;
    if (logView === "tasks") return taskOutlineLines;
    return parsedLines;
  }, [logView, parsedLines, errorOnlyLines, taskOutlineLines]);

  const activeStepFailed = Boolean(
    activeStepRef && isStepFail(activeStepRef.step.state),
  );
  const failureDiag = useMemo<FailureDiag | null>(() => {
    if (!activeStepRef || !activeStepFailed) return null;
    return extractFailureDiag(parsedLines, activeStepRef.step, shownSummary?.app_id);
  }, [activeStepRef, activeStepFailed, parsedLines, shownSummary?.app_id]);

  // Pipe filters
  const pipeCounts = useMemo(() => {
    let running = 0;
    let failed = 0;
    for (const r of pipelineRows) {
      if (isStepLive(r.state)) running++;
      if (isStepFail(r.state) || (effectiveScope === "all" && r.priorFailCount > 0)) {
        failed++;
      }
    }
    return { total: pipelineRows.length, running, failed };
  }, [pipelineRows, effectiveScope]);

  useEffect(() => {
    if (pipeFilter === "failed" && pipeCounts.failed === 0) {
      setPipeFilter("all");
    } else if (pipeFilter === "running" && pipeCounts.running === 0) {
      setPipeFilter("all");
    }
  }, [pipeFilter, pipeCounts.failed, pipeCounts.running]);

  const groupedPhases = useMemo(() => {
    const visible = pipelineRows.filter((r) => {
      if (pipeFilter === "running") return isStepLive(r.state);
      if (pipeFilter === "failed") {
        return (
          isStepFail(r.state) ||
          (effectiveScope === "all" && r.priorFailCount > 0)
        );
      }
      return true;
    });
    const map = new Map<string, PipelineRow[]>();
    for (const r of visible) {
      if (!map.has(r.phase)) map.set(r.phase, []);
      map.get(r.phase)!.push(r);
    }
    const keys = [...map.keys()].sort((a, b) => {
      const ia = PHASE_ORDER.indexOf(a);
      const ib = PHASE_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
    return keys.map((phase) => {
      const rows = map.get(phase)!;
      const done = rows.filter((x) => isStepSettled(x.state)).length;
      const failed = rows.filter((x) => isStepFail(x.state)).length;
      const live = rows.some((x) => isStepLive(x.state));
      return {
        phase,
        rows,
        done,
        failed,
        live,
      };
    });
  }, [pipelineRows, pipeFilter, effectiveScope]);

  // Live Pipeline Event Stream
  const streamEvents = useMemo<StreamEvent[]>(() => {
    const targetRuns = scopedRun ? [scopedRun] : runsChrono;
    const out: StreamEvent[] = [];
    for (const run of targetRuns) {
      const runNum = runNumById.get(run.id) || 1;
      out.push({ id: `batch-${run.id}`, kind: "batch", run, runNum });

      let i = 0;
      while (i < run.steps.length) {
        const phase = phaseOfKey(run.steps[i].key);
        let j = i;
        while (j < run.steps.length && phaseOfKey(run.steps[j].key) === phase) j++;
        const slice = run.steps.slice(i, j);
        out.push({
          id: `ps-${run.id}-${i}`,
          kind: "phase-start",
          phase,
          stepCount: slice.length,
          runNum,
        });

        let passed = 0;
        let failed = false;
        let phaseMs = 0;
        let anyUnfinished = false;
        for (const st of slice) {
          if (st.state === "pending") {
            anyUnfinished = true;
            continue;
          }
          if (st.started || isStepLive(st.state)) {
            out.push({
              id: `st-start-${st.id}`,
              kind: "step",
              evType: "started",
              run,
              runNum,
              step: st,
              ts: fmtClock(st.started || run.created),
              tag: shortStateTag(st.state === "leased" ? "leased" : "running"),
              tagClass: st.state === "leased" ? "leased" : "running",
              detail:
                st.runtime ||
                (st.playbook
                  ? `${st.playbook}${st.hosts?.length ? ` · ${st.hosts.join(", ")}` : ""}`
                  : bi("执行节点已接单启动", "Started by runner")),
              durText: "",
              failed: false,
            });
          }
          if (st.finished || isStepSettled(st.state) || isStepFail(st.state)) {
            const stFail = isStepFail(st.state);
            if (stFail) failed = true;
            else if (isStepSettled(st.state)) passed++;
            const durText = st.started && st.finished ? fmtStepDur(st, 0) : "";
            if (st.started && st.finished) {
              const a = Date.parse(st.started);
              const b = Date.parse(st.finished);
              if (Number.isFinite(a) && Number.isFinite(b) && b >= a) phaseMs += b - a;
            }
            const recap = normRecap(st.recap);
            const recapStr = recap.length
              ? recap
                  .map(
                    (h) =>
                      `${h.host}(ok=${h.ok}${h.changed ? `,chg=${h.changed}` : ""}${h.failed ? `,fail=${h.failed}` : ""}${h.unreachable ? `,unreach=${h.unreachable}` : ""})`,
                  )
                  .join(" ")
              : "";
            const msgParts = [
              st.message || stepStateLabel(st.state),
              typeof st.exit_code === "number" && st.exit_code !== 0
                ? `exit=${st.exit_code}`
                : "",
              recapStr,
            ].filter(Boolean);
            out.push({
              id: `st-end-${st.id}`,
              kind: "step",
              evType: "finished",
              run,
              runNum,
              step: st,
              ts: fmtClock(st.finished || st.returned || run.updated),
              tag: shortStateTag(st.state),
              tagClass: st.state,
              detail: msgParts.join(" · "),
              durText,
              failed: stFail,
            });
          } else {
            anyUnfinished = true;
          }
        }

        if (!anyUnfinished || failed) {
          out.push({
            id: `pe-${run.id}-${i}`,
            kind: "phase-end",
            phase,
            passed,
            total: slice.length,
            failed,
            durText: phaseMs > 0 ? fmtDurMs(phaseMs) : "",
            runNum,
          });
        }
        i = j;
      }
    }
    return out;
  }, [scopedRun, runsChrono, runNumById]);

  const visibleStreamEvents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return streamEvents.filter((ev) => {
      if (streamFilter === "issues") {
        if (ev.kind === "step" && !ev.failed) return false;
        if (ev.kind === "phase-end" && !ev.failed) return false;
      }
      if (!q) return true;
      if (ev.kind === "batch") return true;
      if (ev.kind === "phase-start" || ev.kind === "phase-end") {
        return (
          phaseLabel(ev.phase).toLowerCase().includes(q) ||
          ev.phase.toLowerCase().includes(q)
        );
      }
      return (
        ev.step.key.toLowerCase().includes(q) ||
        ev.step.title.toLowerCase().includes(q) ||
        ev.detail.toLowerCase().includes(q) ||
        (ev.step.hosts || []).some((h) => h.toLowerCase().includes(q))
      );
    });
  }, [streamEvents, streamFilter, search]);

  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || consoleMode !== "log") return [];
    const indices: number[] = [];
    visibleLogLines.forEach((l) => {
      if (l.text.toLowerCase().includes(q)) indices.push(l.num);
    });
    return indices;
  }, [visibleLogLines, search, consoleMode]);

  useEffect(() => {
    setMatchIdx(0);
    setFocusedLine(null);
  }, [search, activeStepRef?.step.id, logView]);

  useEffect(() => {
    setDiagCollapsed(false);
    setLogTailLimit(LOG_WINDOW_STEP);
  }, [activeStepRef?.step.id]);

  const jumpToLineNum = useCallback(
    (lineNum: number) => {
      suppressScrollUntilRef.current = Date.now() + 650;
      setAutoScroll(false);
      setFocusedLine(lineNum);
      if (parsedLines.length > logTailLimit) {
        const needed = parsedLines.length - lineNum + 200;
        if (needed > logTailLimit) {
          setLogTailLimit(Math.min(parsedLines.length, needed));
        }
      }
      const apply = () => {
        const term = termBodyRef.current;
        if (!term) return;
        const el = term.querySelector<HTMLElement>(`[data-line="${lineNum}"]`);
        if (!el) return;
        const delta =
          el.getBoundingClientRect().top - term.getBoundingClientRect().top;
        term.scrollTop = Math.max(
          0,
          term.scrollTop + delta - Math.floor(term.clientHeight * 0.3),
        );
      };
      requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
      });
    },
    [parsedLines.length, logTailLimit],
  );

  const jumpFirstError = useCallback(() => {
    const targetLine =
      failureDiag?.firstErrorLine ||
      parsedLines.find((l) => l.isErr)?.num ||
      null;
    if (!targetLine) return;
    if (logView === "tasks") setLogView("full");
    jumpToLineNum(targetLine);
  }, [failureDiag, parsedLines, logView, jumpToLineNum]);

  const stepMatch = useCallback(
    (delta: number) => {
      if (!searchMatches.length) return;
      const next =
        (matchIdx + delta + searchMatches.length) % searchMatches.length;
      setMatchIdx(next);
      jumpToLineNum(searchMatches[next]);
    },
    [searchMatches, matchIdx, jumpToLineNum],
  );

  useEffect(() => {
    if (!autoScroll || !termBodyRef.current) return;
    const raf = window.requestAnimationFrame(() => {
      if (termBodyRef.current) {
        termBodyRef.current.scrollTop = termBodyRef.current.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [autoScroll, logText, visibleStreamEvents.length, consoleMode, logView]);

  const handleTermScroll = () => {
    if (Date.now() < suppressScrollUntilRef.current) return;
    const el = termBodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (!nearBottom && autoScroll) setAutoScroll(false);
    else if (nearBottom && !autoScroll) setAutoScroll(true);
  };

  // Batch controls
  const runAction = async (r: ExecRun, act: string) => {
    if (busyLockRef.current) return;
    busyLockRef.current = true;
    setBusy(true);
    try {
      await api(
        `/api/jobs/${encodeURIComponent(jobId)}/executions/${encodeURIComponent(r.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            action: act,
            note:
              act === "close"
                ? bi("操作员在执行监控台结束批次", "Closed from execution monitor")
                : "",
          }),
        },
      );
      await Promise.all([loadDetail(), onListRefresh()]);
    } catch (e) {
      err(e);
    } finally {
      busyLockRef.current = false;
      setBusy(false);
    }
  };

  const launchStepFromMonitor = (mode: "single" | "from", stepKey: string) => {
    dispatchExecLaunchIntent({ jobId, mode, stepKey });
    go({
      name: "deliveries",
      id: clusterName,
      tab: "plans",
      plan: jobId,
    });
  };

  // Check & sync component updates (including workspace drafts for verification deliveries!) directly from the Execution Monitor
  const checkAndSyncComponent = async () => {
    if (syncLockRef.current) return;
    syncLockRef.current = true;
    setSyncBusy(true);
    try {
      const res = await api<{
        preview: {
          available: boolean;
          blocked?: string;
          summary?: string;
          files?: string[];
          steps?: string[];
          using_drafts?: string[];
        };
      }>(`/api/jobs/${encodeURIComponent(jobId)}/sync`);
      const pv = res?.preview;
      if (!pv?.available) {
        Message.info(
          pv?.blocked ||
            bi(
              "当前交付已使用最新组件版本；若修改了正式交付的组件，请先在组件工作台发布，或使用「编辑本步脚本」直接热修当前交付。",
              "Already up to date. Publish component changes (or use Step Hotfix for a quick patch on this delivery).",
            ),
        );
        return;
      }
      const isDraftSync = (pv.using_drafts?.length || 0) > 0;
      const resumeStepKey =
        (activeStepFailed ? activeStepRef?.step.key : undefined) ||
        primaryFailedAttempt?.step.key;
      Modal.confirm({
        title: isDraftSync
          ? bi(
              `检测到组件工作区草稿更新（${pv.using_drafts!.join("、")}），是否直接热同步？`,
              `Component draft update (${pv.using_drafts!.join(", ")}) — hot-sync now?`,
            )
          : bi(
              "检测到新的组件修复版本，是否同步到本次交付？",
              "Component fix available — sync to this delivery?",
            ),
        content: (
          <div style={{ lineHeight: 1.7 }}>
            <p style={{ margin: "0 0 8px" }}>
              {isDraftSync
                ? bi(
                    "验证交付支持直接热同步组件工作区草稿（无需提前发布）。同步后会保留已有软件包与历史记录，下次续跑将自动把最新脚本推送到执行节点。",
                    "Verification deliveries can hot-sync workspace drafts directly without publishing. Next resume auto-pushes updated scripts to the execution node.",
                  )
                : bi(
                    "同步会更新本交付的自动化剧本与手册，保留已有软件包与历史记录；下次续跑将自动推送最新脚本到执行节点（免重新预检环境）。",
                    "Updates automation playbooks & runbook while preserving packages and history. Next resume auto-pushes updated scripts without re-running host prep.",
                  )}
            </p>
            {!!pv.files?.length && (
              <p className="faint small" style={{ margin: "0 0 4px" }}>
                {bi(`变更文件（${pv.files.length}）：`, `Changed files (${pv.files.length}): `)}
                {pv.files.slice(0, 6).join("、")}
                {pv.files.length > 6 ? ` …` : ""}
              </p>
            )}
            {!!pv.steps?.length && (
              <p className="faint small" style={{ margin: 0 }}>
                {bi(`受影响步骤（${pv.steps.length}）：`, `Affected steps (${pv.steps.length}): `)}
                {pv.steps.join("、")}
              </p>
            )}
          </div>
        ),
        okText: isDraftSync
          ? bi("热同步草稿并准备续跑", "Hot-Sync Draft")
          : bi("立即同步更新", "Sync Update Now"),
        onOk: async () => {
          if (syncConfirmLockRef.current) return;
          syncConfirmLockRef.current = true;
          try {
            await api(`/api/jobs/${encodeURIComponent(jobId)}/sync`, {
              method: "POST",
            });
            await Promise.all([loadDetail(), onListRefresh()]);
            if (resumeStepKey && can("delivery.execute") && !activeRun) {
              Message.success(
                bi(
                  "组件更新已同步！正在打开续跑确认窗口，启动时将自动推送补丁包…",
                  "Synced! Opening resume dialog (patched scripts will auto-push)…",
                ),
              );
              launchStepFromMonitor("from", resumeStepKey);
            } else {
              Message.success(
                bi(
                  "组件更新已同步！下次续跑将自动推送最新脚本到执行节点。",
                  "Component update synced! Next resume will auto-push updated scripts.",
                ),
              );
            }
          } catch (e) {
            err(e);
          } finally {
            syncConfirmLockRef.current = false;
          }
        },
      });
    } catch (e) {
      err(e);
    } finally {
      syncLockRef.current = false;
      setSyncBusy(false);
    }
  };

  // Metrics & authoritative status
  const doneCount = pipelineRows.filter((r) => isStepSettled(r.state)).length;
  const failCount = pipelineRows.filter((r) => isStepFail(r.state)).length;
  const totalCount = pipelineRows.length;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const headerRun = scopedRun || activeRun || runsNewest[0];
  const runnerNode = data?.nodes.find((n) => n.id === headerRun?.node);
  const runnerOnline = runnerNode
    ? isExecutionNodeOnline(runnerNode)
    : shownSummary?.runner_online;
  const clusterName = shownSummary?.cluster || headerRun?.cluster || shownJobId.slice(0, 12);

  const unresolvedFailCountAll = useMemo(() => {
    let n = 0;
    latestStateByKey.forEach((st) => {
      if (isStepFail(st)) n++;
    });
    return n;
  }, [latestStateByKey]);

  const historicalRetryBatchCount = useMemo(
    () => runsChrono.filter((r) => !!findLaterPassingRun(r)).length,
    [runsChrono, findLaterPassingRun],
  );

  // Authoritative, plain-language main StatusBadge
  const headerBadge = useMemo<{ state: string; label: string }>(() => {
    if (activeRun) {
      return {
        state: activeRun.state === "paused" ? "warn" : "running",
        label: stepStateLabel(activeRun.state),
      };
    }
    if (unresolvedFailCountAll > 0) {
      return {
        state: "failed",
        label: bi(
          `存在 ${unresolvedFailCountAll} 步失败待处理`,
          `${unresolvedFailCountAll} failed`,
        ),
      };
    }
    if (runsNewest[0]?.state === "closed") {
      return { state: "queued", label: bi("已手动结束", "Closed") };
    }
    return { state: "done", label: bi("全部已通过", "All Passed") };
  }, [activeRun, unresolvedFailCountAll, runsNewest]);

  // Plain-language Context Explanation Banner for the currently viewed batch (or delivery failure)
  const contextBanner = useMemo(() => {
    if (scopedRun && scopedRun.state === "failed") {
      const runNum = runNumById.get(scopedRun.id) || 1;
      const failIdx = scopedRun.steps.findIndex((s) => isStepFail(s.state));
      const failStep = failIdx >= 0 ? scopedRun.steps[failIdx] : null;
      const unrunCount = scopedRun.steps.filter((s) => s.state === "pending").length;
      const laterPass = findLaterPassingRun(scopedRun);
      if (laterPass) {
        return {
          tone: "warn" as const,
          runNum,
          failIdx,
          failStep,
          unrunCount,
          laterPass,
        };
      }
      return {
        tone: "bad" as const,
        runNum,
        failIdx,
        failStep,
        unrunCount,
        laterPass: null,
      };
    }
    if (effectiveScope === "all" && !activeRun && primaryFailedAttempt) {
      const r = primaryFailedAttempt.run;
      const failIdx = r.steps.findIndex((s) => s.id === primaryFailedAttempt.step.id);
      const unrunCount = r.steps.filter((s) => s.state === "pending").length;
      return {
        tone: "bad" as const,
        runNum: primaryFailedAttempt.runNum,
        failIdx,
        failStep: primaryFailedAttempt.step,
        unrunCount,
        laterPass: null,
      };
    }
    return null;
  }, [scopedRun, runNumById, findLaterPassingRun, effectiveScope, activeRun, primaryFailedAttempt]);

  const buildPlainStreamText = () =>
    visibleStreamEvents
      .map((ev) => {
        if (ev.kind === "batch") {
          return `=== ${bi(`批次 #${ev.runNum}`, `Batch #${ev.runNum}`)} · ${ev.run.executor_name || ev.run.node} · ${fullTime(ev.run.created)} ===`;
        }
        if (ev.kind === "phase-start") {
          return `>>> ${bi("阶段", "Phase")} [${phaseLabel(ev.phase)}] (${ev.stepCount} ${bi("步", "steps")})`;
        }
        if (ev.kind === "phase-end") {
          return ev.failed
            ? `<<< ${bi("阶段", "Phase")} [${phaseLabel(ev.phase)}] ${bi("失败停止", "STOPPED")} (${ev.passed}/${ev.total}${ev.durText ? ` · ${ev.durText}` : ""})`
            : `<<< ${bi("阶段", "Phase")} [${phaseLabel(ev.phase)}] ${bi("已完成", "COMPLETED")} (${ev.passed}/${ev.total}${ev.durText ? ` · ${ev.durText}` : ""})`;
        }
        return `${ev.ts} ${ev.tag} ${ev.step.key} | ${ev.step.title} -> ${ev.detail}${ev.durText ? ` (${ev.durText})` : ""}`;
      })
      .join("\n");

  const activeMatchLine = searchMatches[matchIdx];
  const stepLogUrl = activeStepRef
    ? `/api/jobs/${encodeURIComponent(shownJobId)}/executions/${encodeURIComponent(activeStepRef.run.id)}/logs/${encodeURIComponent(activeStepRef.step.id)}`
    : "";
  const activeStepRecap = normRecap(activeStepRef?.step.recap);
  const activeStepLaterFixed = Boolean(
    activeStepFailed &&
      activeStepRef &&
      isStepSettled(latestStateByKey.get(activeStepRef.step.key) || ""),
  );

  return (
    <section
      className="mon-main"
      aria-label={bi("实时执行监控工作台", "Execution monitor workspace")}
    >
      {/* Top Mission Control Header */}
      <header className="mon-header">
        <div
          className={`mon-progress-line ${switching ? "is-switching" : activeRun ? "is-live" : unresolvedFailCountAll > 0 ? "is-failed" : ""}`}
        >
          <i style={{ width: switching ? "100%" : `${pct}%` }} />
        </div>
        <div className="mon-header-top">
          <div className="mon-header-left">
            <Tooltip
              content={
                railHidden
                  ? bi("展开集群列表", "Show cluster list")
                  : bi("收起集群列表，放大日志区域", "Hide cluster list for wider console")
              }
              mini
            >
              <Button
                size="small"
                icon={
                  <IconMenuFold
                    style={{
                      transform: railHidden ? "rotate(180deg)" : undefined,
                      transition: "transform 0.2s var(--spring)",
                    }}
                  />
                }
                onClick={onToggleRail}
                aria-label={bi("切换集群列表", "Toggle cluster list")}
              />
            </Tooltip>

            <div key={`head-${shownJobId}`} className="mon-title-block mon-swap-in">
              <div className="mon-title-row">
                <h1 className="mon-cluster-title">{clusterName}</h1>
                <StatusBadge
                  state={headerBadge.state}
                  label={headerBadge.label}
                />
              </div>
              <div className="mon-meta-row">
                {shownSummary?.app_name && (
                  <span>
                    {shownSummary.app_name}
                    {shownSummary.version ? ` ${shownSummary.version}` : ""}
                  </span>
                )}
                {headerRun && (
                  <span
                    className={`mon-runner-inline ${runnerOnline ? "online" : ""}`}
                  >
                    <i aria-hidden />
                    <span>
                      {headerRun.executor_name ||
                        runnerNode?.name ||
                        bi("执行节点", "Runner")}
                    </span>
                    {headerRun.executor_ip && <code>{headerRun.executor_ip}</code>}
                    <span>
                      ({runnerOnline ? bi("在线", "Online") : bi("离线", "Offline")})
                    </span>
                  </span>
                )}
                {!activeRun &&
                  unresolvedFailCountAll === 0 &&
                  historicalRetryBatchCount > 0 && (
                    <span>
                      {bi(
                        `共 ${runsNewest.length} 批（其中 ${historicalRetryBatchCount} 批曾中断，后续已重跑通过）`,
                        `${runsNewest.length} runs (${historicalRetryBatchCount} earlier interrupted, re-run passed)`,
                      )}
                    </span>
                  )}
                {(data?.patches?.length || 0) > 0 && (
                  <span style={{ color: "var(--brand-ink)", fontWeight: 560 }}>
                    {bi(
                      `· 本交付已热修 ${new Set(data!.patches!.map((p) => p.path)).size} 个脚本（续跑自动推送）`,
                      `· ${new Set(data!.patches!.map((p) => p.path)).size} hotfixed (auto-pushed)`,
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="mon-header-right">
            {activeRun && (
              <span className="mon-live-sync-tag">
                <IconLoading spin />
                {bi("实时流同步中", "Live streaming")}
              </span>
            )}

            <AIDiagnoseButton
              step={
                activeStepFailed
                  ? activeStepRef?.step
                  : primaryFailedAttempt?.step
              }
              runNum={
                activeStepFailed
                  ? activeStepRef?.runNum
                  : primaryFailedAttempt?.runNum
              }
              diag={
                activeStepFailed && failureDiag
                  ? failureDiag
                  : primaryFailedAttempt
                    ? extractFailureDiag(
                        [],
                        primaryFailedAttempt.step,
                        shownSummary?.app_id,
                      )
                    : undefined
              }
              logText={activeStepFailed ? logText : undefined}
              clusterName={clusterName}
              label={
                unresolvedFailCountAll > 0 || activeStepFailed
                  ? bi("AI 一键诊断", "AI Diagnose")
                  : bi("AI 助手", "AI Assistant")
              }
              size="small"
            />

            {can("delivery.create") &&
              (unresolvedFailCountAll > 0 || activeStepFailed) && (
                <Button
                  size="small"
                  loading={syncBusy}
                  icon={<IconSync />}
                  onClick={checkAndSyncComponent}
                >
                  {bi("同步组件更新", "Sync Fix")}
                </Button>
              )}

            {activeRun && can("delivery.execute") && (
              <>
                {activeRun.state === "paused" ? (
                  <Button
                    size="small"
                    type="primary"
                    loading={busy}
                    icon={<IconPlayArrow />}
                    onClick={() => runAction(activeRun, "resume")}
                  >
                    {bi("继续执行", "Resume")}
                  </Button>
                ) : (
                  <Button
                    size="small"
                    loading={busy}
                    disabled={activeRun.pause || activeRun.state === "unknown"}
                    icon={<IconPause />}
                    onClick={() => runAction(activeRun, "pause")}
                  >
                    {activeRun.pause
                      ? bi("当前步后暂停", "Pausing…")
                      : bi("暂停后续", "Pause")}
                  </Button>
                )}
                {!activeRun.steps.some((s) => isStepLive(s.state)) && (
                  <Button
                    size="small"
                    status="danger"
                    loading={busy}
                    icon={<IconRecordStop />}
                    onClick={() => runAction(activeRun, "close")}
                  >
                    {bi("结束批次", "Close")}
                  </Button>
                )}
              </>
            )}

            <Button
              size="small"
              icon={<IconRefresh />}
              onClick={() => {
                void loadDetail();
                void onListRefresh();
                if (consoleMode === "log") void reloadLog();
              }}
            >
              {bi("刷新", "Refresh")}
            </Button>

            <Button
              size="small"
              type="outline"
              icon={<IconLaunch />}
              onClick={() =>
                go({
                  name: "deliveries",
                  id: clusterName,
                  tab: "plans",
                  plan: jobId,
                })
              }
            >
              {bi("交付手册", "Runbook")}
            </Button>
          </div>
        </div>

        {/* Batch Switcher Strip */}
        {runsNewest.length > 0 && (
          <div className="mon-subbar">
            <div
              className="mon-scope-pills"
              role="tablist"
              aria-label={bi("执行批次切换", "Execution batches")}
            >
              <button
                type="button"
                role="tab"
                aria-selected={effectiveScope === "all"}
                className={`mon-scope-pill ${effectiveScope === "all" ? "on" : ""}`}
                onClick={() => selectScope("all")}
              >
                <span>{bi("全流程汇总", "All Batches")}</span>
                <span className="mon-pill-num">
                  {bi(`共 ${runsNewest.length} 批`, `${runsNewest.length}`)}
                </span>
              </button>
              {runsChrono.map((r) => {
                const num = runNumById.get(r.id) || 1;
                const laterPass = findLaterPassingRun(r);
                const live = isActiveRun(r);
                const phases = Array.from(
                  new Set(r.steps.map((s) => phaseLabel(phaseOfKey(s.key)))),
                );
                const label = phases.slice(0, 2).join("/");
                const dotState = live
                  ? r.state
                  : laterPass
                    ? "interrupted-fixed"
                    : r.state;
                return (
                  <button
                    key={r.id}
                    type="button"
                    role="tab"
                    aria-selected={effectiveScope === r.id}
                    className={`mon-scope-pill ${effectiveScope === r.id ? "on" : ""} ${laterPass ? "is-interrupted" : r.state === "failed" ? "is-failed" : ""}`}
                    onClick={() => selectScope(r.id)}
                    title={
                      laterPass
                        ? bi(
                            `第 ${num} 批曾失败停止，后续已在第 #${laterPass.runNum} 批重跑通过 · ${fullTime(r.created)}`,
                            `Batch #${num} failed earlier; later passed in #${laterPass.runNum}`,
                          )
                        : `${bi(`第 ${num} 批`, `Batch #${num}`)} · ${fullTime(r.created)}`
                    }
                  >
                    <span className={`mon-dot ${dotState}`} aria-hidden />
                    <span className="mon-pill-num">#{num}</span>
                    <span>{label}</span>
                    {live && (
                      <em className="mon-pill-tag live">
                        {bi("运行中", "Live")}
                      </em>
                    )}
                    {laterPass && (
                      <em className="mon-pill-tag warn">
                        {bi("曾中断 · 已重跑", "Retried")}
                      </em>
                    )}
                    {!laterPass && r.state === "failed" && (
                      <em className="mon-pill-tag bad">
                        {bi("失败停止", "Failed")}
                      </em>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="mon-kpis">
              <span className="mon-kpi ok">
                {bi("通过", "Passed")}
                <b>
                  {doneCount}/{totalCount}
                </b>
              </span>
              {failCount > 0 && (
                <span className="mon-kpi bad">
                  {bi("失败", "Failed")}
                  <b>{failCount}</b>
                </span>
              )}
              <LiveTotalDur
                scopedRun={scopedRun}
                runsChrono={runsChrono}
                active={Boolean(activeRun)}
              />
            </div>
          </div>
        )}
      </header>

      {/* Plain-Language Batch Context Banner (hidden when already inspecting that failed step's console to avoid stacked red banners) */}
      {contextBanner &&
        !(
          contextBanner.tone === "bad" &&
          consoleMode === "log" &&
          activeStepFailed &&
          (!contextBanner.failStep ||
            activeStepRef?.step.id === contextBanner.failStep.id)
        ) && (
        <div
          className={`mon-context-banner ${contextBanner.tone}`}
          role="status"
        >
          <div className="mon-context-text">
            {contextBanner.tone === "warn" ? (
              <IconInfoCircle />
            ) : (
              <IconExclamationCircleFill />
            )}
            <span>
              {contextBanner.laterPass ? (
                <>
                  <b>{bi(`历史批次 #${contextBanner.runNum}：`, `Batch #${contextBanner.runNum}: `)}</b>
                  {bi(
                    `在第 ${contextBanner.failIdx + 1} 步失败停止，后续 ${contextBanner.unrunCount} 步未在此批执行（平台默认失败即止）；已在 #${contextBanner.laterPass.runNum} 批重跑通过。`,
                    `Stopped at step ${contextBanner.failIdx + 1} (${contextBanner.unrunCount} remaining steps did not run); retried and passed in batch #${contextBanner.laterPass.runNum}.`,
                  )}
                </>
              ) : (
                <>
                  <b>{bi(`第 #${contextBanner.runNum} 批失败停止：`, `Batch #${contextBanner.runNum} halted: `)}</b>
                  {bi(
                    `在第 ${contextBanner.failIdx + 1} 步「${contextBanner.failStep?.title || ""}」失败${contextBanner.unrunCount > 0 ? `，后续 ${contextBanner.unrunCount} 步暂停未执行（平台默认失败即止，不会自动跳过）` : ""}，修复后可在手册续跑。`,
                    `Failed at step ${contextBanner.failIdx + 1} "${contextBanner.failStep?.title || ""}"${contextBanner.unrunCount > 0 ? ` (${contextBanner.unrunCount} remaining steps halted — fail-fast)` : ""}. Fix and resume in Runbook.`,
                  )}
                </>
              )}
            </span>
          </div>
          <div className="mon-context-acts">
            {contextBanner.laterPass ? (
              <>
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    const nextRun = contextBanner.laterPass!.run;
                    if (!activeRun || nextRun.id !== activeRun.id) {
                      setFollowLive(false);
                    }
                    setScope(nextRun.id);
                    const matching =
                      contextBanner.failStep &&
                      nextRun.steps.find(
                        (s) => s.key === contextBanner.failStep!.key,
                      );
                    if (matching) {
                      setSelectedRef({
                        runId: nextRun.id,
                        stepId: matching.id,
                        stepKey: matching.key,
                      });
                    }
                  }}
                >
                  {bi(
                    `切换到 #${contextBanner.laterPass.runNum} 查看通过记录`,
                    `Switch to #${contextBanner.laterPass.runNum}`,
                  )}
                </Button>
                <Button size="small" onClick={() => selectScope("all")}>
                  {bi("看全流程汇总", "All Batches")}
                </Button>
              </>
            ) : (
              <>
                {contextBanner.failStep && (
                  <Button
                    size="small"
                    status="danger"
                    onClick={() => {
                      const targetRun =
                        scopedRun || primaryFailedAttempt?.run;
                      if (!targetRun || !contextBanner.failStep) return;
                      setSelectedRef({
                        runId: targetRun.id,
                        stepId: contextBanner.failStep.id,
                        stepKey: contextBanner.failStep.key,
                      });
                      setConsoleMode("log");
                    }}
                  >
                    {bi("查看失败步骤与诊断", "Inspect Failed Step")}
                  </Button>
                )}
                {contextBanner.failStep && can("delivery.run") && (
                  <Button
                    size="small"
                    icon={<IconCode />}
                    onClick={() =>
                      setHotfixStep({
                        key: contextBanner.failStep!.key,
                        title: contextBanner.failStep!.title,
                      })
                    }
                  >
                    {bi("编辑失败步脚本", "Hotfix Step")}
                  </Button>
                )}
                {contextBanner.failStep && !activeRun && can("delivery.execute") ? (
                  <Button
                    size="small"
                    type="primary"
                    icon={<IconPlayArrow />}
                    onClick={() =>
                      launchStepFromMonitor("from", contextBanner.failStep!.key)
                    }
                  >
                    {bi("从此步续跑", "Resume From Here")}
                  </Button>
                ) : (
                  <Button
                    size="small"
                    onClick={() =>
                      go({
                        name: "deliveries",
                        id: clusterName,
                        tab: "plans",
                        plan: jobId,
                      })
                    }
                  >
                    {bi("前往手册续跑", "Resume in Runbook")}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Main Content */}
      {loadErr && !data ? (
        <div className="mon-empty-canvas">
          <IconExclamationCircleFill
            style={{ fontSize: 30, color: "var(--bad)" }}
          />
          <h2>{bi("读取执行状态失败", "Failed to load execution telemetry")}</h2>
          <p>{loadErr}</p>
          <Button type="primary" onClick={loadDetail}>
            {bi("重试", "Retry")}
          </Button>
        </div>
      ) : !data ? (
        <div className="mon-empty-canvas">
          <IconLoading spin style={{ fontSize: 26, color: "var(--brand)" }} />
          <p>{bi("正在加载自动化执行数据…", "Loading execution telemetry…")}</p>
        </div>
      ) : runsNewest.length === 0 ? (
        <div className="mon-empty-canvas">
          <div className="mon-empty-icon">
            <IconThunderbolt />
          </div>
          <h2>{bi("该交付尚未启动自动执行", "No Automated Runs Yet")}</h2>
          <p>
            {bi(
              "前往交付手册点击「选择自动执行步骤」授权后，将自动进入此实时监控台。",
              "Launch an automated batch from the delivery runbook to monitor execution live here.",
            )}
          </p>
          <Button
            type="primary"
            onClick={() =>
              go({
                name: "deliveries",
                id: clusterName,
                tab: "plans",
                plan: jobId,
              })
            }
          >
            {bi("打开交付手册", "Open Runbook")}
          </Button>
        </div>
      ) : (
        <div className="mon-workspace" ref={workspaceRef}>
          {/* Left Pane: Phase-Grouped Step Pipeline (collapsible) */}
          <aside
            className={`mon-pipeline ${pipeHidden ? "collapsed" : ""}`}
            aria-label={bi("步骤执行流水线", "Step execution pipeline")}
          >
            <div className="mon-pipe-bar">
              <Segmented<"all" | "running" | "failed">
                size="sm"
                label={bi("筛选步骤", "Filter steps")}
                value={pipeFilter}
                onChange={setPipeFilter}
                options={[
                  { value: "all", label: bi("全部", "All"), count: pipeCounts.total },
                  ...(pipeCounts.running > 0
                    ? [
                        {
                          value: "running" as const,
                          label: bi("进行中", "Live"),
                          count: pipeCounts.running,
                        },
                      ]
                    : []),
                  ...(pipeCounts.failed > 0
                    ? [
                        {
                          value: "failed" as const,
                          label: bi("异常", "Issues"),
                          count: pipeCounts.failed,
                        },
                      ]
                    : []),
                ]}
              />

              {activeRun && (
                <Button
                  size="small"
                  type={followLive ? "primary" : "secondary"}
                  onClick={() => setFollowLive((v) => !v)}
                >
                  {followLive ? bi("跟随中", "Following") : bi("跟随", "Follow")}
                </Button>
              )}
            </div>

            {liveRunningRef && !followLive && (
              <button
                type="button"
                className="mon-live-banner"
                onClick={() => {
                  setFollowLive(true);
                  setSelectedRef({
                    runId: liveRunningRef.run.id,
                    stepId: liveRunningRef.step.id,
                    stepKey: liveRunningRef.step.key,
                  });
                  setConsoleMode("log");
                }}
              >
                <span>
                  <IconLoading spin />
                  {bi("正在执行：", "Running: ")}
                  {liveRunningRef.step.title}
                </span>
                <em>{bi("跟随 →", "Follow →")}</em>
              </button>
            )}

            <div className="mon-pipe-scroll">
              <div key={`pipe-${shownJobId}`} className="mon-swap-in">
                {groupedPhases.map((grp) => {
                const isCollapsed = !!collapsedPhases[grp.phase];
                const fracCls = grp.live
                  ? "run"
                  : grp.failed > 0
                    ? "bad"
                    : grp.done === grp.rows.length
                      ? "ok"
                      : "";
                return (
                  <div className="mon-phase" key={grp.phase}>
                    <button
                      type="button"
                      className="mon-phase-head"
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsedPhases((p) => ({
                          ...p,
                          [grp.phase]: !p[grp.phase],
                        }))
                      }
                    >
                      <span className="mon-phase-left">
                        <IconRight
                          className={`mon-phase-chev ${isCollapsed ? "" : "open"}`}
                        />
                        <span>{phaseLabel(grp.phase)}</span>
                      </span>
                      <span className="mon-phase-right">
                        <LivePhaseDur rows={grp.rows} live={grp.live} />
                        <span className={`mon-phase-frac ${fracCls}`}>
                          {grp.done}/{grp.rows.length}
                        </span>
                      </span>
                    </button>

                    {!isCollapsed && (
                      <div className="mon-phase-steps">
                        {grp.rows.map((row) => {
                          const isSel =
                            consoleMode === "log" &&
                            (scopedRun
                              ? activeStepRef?.run.id === row.run.id &&
                                activeStepRef?.step.id === row.step.id
                              : activeStepRef?.step.key === row.key);
                          const live = isStepLive(row.state);
                          const fail = isStepFail(row.state);
                          const hadPriorFail =
                            effectiveScope === "all" &&
                            !fail &&
                            row.priorFailCount > 0;
                          return (
                            <button
                              key={`${row.run.id}-${row.step.id}`}
                              type="button"
                              className={`mon-step-row ${row.state} ${isSel ? "on" : ""} ${live ? "is-running" : ""} ${fail ? "is-failed" : ""}`}
                              onClick={() => {
                                setFollowLive(false);
                                setSelectedRef({
                                  runId: row.run.id,
                                  stepId: row.step.id,
                                  stepKey: row.key,
                                });
                                setConsoleMode("log");
                              }}
                            >
                              <StepGlyph state={row.state} />
                              <div className="mon-step-body">
                                <div className="mon-step-title-line">
                                  <span className="mon-step-title">{row.title}</span>
                                  <LiveStepDur
                                    step={row.step}
                                    className="mon-step-dur"
                                  />
                                </div>
                                <div className="mon-step-sub">
                                  <span className="mon-step-key" title={row.key}>
                                    {row.key}
                                  </span>
                                  {row.haltedAfterFailure && (
                                    <span className="mon-step-tag muted">
                                      {bi("前序失败 · 未执行", "Halted after failure")}
                                    </span>
                                  )}
                                  {hadPriorFail && (
                                    <span className="mon-step-tag warn">
                                      {bi(
                                        `曾失败 ${row.priorFailCount} 次`,
                                        `${row.priorFailCount} prior fail`,
                                      )}
                                    </span>
                                  )}
                                  {!row.haltedAfterFailure &&
                                    !hadPriorFail &&
                                    effectiveScope === "all" &&
                                    row.attempts.length > 1 && (
                                      <span className="mon-step-tag muted num">
                                        {bi(
                                          `共 ${row.attempts.length} 次`,
                                          `${row.attempts.length} runs`,
                                        )}
                                      </span>
                                    )}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              </div>
            </div>
          </aside>

          {!pipeHidden && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={bi("调整步骤栏宽度", "Resize pipeline pane")}
              title={bi("拖动调整宽度 · 双击还原默认", "Drag to resize · Double-click to reset")}
              className={`mon-pipe-resizer ${resizingPipe ? "is-dragging" : ""}`}
              onPointerDown={startPipeResize}
              onDoubleClick={() =>
                workspaceRef.current?.style.removeProperty("--mon-pipe-w")
              }
            />
          )}

          {/* Right Pane: Dual-Mode Live Console & Failure Diagnostics */}
          <div className="mon-console-pane">
            {/* Single-Row Console Mode & Compact Tools Bar */}
            <div className="mon-console-bar">
              <div className="mon-console-bar-left">
                <Tooltip
                  content={
                    pipeHidden
                      ? bi("展开步骤目录", "Show step pipeline")
                      : bi("收起步骤目录", "Hide step pipeline")
                  }
                  mini
                >
                  <Button
                    size="small"
                    icon={<IconList />}
                    type={pipeHidden ? "primary" : "secondary"}
                    onClick={() => setPipeHidden((v) => !v)}
                  >
                    {pipeHidden ? bi("步骤", "Steps") : undefined}
                  </Button>
                </Tooltip>

                <Segmented<"stream" | "log">
                  size="sm"
                  label={bi("监控视图模式", "Console view mode")}
                  value={consoleMode}
                  onChange={setConsoleMode}
                  options={[
                    {
                      value: "stream",
                      label: bi("事件流", "Stream"),
                    },
                    {
                      value: "log",
                      label: bi("终端日志", "Console"),
                    },
                  ]}
                />

                {consoleMode === "log" && (
                  <Segmented<LogViewMode>
                    size="sm"
                    label={bi("日志筛选模式", "Log view filter")}
                    value={logView}
                    onChange={setLogView}
                    options={[
                      { value: "full", label: bi("完整", "Full") },
                      {
                        value: "errors",
                        label: bi("仅报错", "Errors"),
                        count: errorOnlyLines.length > 0 ? errorOnlyLines.length : undefined,
                      },
                      {
                        value: "tasks",
                        label: bi("大纲", "Tasks"),
                        count: taskOutlineLines.length > 0 ? taskOutlineLines.length : undefined,
                      },
                    ]}
                  />
                )}
              </div>

              <div className="mon-console-tools">
                <Input
                  size="small"
                  className="mon-log-search"
                  prefix={<IconSearch />}
                  allowClear
                  value={search}
                  onChange={setSearch}
                  onPressEnter={() => consoleMode === "log" && stepMatch(1)}
                  placeholder={
                    consoleMode === "stream"
                      ? bi("筛选事件…", "Filter…")
                      : bi("搜索日志…", "Find…")
                  }
                />

                {consoleMode === "log" && search.trim() && (
                  <span className="mon-match-nav">
                    <span>
                      {searchMatches.length > 0
                        ? `${matchIdx + 1}/${searchMatches.length}`
                        : "0/0"}
                    </span>
                    <Button
                      size="mini"
                      icon={<IconArrowUp />}
                      disabled={!searchMatches.length}
                      onClick={() => stepMatch(-1)}
                    />
                    <Button
                      size="mini"
                      icon={<IconArrowDown />}
                      disabled={!searchMatches.length}
                      onClick={() => stepMatch(1)}
                    />
                  </span>
                )}

                {consoleMode === "stream" && (
                  <Button
                    size="small"
                    type={streamFilter === "issues" ? "primary" : "secondary"}
                    status={streamFilter === "issues" ? "danger" : undefined}
                    onClick={() =>
                      setStreamFilter((v) => (v === "all" ? "issues" : "all"))
                    }
                  >
                    {bi("仅异常", "Issues")}
                  </Button>
                )}

                {consoleMode === "log" && (
                  <Tooltip
                    content={
                      wrapLines
                        ? bi("自动换行：开", "Line wrap: On")
                        : bi("自动换行：关", "Line wrap: Off")
                    }
                    mini
                  >
                    <Button
                      size="small"
                      type={wrapLines ? "outline" : "secondary"}
                      icon={<IconAlignLeft />}
                      onClick={() => setWrapLines((v) => !v)}
                      aria-label={bi("自动换行", "Wrap lines")}
                    />
                  </Tooltip>
                )}

                <Tooltip
                  content={
                    autoScroll
                      ? bi("自动滚底：开", "Auto-scroll: On")
                      : bi("自动滚底：关", "Auto-scroll: Off")
                  }
                  mini
                >
                  <Button
                    size="small"
                    type={autoScroll ? "outline" : "secondary"}
                    icon={<IconToBottom />}
                    onClick={() => setAutoScroll((v) => !v)}
                    aria-label={bi("自动滚底", "Auto-scroll")}
                  />
                </Tooltip>

                <Tooltip
                  content={copied ? bi("已复制", "Copied") : bi("复制日志", "Copy")}
                  mini
                >
                  <Button
                    size="small"
                    icon={copied ? <IconCheck /> : <IconCopy />}
                    disabled={
                      consoleMode === "log"
                        ? !logText
                        : visibleStreamEvents.length === 0
                    }
                    onClick={() => {
                      copy(
                        consoleMode === "log" ? logText : buildPlainStreamText(),
                      );
                      setCopied(true);
                      if (copyTimerRef.current) {
                        window.clearTimeout(copyTimerRef.current);
                      }
                      copyTimerRef.current = window.setTimeout(
                        () => setCopied(false),
                        1400,
                      );
                    }}
                    aria-label={bi("复制", "Copy")}
                  />
                </Tooltip>

                {consoleMode === "log" &&
                  activeStepRef &&
                  activeStepRef.step.seq > 0 && (
                    <Tooltip content={bi("下载日志文件", "Download log")} mini>
                      <Button
                        size="small"
                        icon={<IconDownload />}
                        href={withLang(stepLogUrl)}
                        download={`execution-${activeStepRef.step.id}.log`}
                        aria-label={bi("下载", "Download")}
                      />
                    </Tooltip>
                  )}
              </div>
            </div>

            {/* Streamlined Step Header & Collapsible Failure Card (Step Console Mode) */}
            {consoleMode === "log" && activeStepRef && (
              <div className="mon-step-diag">
                <div className="mon-diag-title-row">
                  <div className="mon-diag-title-left">
                    <h3>{activeStepRef.step.title}</h3>
                    <StatusBadge
                      state={
                        isStepLive(activeStepRef.step.state)
                          ? "running"
                          : activeStepFailed
                            ? "failed"
                            : isStepSettled(activeStepRef.step.state)
                              ? "done"
                              : "queued"
                      }
                      label={
                        typeof activeStepRef.step.exit_code === "number" &&
                        activeStepRef.step.exit_code !== 0
                          ? `${stepStateLabel(activeStepRef.step.state)} · exit ${activeStepRef.step.exit_code}`
                          : stepStateLabel(activeStepRef.step.state)
                      }
                    />
                    {activeStepLaterFixed && (
                      <StatusBadge
                        state="warn"
                        label={bi("后续已重跑通过", "Later passed")}
                      />
                    )}
                  </div>

                  <div className="mon-diag-title-right">
                    <span className="mon-diag-quick num">
                      {bi(`第 #${activeStepRef.runNum} 批`, `Batch #${activeStepRef.runNum}`)}
                      <LiveStepDur step={activeStepRef.step} prefix=" · " />
                    </span>
                    <Button
                      size="mini"
                      type="secondary"
                      icon={<IconCode />}
                      onClick={() =>
                        setHotfixStep({
                          key: activeStepRef.step.key,
                          title: activeStepRef.step.title,
                        })
                      }
                    >
                      {can("delivery.run")
                        ? bi("编辑本步脚本", "Edit Script")
                        : bi("查看脚本", "View Script")}
                    </Button>
                    {!activeRun && can("delivery.execute") && (
                      <>
                        <Tooltip
                          content={bi(
                            "仅重新执行当前这一步（自动推送最新脚本，已完成高风险步需二次确认）",
                            "Re-run only this step",
                          )}
                          mini
                        >
                          <Button
                            size="mini"
                            type="outline"
                            icon={<IconPlayArrow />}
                            onClick={() =>
                              launchStepFromMonitor(
                                "single",
                                activeStepRef.step.key,
                              )
                            }
                          >
                            {bi("仅重跑此步", "Retry Step")}
                          </Button>
                        </Tooltip>
                        <Tooltip
                          content={bi(
                            "从此步骤起按序继续执行本阶段后续步骤（自动推送热修/同步补丁）",
                            "Resume from this step onward",
                          )}
                          mini
                        >
                          <Button
                            size="mini"
                            type="primary"
                            icon={<IconPlayArrow />}
                            onClick={() =>
                              launchStepFromMonitor(
                                "from",
                                activeStepRef.step.key,
                              )
                            }
                          >
                            {bi("从此步续跑", "Resume From Here")}
                          </Button>
                        </Tooltip>
                      </>
                    )}
                    <Popover
                      trigger="click"
                      position="tr"
                      triggerProps={{ autoFitPosition: true }}
                      content={
                        <div className="mon-step-info-pop">
                          <div>
                            <label>{bi("步骤标识", "Step key")}</label>
                            <code className="mono">{activeStepRef.step.key}</code>
                          </div>
                          {activeStepRef.step.playbook && (
                            <div>
                              <label>{bi("执行剧本", "Playbook")}</label>
                              <code className="mono">{activeStepRef.step.playbook}</code>
                            </div>
                          )}
                          {activeStepRef.step.started && (
                            <div>
                              <label>{bi("开始时间", "Started")}</label>
                              <span>{fullTime(activeStepRef.step.started)}</span>
                            </div>
                          )}
                          <div>
                            <label>{bi("交付快照", "Snapshot")}</label>
                            <code className="mono">{activeStepRef.run.snapshot.slice(0, 12)}</code>
                          </div>
                          {(activeStepRef.run.patched_files?.length || 0) > 0 && (
                            <div>
                              <label>{bi("自动推送热修", "Pushed hotfixes")}</label>
                              <code className="mono">
                                {activeStepRef.run.patched_files!.join(", ")}
                              </code>
                            </div>
                          )}
                        </div>
                      }
                    >
                      <Button
                        size="mini"
                        type="text"
                        icon={<IconInfoCircle />}
                        className="mon-info-btn"
                      >
                        {bi("详情", "Info")}
                      </Button>
                    </Popover>
                  </div>
                </div>

                {showActiveStepAttemptPills && (
                  <div className="mon-attempt-bar">
                    <span className="mon-attempt-label">
                      {bi("执行尝试", "Attempts")}
                    </span>
                    <div className="mon-attempt-inline">
                      {activeStepAttempts.map((att, idx) => {
                        const on = att.step.id === activeStepRef.step.id;
                        return (
                          <button
                            key={att.step.id}
                            type="button"
                            className={`mon-attempt-pill ${on ? "on" : ""}`}
                            title={bi(
                              `第 #${att.runNum} 批 · 该步骤第 ${idx + 1} 次执行（${stepStateLabel(att.step.state)}）`,
                              `Batch #${att.runNum} · Attempt ${idx + 1} (${stepStateLabel(att.step.state)})`,
                            )}
                            onClick={() => {
                              setFollowLive(false);
                              if (effectiveScope !== "all") {
                                setScope(att.run.id);
                              }
                              setSelectedRef({
                                runId: att.run.id,
                                stepId: att.step.id,
                                stepKey: att.step.key,
                              });
                            }}
                          >
                            <span
                              className={`mon-dot ${att.step.state}`}
                              aria-hidden
                            />
                            <span>#{att.runNum}</span>
                            <span className="faint">
                              {bi(`第${idx + 1}次`, `Run ${idx + 1}`)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Compact Host Recap Strip */}
                {activeStepRecap.length > 0 && (
                  <div className="mon-recap-row">
                    <span className="mon-recap-label">
                      {bi("主机汇总", "Host recap")}
                    </span>
                    <div className="mon-recap-chips">
                      {activeStepRecap.map((h) => {
                        const bad = h.failed > 0 || h.unreachable > 0;
                        return (
                          <span
                            key={h.host}
                            className={`mon-recap-chip ${bad ? "bad" : ""}`}
                          >
                            <b>{h.host}</b>
                            <span className="rc-ok">ok={h.ok}</span>
                            {h.changed > 0 && (
                              <span className="rc-chg">chg={h.changed}</span>
                            )}
                            {h.skipped > 0 && <span>skip={h.skipped}</span>}
                            {h.failed > 0 && (
                              <span className="rc-bad">fail={h.failed}</span>
                            )}
                            {h.unreachable > 0 && (
                              <span className="rc-bad">
                                unreach={h.unreachable}
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Concise Collapsible Failure Root-Cause & Rainbow-Glow AI Remediation Card */}
                {activeStepFailed && failureDiag && (
                  <div className={`mon-fail-card ${diagCollapsed ? "is-collapsed" : ""}`} role="alert">
                    <div className="mon-fail-head">
                      <div className="mon-fail-head-left">
                        <span className="mon-fail-headline">
                          <IconExclamationCircleFill />
                          <span>{bi("故障归因", "Failure")}</span>
                        </span>
                        <span className="mon-fail-cat">
                          {failureDiag.category === "env"
                            ? bi("目标环境问题", "Host / Env")
                            : bi("组件剧本问题", "Component Playbook")}
                        </span>
                        <span className="mon-fail-inline-meta">
                          <b>{failureDiag.componentLabel}</b>
                          {failureDiag.failedTask && (
                            <span>· {failureDiag.failedTask}</span>
                          )}
                          {failureDiag.failedHosts.length > 0 && (
                            <code className="mono">
                              {failureDiag.failedHosts.join(", ")}
                            </code>
                          )}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="mon-fail-toggle"
                        onClick={() => setDiagCollapsed((v) => !v)}
                        aria-expanded={!diagCollapsed}
                      >
                        <span>
                          {diagCollapsed
                            ? bi("展开摘要", "Expand")
                            : bi("收起", "Hide")}
                        </span>
                        <IconDown
                          style={{
                            transform: diagCollapsed ? undefined : "rotate(180deg)",
                            transition: "transform 0.2s var(--spring)",
                          }}
                        />
                      </button>
                    </div>

                    {!diagCollapsed && (
                      <>
                        <div className="mon-fail-msg-box">
                          {failureDiag.errorDetail}
                        </div>

                        <div className="mon-fail-foot">
                          <div className="mon-fail-acts">
                            <AIDiagnoseButton
                              step={activeStepRef.step}
                              runNum={activeStepRef.runNum}
                              diag={failureDiag}
                              logText={logText}
                              clusterName={clusterName}
                              label={bi("AI 一键诊断", "AI Diagnose")}
                              size="small"
                            />
                            {can("delivery.run") && (
                              <Button
                                size="small"
                                type="outline"
                                icon={<IconCode />}
                                onClick={() =>
                                  setHotfixStep({
                                    key: activeStepRef.step.key,
                                    title: activeStepRef.step.title,
                                  })
                                }
                              >
                                {bi("直接热修本步脚本", "Hotfix Step Script")}
                              </Button>
                            )}
                            {can("component.edit") && (
                              <Button
                                size="small"
                                icon={<IconEdit />}
                                onClick={() =>
                                  openComponentWorkbenchWithAI(
                                    failureDiag.componentId,
                                    clusterName,
                                    activeStepRef.step,
                                    failureDiag,
                                  )
                                }
                              >
                                {bi(
                                  "在组件工作台修复",
                                  "Fix in Workbench",
                                )}
                              </Button>
                            )}
                            {can("delivery.create") && (
                              <Button
                                size="small"
                                loading={syncBusy}
                                icon={<IconSync />}
                                onClick={checkAndSyncComponent}
                              >
                                {bi("同步组件/草稿更新", "Sync Component Fix")}
                              </Button>
                            )}
                            {failureDiag.firstErrorLine && (
                              <Button
                                size="small"
                                type="text"
                                onClick={jumpFirstError}
                              >
                                {bi("定位报错行", "Jump to Error")}
                              </Button>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Terminal / Live Stream Surface */}
            <div className="mon-term-wrap">
              <div className="mon-term-head">
                <div className="mon-term-head-left">
                  {((consoleMode === "stream" && activeRun) ||
                    (consoleMode === "log" &&
                      activeStepRef &&
                      isStepLive(activeStepRef.step.state))) && (
                    <span className="mon-live-pill">
                      <i aria-hidden />
                      LIVE
                    </span>
                  )}
                  <span className="mono">
                    {consoleMode === "stream"
                      ? scopedRun
                        ? bi(
                            `${clusterName} · 第 #${runNumById.get(scopedRun.id) || 1} 批实时事件流`,
                            `${clusterName} · Batch #${runNumById.get(scopedRun.id) || 1} Stream`,
                          )
                        : bi(
                            `${clusterName} · 全流程事件流（共 ${runsNewest.length} 批）`,
                            `${clusterName} · Full Pipeline Stream (${runsNewest.length} runs)`,
                          )
                      : activeStepRef
                        ? `${activeStepRef.step.key} · ${activeStepRef.run.executor_name || "runner"}`
                        : "console"}
                  </span>
                </div>
                <span className="mon-term-stats">
                  {consoleMode === "stream"
                    ? bi(
                        `${visibleStreamEvents.length} 条事件 · 点击任意步骤行查看完整日志`,
                        `${visibleStreamEvents.length} events · click any step line for log`,
                      )
                    : logView === "tasks"
                      ? bi(
                          `${visibleLogLines.length} 个任务节点 · 点击任意行跳转完整日志`,
                          `${visibleLogLines.length} tasks · click any row to jump`,
                        )
                      : `${visibleLogLines.length} / ${parsedLines.length} ${bi("行", "lines")}${logBytes > 0 ? ` · ${fmtBytes(logBytes)}` : ""}`}
                </span>
              </div>

              <div
                ref={termBodyRef}
                className={`mon-term-body ${wrapLines ? "wrap" : ""}`}
                onScroll={handleTermScroll}
              >
                <div key={`term-${shownJobId}`} className="mon-swap-in">
                {consoleMode === "stream" ? (
                  visibleStreamEvents.length === 0 ? (
                    <div className="mon-term-empty">
                      <b>{bi("没有匹配的事件", "No matching events")}</b>
                      <span>
                        {bi(
                          "当前没有异常或匹配关键字的流事件。",
                          "No stream events match the current filter.",
                        )}
                      </span>
                      {streamFilter === "issues" && (
                        <Button
                          size="small"
                          type="primary"
                          onClick={() => setStreamFilter("all")}
                        >
                          {bi("显示全部事件", "Show all events")}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <>
                      {visibleStreamEvents.map((ev, idx) => {
                        const lineNo = idx + 1;
                        if (ev.kind === "batch") {
                          const laterPass = findLaterPassingRun(ev.run);
                          return (
                            <div key={ev.id} className="mon-ev mon-ev-batch">
                              <span className="mon-ln">{lineNo}</span>
                              <span className="mon-ev-body">
                                <span>
                                  ═══{" "}
                                  {bi(`批次 #${ev.runNum}`, `Batch #${ev.runNum}`)}{" "}
                                  · {ev.run.executor_name || ev.run.node}
                                  {ev.run.executor_ip
                                    ? ` (${ev.run.executor_ip})`
                                    : ""}{" "}
                                  · {fullTime(ev.run.created)} ·{" "}
                                  {bi("快照", "snapshot")}{" "}
                                  {ev.run.snapshot.slice(0, 12)} ·{" "}
                                  {laterPass
                                    ? bi(
                                        `曾失败停止（已在 #${laterPass.runNum} 重跑通过）`,
                                        `failed earlier (passed in #${laterPass.runNum})`,
                                      )
                                    : stepStateLabel(ev.run.state)}{" "}
                                  ═══
                                </span>
                              </span>
                            </div>
                          );
                        }
                        if (ev.kind === "phase-start") {
                          return (
                            <div
                              key={ev.id}
                              className="mon-ev mon-ev-phase-start"
                            >
                              <span className="mon-ln">{lineNo}</span>
                              <span className="mon-ev-body">
                                &gt;&gt;&gt; {bi("阶段", "Phase")} [
                                {phaseLabel(ev.phase)}]:{" "}
                                {bi(`${ev.stepCount} 个步骤`, `${ev.stepCount} steps`)}
                              </span>
                            </div>
                          );
                        }
                        if (ev.kind === "phase-end") {
                          return (
                            <div
                              key={ev.id}
                              className={`mon-ev ${ev.failed ? "mon-ev-phase-fail" : "mon-ev-phase-done"}`}
                            >
                              <span className="mon-ln">{lineNo}</span>
                              <span className="mon-ev-body">
                                &lt;&lt;&lt; {bi("阶段", "Phase")} [
                                {phaseLabel(ev.phase)}]{" "}
                                {ev.failed
                                  ? bi(
                                      `失败停止 (${ev.passed}/${ev.total} 通过，后续未执行)`,
                                      `HALTED (${ev.passed}/${ev.total} passed)`,
                                    )
                                  : bi(
                                      `已完成 (${ev.passed}/${ev.total} 步)`,
                                      `COMPLETED (${ev.passed}/${ev.total} steps)`,
                                    )}
                                {ev.durText && (
                                  <span className="mon-ev-dur">
                                    · {ev.durText}
                                  </span>
                                )}
                              </span>
                            </div>
                          );
                        }
                        const isSel =
                          activeStepRef?.run.id === ev.run.id &&
                          activeStepRef?.step.id === ev.step.id;
                        return (
                          <div
                            key={ev.id}
                            className={`mon-ev clickable ${ev.failed ? "ev-fail" : ""} ${isSel ? "is-selected" : ""}`}
                            onClick={() => {
                              setFollowLive(false);
                              setSelectedRef({
                                runId: ev.run.id,
                                stepId: ev.step.id,
                                stepKey: ev.step.key,
                              });
                              setConsoleMode("log");
                            }}
                          >
                            <span className="mon-ln">{lineNo}</span>
                            <span className="mon-ev-body">
                              {ev.ts && (
                                <span className="mon-ev-ts">{ev.ts}</span>
                              )}
                              <span className={`mon-ev-tag ${ev.tagClass}`}>
                                {ev.tag}
                              </span>
                              <span className="mon-ev-key">
                                {renderHighlightedText(
                                  ev.step.key,
                                  search.trim(),
                                )}
                              </span>
                              <span className="mon-ev-sep">|</span>
                              <span className="mon-ev-title">
                                {renderHighlightedText(
                                  ev.step.title,
                                  search.trim(),
                                )}
                              </span>
                              <span className="mon-ev-arrow">-&gt;</span>
                              <span className="mon-ev-detail">
                                {renderHighlightedText(ev.detail, search.trim())}
                              </span>
                              {ev.durText ? (
                                <span className="mon-ev-dur">({ev.durText})</span>
                              ) : ev.evType === "started" &&
                                isStepLive(ev.step.state) ? (
                                <LiveStepDur
                                  step={ev.step}
                                  wrapParen
                                  className="mon-ev-dur"
                                />
                              ) : null}
                              <span className="mon-ev-jump">
                                {bi("查看日志 →", "View log →")}
                              </span>
                            </span>
                          </div>
                        );
                      })}
                      {activeRun && (
                        <div className="mon-stream-live-foot">
                          <IconLoading spin />
                          <span>
                            {liveRunningRef
                              ? bi(
                                  `正在实时执行：${liveRunningRef.step.title}（${liveRunningRef.step.key}）…`,
                                  `Executing live: ${liveRunningRef.step.title} (${liveRunningRef.step.key})…`,
                                )
                              : bi(
                                  "等待执行节点回传下一个事件…",
                                  "Waiting for next runner event…",
                                )}
                          </span>
                        </div>
                      )}
                    </>
                  )
                ) : !activeStepRef ? (
                  <div className="mon-term-empty">
                    <b>{bi("从左侧选择一个步骤", "Select a step on the left")}</b>
                    <span>
                      {bi(
                        "即可查看实时 Ansible 终端日志与主机汇总。",
                        "Inspect live Ansible stdout/stderr and host recap here.",
                      )}
                    </span>
                  </div>
                ) : logErr ? (
                  <div className="mon-term-empty">
                    <b>{bi("日志加载失败", "Failed to load log")}</b>
                    <span>{logErr}</span>
                  </div>
                ) : activeStepRef.step.seq === 0 && !logText ? (
                  <div className="mon-term-empty">
                    {isStepLive(activeStepRef.step.state) ? (
                      <>
                        <IconLoading spin style={{ fontSize: 22 }} />
                        <b>
                          {bi(
                            "执行节点已接单，等待首个终端输出…",
                            "Authorized — waiting for first output…",
                          )}
                        </b>
                        <span>
                          {bi(
                            "日志将在命令产生输出后自动实时滚动显示。",
                            "Lines will stream live as soon as Ansible outputs them.",
                          )}
                        </span>
                      </>
                    ) : activeStepRef.step.state === "pending" ? (
                      <>
                        <b>
                          {bi(
                            `该步骤在第 #${activeStepRef.runNum} 批中未执行`,
                            `Step did not run in batch #${activeStepRef.runNum}`,
                          )}
                        </b>
                        <span>
                          {bi(
                            "因本批次前序步骤失败，平台按「失败即止」原则自动停止了后续步骤。",
                            "An earlier step in this batch failed, so remaining steps were halted automatically.",
                          )}
                        </span>
                        {activeStepAttempts.some(
                          (a) => a.step.id !== activeStepRef.step.id && a.step.seq > 0,
                        ) && (
                          <Button
                            size="small"
                            type="primary"
                            onClick={() => {
                              const executed = [...activeStepAttempts]
                                .reverse()
                                .find((a) => a.step.seq > 0);
                              if (!executed) return;
                              setFollowLive(false);
                              if (effectiveScope !== "all") setScope(executed.run.id);
                              setSelectedRef({
                                runId: executed.run.id,
                                stepId: executed.step.id,
                                stepKey: executed.step.key,
                              });
                            }}
                          >
                            {bi("查看后续已执行的批次日志", "Jump to executed batch log")}
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        <b>{bi("该步骤无原始终端日志", "No terminal output recorded")}</b>
                        <span>{activeStepRef.step.message || ""}</span>
                      </>
                    )}
                  </div>
                ) : logLoading && !logText ? (
                  <div className="mon-term-empty">
                    <IconLoading spin style={{ fontSize: 22 }} />
                    <span>{bi("正在载入完整终端日志…", "Loading terminal log…")}</span>
                  </div>
                ) : visibleLogLines.length === 0 ? (
                  <div className="mon-term-empty">
                    {logView === "errors" ? (
                      <>
                        <IconCheckCircleFill
                          style={{ fontSize: 24, color: "#4ade80" }}
                        />
                        <b>
                          {bi(
                            "本步骤日志中无报错记录",
                            "No errors found in this step log",
                          )}
                        </b>
                        <span>
                          {bi(
                            "所有任务均正常执行，没有出现 FAILED / fatal / unreachable 报错。",
                            "All tasks executed cleanly without FAILED, fatal, or unreachable errors.",
                          )}
                        </span>
                        <div className="row-gap" style={{ marginTop: 6 }}>
                          <Button
                            size="small"
                            type="primary"
                            onClick={() => setLogView("full")}
                          >
                            {bi("查看完整日志", "View Full Log")}
                          </Button>
                          <Button
                            size="small"
                            onClick={() => setLogView("tasks")}
                          >
                            {bi("查看任务大纲", "View Task Outline")}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <b>{bi("当前视图暂无内容", "No matching lines")}</b>
                        <Button
                          size="small"
                          onClick={() => setLogView("full")}
                        >
                          {bi("切换回完整日志", "Back to Full Log")}
                        </Button>
                      </>
                    )}
                  </div>
                ) : (
                  (() => {
                    const q = search.trim();
                    const isTaskOutline = logView === "tasks";
                    const canWindow =
                      logView === "full" &&
                      !q &&
                      visibleLogLines.length > logTailLimit;
                    const hiddenCount = canWindow
                      ? visibleLogLines.length - logTailLimit
                      : 0;
                    const renderedLines = canWindow
                      ? visibleLogLines.slice(hiddenCount)
                      : visibleLogLines;
                    return (
                      <>
                        {hiddenCount > 0 && (
                          <div className="mon-log-window-bar">
                            <span>
                              {bi(
                                `已折叠较早的 ${hiddenCount.toLocaleString()} 行以保持 60fps 流畅滚动（共 ${visibleLogLines.length.toLocaleString()} 行）`,
                                `Collapsed ${hiddenCount.toLocaleString()} earlier lines for 60fps performance (${visibleLogLines.length.toLocaleString()} total)`,
                              )}
                            </span>
                            <span className="mon-log-window-acts">
                              <button
                                type="button"
                                className="mon-log-window-btn"
                                onClick={() =>
                                  setLogTailLimit((prev) =>
                                    Math.min(
                                      visibleLogLines.length,
                                      prev + LOG_WINDOW_STEP,
                                    ),
                                  )
                                }
                              >
                                {bi(
                                  `加载前 ${Math.min(hiddenCount, LOG_WINDOW_STEP).toLocaleString()} 行`,
                                  `Load ${Math.min(hiddenCount, LOG_WINDOW_STEP).toLocaleString()} earlier`,
                                )}
                              </button>
                              <button
                                type="button"
                                className="mon-log-window-btn"
                                onClick={() =>
                                  setLogTailLimit(visibleLogLines.length)
                                }
                              >
                                {bi("显示全部", "Show all")}
                              </button>
                            </span>
                          </div>
                        )}
                        <MemoLogLines
                          lines={renderedLines}
                          query={q}
                          searchMatches={searchMatches}
                          activeMatchLine={activeMatchLine}
                          focusedLine={focusedLine}
                          isTaskOutline={isTaskOutline}
                          onSelectTaskLine={(lineNum) => {
                            setLogView("full");
                            jumpToLineNum(lineNum);
                          }}
                        />
                      </>
                    );
                  })()
                )}
                </div>
              </div>

              {!autoScroll && (
                <button
                  type="button"
                  className="mon-scroll-bottom"
                  onClick={() => {
                    setAutoScroll(true);
                    if (termBodyRef.current) {
                      termBodyRef.current.scrollTop =
                        termBodyRef.current.scrollHeight;
                    }
                  }}
                >
                  <IconArrowDown />
                  <span>{bi("滚至最新", "Jump to latest")}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <StepHotfixDrawer
        open={!!hotfixStep}
        jobId={jobId}
        stepKey={hotfixStep?.key}
        stepTitle={hotfixStep?.title}
        deliveryMode={shownSummary?.delivery_mode || "automatic"}
        onClose={() => setHotfixStep(null)}
        onPatched={() => {
          void loadDetail();
          void onListRefresh();
        }}
        onLaunchStep={(mode, key) => launchStepFromMonitor(mode, key)}
      />
    </section>
  );
}

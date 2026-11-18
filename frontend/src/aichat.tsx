import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Input,
  Message,
  Modal,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowDown,
  IconCheck,
  IconCheckCircle,
  IconClose,
  IconCode,
  IconDown,
  IconCopy,
  IconDelete,
  IconDownload,
  IconExpand,
  IconFile,
  IconImage,
  IconMinus,
  IconQuestionCircle,
  IconSafe,
  IconHistory,
  IconMessage,
  IconPlus,
  IconSearch,
  IconUp,
  IconRecordStop,
  IconRefresh,
  IconSend,
  IconShrink,
} from "@arco-design/web-react/icon";
import { reportDoc, useSubmitKB } from "./kb";
import { go } from "./router";
import { bi, getLang, useLang, withLang } from "./i18n";
import {
  ago,
  api,
  can,
  copy,
  csrfToken,
  err,
  fullTime,
  useAIStatus,
  useConnectivity,
} from "./shared";
import type { AIStatus } from "./shared";
export { useAIStatus } from "./shared";
export type { AIStatus } from "./shared";
import { CodeBlock, Markdown } from "./aimd";
import { Process } from "./aiwork";
import { ModelPicker, useModelPick } from "./modelpick";
import { ToolMenu, useAIOptions } from "./aitools";
import type { Step } from "./aiwork";
export type { Step } from "./aiwork";
export { Process, stepLabel, fmtDur } from "./aiwork";
import "./aichat.css";

export type AIAttemptDiag = {
  endpoint: string;
  api: string;
  http_status?: number;
  ms: number;
  response_id?: string;
  upstream_status?: string;
  reason?: string;
  in_tokens?: number;
  out_tokens?: number;
  cached_tokens?: number;
  sse_events?: string[];
  keepalives?: number;
  request_note?: string;
};

export type AICallDiag = {
  provider?: string;
  model?: string;
  api?: string;
  endpoint?: string;
  http_status?: number;
  reason_code?:
    | "empty_output"
    | "http_error"
    | "sse_error"
    | "incomplete"
    | "network_error"
    | "timeout"
    | string;
  response_id?: string;
  upstream_status?: string;
  ms?: number;
  in_tokens?: number;
  out_tokens?: number;
  cached_tokens?: number;
  sse_events?: string[];
  keepalives?: number;
  request_summary?: string;
  response_raw?: string;
  fallback_used?: string;
  attempts?: AIAttemptDiag[];
};

export type ChatStreamError = Error & { diag?: AICallDiag };

const REASON_LABELS: Record<string, string> = {
  get empty_output() {
    return bi("空输出 (empty_output)", "Empty output (empty_output)");
  },
  get http_error() {
    return bi("HTTP 错误 (http_error)", "HTTP error (http_error)");
  },
  get sse_error() {
    return bi("流式事件异常 (sse_error)", "SSE stream error (sse_error)");
  },
  get incomplete() {
    return bi("输出未完成 (incomplete)", "Incomplete output (incomplete)");
  },
  get invalid_output() {
    return bi(
      "结构化输出不完整 (invalid_output)",
      "Invalid structured output (invalid_output)",
    );
  },
  get network_error() {
    return bi("网络连接异常 (network_error)", "Network error (network_error)");
  },
  get timeout() {
    return bi("请求超时 (timeout)", "Request timeout (timeout)");
  },
};

export const reasonCodeLabel = (code?: string) =>
  !code ? "" : REASON_LABELS[code] || code;

export function prettyDiagPayload(raw?: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function formatAICallDiag(
  diag?: AICallDiag | null,
  meta?: {
    title?: string;
    provider?: string;
    model?: string;
    testedAt?: string;
    warn?: string;
    error?: string;
    callId?: string;
    httpStatus?: number;
    responseId?: string;
    endpoint?: string;
    ms?: number;
  },
): string {
  const lines: string[] = [];
  if (meta?.title) lines.push(bi(`【${meta.title}】`, `[${meta.title}]`));
  if (meta?.callId)
    lines.push(bi(`调用编号: ${meta.callId}`, `Call ID: ${meta.callId}`));
  const prov = meta?.provider || diag?.provider;
  const mod = meta?.model || diag?.model;
  if (prov || mod)
    lines.push(
      bi(
        `模型: ${[prov, mod].filter(Boolean).join(" / ")}`,
        `Model: ${[prov, mod].filter(Boolean).join(" / ")}`,
      ),
    );
  if (meta?.testedAt)
    lines.push(bi(`时间: ${meta.testedAt}`, `Time: ${meta.testedAt}`));
  if (meta?.warn)
    lines.push(bi(`兼容告警: ${meta.warn}`, `Compatibility warning: ${meta.warn}`));
  if (meta?.error)
    lines.push(bi(`错误信息: ${meta.error}`, `Error: ${meta.error}`));
  const ep = diag?.endpoint || meta?.endpoint;
  if (ep) lines.push(bi(`协议端点: ${ep}`, `Endpoint: ${ep}`));
  if (diag?.api) lines.push(bi(`接口方式: ${diag.api}`, `API mode: ${diag.api}`));
  if (diag?.fallback_used)
    lines.push(
      bi(`协议回退: ${diag.fallback_used}`, `Fallback: ${diag.fallback_used}`),
    );
  const st = diag?.http_status ?? meta?.httpStatus;
  if (st != null || diag?.upstream_status || diag?.reason_code) {
    const parts = [
      st != null
        ? st > 0
          ? `HTTP ${st}`
          : bi("网络未连通", "Network unreachable")
        : "",
      diag?.upstream_status
        ? bi(`上游状态=${diag.upstream_status}`, `upstream=${diag.upstream_status}`)
        : "",
      diag?.reason_code
        ? bi(
            `原因=${reasonCodeLabel(diag.reason_code)}`,
            `reason=${reasonCodeLabel(diag.reason_code)}`,
          )
        : "",
    ].filter(Boolean);
    if (parts.length)
      lines.push(bi(`状态: ${parts.join(" · ")}`, `Status: ${parts.join(" · ")}`));
  }
  const rid = diag?.response_id || meta?.responseId;
  if (rid) lines.push(bi(`响应 ID: ${rid}`, `Response ID: ${rid}`));
  const latency = diag?.ms ?? meta?.ms;
  if (latency != null)
    lines.push(bi(`耗时: ${latency} ms`, `Latency: ${latency} ms`));
  if (
    diag?.in_tokens != null ||
    diag?.out_tokens != null ||
    diag?.cached_tokens != null
  ) {
    lines.push(
      bi(
        `Token: 输入 ${diag?.in_tokens ?? 0} / 缓存 ${diag?.cached_tokens ?? 0} / 输出 ${diag?.out_tokens ?? 0}`,
        `Tokens: in ${diag?.in_tokens ?? 0} / cached ${diag?.cached_tokens ?? 0} / out ${diag?.out_tokens ?? 0}`,
      ),
    );
  }
  if (diag?.sse_events?.length) {
    lines.push(
      bi(
        `SSE 事件: ${diag.sse_events.join(" -> ")}${diag.keepalives ? ` (心跳 ${diag.keepalives})` : ""}`,
        `SSE events: ${diag.sse_events.join(" -> ")}${diag.keepalives ? ` (keepalives ${diag.keepalives})` : ""}`,
      ),
    );
  }
  if (diag?.attempts?.length) {
    lines.push(bi("尝试链路:", "Attempt trace:"));
    diag.attempts.forEach((a, idx) => {
      const segs = [
        `  #${idx + 1}`,
        `[${a.api}]`,
        a.endpoint,
        a.http_status
          ? `HTTP ${a.http_status}`
          : bi("连接失败", "Connection failed"),
        `${a.ms} ms`,
        a.in_tokens != null || a.out_tokens != null
          ? `in=${a.in_tokens ?? 0}${a.cached_tokens ? `/cache=${a.cached_tokens}` : ""}/out=${a.out_tokens ?? 0}`
          : "",
        a.upstream_status ? `status=${a.upstream_status}` : "",
        a.response_id ? `id=${a.response_id}` : "",
        a.reason || a.request_note || "",
      ].filter(Boolean);
      lines.push(segs.join(" · "));
    });
  }
  if (diag?.request_summary) {
    lines.push(
      bi(
        `请求参数摘要:\n${prettyDiagPayload(diag.request_summary)}`,
        `Request summary:\n${prettyDiagPayload(diag.request_summary)}`,
      ),
    );
  }
  if (diag?.response_raw) {
    lines.push(
      bi(
        `网关原始响应:\n${prettyDiagPayload(diag.response_raw)}`,
        `Gateway raw response:\n${prettyDiagPayload(diag.response_raw)}`,
      ),
    );
  }
  return lines.join("\n");
}

/* The assistant, as a chat window that floats over the page instead of covering it: the runbook stays usable while you
   talk. One window per page; it holds several conversations (the review of a delivery, and one per runbook step, or the
   component being edited) and switches between them. */

export type AskQuestion = {
  question: string;
  options?: { label: string; description?: string }[];
  multi?: boolean;
};
export type Ask = { questions: AskQuestion[] };
export type MsgFile = {
  id: string;
  name: string;
  mime?: string;
  size?: number;
};
export type Msg = {
  form?: {
    target_component?: string;
    summary?: string;
    blocking?: number;
    deployment?: unknown;
    changes?: unknown[];
  };
  role: "user" | "assistant";
  text: string;
  images?: string[];
  files?: MsgFile[];
  ask?: Ask;
  tools?: string[];
  steps?: Step[];
  ms?: number;
  proposals?: string[];
  at?: string;
  by?: string;
};
export type StepProposal = {
  kind?: string;
  id: string;
  status: string;
  phase: string;
  after_title?: string;
  step: {
    title: string;
    desc?: string;
    command: string;
    effect: string;
    hosts: string[];
    expect?: string;
    rollback?: string;
  };
  reason: string;
  warnings?: string[];
  decided_by?: string;
  /** The change to one file of the delivery's project, when kind is "file". */
  file?: { path: string; diff?: string; new?: boolean };
};
type CompProposal = {
  id: string;
  summary: string;
  files: { path: string; op: string; diff?: string }[];
  warnings?: string[];
  trial?: string;
  status: string;
  decided_by?: string;
};
type SessionInfo = {
  key: string;
  title: string;
  kind: string;
  updated: string;
  running?: boolean;
};
export type AIReport = {
  session: string;
  kind: string;
  key: string;
  title: string;
  symptom: string;
  evidence?: string;
  cause: string;
  fix: string;
  changed: boolean;
  followups?: string[];
  model?: string;
  at: string;
  by: string;
  /** The copy in the writer's own knowledge base. */
  kb_id?: string;
  kb_title?: string;
};

/** What a conversation is about. key is "review", "step:<runbook key>" or "comp". */
export type AITarget = {
  key: string;
  title: string;
  context?: string;
  step?: Record<string, unknown>;
  hello?: string;
  suggestions?: string[];
  prefill?: string;
};
type Scope =
  | { kind: "job"; jobId: string }
  | { kind: "comp"; name: string; beforeSend?: () => Promise<unknown> };

const PHASE: Record<string, string> = {
  get prepare() {
    return bi("环境准备", "Environment setup");
  },
  get deploy() {
    return bi("部署", "Deploy");
  },
  get tests() {
    return bi("功能测试", "Functional tests");
  },
  get endpoint() {
    return bi("入口测试", "Endpoint tests");
  },
  get cleanup() {
    return bi("清理", "Cleanup");
  },
};
const EFFECT: Record<string, string> = {
  get "read-only"() {
    return bi("只读", "Read-only");
  },
  get change() {
    return bi("修改", "Modify");
  },
  get disruptive() {
    return bi("会中断服务", "Disruptive");
  },
  get destructive() {
    return bi("不可撤销", "Destructive");
  },
};
const OP: Record<string, string> = {
  get add() {
    return bi("新增", "Add");
  },
  get change() {
    return bi("修改", "Modify");
  },
  get delete() {
    return bi("删除", "Delete");
  },
};
const TOOL: Record<string, string> = {
  get list_deliveries() {
    return bi("交付列表", "Deliveries");
  },
  get delivery_info() {
    return bi("交付概况", "Delivery overview");
  },
  get runbook() {
    return bi("执行手册", "Runbook");
  },
  get execution_record() {
    return bi("执行记录", "Execution record");
  },
  get list_files() {
    return bi("项目文件列表", "Project file list");
  },
  get read_file() {
    return bi("项目文件", "Project file");
  },
  get propose_step() {
    return bi("步骤提案", "Step proposal");
  },
  get propose_change() {
    return bi("修改提案", "Change proposal");
  },
  get component_guide() {
    return bi("设计指南", "Design guide");
  },
  get list_components() {
    return bi("现有组件", "Components");
  },
  get example_component() {
    return bi("参考组件", "Reference component");
  },
  get draft_files() {
    return bi("草稿文件列表", "Draft file list");
  },
  get draft_read() {
    return bi("草稿文件", "Draft file");
  },
  get run_check() {
    return bi("平台检查", "Platform check");
  },
  get propose_files() {
    return bi("改动提案", "File proposal");
  },
};
const DOING: Record<string, string> = {
  get list_deliveries() {
    return bi("查看你的交付", "Listing deliveries");
  },
  get delivery_info() {
    return bi("查看交付概况", "Checking delivery overview");
  },
  get runbook() {
    return bi("阅读执行手册", "Reading runbook");
  },
  get execution_record() {
    return bi("查看执行记录", "Reading execution record");
  },
  get list_files() {
    return bi("浏览项目文件", "Browsing project files");
  },
  get read_file() {
    return bi("读取项目文件", "Reading project file");
  },
  get propose_step() {
    return bi("整理步骤提案，平台校验中", "Validating step proposal");
  },
  get propose_change() {
    return bi("整理修改提案，平台校验中", "Validating change proposal");
  },
  get component_guide() {
    return bi("查阅设计指南", "Reading design guide");
  },
  get list_components() {
    return bi("查看现有组件", "Listing components");
  },
  get example_component() {
    return bi("参考现有组件", "Checking reference component");
  },
  get draft_files() {
    return bi("查看草稿", "Listing draft files");
  },
  get draft_read() {
    return bi("读取草稿文件", "Reading draft file");
  },
  get run_check() {
    return bi("运行平台检查", "Running platform check");
  },
  get propose_files() {
    return bi(
      "提交改动，平台检查与试生成中",
      "Submitting changes & running dry-run check",
    );
  },
};

/** A conversation about the whole delivery (as many as people start), not about one step. */
export const isGeneral = (key: string) =>
  key === "review" || key.startsWith("review:");
const newGeneral = () => `review:${Math.random().toString(36).slice(2, 10)}`;

const featureOf = (key: string) =>
  isGeneral(key) ? "review" : key === "comp" ? "component" : "troubleshoot";

/* ---------------------------------------------------------------- dock */

type Dock = {
  open: (t?: AITarget) => void;
  available: (key: string) => boolean;
  /** Steps the window aside (a bar at the bottom) so the page under it can be seen; the conversation goes on. */
  minimize: () => void;
};
const DockCtx = createContext<Dock | null>(null);
/** Opens the page's assistant on a conversation. Null outside a page that has one. */
export const useAIDock = () => useContext(DockCtx);

/** Tells the parts of a delivery page that read the record to read it again (an accepted proposal, a write-up). */
export const AI_CHANGED = "mh-ai-changed";

export function AIDock({
  scope,
  start,
  hidden = false,
  onChanged,
  children,
}: {
  scope: Scope;
  start: AITarget;
  hidden?: boolean;
  onChanged?: () => void;
  children: React.ReactNode;
}) {
  useLang();
  const status = useAIStatus();
  // closed: only the launcher shows (an open conversation keeps running behind it); min: a bar at the bottom
  const [mode, setMode] = useState<"closed" | "open" | "min">("closed");
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const setOpen = useCallback((v: boolean | ((o: boolean) => boolean)) => {
    setMode((m) => {
      const next = typeof v === "function" ? v(m === "open") : v;
      return next ? "open" : "closed";
    });
    setMounted(true);
  }, []);
  const id = scope.kind === "job" ? scope.jobId : scope.name;
  const [target, setTarget] = useState<AITarget>(start);
  const prevIdRef = useRef(id);
  useEffect(() => {
    if (prevIdRef.current !== id) {
      prevIdRef.current = id;
      setTarget(start);
    }
  }, [id, start]);
  // at the foot of a long page the button shrinks to its mark, so it does not sit on the last lines
  const [atEnd, setAtEnd] = useState(false);
  useEffect(() => {
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | Document;
      const el = (
        t instanceof Document ? document.scrollingElement : t
      ) as HTMLElement | null;
      if (!el || el.scrollHeight <= el.clientHeight + 80) return;
      setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 80);
    };
    window.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      window.removeEventListener("scroll", onScroll, { capture: true });
  }, []);
  const available = useCallback(
    (key: string) =>
      !hidden &&
      status.enabled &&
      can("ai.use") &&
      !!status.features[featureOf(key)],
    [hidden, status],
  );
  const any =
    !hidden &&
    (scope.kind === "comp"
      ? available("comp")
      : available("review") || available("step:x"));
  useEffect(() => {
    if (hidden || !status.enabled || !any) {
      setMode("closed");
    }
  }, [hidden, status.enabled, any]);
  const dock = useMemo<Dock>(
    () => ({
      available,
      open: (t) => {
        // the page's own starting conversation keeps its context line when opened from a button
        if (t)
          setTarget(
            t.key === start.key
              ? { ...start, ...t, context: t.context || start.context }
              : t,
          );
        setOpen(true);
      },
      minimize: () => setMode((m) => (m === "open" ? "min" : m)),
    }),
    [available, start, setOpen],
  );
  // opened from the button or the keyboard: a conversation about the whole delivery, not the step someone asked about last
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const openGeneral = useCallback(() => {
    if (!busyRef.current) setTarget(start);
    setOpen(true);
  }, [start, setOpen]);
  // the page can step the window aside (to show what the assistant did) or bring it back
  useEffect(() => {
    const h = (e: Event) => {
      const v = (e as CustomEvent<string>).detail;
      if (v === "min") setMode((m) => (m === "open" ? "min" : m));
      if (v === "open") setOpen(true);
    };
    window.addEventListener("mh-ai-dock", h);
    return () => window.removeEventListener("mh-ai-dock", h);
  }, [setOpen]);
  // ⌘J / Ctrl+J opens and closes the window from anywhere on the page
  useEffect(() => {
    if (!any) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [any, setOpen]);
  const changed = useCallback(() => {
    if (scope.kind === "job")
      window.dispatchEvent(
        new CustomEvent(AI_CHANGED, { detail: scope.jobId }),
      );
    onChanged?.();
  }, [scope, onChanged]);
  return (
    <DockCtx.Provider value={dock}>
      {children}
      {any && mode === "closed" && (
        <button
          type="button"
          className={`ad-launch ${busy ? "busy" : ""} ${atEnd && !busy ? "mini" : ""}`}
          onClick={() => setOpen(true)}
          aria-label={bi("打开 AI 助手（Ctrl+J）", "Open AI Assistant (Ctrl+J)")}
        >
          <Spark rainbow />
          <span>
            {busy
              ? bi("AI 正在回答…", "AI is replying…")
              : bi("AI 助手", "AI Assistant")}
          </span>
          {!busy && <kbd>⌘J</kbd>}
        </button>
      )}
      {any && mounted && (
        <WindowBoundary onClose={() => setOpen(false)}>
          <ChatWindow
            key={id}
            scope={scope}
            start={start}
            target={target}
            setTarget={setTarget}
            expanded={expanded}
            setExpanded={setExpanded}
            mode={mode}
            setMode={setMode}
            onBusy={setBusy}
            onClose={() => setOpen(false)}
            onChanged={changed}
            available={available}
          />
        </WindowBoundary>
      )}
    </DockCtx.Provider>
  );
}

type HistoryItem = {
  id: string;
  at: string;
  label: string;
  title: string;
  messages: number;
  accepted: number;
};

/** The conversations that came before the current draft: what the assistant was asked and why it changed what it
 *  changed, kept after the draft was published or dropped. Read-only. */
function CompHistory({
  open,
  close,
  base,
}: {
  open: boolean;
  close: () => void;
  base: string;
}) {
  useLang();
  const [list, setList] = useState<HistoryItem[] | null>(null);
  const [pick, setPick] = useState("");
  const [detail, setDetail] = useState<{
    messages: Msg[];
    proposals: (StepProposal | CompProposal)[];
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    setPick("");
    setDetail(null);
    api<{ history: HistoryItem[] }>(`${base}/history`)
      .then((r) => setList(r.history))
      .catch(() => setList([]));
  }, [open, base]);
  useEffect(() => {
    if (!pick) return setDetail(null);
    api<{ messages: Msg[]; proposals: CompProposal[] }>(
      `${base}/history/${pick}`,
    )
      .then((r) =>
        setDetail({
          messages: r.messages || [],
          // an old proposal still waiting can no longer be decided here
          proposals: (r.proposals || []).map((p) =>
            p.status === "pending" ? { ...p, status: "withdrawn" } : p,
          ),
        }),
      )
      .catch(() => setDetail({ messages: [], proposals: [] }));
  }, [pick, base]);
  const props = Object.fromEntries(
    (detail?.proposals || []).map((p) => [p.id, p]),
  );
  return (
    <Drawer
      width={Math.min(760, window.innerWidth)}
      visible={open}
      onCancel={close}
      title={
        pick
          ? bi("以前的对话", "Previous conversation")
          : bi("这个组件以前的对话", "Past conversations for this component")
      }
      footer={null}
      className="ad-hist"
    >
      {!pick ? (
        list === null ? null : list.length === 0 ? (
          <p className="faint">
            {bi(
              "还没有。发布修订、放弃草稿或清空对话时，当时的对话会存在这里。",
              "None yet. Conversations are archived here when you publish, discard a draft, or clear chat.",
            )}
          </p>
        ) : (
          <ul className="ad-hist-list">
            {list.map((h) => (
              <li key={h.id}>
                <button type="button" onClick={() => setPick(h.id)}>
                  <b>{h.title || bi("（没有文字）", "(No text)")}</b>
                  <span className="faint small">
                    {h.label} · {fullTime(h.at)} ·{" "}
                    {bi(`${h.messages} 条`, `${h.messages} msgs`)}
                    {h.accepted
                      ? bi(
                          ` · 采纳了 ${h.accepted} 个改动`,
                          ` · ${h.accepted} accepted`,
                        )
                      : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <>
          <button type="button" className="link" onClick={() => setPick("")}>
            {bi("← 返回列表", "← Back to list")}
          </button>
          <div className="ad-hist-msgs">
            {(detail?.messages || []).map((m, i) => (
              <Bubble
                key={i}
                m={m}
                jobBase={`${base}/history/${pick}`}
                props={props}
                deciding=""
                decide={() => undefined}
                comp
              />
            ))}
          </div>
        </>
      )}
    </Drawer>
  );
}

/** A failure inside the window stays inside the window. */
class WindowBoundary extends React.Component<
  { onClose: () => void; children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message || bi("出错了", "Something went wrong") };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section
        className="ad-win ad-broken"
        role="dialog"
        aria-label={bi("AI 助手", "AI Assistant")}
      >
        <p>
          {bi("AI 窗口出错了：", "AI window error: ")}
          {this.state.error}
        </p>
        <div>
          <Button size="small" onClick={() => this.setState({ error: "" })}>
            {bi("重试", "Retry")}
          </Button>
          <Button size="small" type="text" onClick={this.props.onClose}>
            {bi("关闭", "Close")}
          </Button>
        </div>
      </section>
    );
  }
}

/** Sculpted AI constellation glyph for buttons, pills, and inline indicators. */
export function Spark({
  size = 16,
  rainbow,
}: {
  size?: number;
  rainbow?: boolean;
}) {
  const gid = `sg${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const paint = rainbow ? `url(#${gid})` : "currentColor";
  return (
    <svg
      className={`ad-spark ${rainbow ? "rb" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      style={{ display: "block", flex: "none" }}
      aria-hidden
    >
      {rainbow && (
        <defs>
          <linearGradient
            id={gid}
            x1="2"
            y1="18"
            x2="18.5"
            y2="1.5"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#0ea5e9" />
            <stop offset=".38" stopColor="#6366f1" />
            <stop offset=".72" stopColor="#a855f7" />
            <stop offset="1" stopColor="#ec4899" />
          </linearGradient>
        </defs>
      )}
      <path
        d="M9.2 3.8C9.72 7.7 12.1 10.08 16 10.6C12.1 11.12 9.72 13.5 9.2 17.4C8.68 13.5 6.3 11.12 2.4 10.6C6.3 10.08 8.68 7.7 9.2 3.8Z"
        fill={paint}
      />
      <path
        d="M15.6 1.8C15.84 3.4 16.8 4.36 18.4 4.6C16.8 4.84 15.84 5.8 15.6 7.4C15.36 5.8 14.4 4.84 12.8 4.6C14.4 4.36 15.36 3.4 15.6 1.8Z"
        fill={paint}
        opacity=".92"
      />
      <circle cx="4.2" cy="5" r="1.05" fill={paint} opacity=".74" />
    </svg>
  );
}

/** Multi-layered Aurora Prism squircle emblem with adaptive LOD for hero orbs (40–56px) and compact badges (24–28px). */
export function AIEmblem({ size = 52 }: { size?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const detail = size >= 36;
  return (
    <svg
      className="ai-emblem"
      width={size}
      height={size}
      viewBox="0 0 52 52"
      fill="none"
      style={{ display: "block", flex: "none" }}
      aria-hidden
    >
      <defs>
        <linearGradient
          id={`ae-bg-${uid}`}
          x1="4"
          y1="4"
          x2="48"
          y2="48"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#4338ca" />
          <stop offset=".48" stopColor="#5b54ef" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
        <radialGradient
          id={`ae-cyan-${uid}`}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(8.5 45.5) rotate(-42) scale(37 34)"
        >
          <stop offset="0" stopColor="#38bdf8" stopOpacity=".66" />
          <stop offset=".62" stopColor="#38bdf8" stopOpacity=".16" />
          <stop offset="1" stopColor="#38bdf8" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={`ae-rose-${uid}`}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(45.5 6.5) rotate(135) scale(36 33)"
        >
          <stop offset="0" stopColor="#f472b6" stopOpacity=".68" />
          <stop offset=".52" stopColor="#c084fc" stopOpacity=".26" />
          <stop offset="1" stopColor="#c084fc" stopOpacity="0" />
        </radialGradient>
        <linearGradient
          id={`ae-sheen-${uid}`}
          x1="26"
          y1="0"
          x2="26"
          y2="26"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffffff" stopOpacity=".22" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient
          id={`ae-rim-${uid}`}
          x1="26"
          y1="0"
          x2="26"
          y2="52"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffffff" stopOpacity=".52" />
          <stop offset=".45" stopColor="#ffffff" stopOpacity=".08" />
          <stop offset="1" stopColor="#ffffff" stopOpacity=".2" />
        </linearGradient>
        <linearGradient
          id={`ae-star-${uid}`}
          x1="14"
          y1="13"
          x2="36"
          y2="40"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#eef2ff" />
        </linearGradient>
        {detail && (
          <>
            <linearGradient
              id={`ae-orb-${uid}`}
              x1="6"
              y1="26"
              x2="46"
              y2="26"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0" stopColor="#bae6fd" stopOpacity=".58" />
              <stop offset=".48" stopColor="#ffffff" stopOpacity=".1" />
              <stop offset="1" stopColor="#fbcfe8" stopOpacity=".46" />
            </linearGradient>
            <linearGradient
              id={`ae-core-${uid}`}
              x1="21"
              y1="23.8"
              x2="28"
              y2="30.6"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0" stopColor="#4f46e5" stopOpacity=".3" />
              <stop offset="1" stopColor="#ec4899" stopOpacity=".28" />
            </linearGradient>
          </>
        )}
      </defs>

      <rect width="52" height="52" rx="14.5" fill={`url(#ae-bg-${uid})`} />
      <rect width="52" height="52" rx="14.5" fill={`url(#ae-cyan-${uid})`} />
      <rect width="52" height="52" rx="14.5" fill={`url(#ae-rose-${uid})`} />
      <rect width="52" height="52" rx="14.5" fill={`url(#ae-sheen-${uid})`} />

      {detail ? (
        <>
          <ellipse
            cx="26"
            cy="26"
            rx="19.5"
            ry="9.2"
            transform="rotate(-30 26 26)"
            stroke={`url(#ae-orb-${uid})`}
            strokeWidth="1.25"
          />
          <circle cx="9.1" cy="35.75" r="1.95" fill="#e0f2fe" opacity=".92" />
        </>
      ) : (
        <circle cx="12.6" cy="14.6" r="2.05" fill="#e0f2fe" opacity=".82" />
      )}

      <path
        d="M24.6 12.6C25.65 21 30.8 26.15 39.2 27.2C30.8 28.25 25.65 33.4 24.6 41.8C23.55 33.4 18.4 28.25 10 27.2C18.4 26.15 23.55 21 24.6 12.6Z"
        fill={`url(#ae-star-${uid})`}
      />
      {detail && (
        <path
          d="M24.6 23.7L28.1 27.2L24.6 30.7L21.1 27.2Z"
          fill={`url(#ae-core-${uid})`}
        />
      )}
      <path
        d="M37.4 8.8C37.85 12 39.8 13.95 43 14.4C39.8 14.85 37.85 16.8 37.4 20C36.95 16.8 35 14.85 31.8 14.4C35 13.95 36.95 12 37.4 8.8Z"
        fill="#ffffff"
        opacity=".95"
      />

      <rect
        x="0.6"
        y="0.6"
        width="50.8"
        height="50.8"
        rx="13.9"
        stroke={`url(#ae-rim-${uid})`}
        strokeWidth="1.2"
      />
    </svg>
  );
}

/* ---------------------------------------------------------------- window */

export const readFile = (f: File) =>
  new Promise<string>((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () =>
      bad(new Error(bi("图片无法读取", "Unable to read image")));
    r.readAsDataURL(f);
  });

export type SandboxConfirm = {
  id: string;
  kind: "python" | "skill_script" | "shell" | string;
  title: string;
  purpose?: string;
  skill?: string;
  script?: string;
  shell?: string;
  workspace?: string;
  mine?: boolean;
  files?: string[];
  code?: string;
  want_net?: boolean;
  net_reason?: string;
  reasons?: string[];
  exec_policy?: string;
  net_policy?: string;
};

export type Live = {
  files?: MsgFile[];
  ask?: Ask;
  sandboxConfirms?: SandboxConfirm[];
  text: string;
  tools: string[];
  steps: Step[];
  t0: number;
  notice: string;
  made: string[];
  looking: boolean;
  thinking: string;
  model?: string;
};
export const newLive = (): Live => ({
  text: "",
  tools: [],
  steps: [],
  t0: Date.now(),
  notice: "",
  made: [],
  looking: true,
  thinking: "",
});

function ChatWindow({
  scope,
  start,
  target,
  setTarget,
  expanded,
  setExpanded,
  mode,
  setMode,
  onBusy,
  onClose,
  onChanged,
  available,
}: {
  scope: Scope;
  start: AITarget;
  target: AITarget;
  setTarget: (t: AITarget) => void;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  mode: "closed" | "open" | "min";
  setMode: (m: "closed" | "open" | "min") => void;
  onBusy: (b: boolean) => void;
  onClose: () => void;
  onChanged: () => void;
  available: (key: string) => boolean;
}) {
  useLang();
  const status = useAIStatus();
  const net = useConnectivity();
  const base =
    scope.kind === "comp"
      ? `/api/components/${scope.name}/ai`
      : `/api/jobs/${scope.jobId}/ai`;
  const sessionURL =
    scope.kind === "comp"
      ? `${base}/session`
      : `${base}/session?key=${encodeURIComponent(target.key)}`;
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [savedStep, setSavedStep] = useState<
    Record<string, unknown> | undefined
  >();
  const [props, setProps] = useState<
    Record<string, StepProposal | CompProposal>
  >({});
  const [input, setInput] = useState("");
  const [imgs, setImgs] = useState<string[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<{
    text: string;
    retry?: string;
    diag?: AICallDiag;
  } | null>(null);
  const [errDiagOpen, setErrDiagOpen] = useState(false);
  const [deciding, setDeciding] = useState("");
  const [resolving, setResolving] = useState(false);
  // the "solved?" line is only a question: it can be put away, and comes back after the conversation goes on
  const solvedKey = `mh-solved-${scope.kind === "job" ? scope.jobId : ""}-${target.key}`;
  const [solvedAt, setSolvedAt] = useState<number>(() =>
    Number(sessionStorage.getItem(solvedKey) || -1),
  );
  useEffect(
    () => setSolvedAt(Number(sessionStorage.getItem(solvedKey) || -1)),
    [solvedKey],
  );
  const putAway = (n: number) => {
    sessionStorage.setItem(solvedKey, String(n));
    setSolvedAt(n);
  };
  const [openSubmit, submitNode] = useSubmitKB();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [drag, setDrag] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);
  const feature = featureOf(target.key);
  const model = useModelPick(feature);
  const tools = useAIOptions();
  const on = available(target.key);
  const noVision = model.current
    ? model.current.vision === "no"
    : !!status.no_vision?.[feature];
  const images = true;
  const busy = !!live;
  useEffect(() => onBusy(busy), [busy, onBusy]);
  // which conversation the window shows now: an answer that comes back for another one is not shown here
  const sessionRef = useRef(sessionURL);
  sessionRef.current = sessionURL;
  // the answer of this conversation is being written on the server (the page looked elsewhere meanwhile)
  const [remote, setRemote] = useState(false);
  const win = useRef<HTMLElement>(null);
  // where the window was dragged to, as distances from the right and bottom edges
  const [pos, setPos] = useState<{ r: number; b: number } | null>(null);
  const dragging = useRef<{
    x: number;
    y: number;
    r: number;
    b: number;
    w: number;
    h: number;
    moved: boolean;
  } | null>(null);
  const [moving, setMoving] = useState(false);
  // A size change resets the position and closes the compact conversation menu.
  useEffect(() => {
    setPos(null);
    setListOpen(false);
  }, [expanded]);
  const wasDrag = useRef(false);
  const small = () => window.innerWidth <= 640;
  const onDown = (e: React.PointerEvent) => {
    if (
      e.button !== 0 ||
      small() ||
      (e.target as HTMLElement).closest(".ad-tools")
    )
      return;
    const rect = win.current!.getBoundingClientRect();
    dragging.current = {
      x: e.clientX,
      y: e.clientY,
      r: window.innerWidth - rect.right,
      b: window.innerHeight - rect.bottom,
      w: rect.width,
      h: rect.height,
      moved: false,
    };
  };
  const moveTo = useRef<{ r: number; b: number; raf: number }>({
    r: 0,
    b: 0,
    raf: 0,
  });
  const onMove = (e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!d.moved) {
      setMoving(true);
      // only a real drag takes the pointer: a plain click still reaches the buttons in the header
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    d.moved = true;
    wasDrag.current = true;
    // keep the header reachable: at least 120px of it inside the screen, and never above the top bar
    const r = Math.min(window.innerWidth - 120, Math.max(120 - d.w, d.r - dx));
    const b = Math.min(
      window.innerHeight - d.h - 8,
      Math.max(54 - d.h, d.b - dy),
    );
    // the window follows the pointer directly; the page is not drawn again for every movement
    moveTo.current.r = r;
    moveTo.current.b = b;
    if (!moveTo.current.raf)
      moveTo.current.raf = requestAnimationFrame(() => {
        moveTo.current.raf = 0;
        if (win.current)
          win.current.style.translate = `${Math.round(d.r - moveTo.current.r)}px ${Math.round(d.b - moveTo.current.b)}px`;
      });
  };
  const onUp = () => {
    const d = dragging.current;
    dragging.current = null;
    if (moveTo.current.raf) {
      cancelAnimationFrame(moveTo.current.raf);
      moveTo.current.raf = 0;
    }
    if (d?.moved) {
      // it stays where it was dropped: the translation becomes the window's own position
      if (win.current) {
        win.current.style.right = moveTo.current.r + "px";
        win.current.style.bottom = moveTo.current.b + "px";
        win.current.style.translate = "";
      }
      setPos({ r: moveTo.current.r, b: moveTo.current.b });
    }
    setMoving(false);
    window.setTimeout(() => (wasDrag.current = false), 0);
    if (d && !d.moved && mode === "min") setMode("open");
  };

  const loadProps = useCallback(
    () =>
      api<{ proposals?: (StepProposal | CompProposal)[] }>(
        scope.kind === "comp" ? `${base}/session` : `${base}/proposals`,
      )
        .then((r) =>
          setProps(
            Object.fromEntries((r.proposals || []).map((p) => [p.id, p])),
          ),
        )
        .catch(() => undefined),
    [base, scope.kind],
  );
  const sessListRef = useRef<HTMLDivElement>(null);
  const sessOrder = useRef<{
    base: string;
    ranks: Map<string, number>;
    top: number;
  }>({ base: "", ranks: new Map(), top: 0 });
  const loadSessions = useCallback(() => {
    if (scope.kind !== "job") return;
    api<{ sessions: SessionInfo[] }>(`${base}/sessions`)
      .then((r) => {
        const list = r.sessions || [];
        if (
          sessOrder.current.base !== base ||
          sessOrder.current.ranks.size === 0
        ) {
          const ranks = new Map<string, number>();
          list.forEach((s, idx) => ranks.set(s.key, idx));
          sessOrder.current = { base, ranks, top: 0 };
        } else {
          for (let i = list.length - 1; i >= 0; i--) {
            const s = list[i];
            if (!sessOrder.current.ranks.has(s.key))
              sessOrder.current.ranks.set(s.key, --sessOrder.current.top);
          }
        }
        setSessions(list);
      })
      .catch(() => undefined);
  }, [base, scope.kind]);

  useEffect(() => {
    setMsgs(null);
    setError(null);
    setErrDiagOpen(false);
    setLive(null);
    setInput("");
    setImgs([]);
    setAtBottom(true);
    abort.current?.abort();
    let live = true;
    setSavedStep(undefined);
    setRemote(false);
    api<{
      messages: Msg[];
      step?: Record<string, unknown>;
      running?: boolean;
      running_since?: string;
    }>(sessionURL)
      .then((s) => {
        if (!live) return;
        setMsgs(s.messages || []);
        setSavedStep(s.step);
        // a question the server kept but never answered (the answer broke off): offer to ask it again
        const last = (s.messages || [])[(s.messages || []).length - 1];
        if (scope.kind === "comp" && !s.running && last?.role === "user")
          setError({
            text: bi(
              "上一次提问没有得到回答（回答中途断了，可能是服务刚更新过）",
              "The previous message received no reply (stream interrupted, possibly due to a service restart)",
            ),
            retry: last.text,
          });
        if (s.running) {
          setLive({
            ...newLive(),
            t0: s.running_since
              ? Date.parse(s.running_since) || Date.now()
              : Date.now(),
            notice: bi(
              "这段对话还在回答，写完会自动显示在这里",
              "This reply is still generating; it will appear here automatically once done",
            ),
          });
          setRemote(true);
        }
      })
      .catch((e) => {
        if (!live) return;
        setMsgs([]);
        setError({ text: (e as Error).message });
      });
    loadProps();
    loadSessions();
    return () => {
      live = false;
    };
  }, [sessionURL, loadProps, loadSessions]);
  useEffect(() => () => abort.current?.abort(), []);
  // follow an answer that is being written on the server until it is there
  useEffect(() => {
    if (!remote) return;
    let alive = true;
    const t = window.setInterval(() => {
      api<{ messages: Msg[]; running?: boolean }>(sessionURL)
        .then((s) => {
          if (!alive || s.running) return;
          setMsgs(s.messages || []);
          setLive(null);
          setRemote(false);
          loadProps();
          loadSessions();
          onChanged();
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [remote, sessionURL]); // eslint-disable-line react-hooks/exhaustive-deps
  // opened with something to ask (a failed step's output): ask it once the conversation is loaded
  const asked = useRef("");
  useEffect(() => {
    const p = target.prefill;
    if (!p || msgs === null || asked.current === target.key + p) return;
    asked.current = target.key + p;
    send(p);
  }, [msgs === null, target.prefill]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (msgs && !small()) box.current?.focus({ preventScroll: true });
  }, [target.key, msgs === null]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!expanded && !listOpen) return;
    const el = sessListRef.current;
    if (!el || el.scrollTop > 0) return;
    el.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }, [expanded, listOpen]);

  // Follow the answer while it streams, unless the reader scrolled up to read something earlier.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [msgs, live, atBottom]);
  const onScroll = () => {
    const el = list.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  const toBottom = () => {
    const el = list.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // the input grows with what is typed, up to a limit
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [input]);

  const addFiles = async (files: FileList | File[]) => {
    const pics = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!pics.length) return;
    if (!images) return;
    if (noVision)
      return Message.warning(
        bi(
          "当前模型看不了图片，请把报错文字贴进来",
          "Current model doesn't support images—paste error text instead",
        ),
      );
    if (imgs.length + pics.length > 3)
      return Message.warning(bi("一次最多 3 张图片", "At most 3 images at once"));
    if (pics.some((f) => f.size > 4 << 20))
      return Message.warning(
        bi("图片不能超过 4 MiB", "Image size cannot exceed 4 MiB"),
      );
    try {
      const data = await Promise.all(pics.map(readFile));
      setImgs((x) => [...x, ...data]);
    } catch (e) {
      err(e);
    }
  };

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if ((!text && !imgs.length) || busy || !on) return;
    const sent = imgs;
    const mine = sessionURL;
    const here = () => sessionRef.current === mine;
    setError(null);
    setErrDiagOpen(false);
    // asking again a question the server kept but never answered: it is already in the conversation
    const again =
      override !== undefined &&
      msgs?.length &&
      msgs[msgs.length - 1].role === "user" &&
      msgs[msgs.length - 1].text === text;
    if (!again)
      setMsgs((m) => [
        ...(m || []),
        { role: "user", text, images: sent, at: new Date().toISOString() },
      ]);
    setInput("");
    setImgs([]);
    setAtBottom(true);
    const cur = newLive();
    setLive({ ...cur });
    const ac = new AbortController();
    abort.current = ac;
    const done = () => ({
      role: "assistant" as const,
      text: cur.text,
      tools: cur.tools,
      steps: cur.steps.map((x) => ({ ...x, running: false })),
      ms: Date.now() - cur.t0,
      proposals: cur.made,
      ask: cur.ask,
      files: cur.files,
      at: new Date().toISOString(),
    });
    try {
      if (scope.kind === "comp") await scope.beforeSend?.();
      await streamChat(
        `${base}/chat`,
        scope.kind === "comp"
          ? {
              message: text,
              images: sent,
              model: model.ref,
              options: tools.opts,
              retry: !!again,
            }
          : {
              key: target.key,
              message: text,
              images: sent,
              step: target.step,
              model: model.ref,
              options: tools.opts,
            },
        ac.signal,
        cur,
        () =>
          here() &&
          setLive({
            ...cur,
            tools: [...cur.tools],
            steps: cur.steps.map((x) => ({ ...x })),
            made: [...cur.made],
            sandboxConfirms: cur.sandboxConfirms
              ? [...cur.sandboxConfirms]
              : undefined,
          }),
        () => (here() ? loadProps() : Promise.resolve()),
      );
      if (!here()) return;
      setMsgs((m) => [...(m || []), done()]);
      loadSessions();
    } catch (e) {
      // the page moved to another conversation: this one keeps being written on the server, and is read from there
      if (!here()) return;
      const stopped = (e as Error).name === "AbortError";
      if (cur.text || cur.made.length || cur.steps.length)
        setMsgs((m) => [
          ...(m || []),
          {
            ...done(),
            text: cur.text + (stopped ? bi("\n\n（已停止）", "\n\n(Stopped)") : ""),
          },
        ]);
      if (!stopped) {
        const diag =
          (e as ChatStreamError).diag ??
          (e as { body?: { diag?: AICallDiag } }).body?.diag;
        setErrDiagOpen(false);
        setError({
          text: (e as Error).message,
          retry: cur.text ? undefined : text,
          diag,
        });
      }
    } finally {
      if (here()) {
        setLive(null);
        abort.current = null;
      }
    }
  };

  const stop = () => {
    abort.current?.abort();
    if (scope.kind === "job")
      api(`${base}/stop`, {
        method: "POST",
        body: JSON.stringify({ key: target.key }),
      }).catch(() => undefined);
    if (remote) {
      setRemote(false);
      setLive(null);
      api<{ messages: Msg[] }>(sessionURL)
        .then((s) => setMsgs(s.messages || []))
        .catch(() => undefined);
    }
  };

  const decide = async (id: string, verb: "accept" | "reject") => {
    setDeciding(id);
    try {
      await api(`${base}/proposals/${id}/${verb}`, { method: "POST" });
      if (verb === "accept" && scope.kind === "comp")
        window.dispatchEvent(
          new CustomEvent("mh-ai-wrote", {
            detail: {
              name: scope.name,
              files: ((props[id] as CompProposal | undefined)?.files || []).map(
                (f) => ({ path: f.path, op: f.op, diff: f.diff }),
              ),
            },
          }),
        );
      if (
        verb === "accept" &&
        (props[id] as StepProposal | undefined)?.kind !== "component"
      )
        Message.success(
          scope.kind === "comp"
            ? bi(
                "已写入草稿，工作台已重新检查",
                "Applied to draft; workbench re-checked",
              )
            : bi(
                "已写入执行手册和交付文档",
                "Applied to runbook and delivery docs",
              ),
        );
      await loadProps();
      onChanged();
    } catch (e) {
      err(e);
    } finally {
      setDeciding("");
    }
  };

  // "solved": the assistant writes the conversation up as a draft, the person reads and corrects it, and only then is it
  // written into the execution record. Closing the draft writes nothing and the question stays.
  const [draft, setDraft] = useState<AIReport | null>(null);
  const [markStep, setMarkStep] = useState(false);
  const [saving, setSaving] = useState<"" | "save" | "kb">("");
  const resolve = async () => {
    setResolving(true);
    try {
      setDraft(
        await api<AIReport>(`${base}/resolve`, {
          method: "POST",
          body: JSON.stringify({ key: target.key, draft: true }),
        }),
      );
      setMarkStep(false);
    } catch (e) {
      err(e);
    } finally {
      setResolving(false);
    }
  };
  const confirmDraft = async (toKB: boolean) => {
    if (!draft) return;
    setSaving(toKB ? "kb" : "save");
    try {
      const rep = await api<AIReport>(`${base}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          key: target.key,
          report: draft,
          mark_step: markStep && target.key.startsWith("step:"),
          to_kb: toKB,
        }),
      });
      putAway((msgs || []).length);
      setDraft(null);
      onChanged();
      Message.success(
        toKB && rep.kb_id
          ? bi(
              "已写入执行记录，并存进你自己的知识库（只有你能看到；要给团队用，在记录里点「发布到团队」）",
              "Saved to execution record and your personal KB (private; click 'Publish to team' on the record to share)",
            )
          : bi(
              "已写入执行记录，交付报告里会出现这一段",
              "Saved to execution record; it will appear in the delivery report",
            ),
      );
    } catch (e) {
      err(e);
    } finally {
      setSaving("");
    }
  };

  const [history, setHistory] = useState(false);
  const restart = () =>
    Modal.confirm({
      title: bi("清空这段对话？", "Clear this conversation?"),
      content: bi(
        "对话内容会删除；已采纳的提案和写入执行记录的内容不受影响。",
        "Chat messages will be deleted; accepted proposals and saved execution records are kept.",
      ),
      okText: bi("清空", "Clear"),
      cancelText: bi("取消", "Cancel"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          await api(sessionURL, { method: "DELETE" });
          setMsgs([]);
          setError(null);
          loadSessions();
        } catch (e) {
          err(e);
        }
      },
    });

  const savedSessScroll = useRef<number | null>(null);
  const normDeployCopy = (s?: string) =>
    s ? s.replace(/首次部署/g, bi("集群部署", "Cluster deploy")) : s;
  const pick = (t: AITarget) => {
    if (sessListRef.current)
      savedSessScroll.current = sessListRef.current.scrollTop;
    setTarget(t);
    setListOpen(false);
  };
  useLayoutEffect(() => {
    if (savedSessScroll.current !== null && sessListRef.current) {
      sessListRef.current.scrollTop = savedSessScroll.current;
      savedSessScroll.current = null;
    }
  });
  const hello =
    target.hello ||
    (scope.kind === "comp"
      ? getHelloComp()
      : isGeneral(target.key)
        ? getHelloReview()
        : getHelloStep());
  const suggestions =
    target.suggestions ||
    (scope.kind === "comp"
      ? getSuggestComp()
      : isGeneral(target.key)
        ? getSuggestReview()
        : getSuggestStep());
  const answered = (msgs || []).some((m) => m.role === "assistant");
  // the "solved?" line shows while it is new; once put away it shrinks to a small button in the box's toolbar, so the
  // way to write the conversation up is still there when it turns out to be needed
  const askSolved = feature === "troubleshoot" && answered && !busy;
  const showSolved = askSolved && (msgs || []).length >= solvedAt + 2;
  const solvedChip = askSolved && !showSolved;
  const offline = net !== "online";

  // a new conversation about the whole delivery; one that has not been written in yet is not started twice
  const startGeneral = () => {
    if (isGeneral(target.key) && (msgs || []).length === 0 && !busy) {
      box.current?.focus({ preventScroll: true });
      setListOpen(false);
      return;
    }
    pick({
      key: newGeneral(),
      title: bi("新对话", "New chat"),
      context: start.context,
    });
  };
  // the list: what was asked about the whole delivery, then what was asked on a step; a conversation not yet written in
  // is not in it (it would come and go as the person moves between conversations)
  const [find, setFind] = useState("");
  const shownSessions = sessions
    .filter(
      (x) =>
        !find.trim() ||
        x.title.toLowerCase().includes(find.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        (sessOrder.current.ranks.get(a.key) ?? 0) -
        (sessOrder.current.ranks.get(b.key) ?? 0),
    );
  const groups = [
    {
      id: "all",
      label: bi("整个交付", "Whole delivery"),
      items: shownSessions.filter((x) => isGeneral(x.key)),
    },
    {
      id: "step",
      label: bi("现场排障", "Troubleshooting"),
      items: shownSessions.filter((x) => !isGeneral(x.key)),
    },
  ].filter((g) => g.items.length);
  const sideList = scope.kind === "job" && (
    <nav className="ad-sessions" aria-label={bi("对话", "Conversations")}>
      <div className="ad-side-top">
        <b>{bi("对话", "Chats")}</b>
        <button
          type="button"
          className="ad-new"
          disabled={!available("review")}
          onClick={startGeneral}
        >
          <IconPlus aria-hidden />
          {bi("新对话", "New chat")}
        </button>
      </div>
      {sessions.length > 0 && (
        <label className="ad-find">
          <IconSearch aria-hidden />
          <input
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder={bi("搜索对话", "Search chats")}
            aria-label={bi("搜索对话", "Search chats")}
          />
          {find && (
            <button
              type="button"
              aria-label={bi("清除搜索", "Clear search")}
              onClick={() => setFind("")}
            >
              <IconClose />
            </button>
          )}
        </label>
      )}
      <div className="ad-sess-list" ref={sessListRef}>
        {groups.map((g) => (
          <section key={g.id} className="ad-sess-group">
            {groups.length > 1 && <div className="ad-side-h">{g.label}</div>}
            {g.items.map((s) => {
              const cur = s.key === target.key;
              const general = isGeneral(s.key);
              return (
                <button
                  key={s.key}
                  type="button"
                  className={cur ? "on" : ""}
                  aria-current={cur ? "true" : undefined}
                  disabled={!available(s.key)}
                  title={s.title}
                  onClick={() =>
                    pick(
                      s.key === start.key
                        ? start
                        : {
                            key: s.key,
                            title: s.title,
                            context: general
                              ? start.context
                              : bi("现场排障", "Troubleshooting"),
                          },
                    )
                  }
                >
                  <i
                    className={`ad-dot k-${general ? "review" : "step"} ${s.running ? "run" : ""}`}
                    aria-hidden
                  />
                  <span>
                    <b>{normDeployCopy(s.title)}</b>
                    <small>
                      {s.running
                        ? bi("正在回答…", "Replying…")
                        : s.updated
                          ? ago(s.updated)
                          : ""}
                    </small>
                  </span>
                </button>
              );
            })}
          </section>
        ))}
        {sessions.length > 0 && groups.length === 0 && (
          <p className="ad-sess-none">
            {bi("没有匹配的对话", "No matching conversations")}
          </p>
        )}
        {sessions.length === 0 && (
          <p className="ad-sess-none">
            {bi(
              "还没有对话。点「新对话」问点什么，或在某一步点「问 AI」。",
              "No conversations yet. Click New chat to ask something, or click Ask AI on any step.",
            )}
          </p>
        )}
      </div>
    </nav>
  );

  return (
    <section
      ref={win}
      className={`ad-win ${expanded && mode !== "min" ? "big" : ""} ${drag ? "drag" : ""} ${mode === "min" ? "min" : ""} ${mode === "closed" ? "hidden" : ""} ${moving ? "moving" : ""}`}
      style={
        pos && mode !== "min" ? { right: pos.r, bottom: pos.b } : undefined
      }
      aria-hidden={mode === "closed" || undefined}
      role="dialog"
      aria-label={bi(`AI 助手：${target.title}`, `AI Assistant: ${target.title}`)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          // a menu that is open takes the key first; the window stays
          const menu = [
            ...document.querySelectorAll<HTMLElement>(".arco-trigger-popup"),
          ].some((el) => el.offsetParent !== null);
          if (menu) return;
          if (listOpen) setListOpen(false);
          else onClose();
        }
      }}
      onDragOver={(e) => {
        if (images && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrag(false);
      }}
      onDrop={(e) => {
        if (!images) return;
        e.preventDefault();
        setDrag(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <header
        className="ad-head"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={(e) =>
          !(e.target as HTMLElement).closest(".ad-tools") && setPos(null)
        }
        title={
          expanded
            ? undefined
            : bi(
                "拖动可移动窗口，双击回到右下角",
                "Drag to move; double-click to reset position",
              )
        }
      >
        <span className="ad-mark">
          <AIEmblem size={28} />
        </span>
        <div className="ad-title">
          {scope.kind === "job" && !expanded ? (
            <button
              type="button"
              className="ad-switch"
              onClick={() => !wasDrag.current && setListOpen((v) => !v)}
              aria-expanded={listOpen}
              aria-label={bi("切换对话", "Switch conversation")}
            >
              <b>{normDeployCopy(target.title)}</b>
              <IconDown className={listOpen ? "ad-flip" : ""} />
            </button>
          ) : (
            <b>
              {normDeployCopy(scope.kind === "job" ? target.title : start.title)}
            </b>
          )}
          <small>
            {busy && mode === "min" ? (
              <span className="ad-busy">
                <i className="ad-pulse" aria-hidden />{" "}
                {bi("正在回答…", "Replying…")}
              </span>
            ) : (
              normDeployCopy(target.context) ||
              (isGeneral(target.key)
                ? bi("关于整个交付", "About this delivery")
                : scope.kind === "comp"
                  ? bi("组件工作台", "Component workbench")
                  : bi("现场排障", "Troubleshooting"))
            )}
          </small>
        </div>
        <div className="ad-tools">
          {scope.kind === "job" && mode !== "min" && !expanded && (
            <Tooltip
              content={bi(
                "新对话（针对整个交付，不关联步骤）",
                "New chat (about the whole delivery)",
              )}
              mini
            >
              <button
                type="button"
                className="ad-whole"
                onClick={startGeneral}
                aria-label={bi("新对话", "New chat")}
                disabled={!available("review")}
              >
                <IconMessage />
              </button>
            </Tooltip>
          )}
          {scope.kind === "comp" && mode !== "min" && (
            <Tooltip
              content={bi(
                "这个组件以前的对话（发布或放弃草稿后留下的）",
                "Past conversations for this component (kept after publishing or discarding drafts)",
              )}
              mini
            >
              <button
                type="button"
                onClick={() => setHistory(true)}
                aria-label={bi("历史对话", "Chat history")}
              >
                <IconHistory />
              </button>
            </Tooltip>
          )}
          {mode !== "min" && (msgs || []).length > 0 && (
            <Tooltip content={bi("清空这段对话", "Clear conversation")} mini>
              <button
                type="button"
                onClick={restart}
                aria-label={bi("清空这段对话", "Clear conversation")}
                disabled={busy}
              >
                <IconDelete />
              </button>
            </Tooltip>
          )}
          {mode === "min" ? (
            <Tooltip content={bi("展开", "Expand")} mini>
              <button
                type="button"
                onClick={() => setMode("open")}
                aria-label={bi("展开窗口", "Restore window")}
              >
                <IconUp />
              </button>
            </Tooltip>
          ) : (
            <>
              <Tooltip content={bi("最小化到底部", "Minimize to bottom")} mini>
                <button
                  type="button"
                  onClick={() => setMode("min")}
                  aria-label={bi("最小化窗口", "Minimize window")}
                >
                  <IconMinus />
                </button>
              </Tooltip>
              <Tooltip
                content={
                  expanded ? bi("缩小", "Compact") : bi("放大", "Expand")
                }
                mini
              >
                <button
                  type="button"
                  onClick={() => setExpanded(!expanded)}
                  aria-label={
                    expanded
                      ? bi("缩小窗口", "Compact window")
                      : bi("放大窗口", "Expand window")
                  }
                >
                  {expanded ? <IconShrink /> : <IconExpand />}
                </button>
              </Tooltip>
            </>
          )}
          <Tooltip
            content={bi(
              "关闭（Esc），对话会保留",
              "Close (Esc); conversation is kept",
            )}
            mini
          >
            <button
              type="button"
              onClick={onClose}
              aria-label={bi("关闭 AI 助手", "Close AI Assistant")}
            >
              <IconClose />
            </button>
          </Tooltip>
        </div>
      </header>

      <div className="ad-body">
        {expanded && sideList}
        {!expanded && listOpen && (
          <div
            className="ad-pop"
            onClick={(e) => e.target === e.currentTarget && setListOpen(false)}
          >
            {sideList}
          </div>
        )}
        <div className="ad-main">
          {(target.step || savedStep) && (
            <StepContext step={(target.step || savedStep)!} />
          )}
          <div
            className="ad-list"
            ref={list}
            onScroll={onScroll}
            aria-live="polite"
            aria-busy={busy}
          >
            {msgs === null ? (
              <div
                className="ad-loading"
                aria-label={bi("正在载入对话", "Loading conversation")}
              >
                <i />
                <i />
                <i />
              </div>
            ) : msgs.length === 0 && !live ? (
              <div className="ad-empty">
                <span className="ad-empty-mark">
                  <AIEmblem size={44} />
                </span>
                <p>{hello}</p>
                <div className="ad-chips">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => send(s)}
                      disabled={!on || offline}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {msgs.map((m, i) => (
                  <Bubble
                    key={`${target.key}-${i}`}
                    m={m}
                    jobBase={base}
                    props={props}
                    deciding={deciding}
                    decide={decide}
                    comp={scope.kind === "comp"}
                    answer={(t) => send(t)}
                  />
                ))}
                {live && (
                  <LiveBubble
                    live={live}
                    props={props}
                    deciding={deciding}
                    decide={decide}
                    comp={scope.kind === "comp"}
                  />
                )}
              </>
            )}
            {error && (
              <div
                className={`ad-error ${error.diag ? "has-diag" : ""}`}
                role="alert"
              >
                <div className="ad-error-row">
                  <span>{error.text}</span>
                  <div className="ad-error-acts">
                    {error.diag && (
                      <button
                        type="button"
                        className="ad-err-toggle"
                        aria-expanded={errDiagOpen}
                        onClick={() => setErrDiagOpen((v) => !v)}
                      >
                        {errDiagOpen
                          ? bi("收起网关诊断", "Hide diagnostics")
                          : bi("展开网关诊断", "Show diagnostics")}
                        <IconDown className={errDiagOpen ? "ad-flip" : ""} />
                      </button>
                    )}
                    {error.retry !== undefined && (
                      <Button
                        size="mini"
                        icon={<IconRefresh />}
                        onClick={() => send(error.retry)}
                        disabled={busy}
                      >
                        {bi("重试", "Retry")}
                      </Button>
                    )}
                  </div>
                </div>
                {error.diag && errDiagOpen && (
                  <ChatErrorDiag diag={error.diag} errText={error.text} />
                )}
              </div>
            )}
            {!atBottom && (
              <button
                type="button"
                className="ad-down"
                onClick={toBottom}
                aria-label={bi("回到最新", "Jump to latest")}
              >
                <IconArrowDown />
              </button>
            )}
          </div>

          {showSolved && (
            <div className="ad-solved">
              <span>
                {bi(
                  "问题解决了？把经过整理成记录，写进这份交付的执行记录。",
                  "Issue resolved? Summarize it into this delivery's execution record.",
                )}
              </span>
              <Button
                size="mini"
                type="outline"
                loading={resolving}
                onClick={resolve}
              >
                {bi("已解决，写入记录", "Resolved, save record")}
              </Button>
              <button
                type="button"
                className="ad-solved-x"
                aria-label={bi("先不用，收起这一行", "Dismiss for now")}
                onClick={() => putAway((msgs || []).length)}
              >
                <IconClose />
              </button>
            </div>
          )}

          <form
            className={`ad-compose ${offline || !on ? "off" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
          >
            {imgs.length > 0 && (
              <div className="ad-thumbs">
                {imgs.map((im, i) => (
                  <span key={i}>
                    <img
                      src={im}
                      alt={bi(
                        `待发送的截图 ${i + 1}`,
                        `Pending screenshot ${i + 1}`,
                      )}
                    />
                    <button
                      type="button"
                      aria-label={bi("移除这张图片", "Remove image")}
                      onClick={() => setImgs(imgs.filter((_, k) => k !== i))}
                    >
                      <IconClose />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={box}
              value={input}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                !on
                  ? can("ai.settings")
                    ? bi(
                        "AI 未开启，可在「设置 → AI」中开启",
                        "AI is off—enable it in Settings → AI",
                      )
                    : bi(
                        "AI 未开启，请联系管理员启用",
                        "AI is off—contact an administrator",
                      )
                  : offline
                    ? bi("网络已断开", "Network disconnected")
                    : scope.kind === "comp"
                      ? bi(
                          "说说要怎么改这个组件…",
                          "Describe how to update this component…",
                        )
                      : images && !noVision
                        ? bi(
                            "贴上报错、描述现象，或粘贴截图…",
                            "Paste errors, describe symptoms, or paste screenshots…",
                          )
                        : bi(
                            "贴上报错文字，或描述现象…",
                            "Paste error text or describe symptoms…",
                          )
              }
              disabled={!on || offline}
              aria-label={bi("消息", "Message")}
            />
            <div className="ad-bar">
              <ToolMenu
                t={tools}
                levels={model.current?.effort}
                compact={!expanded}
              />
              {images &&
                (noVision ? (
                  <Tooltip
                    content={bi(
                      "当前模型看不了图片。请把报错文字贴进来，或请管理员换一个支持看图的模型。",
                      "Current model has no vision. Paste error text instead, or ask an admin to switch to a vision model.",
                    )}
                  >
                    <span className="ad-attach off" aria-disabled>
                      <IconImage />
                    </span>
                  </Tooltip>
                ) : (
                  <Tooltip
                    content={bi(
                      "添加截图（也可以直接粘贴或拖进来）",
                      "Attach screenshot (or paste/drop directly)",
                    )}
                    mini
                  >
                    <label className="ad-attach">
                      <IconImage />
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        onChange={(e) =>
                          e.target.files && addFiles(e.target.files)
                        }
                      />
                    </label>
                  </Tooltip>
                ))}
              {solvedChip && (
                <Tooltip
                  content={bi(
                    "问题解决了？整理成记录写进执行记录",
                    "Issue resolved? Save a summary to the execution record",
                  )}
                  mini
                >
                  <button
                    type="button"
                    className="ad-attach ad-solve-chip"
                    aria-label={bi("整理成记录", "Save as record")}
                    disabled={resolving}
                    onClick={resolve}
                  >
                    <IconCheckCircle />
                  </button>
                </Tooltip>
              )}
              <ModelPicker pick={model} compact />
              {busy ? (
                <button
                  type="button"
                  className="ad-send stop"
                  onClick={stop}
                  aria-label={bi("停止生成", "Stop")}
                  title={bi("停止生成", "Stop")}
                >
                  <IconRecordStop />
                </button>
              ) : (
                <button
                  type="submit"
                  className="ad-send"
                  disabled={(!input.trim() && !imgs.length) || !on || offline}
                  aria-label={bi("发送", "Send")}
                  title={bi(
                    "发送（Enter 发送 · Shift+Enter 换行）",
                    "Send (Enter to send · Shift+Enter for new line)",
                  )}
                >
                  <IconSend />
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
      {drag && (
        <div className="ad-drop">
          {bi("松开即可添加截图", "Drop to attach screenshots")}
        </div>
      )}
      {scope.kind === "comp" && (
        <CompHistory
          open={history}
          close={() => setHistory(false)}
          base={base}
        />
      )}
      {submitNode}
      <Modal
        visible={!!draft}
        title={bi("整理成记录", "Save as record")}
        className="ad-wu-modal"
        onCancel={() => !saving && setDraft(null)}
        maskClosable={false}
        footer={
          <>
            <Button onClick={() => setDraft(null)} disabled={!!saving}>
              {bi("先不写入", "Cancel")}
            </Button>
            <Button
              loading={saving === "kb"}
              disabled={!!saving && saving !== "kb"}
              onClick={() => confirmDraft(true)}
            >
              {bi("写入并存入知识库", "Save & add to KB")}
            </Button>
            <Button
              type="primary"
              loading={saving === "save"}
              disabled={!!saving && saving !== "save"}
              onClick={() => confirmDraft(false)}
            >
              {bi("写入记录", "Save record")}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="ad-wu">
            <p className="ad-wu-lead">
              {bi(
                "AI 根据对话整理的草稿，可以直接修改。写入后出现在这份交付的执行记录、交付报告和变更报告里。",
                "Draft generated by AI from this chat—feel free to edit. Once saved, it appears in the execution record, delivery report, and change report.",
              )}
            </p>
            {(
              [
                ["symptom", bi("现象", "Symptom"), 2, 5, false],
                ["cause", bi("原因", "Root cause"), 2, 6, false],
                ["fix", bi("处理经过", "Resolution"), 3, 8, false],
              ] as const
            ).map(([k, label, min, max, mono]) => (
              <section key={k} className={"ad-wu-f ad-wu-" + k}>
                <h4>{label}</h4>
                <Input.TextArea
                  className={mono ? "mono" : ""}
                  autoSize={{ minRows: min, maxRows: max }}
                  value={draft[k] || ""}
                  onChange={(v) => setDraft({ ...draft, [k]: v })}
                  aria-label={label}
                />
              </section>
            ))}
            {draft.fix && (
              <p className="ad-wu-tip">
                {bi(
                  "命令用 ``` 围起来，会按代码显示。",
                  "Wrap commands in ``` to render as code blocks.",
                )}
              </p>
            )}
            <details className="ad-wu-more">
              <summary>{bi("关键证据", "Key evidence")}</summary>
              <Input.TextArea
                className="mono"
                autoSize={{ minRows: 2, maxRows: 8 }}
                value={draft.evidence || ""}
                onChange={(v) => setDraft({ ...draft, evidence: v })}
                aria-label={bi("关键证据", "Key evidence")}
              />
            </details>
            <details className="ad-wu-more">
              <summary>
                {bi("还要跟进的事（一行一条）", "Follow-ups (one per line)")}
              </summary>
              <Input.TextArea
                autoSize={{ minRows: 2, maxRows: 6 }}
                value={(draft.followups || []).join("\n")}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    followups: v.split("\n").filter((x) => x.trim()),
                  })
                }
                aria-label={bi("还要跟进的事", "Follow-ups")}
              />
            </details>
            <div className="ad-wu-opts">
              <label>
                <Checkbox
                  checked={draft.changed}
                  onChange={(v) => setDraft({ ...draft, changed: v })}
                >
                  {bi(
                    "这说明交付本身需要修改",
                    "This indicates the delivery itself needs changes",
                  )}
                </Checkbox>
              </label>
              {target.key.startsWith("step:") && (
                <label>
                  <Checkbox checked={markStep} onChange={setMarkStep}>
                    {bi(
                      "已核对执行结果，同时将这一步标记为完成",
                      "Verified output; also mark this step as completed",
                    )}
                  </Checkbox>
                </label>
              )}
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

const getHelloReview = () =>
  bi(
    "我会先读这份交付的执行手册和项目文件，再按严重程度指出问题：组件组合、单点、参数风险、步骤顺序和验证是否完备。也可以直接问你关心的事。",
    "I'll inspect this delivery's runbook and project files, then highlight issues by severity—component mix, SPOFs, parameter risks, step order, and verification gaps. Or ask anything directly.",
  );
const getSuggestReview = () => [
  bi(
    "评审这份交付，按严重程度列出问题",
    "Review this delivery and list issues by severity",
  ),
  bi("这套集群有没有单点？", "Does this cluster have any single points of failure?"),
  bi("上线前还缺哪些检查？", "What pre-launch checks are missing?"),
];
const getHelloStep = () =>
  bi(
    "这一步遇到报错，把它贴过来或直接粘贴截图；对这一步有疑问、想确认风险，也可以直接问。我会自己去看执行手册、项目文件和之前的执行记录，告诉你原因和下一步；需要改手册时会给出提案，你确认后才写进交付。",
    "Paste errors or screenshots here if this step failed, or ask about risks. I'll inspect the runbook, project files, and logs to explain the cause and next steps, and propose runbook edits for your approval when needed.",
  );
const getSuggestStep = () => [
  bi(
    "这一步会做什么？有什么风险？",
    "What does this step do and what are the risks?",
  ),
  bi("执行前要先确认什么？", "What should I verify before running this step?"),
  bi("如果失败了怎么回退？", "How do I roll back if this step fails?"),
];
const getHelloComp = () =>
  bi(
    "可以让我起草或补全这个组件、修复检查报出的错误、解释参数，或者评审风险。改动会先过平台检查和试生成，你采纳后才写入草稿，发布仍由你来做。",
    "Ask me to draft or complete this component, fix check errors, explain parameters, or review risks. Changes pass platform validation and dry-run before applying to your draft; publishing stays in your hands.",
  );
const getSuggestComp = () => [
  bi("看看这个组件还缺什么", "Check what's missing in this component"),
  bi("修复检查报出的错误", "Fix the validation errors"),
  bi("评审这个组件的风险", "Review risks in this component"),
];

function StepContext({ step }: { step: Record<string, unknown> }) {
  useLang();
  const title = String(step.title || "");
  const phase = step.phase ? String(step.phase) : "";
  const effect = String(step.effect || "");
  const hosts = Array.isArray(step.hosts) ? (step.hosts as string[]) : [];
  return (
    <div className="ad-ctx">
      <span className="ad-ctx-l">{bi("正在处理", "Step")}</span>
      <b title={title}>{title}</b>
      {phase && <span className="ad-tag">{phase}</span>}
      {effect && (
        <span className={`ad-tag e-${effect}`}>{EFFECT[effect] || effect}</span>
      )}
      {hosts.length > 0 && (
        <span className="ad-ctx-h">{hosts.join(" → ")}</span>
      )}
    </div>
  );
}

function ChatErrorDiag({
  diag,
  errText,
}: {
  diag: AICallDiag;
  errText: string;
}) {
  useLang();
  const hasTokens =
    diag.in_tokens != null ||
    diag.out_tokens != null ||
    diag.cached_tokens != null;
  const statusParts = [
    diag.http_status != null
      ? diag.http_status > 0
        ? `HTTP ${diag.http_status}`
        : bi("网络未连通", "Network unreachable")
      : "",
    diag.upstream_status
      ? bi(`上游 ${diag.upstream_status}`, `Upstream ${diag.upstream_status}`)
      : "",
    diag.reason_code ? reasonCodeLabel(diag.reason_code) : "",
  ].filter(Boolean);
  return (
    <div className="ad-err-diag">
      <div className="ad-err-diag-h">
        <span className="ad-err-diag-meta">
          <b>{bi("网关诊断明细", "Gateway diagnostics")}</b>
          {(diag.provider || diag.model) && (
            <small>
              {diag.provider && <span>{diag.provider}</span>}
              {diag.provider && diag.model && <span className="faint"> · </span>}
              {diag.model && <span className="mono">{diag.model}</span>}
            </small>
          )}
          {diag.fallback_used && (
            <em className="ad-err-fb">
              {bi("已回退", "Fallback")}{" "}
              <span className="mono">{diag.fallback_used}</span>
            </em>
          )}
        </span>
        <button
          type="button"
          className="ad-err-copy"
          onClick={() =>
            copy(
              formatAICallDiag(diag, {
                title: bi("AI 对话网关诊断", "AI Chat Gateway Diagnostics"),
                error: errText,
              }),
            )
          }
        >
          <IconCopy /> {bi("复制诊断", "Copy diagnostics")}
        </button>
      </div>
      <dl className="ad-err-dl">
        {(diag.endpoint || diag.api) && (
          <>
            <dt>{bi("协议端点", "Endpoint")}</dt>
            <dd className="mono">{diag.endpoint || diag.api}</dd>
          </>
        )}
        {statusParts.length > 0 && (
          <>
            <dt>{bi("HTTP 状态", "HTTP status")}</dt>
            <dd>{statusParts.join(" · ")}</dd>
          </>
        )}
        {diag.ms != null && (
          <>
            <dt>{bi("耗时", "Latency")}</dt>
            <dd className="num">{diag.ms} ms</dd>
          </>
        )}
        {hasTokens && (
          <>
            <dt>Token</dt>
            <dd className="num">
              {bi(`输入 ${diag.in_tokens ?? 0}`, `In ${diag.in_tokens ?? 0}`)}
              {diag.cached_tokens != null
                ? bi(
                    ` · 缓存 ${diag.cached_tokens}`,
                    ` · Cached ${diag.cached_tokens}`,
                  )
                : ""}
              {bi(
                ` · 输出 ${diag.out_tokens ?? 0}`,
                ` · Out ${diag.out_tokens ?? 0}`,
              )}
            </dd>
          </>
        )}
        {diag.response_id && (
          <>
            <dt>{bi("响应 ID", "Response ID")}</dt>
            <dd className="mono">{diag.response_id}</dd>
          </>
        )}
        {diag.sse_events && diag.sse_events.length > 0 && (
          <>
            <dt>{bi("SSE 事件", "SSE events")}</dt>
            <dd>
              <span className="mono">{diag.sse_events.join(" → ")}</span>
              {diag.keepalives ? (
                <span className="faint">
                  {bi(
                    `（心跳 ${diag.keepalives} 次）`,
                    ` (${diag.keepalives} keepalive${diag.keepalives === 1 ? "" : "s"})`,
                  )}
                </span>
              ) : null}
            </dd>
          </>
        )}
      </dl>
      {diag.attempts && diag.attempts.length > 0 && (
        <div className="ad-err-sec">
          <div className="ad-err-sec-t">
            {bi(
              `尝试链路（${diag.attempts.length} 次）`,
              `Attempt trace (${diag.attempts.length})`,
            )}
          </div>
          <ol className="ad-err-attempts">
            {diag.attempts.map((a, idx) => (
              <li key={idx}>
                <span className="ad-err-att-api">{a.api}</span>
                <code className="ad-err-att-ep">{a.endpoint}</code>
                <span
                  className={`ad-err-att-st ${a.http_status && a.http_status >= 200 && a.http_status < 300 ? "ok" : "bad"}`}
                >
                  {a.http_status
                    ? `HTTP ${a.http_status}`
                    : bi("连接失败", "Connection failed")}
                </span>
                <span className="num">{a.ms} ms</span>
                {(a.in_tokens != null || a.out_tokens != null) && (
                  <span className="num">
                    ↓{a.in_tokens ?? 0}
                    {a.cached_tokens
                      ? bi(` 缓${a.cached_tokens}`, ` c:${a.cached_tokens}`)
                      : ""}{" "}
                    ↑{a.out_tokens ?? 0}
                  </span>
                )}
                {a.upstream_status && (
                  <span>
                    {bi(
                      `状态 ${a.upstream_status}`,
                      `Status ${a.upstream_status}`,
                    )}
                  </span>
                )}
                {a.response_id && <code className="faint">{a.response_id}</code>}
                {(a.reason || a.request_note) && (
                  <span className="ad-err-att-why">
                    {a.reason || a.request_note}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {diag.request_summary && (
        <div className="ad-err-sec">
          <div className="ad-err-sec-t">
            {bi("请求参数摘要", "Request summary")}
          </div>
          <pre className="ad-err-raw">
            {prettyDiagPayload(diag.request_summary)}
          </pre>
        </div>
      )}
      {diag.response_raw && (
        <div className="ad-err-sec">
          <div className="ad-err-sec-t">
            {bi("网关原始响应", "Gateway raw response")}
          </div>
          <pre className="ad-err-raw">
            {prettyDiagPayload(diag.response_raw)}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Sends a message and folds the events of the answer into `cur` as they arrive; `push` says to draw it again. */
export async function streamChat(
  url: string,
  body: unknown,
  signal: AbortSignal,
  cur: Live,
  push: () => void,
  onProposal?: (id: string) => Promise<unknown>,
  onOther?: (e: { t: string; v?: unknown; target?: unknown }) => void,
) {
  const r = await fetch(withLang(url), {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken(),
      "X-Lang": getLang(),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) {
    const d = await r.json().catch(() => ({}));
    const errObj = new Error(
      d.error || bi(`请求失败（${r.status}）`, `Request failed (${r.status})`),
    ) as ChatStreamError;
    if (d && typeof d === "object" && d.diag) {
      errObj.diag = d.diag as AICallDiag;
    }
    throw errObj;
  }
  const rd = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (!line.startsWith("data:")) continue;
      const e = JSON.parse(line.slice(5));
      switch (e.t) {
        case "reset":
          cur.text = "";
          cur.steps = [];
          cur.tools = [];
          cur.thinking = "";
          cur.looking = true;
          cur.model = e.model;
          break;
        case "think":
          cur.thinking += e.v;
          cur.looking = true;
          break;
        case "thinkdone":
          cur.steps.push({ kind: "think", text: cur.thinking, ms: e.ms });
          cur.thinking = "";
          break;
        case "thought-hidden":
          cur.steps.push({
            kind: "think",
            summary: bi(
              `用了 ${e.n} 个思考 token，这个模型不公开思考内容`,
              `Used ${e.n} thinking tokens (reasoning hidden by model)`,
            ),
            ms: e.ms,
          });
          break;
        case "text":
          cur.text += e.v;
          cur.looking = false;
          break;
        case "thought":
          // what was streamed as the answer was in fact the assistant thinking aloud before it looked
          cur.steps.push({ kind: "thought", text: e.v });
          cur.text = "";
          cur.looking = true;
          break;
        case "tool":
          cur.tools.push(e.v);
          cur.looking = true;
          break;
        case "step":
          cur.steps.push({
            kind: e.kind || "tool",
            id: e.id,
            name: e.name,
            args: e.args,
            running: true,
          });
          break;
        case "stepdone": {
          const st = cur.steps.find((x) => x.id === e.id);
          if (st)
            Object.assign(st, {
              running: false,
              summary: e.summary,
              ms: e.ms,
              ok: e.ok,
              preview: e.preview,
            });
          break;
        }
        case "notice":
          cur.notice = e.v;
          break;
        case "files":
          cur.files = [...(cur.files || []), ...e.v];
          break;
        case "ask":
          cur.ask = e.v;
          break;
        case "sandbox_confirm":
          cur.sandboxConfirms = [
            ...(cur.sandboxConfirms || []).filter((x) => x.id !== e.v?.id),
            e.v as SandboxConfirm,
          ];
          break;
        case "sandbox_confirmed":
          cur.sandboxConfirms = (cur.sandboxConfirms || []).filter(
            (x) => x.id !== e.id,
          );
          break;
        case "proposal":
          cur.made.push(e.v);
          await onProposal?.(e.v);
          break;
        case "error": {
          const errObj = new Error(
            e.v || bi("模型调用失败", "Model call failed"),
          ) as ChatStreamError;
          if (e.diag) errObj.diag = e.diag as AICallDiag;
          throw errObj;
        }
        default:
          // events only one page understands (the new-delivery form is told what to fill in)
          onOther?.(e);
      }
      push();
    }
  }
}

/** Conversations kept before steps were recorded only know which tools were used. */
function Activity({ tools }: { tools: string[] }) {
  useLang();
  const counts = new Map<string, number>();
  tools.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
  const looked = [...counts.entries()].filter(
    ([t]) => !t.startsWith("propose"),
  );
  if (!looked.length) return null;
  return (
    <div className="ad-act">
      <IconCheck /> {bi("查看了", "Checked")}{" "}
      {looked
        .map(([t, n]) => (n > 1 ? `${TOOL[t] || t} ×${n}` : TOOL[t] || t))
        .join(bi("、", ", "))}
    </div>
  );
}

export function Bubble({
  m,
  jobBase,
  props,
  deciding,
  decide,
  comp,
  answer,
}: {
  answer?: (text: string) => void;
  m: Msg;
  jobBase: string;
  props: Record<string, StepProposal | CompProposal>;
  deciding: string;
  decide: (id: string, v: "accept" | "reject") => void;
  comp: boolean;
}) {
  useLang();
  const [copied, setCopied] = useState(false);
  if (m.role === "user")
    return (
      <div className="ad-msg user">
        {m.images && m.images.length > 0 && (
          <div className="ad-imgs">
            {m.images.map((im, k) => (
              <a
                key={k}
                href={
                  im.startsWith("data:")
                    ? undefined
                    : withLang(`${jobBase}/img/${im}`)
                }
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src={
                    im.startsWith("data:") ? im : withLang(`${jobBase}/img/${im}`)
                  }
                  alt={bi(`截图 ${k + 1}`, `Screenshot ${k + 1}`)}
                />
              </a>
            ))}
          </div>
        )}
        {m.files && m.files.length > 0 && (
          <div className="ad-files">
            {m.files.map((f) =>
              f.mime?.startsWith("image/") ? (
                <a
                  key={f.id}
                  className="img"
                  href={withLang(`/api/me/files/${f.id}/raw`)}
                  target="_blank"
                  rel="noreferrer"
                  title={f.name}
                >
                  <img
                    src={withLang(`/api/me/files/${f.id}/raw`)}
                    alt={f.name}
                    loading="lazy"
                  />
                </a>
              ) : (
                <a
                  key={f.id}
                  className="doc"
                  href={withLang(`/api/me/files/${f.id}/raw?download=1`)}
                  title={f.name}
                >
                  <IconFile />
                  <span>{f.name}</span>
                </a>
              ),
            )}
          </div>
        )}
        {m.text && <div className="ad-u">{m.text}</div>}
        {m.at && (
          <time className="ad-time" title={fullTime(m.at)}>
            {m.by ? `${m.by} · ` : ""}
            {ago(m.at)}
          </time>
        )}
      </div>
    );
  return (
    <div className="ad-msg ai">
      <span className="ad-avatar" aria-hidden>
        <AIEmblem size={24} />
      </span>
      <div className="ad-a">
        {m.steps && m.steps.length > 0 ? (
          <Process steps={m.steps} ms={m.ms} />
        ) : m.tools && m.tools.length > 0 ? (
          <Activity tools={m.tools} />
        ) : null}
        {m.text && <Markdown text={m.text} />}
        {m.files && m.files.length > 0 && <MadeFiles files={m.files} />}
        {m.ask && <AskCard ask={m.ask} answer={answer} />}
        {(m.proposals || []).map(
          (id) =>
            props[id] && (
              <Card
                key={id}
                p={props[id]}
                comp={comp}
                busy={deciding === id}
                decide={decide}
                feedback={answer}
                ask={answer}
              />
            ),
        )}
        <div className="ad-acts">
          <button
            type="button"
            onClick={() => {
              copy(m.text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? <IconCheck /> : <IconCopy />}{" "}
            {copied ? bi("已复制", "Copied") : bi("复制", "Copy")}
          </button>
          {m.at && (
            <time title={fullTime(m.at)} className="ad-time">
              {ago(m.at)}
            </time>
          )}
        </div>
      </div>
    </div>
  );
}

/** Questions the assistant asks instead of guessing: pick an option or type an answer; the answer goes back as the next message. */
export function AskCard({
  ask,
  answer,
}: {
  ask: Ask;
  answer?: (text: string) => void;
}) {
  useLang();
  const [pick, setPick] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const live = !!answer;
  // one question with one choice: the choice is the answer, no extra button to press
  const instant = ask.questions.length === 1 && !ask.questions[0].multi;
  const value = (qi: number, p = pick, o = other) => [
    ...(p[qi] || []),
    ...(o[qi]?.trim() ? [o[qi].trim()] : []),
  ];
  const ready = ask.questions.every((_, i) => value(i).length > 0);
  const submit = (p = pick, o = other) =>
    answer?.(
      ask.questions
        .map(
          (_, i) =>
            (ask.questions.length > 1 ? String(i + 1) + ". " : "") +
            value(i, p, o).join(bi("、", ", ")),
        )
        .join("\n"),
    );
  const toggle = (qi: number, label: string, multi?: boolean) => {
    const cur = pick[qi] || [];
    const next = {
      ...pick,
      [qi]: multi
        ? cur.includes(label)
          ? cur.filter((x) => x !== label)
          : [...cur, label]
        : [label],
    };
    setPick(next);
    if (instant && !multi) submit(next, {});
  };
  return (
    <div
      className={`ad-ask ${live ? "" : "done"}`}
      role="group"
      aria-label={bi("AI 的提问", "Questions from AI")}
    >
      {ask.questions.map((q, qi) => (
        <fieldset key={qi} disabled={!live}>
          <legend>
            <span className="ad-ask-n" aria-hidden>
              {ask.questions.length > 1 ? qi + 1 : "?"}
            </span>
            {q.question}
            {q.multi && <small>{bi("可多选", "Multi-select")}</small>}
          </legend>
          {(q.options || []).length > 0 && (
            <div
              className="ad-ask-opts"
              role={q.multi ? "group" : "radiogroup"}
            >
              {(q.options || []).map((o) => {
                const on = (pick[qi] || []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    className={on ? "on" : ""}
                    role={q.multi ? "checkbox" : "radio"}
                    aria-checked={on}
                    onClick={() => toggle(qi, o.label, q.multi)}
                  >
                    <span className="ad-ask-tick" aria-hidden>
                      {on && <IconCheck />}
                    </span>
                    <span className="ad-ask-txt">
                      <b>{o.label}</b>
                      {o.description && <small>{o.description}</small>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {live &&
            ((q.options || []).length === 0 ||
            otherOpen[qi] ||
            Boolean(other[qi]?.trim()) ? (
              <div className="ad-ask-other">
                <input
                  type="text"
                  autoFocus={Boolean(otherOpen[qi])}
                  value={other[qi] || ""}
                  onChange={(e) =>
                    setOther({ ...other, [qi]: e.target.value })
                  }
                  onKeyDown={(e) =>
                    e.key === "Enter" &&
                    !e.nativeEvent.isComposing &&
                    ready &&
                    (e.preventDefault(), submit())
                  }
                  placeholder={
                    (q.options || []).length
                      ? bi(
                          "补充或填写其他现场情况…",
                          "Add details or specify another option…",
                        )
                      : bi("写下你的回答…", "Type your answer…")
                  }
                  aria-label={bi(`${q.question} 自己写`, `${q.question} custom answer`)}
                />
                {instant && other[qi]?.trim() && (
                  <button
                    type="button"
                    className="ad-ask-go"
                    onClick={() => submit()}
                    aria-label={bi("发送这个回答", "Submit answer")}
                  >
                    <IconSend />
                  </button>
                )}
                {(q.options || []).length > 0 && !other[qi]?.trim() && (
                  <button
                    type="button"
                    className="ad-ask-cancel"
                    onClick={() =>
                      setOtherOpen((prev) => ({ ...prev, [qi]: false }))
                    }
                  >
                    {bi("收起", "Collapse")}
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                className="ad-ask-custom-btn"
                onClick={() =>
                  setOtherOpen((prev) => ({ ...prev, [qi]: true }))
                }
              >
                <IconPlus />
                <span>{bi("其他情况 / 自由说明", "Other / custom note")}</span>
              </button>
            ))}
        </fieldset>
      ))}
      {live && !instant && (
        <div className="ad-ask-acts">
          <Button
            type="primary"
            size="small"
            disabled={!ready}
            onClick={() => submit()}
          >
            {bi("提交回答", "Submit answers")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** What the assistant made for the person: documents and pictures kept in "我的资料 / AI 生成". */
export function MadeFiles({ files }: { files: MsgFile[] }) {
  useLang();
  return (
    <div className="ad-made" aria-label={bi("AI 生成的文件", "Files generated by AI")}>
      {files.map((f) => (
        <a
          key={f.id}
          href={withLang(`/api/me/files/${f.id}/raw?download=1`)}
          className="ad-made-i"
          title={bi("下载", "Download")}
        >
          {f.mime?.startsWith("image/") ? (
            <img
              src={withLang(`/api/me/files/${f.id}/raw`)}
              alt=""
              loading="lazy"
            />
          ) : (
            <IconFile />
          )}
          <span>
            <b>{f.name}</b>
            <small>
              {f.size
                ? f.size >= 1 << 20
                  ? `${(f.size / (1 << 20)).toFixed(1)} MB`
                  : `${Math.max(1, Math.round(f.size / 1024))} KB`
                : ""}{" "}
              {bi("· 已存入「我的资料」", "· Saved to My Files")}
            </small>
          </span>
          <IconDownload />
        </a>
      ))}
    </div>
  );
}

export function SandboxConfirmCard({ req }: { req: SandboxConfirm }) {
  useLang();
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState("");
  const [showCode, setShowCode] = useState(
    req.kind === "python" || req.kind === "shell",
  );
  const canNet = !!req.want_net && req.net_policy !== "deny";

  const submit = async (
    decision: "allow" | "allow_offline" | "allow_session" | "deny",
  ) => {
    setBusy(decision);
    try {
      await api("/api/ai/sandbox/approve", {
        method: "POST",
        body: JSON.stringify({ id: req.id, decision }),
      });
      setDone(decision);
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };

  if (done) {
    return (
      <div className="ad-sbc done" role="status">
        <IconCheck />
        <span>
          {done === "deny"
            ? bi("已拒绝本次沙箱执行", "Sandbox execution denied")
            : done === "allow_offline"
              ? bi("已授权离线沙箱执行", "Approved offline sandbox execution")
              : done === "allow_session"
                ? bi(
                    "已授权本会话内沙箱执行",
                    "Approved sandbox execution for this chat",
                  )
                : canNet
                  ? bi(
                      "已授权联网沙箱执行",
                      "Approved sandbox execution with network",
                    )
                  : bi("已授权沙箱执行", "Approved sandbox execution")}
        </span>
      </div>
    );
  }

  return (
    <div
      className="ad-sbc"
      role="region"
      aria-label={bi("沙箱运行授权", "Sandbox execution approval")}
    >
      <div className="ad-sbc-h">
        <span className="ad-sbc-ic">
          <IconSafe />
        </span>
        <div className="ad-sbc-title">
          <b>
            {req.title ||
              bi(
                "请求在隔离沙箱中运行代码",
                "Request to run code in isolated sandbox",
              )}
          </b>
          {req.purpose && <small>{req.purpose}</small>}
        </div>
        <span className={`ad-sbc-tag ${canNet ? "net" : ""}`}>
          {canNet
            ? bi("请求外网", "Network requested")
            : bi("离线隔离", "Offline isolated")}
        </span>
      </div>
      {(req.reasons || []).length > 0 && (
        <ul className="ad-sbc-reasons">
          {req.reasons!.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {req.files && req.files.length > 0 && (
        <div className="ad-sbc-files">
          <span>{bi("只读挂载文件：", "Read-only input files: ")}</span>
          {req.files.map((f) => (
            <code key={f} className="mono">
              {f}
            </code>
          ))}
        </div>
      )}
      {req.workspace && (
        <div className="ad-sbc-files">
          <span>{bi("只读工作区：", "Read-only workspace: ")}</span>
          <code className="mono">{req.workspace} → /workspace</code>
        </div>
      )}
      {req.code && (
        <div className="ad-sbc-code">
          <button
            type="button"
            className="ad-sbc-toggle"
            onClick={() => setShowCode(!showCode)}
            aria-expanded={showCode}
          >
            <IconCode />
            <span>
              {showCode
                ? req.kind === "shell"
                  ? bi("收起待执行命令", "Hide command")
                  : bi("收起待执行代码", "Hide code")
                : req.kind === "shell"
                  ? bi("查看待执行命令", "View command")
                  : bi("查看待执行代码", "View code")}
            </span>
            <IconDown className={showCode ? "ad-flip" : ""} />
          </button>
          {showCode && <pre className="mono">{req.code}</pre>}
        </div>
      )}
      <div className="ad-sbc-acts">
        <Button
          size="small"
          type="primary"
          loading={busy === "allow"}
          disabled={busy !== ""}
          onClick={() => submit("allow")}
        >
          {canNet
            ? bi("允许联网运行", "Allow with network")
            : bi("允许运行", "Allow")}
        </Button>
        {canNet && (
          <Button
            size="small"
            loading={busy === "allow_offline"}
            disabled={busy !== ""}
            onClick={() => submit("allow_offline")}
          >
            {bi("仅离线运行", "Run offline only")}
          </Button>
        )}
        {!canNet && (
          <Button
            size="small"
            loading={busy === "allow_session"}
            disabled={busy !== ""}
            onClick={() => submit("allow_session")}
          >
            {bi("本会话不再询问", "Allow for this chat")}
          </Button>
        )}
        <Button
          size="small"
          status="danger"
          type="text"
          loading={busy === "deny"}
          disabled={busy !== ""}
          onClick={() => submit("deny")}
        >
          {bi("拒绝", "Deny")}
        </Button>
      </div>
    </div>
  );
}

export function LiveBubble({
  live,
  props,
  deciding,
  decide,
  comp,
}: {
  live: Live;
  props: Record<string, StepProposal | CompProposal>;
  deciding: string;
  decide: (id: string, v: "accept" | "reject") => void;
  comp: boolean;
}) {
  useLang();
  return (
    <div className="ad-msg ai live">
      <span className="ad-avatar thinking" aria-hidden>
        <AIEmblem size={24} />
      </span>
      <div className="ad-a">
        {live.notice && <div className="ad-notice">{live.notice}</div>}
        <Process
          steps={live.steps}
          live
          t0={live.t0}
          thinking={live.thinking}
        />
        {(live.sandboxConfirms || []).map((c) => (
          <SandboxConfirmCard key={c.id} req={c} />
        ))}
        {live.text && (
          <Markdown
            text={live.text}
            className={live.looking ? "" : "streaming"}
          />
        )}
        {live.files && live.files.length > 0 && (
          <MadeFiles files={live.files} />
        )}
        {live.ask && <AskCard ask={live.ask} />}
        {/* the cards come with the finished answer, not while it is still being written */}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- proposals */

/** A problem was solved that the component should have caught: take it to the component workbench, where the component's
 *  assistant drafts the change and the person reviews and saves it. */
function SuggestCard({
  s,
  busy,
  decide,
}: {
  s: StepProposal;
  busy: boolean;
  decide: (id: string, v: "accept" | "reject") => void;
}) {
  useLang();
  const comp = s.after_title || "";
  const openWorkbench = () => {
    const child = window.open("about:blank", "_blank");
    if (!child) {
      Message.warning(
        bi(
          "浏览器拦截了新标签页，请允许弹出窗口后重试；当前交付已保留。",
          "Pop-up blocked by browser; allow pop-ups and retry (current delivery is preserved).",
        ),
      );
      return false;
    }
    try {
      child.sessionStorage.setItem(
        "mh-wb-prefill",
        JSON.stringify({
          name: comp,
          text: bi(
            [
              "这次交付遇到一个组件应预先检查的问题。",
              "问题：" + s.reason,
              "建议：" + s.step.title,
              "详情：" + (s.step.desc || ""),
              "请先读当前组件的相关文件，用 edits 提议最小修改并通过检查；不要直接发布。",
            ].join("\n"),
            [
              "This delivery hit an issue the component should pre-check.",
              "Issue: " + s.reason,
              "Suggestion: " + s.step.title,
              "Details: " + (s.step.desc || ""),
              "Read the relevant component files first, propose minimal edits that pass checks, and do not publish directly.",
            ].join("\n"),
          ),
        }),
      );
      child.opener = null;
      child.location.replace(window.location.origin + window.location.pathname + "#/components/" + encodeURIComponent(comp) + "/edit/overview");
      return true;
    } catch {
      child.close();
      Message.error(
        bi(
          "无法打开组件工作台，请重试；当前交付未离开。",
          "Unable to open Component Workbench; please retry.",
        ),
      );
      return false;
    }
  };
  const take = () => {
    if (openWorkbench()) decide(s.id, "accept");
  };
  const done = s.status !== "pending";
  return (
    <article className={`ad-card s-${s.status}`}>
      <header>
        <span className="ad-card-k">
          {bi("组件改进建议", "Component improvement")}
        </span>
        <span className="ad-card-m">{comp}</span>
      </header>
      <p className="ad-card-t">{s.step.title}</p>
      {s.step.desc && <p className="ad-card-d">{s.step.desc}</p>}
      <dl className="ad-card-dl">
        <dt>{bi("缘由", "Reason")}</dt>
        <dd>{s.reason}</dd>
      </dl>
      {done ? (
        <div className={`ad-card-done ad-suggest-done s-${s.status}`}>
          <span className="ad-suggest-status">
            {s.status === "accepted"
              ? bi(
                  `${s.decided_by} 已转到组件工作台处理`,
                  `${s.decided_by} opened in Component Workbench`,
                )
              : bi(
                  `${s.decided_by} 认为不需要`,
                  `${s.decided_by} dismissed`,
                )}
          </span>
          {s.status === "accepted" && can("component.edit") && (
            <Button size="small" type="text" onClick={openWorkbench}>
              {bi("新标签页打开组件工作台", "Open Component Workbench")}
            </Button>
          )}
        </div>
      ) : (
        <div className="ad-card-acts">
          {can("component.edit") ? (
            <Button size="small" type="primary" loading={busy} onClick={take}>
              {bi("新标签页打开，让 AI 起草", "Open in new tab for AI draft")}
            </Button>
          ) : (
            <span className="faint small">
              {bi(
                "需要有组件编辑权限的人处理",
                "Requires component edit permission",
              )}
            </span>
          )}
          <Button
            size="small"
            disabled={busy}
            onClick={() => decide(s.id, "reject")}
          >
            {bi("不需要", "Dismiss")}
          </Button>
        </div>
      )}
    </article>
  );
}

/** A change to one file of the delivery's own automation: the diff, why, and what happens when it is accepted. */
function FileCard({
  s,
  busy,
  decide,
  feedback,
}: {
  s: StepProposal;
  busy: boolean;
  decide: (id: string, v: "accept" | "reject") => void;
  feedback?: (text: string) => void;
}) {
  useLang();
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState("");
  const f = s.file;
  const done = s.status !== "pending";
  return (
    <article className={`ad-card s-${s.status}`}>
      <header>
        <span className="ad-card-k">
          {bi("修改自动化文件", "Edit automation file")}
        </span>
        <span className="ad-card-m">
          {bi("只改这一份交付", "This delivery only")}
        </span>
      </header>
      <p className="ad-card-t">
        <code>{f?.path}</code>
        {f?.new && <span className="ad-tag">{bi("新增", "New")}</span>}
      </p>
      {f?.diff && <CodeBlock text={f.diff} caption={bi("差异", "Diff")} />}
      <dl className="ad-card-dl">
        <dt>{bi("缘由", "Reason")}</dt>
        <dd>{s.reason}</dd>
      </dl>
      {done ? (
        <div className={`ad-card-done s-${s.status}`}>
          <span className="ad-card-verdict">
            {s.status === "accepted" ? <IconCheck /> : null}
            <span>
              {s.decided_by}{" "}
              {s.status === "accepted"
                ? bi("已采纳", "accepted")
                : bi("已拒绝", "rejected")}
            </span>
          </span>
          {s.status === "accepted" && (
            <span className="ad-card-where">
              {bi(
                "已生成更新包，在页面「现场执行」上方按提示放到控制节点，之后这份交付的自动化就是改过的样子。",
                "Update bundle generated—follow the instructions above Field Execution to place it on the control node.",
              )}
            </span>
          )}
        </div>
      ) : rejecting ? (
        <div className="ad-card-why">
          <b>
            {bi(
              "不采纳的原因？告诉 AI，它会据此调整",
              "Why reject? Tell AI so it can adjust",
            )}
          </b>
          <Input.TextArea
            value={why}
            onChange={setWhy}
            autoSize={{ minRows: 2, maxRows: 5 }}
            aria-label={bi("不采纳的原因", "Reason for rejection")}
          />
          <div className="ad-card-acts">
            <Button
              size="small"
              type="primary"
              disabled={!why.trim()}
              onClick={() => {
                decide(s.id, "reject");
                setRejecting(false);
                feedback?.(
                  bi(
                    `我没有采纳这个文件修改：${why.trim()}`,
                    `I rejected this file edit: ${why.trim()}`,
                  ),
                );
              }}
            >
              {bi("发给 AI", "Send to AI")}
            </Button>
            <Button size="small" onClick={() => decide(s.id, "reject")}>
              {bi("只拒绝", "Reject only")}
            </Button>
            <Button
              size="small"
              type="text"
              onClick={() => setRejecting(false)}
            >
              {bi("取消", "Cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="ad-card-acts">
          <Button
            size="small"
            type="primary"
            loading={busy}
            onClick={() => decide(s.id, "accept")}
          >
            {bi("采纳，生成更新包", "Accept & build update")}
          </Button>
          <Button
            size="small"
            disabled={busy}
            onClick={() =>
              feedback ? setRejecting(true) : decide(s.id, "reject")
            }
          >
            {bi("不采纳", "Reject")}
          </Button>
        </div>
      )}
    </article>
  );
}

const getWhyNot = () => [
  bi(
    "命令不对，我来补充说明",
    "Command is wrong—let me clarify",
  ),
  bi(
    "不是这个原因，请继续排查",
    "Wrong root cause—keep investigating",
  ),
  bi(
    "我想手动处理，只告诉我步骤和风险",
    "I'll handle it manually—just tell me the steps and risks",
  ),
];

export function Card({
  p,
  comp,
  busy,
  decide,
  feedback,
  ask,
}: {
  /** Puts a question to the assistant (from the "?" beside a warning). */
  ask?: (text: string) => void;
  p: StepProposal | CompProposal;
  comp: boolean;
  busy: boolean;
  decide: (id: string, v: "accept" | "reject") => void;
  /** Sends the person's words to the assistant, so a refused card leads to a better one rather than a dead end. */
  feedback?: (text: string) => void;
}) {
  useLang();
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState("");
  const done = p.status !== "pending";
  const verdict =
    p.status === "accepted"
      ? bi(`${p.decided_by} 已采纳`, `${p.decided_by} accepted`)
      : p.status === "rejected"
        ? bi(`${p.decided_by} 已拒绝`, `${p.decided_by} rejected`)
        : p.status === "withdrawn"
          ? bi("已撤销", "Withdrawn")
          : "";
  const reject = (text: string) => {
    decide(p.id, "reject");
    setRejecting(false);
    if (feedback && text.trim())
      feedback(
        bi(
          `我没有采纳这个提案：${text.trim()}`,
          `I rejected this proposal: ${text.trim()}`,
        ),
      );
  };
  const acts =
    !done && rejecting ? (
      <div className="ad-card-why">
        <b>
          {bi(
            "不采纳的原因？告诉 AI，它会据此调整",
            "Why reject? Tell AI so it can adjust",
          )}
        </b>
        <div className="ad-card-opts">
          {getWhyNot().map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setWhy(o + bi("：", ": "))}
            >
              {o}
            </button>
          ))}
        </div>
        <Input.TextArea
          value={why}
          onChange={setWhy}
          autoSize={{ minRows: 2, maxRows: 5 }}
          placeholder={bi(
            "写下你的想法，例如现场的实际情况、你想怎么做",
            "Explain the situation on site or what you'd prefer",
          )}
          aria-label={bi("不采纳的原因", "Reason for rejection")}
        />
        <div className="ad-card-acts">
          <Button
            size="small"
            type="primary"
            disabled={!why.trim()}
            onClick={() => reject(why)}
          >
            {bi("发给 AI", "Send to AI")}
          </Button>
          <Button size="small" onClick={() => reject("")}>
            {bi("只拒绝，不说明", "Reject silently")}
          </Button>
          <Button size="small" type="text" onClick={() => setRejecting(false)}>
            {bi("取消", "Cancel")}
          </Button>
        </div>
      </div>
    ) : !done ? (
      <div className="ad-card-acts">
        <Button
          size="small"
          type="primary"
          loading={busy}
          onClick={() => decide(p.id, "accept")}
        >
          {comp
            ? bi("采纳，写入草稿", "Accept to draft")
            : bi("采纳，写入交付", "Accept to delivery")}
        </Button>
        <Button
          size="small"
          disabled={busy}
          onClick={() =>
            feedback ? setRejecting(true) : decide(p.id, "reject")
          }
        >
          {bi("不采纳", "Reject")}
        </Button>
      </div>
    ) : (
      <div className={`ad-card-done s-${p.status}`}>
        <span className="ad-card-verdict">
          {p.status === "accepted" ? <IconCheck /> : null}
          <span>{verdict}</span>
        </span>
        {p.status === "accepted" && (
          <span className="ad-card-result">
            {comp
              ? bi("已写入草稿", "Applied to draft")
              : bi("已写入执行手册和交付文档", "Applied to runbook & delivery docs")}
          </span>
        )}
        {p.status === "accepted" && !comp && (
          <span className="ad-card-where">
            {bi(
              `在「${PHASE[(p as StepProposal).phase] || (p as StepProposal).phase}」阶段${
                (p as StepProposal).kind === "replace"
                  ? `的「${(p as StepProposal).step.title}」这一步`
                  : (p as StepProposal).after_title
                    ? `「${(p as StepProposal).after_title}」之后`
                    : "的末尾"
              }，由你在现场执行。`,
              `In phase "${PHASE[(p as StepProposal).phase] || (p as StepProposal).phase}"${
                (p as StepProposal).kind === "replace"
                  ? ` (step "${(p as StepProposal).step.title}")`
                  : (p as StepProposal).after_title
                    ? ` after "${(p as StepProposal).after_title}"`
                    : " at end of phase"
              }, ready for execution.`,
            )}
            <button
              type="button"
              className="link"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("mh-runbook-focus", {
                    detail: { title: (p as StepProposal).step.title },
                  }),
                )
              }
            >
              {bi("去看这一步", "View step")}
            </button>
          </span>
        )}
      </div>
    );
  if (comp) {
    const c = p as CompProposal;
    return (
      <article className={`ad-card s-${c.status}`}>
        <header>
          <span className="ad-card-k">{bi("改动提案", "Edit proposal")}</span>
          <span className="ad-card-m">
            {bi(
              `${c.files.length} 个文件`,
              `${c.files.length} file${c.files.length === 1 ? "" : "s"}`,
            )}
          </span>
        </header>
        <p className="ad-card-t">{c.summary}</p>
        <ul className="ad-files">
          {c.files.map((f) => (
            <li key={f.path}>
              <details open={c.files.length <= 3}>
                <summary>
                  <span className={`ad-op o-${f.op}`}>{OP[f.op] || f.op}</span>
                  <code>{f.path}</code>
                </summary>
                {f.diff && <CodeBlock text={f.diff} caption={bi("差异", "Diff")} />}
              </details>
            </li>
          ))}
        </ul>
        {c.trial && (
          <p className="ad-card-ok">
            <IconCheck /> {bi("平台检查通过", "Platform check passed")} · {c.trial}
          </p>
        )}
        {c.warnings && c.warnings.length > 0 && (
          <details className="ad-card-warn">
            <summary>
              {bi(
                `仍有 ${c.warnings.length} 条提示需要留意`,
                `${c.warnings.length} warning${c.warnings.length === 1 ? "" : "s"} to review`,
              )}
            </summary>
            <ul>
              {c.warnings.map((w) => (
                <li key={w}>
                  <span>{w.replace(/^- /, "")}</span>
                  {ask && (
                    <Tooltip
                      content={bi(
                        "问 AI：这条提示要不要处理",
                        "Ask AI whether this warning needs action",
                      )}
                      mini
                    >
                      <button
                        type="button"
                        className="cs-q"
                        aria-label={bi("问 AI 这条提示", "Ask AI about this warning")}
                        onClick={() =>
                          ask(
                            bi(
                              `请解释这条提示：它是什么意思、对这个组件有没有影响、需不需要处理、怎么处理。\n${w.replace(/^- /, "")}`,
                              `Explain this warning: what does it mean, does it impact the component, should it be fixed, and how?\n${w.replace(/^- /, "")}`,
                            ),
                          )
                        }
                      >
                        <IconQuestionCircle />
                      </button>
                    </Tooltip>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        {acts}
      </article>
    );
  }
  const s = p as StepProposal;
  if (s.kind === "component")
    return <SuggestCard s={s} busy={busy} decide={decide} />;
  if (s.kind === "file")
    return <FileCard s={s} busy={busy} decide={decide} feedback={feedback} />;
  const change = s.kind === "replace";
  return (
    <article className={`ad-card s-${s.status}`}>
      <header>
        <span className="ad-card-k">
          {change ? bi("修改这一步", "Modify step") : bi("新增一步", "Add step")}
        </span>
        <span className="ad-card-m">
          {PHASE[s.phase] || s.phase}
          {change
            ? ""
            : s.after_title
              ? bi(` · 放在「${s.after_title}」之后`, ` · after "${s.after_title}"`)
              : bi(" · 放在阶段末尾", " · at end of phase")}
        </span>
      </header>
      <p className="ad-card-t">
        {s.step.title}
        <span className={`ad-tag e-${s.step.effect}`}>
          {EFFECT[s.step.effect] || s.step.effect}
        </span>
      </p>
      {s.step.desc && <p className="ad-card-d">{s.step.desc}</p>}
      <CodeBlock
        text={s.step.command}
        caption={bi(
          `在 ${s.step.hosts.join("、")} 上执行`,
          `Run on ${s.step.hosts.join(", ")}`,
        )}
      />
      <dl className="ad-card-dl">
        {s.step.expect && (
          <>
            <dt>{bi("通过标准", "Expected")}</dt>
            <dd>{s.step.expect}</dd>
          </>
        )}
        {s.step.rollback && (
          <>
            <dt>{bi("回退", "Rollback")}</dt>
            <dd>{s.step.rollback}</dd>
          </>
        )}
        <dt>{bi("缘由", "Reason")}</dt>
        <dd>{s.reason}</dd>
      </dl>
      {s.warnings && s.warnings.length > 0 && (
        <div className="ad-card-risk">
          {s.warnings.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
      )}
      {acts}
    </article>
  );
}

/* ---------------------------------------------------------------- record */

/** What the assistant helped solve on a delivery, as it reads in the execution record. */
export function AIReports({
  reports,
  where,
}: {
  reports: AIReport[];
  where?: string;
}) {
  useLang();
  const ai = useAIStatus();
  const [openSubmit, submitNode] = useSubmitKB();
  if (!ai.enabled || !reports.length) return null;
  return (
    <section className="ad-reports" aria-label={bi("AI 辅助处理", "AI-assisted resolutions")}>
      {submitNode}
      <h3>
        <Spark /> {bi("AI 辅助处理", "AI-assisted resolutions")}
      </h3>
      {reports.map((r) => (
        <article key={r.session} className="ad-report">
          <header>
            <b>{r.title}</b>
            {r.changed && (
              <span className="ad-tag e-destructive">
                {bi("交付需要修改", "Delivery requires changes")}
              </span>
            )}
            <span className="ad-report-by" title={fullTime(r.at)}>
              {r.by} · {ago(r.at)}
            </span>
            {r.kb_id && (
              <button
                type="button"
                className="ad-report-kb"
                onClick={() => go({ name: "kb", id: `my-${r.kb_id}` })}
              >
                {bi("已存入我的知识库", "Saved to my KB")}
              </button>
            )}
            {can("kb.submit") && (
              <button
                type="button"
                className="ad-report-kb"
                title={bi(
                  "提交后由管理员审核，通过才进入团队知识库",
                  "Requires admin review before entering the team KB",
                )}
                onClick={() =>
                  openSubmit(
                    reportDoc(r, where ? `${where} · ${r.title}` : r.title),
                  )
                }
              >
                {bi("发布到团队（需审核）", "Publish to team (needs review)")}
              </button>
            )}
          </header>
          <dl>
            <dt>{bi("现象", "Symptom")}</dt>
            <dd>{r.symptom}</dd>
            {r.evidence && (
              <>
                <dt>{bi("证据", "Evidence")}</dt>
                <dd>
                  <code>{r.evidence}</code>
                </dd>
              </>
            )}
            <dt>{bi("原因", "Root cause")}</dt>
            <dd>{r.cause}</dd>
            <dt>{bi("处理", "Resolution")}</dt>
            <dd>
              <Markdown text={r.fix} />
            </dd>
            {r.followups && r.followups.length > 0 && (
              <>
                <dt>{bi("待跟进", "Follow-ups")}</dt>
                <dd>
                  <ul>
                    {r.followups.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>
        </article>
      ))}
    </section>
  );
}

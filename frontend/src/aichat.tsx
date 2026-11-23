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
  IconBook,
  IconCheck,
  IconCheckCircle,
  IconClose,
  IconCloseCircleFill,
  IconCode,
  IconDown,
  IconCopy,
  IconDelete,
  IconDownload,
  IconEdit,
  IconExclamationCircleFill,
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
  IconSettings,
  IconUp,
  IconRecordStop,
  IconRefresh,
  IconRight,
  IconSend,
  IconShrink,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import { reportDoc, useSubmitKB } from "./kb";
import { MessageQueueTray, useMessageQueue } from "./aiqueue";
import type { QueuedMsg } from "./aiqueue";
import { go } from "./router";
import {
  launchRehearsalIntent,
  launchSecurityRehearsalIntent,
} from "./rehearsal_intent";
import type { RehearsalPresetKind } from "./rehearsal_intent";
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
import { ThinkLevel, ToolMenu, useAIOptions } from "./aitools";
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

export type ChatErrorKind =
  | "hub_network"
  | "stream_interrupted"
  | "gateway_network"
  | "auth"
  | "rate_limit"
  | "config"
  | "model_error";

export type ChatStreamError = Error & {
  diag?: AICallDiag;
  kind?: ChatErrorKind;
  rawError?: string;
  saved?: boolean;
};

export type ChatErrorState = {
  text: string;
  retry?: string;
  diag?: AICallDiag;
  kind?: ChatErrorKind;
  rawError?: string;
};

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
  rehearsals?: RehearsalProposal[];
  knowledges?: KnowledgeProposal[];
  components?: ComponentSuggestion[];
  error?: string;
  error_diag?: AICallDiag;
  at?: string;
  by?: string;
};
export type VexProposal = {
  cves?: string[];
  cve?: string;
  package?: string;
  ecosystem?: string;
  cluster_id?: string;
  global?: boolean;
  status: string;
  justification?: string;
  expires_at?: string;
  note: string;
};
export type BaselineProposal = {
  cluster_id: string;
  check_id: string;
  title?: string;
  note: string;
};
export type RehearsalProposal = {
  cluster_id: string;
  kind?: "upgrade" | "scale" | "tune" | "switch" | "security" | "change" | string;
  mode?: "light" | "full" | string;
  title: string;
  goal?: string;
  packages?: string[];
  cves?: string[];
  summary?: string;
  reason?: string;
  running?: boolean;
  app_label?: string;
};
export type KnowledgeProposal = {
  title: string;
  summary?: string;
  content: string;
  scope?: "personal" | "team" | string;
  source?: string;
  kb_id?: string;
  team_doc_id?: string;
  submission_id?: string;
};
export type ComponentSuggestion = {
  component: string;
  title: string;
  detail: string;
  why?: string;
};
export type RehearsalStepEditProposal = {
  cluster_id: string;
  rehearsal_id: string;
  rehearsal_title?: string;
  step_id: string;
  step_order?: number;
  action: "replace" | "insert_before" | "insert_after" | "delete" | string;
  phase?: string;
  title?: string;
  target_role?: string;
  command?: string;
  expect?: string;
  rollback?: string;
  risk_note?: string;
  old_title?: string;
  old_target_role?: string;
  old_command?: string;
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
  vex?: VexProposal;
  baseline?: BaselineProposal;
  rehearsal?: RehearsalProposal;
  rehearsal_step?: RehearsalStepEditProposal;
  knowledge?: KnowledgeProposal;
};
export type CompProposal = {
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
  /** Standalone exportable Change Report doc ID archived under Cluster Docs (chg-*). */
  doc_id?: string;
};

/** What a conversation is about. key is "review", "step:<runbook key>", "sec:<id>", "portal:<id>" or "comp". */
export type AITarget = {
  key: string;
  title: string;
  context?: string;
  step?: Record<string, unknown>;
  hello?: string;
  suggestions?: string[];
  prefill?: string;
  /** Pre-populates the composer without auto-sending, letting the user paste logs or edit before sending. */
  draft?: string;
  /** Only auto-send prefill when this conversation has no messages yet (reopening an existing security chat shows history instead of re-asking). */
  prefillIfEmpty?: boolean;
  /** Internal marker for an auto-created blank general conversation (reusable only while still empty). */
  fresh?: boolean;
};
type Scope =
  | { kind: "job"; jobId: string }
  | { kind: "comp"; name: string; beforeSend?: () => Promise<unknown> }
  | { kind: "security" }
  | { kind: "portal" };

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
  get execution_history() {
    return bi("自动执行批次", "Execution history");
  },
  get execution_log() {
    return bi("执行日志", "Execution log");
  },
  get cluster_history() {
    return bi("集群历史", "Cluster history");
  },
  get component_sync_status() {
    return bi("组件与同步状态", "Component sync status");
  },
  get library_runtimes() {
    return bi("软件库运行环境", "Library runtimes");
  },
  get check_package_security() {
    return bi("安全公告核查", "Security advisory check");
  },
  get search_files() {
    return bi("搜索项目文件", "Search project files");
  },
  get list_files() {
    return bi("项目文件列表", "Project file list");
  },
  get read_file() {
    return bi("项目文件", "Project file");
  },
  get draft_search() {
    return bi("搜索草稿", "Search draft");
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
  get propose_rehearsal() {
    return bi("变更演练卡片", "Change rehearsal card");
  },
  get propose_knowledge() {
    return bi("知识库总结卡片", "KB summary card");
  },
  get suggest_component_change() {
    return bi("组件改进建议", "Component suggestion");
  },
  get suggest_security_rehearsal() {
    return bi("安全修复演练建议", "Security rehearsal suggestion");
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
  get execution_history() {
    return bi("查看自动执行批次", "Checking execution runs");
  },
  get execution_log() {
    return bi("读取执行日志", "Reading execution log");
  },
  get cluster_history() {
    return bi("查看集群历史", "Checking cluster history");
  },
  get component_sync_status() {
    return bi("核对当前组件与同步状态", "Checking component & sync status");
  },
  get library_runtimes() {
    return bi("查看软件库运行环境", "Checking library runtimes");
  },
  get check_package_security() {
    return bi("核查官方安全公告与版本", "Checking security advisories");
  },
  get search_files() {
    return bi("搜索项目文件", "Searching project files");
  },
  get list_files() {
    return bi("浏览项目文件", "Browsing project files");
  },
  get read_file() {
    return bi("读取项目文件", "Reading project file");
  },
  get draft_search() {
    return bi("搜索草稿文件", "Searching draft files");
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
  get cluster_security_info() {
    return bi("读取集群安全态势与配置基线", "Reading cluster security posture");
  },
  get security_scan_summary() {
    return bi("查看全局安全扫描概览", "Reading global security overview");
  },
  get security_search_findings() {
    return bi("检索安全中心漏洞清单", "Searching security findings");
  },
  get propose_vex_triage() {
    return bi("生成 VEX 处置提案卡片", "Drafting VEX triage proposal");
  },
  get propose_baseline_waive() {
    return bi("生成配置基线豁免卡片", "Drafting baseline waiver proposal");
  },
  get propose_rehearsal() {
    return bi("整理变更演练方案与目标卡片", "Preparing change rehearsal card");
  },
  get read_rehearsal() {
    return bi("读取当前集群变更演练步骤", "Reading cluster change rehearsal");
  },
  get propose_rehearsal_step_edit() {
    return bi("生成演练步骤修订提案卡片", "Drafting rehearsal step edit card");
  },
  get propose_knowledge() {
    return bi("整理写入知识库总结卡片", "Drafting knowledge base summary card");
  },
  get suggest_component_change() {
    return bi("生成组件改进建议卡片", "Drafting component improvement card");
  },
  get suggest_security_rehearsal() {
    return bi("生成安全修复演练建议", "Drafting security rehearsal suggestion");
  },
};

/** A conversation about the whole delivery (as many as people start), not about one step. */
export const isGeneral = (key: string) =>
  key === "review" || key.startsWith("review:");
export const isSecurityKey = (key: string) =>
  key === "sec" || key.startsWith("sec:");
export const isPortalKey = (key: string) =>
  key === "portal" || key.startsWith("portal:");
const randKey = () =>
  (Math.random().toString(36).slice(2) + Date.now().toString(36))
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10)
    .padEnd(8, "0");
const newGeneral = () => `review:${randKey()}`;
const newSecurityChat = () => `sec:${randKey()}`;
const newPortalChat = () => `portal:${randKey()}`;

const sameStringList = (a?: string[], b?: string[]) =>
  a === b ||
  (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]));

function freshStart(scope: Scope, start: AITarget): AITarget {
  if (scope.kind === "comp") return start;
  const key =
    scope.kind === "portal"
      ? newPortalChat()
      : scope.kind === "security"
        ? newSecurityChat()
        : newGeneral();
  return {
    key,
    title: start.title || bi("新对话", "New chat"),
    context: start.context,
    hello: start.hello,
    suggestions: start.suggestions,
    step:
      scope.kind === "portal" && start.step?.page
        ? { page: start.step.page }
        : undefined,
    fresh: true,
  };
}

const featureOf = (key: string) =>
  isSecurityKey(key)
    ? "security"
    : isPortalKey(key)
      ? "assistant"
      : isGeneral(key)
        ? "review"
        : key === "comp"
          ? "component"
          : "troubleshoot";

/* ---------------------------------------------------------------- dock */

type Dock = {
  open: (t?: AITarget) => void;
  available: (key: string) => boolean;
  /** Steps the window aside (a bar at the bottom) so the page under it can be seen; the conversation goes on. */
  minimize: () => void;
  scopeKind: Scope["kind"];
};
const DockCtx = createContext<Dock | null>(null);
/** Tracks nested specialized docks (job/comp/security) so an outer portal dock yields automatically without duplicate buttons. */
const NestedDockCtx = createContext<(() => () => void) | null>(null);
/** Opens the page's assistant on a conversation. Null outside a page that has one. */
export const useAIDock = () => useContext(DockCtx);

/**
 * Compact inline "?" / "Ask AI" trigger that can sit next to any step, field, or error.
 * Opens the nearest active AIDock (page-specific or global portal dock) with rich context.
 */
export function AIHelpButton({
  topic,
  title,
  prompt,
  draft,
  page,
  summary,
  error,
  command,
  label,
  tooltip,
  variant = "icon",
  className = "",
}: {
  topic: string;
  title: string;
  prompt?: string;
  draft?: string;
  page?: string;
  summary?: string;
  error?: string;
  command?: string;
  label?: string;
  tooltip?: string;
  variant?: "icon" | "pill";
  className?: string;
}) {
  useLang();
  const dock = useAIDock();
  if (!dock) return null;
  const checkKey =
    dock.scopeKind === "portal"
      ? "portal"
      : dock.scopeKind === "security"
        ? "sec"
        : dock.scopeKind === "comp"
          ? "comp"
          : "step:help";
  if (!dock.available(checkKey)) return null;

  const openHelp = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const safeTopic =
      topic
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "help";
    const key =
      dock.scopeKind === "portal"
        ? `portal:${safeTopic}`
        : dock.scopeKind === "security"
          ? `sec:${safeTopic}`
          : dock.scopeKind === "comp"
            ? "comp"
            : `step:${safeTopic}`;
    const step: Record<string, unknown> = { title, topic };
    if (page) step.page = page;
    if (summary) step.summary = summary;
    if (error) step.error = error;
    if (command) step.command = command;
    dock.open({
      key,
      title,
      context: page || summary,
      step,
      prefill: prompt,
      draft: prompt ? undefined : draft,
      prefillIfEmpty: !error,
    });
  };

  if (variant === "pill") {
    return (
      <button
        type="button"
        className={`ai-help-btn ai-help-pill ${className}`.trim()}
        onClick={openHelp}
        aria-label={tooltip || bi(`问 AI：${title}`, `Ask AI: ${title}`)}
      >
        <Spark size={12} />
        <span>{label || bi("问 AI", "Ask AI")}</span>
      </button>
    );
  }
  return (
    <Tooltip
      content={tooltip || bi(`有疑问？问 AI：${title}`, `Ask AI: ${title}`)}
      mini
    >
      <button
        type="button"
        className={`ai-help-btn ai-help-icon ${className}`.trim()}
        onClick={openHelp}
        aria-label={tooltip || bi(`问 AI：${title}`, `Ask AI: ${title}`)}
      >
        <IconQuestionCircle />
      </button>
    </Tooltip>
  );
}

/** Tells the parts of a delivery page that read the record to read it again (an accepted proposal, a write-up). */
export const AI_CHANGED = "mh-ai-changed";
/** Tells security views (cluster security tab & global security center) to reload after a VEX / baseline proposal is accepted. */
export const SECURITY_CHANGED = "mh-security-changed";
/** Tells active rehearsal views to reload after an AI assistant rehearsal-step edit proposal is accepted. */
export const REHEARSAL_CHANGED = "mh-rehearsal-changed";
/** Opens the VEX triage form prefilled from an AI VEX proposal card so the user can fine-tune before saving. */
export const VEX_OPEN_DRAFT = "mh-vex-open-draft";

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
  const registerInParent = useContext(NestedDockCtx);
  const [innerCount, setInnerCount] = useState(0);
  const registerInner = useCallback(() => {
    setInnerCount((c) => c + 1);
    return () => setInnerCount((c) => Math.max(0, c - 1));
  }, []);
  useEffect(() => {
    if (!registerInParent || hidden) return;
    return registerInParent();
  }, [registerInParent, hidden]);
  const yielded = scope.kind === "portal" && innerCount > 0;
  const effectiveHidden = hidden || yielded;
  const id =
    scope.kind === "job"
      ? scope.jobId
      : scope.kind === "comp"
        ? scope.name
        : scope.kind === "portal"
          ? "__portal__"
          : "__security__";
  const [target, setTarget] = useState<AITarget>(() =>
    freshStart(scope, start),
  );
  const targetRef = useRef(target);
  targetRef.current = target;
  const hasContentRef = useRef(false);
  const onHasContent = useCallback((has: boolean) => {
    hasContentRef.current = has;
  }, []);
  const startStepPage =
    typeof start.step?.page === "string" ? start.step.page : "";
  const startSugKey = (start.suggestions || []).join("\0");
  const prevIdRef = useRef(id);
  useEffect(() => {
    if (prevIdRef.current !== id) {
      prevIdRef.current = id;
      hasContentRef.current = false;
      setTarget(freshStart(scope, start));
      return;
    }
    setTarget((cur) => {
      if (scope.kind === "comp") {
        return cur.key === start.key &&
          (cur.title !== start.title ||
            cur.context !== start.context ||
            cur.hello !== start.hello ||
            !sameStringList(cur.suggestions, start.suggestions))
          ? { ...cur, ...start }
          : cur;
      }
      if (!cur.fresh || hasContentRef.current) return cur;
      const nextStep =
        scope.kind === "portal" && startStepPage
          ? { page: startStepPage }
          : undefined;
      const nextTitle = start.title || bi("新对话", "New chat");
      const curStepPage =
        typeof cur.step?.page === "string" ? cur.step.page : "";
      if (
        cur.title !== nextTitle ||
        cur.context !== start.context ||
        cur.hello !== start.hello ||
        !sameStringList(cur.suggestions, start.suggestions) ||
        curStepPage !== (nextStep?.page || "")
      ) {
        return {
          ...cur,
          title: nextTitle,
          context: start.context,
          hello: start.hello,
          suggestions: start.suggestions,
          step: nextStep,
        };
      }
      return cur;
    });
  }, [
    id,
    scope.kind,
    start.key,
    start.title,
    start.context,
    start.hello,
    startSugKey,
    startStepPage,
  ]); // eslint-disable-line react-hooks/exhaustive-deps
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
      !effectiveHidden &&
      status.enabled &&
      can("ai.use") &&
      !!status.features[featureOf(key)],
    [effectiveHidden, status],
  );
  const any =
    !effectiveHidden &&
    (scope.kind === "comp"
      ? available("comp")
      : scope.kind === "security"
        ? available("sec")
        : scope.kind === "portal"
          ? available("portal")
          : available("review") || available("step:x") || available("sec:x"));
  useEffect(() => {
    if (effectiveHidden || !status.enabled || !any) {
      setMode("closed");
    }
  }, [effectiveHidden, status.enabled, any]);
  // opened from the button or the keyboard: always start a fresh general conversation (unless actively replying)
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const openGeneral = useCallback(() => {
    if (!busyRef.current) {
      if (scope.kind === "comp") {
        setTarget(start);
      } else {
        const cur = targetRef.current;
        if (cur.fresh && !hasContentRef.current && !cur.prefill && !cur.draft) {
          const nextStep =
            scope.kind === "portal" && startStepPage
              ? { page: startStepPage }
              : undefined;
          const nextTitle = start.title || bi("新对话", "New chat");
          const curStepPage =
            typeof cur.step?.page === "string" ? cur.step.page : "";
          if (
            cur.title !== nextTitle ||
            cur.context !== start.context ||
            cur.hello !== start.hello ||
            !sameStringList(cur.suggestions, start.suggestions) ||
            curStepPage !== (nextStep?.page || "")
          ) {
            setTarget({
              ...cur,
              title: nextTitle,
              context: start.context,
              hello: start.hello,
              suggestions: start.suggestions,
              step: nextStep,
            });
          }
        } else {
          hasContentRef.current = false;
          setTarget(freshStart(scope, start));
        }
      }
    }
    setOpen(true);
  }, [scope, start, startStepPage, setOpen]);
  const dock = useMemo<Dock>(
    () => ({
      available,
      scopeKind: scope.kind,
      open: (t) => {
        if (!t) {
          if (modeRef.current === "closed") openGeneral();
          else setOpen(true);
          return;
        }
        // the page's own starting conversation keeps its context line when opened from a button
        setTarget(
          t.key === start.key
            ? { ...start, ...t, context: t.context || start.context }
            : isGeneral(t.key) && !t.context && start.context
              ? { ...t, context: start.context }
              : t,
        );
        setOpen(true);
      },
      minimize: () => setMode((m) => (m === "open" ? "min" : m)),
    }),
    [available, scope.kind, start, setOpen, openGeneral],
  );
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
  // ⌘J / Ctrl+J opens a fresh chat from closed, restores from minimized, or closes when open
  useEffect(() => {
    if (!any) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        if (modeRef.current === "open") setOpen(false);
        else if (modeRef.current === "min") setOpen(true);
        else openGeneral();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [any, setOpen, openGeneral]);
  const changed = useCallback(() => {
    if (scope.kind === "job")
      window.dispatchEvent(
        new CustomEvent(AI_CHANGED, { detail: scope.jobId }),
      );
    onChanged?.();
  }, [scope, onChanged]);
  return (
    <NestedDockCtx.Provider
      value={scope.kind === "portal" ? registerInner : registerInParent}
    >
      <DockCtx.Provider value={dock}>
        {children}
        {any && mode === "closed" && (
          <button
            type="button"
            className={`ad-launch ${busy ? "busy" : ""} ${atEnd && !busy ? "mini" : ""}`}
            onClick={openGeneral}
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
              onHasContent={onHasContent}
              onClose={() => setOpen(false)}
              onChanged={changed}
              available={available}
            />
          </WindowBoundary>
        )}
      </DockCtx.Provider>
    </NestedDockCtx.Provider>
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
  rehearsals?: RehearsalProposal[];
  knowledges?: KnowledgeProposal[];
  components?: ComponentSuggestion[];
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
  onHasContent,
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
  onHasContent: (has: boolean) => void;
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
      : scope.kind === "security"
        ? `/api/security/ai`
        : scope.kind === "portal"
          ? `/api/ai/portal`
          : `/api/jobs/${scope.jobId}/ai`;
  const hasSessions =
    scope.kind === "job" ||
    scope.kind === "security" ||
    scope.kind === "portal";
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
  const [error, setError] = useState<ChatErrorState | null>(null);
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
  const queue = useMessageQueue(sessionURL);
  const pendingJumpRef = useRef<{ session: string; item: QueuedMsg } | null>(
    null,
  );
  // the answer of this conversation is being written on the server (the page looked elsewhere meanwhile)
  const [remote, setRemote] = useState(false);
  const hasContent = Boolean(
    (msgs && msgs.length > 0) ||
      busy ||
      remote ||
      input.trim() ||
      imgs.length > 0,
  );
  useEffect(() => onHasContent(hasContent), [hasContent, onHasContent]);
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
  useEffect(() => {
    if (mode !== "open") setListOpen(false);
  }, [mode]);
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
    if (!hasSessions) return;
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
  }, [base, hasSessions]);

  useEffect(() => {
    setMsgs(null);
    setError(null);
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
  // opened with something to ask (a failed step's output or a CVE to analyze): ask it once the conversation is loaded
  const asked = useRef("");
  useEffect(() => {
    const p = target.prefill;
    if (!p || msgs === null || remote || asked.current === target.key + p) return;
    if (target.prefillIfEmpty && msgs.length > 0) {
      asked.current = target.key + p;
      return;
    }
    asked.current = target.key + p;
    send(p);
  }, [msgs === null, target.key, target.prefill]); // eslint-disable-line react-hooks/exhaustive-deps
  const drafted = useRef("");
  useEffect(() => {
    const d = target.draft;
    if (!d || msgs === null || drafted.current === target.key + d) return;
    drafted.current = target.key + d;
    setInput(d);
    window.setTimeout(() => box.current?.focus({ preventScroll: true }), 40);
  }, [msgs === null, target.key, target.draft]);
  useEffect(() => {
    if (mode === "open" && msgs && !small())
      box.current?.focus({ preventScroll: true });
  }, [mode, target.key, msgs === null]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const enqueueCurrent = () => {
    const text = input.trim();
    if ((!text && !imgs.length) || !on || net !== "online") return false;
    const ok = queue.enqueue({ text, images: imgs });
    if (ok) {
      setInput("");
      setImgs([]);
      requestAnimationFrame(() => box.current?.focus({ preventScroll: true }));
    }
    return ok;
  };

  const send = async (
    override?: string,
    isRetry?: boolean,
    queued?: QueuedMsg,
  ) => {
    const text = (queued ? queued.text : (override ?? input)).trim();
    const sent = queued ? queued.images || [] : override !== undefined ? [] : imgs;
    if ((!text && !sent.length) || busy || !on) return;
    const mine = sessionURL;
    const here = () => sessionRef.current === mine;
    setError(null);
    // asking again a question the server kept (or failed to answer): strip trailing error turn and reuse user bubble
    const trimmed = [...(msgs || [])];
    while (
      trimmed.length > 0 &&
      trimmed[trimmed.length - 1].role === "assistant" &&
      trimmed[trimmed.length - 1].error &&
      !trimmed[trimmed.length - 1].text?.trim()
    ) {
      trimmed.pop();
    }
    const again = Boolean(
      !queued &&
        (isRetry || override !== undefined) &&
        trimmed.length > 0 &&
        trimmed[trimmed.length - 1].role === "user" &&
        trimmed[trimmed.length - 1].text === text,
    );
    if (again) {
      setMsgs(trimmed);
    } else {
      setMsgs([
        ...(msgs || []),
        { role: "user", text, images: sent, at: new Date().toISOString() },
      ]);
    }
    if (!queued && override === undefined) {
      setInput("");
      setImgs([]);
    }
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
      rehearsals: cur.rehearsals,
      knowledges: cur.knowledges,
      components: cur.components,
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
              retry: again,
            }
          : {
              key: target.key,
              message: text,
              images: sent,
              step: target.step,
              model: model.ref,
              options: tools.opts,
              retry: again,
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
            rehearsals: cur.rehearsals ? [...cur.rehearsals] : undefined,
            knowledges: cur.knowledges ? [...cur.knowledges] : undefined,
            components: cur.components ? [...cur.components] : undefined,
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
      const streamErr = e as ChatStreamError;
      const diag =
        streamErr.diag ??
        (e as { body?: { diag?: AICallDiag } }).body?.diag;
      if (cur.text || cur.made.length || cur.steps.length) {
        setMsgs((m) => [
          ...(m || []),
          {
            ...done(),
            text: cur.text + (stopped ? bi("\n\n（已停止）", "\n\n(Stopped)") : ""),
            ...(stopped
              ? {}
              : { error: streamErr.message, error_diag: diag }),
          },
        ]);
      } else if (!stopped && streamErr.saved) {
        setMsgs((m) => [
          ...(m || []),
          {
            role: "assistant",
            text: "",
            error: streamErr.message,
            error_diag: diag,
            at: new Date().toISOString(),
          },
        ]);
        loadSessions();
      } else if (!stopped) {
        setError({
          text: streamErr.message,
          retry: text,
          diag,
          kind: streamErr.kind,
          rawError: streamErr.rawError,
        });
      }
      if (!stopped && queue.items.length > 0) queue.setPaused(true);
    } finally {
      if (here()) {
        setLive(null);
        abort.current = null;
      }
    }
  };

  const stop = (pauseQueue = true) => {
    if (pauseQueue && queue.items.length > 0) queue.setPaused(true);
    abort.current?.abort();
    if (hasSessions)
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

  const submitComposer = () => {
    if (busy) {
      enqueueCurrent();
      return;
    }
    void send();
  };

  const sendQueuedNow = (item: QueuedMsg) => {
    const taken = queue.take(item.id);
    if (!taken) return;
    queue.setPaused(false);
    if (busy) {
      pendingJumpRef.current = { session: sessionURL, item: taken };
      stop(false);
    } else {
      void send(undefined, false, taken);
    }
  };

  useEffect(() => {
    if (busy || !on || net !== "online" || msgs === null) return;
    if (
      pendingJumpRef.current &&
      pendingJumpRef.current.session === sessionURL
    ) {
      const next = pendingJumpRef.current.item;
      pendingJumpRef.current = null;
      void send(undefined, false, next);
      return;
    }
    if (!queue.paused && queue.items.length > 0) {
      const next = queue.take();
      if (next) void send(undefined, false, next);
    }
  }, [busy, on, net, msgs, sessionURL, queue.paused, queue.items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (
    id: string,
    verb: "accept" | "reject",
    body?: Record<string, unknown>,
  ) => {
    setDeciding(id);
    try {
      const curProp = props[id] as StepProposal | undefined;
      const saved = await api<StepProposal>(`${base}/proposals/${id}/${verb}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
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
      if (verb === "accept") {
        if (curProp?.kind === "vex") {
          window.dispatchEvent(new CustomEvent(SECURITY_CHANGED));
          Message.success(
            bi(
              "已采纳并写入 VEX 漏洞处置记录",
              "Accepted and saved to VEX triage",
            ),
          );
        } else if (curProp?.kind === "baseline_waive") {
          window.dispatchEvent(new CustomEvent(SECURITY_CHANGED));
          Message.success(
            bi(
              "已采纳并写入配置安全基线豁免",
              "Accepted and saved baseline waiver",
            ),
          );
        } else if (curProp?.kind === "rehearsal") {
          Message.success(
            bi(
              "已确认，正在前往集群变更演练",
              "Confirmed; opening cluster rehearsal",
            ),
          );
        } else if (curProp?.kind === "rehearsal_step") {
          const rs = saved?.rehearsal_step || curProp.rehearsal_step;
          window.dispatchEvent(
            new CustomEvent(REHEARSAL_CHANGED, {
              detail: {
                clusterId: rs?.cluster_id,
                rehearsalId: rs?.rehearsal_id,
              },
            }),
          );
          Message.success(
            bi(
              "已采纳并更新演练步骤，页面已同步刷新",
              "Rehearsal step updated and synced",
            ),
          );
        } else if (curProp?.kind === "knowledge") {
          const kb = saved?.knowledge;
          Message.success(
            kb?.team_doc_id
              ? bi("已直接发布到团队知识库", "Published to team Knowledge Base")
              : kb?.submission_id
                ? bi(
                    "已提交到团队知识库等待审核",
                    "Submitted to team Knowledge Base for review",
                  )
                : bi(
                    "已存入「我的知识库」",
                    "Saved to your personal Knowledge Base",
                  ),
          );
        } else if (curProp?.kind !== "component") {
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
        }
      }
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
  const isRunbookStep =
    target.key.startsWith("step:") && !target.key.startsWith("step:rehearsal:");
  const confirmDraft = async (toKB: boolean) => {
    if (!draft) return;
    setSaving(toKB ? "kb" : "save");
    try {
      const rep = await api<AIReport>(`${base}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          key: target.key,
          report: draft,
          mark_step: markStep && isRunbookStep,
          to_kb: toKB,
        }),
      });
      putAway((msgs || []).length);
      setDraft(null);
      onChanged();
      if (rep.doc_id) {
        Message.success(
          toKB && rep.kb_id
            ? bi(
                "已归档为集群《变更报告》（可在「文档」页审阅与导出 Word），并同步存入个人知识库",
                "Archived as Cluster Change Report (view/export in Docs) and saved to your personal KB",
              )
            : bi(
                "已归档为集群《变更报告》，可在集群「文档」页查看与导出 Word",
                "Archived as a Cluster Change Report; view and export Word in the cluster Docs tab",
              ),
        );
      } else {
        Message.success(
          toKB && rep.kb_id
            ? bi(
                "已归档到交付执行记录，并存进你自己的知识库（仅自己可见，可在记录里发布到团队）",
                "Saved to execution record and your personal KB (private; publish to team anytime)",
              )
            : bi(
                "已归档到交付执行记录，交付报告里将自动收录",
                "Saved to execution record; it will appear in the delivery report",
              ),
        );
      }
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
  const normDeployCopy = (s?: string) => {
    if (!s) return s;
    const t = s.trim();
    const pairs: Record<string, [string, string]> = {
      集群问答: ["集群问答", "Cluster Q&A"],
      "Cluster Q&A": ["集群问答", "Cluster Q&A"],
      新对话: ["新对话", "New chat"],
      "New chat": ["新对话", "New chat"],
      "New Chat": ["新对话", "New Chat"],
      交付评审: ["交付评审", "Delivery review"],
      "Delivery review": ["交付评审", "Delivery review"],
      "Delivery Review": ["交付评审", "Delivery review"],
      关于整个交付: ["关于整个交付", "About this delivery"],
      "About this delivery": ["关于整个交付", "About this delivery"],
      现场排障: ["现场排障", "Troubleshooting"],
      Troubleshooting: ["现场排障", "Troubleshooting"],
      组件工作台: ["组件工作台", "Component workbench"],
      "Component workbench": ["组件工作台", "Component workbench"],
      "Component Workbench": ["组件工作台", "Component workbench"],
    };
    if (pairs[t]) return bi(pairs[t][0], pairs[t][1]);
    return s.replace(/首次部署/g, bi("集群部署", "Cluster deploy"));
  };
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
      : scope.kind === "portal"
        ? getHelloPortal()
        : isSecurityKey(target.key)
          ? getHelloSec(scope.kind === "security")
          : isGeneral(target.key)
            ? getHelloReview()
            : getHelloStep());
  const suggestions =
    target.suggestions ||
    (scope.kind === "comp"
      ? getSuggestComp()
      : scope.kind === "portal"
        ? getSuggestPortal()
        : isSecurityKey(target.key)
          ? getSuggestSec(scope.kind === "security")
          : isGeneral(target.key)
            ? getSuggestReview()
            : getSuggestStep());
  const answered = (msgs || []).some((m) => m.role === "assistant" && !m.error);
  // the "solved?" line shows on delivery chats (both step troubleshooting and whole-delivery review/ops chats);
  // once dismissed it stays accessible as a toolbar icon so write-up & save-to-KB is always 1 click away.
  const askSolved =
    scope.kind === "job" &&
    (feature === "troubleshoot" || feature === "review") &&
    answered &&
    !busy;
  const showSolved =
    askSolved &&
    (feature === "troubleshoot"
      ? (msgs || []).length >= solvedAt + 2
      : (msgs || []).length >= solvedAt + 4);
  const solvedChip = askSolved && !showSolved;
  const offline = net !== "online";

  // a new conversation about the whole delivery (or a new security/portal chat); one not yet written in is not started twice
  const startGeneral = () => {
    if (scope.kind === "comp") return;
    if (target.fresh && (msgs || []).length === 0 && !busy) {
      box.current?.focus({ preventScroll: true });
      setListOpen(false);
      return;
    }
    pick(freshStart(scope, start));
  };
  // the list: security sessions, whole delivery chats, and troubleshooting chats
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
  const groups = (
    scope.kind === "portal"
      ? [
          {
            id: "portal",
            label: bi("平台助手对话", "Portal assistant chats"),
            items: shownSessions,
          },
        ]
      : scope.kind === "security"
      ? [
          {
            id: "sec",
            label: bi("安全研判对话", "Security chats"),
            items: shownSessions,
          },
        ]
      : [
          {
            id: "sec",
            label: bi("安全研判", "Security analysis"),
            items: shownSessions.filter((x) => isSecurityKey(x.key)),
          },
          {
            id: "all",
            label: bi("整个交付", "Whole delivery"),
            items: shownSessions.filter((x) => isGeneral(x.key)),
          },
          {
            id: "step",
            label: bi("现场排障", "Troubleshooting"),
            items: shownSessions.filter(
              (x) => !isGeneral(x.key) && !isSecurityKey(x.key),
            ),
          },
        ]
  ).filter((g) => g.items.length);
  const newChatEnabled =
    scope.kind === "portal"
      ? available("portal")
      : scope.kind === "security"
        ? available("sec")
        : available("review");
  const sideList = hasSessions && (
    <nav className="ad-sessions" aria-label={bi("对话", "Conversations")}>
      <div className="ad-side-top">
        <b>{bi("对话", "Chats")}</b>
        <button
          type="button"
          className="ad-new"
          disabled={!newChatEnabled}
          onClick={startGeneral}
        >
          <IconPlus aria-hidden />
          {scope.kind === "security"
            ? bi("新安全对话", "New chat")
            : bi("新对话", "New chat")}
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
              const isSec = isSecurityKey(s.key);
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
                            context: isSec
                              ? bi("安全研判", "Security analysis")
                              : general
                                ? start.context
                                : bi("现场排障", "Troubleshooting"),
                          },
                    )
                  }
                >
                  <i
                    className={`ad-dot k-${isSec ? "sec" : general ? "review" : "step"} ${s.running ? "run" : ""}`}
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

  const savedSessTitle = useMemo(
    () => sessions.find((s) => s.key === target.key)?.title,
    [sessions, target.key],
  );
  const displayTitle =
    target.fresh && savedSessTitle ? savedSessTitle : target.title;

  return (
    <section
      ref={win}
      className={`ad-win ${expanded && mode !== "min" ? "big" : ""} ${drag ? "drag" : ""} ${mode === "min" ? "min" : ""} ${mode === "closed" ? "hidden" : ""} ${moving ? "moving" : ""}`}
      style={
        pos && mode !== "min" ? { right: pos.r, bottom: pos.b } : undefined
      }
      aria-hidden={mode === "closed" || undefined}
      role="dialog"
      aria-label={bi(`AI 助手：${displayTitle}`, `AI Assistant: ${displayTitle}`)}
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
          {hasSessions && !expanded ? (
            <button
              type="button"
              className="ad-switch"
              onClick={() => !wasDrag.current && setListOpen((v) => !v)}
              aria-expanded={listOpen}
              aria-label={bi("切换对话", "Switch conversation")}
            >
              <b>{normDeployCopy(displayTitle)}</b>
              <IconDown className={listOpen ? "ad-flip" : ""} />
            </button>
          ) : (
            <b>
              {normDeployCopy(hasSessions ? displayTitle : start.title)}
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
              (isSecurityKey(target.key)
                ? bi("安全研判", "Security analysis")
                : isGeneral(target.key)
                  ? bi("关于整个交付", "About this delivery")
                  : scope.kind === "comp"
                    ? bi("组件工作台", "Component workbench")
                    : bi("现场排障", "Troubleshooting"))
            )}
          </small>
        </div>
        <div className="ad-tools">
          {hasSessions && mode !== "min" && !expanded && (
            <Tooltip
              position="bottom"
              triggerProps={{ autoFitPosition: false }}
              content={
                scope.kind === "security"
                  ? bi("新安全对话", "New security chat")
                  : bi(
                      "新对话（针对整个交付，不关联步骤）",
                      "New chat (about the whole delivery)",
                    )
              }
              mini
            >
              <button
                type="button"
                className="ad-whole"
                onClick={startGeneral}
                aria-label={bi("新对话", "New chat")}
                disabled={!newChatEnabled}
              >
                <IconMessage />
              </button>
            </Tooltip>
          )}
          {scope.kind === "comp" && mode !== "min" && (
            <Tooltip
              position="bottom"
              triggerProps={{ autoFitPosition: false }}
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
            <Tooltip
              position="br"
              triggerProps={{ autoFitPosition: false }}
              content={bi("清空这段对话", "Clear conversation")}
              mini
            >
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
            <Tooltip
              position="tr"
              triggerProps={{ autoFitPosition: false }}
              content={bi("展开", "Expand")}
              mini
            >
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
              <Tooltip
                position="br"
                triggerProps={{ autoFitPosition: false }}
                content={bi("最小化到底部", "Minimize to bottom")}
                mini
              >
                <button
                  type="button"
                  onClick={() => setMode("min")}
                  aria-label={bi("最小化窗口", "Minimize window")}
                >
                  <IconMinus />
                </button>
              </Tooltip>
              <Tooltip
                position="br"
                triggerProps={{ autoFitPosition: false }}
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
            position={mode === "min" ? "tr" : "br"}
            triggerProps={{ autoFitPosition: false }}
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
                {msgs.map((m, i) => {
                  const isLast = i === msgs.length - 1;
                  const prevUser =
                    isLast && m.role === "assistant" && m.error
                      ? [...msgs.slice(0, i)]
                          .reverse()
                          .find((x) => x.role === "user" && x.text?.trim())
                      : undefined;
                  return (
                    <Bubble
                      key={`${target.key}-${i}`}
                      m={m}
                      jobBase={base}
                      props={props}
                      deciding={deciding}
                      decide={decide}
                      comp={scope.kind === "comp"}
                      answer={(t) => send(t)}
                      busy={busy}
                      onRetry={
                        isLast && !busy && on && m.error && prevUser?.text
                          ? () => send(prevUser.text, true)
                          : undefined
                      }
                    />
                  );
                })}
                {!busy &&
                  !live &&
                  !error &&
                  msgs.length > 0 &&
                  msgs[msgs.length - 1].role === "user" &&
                  msgs[msgs.length - 1].text?.trim() && (
                    <UnansweredTurnCard
                      busy={busy}
                      onRetry={
                        on
                          ? () => send(msgs[msgs.length - 1].text, true)
                          : undefined
                      }
                    />
                  )}
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
              <ChatErrorCard
                text={error.text}
                diag={error.diag}
                kind={error.kind}
                rawError={error.rawError}
                busy={busy}
                onRetry={
                  error.retry !== undefined
                    ? () => send(error.retry, true)
                    : undefined
                }
              />
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
                  "变更或排障已敲定？一键归档为集群《变更报告》，可同步存入知识库。",
                  "Change or troubleshooting done? Archive as a Cluster Change Report and optionally save to KB.",
                )}
              </span>
              <Button
                size="mini"
                type="outline"
                loading={resolving}
                onClick={resolve}
              >
                {bi("归档变更报告", "Archive Change Report")}
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

          <MessageQueueTray
            items={queue.items}
            busy={busy}
            paused={queue.paused}
            compact
            onResume={() => queue.setPaused(false)}
            onSendNow={sendQueuedNow}
            onEdit={queue.update}
            onDelete={queue.remove}
            onMove={queue.move}
            onMoveUp={queue.moveUp}
            onMoveDown={queue.moveDown}
            onClear={queue.clear}
          />

          <form
            className={`ad-compose ${offline || !on ? "off" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              submitComposer();
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
                  submitComposer();
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
                    ? bi(
                        "暂未连上 Middleware Hub 后端服务",
                        "Middleware Hub backend unavailable",
                      )
                    : busy
                      ? bi(
                          "AI 正在回复，输入下一条问题按 Enter 加入待发送队列…",
                          "AI is replying—type a follow-up and press Enter to queue…",
                        )
                      : scope.kind === "comp"
                      ? bi(
                          "说说要怎么改这个组件…",
                          "Describe how to update this component…",
                        )
                      : isSecurityKey(target.key)
                        ? bi(
                            "继续追问漏洞细节、补充网络隔离条件，或让 AI 调整 VEX 提案…",
                            "Follow up on vulnerability details, network isolation, or ask AI to adjust VEX…",
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
                hideThink
                thinkInMenu={false}
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
                    "归档为集群变更报告 / 存入知识库",
                    "Archive as Change Report / save to KB",
                  )}
                  mini
                >
                  <button
                    type="button"
                    className="ad-attach ad-solve-chip"
                    aria-label={bi(
                      "归档变更报告 / 存入知识库",
                      "Archive Change Report / KB",
                    )}
                    disabled={resolving}
                    onClick={resolve}
                  >
                    <IconCheckCircle />
                  </button>
                </Tooltip>
              )}
              <div className="ad-bar-right">
                <ThinkLevel
                  levels={model.current?.effort}
                  value={tools.pref.think}
                  onChange={(v) => tools.update({ think: v })}
                />
                <ModelPicker pick={model} compact={!expanded} />
                {busy ? (
                  <>
                    {(input.trim() || imgs.length > 0) && (
                      <Tooltip
                        content={bi(
                          "加入待发送队列（当前回复完成后自动发送 · Enter）",
                          "Add to queue (sends automatically after current reply · Enter)",
                        )}
                        mini
                      >
                        <button
                          type="submit"
                          className="aq-enqueue-btn"
                          aria-label={bi("加入队列", "Queue message")}
                        >
                          <IconSend />
                          <span>{bi("入队", "Queue")}</span>
                        </button>
                      </Tooltip>
                    )}
                    <button
                      type="button"
                      className="ad-send stop"
                      onClick={() => stop(true)}
                      aria-label={bi("停止生成", "Stop")}
                      title={bi("停止生成", "Stop")}
                    >
                      <IconRecordStop />
                    </button>
                  </>
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
        wrapClassName="ad-wu-wrap"
        className="ad-wu-modal"
        style={{ transformOrigin: "center center" }}
        focusLock={false}
        autoFocus={false}
        title={
          <div className="ad-wu-head">
            <span className="ad-wu-head-ico" aria-hidden>
              <IconFile />
            </span>
            <div className="ad-wu-head-txt">
              <div className="ad-wu-head-row">
                <b>{bi("归档变更报告", "Archive Change Report")}</b>
                <span className="ad-wu-head-pill">
                  {bi("AI 整理草稿 · 可自由编辑", "AI Draft · Editable")}
                </span>
              </div>
              <small>
                {bi(
                  "已运行集群将自动生成独立《变更报告》至集群「文档」页，支持在线审阅与 Word 导出",
                  "Archives a standalone Change Report under Cluster Docs with online review & Word export",
                )}
              </small>
            </div>
          </div>
        }
        onCancel={() => !saving && setDraft(null)}
        maskClosable={false}
        footer={
          <div className="ad-wu-foot">
            <span className="ad-wu-foot-note">
              {bi(
                "归档位置：集群「文档」· 变更报告",
                "Destination: Cluster Docs · Change Report",
              )}
            </span>
            <div className="ad-wu-foot-acts">
              <Button onClick={() => setDraft(null)} disabled={!!saving}>
                {bi("暂不归档", "Cancel")}
              </Button>
              <Button
                icon={<IconBook />}
                loading={saving === "kb"}
                disabled={!!saving && saving !== "kb"}
                onClick={() => confirmDraft(true)}
              >
                {bi("归档并存入知识库", "Archive & Save to KB")}
              </Button>
              <Button
                type="primary"
                icon={<IconCheck />}
                loading={saving === "save"}
                disabled={!!saving && saving !== "save"}
                onClick={() => confirmDraft(false)}
              >
                {bi("归档变更报告", "Archive Report")}
              </Button>
            </div>
          </div>
        }
      >
        {draft && (
          <div className="ad-wu">
            <div className="ad-wu-card ad-wu-title-card">
              <div className="ad-wu-card-h">
                <h4>{bi("报告标题", "Report Title")}</h4>
                <span className="ad-wu-card-hint">
                  {bi("将作为文档目录标题显示", "Shown in Cluster Docs list")}
                </span>
              </div>
              <Input
                value={draft.title || ""}
                maxLength={80}
                placeholder={bi(
                  "例如：调整 Patroni synchronous_node_count 参数",
                  "e.g. Tune Patroni synchronous_node_count",
                )}
                onChange={(v) => setDraft({ ...draft, title: v })}
                aria-label={bi("报告标题", "Report title")}
              />
            </div>

            <div className="ad-wu-grid">
              <section className="ad-wu-card ad-wu-symptom">
                <div className="ad-wu-card-h">
                  <h4>{bi("变更背景与现象", "Background & Symptom")}</h4>
                </div>
                <Input.TextArea
                  autoSize={{ minRows: 3, maxRows: 6 }}
                  value={draft.symptom || ""}
                  placeholder={bi(
                    "记录变更缘由或现场最初观察到的现象…",
                    "Describe the change trigger or initial symptom…",
                  )}
                  onChange={(v) => setDraft({ ...draft, symptom: v })}
                  aria-label={bi("变更背景与现象", "Background & Symptom")}
                />
              </section>
              <section className="ad-wu-card ad-wu-cause">
                <div className="ad-wu-card-h">
                  <h4>{bi("原因与变更依据", "Cause & Rationale")}</h4>
                </div>
                <Input.TextArea
                  autoSize={{ minRows: 3, maxRows: 6 }}
                  value={draft.cause || ""}
                  placeholder={bi(
                    "说明根因判定或实施本次变更的技术依据…",
                    "Explain the root cause or technical rationale…",
                  )}
                  onChange={(v) => setDraft({ ...draft, cause: v })}
                  aria-label={bi("原因与变更依据", "Cause & Rationale")}
                />
              </section>
            </div>

            <section className="ad-wu-card ad-wu-fix">
              <div className="ad-wu-card-h">
                <h4>{bi("执行命令与处理经过", "Commands & Resolution")}</h4>
                <span className="ad-wu-card-hint">
                  {bi(
                    "支持用 ``` 包裹代码块，导出 Word 时将按命令框排版",
                    "Wrap commands in ``` for formatted code blocks in Word export",
                  )}
                </span>
              </div>
              <Input.TextArea
                autoSize={{ minRows: 4, maxRows: 10 }}
                value={draft.fix || ""}
                placeholder={bi(
                  "贴入实际执行的命令、目标节点与验证结果…",
                  "Record executed commands, target hosts, and verification outcome…",
                )}
                onChange={(v) => setDraft({ ...draft, fix: v })}
                aria-label={bi("执行命令与处理经过", "Commands & Resolution")}
              />
            </section>

            <div className="ad-wu-extras">
              <details
                className="ad-wu-more"
                open={Boolean(draft.evidence && draft.evidence.trim())}
              >
                <summary>
                  <span>{bi("关键证据与终端回显", "Key Evidence & Output")}</span>
                  <span className="ad-wu-more-badge">
                    {draft.evidence?.trim()
                      ? bi("已填充", "Filled")
                      : bi("可选", "Optional")}
                  </span>
                </summary>
                <Input.TextArea
                  className="mono"
                  autoSize={{ minRows: 2, maxRows: 8 }}
                  value={draft.evidence || ""}
                  placeholder={bi(
                    "粘贴关键报错日志、配置对比或验收回显片段…",
                    "Paste key error logs, config diffs, or verification output…",
                  )}
                  onChange={(v) => setDraft({ ...draft, evidence: v })}
                  aria-label={bi("关键证据与终端回显", "Key Evidence & Output")}
                />
              </details>
              <details
                className="ad-wu-more"
                open={Boolean(draft.followups && draft.followups.length > 0)}
              >
                <summary>
                  <span>
                    {bi("后续跟进事项（一行一条）", "Follow-ups (one per line)")}
                  </span>
                  <span className="ad-wu-more-badge">
                    {draft.followups && draft.followups.length > 0
                      ? bi(
                          `${draft.followups.length} 项`,
                          `${draft.followups.length}`,
                        )
                      : bi("可选", "Optional")}
                  </span>
                </summary>
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  value={(draft.followups || []).join("\n")}
                  placeholder={bi(
                    "例如：下个维护窗口评估是否将同步策略固化到交付模板…",
                    "e.g. Review syncing this setting back into the delivery template…",
                  )}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      followups: v.split("\n").filter((x) => x.trim()),
                    })
                  }
                  aria-label={bi("后续跟进事项", "Follow-ups")}
                />
              </details>
            </div>

            <div className="ad-wu-opts">
              <label className="ad-wu-opt">
                <Checkbox
                  checked={draft.changed}
                  onChange={(v) => setDraft({ ...draft, changed: v })}
                >
                  {bi(
                    "标记初始交付基线存在偏差（后续需同步优化交付模板或文档）",
                    "Flag baseline deviation (initial delivery template/docs should be updated)",
                  )}
                </Checkbox>
              </label>
              {isRunbookStep && (
                <label className="ad-wu-opt">
                  <Checkbox checked={markStep} onChange={setMarkStep}>
                    {bi(
                      "已核对执行结果，同时将当前交付步骤标记为完成",
                      "Verified output; also mark this runbook step as completed",
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

const getHelloPortal = () =>
  bi(
    "我是 Middleware Hub 全站助手。可以随时向我咨询执行节点接入、TLS/CA 证书、SSH 免密与目标 Agent 区别、部署规划，或者直接粘贴终端报错让我帮你定位修复命令。",
    "I'm your Middleware Hub portal assistant. Ask about execution node setup, TLS/CA certs, SSH vs. Target Agent, deployment planning, or paste terminal errors for instant troubleshooting.",
  );
const getSuggestPortal = () => [
  bi(
    "执行器和目标 Agent 有什么区别？分别装在哪？",
    "What's the difference between the execution runner and Target Agent?",
  ),
  bi(
    "检查当前平台的连接地址、证书和执行节点状态",
    "Check current Hub URLs, TLS cert status, and execution nodes",
  ),
  bi(
    "我只有堡垒机、拿不到目标机密码，怎么实现自动部署？",
    "How do I automate deployments via bastion when I don't have target passwords?",
  ),
];
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
const getHelloSec = (global: boolean) =>
  global
    ? bi(
        "我会读取安全中心的实时扫描结果（已区分中间件本体与 OS 底层包），结合受影响集群为你研判漏洞风险与修复优先级；需要登记 VEX 处置或发起修复演练时，会在下方直接给出可一键采纳的卡片。",
        "I inspect live Security Center findings (separating middleware from OS base packages) to assess exploitability and priority, and propose one-click VEX triage or remediation cards right in chat.",
      )
    : bi(
        "我会读取本集群的真实漏洞、配置基线和交付配置文件，为你研判漏洞在本集群的实际可利用性。讨论明确后可直接输出 VEX 处置、基线豁免或修复演练卡片，你确认采纳后才会写入。",
        "I inspect this cluster's findings, config baselines, and delivery files to assess real exploitability, and propose one-click VEX triage, baseline waiver, or rehearsal cards for your approval.",
      );
const getSuggestSec = (global: boolean) =>
  global
    ? [
        bi("总结当前最优先处理的中间件高危漏洞", "Summarize top-priority middleware CVEs"),
        bi("哪些 OS 底层包漏洞适合先做 VEX 评估？", "Which OS base CVEs should be triaged first?"),
        bi("帮我核查受影响最广的软件包并给处置建议", "Check widest-impact packages and suggest actions"),
      ]
    : [
        bi("总结本集群最优先处理的漏洞与基线问题", "Summarize top vulnerabilities & baseline issues"),
        bi("核对本集群未通过的配置基线，给出加固或豁免建议", "Review failed config baselines and suggest actions"),
        bi("哪些 OS 底层漏洞在本集群内网环境下可标记已缓解？", "Which OS CVEs can be marked mitigated in this cluster?"),
      ];

function StepContext({ step }: { step: Record<string, unknown> }) {
  useLang();
  const kind = String(step.kind || "");
  if (kind.startsWith("security_")) {
    const cve = String(step.cve || "");
    const pkg = String(step.package || "");
    const ver = String(step.installed_version || "");
    const sev = String(step.severity || "");
    const role = String(step.pkg_role || "");
    const title = String(step.title || cve || pkg);
    const roleLabel =
      role === "primary"
        ? bi("中间件本体", "Middleware")
        : role === "runtime"
          ? bi("控制机运行环境", "Runtime")
          : role === "dependency"
            ? bi("OS 底层包", "OS Base")
            : "";
    return (
      <div className="ad-ctx ad-ctx-sec">
        <span className="ad-ctx-l">{bi("安全研判", "Security")}</span>
        <b title={title}>{title}</b>
        {sev && <span className={`ad-tag sec-tag-${sev.toLowerCase()}`}>{sev}</span>}
        {roleLabel && <span className="ad-tag">{roleLabel}</span>}
        {pkg && (
          <span className="ad-ctx-h">
            {pkg}
            {ver ? ` ${ver}` : ""}
          </span>
        )}
      </div>
    );
  }
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

const RAW_BROWSER_NET_RE =
  /^(network error|failed to fetch|load failed|networkerror when attempting to fetch resource|the internet connection appears to be offline|fetch failed|err_network|err_connection|connection reset|econnreset)$/i;

export function classifyChatError(
  text: string,
  diag?: AICallDiag,
  kind?: ChatErrorKind,
  rawError?: string,
): {
  kind: ChatErrorKind;
  tone: "bad" | "warn";
  title: string;
  summary: string;
  hint: string;
  showSettings: boolean;
  raw?: string;
} {
  const clean = (text || "").trim();
  const low = clean.toLowerCase();
  const rc = (diag?.reason_code || "").toLowerCase();
  const st = diag?.http_status;

  if (kind === "hub_network" || (!diag && RAW_BROWSER_NET_RE.test(clean))) {
    return {
      kind: "hub_network",
      tone: "warn",
      title: bi(
        "无法连接 Middleware Hub 平台后端",
        "Cannot reach Middleware Hub backend",
      ),
      summary: bi(
        "浏览器与 Middleware Hub 平台服务之间的连接断开，请求未能送达或未收到响应。",
        "The browser lost connection to the Middleware Hub server before the request completed.",
      ),
      hint: bi(
        "平台服务可能正在重启，或当前本地网络波动；等待服务恢复后点击「重试」即可继续。",
        "The Hub server may be restarting or your local network dropped; click Retry once it is back.",
      ),
      showSettings: false,
      raw: rawError || (RAW_BROWSER_NET_RE.test(clean) ? clean : undefined),
    };
  }

  if (kind === "stream_interrupted") {
    return {
      kind: "stream_interrupted",
      tone: "warn",
      title: bi(
        "与 Middleware Hub 的流式连接意外中断",
        "Streaming connection to Middleware Hub interrupted",
      ),
      summary: bi(
        "回答尚未完成时，浏览器与 Middleware Hub 后端的连接被中途切断。",
        "The streaming connection to Middleware Hub was cut off before the reply finished.",
      ),
      hint: bi(
        "平台重启、反向代理超时或网络闪断都会导致流式中断；请点击「重试」重新生成。",
        "A server restart, proxy timeout, or brief network drop can interrupt streaming; click Retry to regenerate.",
      ),
      showSettings: false,
      raw: rawError,
    };
  }

  if (
    kind === "config" ||
    /未开启|没有可用的模型供应商|尚未配置|not enabled|no available model|provider.*not configured/i.test(
      clean,
    )
  ) {
    return {
      kind: "config",
      tone: "warn",
      title: bi("AI 功能或模型尚未就绪", "AI feature or model not ready"),
      summary: clean,
      hint: bi(
        "请在「设置 → AI」中确认对应功能开关已开启，并配置了可用的模型供应商。",
        "Check Settings → AI to ensure the feature is enabled and a model provider is configured.",
      ),
      showSettings: true,
    };
  }

  if (
    kind === "auth" ||
    st === 401 ||
    st === 403 ||
    /401|403|api key|invalid_api_key|unauthorized|authentication|鉴权|密钥|无权限/i.test(
      clean,
    )
  ) {
    return {
      kind: "auth",
      tone: "bad",
      title: bi("AI 模型鉴权或权限失败", "AI model authentication failed"),
      summary: clean,
      hint: bi(
        "请核对供应商的 API Key 是否正确、是否过期，以及该密钥是否有权限调用当前所选模型。",
        "Verify the provider API key is valid and authorized to call the selected model.",
      ),
      showSettings: true,
    };
  }

  if (
    kind === "rate_limit" ||
    st === 429 ||
    /429|rate limit|quota|上限|限流|too many requests|余额不足|insufficient_quota/i.test(
      clean,
    )
  ) {
    return {
      kind: "rate_limit",
      tone: "warn",
      title: bi("AI 请求受限或额度已满", "AI request rate-limited or quota reached"),
      summary: clean,
      hint: bi(
        "可稍等片刻后点击「重试」，或在下方切换其他备用模型继续对话。",
        "Wait a moment and click Retry, or switch to another available model below.",
      ),
      showSettings: true,
    };
  }

  if (
    kind === "gateway_network" ||
    rc === "network_error" ||
    rc === "timeout" ||
    st === 502 ||
    st === 503 ||
    st === 504 ||
    /dial tcp|connection refused|connectex|i\/o timeout|context deadline|timed out|超时|连不上|无法连接|network_error|502|503|504|eof|bad gateway/i.test(
      low,
    )
  ) {
    const isTimeout =
      rc === "timeout" || /timeout|timed out|deadline|超时/i.test(low);
    return {
      kind: "gateway_network",
      tone: "bad",
      title: isTimeout
        ? bi("AI 模型网关响应超时", "AI model gateway timed out")
        : bi("AI 模型网关连接失败", "Failed to reach AI model gateway"),
      summary: clean,
      hint: bi(
        "Middleware Hub 后端无法连通配置的模型网关（并非本平台宕机）；请检查网关地址、端口与网络连通性，或切换其他可用模型后重试。",
        "Middleware Hub could not reach the configured model gateway; check the gateway URL/network in Settings → AI or switch to another model.",
      ),
      showSettings: true,
    };
  }

  return {
    kind: kind || "model_error",
    tone: "bad",
    title: bi("AI 模型调用失败", "AI model call failed"),
    summary: clean || bi("本次模型调用返回了异常结果", "The model request returned an error"),
    hint: bi(
      "你可以点击「重试」再试一次，或展开诊断明细核对接口协议与上游返回信息。",
      "Click Retry to try again, or inspect diagnostics to check the API protocol and upstream response.",
    ),
    showSettings: Boolean(diag),
    raw: rawError,
  };
}

export function ChatErrorCard({
  text,
  diag,
  kind,
  rawError,
  at,
  onRetry,
  busy,
  variant = "standalone",
}: {
  text: string;
  diag?: AICallDiag;
  kind?: ChatErrorKind;
  rawError?: string;
  at?: string;
  onRetry?: () => void;
  busy?: boolean;
  variant?: "standalone" | "bubble" | "hero";
}) {
  useLang();
  const [openDiag, setOpenDiag] = useState(false);
  const [copied, setCopied] = useState(false);
  const info = classifyChatError(text, diag, kind, rawError);
  const modelLabel = [diag?.provider, diag?.model].filter(Boolean).join(" · ");
  const hasDetail = Boolean(diag || info.raw);
  return (
    <div
      className={`ad-errcard tone-${info.tone} ${variant === "bubble" ? "in-bubble" : variant === "hero" ? "in-hero" : ""}`}
      role="alert"
    >
      <div className="ad-errcard-head">
        <span className="ad-errcard-ic" aria-hidden>
          {info.tone === "warn" ? (
            <IconExclamationCircleFill />
          ) : (
            <IconCloseCircleFill />
          )}
        </span>
        <span className="ad-errcard-title">{info.title}</span>
        {modelLabel && (
          <span className="ad-errcard-model" title={modelLabel}>
            {modelLabel}
          </span>
        )}
        {at && (
          <time className="ad-errcard-time" title={fullTime(at)}>
            {ago(at)}
          </time>
        )}
      </div>
      <p className="ad-errcard-summary">{info.summary}</p>
      <p className="ad-errcard-hint">{info.hint}</p>
      <div className="ad-errcard-acts">
        {onRetry && (
          <button
            type="button"
            className="ad-errcard-btn primary"
            disabled={busy}
            onClick={onRetry}
          >
            <IconRefresh /> {bi("重试", "Retry")}
          </button>
        )}
        {hasDetail && (
          <button
            type="button"
            className="ad-errcard-btn"
            aria-expanded={openDiag}
            onClick={() => setOpenDiag((v) => !v)}
          >
            {openDiag
              ? bi("收起诊断详情", "Hide details")
              : diag
                ? bi("展开网关诊断", "Show diagnostics")
                : bi("查看技术详情", "Technical details")}
            <IconDown className={openDiag ? "ad-flip" : ""} />
          </button>
        )}
        {!diag && (
          <button
            type="button"
            className="ad-errcard-btn"
            onClick={() => {
              copy(
                [info.title, info.summary, info.raw ? `detail: ${info.raw}` : ""]
                  .filter(Boolean)
                  .join("\n"),
              );
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? <IconCheck /> : <IconCopy />}{" "}
            {copied ? bi("已复制", "Copied") : bi("复制错误", "Copy error")}
          </button>
        )}
        {info.showSettings && can("ai.settings") && (
          <button
            type="button"
            className="ad-errcard-btn"
            onClick={() => go({ name: "settings", id: "ai" })}
          >
            <IconSettings /> {bi("前往设置 → AI", "Settings → AI")}
          </button>
        )}
      </div>
      {openDiag && diag && <ChatErrorDiag diag={diag} errText={text} />}
      {openDiag && !diag && info.raw && (
        <pre className="ad-errcard-raw">{info.raw}</pre>
      )}
    </div>
  );
}

export function UnansweredTurnCard({
  onRetry,
  busy,
}: {
  onRetry?: () => void;
  busy?: boolean;
}) {
  useLang();
  return (
    <div className="ad-unanswered" role="status">
      <div className="ad-unanswered-body">
        <span className="ad-unanswered-ic" aria-hidden>
          <IconExclamationCircleFill />
        </span>
        <div className="ad-unanswered-text">
          <b>{bi("本轮未收到 AI 回复", "No AI reply received for this turn")}</b>
          <span>
            {bi(
              "上次请求可能因模型网关异常、网络中断或平台服务重启而中止，未留下回复内容。",
              "The previous request may have stopped due to a gateway error, network drop, or server restart.",
            )}
          </span>
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          className="ad-errcard-btn primary"
          disabled={busy}
          onClick={onRetry}
        >
          <IconRefresh /> {bi("重新生成回复", "Retry reply")}
        </button>
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
  let r: Response;
  try {
    r = await fetch(withLang(url), {
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
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    const raw = (e as Error)?.message || String(e);
    const errObj = new Error(
      bi(
        "无法连接到 Middleware Hub 平台后端，请求未发出或连接中断",
        "Unable to reach Middleware Hub server; request failed or connection dropped",
      ),
    ) as ChatStreamError;
    errObj.kind = "hub_network";
    errObj.rawError = raw;
    throw errObj;
  }
  if (!r.ok || !r.body) {
    const d = await r.json().catch(() => ({}));
    const proxyDown =
      !d?.error && (r.status === 502 || r.status === 503 || r.status === 504);
    const errObj = new Error(
      d.error ||
        (proxyDown
          ? bi(
              `Middleware Hub 后端服务暂时不可用（HTTP ${r.status}），可能正在重启`,
              `Middleware Hub server is temporarily unavailable (HTTP ${r.status})`,
            )
          : bi(`请求失败（HTTP ${r.status}）`, `Request failed (HTTP ${r.status})`)),
    ) as ChatStreamError;
    if (proxyDown) errObj.kind = "hub_network";
    if (d && typeof d === "object" && d.diag) {
      errObj.diag = d.diag as AICallDiag;
    }
    throw errObj;
  }
  const rd = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let sawDone = false;
  let sseErr: ChatStreamError | null = null;
  try {
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
          case "done":
            sawDone = true;
            onOther?.(e);
            break;
          case "reset":
            cur.text = "";
            cur.steps = [];
            cur.tools = [];
            cur.rehearsals = undefined;
            cur.knowledges = undefined;
            cur.components = undefined;
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
          case "rehearsal":
            if (e.v) {
              cur.rehearsals = [
                ...(cur.rehearsals || []),
                e.v as RehearsalProposal,
              ];
            }
            break;
          case "knowledge":
            if (e.v) {
              cur.knowledges = [
                ...(cur.knowledges || []),
                e.v as KnowledgeProposal,
              ];
            }
            break;
          case "component_suggest":
            if (e.v) {
              cur.components = [
                ...(cur.components || []),
                e.v as ComponentSuggestion,
              ];
            }
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
            if (e.saved) errObj.saved = true;
            sseErr = errObj;
            throw errObj;
          }
          default:
            // events only one page understands (the new-delivery form is told what to fill in)
            onOther?.(e);
        }
        push();
      }
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    if (
      (sseErr && e === sseErr) ||
      (e as ChatStreamError)?.diag ||
      (e as ChatStreamError)?.saved ||
      (e as ChatStreamError)?.kind
    ) {
      throw e;
    }
    const raw = (e as Error)?.message || String(e);
    if (e instanceof TypeError || RAW_BROWSER_NET_RE.test(raw.trim()) || /network|stream|aborted|reset|eof/i.test(raw)) {
      const errObj = new Error(
        bi(
          "与 Middleware Hub 平台后端的流式连接意外中断，未收到完整回复",
          "Streaming connection to Middleware Hub was interrupted before the reply completed",
        ),
      ) as ChatStreamError;
      errObj.kind = "stream_interrupted";
      errObj.rawError = raw;
      throw errObj;
    }
    throw e;
  }
  if (
    !sawDone &&
    !cur.text &&
    !cur.ask &&
    !cur.made.length &&
    !(cur.rehearsals && cur.rehearsals.length) &&
    !(cur.knowledges && cur.knowledges.length) &&
    !(cur.components && cur.components.length)
  ) {
    const errObj = new Error(
      bi(
        "与 Middleware Hub 平台后端的连接提前关闭，未收到回复内容",
        "Connection to Middleware Hub closed unexpectedly with no reply",
      ),
    ) as ChatStreamError;
    errObj.kind = "stream_interrupted";
    throw errObj;
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
  onRetry,
  busy,
}: {
  answer?: (text: string) => void;
  onRetry?: () => void;
  busy?: boolean;
  m: Msg;
  jobBase: string;
  props: Record<string, StepProposal | CompProposal>;
  deciding: string;
  decide: (id: string, v: "accept" | "reject", body?: Record<string, unknown>) => void;
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
  const isErrorOnly = Boolean(m.error && !m.text?.trim());
  return (
    <div className={`ad-msg ai ${isErrorOnly ? "is-err" : ""}`}>
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
        {m.error && (
          <ChatErrorCard
            text={m.error}
            diag={m.error_diag}
            at={isErrorOnly ? m.at : undefined}
            onRetry={onRetry}
            busy={busy}
            variant="bubble"
          />
        )}
        {m.files && m.files.length > 0 && <MadeFiles files={m.files} />}
        {m.ask && <AskCard ask={m.ask} answer={answer} />}
        {(m.rehearsals || []).map((r, idx) => (
          <RehearsalLaunchCard
            key={`${r.cluster_id}-${r.title}-${idx}`}
            r={r}
          />
        ))}
        {(m.knowledges || []).map((k, idx) => (
          <KnowledgeCard key={`kb-${k.title}-${idx}`} k={k} />
        ))}
        {(m.components || []).map((c, idx) => (
          <SuggestInlineCard
            key={`comp-${c.component}-${c.title}-${idx}`}
            c={c}
          />
        ))}
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
        {!isErrorOnly && (
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
        )}
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
  decide: (id: string, v: "accept" | "reject", body?: Record<string, unknown>) => void;
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

function openComponentWorkbenchPrefill(
  comp: string,
  title: string,
  detail: string,
  why: string,
): boolean {
  const child = window.open("about:blank", "_blank");
  if (!child) {
    Message.warning(
      bi(
        "浏览器拦截了新标签页，请允许弹出窗口后重试；当前页面已保留。",
        "Pop-up blocked by browser; allow pop-ups and retry (current page is preserved).",
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
            "这次实践识别到一个组件应改进/补充的能力或检查项。",
            why ? "根因：" + why : "",
            "建议：" + title,
            detail ? "详情：" + detail : "",
            "请先读当前组件的相关文件，用 edits 提议最小修改并通过检查；不要直接发布。",
          ]
            .filter(Boolean)
            .join("\n"),
          [
            "Identified a component improvement or missing capability/check.",
            why ? "Root cause: " + why : "",
            "Suggestion: " + title,
            detail ? "Details: " + detail : "",
            "Read the relevant component files first, propose minimal edits that pass checks, and do not publish directly.",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      }),
    );
    child.opener = null;
    child.location.replace(
      window.location.origin +
        window.location.pathname +
        "#/components/" +
        encodeURIComponent(comp) +
        "/edit/overview",
    );
    return true;
  } catch {
    child.close();
    Message.error(
      bi(
        "无法打开组件工作台，请重试；当前页面未离开。",
        "Unable to open Component Workbench; please retry.",
      ),
    );
    return false;
  }
}

function SuggestInlineCard({ c }: { c: ComponentSuggestion }) {
  useLang();
  const [opened, setOpened] = useState(false);
  const open = () => {
    if (
      openComponentWorkbenchPrefill(c.component, c.title, c.detail, c.why || "")
    ) {
      setOpened(true);
    }
  };
  return (
    <article
      className={`ad-card ad-card-comp${opened ? " s-accepted" : ""}`}
      role="region"
      aria-label={bi("组件改进建议", "Component improvement")}
    >
      <header>
        <span className="ad-card-k">
          {bi("组件改进建议", "Component improvement")}
        </span>
        <span className="ad-card-m">{c.component}</span>
      </header>
      <p className="ad-card-t">{c.title}</p>
      {c.detail && <p className="ad-card-d">{c.detail}</p>}
      {c.why && (
        <dl className="ad-card-dl">
          <dt>{bi("缘由", "Reason")}</dt>
          <dd>{c.why}</dd>
        </dl>
      )}
      <div className="ad-card-acts">
        {can("component.edit") ? (
          <Button size="small" type="primary" onClick={open}>
            {opened
              ? bi("再次打开组件工作台", "Open Component Workbench again")
              : bi("新标签页打开，让 AI 起草", "Open in new tab for AI draft")}
          </Button>
        ) : (
          <span className="faint small">
            {bi(
              "需要有组件编辑权限的人处理",
              "Requires component edit permission",
            )}
          </span>
        )}
      </div>
    </article>
  );
}

function KnowledgeCard({
  k,
  status,
  decidedBy,
  busy,
  onAccept,
  onReject,
}: {
  k: KnowledgeProposal;
  status?: string;
  decidedBy?: string;
  busy?: boolean;
  onAccept?: (body: { scope: "personal" | "team"; title: string; content: string }) => void;
  onReject?: () => void;
}) {
  useLang();
  const [showBody, setShowBody] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(k.title || "");
  const [content, setContent] = useState(k.content || "");
  const [saving, setSaving] = useState<"" | "personal" | "team">("");
  const [savedPersonalId, setSavedPersonalId] = useState(k.kb_id || "");
  const [savedTeamId, setSavedTeamId] = useState(k.team_doc_id || "");
  const [savedSubId, setSavedSubId] = useState(k.submission_id || "");

  useEffect(() => {
    setTitle(k.title || "");
    setContent(k.content || "");
    if (k.kb_id) setSavedPersonalId(k.kb_id);
    if (k.team_doc_id) setSavedTeamId(k.team_doc_id);
    if (k.submission_id) setSavedSubId(k.submission_id);
  }, [k.title, k.content, k.kb_id, k.team_doc_id, k.submission_id]);

  const isProposal = status !== undefined;
  const done = isProposal && status !== "pending";
  const canManageTeam = can("kb.manage");
  const canSubmitTeam = can("kb.submit");
  const preferTeam = k.scope === "team" && (canManageTeam || canSubmitTeam);

  const saveDirect = async (target: "personal" | "team") => {
    const cleanTitle = title.trim() || k.title;
    const cleanText = content.trim() || k.content;
    if (!cleanTitle || !cleanText) {
      Message.warning(bi("标题和正文不能为空", "Title and content cannot be empty"));
      return;
    }
    if (onAccept) {
      onAccept({ scope: target, title: cleanTitle, content: cleanText });
      setEditing(false);
      return;
    }
    setSaving(target);
    try {
      if (target === "personal") {
        const res = await api<{ id: string; title: string }>("/api/me/kb", {
          method: "POST",
          body: JSON.stringify({ title: cleanTitle, text: cleanText }),
        });
        setSavedPersonalId(res.id || "saved");
        setEditing(false);
        Message.success(bi("已存入「我的知识库」", "Saved to your personal Knowledge Base"));
      } else if (canManageTeam) {
        const res = await api<{ id: string; title: string }>("/api/kb", {
          method: "POST",
          body: JSON.stringify({
            title: cleanTitle,
            text: cleanText,
            source: k.source || "",
          }),
        });
        setSavedTeamId(res.id || "saved");
        setEditing(false);
        Message.success(bi("已直接发布到团队知识库", "Published to team Knowledge Base"));
      } else {
        const res = await api<{ id: string }>("/api/kb/submissions", {
          method: "POST",
          body: JSON.stringify({
            title: cleanTitle,
            text: cleanText,
            source: k.source || "",
          }),
        });
        setSavedSubId(res.id || "submitted");
        setEditing(false);
        Message.success(
          bi(
            "已提交团队知识库审核，管理员通过后全员可用",
            "Submitted to team Knowledge Base for admin review",
          ),
        );
      }
    } catch (e) {
      err(e);
    } finally {
      setSaving("");
    }
  };

  const savedInline = Boolean(savedPersonalId || savedTeamId || savedSubId);

  return (
    <article
      className={`ad-card ad-card-kb${status ? ` s-${status}` : savedInline ? " s-accepted" : ""}`}
      role="region"
      aria-label={bi("写入知识库总结卡片", "Knowledge base summary card")}
    >
      <header className="ad-kb-head">
        <span className="ad-kb-badge">
          <IconBook />
          <span>{bi("知识库总结卡片", "KB Summary Card")}</span>
        </span>
        <div className="ad-kb-meta">
          <span className="ad-kb-scope">
            {k.scope === "team"
              ? bi("推荐：团队知识库", "Suggested: Team KB")
              : bi("推荐：我的知识库", "Suggested: My KB")}
          </span>
          {k.source && <span className="ad-kb-src">{k.source}</span>}
        </div>
      </header>

      {editing ? (
        <div className="ad-kb-edit">
          <Input
            size="small"
            value={title}
            onChange={setTitle}
            placeholder={bi("知识库文档标题", "Document title")}
            aria-label={bi("知识库文档标题", "Document title")}
          />
          <Input.TextArea
            value={content}
            onChange={setContent}
            autoSize={{ minRows: 5, maxRows: 14 }}
            className="mono"
            placeholder={bi("Markdown 正文内容", "Markdown content")}
            aria-label={bi("知识库正文内容", "Document content")}
          />
        </div>
      ) : (
        <>
          <p className="ad-card-t">{title}</p>
          {k.summary && <p className="ad-card-d">{k.summary}</p>}
          <div className="ad-rh-goal">
            <button
              type="button"
              className="ad-rh-goal-toggle"
              aria-expanded={showBody}
              onClick={() => setShowBody((v) => !v)}
            >
              <span>
                {showBody
                  ? bi("收起知识库正文预览", "Hide document preview")
                  : bi("展开预览知识库正文", "Preview full KB document")}
              </span>
              <IconDown className={showBody ? "ad-flip" : ""} />
            </button>
            {showBody && (
              <div className="ad-kb-body">
                <Markdown text={content} />
              </div>
            )}
          </div>
        </>
      )}

      {done ? (
        <div className={`ad-card-done s-${status}`}>
          <span className="ad-card-verdict">
            {status === "accepted" ? <IconCheck /> : null}
            <span>
              {decidedBy}{" "}
              {status === "accepted"
                ? k.team_doc_id
                  ? bi("已发布到团队知识库", "published to team KB")
                  : k.submission_id
                    ? bi("已提交团队知识库审核", "submitted to team KB review")
                    : bi("已存入「我的知识库」", "saved to personal KB")
                : bi("已忽略", "dismissed")}
            </span>
          </span>
          {status === "accepted" && (
            <button
              type="button"
              className="link"
              onClick={() =>
                go(
                  k.team_doc_id
                    ? { name: "kb", id: k.team_doc_id }
                    : k.kb_id
                      ? { name: "kb", id: `my-${k.kb_id}` }
                      : { name: "kb" },
                )
              }
            >
              {bi("前往知识库查看", "Open in Knowledge Base")}
            </button>
          )}
        </div>
      ) : (
        <div className="ad-card-acts">
          {(canManageTeam || canSubmitTeam) && (
            <Button
              size="small"
              type={preferTeam ? "primary" : "outline"}
              loading={busy || saving === "team"}
              disabled={busy || saving !== "" || Boolean(savedTeamId || savedSubId)}
              onClick={() => void saveDirect("team")}
            >
              {savedTeamId
                ? bi("已发布到团队知识库", "Published to team KB")
                : savedSubId
                  ? bi("已提交审核", "Submitted for review")
                  : canManageTeam
                    ? bi("发布到团队知识库", "Publish to Team KB")
                    : bi("提交到团队知识库（需审核）", "Submit to Team KB")}
            </Button>
          )}
          <Button
            size="small"
            type={preferTeam ? "outline" : "primary"}
            loading={busy || saving === "personal"}
            disabled={busy || saving !== "" || Boolean(savedPersonalId)}
            onClick={() => void saveDirect("personal")}
          >
            {savedPersonalId
              ? bi("已存入我的知识库", "Saved to My KB")
              : bi("存入我的知识库", "Save to My KB")}
          </Button>
          <Button
            size="small"
            type="text"
            icon={<IconEdit />}
            disabled={busy || saving !== ""}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? bi("完成微调", "Done editing") : bi("微调内容", "Edit")}
          </Button>
          {savedInline && (
            <button
              type="button"
              className="link"
              onClick={() =>
                go(
                  savedTeamId && savedTeamId !== "saved"
                    ? { name: "kb", id: savedTeamId }
                    : savedPersonalId && savedPersonalId !== "saved"
                      ? { name: "kb", id: `my-${savedPersonalId}` }
                      : { name: "kb" },
                )
              }
            >
              {bi("去知识库查看", "Open KB")}
            </button>
          )}
          {isProposal && onReject && (
            <Button
              size="small"
              disabled={busy || saving !== ""}
              onClick={() => onReject()}
            >
              {bi("暂不保存", "Dismiss")}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

function KnowledgeProposalCard({
  s,
  busy,
  decide,
}: {
  s: StepProposal;
  busy: boolean;
  decide: (
    id: string,
    v: "accept" | "reject",
    body?: Record<string, unknown>,
  ) => void;
}) {
  const k = s.knowledge;
  if (!k) return null;
  return (
    <KnowledgeCard
      k={k}
      status={s.status}
      decidedBy={s.decided_by}
      busy={busy}
      onAccept={(body) => decide(s.id, "accept", body)}
      onReject={() => decide(s.id, "reject")}
    />
  );
}

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
  const openWorkbench = () =>
    openComponentWorkbenchPrefill(comp, s.step.title, s.step.desc || "", s.reason);
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

const VEX_STATUS_META: Record<string, { zh: string; en: string; cls: string }> = {
  open: { zh: "待评估", en: "Open", cls: "s-open" },
  planned: { zh: "计划修复", en: "Planned", cls: "s-planned" },
  mitigated: { zh: "已缓解", en: "Mitigated", cls: "s-mitigated" },
  not_affected: { zh: "不受影响", en: "Not Affected", cls: "s-not_affected" },
  accepted: { zh: "风险豁免", en: "Accepted Risk", cls: "s-accepted" },
};

const VEX_JUST_LABEL: Record<string, [string, string]> = {
  vulnerable_code_not_in_execute_path: [
    "漏洞代码不在执行路径",
    "Vulnerable code not in execute path",
  ],
  inline_mitigations_already_exist: [
    "已存在补偿性缓解措施",
    "Inline mitigations already exist",
  ],
  component_not_present: [
    "受影响组件/模块未启用",
    "Component / module not present",
  ],
};

function VexProposalCard({
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
  const v = s.vex;
  if (!v) return null;
  const done = s.status !== "pending";
  const st = VEX_STATUS_META[v.status] || {
    zh: v.status,
    en: v.status,
    cls: "s-open",
  };
  const cves = v.cves && v.cves.length > 0 ? v.cves : v.cve ? [v.cve] : [];
  const justPair = v.justification ? VEX_JUST_LABEL[v.justification] : undefined;
  const canManage = can("security.manage");
  const quickWhy = [
    bi("状态不太对，换一个 VEX 状态", "Wrong VEX status—pick another"),
    bi("补充一下现场隔离/业务条件再改说明", "Let me add site context to revise the note"),
    bi("暂不写 VEX，先告诉我升级修复方案", "Skip VEX for now—give upgrade guidance"),
  ];
  return (
    <article className={`ad-card ad-card-sec s-${s.status}`}>
      <header>
        <span className="ad-card-k">{bi("VEX 漏洞处置提案", "VEX Triage Proposal")}</span>
        <span className="ad-card-m">
          {v.global
            ? bi("全局 CVE 生效", "Global CVE scope")
            : v.package
              ? `${v.package}${v.ecosystem ? ` · ${v.ecosystem}` : ""}`
              : bi("按当前包生效", "Package scope")}
        </span>
      </header>
      <div className="ad-sec-head">
        <div className="ad-sec-cves">
          {cves.slice(0, 4).map((c) => (
            <code key={c} className="ad-sec-cve">
              {c}
            </code>
          ))}
          {cves.length > 4 && (
            <span className="ad-sec-more">+{cves.length - 4}</span>
          )}
        </div>
        <span className={`ad-vex-pill ${st.cls}`}>{bi(st.zh, st.en)}</span>
      </div>
      {(justPair || v.expires_at) && (
        <div className="ad-sec-meta">
          {justPair && (
            <span>
              {bi("标准依据：", "Justification: ")}
              <b>{bi(justPair[0], justPair[1])}</b>
            </span>
          )}
          {v.expires_at && (
            <span>
              {bi("复审到期：", "Expires: ")}
              <b className="mono">{v.expires_at}</b>
            </span>
          )}
        </div>
      )}
      <div className="ad-sec-note">{v.note}</div>
      {s.reason && (
        <dl className="ad-card-dl">
          <dt>{bi("推荐理由", "Why")}</dt>
          <dd>{s.reason}</dd>
        </dl>
      )}
      {done ? (
        <div className={`ad-card-done s-${s.status}`}>
          <span className="ad-card-verdict">
            {s.status === "accepted" ? <IconCheck /> : null}
            <span>
              {s.decided_by}{" "}
              {s.status === "accepted"
                ? bi("已采纳并写入 VEX", "accepted & saved to VEX")
                : bi("已拒绝", "rejected")}
            </span>
          </span>
        </div>
      ) : rejecting ? (
        <div className="ad-card-why">
          <b>
            {bi(
              "需要怎么调整？告诉 AI，它会立即修改提案",
              "How should this be adjusted? Tell AI so it can revise",
            )}
          </b>
          <div className="ad-card-opts">
            {quickWhy.map((o) => (
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
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder={bi(
              "例如：这个集群仅内网访问、请改成「已缓解」并补充说明",
              "e.g. Internal network only—change to Mitigated and update note",
            )}
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
                    `我没有采纳这张 VEX 处置提案：${why.trim()}`,
                    `I rejected this VEX proposal: ${why.trim()}`,
                  ),
                );
              }}
            >
              {bi("发给 AI 调整", "Send to AI")}
            </Button>
            <Button size="small" onClick={() => decide(s.id, "reject")}>
              {bi("只拒绝", "Reject only")}
            </Button>
            <Button size="small" type="text" onClick={() => setRejecting(false)}>
              {bi("取消", "Cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="ad-card-acts">
          <Tooltip
            content={
              canManage
                ? bi("立即写入安全中心 VEX 处置记录并刷新页面", "Write directly to Security Center VEX records")
                : bi("需要「安全处置」权限才能写入 VEX", "Requires security.manage permission")
            }
            mini
          >
            <Button
              size="small"
              type="primary"
              loading={busy}
              disabled={!canManage}
              onClick={() => decide(s.id, "accept")}
            >
              {bi("采纳并写入 VEX", "Accept & Save VEX")}
            </Button>
          </Tooltip>
          {canManage && cves.length === 1 && (
            <Button
              size="small"
              disabled={busy}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent(VEX_OPEN_DRAFT, { detail: v }),
                )
              }
            >
              {bi("在弹窗中微调", "Edit in Modal")}
            </Button>
          )}
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

function BaselineWaiveProposalCard({
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
  const b = s.baseline;
  if (!b) return null;
  const done = s.status !== "pending";
  const canManage = can("security.manage");
  return (
    <article className={`ad-card ad-card-sec s-${s.status}`}>
      <header>
        <span className="ad-card-k">
          {bi("配置基线豁免提案", "Baseline Waiver Proposal")}
        </span>
        <span className="ad-card-m">{b.cluster_id}</span>
      </header>
      <p className="ad-card-t">{b.title || b.check_id}</p>
      <div className="ad-sec-note">{b.note}</div>
      {s.reason && (
        <dl className="ad-card-dl">
          <dt>{bi("建议说明", "Reason")}</dt>
          <dd>{s.reason}</dd>
        </dl>
      )}
      {done ? (
        <div className={`ad-card-done s-${s.status}`}>
          <span className="ad-card-verdict">
            {s.status === "accepted" ? <IconCheck /> : null}
            <span>
              {s.decided_by}{" "}
              {s.status === "accepted"
                ? bi("已采纳并豁免基线", "accepted & waived baseline")
                : bi("已拒绝", "rejected")}
            </span>
          </span>
        </div>
      ) : rejecting ? (
        <div className="ad-card-why">
          <b>{bi("不豁免的原因？告诉 AI 改出加固方案", "Why not waive? Tell AI to suggest hardening instead")}</b>
          <Input.TextArea
            value={why}
            onChange={setWhy}
            autoSize={{ minRows: 2, maxRows: 4 }}
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
                    `我不豁免这条基线：${why.trim()}`,
                    `I rejected this baseline waiver: ${why.trim()}`,
                  ),
                );
              }}
            >
              {bi("发给 AI", "Send to AI")}
            </Button>
            <Button size="small" onClick={() => decide(s.id, "reject")}>
              {bi("只拒绝", "Reject only")}
            </Button>
            <Button size="small" type="text" onClick={() => setRejecting(false)}>
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
            disabled={!canManage}
            onClick={() => decide(s.id, "accept")}
          >
            {bi("采纳并豁免基线", "Accept & Waive Baseline")}
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

function rehearsalKindLabel(kind?: string, mode?: string): string {
  const m = (mode || "").toLowerCase();
  const prefix =
    m === "quick"
      ? bi("极速变更", "Quick Change")
      : m === "light"
        ? bi("简单推演", "Light Rehearsal")
        : m === "full"
          ? bi("全量推演", "Full Rehearsal")
          : bi("变更演练", "Rehearsal");
  switch ((kind || "").toLowerCase()) {
    case "tune":
      return `${prefix} · ${bi("参数与配置", "Config & Tuning")}`;
    case "upgrade":
      return `${prefix} · ${bi("版本升级", "Version Upgrade")}`;
    case "scale":
      return `${prefix} · ${bi("节点扩缩", "Scaling")}`;
    case "switch":
      return `${prefix} · ${bi("主备切换", "Failover Drill")}`;
    case "security":
      return bi("安全修复演练", "Security Rehearsal");
    default:
      return m === "quick"
        ? bi("极速变更 · 直出步骤与报告", "Quick Change · Direct Steps & Report")
        : m === "light"
          ? bi("简单推演建议", "Light Rehearsal")
          : m === "full"
            ? bi("全量推演建议", "Full Rehearsal")
            : bi("变更演练建议", "Change Rehearsal");
  }
}

function openRehearsalFromSpec(r: RehearsalProposal) {
  const goalText = r.goal?.trim() || r.summary?.trim() || r.title;
  const isSec =
    r.kind === "security" || (r.cves !== undefined && r.cves.length > 0);
  if (isSec) {
    launchSecurityRehearsalIntent(r.cluster_id, {
      title: r.title,
      goal: goalText,
      securityContext: {
        kind:
          r.packages && r.packages.length > 0
            ? "cve_patch"
            : "config_hardening",
        cves: r.cves,
        package: r.packages?.[0],
      },
    });
    return;
  }
  const presetKind: RehearsalPresetKind | undefined =
    r.kind === "upgrade" ||
    r.kind === "scale" ||
    r.kind === "tune" ||
    r.kind === "switch"
      ? r.kind
      : undefined;
  const modeLower = (r.mode || "").toLowerCase();
  const resolvedMode =
    modeLower === "quick"
      ? ("quick" as const)
      : modeLower === "light"
        ? ("light" as const)
        : modeLower === "full"
          ? ("full" as const)
          : undefined;
  const modeTag =
    resolvedMode === "quick"
      ? bi("极速变更", "Quick")
      : resolvedMode === "light"
        ? bi("简单推演", "Light")
        : resolvedMode === "full"
          ? bi("全量推演", "Full")
          : bi("变更演练", "Rehearsal");
  const kindBadge =
    r.kind === "tune"
      ? bi(`AI 对话 · ${modeTag} · 参数与配置`, `AI Chat · ${modeTag} · Config & Tuning`)
      : r.kind === "upgrade"
        ? bi(`AI 对话 · ${modeTag} · 版本升级`, `AI Chat · ${modeTag} · Version Upgrade`)
        : r.kind === "scale"
          ? bi(`AI 对话 · ${modeTag} · 节点扩缩`, `AI Chat · ${modeTag} · Scaling`)
          : r.kind === "switch"
            ? bi(`AI 对话 · ${modeTag} · 主备切换`, `AI Chat · ${modeTag} · Failover Drill`)
            : bi(`AI 对话 · ${modeTag}`, `AI Chat · ${modeTag}`);
  const tags = [
    r.cluster_id,
    ...(r.app_label ? [r.app_label] : []),
    ...(r.packages || []),
  ].filter(Boolean);
  launchRehearsalIntent(r.cluster_id, presetKind, {
    mode: resolvedMode,
    title: r.title,
    goal: goalText,
    sourceContext: {
      source: "ai_chat",
      badge: kindBadge,
      subject: r.title,
      tags,
      note:
        r.reason && r.reason.trim() !== r.title.trim()
          ? r.reason.trim()
          : undefined,
    },
  });
}

function RehearsalLaunchCard({
  r,
  status,
  decidedBy,
  busy,
  onAccept,
  onReject,
}: {
  r: RehearsalProposal;
  status?: string;
  decidedBy?: string;
  busy?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
}) {
  useLang();
  const [showGoal, setShowGoal] = useState(false);
  const isProposal = status !== undefined;
  const done = isProposal && status !== "pending";
  const isQuick = (r.mode || "").toLowerCase() === "quick";
  const isLight = (r.mode || "").toLowerCase() === "light";
  const isFull = (r.mode || "").toLowerCase() === "full";
  const modeCls = isQuick ? " is-quick" : isLight ? " is-light" : "";
  const hasGoalDetail = Boolean(
    r.goal && r.goal.trim() && r.goal.trim() !== (r.summary || "").trim(),
  );
  const showReason = Boolean(
    r.reason &&
      r.reason.trim() &&
      r.reason.trim() !== (r.summary || "").trim(),
  );

  return (
    <article
      className={`ad-card ad-card-rh${modeCls}${status ? ` s-${status}` : ""}`}
      role="region"
      aria-label={bi("变更演练卡片", "Change rehearsal card")}
    >
      <header className="ad-rh-head">
        <span className={`ad-rh-badge${modeCls}`}>
          <IconThunderbolt />
          <span>{rehearsalKindLabel(r.kind, r.mode)}</span>
        </span>
        <div className="ad-rh-target">
          <span className="ad-rh-cluster">{r.cluster_id}</span>
          {r.app_label && <span className="ad-rh-app">{r.app_label}</span>}
          {r.running && (
            <span className="ad-rh-live">
              <i aria-hidden />
              {bi("运行中", "Running")}
            </span>
          )}
        </div>
      </header>
      <p className="ad-card-t">{r.title}</p>
      {((r.packages && r.packages.length > 0) ||
        (r.cves && r.cves.length > 0)) && (
        <div className="ad-sec-cves" style={{ marginBottom: 6 }}>
          {(r.packages || []).map((pk) => (
            <span key={pk} className="ad-tag">
              {pk}
            </span>
          ))}
          {(r.cves || []).slice(0, 4).map((c) => (
            <code key={c} className="ad-sec-cve">
              {c}
            </code>
          ))}
        </div>
      )}
      {r.summary && <p className="ad-card-d">{r.summary}</p>}
      {showReason && (
        <p className="ad-rh-reason">
          <b>
            {isQuick
              ? bi("建议走极速变更（留存变更报告）：", "Why quick change (leaves Change Report): ")
              : isLight
                ? bi("建议走简单推演：", "Why light rehearsal: ")
                : isFull
                  ? bi("建议走全量推演：", "Why full rehearsal: ")
                  : bi("建议走演练：", "Why rehearse: ")}
          </b>
          {r.reason}
        </p>
      )}
      {hasGoalDetail && (
        <div className="ad-rh-goal">
          <button
            type="button"
            className="ad-rh-goal-toggle"
            aria-expanded={showGoal}
            onClick={() => setShowGoal((v) => !v)}
          >
            <span>
              {showGoal
                ? bi("收起带入的变更目标", "Hide prefilled change goal")
                : bi("预览将带入的变更目标", "Preview prefilled change goal")}
            </span>
            <IconDown className={showGoal ? "ad-flip" : ""} />
          </button>
          {showGoal && <div className="ad-rh-goal-body">{r.goal}</div>}
        </div>
      )}
      {done ? (
        <div className={`ad-card-done s-${status}`}>
          <span className="ad-card-verdict">
            {status === "accepted" ? <IconCheck /> : null}
            <span>
              {decidedBy}{" "}
              {status === "accepted"
                ? bi("已采纳", "accepted")
                : bi("已忽略", "dismissed")}
            </span>
          </span>
          {status === "accepted" && (
            <button
              type="button"
              className="link"
              onClick={() => openRehearsalFromSpec(r)}
            >
              {isQuick
                ? bi("带入目标前往极速变更", "Open Quick Change")
                : isLight
                  ? bi("带入目标前往简单推演", "Open Light Rehearsal")
                  : isFull
                    ? bi("带入目标前往全量推演", "Open Full Rehearsal")
                    : bi("带入目标前往变更演练", "Open Rehearsal with Goal")}
            </button>
          )}
        </div>
      ) : isProposal ? (
        <div className="ad-card-acts">
          <Button
            size="small"
            type="primary"
            loading={busy}
            onClick={() => {
              onAccept?.();
              openRehearsalFromSpec(r);
            }}
          >
            {isQuick
              ? bi("采纳并直出步骤与报告", "Accept & Quick Change")
              : isLight
                ? bi("采纳并前往简单推演", "Accept & Launch Light Rehearsal")
                : isFull
                  ? bi("采纳并前往全量推演", "Accept & Launch Full Rehearsal")
                  : bi("采纳并前往演练", "Accept & Launch Rehearsal")}
            <IconRight style={{ marginLeft: 4 }} />
          </Button>
          <Button size="small" disabled={busy} onClick={() => onReject?.()}>
            {bi("暂不需要", "Dismiss")}
          </Button>
        </div>
      ) : (
        <div className="ad-card-acts">
          <Button
            size="small"
            type="primary"
            onClick={() => openRehearsalFromSpec(r)}
          >
            {isQuick
              ? bi("发起极速变更", "Launch Quick Change")
              : isLight
                ? bi("发起简单推演", "Launch Light Rehearsal")
                : isFull
                  ? bi("发起全量推演", "Launch Full Rehearsal")
                  : bi("发起变更演练", "Launch Change Rehearsal")}
            <IconRight style={{ marginLeft: 4 }} />
          </Button>
          <Button
            size="small"
            onClick={() => go({ name: "deliveries", id: r.cluster_id })}
          >
            {bi("查看集群", "Open Cluster")}
          </Button>
        </div>
      )}
    </article>
  );
}

function RehearsalProposalCard({
  s,
  busy,
  decide,
}: {
  s: StepProposal;
  busy: boolean;
  decide: (id: string, v: "accept" | "reject") => void;
}) {
  const r = s.rehearsal;
  if (!r) return null;
  return (
    <RehearsalLaunchCard
      r={r}
      status={s.status}
      decidedBy={s.decided_by}
      busy={busy}
      onAccept={() => decide(s.id, "accept")}
      onReject={() => decide(s.id, "reject")}
    />
  );
}

function RehearsalStepEditCard({
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
  const rs = s.rehearsal_step;
  if (!rs) return null;
  const done = s.status !== "pending";
  const actionLabel =
    rs.action === "insert_before"
      ? bi("前置插入演练步骤", "Insert step before")
      : rs.action === "insert_after"
        ? bi("后置插入演练步骤", "Insert step after")
        : rs.action === "delete"
          ? bi("删除演练步骤", "Delete rehearsal step")
          : bi("修改演练步骤", "Modify rehearsal step");
  const phaseLabel: Record<string, string> = {
    precheck: bi("预检", "Precheck"),
    execute: bi("执行", "Execute"),
    verify: bi("验收", "Verify"),
    rollback: bi("回退", "Rollback"),
  };
  const stepTag = rs.step_order
    ? bi(`步骤 #${rs.step_order}`, `Step #${rs.step_order}`)
    : rs.step_id;
  const verdict =
    s.status === "accepted"
      ? bi(`${s.decided_by || "用户"} 已采纳`, `${s.decided_by || "User"} accepted`)
      : s.status === "rejected"
        ? bi(`${s.decided_by || "用户"} 已拒绝`, `${s.decided_by || "User"} rejected`)
        : "";
  const reject = (text: string) => {
    decide(s.id, "reject");
    setRejecting(false);
    if (feedback && text.trim()) {
      feedback(
        bi(
          `我没有采纳这条演练步骤修订：${text.trim()}`,
          `I rejected this rehearsal step edit: ${text.trim()}`,
        ),
      );
    }
  };
  return (
    <article className={`ad-card s-${s.status}`}>
      <header>
        <span className="ad-card-k">{actionLabel}</span>
        <span className="ad-card-m">
          {rs.rehearsal_title ? `${rs.rehearsal_title} · ` : ""}
          {stepTag}
          {rs.phase && phaseLabel[rs.phase] ? ` · ${phaseLabel[rs.phase]}` : ""}
        </span>
      </header>
      <p className="ad-card-t">
        {rs.title || rs.old_title || rs.step_id}
      </p>
      {rs.target_role && (
        <p className="ad-card-d">
          {bi("执行机器：", "Run on: ")}
          <b>{rs.target_role}</b>
        </p>
      )}
      {rs.action !== "delete" && rs.command && (
        <CodeBlock
          text={rs.command}
          caption={
            rs.action === "replace"
              ? bi("修改后的执行命令", "Updated command")
              : bi("新增步骤命令", "New step command")
          }
        />
      )}
      {rs.action === "replace" &&
        rs.old_command &&
        rs.old_command.trim() !== (rs.command || "").trim() && (
          <details className="ad-card-warn">
            <summary>{bi("对比修改前的原命令", "Compare previous command")}</summary>
            <CodeBlock text={rs.old_command} caption={bi("原命令", "Previous")} />
          </details>
        )}
      <dl className="ad-card-dl">
        {rs.expect && (
          <>
            <dt>{bi("预期判据", "Expected")}</dt>
            <dd>{rs.expect}</dd>
          </>
        )}
        {rs.risk_note && (
          <>
            <dt>{bi("注意事项", "Caution")}</dt>
            <dd>{rs.risk_note}</dd>
          </>
        )}
        {rs.rollback && (
          <>
            <dt>{bi("回退方式", "Rollback")}</dt>
            <dd>{rs.rollback}</dd>
          </>
        )}
        {s.reason && (
          <>
            <dt>{bi("修改原因", "Reason")}</dt>
            <dd>{s.reason}</dd>
          </>
        )}
      </dl>
      {!done && rejecting ? (
        <div className="ad-card-why">
          <b>
            {bi(
              "不采纳的原因？告诉 AI，它会重新调整这条演练步骤",
              "Why reject? Tell AI how to adjust this step",
            )}
          </b>
          <Input.TextArea
            value={why}
            onChange={setWhy}
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder={bi(
              "例如：想拆成两步 / 只在 node-2 执行 / 命令里不要加 --force",
              "e.g. split into two steps / run on node-2 only / drop --force",
            )}
          />
          <div className="ad-card-acts">
            <Button
              size="small"
              type="primary"
              disabled={!why.trim()}
              onClick={() => reject(why)}
            >
              {bi("发给 AI 调整", "Send to AI")}
            </Button>
            <Button size="small" onClick={() => reject("")}>
              {bi("只拒绝", "Reject")}
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
            onClick={() => decide(s.id, "accept")}
          >
            {rs.action === "delete"
              ? bi("确认删除该演练步骤", "Confirm Delete Step")
              : bi("采纳并更新演练步骤", "Accept & Update Step")}
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
      ) : (
        <div className={`ad-card-done s-${s.status}`}>
          <span className="ad-card-verdict">
            {s.status === "accepted" ? <IconCheck /> : null}
            <span>{verdict}</span>
          </span>
          {s.status === "accepted" && (
            <span className="ad-card-result">
              {bi("已同步更新变更演练步骤", "Synced to change rehearsal")}
            </span>
          )}
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
  decide: (
    id: string,
    v: "accept" | "reject",
    body?: Record<string, unknown>,
  ) => void;
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
  if (s.kind === "vex")
    return (
      <VexProposalCard s={s} busy={busy} decide={decide} feedback={feedback} />
    );
  if (s.kind === "baseline_waive")
    return (
      <BaselineWaiveProposalCard
        s={s}
        busy={busy}
        decide={decide}
        feedback={feedback}
      />
    );
  if (s.kind === "rehearsal")
    return <RehearsalProposalCard s={s} busy={busy} decide={decide} />;
  if (s.kind === "rehearsal_step")
    return (
      <RehearsalStepEditCard
        s={s}
        busy={busy}
        decide={decide}
        feedback={feedback}
      />
    );
  if (s.kind === "knowledge")
    return <KnowledgeProposalCard s={s} busy={busy} decide={decide} />;
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

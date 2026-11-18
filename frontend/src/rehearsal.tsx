import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Button,
  Dropdown,
  Input,
  Message,
  Modal,
  Popconfirm,
  Skeleton,
  Tag,
  Tooltip,
  Upload,
} from "@arco-design/web-react";
import {
  IconBulb,
  IconCheck,
  IconClose,
  IconCopy,
  IconDelete,
  IconDown,
  IconDownload,
  IconEdit,
  IconExclamationCircle,
  IconExpand,
  IconFile,
  IconImage,
  IconPlus,
  IconRecordStop,
  IconRefresh,
  IconRight,
  IconSearch,
  IconShrink,
  IconUp,
  IconUpload,
} from "@arco-design/web-react/icon";
import {
  ApiError,
  ago,
  api,
  cached,
  can,
  copy,
  csrfToken,
  err,
  fetchCached,
  platformShort,
  putCached,
  useAIStatus,
  useConnectivity,
  useMedia,
} from "./shared";
import type {
  AIAttemptDiag,
  AICallDiag,
  ChangeRehearsal,
  ClusterView,
  JobDetail,
  RehearsalStep,
  RehearsalTrace,
  RehearsalTraceStep,
  ScopeQuestion,
} from "./shared";
import { SchemeInfo, schemeName } from "./scheme";
import { go } from "./router";
import { Segmented, Smooth } from "./ui";
import { Spark } from "./aichat";
import { ModelPicker, useModelPick } from "./modelpick";
import { ThinkLevel, useAIOptions } from "./aitools";
import "./rehearsal.css";

export type RehearsalPresetKind = "upgrade" | "scale" | "tune" | "switch";

const INTENT_KEY = "mh-rehearsal-intent";

export function launchRehearsalIntent(
  clusterId: string,
  kind?: RehearsalPresetKind,
) {
  try {
    if (kind) {
      sessionStorage.setItem(
        INTENT_KEY,
        JSON.stringify({ cluster: clusterId, kind }),
      );
    } else {
      sessionStorage.setItem(
        INTENT_KEY,
        JSON.stringify({ cluster: clusterId, create: true }),
      );
    }
  } catch {
    /* ignore storage limits */
  }
  go({ name: "deliveries", id: clusterId, tab: "rehearsal" });
}

const STAGE_ORDER: ChangeRehearsal["stage"][] = [
  "scoping",
  "probing",
  "rehearsing",
  "finalized",
];

const STAGE_META: Record<
  ChangeRehearsal["stage"],
  { short: string; title: string; sub: string }
> = {
  scoping: {
    short: "边界对齐",
    title: "变更诉求与边界对齐",
    sub: "确认维护窗口与高可用约束",
  },
  probing: {
    short: "只读探针",
    title: "现场只读采集与漂移识别",
    sub: "零修改采集生产真实角色与参数",
  },
  rehearsing: {
    short: "测试演练",
    title: "测试环境分步验证",
    sub: "逐步实测耗时并就地排障修订",
  },
  finalized: {
    short: "生产 SOP",
    title: "生产变更实施方案",
    sub: "映射生产节点并导出 Word",
  },
};

const PHASE_LABEL: Record<RehearsalStep["phase"], string> = {
  precheck: "预检",
  execute: "执行",
  verify: "验收",
  rollback: "回退",
};

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/* ---------- Streaming SSE State & Client ---------- */

type LivePipelineKind = "create" | "scope" | "probe" | "troubleshoot";

type LiveAIState = {
  kind: LivePipelineKind;
  title: string;
  startedAt: number;
  model?: string;
  provider?: string;
  failover?: boolean;
  steps: RehearsalTraceStep[];
  thinking: string;
  phase: string;
  chars: number;
  error?: string;
  errorCode?: number;
  errorAt?: number;
  errorDiag?: AICallDiag;
};

function buildInitialPipelineSteps(kind: LivePipelineKind): RehearsalTraceStep[] {
  if (kind === "scope") {
    return [
      {
        id: "align-scope",
        kind: "inspect",
        title: "锁定变更边界与窗口约束",
        detail: "对齐维护窗口前提，装载组件巡检规则字典…",
        ok: true,
        status: "running",
      },
      {
        id: "inject-ro-policy",
        kind: "guard",
        title: "注入纯只读安全红线规则",
        detail: "锁定零修改、零服务控制、零文件重定向及凭据过滤约束",
        ok: true,
        status: "pending",
      },
      {
        id: "connect-model",
        kind: "connect",
        title: "连接模型网关与投递上下文",
        detail: "等待前序安全校验完成后建立模型流式连接",
        ok: true,
        status: "pending",
      },
      {
        id: "model-think",
        kind: "think",
        title: "设计生产现场纯只读采集策略",
        detail: "等待模型通道返回首包后展开推演",
        ok: true,
        status: "pending",
      },
      {
        id: "readonly-ast-guard",
        kind: "guard",
        title: "生成探针与静态安全红线扫描",
        detail: "等待脚本编写完成后执行 15 类高危写操作静态扫描",
        ok: true,
        status: "pending",
      },
    ];
  }
  if (kind === "probe") {
    return [
      {
        id: "parse-probe",
        kind: "inspect",
        title: "解析现场采集证据与交付基线",
        detail: "提取现场回显/截图与集群初始交付拓扑…",
        ok: true,
        status: "running",
      },
      {
        id: "scrub-probe",
        kind: "guard",
        title: "现场回显敏感凭据二次脱敏",
        detail: "自动擦除回显中的口令、密钥与连接串",
        ok: true,
        status: "pending",
      },
      {
        id: "connect-model",
        kind: "connect",
        title: "连接模型网关与投递上下文",
        detail: "等待脱敏完成后建立模型流式连接",
        ok: true,
        status: "pending",
      },
      {
        id: "model-think",
        kind: "think",
        title: "逐节点比对拓扑角色与参数漂移",
        detail: "等待模型通道返回首包后展开推演",
        ok: true,
        status: "pending",
      },
      {
        id: "build-rehearsal-plan",
        kind: "synthesize",
        title: "完成漂移诊断与分步演练编排",
        detail: "等待漂移研判完成后编排预检/执行/验收/回退步骤",
        ok: true,
        status: "pending",
      },
    ];
  }
  if (kind === "troubleshoot") {
    return [
      {
        id: "inspect-step-err",
        kind: "inspect",
        title: "定位受阻步骤与报错证据",
        detail: "读取当前演练步骤命令、判据与报错输出…",
        ok: true,
        status: "running",
      },
      {
        id: "scrub-err-context",
        kind: "guard",
        title: "报错回显脱敏与上下文封装",
        detail: "剥离报错输出中的敏感凭据，锁定演练步骤边界",
        ok: true,
        status: "pending",
      },
      {
        id: "connect-model",
        kind: "connect",
        title: "连接模型网关与投递上下文",
        detail: "等待脱敏完成后建立模型流式连接",
        ok: true,
        status: "pending",
      },
      {
        id: "model-think",
        kind: "think",
        title: "诊断报错信号与环境根因推理",
        detail: "等待模型通道返回首包后展开推演",
        ok: true,
        status: "pending",
      },
      {
        id: "propose-fix",
        kind: "synthesize",
        title: "生成命令修订提案",
        detail: "等待根因明确后生成就地替换或前置步骤命令",
        ok: true,
        status: "pending",
      },
    ];
  }
  return [
    {
      id: "read-baseline",
      kind: "inspect",
      title: "读取集群初始交付基线",
      detail: "装载集群节点拓扑、组件版本与运行方案基线…",
      ok: true,
      status: "running",
    },
    {
      id: "scrub-context",
      kind: "guard",
      title: "敏感凭据脱敏与边界检查",
      detail: "自动剥离敏感口令与私钥字段，锁定只读边界",
      ok: true,
      status: "pending",
    },
    {
      id: "connect-model",
      kind: "connect",
      title: "连接模型网关与投递上下文",
      detail: "等待脱敏完成后建立模型流式连接",
      ok: true,
      status: "pending",
    },
    {
      id: "model-think",
      kind: "think",
      title: "研判变更诉求与集群高可用边界",
      detail: "等待模型通道返回首包后展开推演",
      ok: true,
      status: "pending",
    },
    {
      id: "build-scope",
      kind: "synthesize",
      title: "生成变更边界澄清清单",
      detail: "等待风险推演完成后提炼维护窗口与前提问题",
      ok: true,
      status: "pending",
    },
  ];
}

function createInitialLiveState(
  kind: LivePipelineKind,
  title: string,
  defaultPhase: string,
  target?: { provider?: string; model?: string },
): LiveAIState {
  return {
    kind,
    title,
    startedAt: Date.now(),
    steps: buildInitialPipelineSteps(kind),
    thinking: "",
    phase: defaultPhase,
    chars: 0,
    provider: target?.provider,
    model: target?.model,
  };
}

function cleanClientErrText(raw: string): string {
  let s = (raw || "").trim();
  if (!s) return "AI 模型通道调用中断，请稍后重试";
  // Strip empty proxy JSON tails such as `: {"error":{"code":"server_error","message":""}}`
  s = s.replace(
    /[:\s]*\{\s*"error"\s*:\s*\{[^}]*"message"\s*:\s*""[^}]*\}\s*\}\s*$/i,
    "",
  );
  s = s.replace(/[:\s]*\{\s*\}\s*$/, "").trim();
  return s || "AI 模型通道调用中断，请稍后重试";
}

function extractDiagFromError(rawErr: unknown): AICallDiag | undefined {
  if (!(rawErr instanceof ApiError) || !rawErr.body || typeof rawErr.body !== "object") {
    return undefined;
  }
  const body = rawErr.body as Record<string, unknown>;
  if (body.diag && typeof body.diag === "object") {
    return body.diag as AICallDiag;
  }
  return undefined;
}

function markLiveStateError(prev: LiveAIState, rawErr: unknown): LiveAIState {
  const msg = cleanClientErrText(
    rawErr instanceof Error
      ? rawErr.message
      : String(rawErr || "AI 模型通道调用中断"),
  );
  const bodyDiag = extractDiagFromError(rawErr);
  const stepDiag = [...prev.steps]
    .reverse()
    .find((s) => (s.status === "error" || s.ok === false) && s.diag)?.diag;
  const finalDiag = bodyDiag || prev.errorDiag || stepDiag;
  const rawCode = rawErr instanceof ApiError ? rawErr.status : undefined;
  const code =
    finalDiag?.http_status &&
    finalDiag.http_status > 0 &&
    (!rawCode || rawCode === 502)
      ? finalDiag.http_status
      : rawCode;

  const hasExplicitErr = prev.steps.some(
    (s) => s.status === "error" || s.ok === false,
  );
  let nextSteps = prev.steps;
  if (!hasExplicitErr && prev.steps.length > 0) {
    let failIdx = prev.steps.findIndex((s) => s.status === "running");
    if (failIdx < 0) {
      failIdx = prev.steps.findIndex((s) => s.id === "connect-model");
    }
    if (failIdx < 0) {
      failIdx = prev.steps.findIndex((s) => s.status === "pending");
    }
    if (failIdx < 0) failIdx = prev.steps.length - 1;
    nextSteps = prev.steps.map((s, idx) =>
      idx === failIdx
        ? {
            ...s,
            status: "error",
            ok: false,
            detail: msg,
            diag: s.diag || finalDiag,
          }
        : s,
    );
  }
  return {
    ...prev,
    model: prev.model || finalDiag?.model,
    provider: prev.provider || finalDiag?.provider,
    steps: nextSteps,
    error: msg,
    errorCode: code,
    errorAt: Date.now(),
    errorDiag: finalDiag,
  };
}

function parseAIErrorGuide(
  errMsg: string,
  errCode?: number,
  diag?: AICallDiag,
): {
  badge: string;
  summary: string;
  hint: string;
  suggestSettings: boolean;
} {
  const lower = errMsg.toLowerCase();
  const httpStatus =
    diag?.http_status && diag.http_status > 0
      ? diag.http_status
      : errCode && errCode >= 100 && errCode !== 502
        ? errCode
        : undefined;
  const reasonCode = diag?.reason_code || "";

  if (
    reasonCode === "empty_output" ||
    (httpStatus === 200 &&
      diag?.out_tokens === 0 &&
      typeof diag?.in_tokens === "number")
  ) {
    const inPart =
      typeof diag?.in_tokens === "number" && diag.in_tokens > 0
        ? `已接收 ${diag.in_tokens.toLocaleString("en-US")} 输入 Token${
            diag.cached_tokens
              ? `（缓存 ${diag.cached_tokens.toLocaleString("en-US")}）`
              : ""
          }`
        : "已返回成功状态码";
    return {
      badge: `HTTP ${httpStatus || 200} · 空输出响应 (0 Token)`,
      summary: `上游模型网关${inPart}，但响应体 output: [] 为空，未生成任何有效输出 Token。`,
      hint: "常见于中转网关（如 Magpie / OneAPI）在 Responses 协议下转译 Claude 等非 OpenAI 模型时丢失输出流，或上游渠道中途断流、欠费截断。建议前往「设置 → AI」将该供应商接口方式改为「Chat Completions（通用）」，或检查上游渠道额度后重试。",
      suggestSettings: true,
    };
  }

  if (
    httpStatus === 402 ||
    lower.includes("402") ||
    lower.includes("payment required") ||
    lower.includes("insufficient") ||
    lower.includes("quota") ||
    lower.includes("balance") ||
    errMsg.includes("额度") ||
    errMsg.includes("余额") ||
    errMsg.includes("欠费")
  ) {
    const afterFallback = Boolean(diag?.attempts && diag.attempts.length > 1);
    return {
      badge: `HTTP ${httpStatus || 402} · 额度或计费受限`,
      summary: afterFallback
        ? `平台自动回退兼容重试后，上游模型渠道返回 HTTP ${httpStatus || 402} 配额或计费限制（Payment Required）。`
        : `上游模型网关返回 HTTP ${httpStatus || 402} 配额或计费限制（Payment Required），当前渠道未能接收推演请求。`,
      hint: "您填写的变更诉求与截图已完整保留。请核查网关下游渠道余额，或前往「设置 → AI」切换其他可用模型后点击「重新发起」。",
      suggestSettings: true,
    };
  }

  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("invalid api key") ||
    errMsg.includes("密钥") ||
    errMsg.includes("鉴权")
  ) {
    return {
      badge: httpStatus
        ? `HTTP ${httpStatus} · 模型鉴权未通过`
        : "模型鉴权未通过",
      summary: `上游模型网关返回 ${httpStatus ? `HTTP ${httpStatus} ` : ""}鉴权拒绝，当前访问密钥无效或无权调用该模型。`,
      hint: "请前往「设置 → AI」核对模型供应商密钥与变更演练绑定模型，保存后点击「重新发起」。",
      suggestSettings: true,
    };
  }

  if (
    httpStatus === 429 ||
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many") ||
    errMsg.includes("限流") ||
    errMsg.includes("并发")
  ) {
    return {
      badge: `HTTP ${httpStatus || 429} · 网关并发限流`,
      summary: `上游模型通道返回 HTTP ${httpStatus || 429} 速率或并发保护限制。`,
      hint: "稍候几秒即可点击「重新发起」重试，或在「设置 → AI」中配置备用模型节点。",
      suggestSettings: true,
    };
  }

  if (
    httpStatus === 404 ||
    lower.includes("model_not_found") ||
    lower.includes("not found") ||
    errMsg.includes("不存在")
  ) {
    return {
      badge: httpStatus
        ? `HTTP ${httpStatus} · 端点或模型未找到`
        : "模型标识未找到",
      summary: `上游网关返回 ${httpStatus ? `HTTP ${httpStatus}` : "404"}，未找到目标接口路径或当前配置的模型标识。`,
      hint: "请前往「设置 → AI」检查模型名称与 Base URL；若使用中转网关且不支持 /responses，建议切换接口方式为「Chat Completions（通用）」。",
      suggestSettings: true,
    };
  }

  if (reasonCode === "incomplete") {
    return {
      badge: `${httpStatus ? `HTTP ${httpStatus} · ` : ""}模型输出截断`,
      summary: `上游模型在完成完整结构化输出前提前中止（状态：${diag?.upstream_status || "incomplete"}）。`,
      hint: "常见于网关单次最大输出 Token 限制偏小或响应中途断流；可直接点击「重新发起」或在「设置 → AI」切换模型。",
      suggestSettings: true,
    };
  }

  if (reasonCode === "invalid_output") {
    return {
      badge: `${httpStatus ? `HTTP ${httpStatus} · ` : ""}返回格式不完整`,
      summary:
        "上游模型已返回文本，但未包含完整可解析的 JSON 结果（可能输出中途截断或模型未按结构化要求输出）。",
      hint: "您的输入已完整保留；可展开下方「查看网关原始诊断报文」查看模型实际输出，或直接点击「重新发起」重试。",
      suggestSettings: true,
    };
  }

  if (reasonCode === "sse_error") {
    return {
      badge: `${httpStatus ? `HTTP ${httpStatus} · ` : ""}SSE 流式帧报错`,
      summary: "模型网关建立流式连接后，在推送 SSE 事件流中途返回了上游错误帧。",
      hint: "可展开下方「查看网关原始诊断报文」定位上游具体错误内容，修复或切换模型后点击「重新发起」。",
      suggestSettings: true,
    };
  }

  if (
    reasonCode === "timeout" ||
    reasonCode === "network_error" ||
    errCode === 0 ||
    httpStatus === 504 ||
    lower.includes("timeout") ||
    errMsg.includes("超时") ||
    errMsg.includes("无法连接") ||
    errMsg.includes("断开")
  ) {
    return {
      badge: `${httpStatus ? `HTTP ${httpStatus} · ` : ""}网关连接超时或中断`,
      summary: "连接上游模型服务超时或网络层中断，本次推演已安全中止。",
      hint: "您输入的变更内容已完整保留；确认模型网关网络可达后点击「重新发起」即可继续。",
      suggestSettings: true,
    };
  }

  if (httpStatus && httpStatus >= 400) {
    return {
      badge: `HTTP ${httpStatus} · 网关错误响应`,
      summary: `上游模型网关返回 HTTP ${httpStatus}${diag?.endpoint ? `（${diag.endpoint}）` : ""}，本次推演未完成落库。`,
      hint: "您填写的内容均已保留；可展开下方「查看网关原始诊断报文」核查上游具体报错，或前往「设置 → AI」切换模型重试。",
      suggestSettings: true,
    };
  }

  return {
    badge: "模型通道调用异常",
    summary: "模型网关未返回可解析的演练结果，本次推演未写入残缺记录。",
    hint: "您填写的内容均已保留，可直接点击「重新发起」重试；若持续报错请查看网关诊断详情或在「设置 → AI」切换可用模型。",
    suggestSettings: true,
  };
}

function formatDiagReport(live: LiveAIState, diag?: AICallDiag): string {
  const payload = {
    time: new Date(live.errorAt || Date.now()).toISOString(),
    pipeline: live.kind,
    error: live.error,
    error_code: live.errorCode,
    provider: diag?.provider || live.provider || undefined,
    model: diag?.model || live.model || undefined,
    diag: diag || null,
  };
  return JSON.stringify(payload, null, 2);
}

function describeAttemptOutcome(att: AIAttemptDiag): string {
  if (att.reason) return att.reason;
  if (
    att.http_status === 200 &&
    att.out_tokens === 0 &&
    typeof att.in_tokens === "number"
  ) {
    return "空响应 (0 Token)";
  }
  if (att.http_status === 402) return "Payment Required";
  if (att.http_status === 401 || att.http_status === 403) return "鉴权拒绝";
  if (att.http_status === 429) return "速率受限";
  if (att.http_status === 404) return "端点未找到";
  if (att.upstream_status) return att.upstream_status;
  return "";
}

async function streamRehearsalAPI(
  path: string,
  body: unknown,
  onEvent: (updater: (prev: LiveAIState) => LiveAIState) => void,
  signal?: AbortSignal,
): Promise<ChangeRehearsal> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${path}${sep}stream=1`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-CSRF-Token": csrfToken(),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(
      navigator.onLine ? "无法连接到服务，请稍后重试" : "网络已断开",
      0,
    );
  }

  const ct = res.headers.get("content-type") || "";
  if (!res.ok || !ct.includes("text/event-stream") || !res.body) {
    const txt = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = txt ? (JSON.parse(txt) as Record<string, unknown>) : {};
    } catch {
      if (!res.ok) throw new ApiError(`服务暂时不可用（${res.status}）`, res.status);
    }
    if (!res.ok) {
      throw new ApiError(
        (typeof parsed.error === "string" && parsed.error) ||
          `请求失败（${res.status}）`,
        res.status,
        parsed,
      );
    }
    return parsed as unknown as ChangeRehearsal;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finalResult: ChangeRehearsal | null = null;

  const handlePayload = (rawLine: string) => {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("data:")) return;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      return;
    }
    const kind = String(ev.t || "");
    if (kind === "step" && ev.step) {
      const st = ev.step as RehearsalTraceStep;
      onEvent((prev) => {
        const idx = prev.steps.findIndex((x) => x.id === st.id);
        const nextSteps =
          idx >= 0
            ? prev.steps.map((x, i) => (i === idx ? st : x))
            : [...prev.steps, st];
        const nextErrDiag =
          (st.status === "error" || st.ok === false) && st.diag
            ? st.diag
            : prev.errorDiag;
        return { ...prev, steps: nextSteps, errorDiag: nextErrDiag };
      });
    } else if (kind === "meta") {
      onEvent((prev) => ({
        ...prev,
        model: typeof ev.model === "string" ? ev.model : prev.model,
        provider: typeof ev.provider === "string" ? ev.provider : prev.provider,
        failover: Boolean(ev.failover),
      }));
    } else if (kind === "think") {
      const chunk = typeof ev.v === "string" ? ev.v : "";
      if (chunk) {
        onEvent((prev) => ({
          ...prev,
          thinking: prev.thinking + chunk,
        }));
      }
    } else if (kind === "phase") {
      const ph = typeof ev.v === "string" ? ev.v : "";
      if (ph) {
        onEvent((prev) => ({ ...prev, phase: ph }));
      }
    } else if (kind === "progress") {
      const chars = typeof ev.chars === "number" ? ev.chars : 0;
      if (chars > 0) {
        onEvent((prev) => ({ ...prev, chars }));
      }
    } else if (kind === "done" && ev.rehearsal) {
      finalResult = ev.rehearsal as ChangeRehearsal;
    } else if (kind === "error") {
      const msg =
        typeof ev.v === "string" && ev.v ? ev.v : "AI 处理中断，请稍后重试";
      const code = typeof ev.code === "number" ? ev.code : 502;
      const diag =
        ev.diag && typeof ev.diag === "object"
          ? (ev.diag as AICallDiag)
          : undefined;
      throw new ApiError(msg, code, diag ? { diag } : undefined);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handlePayload(line);
      nl = buf.indexOf("\n");
    }
  }
  if (buf.trim()) {
    for (const line of buf.split("\n")) {
      handlePayload(line);
    }
  }
  if (!finalResult) {
    throw new ApiError("连接在生成完成前中断，请重试", 502);
  }
  return finalResult;
}

/* ---------- Client-Side Image Attachment Helpers ---------- */

type DraftImage = {
  id: string;
  name: string;
  dataUrl: string;
  width?: number;
  height?: number;
  sizeKB: number;
};

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/i;

function readFileAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("读取图片失败"));
    r.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("解码图片失败"));
    img.src = src;
  });
}

async function prepareDraftImage(file: File): Promise<DraftImage> {
  if (!ALLOWED_IMAGE_MIME.test(file.type)) {
    throw new Error(`不支持的图片格式：${file.name || file.type}`);
  }
  if (file.size > 18 * 1024 * 1024) {
    throw new Error(`图片 ${file.name} 过大，请控制在 18 MiB 以内`);
  }
  const rawUrl = await readFileAsDataURL(file);
  const img = await loadImageElement(rawUrl);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  // Keep GIFs or already-compact terminal screenshots pixel-sharp without re-encoding
  const maxDim = Math.max(w, h);
  if (
    (file.type === "image/gif" && file.size <= MAX_IMAGE_BYTES) ||
    (maxDim <= 2048 && file.size <= 950 * 1024)
  ) {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || "剪贴板截图.png",
      dataUrl: rawUrl,
      width: w,
      height: h,
      sizeKB: Math.max(1, Math.round(file.size / 1024)),
    };
  }

  const scale = maxDim > 2048 ? 2048 / maxDim : 1;
  const targetW = Math.max(1, Math.round(w * scale));
  const targetH = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("浏览器不支持图片画布压缩");
  }
  ctx.drawImage(img, 0, 0, targetW, targetH);

  let outUrl = canvas.toDataURL("image/webp", 0.88);
  if (!outUrl.startsWith("data:image/webp")) {
    outUrl = canvas.toDataURL("image/jpeg", 0.88);
  }
  const approxBytes = Math.round(((outUrl.length - outUrl.indexOf(",") - 1) * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    outUrl = canvas.toDataURL("image/jpeg", 0.74);
  }
  const finalBytes = Math.round(((outUrl.length - outUrl.indexOf(",") - 1) * 3) / 4);
  if (finalBytes > MAX_IMAGE_BYTES) {
    throw new Error(`图片 ${file.name} 压缩后仍超过 4 MiB，请裁剪关键区域后重试`);
  }
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "剪贴板截图.webp",
    dataUrl: outUrl,
    width: targetW,
    height: targetH,
    sizeKB: Math.max(1, Math.round(finalBytes / 1024)),
  };
}

function extractClipboardImageFiles(e: React.ClipboardEvent): File[] {
  const items = Array.from(e.clipboardData?.items || []);
  const out: File[] = [];
  for (const it of items) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) {
        const ext = f.type.split("/")[1] || "png";
        const named =
          f.name && f.name !== "image.png"
            ? f
            : new File([f], `截图-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.${ext}`, {
                type: f.type,
              });
        out.push(named);
      }
    }
  }
  return out;
}

function rehearsalImgUrl(clusterId: string, rehearsalId: string, name: string) {
  return `/api/clusters/${encodeURIComponent(clusterId)}/rehearsals/${encodeURIComponent(rehearsalId)}/img/${encodeURIComponent(name)}`;
}

/* ---------- Bespoke Shell Syntax Highlighter & Code Block ---------- */

type BashToken = {
  cls?: "cmt" | "sec" | "cmd" | "flag" | "str" | "var" | "op";
  text: string;
};

const SHELL_COMMANDS = new Set([
  "echo",
  "printf",
  "sec",
  "hostname",
  "date",
  "uptime",
  "uname",
  "grep",
  "egrep",
  "awk",
  "sed",
  "head",
  "tail",
  "cat",
  "cut",
  "tr",
  "sort",
  "uniq",
  "wc",
  "find",
  "ls",
  "stat",
  "df",
  "du",
  "free",
  "ps",
  "ss",
  "netstat",
  "ip",
  " lsof",
  "systemctl",
  "journalctl",
  "service",
  "dpkg",
  "rpm",
  "apt-cache",
  "yum",
  "dnf",
  "sysctl",
  "ulimit",
  "id",
  "whoami",
  "curl",
  "openssl",
  "redis-cli",
  "redis-server",
  "redis-sentinel",
  "psql",
  "pg_isready",
  "pg_controldata",
  "patronictl",
  "etcdctl",
  "mysql",
  "mysqladmin",
  "nginx",
  "haproxy",
  "kafka-topics.sh",
  "kafka-consumer-groups.sh",
  "rabbitmqctl",
  "set",
  "export",
  "local",
  "readonly",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "case",
  "esac",
  "while",
  "return",
  "exit",
  "command",
  "timeout",
  "sudo",
  "su",
]);

const TOKEN_RE =
  /('[^']*'|"(?:\\.|[^"\\])*"|\$\{[A-Za-z0-9_:#?+-]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!]|2>&1|[12]?>\/dev\/null|\|\||&&|[|;]|--?[A-Za-z0-9][\w=-]*|\s+|[^\s'"$|;&]+)/g;

function tokenizeBashLine(line: string): BashToken[] {
  const trimmed = line.trimStart();
  if (!trimmed) return [{ text: line }];
  if (trimmed.startsWith("#")) {
    const lead = line.slice(0, line.length - trimmed.length);
    return lead
      ? [{ text: lead }, { cls: "cmt", text: trimmed }]
      : [{ cls: "cmt", text: line }];
  }

  const tokens: BashToken[] = [];
  let expectCmd = true;
  let isSecLine = false;
  const matches = line.match(TOKEN_RE) || [line];

  for (const part of matches) {
    if (/^\s+$/.test(part)) {
      tokens.push({ text: part });
      continue;
    }
    if (part.startsWith("#") && tokens.length > 0 && /^\s+$/.test(tokens[tokens.length - 1].text)) {
      const idx = line.indexOf(part);
      if (idx >= 0) {
        tokens.push({ cls: "cmt", text: line.slice(idx) });
        break;
      }
    }
    if (part === "|" || part === "||" || part === "&&" || part === ";") {
      tokens.push({ cls: "op", text: part });
      expectCmd = true;
      continue;
    }
    if (part === "2>&1" || /^[12]?>\/dev\/null$/.test(part)) {
      tokens.push({ cls: "flag", text: part });
      continue;
    }
    if (part.startsWith("'") || part.startsWith('"')) {
      tokens.push({ cls: isSecLine ? "sec" : "str", text: part });
      expectCmd = false;
      continue;
    }
    if (part.startsWith("$")) {
      tokens.push({ cls: "var", text: part });
      expectCmd = false;
      continue;
    }
    if (expectCmd) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) {
        const eq = part.indexOf("=");
        tokens.push({ cls: "var", text: part.slice(0, eq + 1) });
        if (eq + 1 < part.length) {
          tokens.push({ text: part.slice(eq + 1) });
        }
        continue;
      }
      if (part === "sec") {
        isSecLine = true;
        tokens.push({ cls: "sec", text: part });
      } else if (SHELL_COMMANDS.has(part)) {
        tokens.push({ cls: "cmd", text: part });
      } else {
        tokens.push({ text: part });
      }
      expectCmd = false;
      continue;
    }
    if (part.startsWith("-")) {
      tokens.push({ cls: "flag", text: part });
      continue;
    }
    tokens.push({ text: part });
  }
  return tokens;
}

function CopyCodeBtn({
  text,
  label = "复制",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className={`rh-code-btn ${className} ${done ? "copied" : ""}`.trim()}
      onClick={() => {
        void copy(text);
        setDone(true);
      }}
    >
      {done ? <IconCheck /> : <IconCopy />}
      <span>{done ? "已复制" : label}</span>
    </button>
  );
}

function ShellCodeBlock({
  code,
  title,
  compact = false,
  copyLabel = "复制",
  onDownload,
  onEdit,
}: {
  code: string;
  title: string;
  compact?: boolean;
  copyLabel?: string;
  onDownload?: () => void;
  onEdit?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => {
    const clean = code.replace(/\r\n/g, "\n").replace(/\n$/, "");
    return clean.split("\n");
  }, [code]);
  const collapsible = lines.length > (compact ? 10 : 16);

  return (
    <div
      className={`rh-code ${compact ? "compact" : ""} ${expanded ? "expanded" : ""}`}
    >
      <div className="rh-code-bar">
        <div className="rh-code-meta">
          <span className="rh-code-dot" aria-hidden />
          <span
            className={`rh-code-title ${/[\u4e00-\u9fff]/.test(title) ? "" : "mono"}`}
          >
            {title}
          </span>
          <span className="rh-code-lines num">{lines.length} 行</span>
        </div>
        <div className="rh-code-acts">
          {collapsible && (
            <button
              type="button"
              className="rh-code-btn"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <IconShrink /> : <IconExpand />}
              <span>{expanded ? "收起" : `展开全部`}</span>
            </button>
          )}
          <CopyCodeBtn text={code} label={copyLabel} />
          {onDownload && (
            <button
              type="button"
              className="rh-code-btn"
              onClick={onDownload}
            >
              <IconDownload />
              <span>下载 .sh</span>
            </button>
          )}
          {onEdit && (
            <button type="button" className="rh-code-btn" onClick={onEdit}>
              <IconEdit />
              <span>微调</span>
            </button>
          )}
        </div>
      </div>
      <div className="rh-code-scroll">
        <pre className="rh-code-pre mono">
          <code>
            {lines.map((ln, idx) => {
              const toks = tokenizeBashLine(ln);
              return (
                <span key={idx} className="rh-code-row">
                  <span className="rh-code-ln num" aria-hidden>
                    {idx + 1}
                  </span>
                  <span className="rh-code-txt">
                    {toks.map((tk, ti) =>
                      tk.cls ? (
                        <span key={ti} className={`rh-tk-${tk.cls}`}>
                          {tk.text}
                        </span>
                      ) : (
                        <React.Fragment key={ti}>{tk.text}</React.Fragment>
                      ),
                    )}
                    {"\n"}
                  </span>
                </span>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}

/* ---------- Live & Persisted AI Choreographed Pipeline Card ---------- */

function fmtElapsedMs(ms?: number) {
  if (!ms || ms < 80) return "";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function fmtStepDuration(ms?: number) {
  if (!ms || ms < 30) return "已就绪";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function pendingHintForStep(st: RehearsalTraceStep): string {
  switch (st.kind) {
    case "guard":
      return "等待基线上下文读取完成后执行脱敏与安全红线校验";
    case "connect":
      return "等待前序安全校验完成后建立模型流式通道";
    case "think":
      return "等待模型网关返回首包 Token 后展开实时推演";
    case "synthesize":
      return "等待架构风险推演完成后编排结构化结果";
    default:
      return "等待前序环节完成";
  }
}

function computeTargetStepIndex(steps: RehearsalTraceStep[]): number {
  if (steps.length === 0) return 0;
  const errIdx = steps.findIndex(
    (s) => s.status === "error" || s.ok === false,
  );
  if (errIdx >= 0) return errIdx;
  const idx = steps.findIndex(
    (s) => s.status === "running" || s.status === "pending",
  );
  return idx === -1 ? steps.length : idx;
}

type CartoonScene =
  | "inspect"
  | "guard"
  | "connect"
  | "think"
  | "synthesize"
  | "error";

function resolveCartoonScene(
  step: RehearsalTraceStep | undefined,
  hasError: boolean,
): CartoonScene {
  if (hasError) return "error";
  if (!step) return "inspect";
  if (step.id === "readonly-ast-guard") return "synthesize";
  switch (step.kind) {
    case "inspect":
      return "inspect";
    case "guard":
      return "guard";
    case "connect":
      return "connect";
    case "think":
      return "think";
    case "synthesize":
      return "synthesize";
    default:
      return "think";
  }
}

function RehearsalStageCartoon({
  scene,
  stepTitle,
  stepDetail,
  provider,
  model,
  waitSec,
  errorBadge,
}: {
  scene: CartoonScene;
  stepTitle: string;
  stepDetail?: string;
  provider?: string;
  model?: string;
  waitSec?: number;
  errorBadge?: string;
}) {
  const actMeta: Record<
    CartoonScene,
    { tag: string; headline: string; sub: string }
  > = {
    inspect: {
      tag: "ACT 01 · 基线扫描",
      headline: stepTitle || "扫描集群初始交付拓扑与参数基线",
      sub:
        stepDetail ||
        "逐节点提取主从角色、端口与关键配置，构建演练数字沙盘",
    },
    guard: {
      tag: "ACT 02 · 安全脱敏",
      headline: stepTitle || "敏感凭据自动剥离与只读红线锁定",
      sub:
        stepDetail ||
        "口令、私钥与连接串在本地安检门全部擦除，仅放行架构元数据",
    },
    connect: {
      tag: "ACT 03 · 网关握手",
      headline: stepTitle || "平台底座正在与 AI 模型网关双向握手",
      sub:
        stepDetail ||
        `正在向 ${provider || "模型网关"}${model ? ` (${model})` : ""} 投递脱敏基线并等待首包响应${waitSec ? ` · ${waitSec.toFixed(1)}s` : ""}`,
    },
    think: {
      tag: "ACT 04 · 沙盘推演",
      headline: stepTitle || "握手已建立 · 正在推演高可用变更路径",
      sub:
        stepDetail ||
        "遵循「从库先行、主库守卫、随时可回退」原则逐节点模拟变更影响",
    },
    synthesize: {
      tag: "ACT 05 · 方案签章",
      headline: stepTitle || "编排结构化演练清单并加盖安全校验章",
      sub:
        stepDetail ||
        "收敛模型推演结论，完成静态安全红线复核与可执行步骤封装",
    },
    error: {
      tag: errorBadge || "通道熔断保护",
      headline: "模型网关握手中断 · 本地安全熔断已介入",
      sub: "生产与测试数据零改动，您填写的变更诉求与截图已完整保留，可随时重试",
    },
  };

  const cur = actMeta[scene];

  return (
    <div className={`rh-cartoon-stage is-${scene}`} aria-hidden>
      <div className="rh-cartoon-canvas" key={scene}>
        {scene === "inspect" && (
          <svg viewBox="0 0 340 84" fill="none" className="rh-cartoon-svg">
            {/* Server Rack Nodes */}
            <g className="ct-rack">
              <rect
                x="18"
                y="12"
                width="108"
                height="17"
                rx="4.5"
                className="ct-node-box"
              />
              <circle cx="29" cy="20.5" r="3" className="ct-led ok" />
              <rect x="38" y="18" width="44" height="5" rx="2.5" className="ct-bar" />
              <text x="94" y="23.5" className="ct-mini-txt">PRI</text>

              <rect
                x="18"
                y="33.5"
                width="108"
                height="17"
                rx="4.5"
                className="ct-node-box"
              />
              <circle cx="29" cy="42" r="3" className="ct-led brand" />
              <rect x="38" y="39.5" width="38" height="5" rx="2.5" className="ct-bar" />
              <text x="94" y="45" className="ct-mini-txt">REP</text>

              <rect
                x="18"
                y="55"
                width="108"
                height="17"
                rx="4.5"
                className="ct-node-box"
              />
              <circle cx="29" cy="63.5" r="3" className="ct-led brand" />
              <rect x="38" y="61" width="41" height="5" rx="2.5" className="ct-bar" />
              <text x="94" y="66.5" className="ct-mini-txt">REP</text>
            </g>

            {/* Sweeping Laser Scanner Beam */}
            <g className="ct-scan-beam">
              <rect x="16" y="8" width="18" height="68" rx="4" className="ct-scan-glow" />
              <line x1="33" y1="8" x2="33" y2="76" className="ct-scan-line" />
            </g>

            {/* Floating Extracted Blueprint Cards */}
            <path
              d="M134 24 C178 24, 194 42, 236 42"
              className="ct-dash-path"
            />
            <path
              d="M134 60 C178 60, 194 42, 236 42"
              className="ct-dash-path"
            />
            <g className="ct-float-card c1">
              <rect x="156" y="13" width="46" height="18" rx="4" className="ct-pill-card" />
              <text x="179" y="25" textAnchor="middle" className="ct-pill-txt">YAML</text>
            </g>
            <g className="ct-float-card c2">
              <rect x="164" y="51" width="46" height="18" rx="4" className="ct-pill-card" />
              <text x="187" y="63" textAnchor="middle" className="ct-pill-txt">TOPO</text>
            </g>

            {/* Context Capsule Receiver */}
            <g className="ct-capsule">
              <rect x="240" y="21" width="82" height="42" rx="10" className="ct-hub-pod" />
              <circle cx="258" cy="42" r="8" className="ct-pod-ring" />
              <path d="M255 42l2.2 2.2 4.5-4.6" className="ct-pod-check" />
              <text x="294" y="39" textAnchor="middle" className="ct-pod-title">基线快照</text>
              <text x="294" y="52" textAnchor="middle" className="ct-pod-sub">READY</text>
            </g>
          </svg>
        )}

        {scene === "guard" && (
          <svg viewBox="0 0 340 84" fill="none" className="rh-cartoon-svg">
            {/* Conveyor Track */}
            <line x1="16" y1="42" x2="324" y2="42" className="ct-dash-path" />

            {/* Incoming Raw Secret Pills (Left -> Gate) */}
            <g className="ct-raw-pill p1">
              <rect x="22" y="29" width="68" height="26" rx="6" className="ct-pill-warn" />
              <text x="56" y="45" textAnchor="middle" className="ct-pill-warn-txt">pwd=secret</text>
            </g>
            <g className="ct-raw-pill p2">
              <rect x="18" y="29" width="64" height="26" rx="6" className="ct-pill-warn" />
              <text x="50" y="45" textAnchor="middle" className="ct-pill-warn-txt">ssh_key</text>
            </g>

            {/* Outgoing Sanitized Safe Pills (Gate -> Right) */}
            <g className="ct-clean-pill p1">
              <rect x="192" y="29" width="76" height="26" rx="6" className="ct-pill-ok" />
              <text x="230" y="45" textAnchor="middle" className="ct-pill-ok-txt">••• 已脱敏 ✓</text>
            </g>
            <g className="ct-clean-pill p2">
              <rect x="196" y="29" width="72" height="26" rx="6" className="ct-pill-ok" />
              <text x="232" y="45" textAnchor="middle" className="ct-pill-ok-txt">RO 只读 ✓</text>
            </g>

            {/* Central Security Shield Gate */}
            <g className="ct-shield-gate">
              <circle cx="168" cy="42" r="30" className="ct-gate-halo" />
              <line x1="168" y1="8" x2="168" y2="76" className="ct-gate-laser" />
              <path
                d="M168 18L148 26.5v14.2c0 11.8 8.4 21.6 20 24.8 11.6-3.2 20-13 20-24.8V26.5L168 18z"
                className="ct-shield-body"
              />
              <path d="M161 42.5l4.6 4.6 9.6-10" className="ct-shield-tick" />
            </g>
          </svg>
        )}

        {scene === "connect" && (
          <svg viewBox="0 0 340 84" fill="none" className="rh-cartoon-svg">
            {/* Signal Bridge & Ripples */}
            <line x1="74" y1="44" x2="266" y2="44" className="ct-bridge-line" />
            <circle cx="170" cy="44" r="16" className="ct-hs-ring r1" />
            <circle cx="170" cy="44" r="26" className="ct-hs-ring r2" />

            {/* Encrypted Data Packets Gliding Across */}
            <circle cx="110" cy="44" r="3.2" className="ct-pkt p1" />
            <circle cx="110" cy="44" r="3.2" className="ct-pkt p2" />

            {/* Left Hub Station Badge */}
            <g className="ct-endpoint left">
              <rect x="12" y="20" width="52" height="48" rx="10" className="ct-hub-pod" />
              <text x="38" y="41" textAnchor="middle" className="ct-pod-title">HUB</text>
              <text x="38" y="54" textAnchor="middle" className="ct-pod-sub">平台底座</text>
            </g>

            {/* Right AI Gateway Station Badge */}
            <g className="ct-endpoint right">
              <rect x="276" y="20" width="52" height="48" rx="10" className="ct-gw-pod" />
              <text x="302" y="41" textAnchor="middle" className="ct-pod-title">AI GW</text>
              <text x="302" y="54" textAnchor="middle" className="ct-pod-sub">模型网关</text>
            </g>

            {/* Left Articulated Arm & Hand Reaching to Clasp */}
            <g className="ct-hand-left">
              <rect x="64" y="35" width="38" height="18" rx="5" className="ct-sleeve-left" />
              <rect x="98" y="36.5" width="6" height="15" rx="2" className="ct-cuff" />
              <path
                d="M104 37.5h22c4.2 0 7.5 2.5 7.5 6s-3.3 6.5-7.5 6.5h-6l6.5 3.8c2.2 1.3 1.4 4.4-1.2 4.4-1.2 0-2.5-.4-3.8-1.2l-11.5-6.5h-6V37.5z"
                className="ct-palm-left"
              />
              <path
                d="M113 37.5l6.5-6.2c2-1.9 5.2-.4 4.8 2.3l-.7 3.9"
                className="ct-palm-left"
              />
            </g>

            {/* Right Articulated Arm & Hand Reaching to Clasp */}
            <g className="ct-hand-right">
              <rect x="238" y="35" width="38" height="18" rx="5" className="ct-sleeve-right" />
              <rect x="236" y="36.5" width="6" height="15" rx="2" className="ct-cuff" />
              <path
                d="M236 37.5h-22c-4.2 0-7.5 2.5-7.5 6s3.3 6.5 7.5 6.5h6l-6.5 3.8c-2.2 1.3-1.4 4.4 1.2 4.4 1.2 0 2.5-.4 3.8-1.2l11.5-6.5h6V37.5z"
                className="ct-palm-right"
              />
              <path
                d="M227 37.5l-6.5-6.2c-2-1.9-5.2-.4-4.8 2.3l.7 3.9"
                className="ct-palm-right"
              />
            </g>

            {/* Center Handshake Spark Star */}
            <g className="ct-hs-spark">
              <path
                d="M170 15l2.2 5.4 5.4 2.2-5.4 2.2-2.2 5.4-2.2-5.4-5.4-2.2 5.4-2.2 2.2-5.4z"
                className="ct-spark-star"
              />
            </g>
          </svg>
        )}

        {scene === "think" && (
          <svg viewBox="0 0 340 84" fill="none" className="rh-cartoon-svg">
            {/* Locked Handshake Mini Pill */}
            <g className="ct-hs-locked">
              <rect x="12" y="10" width="76" height="20" rx="10" className="ct-pill-ok" />
              <path d="M23 20l2.5 2.5 5-5" className="ct-pod-check" />
              <text x="55" y="23.5" textAnchor="middle" className="ct-pill-ok-txt">握手已连通</text>
            </g>

            {/* HA Cluster Topology Sandbox */}
            <path d="M92 56 L172 56 L256 56" className="ct-flow-line" />

            <g className="ct-sim-node n1">
              <rect x="46" y="42" width="68" height="28" rx="7" className="ct-node-box" />
              <circle cx="58" cy="56" r="3.5" className="ct-led ok" />
              <text x="86" y="59.5" textAnchor="middle" className="ct-sim-lbl">从库 01</text>
            </g>

            <g className="ct-sim-node n2">
              <rect x="136" y="42" width="68" height="28" rx="7" className="ct-node-box" />
              <circle cx="148" cy="56" r="3.5" className="ct-led ok" />
              <text x="176" y="59.5" textAnchor="middle" className="ct-sim-lbl">从库 02</text>
            </g>

            <g className="ct-sim-node n3">
              <rect x="226" y="40" width="84" height="32" rx="8" className="ct-hub-pod" />
              <circle cx="240" cy="56" r="4" className="ct-led brand" />
              <text x="275" y="59.5" textAnchor="middle" className="ct-pod-title">主库守卫</text>
            </g>

            {/* Roaming AI Reasoning Probe */}
            <g className="ct-think-rover">
              <circle cx="80" cy="24" r="9" className="ct-rover-halo" />
              <circle cx="80" cy="24" r="4.5" className="ct-rover-core" />
              <line x1="80" y1="31" x2="80" y2="41" className="ct-rover-beam" />
            </g>
          </svg>
        )}

        {scene === "synthesize" && (
          <svg viewBox="0 0 340 84" fill="none" className="rh-cartoon-svg">
            {/* Runbook Blueprint Document */}
            <rect x="52" y="10" width="174" height="64" rx="8" className="ct-doc-sheet" />
            <circle cx="68" cy="24" r="3.5" className="ct-led ok" />
            <line x1="78" y1="24" x2="178" y2="24" className="ct-draw-line l1" />
            <circle cx="68" cy="38" r="3.5" className="ct-led ok" />
            <line x1="78" y1="38" x2="198" y2="38" className="ct-draw-line l2" />
            <circle cx="68" cy="52" r="3.5" className="ct-led brand" />
            <line x1="78" y1="52" x2="164" y2="52" className="ct-draw-line l3" />
            <circle cx="68" cy="64" r="3" className="ct-led brand" />
            <line x1="78" y1="64" x2="144" y2="64" className="ct-draw-line l4" />

            {/* Seal Stamp Impact */}
            <circle cx="256" cy="46" r="22" className="ct-seal-ring" />
            <g className="ct-stamp-badge">
              <rect x="224" y="30" width="68" height="32" rx="8" className="ct-pill-ok" />
              <text x="258" y="45" textAnchor="middle" className="ct-pill-ok-txt">SAFE ✓</text>
              <text x="258" y="56" textAnchor="middle" className="ct-mini-ok">安全校验通过</text>
            </g>
          </svg>
        )}

        {scene === "error" && (
          <svg viewBox="0 0 340 84" fill="none" className="rh-cartoon-svg">
            {/* Retracted Endpoints */}
            <rect x="18" y="22" width="66" height="42" rx="9" className="ct-hub-pod" />
            <text x="51" y="41" textAnchor="middle" className="ct-pod-title">草稿完好</text>
            <text x="51" y="54" textAnchor="middle" className="ct-mini-ok">已保护 ✓</text>

            <line x1="88" y1="43" x2="136" y2="43" className="ct-broken-line" />
            <line x1="204" y1="43" x2="252" y2="43" className="ct-broken-line" />

            {/* Central Circuit-Breaker Shield */}
            <circle cx="170" cy="43" r="24" className="ct-err-halo" />
            <path
              d="M170 22L152 29.5v12.8c0 10.5 7.5 19.2 18 22.2 10.5-3 18-11.7 18-22.2V29.5L170 22z"
              className="ct-err-shield"
            />
            <path d="M170 34v10M170 49.5h.01" className="ct-err-bang" />

            <rect x="256" y="22" width="66" height="42" rx="9" className="ct-err-pod" />
            <text x="289" y="41" textAnchor="middle" className="ct-err-pod-title">AI 网关</text>
            <text x="289" y="54" textAnchor="middle" className="ct-err-pod-sub">响应受阻</text>
          </svg>
        )}
      </div>

      <div className="rh-cartoon-story">
        <span className={`rh-cartoon-act ${scene === "error" ? "is-err" : ""}`}>
          {cur.tag}
        </span>
        <b className="rh-cartoon-headline">{cur.headline}</b>
        <p className="rh-cartoon-sub">{cur.sub}</p>
      </div>
    </div>
  );
}

function isTechnicalErrorText(raw?: string): boolean {
  if (!raw) return false;
  return /[{}\[\]]|https?:\/\/|\/v\d+\/|\bHTTP\s*[45]\d{2}\b|\btraceback\b|\bexception\b|"[a-zA-Z0-9_]+":/i.test(
    raw,
  );
}

/* ---------- Structured AI Reasoning Parser & Renderer ---------- */

type ThinkingBlock =
  | { kind: "step"; index: string; lead?: string; body: string }
  | { kind: "bullet"; lead?: string; body: string }
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string };

const CIRCLED_NUM_MAP: Record<string, string> = {
  "①": "1",
  "②": "2",
  "③": "3",
  "④": "4",
  "⑤": "5",
  "⑥": "6",
  "⑦": "7",
  "⑧": "8",
  "⑨": "9",
  "⑩": "10",
};

function normalizeStepToken(digits?: string, circled?: string): string {
  if (digits) return digits;
  if (circled && CIRCLED_NUM_MAP[circled]) return CIRCLED_NUM_MAP[circled];
  return "1";
}

// Split compressed single-paragraph chains like "1. 基线核对：...。 2. 风险核对：...。3. 高可用边界：..."
// while never breaking version strings (7.2.16, Ubuntu 24.04) or IPs (172.30.6.100).
function splitInlineThinkingSteps(line: string): string[] {
  const markerRe =
    /(?:(\d{1,2})[.、)）]|([①②③④⑤⑥⑦⑧⑨⑩]))\s*(?=[\u4e00-\u9fa5A-Za-z*`“"「『【\[（(])/g;
  const cuts: number[] = [];
  let prevNum = 0;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(line)) !== null) {
    const idx = m.index;
    const numVal = parseInt(normalizeStepToken(m[1], m[2]), 10);
    if (idx === 0) {
      cuts.push(idx);
      prevNum = numVal;
      continue;
    }
    const before = line.slice(0, idx);
    const afterPunct = /[。；！？.!?;]\s*$/.test(before);
    const afterSequentialSpace =
      /\s+$/.test(before) && prevNum >= 1 && numVal === prevNum + 1;
    if (afterPunct || afterSequentialSpace) {
      cuts.push(idx);
      prevNum = numVal;
    }
  }
  if (cuts.length <= 1) return [line];
  const out: string[] = [];
  if (cuts[0] > 0) {
    const prefix = line.slice(0, cuts[0]).trim();
    if (prefix) out.push(prefix);
  }
  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i];
    const end = i + 1 < cuts.length ? cuts[i + 1] : line.length;
    const seg = line.slice(start, end).trim();
    if (seg) out.push(seg);
  }
  return out.length ? out : [line];
}

function splitThinkingLead(text: string): { lead?: string; body: string } {
  const m =
    /^(?:\*\*([^*：:\n]{2,18})\*\*|([^：:\n，。；!?！？]{2,16}))[：:]\s*([\s\S]+)$/.exec(
      text.trim(),
    );
  if (!m) return { body: text.trim() };
  const lead = (m[1] || m[2] || "").replace(/^\*\*|\*\*$/g, "").trim();
  const body = (m[3] || "").trim();
  // Avoid splitting URLs like http:// or key:value tokens with ASCII slashes directly after ':'
  if (!lead || !body || /^[/\\]/.test(body)) {
    return { body: text.trim() };
  }
  return { lead, body };
}

function parseThinkingBlocks(raw: string): ThinkingBlock[] {
  const src = (raw || "").replace(/\r\n/g, "\n").trim();
  if (!src) return [];
  const rawLines = src.split("\n");
  const blocks: ThinkingBlock[] = [];
  let hadBlank = true;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      hadBlank = true;
      continue;
    }
    const segments = splitInlineThinkingSteps(trimmed);
    for (const seg of segments) {
      const hMatch = /^#{1,4}\s+(.+)$/.exec(seg);
      if (hMatch) {
        blocks.push({ kind: "heading", text: hMatch[1].trim() });
        hadBlank = false;
        continue;
      }
      const stepMatch =
        /^(?:(\d{1,2})[.、)）]|([①②③④⑤⑥⑦⑧⑨⑩]))\s*([\u4e00-\u9fa5A-Za-z*`“"「『【\[（(][\s\S]*)$/.exec(
          seg,
        );
      if (stepMatch) {
        const index = normalizeStepToken(stepMatch[1], stepMatch[2]);
        const { lead, body } = splitThinkingLead(stepMatch[3]);
        blocks.push({ kind: "step", index, lead, body });
        hadBlank = false;
        continue;
      }
      const bulletMatch = /^[-*+•]\s+([\s\S]+)$/.exec(seg);
      if (bulletMatch) {
        const { lead, body } = splitThinkingLead(bulletMatch[1]);
        blocks.push({ kind: "bullet", lead, body });
        hadBlank = false;
        continue;
      }
      const last = blocks[blocks.length - 1];
      if (!hadBlank && last) {
        if (last.kind === "step" || last.kind === "bullet") {
          last.body = `${last.body}\n${seg}`;
          continue;
        }
        if (last.kind === "para") {
          last.text = `${last.text}\n${seg}`;
          continue;
        }
      }
      blocks.push({ kind: "para", text: seg });
      hadBlank = false;
    }
  }
  return blocks;
}

function renderThinkingInline(text: string): React.ReactNode {
  if (!text) return null;
  const tokenRe =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|[a-zA-Z_][\w.-]*=[^\s，。；、：（）()"`]+|\bnode-\d+(?:\/node-\d+)*\b|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b|\bv?\d+\.\d+\.\d+(?:-[a-zA-Z0-9._-]+)?\b|\/(?:etc|var|opt|usr|data|tmp|home|root|srv|proc|sys|dev|run|mnt)(?:\/[a-zA-Z0-9_.*-]+)*|\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.*-]+)+)/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const start = m.index;
    const rawTok = m[0];
    const prevCh = start > 0 ? text[start - 1] : "";
    // Avoid highlighting slash paths inside URLs or words (e.g. a/b except node-1/node-2 handled explicitly)
    if (rawTok.startsWith("/") && /[\w:/]/.test(prevCh)) {
      continue;
    }
    if (start > last) {
      out.push(text.slice(last, start));
    }
    if (rawTok.startsWith("`") && rawTok.endsWith("`")) {
      out.push(
        <code key={k++} className="rh-think-code mono">
          {rawTok.slice(1, -1)}
        </code>,
      );
      last = start + rawTok.length;
    } else if (rawTok.startsWith("**") && rawTok.endsWith("**")) {
      out.push(
        <strong key={k++} className="rh-think-strong">
          {renderThinkingInline(rawTok.slice(2, -2))}
        </strong>,
      );
      last = start + rawTok.length;
    } else {
      let cleanTok = rawTok;
      let trailing = "";
      const punct = /[.,;:!?)]+$/.exec(cleanTok);
      if (punct) {
        cleanTok = cleanTok.slice(0, -punct[0].length);
        trailing = punct[0];
      }
      if (cleanTok) {
        out.push(
          <code key={k++} className="rh-think-code mono">
            {cleanTok}
          </code>,
        );
      }
      if (trailing) {
        out.push(trailing);
      }
      last = start + rawTok.length;
    }
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out.length === 1 && typeof out[0] === "string" ? out[0] : out;
}

function RehearsalThinkingContent({
  text,
  streaming = false,
  compact = false,
}: {
  text: string;
  streaming?: boolean;
  compact?: boolean;
}) {
  const blocks = useMemo(() => parseThinkingBlocks(text), [text]);
  if (!blocks.length) return null;

  const nodes: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < blocks.length) {
    const cur = blocks[i];
    if (cur.kind === "step") {
      const items: Extract<ThinkingBlock, { kind: "step" }>[] = [];
      while (i < blocks.length && blocks[i].kind === "step") {
        items.push(blocks[i] as Extract<ThinkingBlock, { kind: "step" }>);
        i++;
      }
      const isLastGroup = i === blocks.length;
      nodes.push(
        <ol key={k++} className="rh-think-steps">
          {items.map((st, idx) => {
            const isLast = isLastGroup && idx === items.length - 1;
            return (
              <li key={`${st.index}-${idx}`} className="rh-think-item">
                <span className="rh-think-idx num" aria-hidden>
                  {st.index}
                </span>
                <div className="rh-think-body">
                  {st.lead && <span className="rh-think-lead">{st.lead}</span>}
                  <span>{renderThinkingInline(st.body)}</span>
                  {isLast && streaming && (
                    <span className="rh-ai-caret" aria-hidden />
                  )}
                </div>
              </li>
            );
          })}
        </ol>,
      );
      continue;
    }
    if (cur.kind === "bullet") {
      const items: Extract<ThinkingBlock, { kind: "bullet" }>[] = [];
      while (i < blocks.length && blocks[i].kind === "bullet") {
        items.push(blocks[i] as Extract<ThinkingBlock, { kind: "bullet" }>);
        i++;
      }
      const isLastGroup = i === blocks.length;
      nodes.push(
        <ul key={k++} className="rh-think-bullets">
          {items.map((bt, idx) => {
            const isLast = isLastGroup && idx === items.length - 1;
            return (
              <li key={idx} className="rh-think-bullet-item">
                <span className="rh-think-bdot" aria-hidden />
                <div className="rh-think-body">
                  {bt.lead && <span className="rh-think-lead">{bt.lead}</span>}
                  <span>{renderThinkingInline(bt.body)}</span>
                  {isLast && streaming && (
                    <span className="rh-ai-caret" aria-hidden />
                  )}
                </div>
              </li>
            );
          })}
        </ul>,
      );
      continue;
    }
    const isLast = i === blocks.length - 1;
    if (cur.kind === "heading") {
      nodes.push(
        <div key={k++} className="rh-think-heading">
          {renderThinkingInline(cur.text)}
          {isLast && streaming && <span className="rh-ai-caret" aria-hidden />}
        </div>,
      );
    } else {
      nodes.push(
        <p
          key={k++}
          className={`rh-think-para ${blocks.length === 1 ? "is-single" : ""}`}
        >
          {renderThinkingInline(cur.text)}
          {isLast && streaming && <span className="rh-ai-caret" aria-hidden />}
        </p>,
      );
    }
    i++;
  }

  return (
    <div className={`rh-think-flow ${compact ? "is-compact" : ""}`}>{nodes}</div>
  );
}

function RehearsalAIProcess({
  live,
  trace,
  title,
  defaultOpen = false,
  onAbort,
  onRetry,
  onDismiss,
}: {
  live?: LiveAIState | null;
  trace?: RehearsalTrace | null;
  title: string;
  defaultOpen?: boolean;
  onAbort?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen || Boolean(live));
  const [rawDiagOpen, setRawDiagOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [playState, setPlayState] = useState<{
    startedAt: number;
    idx: number;
    enteredAt: number;
  }>(() => ({
    startedAt: live?.startedAt ?? 0,
    idx: 0,
    enteredAt: Date.now(),
  }));
  const procRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledStartRef = useRef<number>(0);
  const thinkBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  useEffect(() => {
    setRawDiagOpen(false);
  }, [live?.startedAt]);

  useEffect(() => {
    if (!live?.startedAt || lastScrolledStartRef.current === live.startedAt) {
      return;
    }
    lastScrolledStartRef.current = live.startedAt;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const alignIntoSafeViewport = () => {
      const el = procRef.current;
      if (!el || typeof window === "undefined") return;
      const rect = el.getBoundingClientRect();
      const safeTop = 116;
      const safeBottom = window.innerHeight - 20;
      if (rect.top < safeTop) {
        window.scrollBy({
          top: rect.top - safeTop,
          behavior: reduced ? "auto" : "smooth",
        });
      } else if (rect.bottom > safeBottom) {
        const delta = Math.min(
          rect.bottom - safeBottom,
          Math.max(0, rect.top - safeTop),
        );
        if (delta > 4) {
          window.scrollBy({
            top: delta,
            behavior: reduced ? "auto" : "smooth",
          });
        }
      }
    };
    const timer = window.setTimeout(alignIntoSafeViewport, reduced ? 0 : 290);
    return () => window.clearTimeout(timer);
  }, [live?.startedAt]);

  useEffect(() => {
    if (!live) return;
    setOpen(true);
    if (live.error) {
      setNow(live.errorAt || Date.now());
      return;
    }
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 120);
    return () => clearInterval(t);
  }, [live, live?.error, live?.errorAt]);

  const targetIdx = useMemo(
    () => (live ? computeTargetStepIndex(live.steps) : 0),
    [live],
  );

  // Stage-by-stage choreography sequencer:
  // Fast local steps animate one-by-one (280ms each), then hold honestly on
  // Step 3 ("connect-model") until the upstream LLM returns its first real token.
  // If an upstream error occurs, jump immediately to the broken step so the user sees why.
  useEffect(() => {
    if (!live) return;
    if (playState.startedAt !== live.startedAt) {
      setPlayState({
        startedAt: live.startedAt,
        idx: live.error ? targetIdx : 0,
        enteredAt: Date.now(),
      });
      return;
    }
    if (live.error && playState.idx !== targetIdx) {
      setPlayState((prev) => ({
        ...prev,
        idx: targetIdx,
        enteredAt: Date.now(),
      }));
      return;
    }
    if (playState.idx >= targetIdx) return;
    const minHold = targetIdx >= 3 ? 150 : 280;
    const elapsed = Date.now() - playState.enteredAt;
    const wait = Math.max(16, minHold - elapsed);
    const timer = window.setTimeout(() => {
      setPlayState((prev) => {
        if (!live || prev.startedAt !== live.startedAt) return prev;
        if (prev.idx >= targetIdx) return prev;
        return {
          startedAt: prev.startedAt,
          idx: prev.idx + 1,
          enteredAt: Date.now(),
        };
      });
    }, wait);
    return () => window.clearTimeout(timer);
  }, [
    live,
    live?.error,
    playState.startedAt,
    playState.idx,
    playState.enteredAt,
    targetIdx,
  ]);

  // Keep streaming thoughts scrolled to the latest line automatically
  useEffect(() => {
    if (!live?.thinking || !thinkBoxRef.current) return;
    const el = thinkBoxRef.current;
    el.scrollTop = el.scrollHeight;
  }, [live?.thinking]);

  if (live) {
    const steps = live.steps;
    const hasError = Boolean(live.error);
    const activePlayIdx = hasError
      ? targetIdx
      : playState.startedAt === live.startedAt
        ? playState.idx
        : 0;
    const clockEnd = hasError ? live.errorAt || now : now;
    const elapsedSecNum = Math.max(0.1, (clockEnd - live.startedAt) / 1000);
    const elapsedSec = elapsedSecNum.toFixed(1);
    const stepWaitSec = Math.max(
      0.1,
      (clockEnd -
        (playState.startedAt === live.startedAt
          ? playState.enteredAt
          : live.startedAt)) /
        1000,
    );
    const stageHumanIdx = Math.min(steps.length, activePlayIdx + 1);
    const showThinkingConsole = !hasError && activePlayIdx >= 3;
    const currentStep =
      steps[Math.min(Math.max(activePlayIdx, 0), Math.max(steps.length - 1, 0))];
    const diag =
      live.errorDiag ||
      currentStep?.diag ||
      [...steps].reverse().find((s) => s.diag)?.diag;
    const errGuide = hasError
      ? parseAIErrorGuide(live.error || "", live.errorCode, diag)
      : null;
    const cartoonScene = resolveCartoonScene(currentStep, hasError);
    const hasTokens =
      typeof diag?.in_tokens === "number" ||
      typeof diag?.out_tokens === "number";
    const hasSSE = Boolean(
      (diag?.sse_events && diag.sse_events.length > 0) ||
        (diag?.keepalives && diag.keepalives > 0),
    );
    const hasTelemetry = Boolean(
      diag &&
        (diag.endpoint ||
          diag.http_status !== undefined ||
          diag.upstream_status ||
          diag.ms ||
          hasTokens ||
          diag.response_id ||
          hasSSE),
    );
    const hasAttempts = Boolean(diag?.attempts && diag.attempts.length > 1);
    const hasRawPayload = Boolean(diag?.request_summary || diag?.response_raw);
    const rawSinglePane = !(diag?.request_summary && diag?.response_raw);
    const isTechErr = isTechnicalErrorText(live.error);
    const isSlowHandshake =
      !hasError &&
      currentStep?.id === "connect-model" &&
      stepWaitSec >= 25;
    const liveSplit = steps.length > 0;

    return (
      <div
        ref={procRef}
        className={`rh-ai-proc is-live ${hasError ? "is-error" : ""}`}
        role={hasError ? "alert" : "status"}
        aria-live="polite"
      >
        <div className="rh-ai-head">
          <div className="rh-ai-head-left">
            {hasError ? (
              <span className="rh-ai-err-ic" aria-hidden>
                <IconExclamationCircle />
              </span>
            ) : (
              <span className="rh-ai-pulse" aria-hidden>
                <Spark size={14} rainbow />
              </span>
            )}
            <b>{hasError ? "AI 推演通道受阻" : live.title}</b>
            {steps.length > 0 && (
              <span
                className={`rh-ai-stage-pill num ${hasError ? "is-error" : ""}`}
              >
                {hasError
                  ? `中断于阶段 ${stageHumanIdx}/${steps.length}`
                  : `阶段 ${stageHumanIdx}/${steps.length}`}
              </span>
            )}
            {(live.provider || live.model) && (
              <span className="rh-ai-chip">
                {live.provider && (
                  <span className="rh-ai-chip-prov">{live.provider}</span>
                )}
                {live.provider && live.model && (
                  <span className="rh-ai-chip-sep" aria-hidden>
                    ·
                  </span>
                )}
                {live.model && (
                  <span className="rh-ai-chip-model mono">{live.model}</span>
                )}
                {live.failover && (
                  <>
                    <span className="rh-ai-chip-sep" aria-hidden>
                      ·
                    </span>
                    <span className="rh-ai-chip-fb">备用节点</span>
                  </>
                )}
              </span>
            )}
            {live.chars > 0 && showThinkingConsole && (
              <span className="rh-ai-chip num">
                已输出 {live.chars.toLocaleString("en-US")} 字
              </span>
            )}
          </div>
          <div className="rh-ai-head-right">
            <span className={`rh-ai-timer num ${hasError ? "is-error" : ""}`}>
              {elapsedSec}s
            </span>
            {!hasError && onAbort && (
              <button
                type="button"
                className="rh-ai-stop"
                onClick={onAbort}
                title="停止当前生成"
              >
                <IconRecordStop />
                <span>停止</span>
              </button>
            )}
            {hasError && onDismiss && (
              <button
                type="button"
                className="rh-ai-dismiss-top"
                onClick={onDismiss}
                title="收起提示"
              >
                <IconClose />
              </button>
            )}
          </div>
        </div>

        {steps.length > 0 && (
          <div className="rh-ai-segbar" aria-hidden>
            {steps.map((st, idx) => {
              const segCls =
                idx < activePlayIdx
                  ? "is-done"
                  : idx === activePlayIdx
                    ? hasError
                      ? "is-error"
                      : "is-active"
                    : "is-pending";
              return (
                <span key={st.id} className={`rh-ai-seg ${segCls}`}>
                  <i />
                </span>
              );
            })}
          </div>
        )}

        <div className={`rh-ai-body ${liveSplit ? "is-split" : ""}`}>
          {liveSplit && (
            <div className="rh-ai-left">
              <ol className="rh-pipe-steps">
                {steps.map((st, idx) => {
                  const vStatus:
                    | "done"
                    | "warn"
                    | "error"
                    | "running"
                    | "pending" =
                    idx < activePlayIdx
                      ? st.ok === false || st.status === "warn"
                        ? "warn"
                        : "done"
                      : idx === activePlayIdx
                        ? hasError
                          ? "error"
                          : "running"
                        : "pending";
                  const isLast = idx === steps.length - 1;
                  const displayDetail =
                    vStatus === "pending"
                      ? hasError
                        ? "因前序模型连接受阻，本环节未执行"
                        : pendingHintForStep(st)
                      : st.detail || "";

                  return (
                    <li key={st.id} className={`rh-pstep is-${vStatus}`}>
                      <div className="rh-pstep-track" aria-hidden>
                        <span className={`rh-pstep-node is-${vStatus}`}>
                          {vStatus === "done" ? (
                            <IconCheck className="rh-check-pop" />
                          ) : vStatus === "error" ? (
                            <IconClose />
                          ) : vStatus === "warn" ? (
                            <span className="rh-pstep-bang">!</span>
                          ) : vStatus === "running" ? (
                            <span className="rh-orb">
                              <span className="rh-orb-ring" />
                              <span className="rh-orb-core" />
                            </span>
                          ) : (
                            <span className="rh-pstep-num num">{idx + 1}</span>
                          )}
                        </span>
                        {!isLast && (
                          <span className="rh-pstep-rail">
                            <i
                              className="rh-pstep-rail-fill"
                              style={{
                                transform: `scaleY(${idx < activePlayIdx ? 1 : 0})`,
                              }}
                            />
                          </span>
                        )}
                      </div>

                      <div className="rh-pstep-main">
                        <div className="rh-pstep-top">
                          <span className="rh-pstep-title">{st.title}</span>
                          <span className={`rh-pstep-badge is-${vStatus} num`}>
                            {vStatus === "done"
                              ? fmtStepDuration(st.ms)
                              : vStatus === "error"
                                ? "连接受阻"
                                : vStatus === "warn"
                                  ? "需留意"
                                  : vStatus === "running"
                                    ? st.id === "connect-model"
                                      ? `握手 ${stepWaitSec.toFixed(1)}s`
                                      : "进行中"
                                    : hasError
                                      ? "已中止"
                                      : "待执行"}
                          </span>
                        </div>
                        {displayDetail && (
                          <p
                            className="rh-pstep-detail"
                            title={
                              displayDetail.length > 44
                                ? displayDetail
                                : undefined
                            }
                          >
                            {displayDetail}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          <div className="rh-ai-right">
            <RehearsalStageCartoon
              scene={cartoonScene}
              stepTitle={currentStep?.title || live.title}
              stepDetail={currentStep?.detail}
              provider={live.provider}
              model={live.model}
              waitSec={
                !hasError && currentStep?.id === "connect-model"
                  ? stepWaitSec
                  : undefined
              }
              errorBadge={errGuide?.badge}
            />

            {!hasError && !showThinkingConsole && (
              <div className="rh-ai-stage-live">
                <div className="rh-stage-live-main">
                  <div className="rh-stage-live-head">
                    <span className="rh-stage-live-k">
                      <span className="rh-stage-live-dot" aria-hidden />
                      <span>通道实时动态</span>
                    </span>
                    {(live.provider || live.model) && (
                      <span className="rh-stage-live-chan">
                        {live.provider && <span>{live.provider}</span>}
                        {live.provider && live.model && (
                          <span className="rh-ai-chip-sep" aria-hidden>
                            ·
                          </span>
                        )}
                        {live.model && (
                          <span className="mono">{live.model}</span>
                        )}
                      </span>
                    )}
                  </div>
                  <p className="rh-stage-live-msg">
                    {live.phase ||
                      currentStep?.detail ||
                      "正在准备集群架构上下文并建立流式推演通道…"}
                  </p>
                  <Smooth>
                    {isSlowHandshake && (
                      <div className="rh-pstep-slow">
                        已等待 {Math.floor(stepWaitSec)}s 暂未收到正文首字（开启深度思考或中转网关自动重试上游渠道时，首包等待 20～90s 属正常现象；若使用中转网关调用 Claude 等非 OpenAI 模型，建议在「设置 → AI」将接口方式设为 Chat Completions 以直连流式输出）。
                      </div>
                    )}
                  </Smooth>
                </div>
                <div className="rh-stage-live-guard">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M10 2.5L4 5v4.6c0 3.8 2.5 6.9 6 7.9 3.5-1 6-4.1 6-7.9V5l-6-2.5z"
                      stroke="currentColor"
                      strokeWidth="1.65"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>自动剥离口令与私钥 · 仅投递架构拓扑与非敏感参数</span>
                </div>
              </div>
            )}

            {hasError && errGuide && (
              <div className="rh-ai-err-card">
                <div className="rh-ai-err-head">
                  <div className="rh-ai-err-badges">
                    <span className="rh-ai-err-tag">{errGuide.badge}</span>
                    {diag?.fallback_used && (
                      <span className="rh-ai-err-fb">
                        已尝试兼容回退 {diag.fallback_used}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="rh-err-copy-btn"
                    onClick={() => void copy(formatDiagReport(live, diag))}
                    title="复制完整脱敏诊断 JSON"
                  >
                    <IconCopy />
                    <span>复制完整诊断</span>
                  </button>
                </div>

                {live.error && (
                  <div
                    className={`rh-ai-err-raw ${isTechErr ? "is-tech mono" : "is-prose"}`}
                  >
                    {live.error}
                  </div>
                )}
                <p className="rh-ai-err-sum">{errGuide.summary}</p>
                <p className="rh-ai-err-hint">{errGuide.hint}</p>

                {hasTelemetry && diag && (
                  <dl className="rh-err-telemetry">
                    {diag.endpoint && (
                      <div className="rh-err-kv is-wide">
                        <dt>协议端点</dt>
                        <dd className="mono">{diag.endpoint}</dd>
                      </div>
                    )}
                    {(diag.http_status !== undefined ||
                      diag.upstream_status ||
                      diag.reason_code) && (
                      <div className="rh-err-kv">
                        <dt>HTTP 状态</dt>
                        <dd className="num">
                          {diag.http_status && diag.http_status > 0
                            ? `HTTP ${diag.http_status}`
                            : "网络层中断"}
                          {diag.upstream_status
                            ? ` · ${diag.upstream_status}`
                            : ""}
                        </dd>
                      </div>
                    )}
                    {Boolean(diag.ms && diag.ms > 0) && (
                      <div className="rh-err-kv">
                        <dt>耗时</dt>
                        <dd className="num">{fmtStepDuration(diag.ms)}</dd>
                      </div>
                    )}
                    {hasTokens && (
                      <div className="rh-err-kv">
                        <dt>Token 计量</dt>
                        <dd className="num">
                          输入 {(diag.in_tokens ?? 0).toLocaleString("en-US")} · 缓存{" "}
                          {(diag.cached_tokens ?? 0).toLocaleString("en-US")} · 输出{" "}
                          {(diag.out_tokens ?? 0).toLocaleString("en-US")}
                        </dd>
                      </div>
                    )}
                    {diag.response_id && (
                      <div className="rh-err-kv">
                        <dt>上游响应 ID</dt>
                        <dd>
                          <button
                            type="button"
                            className="rh-err-copy-id mono"
                            onClick={() => void copy(diag.response_id!)}
                            title="点击复制上游响应 ID"
                          >
                            <span>{diag.response_id}</span>
                            <IconCopy />
                          </button>
                        </dd>
                      </div>
                    )}
                    {hasSSE && (
                      <div className="rh-err-kv is-wide">
                        <dt>SSE 事件链</dt>
                        <dd
                          className={
                            diag.sse_events && diag.sse_events.length > 0
                              ? "mono"
                              : undefined
                          }
                        >
                          {diag.sse_events && diag.sse_events.length > 0
                            ? diag.sse_events.join(" → ")
                            : "无数据帧"}
                          {diag.keepalives
                            ? ` (${diag.keepalives} keepalive)`
                            : ""}
                        </dd>
                      </div>
                    )}
                  </dl>
                )}

                {hasAttempts && diag?.attempts && (
                  <div className="rh-err-attempts">
                    <span className="rh-err-sec-k">
                      自动重试与回退链路（{diag.attempts.length} 次尝试）
                    </span>
                    <ol className="rh-err-attempt-list">
                      {diag.attempts.map((att, aIdx) => {
                        const outcome = describeAttemptOutcome(att);
                        const httpLabel =
                          att.http_status && att.http_status > 0
                            ? `HTTP ${att.http_status}`
                            : "网络中断";
                        const isBad = !att.http_status || att.http_status >= 400;
                        const hasAttTok =
                          typeof att.in_tokens === "number" ||
                          typeof att.out_tokens === "number";
                        const tokPart = hasAttTok
                          ? `输入 ${(att.in_tokens ?? 0).toLocaleString("en-US")}${
                              att.cached_tokens
                                ? ` (缓存 ${att.cached_tokens.toLocaleString("en-US")})`
                                : ""
                            } / 输出 ${(att.out_tokens ?? 0).toLocaleString("en-US")}`
                          : "";
                        return (
                          <li
                            key={`${att.endpoint}-${aIdx}`}
                            className="rh-err-attempt-row"
                          >
                            <span className="rh-err-attempt-idx num">
                              #{aIdx + 1}
                            </span>
                            <code className="rh-err-attempt-ep mono">
                              {att.endpoint || att.api}
                            </code>
                            <span aria-hidden>→</span>
                            <span
                              className={`rh-err-attempt-http num ${isBad ? "is-bad" : ""}`}
                            >
                              {httpLabel}
                            </span>
                            <span className="rh-err-attempt-meta num">
                              · {fmtStepDuration(att.ms)}
                              {tokPart ? ` · ${tokPart}` : ""}
                              {outcome ? ` · ${outcome}` : ""}
                              {att.request_note ? ` · ${att.request_note}` : ""}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}

                <Smooth>
                  {rawDiagOpen && hasRawPayload && diag && (
                    <div className="rh-err-raw-drawer">
                      <div
                        className={`rh-err-raw-grid ${rawSinglePane ? "is-single" : ""}`}
                      >
                        {diag.request_summary && (
                          <div className="rh-err-raw-pane">
                            <div className="rh-err-raw-head">
                              <span>请求参数摘要（已脱敏）</span>
                              <button
                                type="button"
                                className="rh-err-raw-mini-copy"
                                onClick={() => void copy(diag.request_summary!)}
                              >
                                <IconCopy />
                                <span>复制</span>
                              </button>
                            </div>
                            <pre className="rh-err-pre mono">
                              {diag.request_summary}
                            </pre>
                          </div>
                        )}
                        {diag.response_raw && (
                          <div className="rh-err-raw-pane">
                            <div className="rh-err-raw-head">
                              <span>网关原始响应 / SSE 报文</span>
                              <button
                                type="button"
                                className="rh-err-raw-mini-copy"
                                onClick={() => void copy(diag.response_raw!)}
                              >
                                <IconCopy />
                                <span>复制</span>
                              </button>
                            </div>
                            <pre className="rh-err-pre mono">
                              {diag.response_raw}
                            </pre>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </Smooth>

                <div className="rh-ai-err-actions">
                  {onRetry && (
                    <Button
                      size="small"
                      type="primary"
                      icon={<IconRefresh />}
                      onClick={onRetry}
                    >
                      重新发起
                    </Button>
                  )}
                  {errGuide.suggestSettings && can("ai.settings|ai.usage") && (
                    <>
                      <Button
                        size="small"
                        type="secondary"
                        onClick={() => go({ name: "settings", id: "ai" })}
                      >
                        前往 AI 设置切换模型
                      </Button>
                      <Button
                        size="small"
                        type="secondary"
                        onClick={() => go({ name: "settings", id: "ai-usage" })}
                      >
                        查看 AI 用量明细
                      </Button>
                    </>
                  )}
                  {hasRawPayload && (
                    <button
                      type="button"
                      className={`rh-err-raw-toggle ${rawDiagOpen ? "on" : ""}`}
                      aria-expanded={rawDiagOpen}
                      onClick={() => setRawDiagOpen((v) => !v)}
                    >
                      <span>
                        {rawDiagOpen
                          ? "收起网关原始诊断报文"
                          : "查看网关原始诊断报文"}
                      </span>
                      {rawDiagOpen ? <IconUp /> : <IconDown />}
                    </button>
                  )}
                  {onDismiss && (
                    <Button size="small" type="text" onClick={onDismiss}>
                      收起提示
                    </Button>
                  )}
                </div>
              </div>
            )}

            {showThinkingConsole && (
              <div className="rh-ai-think-wrap is-fill">
                <div className="rh-ai-think-label">
                  <span className="rh-ai-think-label-left">
                    <IconBulb />
                    <span>AI 实时思考推演</span>
                  </span>
                  {activePlayIdx >= 4 && (
                    <span className="rh-ai-think-done-tag">推演已收敛</span>
                  )}
                </div>
                <div className="rh-ai-think-box" ref={thinkBoxRef}>
                  {live.thinking ? (
                    <RehearsalThinkingContent
                      text={live.thinking}
                      streaming={activePlayIdx === 3}
                    />
                  ) : (
                    <p className="rh-ai-think-wait">
                      已接收模型流式通道，正在解码架构风险与变更边界推演…
                      <span className="rh-ai-caret" aria-hidden />
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!trace) return null;
  const steps = trace.steps || [];
  const hasThinking = Boolean(trace.thinking && trace.thinking.trim());
  const traceSplit = steps.length > 0 && hasThinking;
  const dur = fmtElapsedMs(trace.ms);
  const fallbackUsed =
    trace.diag?.fallback_used ||
    steps.find((s) => s.diag?.fallback_used)?.diag?.fallback_used;

  const staticStepsNode = steps.length > 0 && (
    <ol className="rh-pipe-steps is-static">
      {steps.map((st, idx) => {
        const vStatus =
          st.ok === false || st.status === "warn" ? "warn" : "done";
        const isLast = idx === steps.length - 1;
        const stepDur = fmtElapsedMs(st.ms);
        return (
          <li key={st.id} className={`rh-pstep is-${vStatus}`}>
            <div className="rh-pstep-track" aria-hidden>
              <span className={`rh-pstep-node is-${vStatus}`}>
                {vStatus === "done" ? (
                  <IconCheck />
                ) : (
                  <span className="rh-pstep-bang">!</span>
                )}
              </span>
              {!isLast && (
                <span className="rh-pstep-rail">
                  <i
                    className="rh-pstep-rail-fill"
                    style={{ transform: "scaleY(1)" }}
                  />
                </span>
              )}
            </div>
            <div className="rh-pstep-main">
              <div className="rh-pstep-top">
                <span className="rh-pstep-title">{st.title}</span>
                {stepDur && (
                  <span className={`rh-pstep-badge is-${vStatus} num`}>
                    {stepDur}
                  </span>
                )}
              </div>
              {st.detail && (
                <p
                  className="rh-pstep-detail"
                  title={st.detail.length > 44 ? st.detail : undefined}
                >
                  {st.detail}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );

  const parsedThink = hasThinking
    ? parseThinkingBlocks(trace.thinking || "")
    : [];
  const thinkStepCount = parsedThink.filter(
    (b) => b.kind === "step" || b.kind === "bullet",
  ).length;
  const thinkPreviewSteps = parsedThink
    .flatMap((b) =>
      (b.kind === "step" || b.kind === "bullet") && b.lead
        ? [
            {
              index: b.kind === "step" ? b.index : undefined,
              lead: b.lead,
              body: b.body,
            },
          ]
        : [],
    )
    .slice(0, 4);
  const firstPreviewBlock = parsedThink[0];
  const primaryPreviewLine = firstPreviewBlock
    ? (firstPreviewBlock.kind === "heading" ||
      firstPreviewBlock.kind === "para"
        ? firstPreviewBlock.text
        : firstPreviewBlock.body
      )
        .replace(/\s*\n+\s*/g, " ")
        .trim()
    : "";
  const fallbackPreviewText = parsedThink
    .map((b) =>
      (b.kind === "heading" || b.kind === "para" ? b.text : b.body)
        .replace(/\s*\n+\s*/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join(" · ");

  const metaItems: React.ReactNode[] = [];
  if (steps.length > 0) {
    metaItems.push(
      <span
        key="steps"
        className={`rh-ai-meta-item ${steps.every((s) => s.ok) ? "is-ok" : ""}`}
      >
        {steps.every((s) => s.ok)
          ? `${steps.length} 步通过`
          : `${steps.length} 步记录`}
      </span>,
    );
  }
  if (dur) {
    metaItems.push(
      <span key="dur" className="rh-ai-meta-item num">
        耗时 {dur}
      </span>,
    );
  }
  if (trace.model) {
    metaItems.push(
      <span key="model" className="rh-ai-meta-model mono">
        {trace.model}
      </span>,
    );
  }

  const staticThinkNode = hasThinking && (
    <div className={`rh-ai-think-wrap ${traceSplit ? "is-fill" : ""}`}>
      <div className="rh-ai-think-label">
        <span className="rh-ai-think-label-left">
          <IconBulb />
          <span>AI 架构研判与思考路径</span>
        </span>
        {thinkStepCount >= 2 && (
          <span className="rh-ai-think-count num">
            {thinkStepCount} 项研判要点
          </span>
        )}
      </div>
      <div className="rh-ai-think-box done">
        <RehearsalThinkingContent text={trace.thinking!} />
      </div>
    </div>
  );

  return (
    <div
      className={`rh-ai-proc ${open ? "is-open" : ""} ${!open && hasThinking ? "has-preview" : ""}`}
    >
      <button
        type="button"
        className="rh-ai-head clickable"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="rh-ai-head-left">
          <span className="rh-ai-badge-ic" aria-hidden>
            <IconBulb />
          </span>
          <b>{title}</b>
          {metaItems.length > 0 && (
            <span className="rh-ai-meta">
              {metaItems.map((item, idx) => (
                <React.Fragment key={idx}>
                  {idx > 0 && (
                    <i className="rh-ai-meta-dot" aria-hidden>
                      ·
                    </i>
                  )}
                  {item}
                </React.Fragment>
              ))}
            </span>
          )}
          {fallbackUsed && (
            <span
              className="rh-ai-chip is-fallback"
              title={`上游 Responses 协议返回空内容或不兼容，已自动降级完成调用（${fallbackUsed}）`}
            >
              {fallbackUsed.includes("chat")
                ? "已自动回退兼容 Chat Completions"
                : `已自动兼容回退 (${fallbackUsed})`}
            </span>
          )}
        </div>
        <div className="rh-ai-head-right">
          <span className="rh-ai-toggle-txt">
            {open ? "收起推演" : "查看完整推演"}
          </span>
          {open ? <IconUp /> : <IconDown />}
        </div>
      </button>

      {!open && hasThinking && (
        <div
          className="rh-ai-preview"
          onClick={() => setOpen(true)}
          role="button"
          tabIndex={-1}
        >
          {thinkPreviewSteps.length > 0 && (
            <div className="rh-ai-preview-tags">
              {thinkPreviewSteps.map((it, idx) => (
                <span key={`${it.lead}-${idx}`} className="rh-ai-preview-tag">
                  {it.index && <b className="num">{it.index}</b>}
                  <span>{it.lead}</span>
                </span>
              ))}
            </div>
          )}
          <div
            className={`rh-ai-preview-clip ${thinkPreviewSteps.length > 0 ? "is-one-line" : ""}`}
          >
            {renderThinkingInline(
              (thinkPreviewSteps.length > 0
                ? primaryPreviewLine
                : fallbackPreviewText) ||
                trace.thinking ||
                "",
            )}
          </div>
        </div>
      )}

      <Smooth>
        {open &&
          (traceSplit ? (
            <div className="rh-ai-body is-split">
              <div className="rh-ai-left">{staticStepsNode}</div>
              <div className="rh-ai-right">{staticThinkNode}</div>
            </div>
          ) : (
            <div className="rh-ai-body">
              {staticStepsNode}
              {staticThinkNode}
            </div>
          ))}
      </Smooth>
    </div>
  );
}

/* ---------- Image Thumbnail Strip, Saved Gallery & Lightbox ---------- */

function ImageLightbox({
  items,
  index,
  onClose,
  onIndexChange,
}: {
  items: { src: string; label: string }[];
  index: number | null;
  onClose: () => void;
  onIndexChange: (next: number) => void;
}) {
  if (index === null || !items[index]) return null;
  const cur = items[index];
  return (
    <Modal
      visible
      footer={null}
      title={
        <span className="rh-lb-title">
          <span>{cur.label}</span>
          {items.length > 1 && (
            <span className="faint small num">
              {index + 1} / {items.length}
            </span>
          )}
        </span>
      }
      onCancel={onClose}
      style={{ width: "min(92vw, 1080px)" }}
    >
      <div className="rh-lb-body">
        <img src={cur.src} alt={cur.label} className="rh-lb-img" />
        {items.length > 1 && (
          <div className="rh-lb-nav">
            <Button
              size="small"
              disabled={index <= 0}
              onClick={() => onIndexChange(index - 1)}
            >
              上一张
            </Button>
            <Button
              size="small"
              disabled={index >= items.length - 1}
              onClick={() => onIndexChange(index + 1)}
            >
              下一张
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function DraftImageStrip({
  images,
  onRemove,
}: {
  images: DraftImage[];
  onRemove: (id: string) => void;
}) {
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  if (!images.length) return null;
  const lbItems = images.map((im, idx) => ({
    src: im.dataUrl,
    label: `${im.name}（${im.sizeKB} KB）` || `待发送截图 ${idx + 1}`,
  }));
  return (
    <>
      <div className="rh-img-strip" aria-label="已粘贴或选择的截图">
        {images.map((im, idx) => (
          <div key={im.id} className="rh-img-thumb">
            <button
              type="button"
              className="rh-img-open"
              onClick={() => setPreviewIdx(idx)}
              title="点击放大查看截图"
            >
              <img src={im.dataUrl} alt={im.name} />
            </button>
            <span className="rh-img-caption">
              <span className="rh-img-name">{im.name}</span>
              <small className="num">{im.sizeKB}KB</small>
            </span>
            <button
              type="button"
              className="rh-img-rm"
              aria-label={`移除 ${im.name}`}
              onClick={() => onRemove(im.id)}
            >
              <IconClose />
            </button>
          </div>
        ))}
      </div>
      <ImageLightbox
        items={lbItems}
        index={previewIdx}
        onClose={() => setPreviewIdx(null)}
        onIndexChange={setPreviewIdx}
      />
    </>
  );
}

function SavedImageGallery({
  clusterId,
  rehearsalId,
  names,
  label = "现场截图",
}: {
  clusterId: string;
  rehearsalId: string;
  names?: string[];
  label?: string;
}) {
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  if (!names || names.length === 0) return null;
  const items = names.map((n, i) => ({
    src: rehearsalImgUrl(clusterId, rehearsalId, n),
    label: `${label} ${i + 1}（${n}）`,
  }));
  return (
    <>
      <div className="rh-saved-imgs">
        <span className="rh-saved-imgs-k">
          <IconImage /> {label}（{names.length}）
        </span>
        <div className="rh-img-strip">
          {items.map((it, idx) => (
            <div key={names[idx]} className="rh-img-thumb saved">
              <button
                type="button"
                className="rh-img-open"
                onClick={() => setPreviewIdx(idx)}
                title="点击放大查看截图"
              >
                <img src={it.src} alt={it.label} loading="lazy" />
              </button>
              <span className="rh-img-caption">
                <span className="rh-img-name">截图 {idx + 1}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <ImageLightbox
        items={items}
        index={previewIdx}
        onClose={() => setPreviewIdx(null)}
        onIndexChange={setPreviewIdx}
      />
    </>
  );
}

/* ---------- Collapsible Right-Side Delivery Baseline Panel ---------- */

const SENSITIVE_KEY_RE = /(pass|pwd|secret|token|key|cert|auth)/i;

function DeliveryBaselineAside({
  c,
  onClose,
  onReturnToDelivery,
}: {
  c: ClusterView;
  onClose: () => void;
  onReturnToDelivery: (tab?: "overview" | "config" | "plans" | "docs") => void;
}) {
  const jobPath = c.current
    ? `/api/jobs/${encodeURIComponent(c.current)}`
    : "";
  const [detail, setDetail] = useState<JobDetail | undefined>(() =>
    jobPath ? cached<JobDetail>(jobPath) : undefined,
  );
  const [loading, setLoading] = useState(() => Boolean(jobPath && !detail));

  useEffect(() => {
    if (!jobPath) {
      setDetail(undefined);
      setLoading(false);
      return;
    }
    const hit = cached<JobDetail>(jobPath);
    if (hit) {
      setDetail(hit);
      setLoading(false);
    } else {
      setLoading(true);
    }
    let alive = true;
    fetchCached<JobDetail>(jobPath)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => {
        /* keep fallback cluster facts */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [jobPath]);

  const hostRows = useMemo(() => {
    const plan = detail?.plan;
    const specHosts = detail?.spec?.deployment?.hosts || [];
    const hosts = plan?.hosts?.length ? plan.hosts : specHosts;
    const roleByHost = new Map<string, string[]>();
    for (const inst of plan?.instances || []) {
      const titles = inst.role_titles || {};
      for (const [roleKey, assigned] of Object.entries(inst.roles || {})) {
        const roleLabel = titles[roleKey] || roleKey;
        for (const hName of assigned || []) {
          const prev = roleByHost.get(hName) || [];
          if (!prev.includes(roleLabel)) prev.push(roleLabel);
          roleByHost.set(hName, prev);
        }
      }
    }
    return hosts.map((h) => ({
      name: h.name,
      ip: h.ip,
      roles: (roleByHost.get(h.name) || []).join(" / ") || "集群节点",
    }));
  }, [detail]);

  const endpoints = useMemo(() => {
    const out: { label: string; addr: string }[] = [];
    for (const inst of detail?.plan?.instances || []) {
      for (const ep of inst.endpoints || []) {
        out.push({
          label: ep.title || ep.name,
          addr: `:${ep.port} (${ep.protocol})`,
        });
      }
    }
    return out.slice(0, 6);
  }, [detail]);

  const customParams = useMemo(() => {
    const raw =
      detail?.spec?.deployment?.instances?.[0]?.params ||
      detail?.plan?.instances?.[0]?.params ||
      {};
    const entries: { k: string; v: string }[] = [];
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === null || v === "" || SENSITIVE_KEY_RE.test(k))
        continue;
      if (typeof v === "object") continue;
      entries.push({ k, v: String(v) });
      if (entries.length >= 10) break;
    }
    return entries;
  }, [detail]);

  return (
    <aside className="rh-delivery-aside" aria-label="集群初始交付基线">
      <div className="rh-aside-head">
        <div>
          <b>当前交付基线</b>
          <span className="faint small">
            {c.app_name} {c.version}
            {c.platform ? ` · ${platformShort(c.platform)}` : ""}
          </span>
        </div>
        <button
          type="button"
          className="rh-aside-close"
          onClick={onClose}
          aria-label="收起交付基线面板"
          title="收起面板 (Esc)"
        >
          <IconClose />
        </button>
      </div>

      <div className="rh-aside-scroll">
        <div className="rh-aside-sec">
          <SchemeInfo scheme={c.scheme} detail label="当前部署架构" />
        </div>

        <div className="rh-aside-sec">
          <div className="rh-aside-sec-title">
            <span>初始节点与角色拓扑</span>
            <span className="num faint">{hostRows.length || c.hosts} 台</span>
          </div>
          {loading && hostRows.length === 0 ? (
            <Skeleton animation text={{ rows: 3 }} />
          ) : hostRows.length > 0 ? (
            <ul className="rh-aside-hosts">
              {hostRows.map((h) => (
                <li key={h.name + h.ip}>
                  <div className="rh-aside-host-main">
                    <b>{h.name}</b>
                    <span className="rh-aside-role">{h.roles}</span>
                  </div>
                  {h.ip && (
                    <button
                      type="button"
                      className="rh-aside-ip mono"
                      onClick={() => void copy(h.ip)}
                      title="点击复制节点 IP"
                    >
                      <span>{h.ip}</span>
                      <IconCopy />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">共 {c.hosts} 台节点（点击下方可查看完整配置）</p>
          )}
        </div>

        {endpoints.length > 0 && (
          <div className="rh-aside-sec">
            <div className="rh-aside-sec-title">
              <span>服务端口与入口</span>
            </div>
            <div className="rh-aside-kv">
              {endpoints.map((ep) => (
                <div key={ep.label + ep.addr}>
                  <span>{ep.label}</span>
                  <code className="mono">{ep.addr}</code>
                </div>
              ))}
            </div>
          </div>
        )}

        {customParams.length > 0 && (
          <div className="rh-aside-sec">
            <div className="rh-aside-sec-title">
              <span>交付关键参数</span>
            </div>
            <div className="rh-aside-kv">
              {customParams.map((p) => (
                <div key={p.k}>
                  <code className="mono">{p.k}</code>
                  <b className="mono">{p.v}</b>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="rh-aside-sec">
          <div className="rh-aside-sec-title">
            <span>跳转集群页面</span>
          </div>
          <div className="rh-aside-nav">
            <button
              type="button"
              onClick={() => onReturnToDelivery("overview")}
            >
              集群概览 <IconRight />
            </button>
            <button
              type="button"
              onClick={() => onReturnToDelivery("config")}
            >
              部署配置 <IconRight />
            </button>
            <button
              type="button"
              onClick={() => onReturnToDelivery("plans")}
            >
              查看部署手册 <IconRight />
            </button>
            <button
              type="button"
              onClick={() => onReturnToDelivery("docs")}
            >
              集群文档 <IconRight />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ---------- Bespoke Business SVG Visuals ---------- */

function RehearsalPipelineArt() {
  return (
    <div className="rh-pipe" aria-label="变更演练四阶段流程：边界对齐、只读探针、测试演练、生产 SOP">
      <div className="rh-pipe-node">
        <span className="rh-pipe-ic">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
            <path
              d="M4 6h12M4 10h8M4 14h10"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
            <circle cx="15" cy="10" r="2" fill="currentColor" />
          </svg>
        </span>
        <div>
          <b>
            <i className="num">01</i>边界对齐
          </b>
          <small>目标与窗口</small>
        </div>
      </div>
      <svg className="rh-pipe-wire" viewBox="0 0 36 12" fill="none" aria-hidden>
        <path d="M2 6h30" stroke="currentColor" strokeDasharray="3 3" />
        <path
          d="M29 3l4 3-4 3"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="rh-pipe-node">
        <span className="rh-pipe-ic ok">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
            <path
              d="M10 2.5L4 5v4.6c0 3.8 2.5 6.9 6 7.9 3.5-1 6-4.1 6-7.9V5l-6-2.5z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path
              d="M7.5 10l1.8 1.8 3.4-3.6"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div>
          <b>
            <i className="num">02</i>只读探针
          </b>
          <small>识别现场漂移</small>
        </div>
      </div>
      <svg className="rh-pipe-wire" viewBox="0 0 36 12" fill="none" aria-hidden>
        <path d="M2 6h30" stroke="currentColor" strokeDasharray="3 3" />
        <path
          d="M29 3l4 3-4 3"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="rh-pipe-node">
        <span className="rh-pipe-ic brand">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
            <rect
              x="2.5"
              y="3.5"
              width="15"
              height="13"
              rx="3"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path
              d="M6.5 8l2.5 2-2.5 2M10.5 12h3"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div>
          <b>
            <i className="num">03</i>测试演练
          </b>
          <small>逐步实测打磨</small>
        </div>
      </div>
      <svg className="rh-pipe-wire" viewBox="0 0 36 12" fill="none" aria-hidden>
        <path d="M2 6h30" stroke="currentColor" strokeDasharray="3 3" />
        <path
          d="M29 3l4 3-4 3"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="rh-pipe-node">
        <span className="rh-pipe-ic">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
            <path
              d="M5.5 2.8h6.3l3.7 3.7v10.7a1.3 1.3 0 01-1.3 1.3H5.5a1.3 1.3 0 01-1.3-1.3V4.1a1.3 1.3 0 011.3-1.3z"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path
              d="M7.2 10.5h5.6M7.2 13.5h3.8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <div>
          <b>
            <i className="num">04</i>生产 SOP
          </b>
          <small>导出 Word 审批</small>
        </div>
      </div>
    </div>
  );
}

function PresetGlyph({ kind }: { kind: RehearsalPresetKind }) {
  if (kind === "upgrade")
    return (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M10 15V5m0 0L6.2 8.8M10 5l3.8 3.8"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M4.5 16.5h11"
          stroke="currentColor"
          strokeOpacity="0.45"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  if (kind === "scale")
    return (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
        <rect
          x="3"
          y="4"
          width="6"
          height="5"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <rect
          x="3"
          y="11"
          width="6"
          height="5"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <rect
          x="11"
          y="7.5"
          width="6"
          height="5"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <path
          d="M14 4v2m-1-1h2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  if (kind === "tune")
    return (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
        <path
          d="M3.5 6.5h13M3.5 13.5h13"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle
          cx="8"
          cy="6.5"
          r="2.1"
          fill="var(--surface)"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <circle
          cx="12.5"
          cy="13.5"
          r="2.1"
          fill="var(--surface)"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </svg>
    );
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M4 7.5h11.5L12.5 4.5M16 12.5H4.5l3 3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ---------- Presets helper ---------- */

export function buildPresets(c: ClusterView) {
  const hostPhrase = c.hosts > 0 ? `现有 ${c.hosts} 台节点` : "现有集群拓扑";
  return [
    {
      kind: "upgrade" as RehearsalPresetKind,
      label: "版本平滑升级",
      sub: "从库先行 · 最小闪断",
      title: `${c.app_name} 小版本平滑升级`,
      goal: `将集群 ${c.id} 的 ${c.app_name}（基线版本 ${c.version}）平滑升级到目标小版本，优先从节点滚动先行、最后无损切主，控制业务闪断在秒级以内。`,
    },
    {
      kind: "scale" as RehearsalPresetKind,
      label: "在线节点扩缩",
      sub: "接入复制 · 读写不断",
      title: `${c.app_name} 在线扩容备节点`,
      goal: `在${hostPhrase}基础上在线新增 1 台只读备节点并接入复制拓扑，全程不中断主节点读写服务。`,
    },
    {
      kind: "tune" as RehearsalPresetKind,
      label: "运行参数调优",
      sub: "核对现值 · 热更或重启",
      title: `${c.app_name} 关键参数调优`,
      goal: `调整集群 ${c.id} 关键连接或内存参数，先核对现场当前生效值，明确动态热加载或滚动重启顺序，并准备回退命令。`,
    },
    {
      kind: "switch" as RehearsalPresetKind,
      label: "主备切换演练",
      sub: "计划切主 · 连通验证",
      title: `${c.app_name} 计划内主备切换演练`,
      goal: `在维护窗口内对集群 ${c.id} 执行一次计划内主备切换与回切演练，验证业务入口切换耗时并沉淀标准操作手册。`,
    },
  ];
}

function stepSummary(item: ChangeRehearsal) {
  const steps = item.steps || [];
  if (item.stage === "finalized") return "已定稿 SOP";
  if (item.stage === "rehearsing" && steps.length > 0) {
    const req = steps.filter((s) => !s.optional && s.phase !== "rollback");
    const done = req.filter(
      (s) => s.status === "passed" || s.status === "skipped",
    ).length;
    return `演练 ${done}/${req.length}`;
  }
  return STAGE_META[item.stage]?.short || "进行中";
}

/* ---------- Main Cluster Rehearsal Workbench ---------- */

const rehearsalsListPath = (clusterId: string) =>
  `/api/clusters/${encodeURIComponent(clusterId)}/rehearsals`;
const rehearsalItemPath = (clusterId: string, id: string) =>
  `/api/clusters/${encodeURIComponent(clusterId)}/rehearsals/${encodeURIComponent(id)}`;

export function ClusterRehearsal({
  c,
  rehearsalId,
  initialList,
  focused = false,
  onFocusChange,
  onListUpdated,
}: {
  c: ClusterView;
  rehearsalId?: string;
  initialList?: ChangeRehearsal[] | null;
  focused?: boolean;
  onFocusChange?: (v: boolean) => void;
  onListUpdated?: () => void;
}) {
  const listUrl = rehearsalsListPath(c.id);
  const [list, setList] = useState<ChangeRehearsal[] | null>(
    () => initialList ?? cached<ChangeRehearsal[]>(listUrl) ?? null,
  );
  const [loadErr, setLoadErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [pickedPreset, setPickedPreset] = useState<RehearsalPresetKind | null>(
    null,
  );
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [goalImages, setGoalImages] = useState<DraftImage[]>([]);
  const [dragGoal, setDragGoal] = useState(false);
  const [liveCreate, setLiveCreate] = useState<LiveAIState | null>(null);
  const [ledgerCollapsed, setLedgerCollapsed] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [ledgerQuery, setLedgerQuery] = useState("");
  const [ledgerFilter, setLedgerFilter] = useState<
    "all" | "active" | "finalized"
  >("all");

  const createAbortRef = useRef<AbortController | null>(null);
  const seededMapRef = useRef<Map<string, ChangeRehearsal>>(new Map());
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  const goalFileInputRef = useRef<HTMLInputElement | null>(null);
  const ledgerShellRef = useRef<HTMLDivElement | null>(null);
  const asideShellRef = useRef<HTMLDivElement | null>(null);
  const onListUpdatedRef = useRef(onListUpdated);
  onListUpdatedRef.current = onListUpdated;

  const conn = useConnectivity();
  const offline = conn === "offline";
  const aiStatus = useAIStatus();
  const noVision = Boolean(aiStatus.no_vision?.change_rehearsal);
  const pick = useModelPick("change_rehearsal");
  const aiOpts = useAIOptions();
  const effectiveNoVision = pick.current
    ? pick.current.vision === "no"
    : noVision;
  const narrow = useMedia("(max-width: 960px)");
  const creatingBusy = Boolean(liveCreate && !liveCreate.error);
  const ledgerOpen = Boolean(focused && !ledgerCollapsed && !narrow);

  const engageFocus = useCallback(() => {
    if (!focused) {
      setLedgerCollapsed(false);
    }
    onFocusChange?.(true);
  }, [focused, onFocusChange]);

  useEffect(() => {
    const el = ledgerShellRef.current as
      | (HTMLDivElement & { inert?: boolean })
      | null;
    if (el) el.inert = !ledgerOpen;
  }, [ledgerOpen]);

  useEffect(() => {
    const el = asideShellRef.current as
      | (HTMLDivElement & { inert?: boolean })
      | null;
    if (el) el.inert = !deliveryOpen;
  }, [deliveryOpen, narrow]);

  useEffect(() => {
    if (!deliveryOpen || narrow) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".arco-modal-wrapper, .pal-mask")) return;
      e.preventDefault();
      setDeliveryOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deliveryOpen, narrow]);

  const presets = useMemo(
    () => buildPresets(c),
    [c.id, c.app_name, c.version, c.hosts],
  );

  // Auto-grow launcher textarea height smoothly when populated; clear inline height when empty so CSS spring controls idle/hover expansion
  const hasLiveCreate = Boolean(liveCreate);
  useLayoutEffect(() => {
    const el = goalRef.current;
    if (!el) return;
    if (!goal) {
      el.style.height = "";
      el.style.overflowY = "hidden";
      return;
    }
    el.style.height = "auto";
    const minH = hasLiveCreate ? 72 : 104;
    const maxH = 280;
    const next = Math.min(Math.max(el.scrollHeight, minH), maxH);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
  }, [goal, creating, hasLiveCreate]);

  // Reset rail collapse and side drawer when switching clusters
  useEffect(() => {
    setLedgerCollapsed(false);
    setDeliveryOpen(false);
    setGoalImages([]);
    setLiveCreate(null);
    setLedgerQuery("");
    setLedgerFilter("all");
  }, [c.id]);

  // Consume one-shot deep-link intent from Cluster Overview if present (stay in current focus state until execution starts)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(INTENT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        cluster?: string;
        kind?: RehearsalPresetKind;
        create?: boolean;
      };
      if (parsed.cluster !== c.id) return;
      sessionStorage.removeItem(INTENT_KEY);
      setCreating(true);
      setLiveCreate(null);
      if (parsed.kind) {
        const found = presets.find((p) => p.kind === parsed.kind);
        if (found) {
          setPickedPreset(found.kind);
          setTitle(found.title);
          setGoal(found.goal);
        }
      }
      requestAnimationFrame(() => goalRef.current?.focus());
    } catch {
      /* ignore */
    }
  }, [c.id, presets]);

  useEffect(() => {
    if (initialList && list === null) {
      putCached(listUrl, initialList);
      for (const item of initialList) {
        putCached(rehearsalItemPath(c.id, item.id), item);
      }
      setList(initialList);
    }
  }, [c.id, initialList, list, listUrl]);

  const loadList = useCallback(
    async (allowRedirect = true) => {
      setLoadErr("");
      try {
        const r = await api<ChangeRehearsal[]>(listUrl);
        putCached(listUrl, r);
        for (const item of r) {
          putCached(rehearsalItemPath(c.id, item.id), item);
        }
        setList(r);
        onListUpdatedRef.current?.();
        if (allowRedirect && !rehearsalId && r.length > 0 && !creating) {
          go(
            {
              name: "deliveries",
              id: c.id,
              tab: "rehearsal",
              rehearsal: r[0].id,
            },
            { replace: true, instant: true },
          );
        }
      } catch (e) {
        setLoadErr((e as Error).message || "读取失败");
      }
    },
    [c.id, listUrl, rehearsalId, creating],
  );

  useEffect(() => {
    const hit = initialList ?? cached<ChangeRehearsal[]>(listUrl) ?? null;
    setList(hit);
    if (hit && hit.length > 0 && !rehearsalId && !creating) {
      go(
        {
          name: "deliveries",
          id: c.id,
          tab: "rehearsal",
          rehearsal: hit[0].id,
        },
        { replace: true, instant: true },
      );
    }
    void loadList(true);
  }, [c.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const showLauncher = creating || (list !== null && list.length === 0);
  const activeId = !showLauncher
    ? rehearsalId && list?.some((x) => x.id === rehearsalId)
      ? rehearsalId
      : list?.[0]?.id
    : undefined;

  const attachGoalFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!arr.length) return;
    if (effectiveNoVision) {
      Message.warning(
        "当前所选模型不支持识别图片，请在输入栏底部切换支持看图的模型",
      );
      return;
    }
    const room = MAX_IMAGES - goalImages.length;
    if (room <= 0) {
      Message.warning(`单次最多附加 ${MAX_IMAGES} 张截图`);
      return;
    }
    const added: DraftImage[] = [];
    for (const f of arr.slice(0, room)) {
      try {
        added.push(await prepareDraftImage(f));
      } catch (e) {
        err(e);
      }
    }
    if (added.length > 0) {
      setGoalImages((prev) => [...prev, ...added]);
    }
  };

  if (c.delivery_mode === "configuration" || !c.head) {
    return (
      <section className="dsec rh-guard">
        <b>当前集群暂不支持变更演练</b>
        <p className="muted">
          {c.delivery_mode === "configuration"
            ? "此记录仅生成配置文件，不代表现场已安装运行的集群。"
            : "请先完成集群部署并确认运行结果，再基于运行基线发起变更演练。"}
        </p>
        <div className="row-gap">
          {c.delivery_mode !== "configuration" && (
            <Button
              type="primary"
              onClick={() =>
                go(
                  { name: "deliveries", id: c.id, tab: "plans" },
                  { replace: true },
                )
              }
            >
              查看部署详情
            </Button>
          )}
          <Button
            onClick={() =>
              go({ name: "deliveries", id: c.id }, { replace: true })
            }
          >
            返回集群概览
          </Button>
        </div>
      </section>
    );
  }

  if (loadErr && list === null) {
    return (
      <section className="dsec rh-state" role="alert">
        <IconExclamationCircle className="bad" />
        <b>演练记录读取失败</b>
        <p className="muted small">{loadErr}</p>
        <Button icon={<IconRefresh />} onClick={() => void loadList(true)}>
          重试
        </Button>
      </section>
    );
  }

  if (list === null) {
    return (
      <section className="dsec rh-skel">
        <Skeleton
          animation
          text={{
            rows: 6,
            width: ["38%", "82%", "95%", "76%", "64%", "45%"],
          }}
        />
      </section>
    );
  }

  const applyPreset = (p: (typeof presets)[number]) => {
    setPickedPreset(p.kind);
    setTitle(p.title);
    setGoal(p.goal);
    requestAnimationFrame(() => goalRef.current?.focus());
  };

  const startNew = async () => {
    if (!goal.trim() || creatingBusy || offline) return;
    engageFocus();
    const ac = new AbortController();
    createAbortRef.current = ac;
    setLiveCreate(
      createInitialLiveState(
        "create",
        "AI 正在研判变更诉求与集群高可用边界",
        "正在读取集群基线并建立模型连接…",
        pick.current,
      ),
    );
    try {
      const created = await streamRehearsalAPI(
        `/api/clusters/${encodeURIComponent(c.id)}/rehearsals`,
        {
          title: title.trim() || undefined,
          goal: goal.trim(),
          images:
            goalImages.length > 0
              ? goalImages.map((im) => im.dataUrl)
              : undefined,
          model: pick.ref || undefined,
          effort: pick.current?.effort?.includes(aiOpts.pref.think)
            ? aiOpts.pref.think
            : undefined,
        },
        (updater) => setLiveCreate((prev) => (prev ? updater(prev) : prev)),
        ac.signal,
      );
      setLiveCreate(null);
      seededMapRef.current.set(created.id, created);
      setFreshId(created.id);
      setCreating(false);
      setPickedPreset(null);
      setGoal("");
      setTitle("");
      setGoalImages([]);
      await loadList(false);
      go({
        name: "deliveries",
        id: c.id,
        tab: "rehearsal",
        rehearsal: created.id,
      });
    } catch (e) {
      if (ac.signal.aborted) {
        setLiveCreate(null);
      } else {
        setLiveCreate((prev) => (prev ? markLiveStateError(prev, e) : null));
      }
    } finally {
      createAbortRef.current = null;
    }
  };

  const handleReturnToDelivery = (
    targetTab?: "overview" | "config" | "plans" | "docs",
  ) => {
    setDeliveryOpen(false);
    onFocusChange?.(false);
    if (!targetTab) return;
    if (targetTab === "overview") {
      go({ name: "deliveries", id: c.id }, { replace: true });
    } else if (targetTab === "config") {
      go({ name: "deliveries", id: c.id, tab: "config" });
    } else {
      go({ name: "deliveries", id: c.id, tab: targetTab }, { replace: true });
    }
  };

  const baselineFacts = [
    `${c.app_name} ${c.version}`,
    schemeName(c.scheme),
    c.hosts > 0 ? `${c.hosts} 台机器` : "",
    c.platform ? platformShort(c.platform) : "",
  ].filter(Boolean);

  const hasSessions = list.length > 0;
  const activeSessionSummary = list.find((x) => x.id === activeId);
  const inProgressSessions = list.filter((x) => x.stage !== "finalized");
  const finalizedSessions = list.filter((x) => x.stage === "finalized");
  const normLedgerQuery = ledgerQuery.trim().toLowerCase();
  const filteredSessions = list.filter((item) => {
    if (ledgerFilter === "active" && item.stage === "finalized") return false;
    if (ledgerFilter === "finalized" && item.stage !== "finalized") return false;
    if (!normLedgerQuery) return true;
    const hay = `${item.title} ${item.goal} ${item.scope_summary || ""} ${STAGE_META[item.stage]?.short || ""}`.toLowerCase();
    return hay.includes(normLedgerQuery);
  });
  const visibleInProgress = filteredSessions.filter(
    (x) => x.stage !== "finalized",
  );
  const visibleFinalized = filteredSessions.filter(
    (x) => x.stage === "finalized",
  );
  const showLedgerSearch = list.length >= 4 || Boolean(ledgerQuery);
  const showLedgerTabs =
    list.length >= 2 &&
    ((inProgressSessions.length > 0 && finalizedSessions.length > 0) ||
      ledgerFilter !== "all");
  const activePresetMeta = pickedPreset
    ? presets.find((p) => p.kind === pickedPreset)
    : null;

  const selectSession = (item: ChangeRehearsal) => {
    setCreating(false);
    setLiveCreate(null);
    go({
      name: "deliveries",
      id: c.id,
      tab: "rehearsal",
      rehearsal: item.id,
    });
  };

  const sessionDroplist = (
    <div className="rh-sess-menu" role="listbox" aria-label="切换演练记录">
      <div className="rh-sess-menu-head">
        <span className="num">演练记录（{list.length}）</span>
        <button
          type="button"
          className="rh-sess-menu-new"
          onClick={() => {
            setCreating(true);
            setLiveCreate(null);
            requestAnimationFrame(() => goalRef.current?.focus());
          }}
        >
          <IconPlus /> 新建演练
        </button>
      </div>
      {showLedgerSearch && (
        <div className="rh-ledger-search in-menu" onClick={(e) => e.stopPropagation()}>
          <IconSearch />
          <input
            type="search"
            value={ledgerQuery}
            onChange={(e) => setLedgerQuery(e.target.value)}
            placeholder="搜索演练标题或诉求…"
            aria-label="搜索演练记录"
          />
          {ledgerQuery && (
            <button
              type="button"
              onClick={() => setLedgerQuery("")}
              aria-label="清空搜索"
            >
              <IconClose />
            </button>
          )}
        </div>
      )}
      <div className="rh-sess-menu-list">
        {filteredSessions.length === 0 ? (
          <div className="rh-ledger-empty-filter">
            <span>无匹配演练记录</span>
            <button
              type="button"
              className="link small"
              onClick={() => {
                setLedgerQuery("");
                setLedgerFilter("all");
              }}
            >
              重置
            </button>
          </div>
        ) : (
          filteredSessions.map((item) => {
            const on = !showLauncher && item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={on}
                className={`rh-sess-menu-item ${on ? "on" : ""}`}
                onClick={() => selectSession(item)}
              >
                <span className={`rh-sdot st-${item.stage}`} aria-hidden />
                <span className="rh-sess-menu-main">
                  <b>{item.title}</b>
                  <small>
                    <span>{stepSummary(item)}</span>
                    <span>·</span>
                    <span>{ago(item.updated_at)}</span>
                  </small>
                </span>
                {on && <IconCheck className="rh-sess-check" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <div
      className={`rh-workbench ${focused ? "is-focused" : ""} ${deliveryOpen ? "aside-open" : ""}`}
    >
      {/* Top Focus & Context Bar */}
      <div className="rh-topbar">
        <div className="rh-topbar-left">
          {focused ? (
            <button
              type="button"
              className="rh-nav-pill back"
              onClick={() => handleReturnToDelivery()}
              title="收起专注模式，显示左侧交付集群列表与顶部标签"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden
              >
                <path
                  d="M10 3.5L5.5 8l4.5 4.5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>交付视图</span>
            </button>
          ) : (
            <button
              type="button"
              className="rh-nav-pill focus"
              onClick={() => {
                setLedgerCollapsed(false);
                onFocusChange?.(true);
              }}
              title="隐藏周围交付列表，展开演练记录栏与专注工作台"
            >
              <IconExpand />
              <span>专注演练</span>
            </button>
          )}

          {focused && !narrow && !ledgerOpen && (
            <button
              type="button"
              className="rh-nav-pill ledger-toggle"
              onClick={() => setLedgerCollapsed(false)}
              title="展开左侧演练记录栏"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden
              >
                <rect
                  x="1.75"
                  y="2.5"
                  width="12.5"
                  height="11"
                  rx="2.2"
                  stroke="currentColor"
                  strokeWidth="1.35"
                />
                <path
                  d="M5.75 2.75v10.5"
                  stroke="currentColor"
                  strokeWidth="1.35"
                />
                <path
                  d="M8.8 6l2.3 2-2.3 2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>展开记录栏</span>
            </button>
          )}

          {focused && (
            <span className="rh-cluster-crumb">
              <b className="mono">{c.id}</b>
              <span className="faint">·</span>
              <span>
                {c.app_name} {c.version}
              </span>
            </span>
          )}

          {!narrow && (!hasSessions || ledgerOpen) && (
            <span className="rh-ledger-crumb num">
              {hasSessions
                ? `共 ${list.length} 次记录 · ${finalizedSessions.length} 份已定稿`
                : "尚无演练记录"}
            </span>
          )}

          {(narrow || !focused || !ledgerOpen) && hasSessions && (
            <div className="rh-sess-bar">
              <Dropdown
                trigger="click"
                position="bl"
                triggerProps={{ autoFitPosition: true }}
                droplist={sessionDroplist}
              >
                <button
                  type="button"
                  className="rh-sess-trigger"
                  aria-label="切换演练记录"
                >
                  <span
                    className={`rh-sdot st-${activeSessionSummary?.stage || "scoping"}`}
                    aria-hidden
                  />
                  <span className="rh-sess-trigger-txt">
                    {showLauncher
                      ? "切换历史演练"
                      : activeSessionSummary?.title || "切换演练"}
                  </span>
                  <span className="rh-sess-count num">{list.length}</span>
                  <IconDown />
                </button>
              </Dropdown>

              <button
                type="button"
                className={`rh-new-btn ${creating ? "on" : ""}`}
                onClick={() => {
                  if (creating) {
                    setCreating(false);
                    setLiveCreate(null);
                  } else {
                    setCreating(true);
                    setLiveCreate(null);
                    requestAnimationFrame(() => goalRef.current?.focus());
                  }
                }}
              >
                {creating ? (
                  <>返回当前演练</>
                ) : (
                  <>
                    <IconPlus /> 新建
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        <div className="rh-topbar-right">
          <button
            type="button"
            className={`rh-nav-pill aside-toggle ${deliveryOpen ? "on" : ""}`}
            onClick={() => setDeliveryOpen((v) => !v)}
            aria-expanded={deliveryOpen}
            title={deliveryOpen ? "收起交付基线 (Esc)" : "查看当前交付基线"}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden
            >
              <rect
                x="1.8"
                y="2.5"
                width="12.4"
                height="11"
                rx="2.2"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <path
                d="M10 2.8v10.4"
                stroke="currentColor"
                strokeWidth="1.4"
              />
            </svg>
            <span>{deliveryOpen ? "收起交付基线" : "查看交付基线"}</span>
            {c.hosts > 0 && <em className="num">{c.hosts} 节点</em>}
          </button>
        </div>
      </div>

      {/* Left-Aligned 3-Zone Workbench: Collapsible Record Rail + Main Stage + Baseline Drawer */}
      <div
        className={`rh-stage-grid ${ledgerOpen ? "with-ledger" : ""} ${deliveryOpen && !narrow ? "with-aside" : ""}`}
      >
        {!narrow && (
          <div
            ref={ledgerShellRef}
            className="rh-ledger-shell"
            aria-hidden={!ledgerOpen}
          >
            <aside className="rh-ledger-rail" aria-label="演练记录">
              <div className="rh-ledger-head">
                <div className="rh-ledger-head-title">
                  <b>演练记录</b>
                  <span className="rh-ledger-cnt num">{list.length}</span>
                </div>
                <div className="rh-ledger-head-acts">
                  {hasSessions && (
                    <button
                      type="button"
                      className={`rh-ledger-new ${creating ? "is-cancel" : ""}`}
                      onClick={() => {
                        if (creating) {
                          setCreating(false);
                          setLiveCreate(null);
                        } else {
                          setCreating(true);
                          setLiveCreate(null);
                          requestAnimationFrame(() => goalRef.current?.focus());
                        }
                      }}
                    >
                      {creating ? (
                        <span>返回</span>
                      ) : (
                        <>
                          <IconPlus />
                          <span>新建</span>
                        </>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rh-ledger-collapse"
                    onClick={() => setLedgerCollapsed(true)}
                    aria-label="收起演练记录栏"
                    title="收起演练记录栏"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden
                    >
                      <rect
                        x="1.75"
                        y="2.5"
                        width="12.5"
                        height="11"
                        rx="2.2"
                        stroke="currentColor"
                        strokeWidth="1.35"
                      />
                      <path
                        d="M5.75 2.75v10.5"
                        stroke="currentColor"
                        strokeWidth="1.35"
                      />
                      <path
                        d="M11.1 6L8.8 8l2.3 2"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              {(showLedgerSearch || showLedgerTabs) && (
                <div className="rh-ledger-tools">
                  {showLedgerSearch && (
                    <div className="rh-ledger-search">
                      <IconSearch />
                      <input
                        type="search"
                        value={ledgerQuery}
                        onChange={(e) => setLedgerQuery(e.target.value)}
                        placeholder="搜索演练记录…"
                        aria-label="搜索演练记录"
                      />
                      {ledgerQuery && (
                        <button
                          type="button"
                          onClick={() => setLedgerQuery("")}
                          aria-label="清空搜索"
                        >
                          <IconClose />
                        </button>
                      )}
                    </div>
                  )}
                  {showLedgerTabs && (
                    <div
                      className="rh-ledger-tabs"
                      role="tablist"
                      aria-label="按演练状态筛选"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={ledgerFilter === "all"}
                        className={ledgerFilter === "all" ? "on" : ""}
                        onClick={() => setLedgerFilter("all")}
                      >
                        <span>全部</span>
                        <i className="num">{list.length}</i>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={ledgerFilter === "active"}
                        className={ledgerFilter === "active" ? "on" : ""}
                        onClick={() => setLedgerFilter("active")}
                      >
                        <span>进行中</span>
                        <i className="num">{inProgressSessions.length}</i>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={ledgerFilter === "finalized"}
                        className={ledgerFilter === "finalized" ? "on" : ""}
                        onClick={() => setLedgerFilter("finalized")}
                      >
                        <span>已定稿</span>
                        <i className="num">{finalizedSessions.length}</i>
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="rh-ledger-body">
                {showLauncher && (
                  <div className="rh-ledger-group">
                    <span className="rh-ledger-gtitle">当前草稿</span>
                    <div className="rh-ledger-card on is-draft">
                      <div className="rh-ledger-card-top">
                        <span className="rh-sdot is-draft-dot" aria-hidden />
                        <b>{title.trim() || "新建变更演练"}</b>
                      </div>
                      <div className="rh-ledger-card-meta">
                        <span className="rh-ledger-pill draft">
                          {liveCreate?.error
                            ? "通道受阻 · 待重试"
                            : creatingBusy
                              ? "AI 推演中…"
                              : activePresetMeta
                                ? activePresetMeta.label
                                : "待录入诉求"}
                        </span>
                        <span>未保存</span>
                      </div>
                    </div>
                  </div>
                )}

                {visibleInProgress.length > 0 && (
                  <div className="rh-ledger-group">
                    <span className="rh-ledger-gtitle num">
                      进行中 ({visibleInProgress.length})
                    </span>
                    {visibleInProgress.map((item) => {
                      const on = !showLauncher && item.id === activeId;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`rh-ledger-card ${on ? "on" : ""}`}
                          onClick={() => selectSession(item)}
                        >
                          <div className="rh-ledger-card-top">
                            <span
                              className={`rh-sdot st-${item.stage}`}
                              aria-hidden
                            />
                            <b>{item.title}</b>
                          </div>
                          <div className="rh-ledger-card-meta">
                            <span className={`rh-ledger-pill st-${item.stage}`}>
                              {stepSummary(item)}
                            </span>
                            <span className="num">{ago(item.updated_at)}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {visibleFinalized.length > 0 && (
                  <div className="rh-ledger-group">
                    <span className="rh-ledger-gtitle num">
                      已定稿 ({visibleFinalized.length})
                    </span>
                    {visibleFinalized.map((item) => {
                      const on = !showLauncher && item.id === activeId;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`rh-ledger-card ${on ? "on" : ""}`}
                          onClick={() => selectSession(item)}
                        >
                          <div className="rh-ledger-card-top">
                            <span className="rh-sdot st-finalized" aria-hidden />
                            <b>{item.title}</b>
                          </div>
                          <div className="rh-ledger-card-meta">
                            <span className="rh-ledger-pill st-finalized">
                              生产 SOP 已归档
                            </span>
                            <span className="num">{ago(item.updated_at)}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {hasSessions && filteredSessions.length === 0 && (
                  <div className="rh-ledger-empty-filter">
                    <span>未找到匹配的演练记录</span>
                    <button
                      type="button"
                      className="link small"
                      onClick={() => {
                        setLedgerQuery("");
                        setLedgerFilter("all");
                      }}
                    >
                      清除筛选条件
                    </button>
                  </div>
                )}

                {!hasSessions && (
                  <p className="rh-ledger-empty-hint">尚无已归档记录</p>
                )}
              </div>
            </aside>
          </div>
        )}

        <div className="rh-work-col">
          {loadErr && (
            <div className="rh-sync-err" role="status">
              <IconExclamationCircle />
              <span>演练记录同步失败：{loadErr}</span>
              <button
                type="button"
                className="link small"
                onClick={() => void loadList(false)}
              >
                重试
              </button>
            </div>
          )}

          {offline && (
            <div className="rh-offline" role="status">
              <span className="sdot s-warn" />
              网络已断开：已加载的采集脚本与命令仍可查看复制，连接恢复后可继续提交。
            </div>
          )}

          {showLauncher ? (
            <div
              className={`rh-launcher ${liveCreate ? "has-live" : ""}`.trim()}
            >
              <div className="rh-launch-top">
                <div className="rh-launch-title">
                  <h2>
                    <Spark size={18} rainbow /> 新建变更演练
                  </h2>
                  <div className="rh-baseline-pills" aria-label="集群基线">
                    {baselineFacts.map((f) => (
                      <span key={f} className="rh-base-pill">
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
                <Smooth>
                  {!liveCreate && (
                    <div className="rh-launch-collapsible">
                      <RehearsalPipelineArt />
                      <div
                        className="rh-preset-grid rh-presets"
                        role="group"
                        aria-label="常见变更场景"
                      >
                        {presets.map((p) => {
                          const active = pickedPreset === p.kind;
                          return (
                            <button
                              key={p.kind}
                              type="button"
                              className={`rh-preset-tile ${active ? "on" : ""}`}
                              disabled={creatingBusy}
                              onClick={() => applyPreset(p)}
                            >
                              <span className="rh-preset-ic">
                                <PresetGlyph kind={p.kind} />
                              </span>
                              <span className="rh-preset-txt">
                                <b>{p.label}</b>
                                <small>{p.sub}</small>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </Smooth>
              </div>

              <div
                className={`rh-compose ${offline ? "off" : ""} ${dragGoal ? "is-drag" : ""} ${creatingBusy ? "is-busy" : ""} ${goal || title || goalImages.length > 0 || dragGoal || creatingBusy ? "is-open" : ""}`}
                onDragOver={(e) => {
                  if (e.dataTransfer?.types?.includes("Files")) {
                    e.preventDefault();
                    setDragGoal(true);
                  }
                }}
                onDragLeave={() => setDragGoal(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragGoal(false);
                  if (e.dataTransfer?.files?.length) {
                    void attachGoalFiles(e.dataTransfer.files);
                  }
                }}
                onPaste={(e) => {
                  const imgs = extractClipboardImageFiles(e);
                  if (imgs.length > 0) {
                    if (!e.clipboardData?.getData("text/plain")) {
                      e.preventDefault();
                    }
                    void attachGoalFiles(imgs);
                  }
                }}
              >
                <div className="rh-compose-title">
                  <input
                    type="text"
                    value={title}
                    disabled={creatingBusy}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={100}
                    placeholder="演练标题（可选，留空由 AI 按诉求自动归纳命名）"
                    aria-label="演练标题"
                  />
                  {(title || goal || goalImages.length > 0) && !creatingBusy && (
                    <button
                      type="button"
                      className="rh-clear-btn"
                      onClick={() => {
                        setPickedPreset(null);
                        setTitle("");
                        setGoal("");
                        setGoalImages([]);
                        goalRef.current?.focus();
                      }}
                      aria-label="清空输入"
                      title="清空"
                    >
                      <IconClose />
                    </button>
                  )}
                </div>

                <textarea
                  ref={goalRef}
                  value={goal}
                  disabled={creatingBusy}
                  rows={1}
                  maxLength={4000}
                  onChange={(e) => setGoal(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void startNew();
                    }
                  }}
                  placeholder="写明变更目标（目标版本、新增节点或待调参数）、可接受的业务闪断窗口与测试环境情况；支持直接 Ctrl+V 粘贴架构图或工单截图…"
                  aria-label="变更诉求"
                />

                {goalImages.length > 0 && (
                  <div className="rh-compose-imgs">
                    <DraftImageStrip
                      images={goalImages}
                      onRemove={(id) =>
                        setGoalImages((prev) => prev.filter((x) => x.id !== id))
                      }
                    />
                  </div>
                )}

                <div className="rh-compose-foot">
                  <div className="rh-compose-tools">
                    <input
                      ref={goalFileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      multiple
                      hidden
                      onChange={(e) => {
                        if (e.target.files?.length) {
                          void attachGoalFiles(e.target.files);
                        }
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      className="rh-attach-btn"
                      disabled={creatingBusy || effectiveNoVision}
                      onClick={() => goalFileInputRef.current?.click()}
                      title={
                        effectiveNoVision
                          ? "当前所选模型不支持图片识别，可切换支持看图的模型"
                          : "上传或直接 Ctrl+V 粘贴截图"
                      }
                    >
                      <IconImage />
                      <span>粘贴/添加截图</span>
                    </button>
                    <span className="rh-safety-note">
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 20 20"
                        fill="none"
                        aria-hidden
                      >
                        <path
                          d="M10 2.5L4 5v4.6c0 3.8 2.5 6.9 6 7.9 3.5-1 6-4.1 6-7.9V5l-6-2.5z"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span>只读探针 · 零直连生产</span>
                    </span>
                  </div>
                  <div className="rh-compose-submit">
                    <ThinkLevel
                      levels={pick.current?.effort}
                      value={aiOpts.pref.think}
                      onChange={(v) => aiOpts.update({ think: v })}
                    />
                    <ModelPicker pick={pick} />
                    <Button
                      type="primary"
                      shape="round"
                      className={`ai-pill ${goal.trim() && !offline ? "ai-pill-primary" : ""}`}
                      icon={
                        <Spark
                          size={14}
                          rainbow={!goal.trim() || offline}
                        />
                      }
                      title={
                        isMac
                          ? "⌘ + Enter 对齐变更边界 · Enter 换行"
                          : "Ctrl + Enter 对齐变更边界 · Enter 换行"
                      }
                      loading={creatingBusy}
                      disabled={!goal.trim() || offline}
                      onClick={() => void startNew()}
                    >
                      对齐变更边界
                    </Button>
                  </div>
                </div>
              </div>

              {liveCreate && (
                <RehearsalAIProcess
                  live={liveCreate}
                  title={liveCreate.title}
                  onAbort={() => createAbortRef.current?.abort()}
                  onRetry={() => void startNew()}
                  onDismiss={() => setLiveCreate(null)}
                />
              )}
            </div>
          ) : activeId ? (
            <RehearsalSessionView
              key={activeId}
              c={c}
              id={activeId}
              initialSession={
                seededMapRef.current.get(activeId) ||
                list?.find((x) => x.id === activeId) ||
                cached<ChangeRehearsal>(rehearsalItemPath(c.id, activeId))
              }
              autoExpandCreateTrace={freshId === activeId}
              offline={offline}
              noVision={effectiveNoVision}
              pick={pick}
              aiOpts={aiOpts}
              onListChanged={() => loadList(false)}
              onEngageFocus={engageFocus}
            />
          ) : null}
        </div>

        {/* Right Collapsible Delivery Baseline Panel (Zero-bounce single-width glide) */}
        {!narrow && (
          <div
            ref={asideShellRef}
            className="rh-aside-shell"
            aria-hidden={!deliveryOpen}
          >
            <div className="rh-aside-inner">
              <DeliveryBaselineAside
                c={c}
                onClose={() => setDeliveryOpen(false)}
                onReturnToDelivery={handleReturnToDelivery}
              />
            </div>
          </div>
        )}
      </div>

      {narrow && deliveryOpen && (
        <Modal
          visible
          footer={null}
          title="当前交付基线"
          onCancel={() => setDeliveryOpen(false)}
          style={{ width: "min(94vw, 480px)" }}
        >
          <DeliveryBaselineAside
            c={c}
            onClose={() => setDeliveryOpen(false)}
            onReturnToDelivery={handleReturnToDelivery}
          />
        </Modal>
      )}
    </div>
  );
}

/* ---------- Progressive Boundary Alignment Deck (Stage 1) ---------- */

type ScopeSupplementSpec = {
  tag: string;
  badge: string;
  placeholder: string;
};

type ParsedScopeOpt = {
  raw: string;
  cleanBase: string;
  headline: string;
  sub: string;
  supplement: ScopeSupplementSpec | null;
};

function suggestNextVersion(base?: string): string {
  const s = (base || "").trim();
  if (!s) return "";
  const m = s.match(/^(v?\d+(?:\.\d+)*)\.(\d+)/i);
  if (m) {
    const nextPatch = String(Number(m[2]) + 1).padStart(
      m[2].length > 1 && m[2].startsWith("0") ? m[2].length : 0,
      "0",
    );
    return `${m[1]}.${nextPatch}`;
  }
  if (/^v?\d+$/i.test(s)) return `${s}.1`;
  return "";
}

function buildVersionPlaceholder(
  baselineVersion?: string,
  withPkgOrNode = false,
): string {
  const base = (baselineVersion || "").trim();
  const next = suggestNextVersion(base);
  const extra = withPkgOrNode ? "，可附包或节点说明" : "";
  if (base && next) {
    return `当前基线 ${base}，填写目标版本号（如 ${next}${extra}），回车确认…`;
  }
  return `填写已确定的目标版本号（如 16.6 / 7.2.5${extra}），回车确认…`;
}

const UNDECIDED_HEAD_RE =
  /待定|未定|不明|未知|不清|不确定|尚未|暂未|暂无|暂不|未明确|未就绪|未准备|未到位|未规划|未分配|无独立|无测试|无演练|无需|不需要|不涉及|不指定|不升级|不变更|保持现状|按默认|保守|先确认|先核实|先评估|先排查|待确认|待评估|待规划|待申请|自动择优/;

function inferScopeSupplement(
  q: ScopeQuestion,
  cleanBase: string,
  headline: string,
  explicitHint: string,
  baselineVersion?: string,
): ScopeSupplementSpec | null {
  if (explicitHint) {
    if (/版本|小版本|大版本|补丁|镜像|tag/i.test(explicitHint)) {
      return {
        tag: "目标版本",
        badge: "填版本号",
        placeholder: buildVersionPlaceholder(baselineVersion, false),
      };
    }
    if (/参数|配置|阈值|配额|连接|内存/i.test(explicitHint)) {
      return {
        tag: "目标参数",
        badge: "填目标值",
        placeholder:
          "填写待调参数名与目标值（如 max_connections=1000），回车确认…",
      };
    }
    if (/节点|主机|机器|ip|地址|实例/i.test(explicitHint)) {
      return {
        tag: "节点信息",
        badge: "填节点信息",
        placeholder:
          "填写新增或目标节点 IP / 主机名（如 10.0.1.14），回车确认…",
      };
    }
    if (/窗口|时段|时间|排期/i.test(explicitHint)) {
      return {
        tag: "维护时段",
        badge: "填时间窗",
        placeholder:
          "填写已排定的变更时间窗（如周六 02:00-04:00），回车确认…",
      };
    }
    return {
      tag: explicitHint.length <= 6 ? explicitHint : "补充说明",
      badge: explicitHint.length <= 4 ? `填${explicitHint}` : "补充说明",
      placeholder: `填写具体${explicitHint}，回车确认…`,
    };
  }

  if (
    UNDECIDED_HEAD_RE.test(headline) ||
    /^(?:尚未|暂未|暂无|暂不|未|无|不|先核实|先确认|先评估|待定|状态不明)/.test(
      cleanBase,
    )
  ) {
    return null;
  }

  const qText = `${q.label || ""} ${q.question || ""}`;

  // 1. Target version / patch upgrade decided
  const optExplicitVersionDecided =
    /(?:版本|小版本|大版本|补丁|镜像)(?:已定|已明确|明确|已确定|确定|已锁定|锁定|已选定|指定)|(?:已确定|已锁定|已明确|指定).*(?:版本|补丁|镜像)/.test(
      cleanBase,
    );
  const qAsksTargetVersion =
    /(?:目标|升级|计划|待升|新|跨|小|大|补丁).*版本|版本.*(?:准备|就绪|哪一步|明确|确定|定了吗|是什么|多少)|升级到/.test(
      qText,
    );
  const optVersionAffirmative =
    /全部就绪|均已就绪|都已就绪|全面就绪|目标明确|目标已定|版本已定|版本明确|已就绪|已备妥|已到位|已在内网|包已就绪|直接升级|已准备/.test(
      cleanBase,
    );
  const versionNegated = /(?:版本|目标)(?:待定|未定|不明|未明确|尚未|暂未)/.test(
    cleanBase,
  );
  if (
    !versionNegated &&
    (optExplicitVersionDecided || (qAsksTargetVersion && optVersionAffirmative))
  ) {
    const alsoHasPkgOrNode =
      /离线包|安装包|节点/.test(qText) &&
      /全部就绪|均已就绪|包与节点/.test(cleanBase);
    return {
      tag: "目标版本",
      badge: "填版本号",
      placeholder: buildVersionPlaceholder(baselineVersion, alsoHasPkgOrNode),
    };
  }

  // 2. Parameter / threshold / quota target decided
  const optExplicitParamDecided =
    /(?:参数|配置项|阈值|配额|目标值)(?:已定|已明确|明确|已确定|指定)|(?:已确定|已明确|指定).*(?:参数|阈值|配额|目标值)/.test(
      cleanBase,
    );
  const qAsksTargetParam =
    /(?:待调|调整|修改|目标|计划).*(?:参数|阈值|配额|目标值)|(?:参数|阈值|配额).*(?:目标值|明确|已定|哪些|多少|调到)/.test(
      qText,
    );
  const optParamAffirmative =
    /参数已定|目标值已定|目标明确|目标已定|全部就绪|方案已定|已确定|已明确|指定参数/.test(
      cleanBase,
    );
  const paramNegated = /(?:参数|阈值|目标值)(?:待定|未定|不明|未明确|尚未|暂未)/.test(
    cleanBase,
  );
  if (
    !paramNegated &&
    (optExplicitParamDecided || (qAsksTargetParam && optParamAffirmative))
  ) {
    return {
      tag: "目标参数",
      badge: "填目标值",
      placeholder:
        "填写待调参数名与目标值（如 max_connections=1000），回车确认…",
    };
  }

  // 3. Scale-out / replacement node IP or host ready
  const optExplicitNodeDecided =
    /(?:节点|机器|主机|备库|从库|实例|IP)(?:已定|已就绪|已到位|已分配|已准备|已备妥|已明确|指定)|(?:指定|已分配|已准备).*(?:节点|机器|主机|IP)/i.test(
      cleanBase,
    );
  const qAsksNodeReady =
    /(?:新增|扩容|缩容|替换|下线|新|待加|目标).*(?:节点|机器|主机|备库|从库)|(?:节点|机器|主机).*(?:准备|就绪|到位|分配|哪一步|IP)/i.test(
      qText,
    );
  const isTestEnvOnly =
    /测试环境|演练环境|沙箱|本地验证/.test(qText) &&
    !/扩容|缩容|生产新增/.test(qText);
  if (
    !isTestEnvOnly &&
    (optExplicitNodeDecided ||
      (qAsksNodeReady &&
        /全部就绪|均已就绪|已就绪|已到位|已分配|已备妥|机器已/.test(cleanBase)))
  ) {
    return {
      tag: "节点信息",
      badge: "填节点信息",
      placeholder:
        "填写新增或目标节点 IP / 主机名（如 10.0.1.14），回车确认…",
    };
  }

  // 4. Specific scheduled maintenance window
  if (
    /(?:窗口|时段|时间|排期)(?:已定|已排定|已确定|已批复)|指定(?:维护|变更)?(?:窗口|时段|时间)/.test(
      cleanBase,
    )
  ) {
    return {
      tag: "维护时段",
      badge: "填时间窗",
      placeholder:
        "填写已排定的变更时间窗（如周六 02:00-04:00），回车确认…",
    };
  }

  // 5. Custom external VIP / proxy / domain
  if (
    /外部.*(?:代理|负载均衡|VIP)|自建.*(?:代理|负载均衡)|自定义(?:域名|VIP|入口)|指定.*(?:VIP|域名|入口)/i.test(
      cleanBase,
    )
  ) {
    return {
      tag: "接入入口",
      badge: "填入口信息",
      placeholder: "填写外部 VIP、域名或负载均衡组件说明，回车确认…",
    };
  }

  // 6. General explicit "X已定 / 已指定"
  if (/(?:已定|已指定|指定目标)$/.test(headline)) {
    return {
      tag: "具体目标",
      badge: "填具体项",
      placeholder: "填写已确定的具体目标或约束值，回车确认…",
    };
  }

  return null;
}

function inferQuestionTopic(q: ScopeQuestion, index: number): string {
  const explicit = (q.label || "").trim();
  if (explicit) return explicit;
  const text = q.question || "";
  if (/版本|离线包|安装包|兼容|扩展|升级包/i.test(text)) return "版本与离线包";
  if (/主从|拓扑|复制|巡检|漂移|健康|实例|stanza|etcd|sentinel|patroni/i.test(text)) {
    return "拓扑与现状";
  }
  if (/窗口|闪断|中断|重连|入口|vip|排空|停机/i.test(text)) return "窗口与连接";
  if (/备份|回退|回滚|演练环境|测试环境|虚拟机/i.test(text)) return "备份与演练";
  if (/容量|内存|磁盘|连接数|参数|配置/i.test(text)) return "容量与参数";
  return `边界项 0${index + 1}`;
}

function parseScopeOption(
  raw: string,
  q: ScopeQuestion,
  baselineVersion?: string,
): ParsedScopeOpt {
  const trimmed = (raw || "").trim();
  let cleanBase = trimmed;
  let explicitHint = "";
  const supMatch = trimmed.match(
    /[（(]\s*(?:请)?(?:补充|填写|注明|输入)([^）)]*)[）)]\s*$/,
  );
  if (supMatch) {
    cleanBase = trimmed.slice(0, supMatch.index).trim();
    explicitHint = (supMatch[1] || "细节").trim();
  }
  const parts = cleanBase
    .split(/[，,]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  let headline = cleanBase;
  let sub = "";
  if (parts.length >= 3 && parts[0].length <= 4) {
    headline = `${parts[0]} · ${parts[1]}`;
    sub = parts.slice(2).join("，");
  } else if (parts.length > 1) {
    headline = parts[0];
    sub = parts.slice(1).join("，");
  }
  const supplement = inferScopeSupplement(
    q,
    cleanBase,
    headline,
    explicitHint,
    baselineVersion,
  );
  return {
    raw: trimmed,
    cleanBase,
    headline,
    sub,
    supplement,
  };
}

function matchOptionAnswer(
  curAns: string,
  opt: ParsedScopeOpt,
): { matched: boolean; detail: string } {
  const a = (curAns || "").trim();
  if (!a) return { matched: false, detail: "" };
  if (a === opt.raw || a === opt.cleanBase) {
    return { matched: true, detail: "" };
  }
  const pfx = `${opt.cleanBase}（`;
  if (a !== opt.raw && a.startsWith(pfx) && a.endsWith("）")) {
    const inner = a.slice(pfx.length, -1);
    const colonMatch = inner.match(/^[\u4e00-\u9fa5A-Za-z]{1,8}[：:]([\s\S]*)$/);
    return {
      matched: true,
      detail: colonMatch ? colonMatch[1] : inner,
    };
  }
  return { matched: false, detail: "" };
}

function summarizeAnswerChip(curAns: string, parsedOpts: ParsedScopeOpt[]): string {
  const a = (curAns || "").trim();
  if (!a) return "";
  for (const po of parsedOpts) {
    const m = matchOptionAnswer(a, po);
    if (m.matched) {
      const cleanDetail = m.detail.trim();
      return cleanDetail ? `${po.headline} · ${cleanDetail}` : po.headline;
    }
  }
  return a;
}

function ScopeAlignmentDeck({
  rehearsalId,
  questions,
  answers,
  setAnswers,
  extraScope,
  setExtraScope,
  disabled,
  freshReveal = false,
  baselineVersion,
}: {
  rehearsalId: string;
  questions: ScopeQuestion[];
  answers: Record<string, string>;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  extraScope: string;
  setExtraScope: (v: string) => void;
  disabled: boolean;
  freshReveal?: boolean;
  baselineVersion?: string;
}) {
  const [expandAll, setExpandAll] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(() => {
    const firstUnanswered = questions.find(
      (q) => !(answers[q.id] || q.answer || "").trim(),
    );
    return firstUnanswered ? firstUnanswered.id : null;
  });
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const [extraOpen, setExtraOpen] = useState(() => Boolean(extraScope.trim()));
  const syncedKeyRef = useRef("");
  const prevPresetRef = useRef<Record<string, string>>({});
  const customInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const supplementInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    const key = `${rehearsalId}:${questions.length}`;
    if (!questions.length || syncedKeyRef.current === key) return;
    syncedKeyRef.current = key;
    const firstUnanswered = questions.find(
      (q) => !(answers[q.id] || q.answer || "").trim(),
    );
    setActiveId(firstUnanswered ? firstUnanswered.id : null);
    setCustomOpen({});
    prevPresetRef.current = {};
    setExtraOpen(Boolean(extraScope.trim()));
  }, [rehearsalId, questions, answers, extraScope]);

  useEffect(() => {
    if (extraScope.trim()) setExtraOpen(true);
  }, [extraScope]);

  const parsedMap = useMemo(() => {
    const m: Record<string, ParsedScopeOpt[]> = {};
    for (const q of questions) {
      m[q.id] = (q.options || []).map((opt) =>
        parseScopeOption(opt, q, baselineVersion),
      );
    }
    return m;
  }, [questions, baselineVersion]);

  const answeredCount = useMemo(
    () => questions.filter((q) => Boolean((answers[q.id] || "").trim())).length,
    [questions, answers],
  );
  const allAligned = questions.length > 0 && answeredCount === questions.length;

  const findNextQuestionId = useCallback(
    (fromId: string, nextAnswers: Record<string, string>): string | null => {
      const idx = questions.findIndex((q) => q.id === fromId);
      if (idx < 0) return null;
      for (let i = idx + 1; i < questions.length; i++) {
        if (!(nextAnswers[questions[i].id] || "").trim()) {
          return questions[i].id;
        }
      }
      for (let i = 0; i < idx; i++) {
        if (!(nextAnswers[questions[i].id] || "").trim()) {
          return questions[i].id;
        }
      }
      return null;
    },
    [questions],
  );

  const advanceFrom = useCallback(
    (fromId: string, nextAnswers = answers) => {
      if (expandAll) return;
      setActiveId(findNextQuestionId(fromId, nextAnswers));
    },
    [answers, expandAll, findNextQuestionId],
  );

  const focusCustomInput = (qId: string) => {
    window.requestAnimationFrame(() => {
      customInputRefs.current[qId]?.focus({ preventScroll: true });
    });
  };

  const focusSupplementInput = (qId: string) => {
    window.requestAnimationFrame(() => {
      supplementInputRefs.current[qId]?.focus({ preventScroll: true });
    });
  };

  const selectPresetOption = (q: ScopeQuestion, opt: ParsedScopeOpt) => {
    if (disabled) return;
    const cur = answers[q.id] || "";
    const sameMatch = matchOptionAnswer(cur, opt);
    let carryDetail = sameMatch.detail.trim();
    if (!carryDetail && opt.supplement) {
      for (const sibling of parsedMap[q.id] || []) {
        if (sibling.supplement) {
          const sibMatch = matchOptionAnswer(cur, sibling);
          if (sibMatch.matched && sibMatch.detail.trim()) {
            carryDetail = sibMatch.detail.trim();
            break;
          }
        }
      }
    }
    const nextVal =
      opt.supplement && carryDetail
        ? `${opt.cleanBase}（${opt.supplement.tag}：${carryDetail}）`
        : opt.cleanBase;
    const nextAnswers = { ...answers, [q.id]: nextVal };
    delete prevPresetRef.current[q.id];
    setAnswers(nextAnswers);
    setCustomOpen((prev) => (prev[q.id] ? { ...prev, [q.id]: false } : prev));

    if (opt.supplement) {
      focusSupplementInput(q.id);
    } else if (!expandAll) {
      setActiveId(findNextQuestionId(q.id, nextAnswers));
    }
  };

  const openCustomEditor = (
    qId: string,
    prevVal: string,
    clearPrevPreset: boolean,
  ) => {
    if (disabled) return;
    prevPresetRef.current[qId] = prevVal;
    if (clearPrevPreset && prevVal) {
      setAnswers((prev) => ({ ...prev, [qId]: "" }));
    }
    setCustomOpen((prev) => ({ ...prev, [qId]: true }));
    focusCustomInput(qId);
  };

  const cancelCustomEditor = (qId: string, isCustomVal: boolean) => {
    const hasPrev = Object.prototype.hasOwnProperty.call(
      prevPresetRef.current,
      qId,
    );
    const restoreVal = prevPresetRef.current[qId];
    delete prevPresetRef.current[qId];
    setCustomOpen((prev) => ({ ...prev, [qId]: false }));
    if (hasPrev) {
      setAnswers((prev) => ({ ...prev, [qId]: restoreVal || "" }));
    } else if (isCustomVal) {
      setAnswers((prev) => ({ ...prev, [qId]: "" }));
    }
  };

  const confirmCustomEditor = (qId: string) => {
    delete prevPresetRef.current[qId];
    setCustomOpen((prev) => ({ ...prev, [qId]: false }));
    advanceFrom(qId);
  };

  const updateSupplementDetail = (
    q: ScopeQuestion,
    opt: ParsedScopeOpt,
    detailRaw: string,
    trimEdges = false,
  ) => {
    const sanitized = detailRaw.replace(/[（）]/g, "");
    const finalDetail = trimEdges ? sanitized.trim() : sanitized;
    const nextVal = finalDetail.trim()
      ? `${opt.cleanBase}（${opt.supplement?.tag || "补充"}：${finalDetail}）`
      : opt.cleanBase;
    setAnswers((prev) => ({ ...prev, [q.id]: nextVal }));
  };

  return (
    <>
      <div
        className={`rh-sec-head rh-scope-sec-head ${freshReveal ? "is-fresh-head" : ""}`}
      >
        <div>
          <h3>确认变更边界与窗口约束</h3>
          <p>
            点选最贴近现场的前提即可生成纯只读探针；暂未确认的维度将自动按生产保守策略兜底。
          </p>
        </div>
        {questions.length > 0 && (
          <div className="rh-scope-head-tools">
            <span
              className={`rh-scope-prog ${allAligned ? "is-ready" : ""}`}
              aria-live="polite"
            >
              <span className="rh-scope-dots" aria-hidden>
                {questions.map((q) => (
                  <i
                    key={q.id}
                    className={(answers[q.id] || "").trim() ? "on" : ""}
                  />
                ))}
              </span>
              <span className="num">
                {allAligned
                  ? `已对齐 ${answeredCount}/${questions.length}`
                  : `已确认 ${answeredCount}/${questions.length}`}
              </span>
            </span>
            {questions.length > 1 && (
              <button
                type="button"
                className={`rh-scope-mode-btn ${expandAll ? "on" : ""}`}
                onClick={() => {
                  setExpandAll((v) => {
                    const next = !v;
                    if (!next && !activeId) {
                      const firstUnanswered = questions.find(
                        (q) => !(answers[q.id] || "").trim(),
                      );
                      setActiveId(
                        firstUnanswered ? firstUnanswered.id : questions[0]?.id || null,
                      );
                    }
                    return next;
                  });
                }}
              >
                {expandAll ? "逐项收起" : "展开全部"}
              </button>
            )}
          </div>
        )}
      </div>

      <div className={`rh-scope-deck ${freshReveal ? "is-fresh-deck" : ""}`}>
        {questions.map((q, qi) => {
          const parsedOpts = parsedMap[q.id] || [];
          const curAns = (answers[q.id] || "").trim();
          const isAnswered = Boolean(curAns);
          const isOpen = expandAll || activeId === q.id;
          const topic = inferQuestionTopic(q, qi);
          const matchedOptIdx = parsedOpts.findIndex(
            (po) => matchOptionAnswer(curAns, po).matched,
          );
          const matchedOpt =
            matchedOptIdx >= 0 ? parsedOpts[matchedOptIdx] : undefined;
          const matchedDetail = matchedOpt
            ? matchOptionAnswer(curAns, matchedOpt).detail
            : "";
          const rawAns = answers[q.id] || "";
          const isCustomVal =
            isAnswered && matchedOptIdx < 0 && parsedOpts.length > 0;
          const isEditingCustom =
            parsedOpts.length === 0 || Boolean(customOpen[q.id]);
          const isSavedCustom =
            parsedOpts.length > 0 && isCustomVal && !customOpen[q.id];
          const hasSupplement = Boolean(
            matchedOpt && matchedOpt.supplement && !isEditingCustom,
          );
          const summaryChip = summarizeAnswerChip(curAns, parsedOpts);
          const nextId = findNextQuestionId(q.id, answers);

          return (
            <div
              key={q.id}
              className={`rh-scope-item ${isOpen ? "is-open" : ""} ${isAnswered ? "is-answered" : ""}`}
              style={
                freshReveal
                  ? ({
                      "--rh-stagger": Math.min(qi, 6),
                    } as React.CSSProperties)
                  : undefined
              }
            >
              <button
                type="button"
                className="rh-scope-row-head"
                aria-expanded={isOpen}
                onClick={() => {
                  if (expandAll) {
                    setExpandAll(false);
                    setActiveId(q.id);
                    return;
                  }
                  setActiveId((prev) => (prev === q.id ? null : q.id));
                }}
              >
                <div className="rh-scope-row-left">
                  <span className="rh-scope-step num" aria-hidden>
                    {isAnswered ? <IconCheck /> : qi + 1}
                  </span>
                  <span className="rh-scope-topic">{topic}</span>
                  {!isOpen ? (
                    <span className="rh-scope-preview">{q.question}</span>
                  ) : (
                    <span className="rh-scope-pos num">
                      第 {qi + 1} / {questions.length} 项
                    </span>
                  )}
                </div>
                <div className="rh-scope-row-right">
                  {isAnswered ? (
                    <span className="rh-scope-ans-pill" title={curAns}>
                      <span className="rh-scope-ans-txt">{summaryChip}</span>
                      {!isOpen && <em>修改</em>}
                    </span>
                  ) : !isOpen ? (
                    <span className="rh-scope-pending-pill">待点选</span>
                  ) : null}
                  <IconDown
                    className={`rh-scope-chev ${isOpen ? "open" : ""}`}
                    aria-hidden
                  />
                </div>
              </button>

              <div
                className={`rh-scope-collapse ${isOpen ? "open" : ""}`}
                aria-hidden={!isOpen}
              >
                <div className="rh-scope-collapse-inner">
                  <div className="rh-scope-card-body">
                    <p className="rh-scope-question">{q.question}</p>

                    {parsedOpts.length > 0 && (
                      <div
                        className="rh-opt-grid"
                        role="radiogroup"
                        aria-label={q.question}
                      >
                        {parsedOpts.map((po, optIdx) => {
                          const selected =
                            !customOpen[q.id] &&
                            matchOptionAnswer(curAns, po).matched;
                          return (
                            <button
                              key={po.raw}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              disabled={disabled}
                              tabIndex={isOpen ? 0 : -1}
                              className={`rh-opt-card ${selected ? "on" : ""}`}
                              style={
                                freshReveal && qi === 0
                                  ? ({
                                      "--rh-opt-i": Math.min(optIdx, 5),
                                    } as React.CSSProperties)
                                  : undefined
                              }
                              onClick={() => selectPresetOption(q, po)}
                            >
                              <span className="rh-opt-radio" aria-hidden>
                                {selected && <IconCheck />}
                              </span>
                              <span className="rh-opt-copy">
                                <span className="rh-opt-head-line">
                                  <b>{po.headline}</b>
                                  {po.supplement && (
                                    <i
                                      className={`rh-opt-sup-tag ${
                                        selected
                                          ? matchedDetail.trim()
                                            ? "is-filled"
                                            : "is-active"
                                          : ""
                                      }`}
                                    >
                                      {selected
                                        ? matchedDetail.trim() ||
                                          `请${po.supplement.badge}`
                                        : po.supplement.badge}
                                    </i>
                                  )}
                                </span>
                                {po.sub && <small>{po.sub}</small>}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <div className="rh-q-dock">
                      {isEditingCustom ? (
                        <div key="custom" className="rh-inline-box">
                          <span className="rh-inline-tag">
                            <IconEdit />
                            <span>
                              {parsedOpts.length > 0 ? "自由说明" : "现场说明"}
                            </span>
                          </span>
                          <input
                            ref={(el) => {
                              customInputRefs.current[q.id] = el;
                            }}
                            type="text"
                            className="rh-inline-in"
                            disabled={disabled}
                            tabIndex={isOpen ? 0 : -1}
                            value={
                              isCustomVal ||
                              customOpen[q.id] ||
                              parsedOpts.length === 0
                                ? rawAns
                                : ""
                            }
                            onChange={(e) =>
                              setAnswers((prev) => ({
                                ...prev,
                                [q.id]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (
                                e.key === "Enter" &&
                                !e.metaKey &&
                                !e.ctrlKey &&
                                !e.nativeEvent.isComposing
                              ) {
                                if (!curAns) return;
                                e.preventDefault();
                                e.stopPropagation();
                                confirmCustomEditor(q.id);
                              } else if (
                                e.key === "Escape" &&
                                parsedOpts.length > 0 &&
                                !e.nativeEvent.isComposing
                              ) {
                                e.preventDefault();
                                e.stopPropagation();
                                cancelCustomEditor(q.id, isCustomVal);
                              }
                            }}
                            placeholder="直接简述现场实际安排或特殊约束…"
                            aria-label={`${q.question} 自定义说明`}
                          />
                          <div className="rh-inline-acts">
                            {parsedOpts.length > 0 && (
                              <button
                                type="button"
                                className="rh-inline-cancel"
                                disabled={disabled}
                                tabIndex={isOpen ? 0 : -1}
                                onClick={() =>
                                  cancelCustomEditor(q.id, isCustomVal)
                                }
                              >
                                取消
                              </button>
                            )}
                            <button
                              type="button"
                              className="rh-inline-next"
                              disabled={disabled || !curAns}
                              tabIndex={isOpen ? 0 : -1}
                              onClick={() => confirmCustomEditor(q.id)}
                            >
                              <span>
                                {nextId && !expandAll ? "确认下一项" : "确认"}
                              </span>
                              {nextId && !expandAll && <IconRight />}
                            </button>
                          </div>
                        </div>
                      ) : isSavedCustom ? (
                        <div key="saved" className="rh-custom-saved">
                          <div className="rh-custom-saved-main">
                            <span className="rh-inline-tag">
                              <IconEdit />
                              <span>已填自定义</span>
                            </span>
                            <span
                              className="rh-custom-saved-text"
                              title={curAns}
                            >
                              {curAns}
                            </span>
                          </div>
                          <div className="rh-custom-saved-acts">
                            <button
                              type="button"
                              className="rh-inline-cancel"
                              disabled={disabled}
                              tabIndex={isOpen ? 0 : -1}
                              onClick={() =>
                                openCustomEditor(q.id, rawAns, false)
                              }
                            >
                              修改
                            </button>
                            <button
                              type="button"
                              className="rh-inline-cancel"
                              disabled={disabled}
                              tabIndex={isOpen ? 0 : -1}
                              onClick={() => {
                                delete prevPresetRef.current[q.id];
                                setAnswers((prev) => ({
                                  ...prev,
                                  [q.id]: "",
                                }));
                              }}
                            >
                              清除
                            </button>
                            {!expandAll && (
                              <button
                                type="button"
                                className="rh-skip-btn"
                                tabIndex={isOpen ? 0 : -1}
                                onClick={() => advanceFrom(q.id)}
                              >
                                <span>
                                  {nextId ? "继续下一项" : "完成确认"}
                                </span>
                                {nextId && <IconRight />}
                              </button>
                            )}
                          </div>
                        </div>
                      ) : hasSupplement && matchedOpt && matchedOpt.supplement ? (
                        <div
                          key="supplement"
                          className="rh-inline-box is-supplement"
                        >
                          <span className="rh-inline-tag">
                            <IconEdit />
                            <span>{matchedOpt.supplement.tag}</span>
                          </span>
                          <input
                            ref={(el) => {
                              supplementInputRefs.current[q.id] = el;
                            }}
                            type="text"
                            className="rh-inline-in"
                            disabled={disabled}
                            tabIndex={isOpen ? 0 : -1}
                            value={matchedDetail}
                            onChange={(e) =>
                              updateSupplementDetail(
                                q,
                                matchedOpt,
                                e.target.value,
                              )
                            }
                            onBlur={() =>
                              updateSupplementDetail(
                                q,
                                matchedOpt,
                                matchedDetail,
                                true,
                              )
                            }
                            onKeyDown={(e) => {
                              if (
                                e.key === "Enter" &&
                                !e.metaKey &&
                                !e.ctrlKey &&
                                !e.nativeEvent.isComposing
                              ) {
                                e.preventDefault();
                                e.stopPropagation();
                                updateSupplementDetail(
                                  q,
                                  matchedOpt,
                                  matchedDetail,
                                  true,
                                );
                                advanceFrom(q.id);
                              }
                            }}
                            placeholder={matchedOpt.supplement.placeholder}
                            aria-label={matchedOpt.supplement.tag}
                          />
                          <div className="rh-inline-acts">
                            <button
                              type="button"
                              className="rh-inline-cancel"
                              disabled={disabled}
                              tabIndex={isOpen ? 0 : -1}
                              onClick={() =>
                                openCustomEditor(q.id, rawAns, true)
                              }
                            >
                              自由说明
                            </button>
                            {!expandAll && (
                              <button
                                type="button"
                                className="rh-inline-next"
                                disabled={disabled}
                                tabIndex={isOpen ? 0 : -1}
                                onClick={() => {
                                  updateSupplementDetail(
                                    q,
                                    matchedOpt,
                                    matchedDetail,
                                    true,
                                  );
                                  advanceFrom(q.id);
                                }}
                              >
                                <span>
                                  {matchedDetail.trim()
                                    ? nextId
                                      ? "确认下一项"
                                      : "完成确认"
                                    : nextId
                                      ? "下一项"
                                      : "收起"}
                                </span>
                                {nextId && <IconRight />}
                              </button>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div key="foot" className="rh-q-foot">
                          {parsedOpts.length > 0 ? (
                            <button
                              type="button"
                              disabled={disabled}
                              tabIndex={isOpen ? 0 : -1}
                              className="rh-custom-trigger"
                              onClick={() =>
                                openCustomEditor(
                                  q.id,
                                  rawAns,
                                  matchedOptIdx >= 0,
                                )
                              }
                            >
                              <IconEdit />
                              <span>其他现场情况（自由说明）</span>
                            </button>
                          ) : (
                            <span />
                          )}

                          {!expandAll && (
                            <div className="rh-q-foot-right">
                              <button
                                type="button"
                                className="rh-skip-btn"
                                tabIndex={isOpen ? 0 : -1}
                                onClick={() => advanceFrom(q.id)}
                              >
                                <span>
                                  {isAnswered
                                    ? nextId
                                      ? "继续下一项"
                                      : "收起"
                                    : "暂不指定，按保守默认"}
                                </span>
                                {nextId && <IconRight />}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Progressive optional background note inside the deck footer */}
        <div
          className={`rh-extra-strip ${extraOpen ? "is-open" : ""}`}
          style={
            freshReveal
              ? ({
                  "--rh-stagger": Math.min(questions.length, 6),
                } as React.CSSProperties)
              : undefined
          }
        >
          {!extraOpen ? (
            <button
              type="button"
              disabled={disabled}
              className="rh-extra-trigger"
              onClick={() => setExtraOpen(true)}
            >
              <IconPlus />
              <span>补充其他现场背景说明</span>
              <small>如近期发生过主备切换、演练节点数量差异等（可选）</small>
            </button>
          ) : (
            <div className="rh-extra-editor">
              <div className="rh-extra-head">
                <label
                  className="rh-field-label"
                  htmlFor={`extra-${rehearsalId}`}
                >
                  补充现场背景 <span className="faint">（可选）</span>
                </label>
                {!extraScope.trim() && (
                  <button
                    type="button"
                    className="rh-inline-cancel"
                    onClick={() => setExtraOpen(false)}
                  >
                    收起
                  </button>
                )}
              </div>
              <Input.TextArea
                id={`extra-${rehearsalId}`}
                value={extraScope}
                disabled={disabled}
                onChange={setExtraScope}
                autoSize={{ minRows: 2, maxRows: 5 }}
                placeholder="例如：生产近期发生过一次主备切换；测试环境为 2 台同系统虚拟机…"
                aria-label="补充约束说明"
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ---------- Stage 2: Structured Probe Execution Kit ---------- */

type ProbeNoteTone = "exec" | "auth" | "conn" | "judge";

type ParsedProbeNote = {
  raw: string;
  tone: ProbeNoteTone;
  tag: string;
  priority: number;
  headline: string;
  detail: string;
};

function parseProbeNote(raw: string): ParsedProbeNote {
  const clean = (raw || "").trim().replace(/^[-*•\d.、)）\s]+/, "");
  let tone: ProbeNoteTone = "exec";
  let tag = "执行要点";
  let priority = 0;

  if (
    /认证|密码|口令|凭据|密钥|AUTH\b|TOKEN\b|_USER\b|ACL\b|脱敏|bash\s+-x|不要把密码|勿写/i.test(
      clean,
    )
  ) {
    tone = "auth";
    tag = "凭据与安全";
    priority = 0;
  } else if (
    /连接本机|默认.*连接|127\.0\.0\.1|localhost|:\d{4,5}\b|TLS\b|SSL\b|监控名|mymaster|socket|非默认端口/i.test(
      clean,
    )
  ) {
    tone = "conn";
    tag = "连接与端口";
    priority = 0;
  } else if (
    /分别使用|节点.*执行|执行脚本|运行脚本|同一时间段|任意.*节点|每台节点|不生成任何文件|终端输出|截图反馈/i.test(
      clean,
    )
  ) {
    tone = "exec";
    tag = "执行范围";
    priority = 0;
  } else if (
    /持久化|appendonly|aof_|save=|maxmemory|内存|磁盘|容量|字节|RDB/i.test(clean)
  ) {
    tone = "judge";
    tag = "基线核对";
    priority = 1;
  } else if (
    /主从|主库|从库|漂移|Sentinel|哨兵|quorum|CKQUORUM|s_down|o_down|复制|lag|Leader|Follower|Patroni/i.test(
      clean,
    )
  ) {
    tone = "judge";
    tag = "拓扑判据";
    priority = 1;
  }

  let headline = clean;
  let detail = "";
  const periodIdx = clean.indexOf("。");
  if (periodIdx >= 8 && periodIdx < clean.length - 1) {
    headline = clean.slice(0, periodIdx).trim();
    detail = clean.slice(periodIdx + 1).trim();
  } else {
    const semiIdx = clean.indexOf("；");
    if (semiIdx >= 10 && semiIdx < clean.length - 1) {
      headline = clean.slice(0, semiIdx).trim();
      detail = clean.slice(semiIdx + 1).trim();
    }
  }

  return { raw: clean, tone, tag, priority, headline, detail };
}

function renderProbeInline(text: string): React.ReactNode {
  if (!text) return null;
  const tokenRe =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\bbash\s+-[a-zA-Z]+\b|\bCONFIG\s+GET\b|\bINFO\s+[a-z_]+\b|[A-Za-z_][\w.-]*=[^\s，。；、：（）()"`]+|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\bCKQUORUM\b|\bmymaster\b|\b[a-z]+_[a-z0-9_]+(?:\/[a-z]+_[a-z0-9_]+)*(?:\/disconnected)?\b|\bnode-\d+(?:\/node-\d+)*\b|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b|\bv?\d+\.\d+\.\d+(?:-[a-zA-Z0-9._-]+)?\b|\/(?:etc|var|opt|usr|data|tmp|home|root|srv|proc|sys|dev|run|mnt)(?:\/[a-zA-Z0-9_.*-]+)*)/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const start = m.index;
    const rawTok = m[0];
    const prevCh = start > 0 ? text[start - 1] : "";
    if (rawTok.startsWith("/") && /[\w:/]/.test(prevCh)) {
      continue;
    }
    if (start > last) {
      out.push(text.slice(last, start));
    }
    if (rawTok.startsWith("`") && rawTok.endsWith("`")) {
      out.push(
        <code key={k++} className="rh-think-code mono">
          {rawTok.slice(1, -1)}
        </code>,
      );
    } else if (rawTok.startsWith("**") && rawTok.endsWith("**")) {
      out.push(
        <strong key={k++} className="rh-think-strong">
          {renderProbeInline(rawTok.slice(2, -2))}
        </strong>,
      );
    } else {
      let cleanTok = rawTok;
      let trailing = "";
      const punct = /[.,;:!?)]+$/.exec(cleanTok);
      if (punct) {
        cleanTok = cleanTok.slice(0, -punct[0].length);
        trailing = punct[0];
      }
      if (cleanTok) {
        out.push(
          <code key={k++} className="rh-think-code mono">
            {cleanTok}
          </code>,
        );
      }
      if (trailing) out.push(trailing);
    }
    last = start + rawTok.length;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out.length === 1 && typeof out[0] === "string" ? out[0] : out;
}

function ProbeExecutionKit({
  script,
  fileName,
  probeSafe,
  warnings,
  notes,
  hasEchoInput,
  onDownload,
}: {
  script: string;
  fileName: string;
  probeSafe: boolean;
  warnings: string[];
  notes: string[];
  hasEchoInput: boolean;
  onDownload: () => void;
}) {
  const [codeOpen, setCodeOpen] = useState(() => !probeSafe);
  const [moreNotesOpen, setMoreNotesOpen] = useState(false);

  const lineCount = useMemo(() => {
    if (!script) return 0;
    return script.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
  }, [script]);

  const { primaryNotes, extraNotes } = useMemo(() => {
    const parsed = notes
      .map((n, idx) => ({ item: parseProbeNote(n), idx }))
      .sort((a, b) => a.item.priority - b.item.priority || a.idx - b.idx)
      .map((x) => x.item);

    const execOnes = parsed.filter((x) => x.priority === 0);
    if (parsed.length <= 4) {
      return { primaryNotes: parsed, extraNotes: [] as ParsedProbeNote[] };
    }
    const splitCount =
      execOnes.length >= 2 && execOnes.length <= 4 ? execOnes.length : 3;
    return {
      primaryNotes: parsed.slice(0, splitCount),
      extraNotes: parsed.slice(splitCount),
    };
  }, [notes]);

  const shownNotes = moreNotesOpen
    ? [...primaryNotes, ...extraNotes]
    : primaryNotes;

  return (
    <div className={`rh-probe-kit ${!probeSafe ? "has-warn" : ""}`}>
      <div className="rh-probe-kit-bar">
        <div className="rh-probe-kit-left">
          <span
            className={`rh-step-num-badge num ${hasEchoInput ? "is-done" : ""}`}
            aria-hidden
          >
            {hasEchoInput ? <IconCheck /> : 1}
          </span>
          <div className="rh-probe-kit-titles">
            <div className="rh-probe-kit-row">
              <b>在生产节点运行只读采集探针</b>
              <span className={`rh-shield-pill ${probeSafe ? "ok" : "warn"}`}>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M10 2.5L4 5v4.6c0 3.8 2.5 6.9 6 7.9 3.5-1 6-4.1 6-7.9V5l-6-2.5z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinejoin="round"
                  />
                  {probeSafe && (
                    <path
                      d="M7.4 10l1.8 1.8 3.5-3.6"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                </svg>
                {probeSafe ? "纯只读校验通过" : "请人工复核只读性"}
              </span>
              {script && (
                <span className="rh-probe-file-chip mono">
                  {fileName} · {lineCount} 行
                </span>
              )}
            </div>
          </div>
        </div>

        {script && (
          <div className="rh-probe-kit-acts">
            <CopyCodeBtn
              text={script}
              label="复制采集脚本"
              className="is-primary-ctl"
            />
            <button
              type="button"
              className="rh-kit-btn"
              onClick={onDownload}
            >
              <IconDownload />
              <span>下载 .sh</span>
            </button>
            <button
              type="button"
              className={`rh-kit-btn is-ghost ${codeOpen ? "is-open" : ""}`}
              aria-expanded={codeOpen}
              onClick={() => setCodeOpen((v) => !v)}
            >
              <span>{codeOpen ? "收起源码" : "查看脚本"}</span>
              <IconDown className={`rh-kit-chev ${codeOpen ? "open" : ""}`} />
            </button>
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="rh-callout warn rh-kit-warn" role="alert">
          {warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      {shownNotes.length > 0 && (
        <div className="rh-probe-notes-wrap">
          <div
            className={`rh-probe-notes-grid ${shownNotes.length === 1 ? "is-single" : ""}`}
          >
            {shownNotes.map((n, i) => (
              <div key={i} className={`rh-pnote-card is-${n.tone}`}>
                <div className="rh-pnote-top">
                  <span className={`rh-pnote-tag is-${n.tone}`}>{n.tag}</span>
                  <span className="rh-pnote-head">
                    {renderProbeInline(n.headline)}
                  </span>
                </div>
                {n.detail && (
                  <p className="rh-pnote-sub">{renderProbeInline(n.detail)}</p>
                )}
              </div>
            ))}
          </div>

          {extraNotes.length > 0 && (
            <button
              type="button"
              className="rh-notes-more-btn"
              onClick={() => setMoreNotesOpen((v) => !v)}
            >
              <span>
                {moreNotesOpen
                  ? "收起补充核查判据"
                  : `展开其余 ${extraNotes.length} 条采集核查判据`}
              </span>
              <IconDown
                className={`rh-kit-chev ${moreNotesOpen ? "open" : ""}`}
              />
            </button>
          )}
        </div>
      )}

      {script && (
        <div
          className={`rh-scope-collapse ${codeOpen ? "open" : ""}`}
          aria-hidden={!codeOpen}
        >
          <div className="rh-scope-collapse-inner">
            <div className="rh-kit-code-drawer">
              <ShellCodeBlock
                code={script}
                title={fileName}
                copyLabel="复制脚本"
                onDownload={onDownload}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Session Detail View ---------- */

function RehearsalSessionView({
  c,
  id,
  initialSession,
  autoExpandCreateTrace = false,
  offline,
  noVision,
  pick,
  aiOpts,
  onListChanged,
  onEngageFocus,
}: {
  c: ClusterView;
  id: string;
  initialSession?: ChangeRehearsal;
  autoExpandCreateTrace?: boolean;
  offline: boolean;
  noVision: boolean;
  pick: ReturnType<typeof useModelPick>;
  aiOpts: ReturnType<typeof useAIOptions>;
  onListChanged: () => Promise<void>;
  onEngageFocus?: () => void;
}) {
  const [r, setR] = useState<ChangeRehearsal | null>(
    () => initialSession || null,
  );
  const [loadErr, setLoadErr] = useState("");
  const [viewStage, setViewStage] = useState<ChangeRehearsal["stage"]>(
    () => initialSession?.stage || "scoping",
  );
  const [stageDir, setStageDir] = useState<"fwd" | "back">("fwd");
  const [stageAnimated, setStageAnimated] = useState(false);
  const [loading, setLoading] = useState(() => !initialSession);
  const [busyFinalize, setBusyFinalize] = useState(false);

  // Live streaming states for Stage 1 -> 2 and Stage 2 -> 3
  const [liveScope, setLiveScope] = useState<LiveAIState | null>(null);
  const [liveProbe, setLiveProbe] = useState<LiveAIState | null>(null);
  const [freshTraceStage, setFreshTraceStage] = useState<string>(
    autoExpandCreateTrace ? "create" : "",
  );
  const abortRef = useRef<AbortController | null>(null);

  // Stage bar spring indicator
  const stageNavRef = useRef<HTMLElement | null>(null);
  const [stageThumb, setStageThumb] = useState<{ x: number; w: number } | null>(
    null,
  );

  // Step 1 state
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    (initialSession?.scope_questions || []).forEach((q) => {
      if (q.answer) init[q.id] = q.answer;
    });
    return init;
  });
  const [extraScope, setExtraScope] = useState(
    () => initialSession?.extra_scope || "",
  );

  // Step 2 state
  const [probeMode, setProbeMode] = useState<"paste" | "manual">(() =>
    initialSession?.manual_state && !initialSession?.probe_output
      ? "manual"
      : "paste",
  );
  const [probeOut, setProbeOut] = useState(
    () => initialSession?.probe_output || "",
  );
  const [probeImages, setProbeImages] = useState<DraftImage[]>([]);
  const [dragProbe, setDragProbe] = useState(false);
  const [manualState, setManualState] = useState(
    () => initialSession?.manual_state || "",
  );
  const [testEnvNote, setTestEnvNote] = useState(
    () => initialSession?.test_env_note || "",
  );
  const [testEnvOpen, setTestEnvOpen] = useState(() =>
    Boolean(initialSession?.test_env_note?.trim()),
  );
  const probeImgInputRef = useRef<HTMLInputElement | null>(null);

  // Step 3 state
  const [phaseFilter, setPhaseFilter] = useState<string>("all");

  const switchStage = (
    next: ChangeRehearsal["stage"],
    isAutoReveal = false,
  ) => {
    if (!isAutoReveal) setFreshTraceStage("");
    if (next === viewStage) return;
    const a = STAGE_ORDER.indexOf(viewStage);
    const b = STAGE_ORDER.indexOf(next);
    setStageDir(b >= a ? "fwd" : "back");
    setStageAnimated(!isAutoReveal);
    setViewStage(next);
  };

  useEffect(() => {
    if (r) putCached(rehearsalItemPath(c.id, r.id), r);
  }, [c.id, r]);

  const load = async (syncStage = false) => {
    setLoadErr("");
    try {
      const data = await api<ChangeRehearsal>(
        rehearsalItemPath(c.id, id),
      );
      putCached(rehearsalItemPath(c.id, id), data);
      setR(data);
      if (syncStage) setViewStage(data.stage);
      const initAns: Record<string, string> = {};
      (data.scope_questions || []).forEach((q) => {
        if (q.answer) initAns[q.id] = q.answer;
      });
      setAnswers((prev) => ({ ...initAns, ...prev }));
      if (data.extra_scope) setExtraScope((ex) => ex || data.extra_scope || "");
      if (data.probe_output) setProbeOut((p) => p || data.probe_output || "");
      if (data.manual_state) {
        setManualState((m) => m || data.manual_state || "");
        if (!data.probe_output) setProbeMode("manual");
      }
      if (data.test_env_note) {
        setTestEnvNote((t) => t || data.test_env_note || "");
        setTestEnvOpen(true);
      }
    } catch (e) {
      setLoadErr((e as Error).message || "读取失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialSession && initialSession.id === id) {
      setLoading(false);
      if (!autoExpandCreateTrace) {
        void load(false);
      }
      return;
    }
    setLoading(true);
    void load(true);
  }, [c.id, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const curIdx = STAGE_ORDER.indexOf(viewStage);

  useLayoutEffect(() => {
    const el = stageNavRef.current;
    if (!el || loading || !r) return;
    const measure = () => {
      const btn =
        el.querySelectorAll<HTMLButtonElement>("button.rh-stage-btn")[curIdx];
      setStageThumb(
        btn ? { x: btn.offsetLeft, w: btn.offsetWidth } : null,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [curIdx, loading, r?.stage, r?.steps?.length]);

  const attachProbeFiles = async (files: FileList | File[]) => {
    const all = Array.from(files);
    const imgFiles = all.filter((f) => f.type.startsWith("image/"));
    const txtFiles = all.filter(
      (f) =>
        !f.type.startsWith("image/") &&
        (/\.(log|txt|out|json|conf|yaml|yml)$/i.test(f.name) ||
          f.type.startsWith("text/")),
    );

    for (const tf of txtFiles.slice(0, 1)) {
      if (tf.size > 2 * 1024 * 1024) {
        Message.warning("回显文本文件请控制在 2 MiB 以内");
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setProbeMode("paste");
        setProbeOut(String(reader.result || ""));
        Message.success(`已载入 ${tf.name}`);
      };
      reader.readAsText(tf);
    }

    if (!imgFiles.length) return;
    if (noVision) {
      Message.warning(
        "当前所选模型不支持识别截图，请粘贴文字回显或在下方切换支持看图的模型",
      );
      return;
    }
    const room = MAX_IMAGES - probeImages.length;
    if (room <= 0) {
      Message.warning(`单次最多上传 ${MAX_IMAGES} 张回显截图`);
      return;
    }
    const added: DraftImage[] = [];
    for (const f of imgFiles.slice(0, room)) {
      try {
        added.push(await prepareDraftImage(f));
      } catch (e) {
        err(e);
      }
    }
    if (added.length > 0) {
      setProbeImages((prev) => [...prev, ...added]);
      Message.success(`已添加 ${added.length} 张回显截图`);
    }
  };

  if (loading) {
    return (
      <div className="rh-skel">
        <Skeleton
          animation
          text={{
            rows: 7,
            width: ["48%", "100%", "90%", "84%", "92%", "70%", "40%"],
          }}
        />
      </div>
    );
  }

  if (loadErr || !r) {
    return (
      <div className="rh-state" role="alert">
        <IconExclamationCircle className="bad" />
        <b>无法打开该演练记录</b>
        <p className="muted small">{loadErr || "记录不存在或已被删除"}</p>
        <div className="row-gap">
          <Button icon={<IconRefresh />} onClick={() => void load(true)}>
            重试
          </Button>
          <Button
            onClick={() =>
              go(
                { name: "deliveries", id: c.id, tab: "rehearsal" },
                { replace: true },
              )
            }
          >
            返回演练列表
          </Button>
        </div>
      </div>
    );
  }

  const maxIdx = STAGE_ORDER.indexOf(r.stage);
  const scopeBusy = Boolean(liveScope && !liveScope.error);
  const probeBusy = Boolean(liveProbe && !liveProbe.error);

  const submitScope = async () => {
    if (offline || scopeBusy) return;
    onEngageFocus?.();
    const ac = new AbortController();
    abortRef.current = ac;
    const effortVal = pick.current?.effort?.includes(aiOpts.pref.think)
      ? aiOpts.pref.think
      : undefined;
    setLiveScope(
      createInitialLiveState(
        "scope",
        "AI 正在定制生产只读采集探针",
        "正在锁定只读安全红线并建立模型连接…",
        pick.current,
      ),
    );
    try {
      const payload = {
        answers: (r.scope_questions || []).map((q) => ({
          id: q.id,
          question: q.question,
          answer: (answers[q.id] || "").trim(),
        })),
        extra: extraScope.trim(),
        model: pick.ref || undefined,
        effort: effortVal,
      };
      const next = await streamRehearsalAPI(
        `/api/clusters/${encodeURIComponent(c.id)}/rehearsals/${encodeURIComponent(r.id)}/scope`,
        payload,
        (updater) => setLiveScope((prev) => (prev ? updater(prev) : prev)),
        ac.signal,
      );
      setLiveScope(null);
      setR(next);
      setFreshTraceStage("scope");
      switchStage(next.stage, true);
      void onListChanged();
      Message.success("已生成只读状态采集脚本并通过静态安全扫描");
    } catch (e) {
      if (ac.signal.aborted) {
        setLiveScope(null);
      } else {
        setLiveScope((prev) => (prev ? markLiveStateError(prev, e) : null));
      }
    } finally {
      abortRef.current = null;
    }
  };

  const submitProbe = async () => {
    if (offline || probeBusy) return;
    onEngageFocus?.();
    const ac = new AbortController();
    abortRef.current = ac;
    const effortVal = pick.current?.effort?.includes(aiOpts.pref.think)
      ? aiOpts.pref.think
      : undefined;
    setLiveProbe(
      createInitialLiveState(
        "probe",
        "AI 正在比对现场漂移并编排演练步骤",
        "正在脱敏现场证据并建立模型连接…",
        pick.current,
      ),
    );
    try {
      const imgs =
        probeImages.length > 0
          ? probeImages.map((im) => im.dataUrl)
          : undefined;
      const modelRef = pick.ref || undefined;
      const payload =
        probeMode === "paste"
          ? {
              probe_output: probeOut,
              test_env_note: testEnvNote,
              images: imgs,
              model: modelRef,
              effort: effortVal,
            }
          : {
              manual_state: manualState,
              test_env_note: testEnvNote,
              images: imgs,
              model: modelRef,
              effort: effortVal,
            };
      const next = await streamRehearsalAPI(
        `/api/clusters/${encodeURIComponent(c.id)}/rehearsals/${encodeURIComponent(r.id)}/probe`,
        payload,
        (updater) => setLiveProbe((prev) => (prev ? updater(prev) : prev)),
        ac.signal,
      );
      setLiveProbe(null);
      setR(next);
      setProbeImages([]);
      setFreshTraceStage("probe");
      switchStage(next.stage, true);
      void onListChanged();
      Message.success("已完成漂移分析并生成测试演练步骤");
    } catch (e) {
      if (ac.signal.aborted) {
        setLiveProbe(null);
      } else {
        setLiveProbe((prev) => (prev ? markLiveStateError(prev, e) : null));
      }
    } finally {
      abortRef.current = null;
    }
  };

  const finalizeSOP = async () => {
    if (offline) return;
    setBusyFinalize(true);
    try {
      const next = await api<ChangeRehearsal>(
        `/api/clusters/${encodeURIComponent(c.id)}/rehearsals/${encodeURIComponent(r.id)}/finalize`,
        {
          method: "POST",
          body: JSON.stringify({ test_env_note: testEnvNote }),
        },
      );
      setR(next);
      setFreshTraceStage("finalized");
      switchStage("finalized", true);
      void onListChanged();
      Message.success("《生产变更实施方案》已存入集群文档");
    } catch (e) {
      err(e);
    } finally {
      setBusyFinalize(false);
    }
  };

  const removeSession = async () => {
    try {
      await api(
        `/api/clusters/${encodeURIComponent(c.id)}/rehearsals/${encodeURIComponent(r.id)}`,
        { method: "DELETE" },
      );
      Message.success("已删除演练记录");
      await onListChanged();
      go(
        { name: "deliveries", id: c.id, tab: "rehearsal" },
        { replace: true },
      );
    } catch (e) {
      err(e);
    }
  };

  const downloadProbe = () => {
    if (!r.probe_script) return;
    const blob = new Blob([r.probe_script], { type: "text/x-shellscript" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `collect-${c.id}-${r.id.slice(0, 6)}.sh`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const steps = r.steps || [];
  const requiredSteps = steps.filter(
    (s) => !s.optional && s.phase !== "rollback",
  );
  const doneRequired = requiredSteps.filter(
    (s) => s.status === "passed" || s.status === "skipped",
  ).length;
  const gateReady =
    requiredSteps.length > 0 && doneRequired === requiredSteps.length;
  const progressPct =
    requiredSteps.length > 0
      ? Math.round((doneRequired / requiredSteps.length) * 100)
      : 0;
  const totalRevisions = steps.reduce(
    (sum, s) => sum + (s.revisions?.length || 0),
    0,
  );

  const shownSteps =
    phaseFilter === "all"
      ? steps
      : steps.filter((s) => s.phase === phaseFilter);

  const probeFileName = `collect-${c.id}-${r.id.slice(0, 6)}.sh`;
  const hasProbeInput =
    probeImages.length > 0 ||
    (probeMode === "paste" ? Boolean(probeOut.trim()) : Boolean(manualState.trim()));

  const isFreshCreate = freshTraceStage === "create" && curIdx === 0;
  const isFreshScope = freshTraceStage === "scope" && curIdx === 1;
  const isFreshProbe = freshTraceStage === "probe" && curIdx === 2;
  const isFreshFinal = freshTraceStage === "finalized" && curIdx === 3;

  return (
    <div className={`rh-session${isFreshCreate ? " is-fresh-session" : ""}`}>
      <header className="rh-shead">
        <div className="rh-shead-main">
          <div className="rh-shead-title">
            <h2>{r.title}</h2>
            <span className="faint small">更新于 {ago(r.updated_at)}</span>
          </div>
          <p className="rh-shead-goal">{renderThinkingInline(r.goal)}</p>
          {r.scope_summary && r.scope_summary.trim() !== r.goal.trim() && (
            <div className="rh-shead-summary">
              <span className="rh-shead-sum-tag">收敛边界</span>
              <span className="rh-shead-sum-txt">
                {renderThinkingInline(r.scope_summary)}
              </span>
            </div>
          )}
          {r.goal_images && r.goal_images.length > 0 && (
            <SavedImageGallery
              clusterId={c.id}
              rehearsalId={r.id}
              names={r.goal_images}
              label="诉求参考截图"
            />
          )}
        </div>
        <Popconfirm
          position="br"
          title={`确认删除演练「${r.title}」？`}
          content="已定稿的实施方案仍会保留在集群文档中。"
          okText="删除"
          okButtonProps={{ status: "danger" }}
          onOk={removeSession}
        >
          <Button
            size="small"
            type="text"
            status="danger"
            icon={<IconDelete />}
            aria-label="删除演练"
          >
            删除
          </Button>
        </Popconfirm>
      </header>

      <nav
        className="rh-stages"
        ref={stageNavRef}
        aria-label="变更演练阶段"
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const unlocked = STAGE_ORDER.filter((_, idx) => idx <= maxIdx);
          const pos = unlocked.indexOf(viewStage);
          if (pos < 0) return;
          e.preventDefault();
          const next =
            unlocked[
              (pos + (e.key === "ArrowRight" ? 1 : unlocked.length - 1)) %
                unlocked.length
            ];
          switchStage(next);
        }}
      >
        {stageThumb && (
          <span
            className="rh-stages-thumb"
            style={{
              transform: `translateX(${stageThumb.x}px)`,
              width: stageThumb.w,
            }}
            aria-hidden
          />
        )}
        {STAGE_ORDER.map((st, idx) => {
          const unlocked = idx <= maxIdx;
          const isDone = idx < maxIdx || r.stage === "finalized";
          const active = viewStage === st;
          return (
            <button
              key={st}
              type="button"
              disabled={!unlocked}
              aria-current={active ? "step" : undefined}
              className={`rh-stage-btn ${active ? "on" : ""} ${isDone ? "done" : ""}`}
              onClick={() => unlocked && switchStage(st)}
            >
              <span className="rh-stage-num num">
                {isDone && !active ? <IconCheck /> : idx + 1}
              </span>
              <span className="rh-stage-txt">
                <b>{STAGE_META[st].short}</b>
                <small>
                  {st === "rehearsing" && requiredSteps.length > 0
                    ? `必测 ${doneRequired}/${requiredSteps.length}`
                    : STAGE_META[st].sub}
                </small>
              </span>
            </button>
          );
        })}
      </nav>

      <div
        key={viewStage}
        className={`rh-stage-body${stageAnimated ? ` rh-anim-${stageDir}` : ""}`}
      >
        {/* ---- Stage 1: Scoping ---- */}
        {curIdx === 0 && (
          <section
            className={`rh-sec${isFreshCreate ? " is-fresh-reveal" : ""}`}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submitScope();
              }
            }}
          >
            {r.traces?.create && (
              <RehearsalAIProcess
                trace={r.traces.create}
                title="AI 诉求研判与边界分析过程"
                defaultOpen={freshTraceStage === "create"}
              />
            )}

            <ScopeAlignmentDeck
              rehearsalId={r.id}
              questions={r.scope_questions || []}
              answers={answers}
              setAnswers={setAnswers}
              extraScope={extraScope}
              setExtraScope={setExtraScope}
              disabled={scopeBusy}
              freshReveal={isFreshCreate}
              baselineVersion={c.version}
            />

            {liveScope && (
              <RehearsalAIProcess
                live={liveScope}
                title={liveScope.title}
                onAbort={() => abortRef.current?.abort()}
                onRetry={() => void submitScope()}
                onDismiss={() => setLiveScope(null)}
              />
            )}

            <div className="rh-sec-foot">
              <div className="rh-sec-foot-tools">
                <ThinkLevel
                  levels={pick.current?.effort}
                  value={aiOpts.pref.think}
                  onChange={(v) => aiOpts.update({ think: v })}
                />
                <ModelPicker pick={pick} compact />
                <span className="rh-foot-note">
                  仅生成静态只读采集命令，零重启与写操作
                </span>
              </div>
              <div className="rh-compose-submit">
                <Button
                  type="primary"
                  shape="round"
                  className={`ai-pill ${!offline ? "ai-pill-primary" : ""}`}
                  icon={<Spark size={14} rainbow={offline} />}
                  title={isMac ? "⌘ + Enter 提交" : "Ctrl + Enter 提交"}
                  loading={scopeBusy}
                  disabled={offline}
                  onClick={() => void submitScope()}
                >
                  {r.probe_script ? "重新生成只读探针" : "生成只读采集脚本"}
                </Button>
              </div>
            </div>
          </section>
        )}

        {/* ---- Stage 2: Read-Only Probing ---- */}
        {curIdx === 1 && (
          <section
            className={`rh-sec rh-probe-stage${isFreshScope ? " is-fresh-reveal" : ""}`}
            onKeyDown={(e) => {
              if (
                (e.metaKey || e.ctrlKey) &&
                e.key === "Enter" &&
                hasProbeInput &&
                !offline &&
                !probeBusy
              ) {
                e.preventDefault();
                void submitProbe();
              }
            }}
          >
            {r.traces?.scope && (
              <RehearsalAIProcess
                trace={r.traces.scope}
                title="AI 只读探针设计与安全扫描过程"
                defaultOpen={false}
              />
            )}

            <ProbeExecutionKit
              script={r.probe_script || ""}
              fileName={probeFileName}
              probeSafe={r.probe_safe !== false}
              warnings={r.probe_warnings || []}
              notes={r.probe_notes || []}
              hasEchoInput={hasProbeInput}
              onDownload={downloadProbe}
            />

            <div className="rh-echo-workspace">
              <div className="rh-echo-ws-head">
                <div className="rh-echo-ws-left">
                  <span
                    className={`rh-step-num-badge is-active num ${hasProbeInput ? "is-done" : ""}`}
                    aria-hidden
                  >
                    {hasProbeInput ? <IconCheck /> : 2}
                  </span>
                  <div className="rh-echo-ws-titles">
                    <b>回填现场采集结果</b>
                    <span
                      className={`rh-echo-status-pill ${hasProbeInput ? "is-ready" : ""}`}
                    >
                      {hasProbeInput
                        ? probeMode === "paste" && probeOut.trim()
                          ? `已录入 ${probeOut.trim().split("\n").length} 行回显${probeImages.length > 0 ? ` · ${probeImages.length} 张截图` : ""}`
                          : probeImages.length > 0
                            ? `已添加 ${probeImages.length} 张终端截图`
                            : "已填写现状说明"
                        : "当前核心操作 · 粘贴回显或终端截图"}
                    </span>
                  </div>
                </div>
                <span className="rh-safety-note">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M10 2.5L4 5v4.6c0 3.8 2.5 6.9 6 7.9 3.5-1 6-4.1 6-7.9V5l-6-2.5z"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>口令与密钥自动二次脱敏 · 识别主从与参数漂移</span>
                </span>
              </div>

              <div className="rh-probe-input">
                <div
                  className={`rh-probe-box is-focal ${offline ? "off" : ""} ${dragProbe ? "is-drag" : ""} ${probeBusy ? "is-busy" : ""}`}
                  onDragOver={(e) => {
                    if (e.dataTransfer?.types?.includes("Files")) {
                      e.preventDefault();
                      setDragProbe(true);
                    }
                  }}
                  onDragLeave={() => setDragProbe(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragProbe(false);
                    if (e.dataTransfer?.files?.length) {
                      void attachProbeFiles(e.dataTransfer.files);
                    }
                  }}
                  onPaste={(e) => {
                    const imgs = extractClipboardImageFiles(e);
                    if (imgs.length > 0) {
                      if (!e.clipboardData?.getData("text/plain")) {
                        e.preventDefault();
                      }
                      void attachProbeFiles(imgs);
                    }
                  }}
                >
                  <div className="rh-probe-head">
                    <Segmented<"paste" | "manual">
                      size="sm"
                      label="录入现场状态方式"
                      value={probeMode}
                      onChange={setProbeMode}
                      options={[
                        { value: "paste", label: "粘贴回显或截图" },
                        { value: "manual", label: "手动说明现状" },
                      ]}
                    />
                    <div className="rh-probe-upload-btns">
                      <input
                        ref={probeImgInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        multiple
                        hidden
                        onChange={(e) => {
                          if (e.target.files?.length) {
                            void attachProbeFiles(e.target.files);
                          }
                          e.target.value = "";
                        }}
                      />
                      <button
                        type="button"
                        className="rh-attach-btn is-sm"
                        disabled={probeBusy || noVision}
                        title={
                          noVision
                            ? "当前所选模型不支持图片识别，可在下方切换支持看图的模型"
                            : "上传或直接 Ctrl+V 粘贴回显截图"
                        }
                        onClick={() => probeImgInputRef.current?.click()}
                      >
                        <IconImage />
                        <span>上传回显截图</span>
                      </button>
                      {probeMode === "paste" && (
                        <Upload
                          accept=".log,.txt,.out,.json"
                          showUploadList={false}
                          disabled={probeBusy}
                          beforeUpload={(file) => {
                            void attachProbeFiles([file]);
                            return false;
                          }}
                        >
                          <button
                            type="button"
                            className="rh-attach-btn is-sm"
                            disabled={probeBusy}
                          >
                            <IconUpload />
                            <span>上传 .log / .txt</span>
                          </button>
                        </Upload>
                      )}
                      {(probeMode === "paste"
                        ? Boolean(probeOut.trim())
                        : Boolean(manualState.trim())) && (
                        <button
                          type="button"
                          className="rh-inline-cancel"
                          disabled={probeBusy}
                          onClick={() =>
                            probeMode === "paste"
                              ? setProbeOut("")
                              : setManualState("")
                          }
                        >
                          清空文本
                        </button>
                      )}
                    </div>
                  </div>

                  {probeMode === "paste" ? (
                    <Input.TextArea
                      value={probeOut}
                      disabled={probeBusy}
                      onChange={setProbeOut}
                      autoSize={{ minRows: 9, maxRows: 20 }}
                      className="mono rh-echo-area"
                      placeholder="将生产节点执行采集脚本后的终端回显粘贴至此（多台节点输出可直接合并粘贴），或直接按 Ctrl+V 粘贴堡垒机/终端截图…"
                      aria-label="探针回显输出"
                    />
                  ) : (
                    <Input.TextArea
                      value={manualState}
                      disabled={probeBusy}
                      onChange={setManualState}
                      autoSize={{ minRows: 8, maxRows: 16 }}
                      placeholder="简述生产集群当前真实拓扑、版本号与配置现状（也可配合 Ctrl+V 粘贴监控或终端截图），例如：目前 node-2 为主节点，node-1 / node-3 为从节点；当前版本 7.2.4…"
                      aria-label="手动说明生产现状"
                    />
                  )}

                  {probeImages.length > 0 && (
                    <div className="rh-compose-imgs">
                      <DraftImageStrip
                        images={probeImages}
                        onRemove={(imgId) =>
                          setProbeImages((prev) =>
                            prev.filter((x) => x.id !== imgId),
                          )
                        }
                      />
                    </div>
                  )}

                  {(testEnvOpen || Boolean(testEnvNote.trim())) && (
                    <div className="rh-probe-tenv-inline">
                      <div className="rh-extra-head">
                        <label
                          className="rh-field-label"
                          htmlFor={`tenv-${r.id}`}
                        >
                          测试演练环境节点映射{" "}
                          <span className="faint">（可选）</span>
                        </label>
                        {!testEnvNote.trim() && (
                          <button
                            type="button"
                            className="rh-inline-cancel"
                            onClick={() => setTestEnvOpen(false)}
                          >
                            收起
                          </button>
                        )}
                      </div>
                      <Input
                        id={`tenv-${r.id}`}
                        value={testEnvNote}
                        disabled={probeBusy}
                        onChange={setTestEnvNote}
                        placeholder="例如：测试环境机器为 192.168.56.11~13，操作系统及架构与生产一致"
                        aria-label="测试环境说明"
                      />
                    </div>
                  )}

                  <div className="rh-compose-foot rh-probe-foot">
                    <div className="rh-compose-tools">
                      {!testEnvOpen && !testEnvNote.trim() && (
                        <button
                          type="button"
                          disabled={probeBusy}
                          className="rh-attach-btn is-sm"
                          onClick={() => setTestEnvOpen(true)}
                        >
                          <IconPlus />
                          <span>映射测试演练节点（可选）</span>
                        </button>
                      )}
                      <span className="rh-foot-note">
                        {isMac ? "⌘ + Enter 提交分析" : "Ctrl + Enter 提交分析"}
                      </span>
                    </div>
                    <div className="rh-compose-submit">
                      <ThinkLevel
                        levels={pick.current?.effort}
                        value={aiOpts.pref.think}
                        onChange={(v) => aiOpts.update({ think: v })}
                      />
                      <ModelPicker pick={pick} compact />
                      <Button
                        type="primary"
                        shape="round"
                        className={`ai-pill ${hasProbeInput && !offline ? "ai-pill-primary" : ""}`}
                        icon={
                          <Spark
                            size={14}
                            rainbow={offline || !hasProbeInput}
                          />
                        }
                        title={isMac ? "⌘ + Enter 提交" : "Ctrl + Enter 提交"}
                        loading={probeBusy}
                        disabled={offline || !hasProbeInput}
                        onClick={() => void submitProbe()}
                      >
                        识别漂移并生成演练步骤
                      </Button>
                    </div>
                  </div>
                </div>

                {r.probe_images && r.probe_images.length > 0 && (
                  <SavedImageGallery
                    clusterId={c.id}
                    rehearsalId={r.id}
                    names={r.probe_images}
                    label="已归档现场回显截图"
                  />
                )}
              </div>
            </div>

            {liveProbe && (
              <RehearsalAIProcess
                live={liveProbe}
                title={liveProbe.title}
                onAbort={() => abortRef.current?.abort()}
                onRetry={() => void submitProbe()}
                onDismiss={() => setLiveProbe(null)}
              />
            )}
          </section>
        )}

        {/* ---- Stage 3: Test Rehearsal ---- */}
        {curIdx === 2 && (
          <div className={`rh-rehearse-wrap${isFreshProbe ? " is-fresh-reveal" : ""}`}>
            {r.traces?.probe && (
              <RehearsalAIProcess
                trace={r.traces.probe}
                title="AI 现场漂移比对与演练编排思考"
                defaultOpen={freshTraceStage === "probe"}
              />
            )}

            {r.drift && (
              <section
                className={`rh-drift-sec ${r.drift.drifted ? "is-drifted" : ""}`}
                aria-label="基线与现场比对"
              >
                <div className="rh-drift-top">
                  <div className="rh-drift-title">
                    <span
                      className={`sdot ${r.drift.drifted ? "s-warn" : "s-done"}`}
                    />
                    <b>
                      {r.drift.drifted
                        ? "检测到现场状态与初始交付存在漂移"
                        : "现场状态与初始交付基线一致"}
                    </b>
                    <span className="rh-drift-tag">
                      {r.drift.drifted ? "已按现场拓扑对齐" : "基线一致"}
                    </span>
                  </div>
                  {r.drift.summary && (
                    <p className="rh-drift-sum">
                      {renderThinkingInline(r.drift.summary)}
                    </p>
                  )}
                </div>

                {(r.drift.hosts || []).length > 0 && (
                  <div className="rh-table-wrap">
                    <table className="rh-drift-tbl">
                      <thead>
                        <tr>
                          <th>节点</th>
                          <th>地址</th>
                          <th>角色比对（初始 → 现场）</th>
                          <th>版本</th>
                          <th>运行状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.drift.hosts.map((h) => {
                          const changed =
                            h.initial_role &&
                            h.actual_role &&
                            h.initial_role !== h.actual_role;
                          return (
                            <tr key={h.name + h.ip}>
                              <td>
                                <b>{h.name}</b>
                              </td>
                              <td className="mono">{h.ip || "—"}</td>
                              <td>
                                {changed ? (
                                  <span className="rh-role-shift">
                                    <span>{h.initial_role}</span>
                                    <span aria-hidden>→</span>
                                    <b>{h.actual_role}</b>
                                  </span>
                                ) : (
                                  <span className="rh-role-same">
                                    {h.actual_role || h.initial_role || "—"}
                                  </span>
                                )}
                              </td>
                              <td className="mono">
                                {h.version || c.version}
                              </td>
                              <td>{h.status || "正常"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {(r.drift.param_diffs || []).length > 0 && (
                  <div className="rh-pdiffs">
                    <span className="rh-pdiffs-k">参数变化</span>
                    <div className="rh-pdiffs-list">
                      {r.drift.param_diffs!.map((p) => (
                        <span key={p.key} className="rh-pdiff-chip">
                          <code className="mono">{p.key}</code>
                          <span>
                            {p.initial} → <b>{p.actual}</b>
                          </span>
                          {p.risk && <em>{p.risk}</em>}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {(r.drift.risks || []).length > 0 && (
                  <ul className="rh-bullet-list warn">
                    {r.drift.risks!.map((rk, i) => (
                      <li key={i}>{renderThinkingInline(rk)}</li>
                    ))}
                  </ul>
                )}

                {r.probe_images && r.probe_images.length > 0 && (
                  <SavedImageGallery
                    clusterId={c.id}
                    rehearsalId={r.id}
                    names={r.probe_images}
                    label="现场采集回显截图"
                  />
                )}
              </section>
            )}

            <div className="rh-gate">
              <div className="rh-gate-left">
                <svg
                  viewBox="0 0 36 36"
                  className={`rh-gate-ring ${gateReady ? "ready" : ""}`}
                  aria-hidden
                >
                  <circle cx="18" cy="18" r="14.5" className="track" />
                  {progressPct > 0 && (
                    <circle
                      cx="18"
                      cy="18"
                      r="14.5"
                      className="fill"
                      pathLength="100"
                      strokeDasharray="100"
                      style={{ strokeDashoffset: 100 - progressPct }}
                    />
                  )}
                </svg>
                <div>
                  <b className="num">
                    必测步骤 {doneRequired} / {requiredSteps.length}
                  </b>
                  <span className="muted small">
                    {gateReady
                      ? "全部必测步骤已验证，可定稿生成生产实施方案"
                      : "在测试环境逐条验证耗时；遇到报错可粘贴文本或截图就地排障"}
                  </span>
                </div>
              </div>
              <div className="rh-gate-right">
                <Segmented<string>
                  label="阶段筛选"
                  value={phaseFilter}
                  onChange={setPhaseFilter}
                  options={[
                    { value: "all", label: "全部", count: steps.length },
                    { value: "precheck", label: "预检" },
                    { value: "execute", label: "执行" },
                    { value: "verify", label: "验收" },
                    { value: "rollback", label: "回退" },
                  ]}
                />
                <Tooltip
                  content={
                    gateReady
                      ? "将已验证命令与实测耗时映射回生产节点并生成实施方案"
                      : `完成剩余 ${requiredSteps.length - doneRequired} 个必测步骤后可定稿`
                  }
                  mini
                >
                  <span>
                    <Button
                      type="primary"
                      icon={<Spark size={14} />}
                      disabled={!gateReady || offline}
                      loading={busyFinalize}
                      onClick={() => void finalizeSOP()}
                    >
                      定稿实施方案
                    </Button>
                  </span>
                </Tooltip>
              </div>
            </div>

            {shownSteps.length === 0 ? (
              <div className="rh-empty-filter muted small">
                该阶段下暂无步骤，切换到「全部」查看完整演练清单。
              </div>
            ) : (
              <ol className="rh-timeline">
                {shownSteps.map((step, idx) => (
                  <StepRow
                    key={step.id}
                    c={c}
                    rehearsalId={r.id}
                    step={step}
                    index={idx + 1}
                    staggerIndex={isFreshProbe ? Math.min(idx, 7) : undefined}
                    offline={offline}
                    noVision={noVision}
                    pick={pick}
                    aiOpts={aiOpts}
                    onUpdated={setR}
                    onEngageFocus={onEngageFocus}
                  />
                ))}
              </ol>
            )}
          </div>
        )}

        {/* ---- Stage 4: Finalized Production SOP ---- */}
        {curIdx === 3 && (
          <section className={`rh-sec rh-final-sec${isFreshFinal ? " is-fresh-reveal" : ""}`}>
            <div className="rh-doc-card">
              <div className="rh-doc-art" aria-hidden>
                <svg width="52" height="64" viewBox="0 0 52 64" fill="none">
                  <rect
                    x="2"
                    y="2"
                    width="48"
                    height="60"
                    rx="8"
                    fill="var(--surface)"
                    stroke="var(--line-strong)"
                    strokeWidth="1.5"
                  />
                  <rect
                    x="10"
                    y="12"
                    width="22"
                    height="4"
                    rx="2"
                    fill="var(--brand)"
                  />
                  <rect
                    x="10"
                    y="22"
                    width="32"
                    height="3"
                    rx="1.5"
                    fill="var(--line-strong)"
                  />
                  <rect
                    x="10"
                    y="29"
                    width="28"
                    height="3"
                    rx="1.5"
                    fill="var(--line-strong)"
                  />
                  <rect
                    x="10"
                    y="36"
                    width="20"
                    height="3"
                    rx="1.5"
                    fill="var(--line)"
                  />
                  <circle cx="38" cy="48" r="8" fill="var(--ok-soft)" />
                  <path
                    d="M34.6 48l2.3 2.3 4.6-4.8"
                    stroke="var(--ok)"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div className="rh-doc-body">
                <div className="rh-doc-top">
                  <span className="rh-doc-badge">已定稿</span>
                  <span className="mono faint small">
                    {r.doc_id || `sop-${r.id}`}
                  </span>
                </div>
                <h3>{r.title} · 生产变更实施方案</h3>
                <p className="muted">
                  已将测试环境验证通过的步骤、实测耗时与回退预案映射回集群{" "}
                  <b className="mono">{c.id}</b> 的生产节点拓扑，并归档至集群文档。
                </p>
                <dl className="rh-doc-facts">
                  <div>
                    <dt>验证步骤</dt>
                    <dd className="num">{steps.length} 步</dd>
                  </div>
                  <div>
                    <dt>必测通过</dt>
                    <dd className="num">
                      {doneRequired}/{requiredSteps.length}
                    </dd>
                  </div>
                  {totalRevisions > 0 && (
                    <div>
                      <dt>排障修订</dt>
                      <dd className="num">{totalRevisions} 次</dd>
                    </div>
                  )}
                  <div>
                    <dt>目标组件</dt>
                    <dd>
                      {c.app_name} {c.version}
                    </dd>
                  </div>
                </dl>
                <div className="rh-doc-actions">
                  {r.doc_id && (
                    <Button
                      type="primary"
                      icon={<IconFile />}
                      onClick={() =>
                        go({
                          name: "deliveries",
                          id: c.id,
                          tab: "docs",
                          doc: r.doc_id,
                        })
                      }
                    >
                      打开文档审阅 <IconRight />
                    </Button>
                  )}
                  {r.doc_id && can("report.export") && (
                    <Button
                      icon={<IconDownload />}
                      onClick={() => {
                        window.location.href = `/api/clusters/${encodeURIComponent(c.id)}/export?docs=${encodeURIComponent(r.doc_id!)}`;
                      }}
                    >
                      导出 Word (.docx)
                    </Button>
                  )}
                  <Button
                    type="text"
                    icon={<IconRefresh />}
                    loading={busyFinalize}
                    disabled={offline}
                    onClick={() => void finalizeSOP()}
                  >
                    重新同步生成
                  </Button>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/* ---------- Continuous Timeline Step Row ---------- */

function StepRow({
  c,
  rehearsalId,
  step,
  index,
  staggerIndex,
  offline,
  noVision,
  pick,
  aiOpts,
  onUpdated,
  onEngageFocus,
}: {
  c: ClusterView;
  rehearsalId: string;
  step: RehearsalStep;
  index: number;
  staggerIndex?: number;
  offline: boolean;
  noVision: boolean;
  pick: ReturnType<typeof useModelPick>;
  aiOpts: ReturnType<typeof useAIOptions>;
  onUpdated: (r: ChangeRehearsal) => void;
  onEngageFocus?: () => void;
}) {
  const [elapsed, setElapsed] = useState(step.elapsed || "");
  const [note, setNote] = useState(step.note || "");
  const [editingCmd, setEditingCmd] = useState(false);
  const [cmdDraft, setCmdDraft] = useState(step.command);
  const [troubleOpen, setTroubleOpen] = useState(Boolean(step.proposal));
  const [errText, setErrText] = useState(step.last_error || "");
  const [errImages, setErrImages] = useState<DraftImage[]>([]);
  const [dragErr, setDragErr] = useState(false);
  const [liveTrouble, setLiveTrouble] = useState<LiveAIState | null>(null);
  const [freshTrouble, setFreshTrouble] = useState(false);
  const [busy, setBusy] = useState("");

  const troubleAbortRef = useRef<AbortController | null>(null);
  const errImgInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setCmdDraft(step.command);
    setElapsed(step.elapsed || "");
    setNote(step.note || "");
    if (step.proposal) setTroubleOpen(true);
  }, [step.command, step.elapsed, step.note, step.proposal]);

  const baseUrl = `/api/clusters/${encodeURIComponent(c.id)}/rehearsals/${encodeURIComponent(rehearsalId)}/steps/${encodeURIComponent(step.id)}`;

  const attachErrFiles = async (files: FileList | File[]) => {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    if (noVision) {
      Message.warning(
        "当前所选模型不支持识别截图，请粘贴报错文本或在下方切换支持看图的模型",
      );
      return;
    }
    const room = MAX_IMAGES - errImages.length;
    if (room <= 0) {
      Message.warning(`单次最多附加 ${MAX_IMAGES} 张报错截图`);
      return;
    }
    const added: DraftImage[] = [];
    for (const f of imgs.slice(0, room)) {
      try {
        added.push(await prepareDraftImage(f));
      } catch (e) {
        err(e);
      }
    }
    if (added.length > 0) {
      setErrImages((prev) => [...prev, ...added]);
    }
  };

  const patchStep = async (
    patch: Partial<
      Pick<RehearsalStep, "status" | "elapsed" | "note" | "command">
    >,
  ) => {
    setBusy("patch");
    try {
      const next = await api<ChangeRehearsal>(baseUrl, {
        method: "PATCH",
        body: JSON.stringify({
          elapsed,
          note,
          ...patch,
        }),
      });
      onUpdated(next);
      setEditingCmd(false);
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };

  const troubleBusy = Boolean(liveTrouble && !liveTrouble.error);

  const askTroubleshoot = async () => {
    if ((!errText.trim() && errImages.length === 0) || offline || troubleBusy)
      return;
    onEngageFocus?.();
    const ac = new AbortController();
    troubleAbortRef.current = ac;
    const effortVal = pick.current?.effort?.includes(aiOpts.pref.think)
      ? aiOpts.pref.think
      : undefined;
    setLiveTrouble(
      createInitialLiveState(
        "troubleshoot",
        "AI 正在诊断测试环境报错并推演修正命令",
        "正在封装报错上下文并建立模型连接…",
        pick.current,
      ),
    );
    try {
      const next = await streamRehearsalAPI(
        `${baseUrl}/troubleshoot`,
        {
          error_output: errText,
          images:
            errImages.length > 0
              ? errImages.map((im) => im.dataUrl)
              : undefined,
          model: pick.ref || undefined,
          effort: effortVal,
        },
        (updater) => setLiveTrouble((prev) => (prev ? updater(prev) : prev)),
        ac.signal,
      );
      setLiveTrouble(null);
      setErrImages([]);
      setFreshTrouble(true);
      onUpdated(next);
    } catch (e) {
      if (ac.signal.aborted) {
        setLiveTrouble(null);
      } else {
        setLiveTrouble((prev) =>
          prev ? markLiveStateError(prev, e) : null,
        );
      }
    } finally {
      troubleAbortRef.current = null;
    }
  };

  const applyProposal = async () => {
    setBusy("apply");
    try {
      const next = await api<ChangeRehearsal>(`${baseUrl}/apply`, {
        method: "POST",
      });
      onUpdated(next);
      setTroubleOpen(false);
      Message.success("已更新步骤命令，请在测试环境复测");
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };

  const num = step.order || index;
  const statusInfo =
    step.status === "passed"
      ? { label: "实测通过", cls: "passed" }
      : step.status === "failed"
        ? { label: "执行受阻", cls: "failed" }
        : step.status === "skipped"
          ? { label: "已跳过", cls: "skipped" }
          : { label: "待演练", cls: "pending" };

  return (
    <li
      className={`rh-step st-${step.status}${staggerIndex !== undefined ? " is-fresh-step" : ""}`}
      style={
        staggerIndex !== undefined
          ? ({ "--rh-stagger": staggerIndex } as React.CSSProperties)
          : undefined
      }
    >
      <span className={`rh-step-node st-${step.status}`} aria-hidden>
        {step.status === "passed" ? (
          <IconCheck />
        ) : step.status === "failed" ? (
          "!"
        ) : step.status === "skipped" ? (
          "–"
        ) : (
          <span className="num">{num}</span>
        )}
      </span>

      <div className="rh-step-body">
        <div className="rh-step-head">
          <div className="rh-step-title">
            <span className={`rh-phase ph-${step.phase}`}>
              {PHASE_LABEL[step.phase]}
            </span>
            <b>{step.title}</b>
            {step.target_role && (
              <code className="rh-target mono">{step.target_role}</code>
            )}
            {step.optional && <Tag size="small">可选</Tag>}
          </div>
          <span className={`rh-status-pill ${statusInfo.cls}`}>
            {statusInfo.label}
          </span>
        </div>

        {editingCmd ? (
          <div
            className="rh-cmd-edit"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void patchStep({ command: cmdDraft, status: "pending" });
              } else if (e.key === "Escape") {
                e.preventDefault();
                setCmdDraft(step.command);
                setEditingCmd(false);
              }
            }}
          >
            <Input.TextArea
              value={cmdDraft}
              onChange={setCmdDraft}
              autoSize={{ minRows: 3, maxRows: 12 }}
              className="mono"
              aria-label="编辑步骤命令"
            />
            <div className="row-gap">
              <Button
                size="small"
                type="primary"
                loading={busy === "patch"}
                onClick={() =>
                  void patchStep({ command: cmdDraft, status: "pending" })
                }
              >
                保存命令
              </Button>
              <Button
                size="small"
                onClick={() => {
                  setCmdDraft(step.command);
                  setEditingCmd(false);
                }}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <ShellCodeBlock
            code={step.command}
            title="执行命令"
            compact
            onEdit={() => setEditingCmd(true)}
          />
        )}

        <dl className="rh-step-facts">
          <div>
            <dt>预期判据</dt>
            <dd>{step.expect || "返回码为 0 且服务状态正常"}</dd>
          </div>
          {step.risk_note && (
            <div>
              <dt>注意事项</dt>
              <dd className="warn-ink">{step.risk_note}</dd>
            </div>
          )}
          {step.rollback && (
            <div>
              <dt>回退方式</dt>
              <dd className="mono">{step.rollback}</dd>
            </div>
          )}
        </dl>

        <Smooth>
          {(troubleOpen || step.proposal || step.trouble_trace) && (
            <div className="rh-drawer-stack">
              {troubleOpen && (
                <div
                  className={`rh-trouble ${offline ? "off" : ""} ${dragErr ? "is-drag" : ""} ${troubleBusy ? "is-busy" : ""}`}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void askTroubleshoot();
                    }
                  }}
                  onDragOver={(e) => {
                    if (e.dataTransfer?.types?.includes("Files")) {
                      e.preventDefault();
                      setDragErr(true);
                    }
                  }}
                  onDragLeave={() => setDragErr(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragErr(false);
                    if (e.dataTransfer?.files?.length) {
                      void attachErrFiles(e.dataTransfer.files);
                    }
                  }}
                  onPaste={(e) => {
                    const imgs = extractClipboardImageFiles(e);
                    if (imgs.length > 0) {
                      if (!e.clipboardData?.getData("text/plain")) {
                        e.preventDefault();
                      }
                      void attachErrFiles(imgs);
                    }
                  }}
                >
                  <div className="rh-trouble-head">
                    <b>
                      <IconExclamationCircle /> 测试环境报错诊断
                    </b>
                    <button
                      type="button"
                      className="link small"
                      onClick={() => setTroubleOpen(false)}
                    >
                      收起
                    </button>
                  </div>
                  <Input.TextArea
                    value={errText}
                    disabled={troubleBusy}
                    onChange={setErrText}
                    autoSize={{ minRows: 3, maxRows: 8 }}
                    className="mono"
                    placeholder="粘贴测试机器上的报错输出，或直接按 Ctrl+V 粘贴报错终端截图（敏感信息自动脱敏）…"
                    aria-label="步骤报错输出"
                  />
                  {(errImages.length > 0 ||
                    (step.error_images && step.error_images.length > 0)) && (
                    <div className="rh-compose-imgs">
                      <DraftImageStrip
                        images={errImages}
                        onRemove={(imgId) =>
                          setErrImages((prev) =>
                            prev.filter((x) => x.id !== imgId),
                          )
                        }
                      />
                      {step.error_images && step.error_images.length > 0 && (
                        <SavedImageGallery
                          clusterId={c.id}
                          rehearsalId={rehearsalId}
                          names={step.error_images}
                          label="报错截图"
                        />
                      )}
                    </div>
                  )}
                  <div className="rh-trouble-foot">
                    <div className="rh-trouble-tools">
                      <input
                        ref={errImgInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        multiple
                        hidden
                        onChange={(e) => {
                          if (e.target.files?.length) {
                            void attachErrFiles(e.target.files);
                          }
                          e.target.value = "";
                        }}
                      />
                      <button
                        type="button"
                        className="rh-attach-btn"
                        disabled={troubleBusy || noVision}
                        title={
                          noVision
                            ? "当前所选模型不支持图片识别，可切换支持看图的模型"
                            : "上传或直接 Ctrl+V 粘贴报错截图"
                        }
                        onClick={() => errImgInputRef.current?.click()}
                      >
                        <IconImage />
                        <span>粘贴/上传报错截图</span>
                      </button>
                      <ThinkLevel
                        levels={pick.current?.effort}
                        value={aiOpts.pref.think}
                        onChange={(v) => aiOpts.update({ think: v })}
                      />
                      <ModelPicker pick={pick} compact />
                    </div>
                    <div className="rh-compose-submit">
                      <Button
                        size="small"
                        type="primary"
                        shape="round"
                        className={`ai-pill ${(errText.trim() || errImages.length > 0) && !offline ? "ai-pill-primary" : ""}`}
                        icon={
                          <Spark
                            size={13}
                            rainbow={
                              (!errText.trim() && errImages.length === 0) ||
                              offline
                            }
                          />
                        }
                        title={isMac ? "⌘ + Enter 诊断" : "Ctrl + Enter 诊断"}
                        loading={troubleBusy}
                        disabled={
                          (!errText.trim() && errImages.length === 0) || offline
                        }
                        onClick={() => void askTroubleshoot()}
                      >
                        诊断并生成修正命令
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {liveTrouble && (
                <RehearsalAIProcess
                  live={liveTrouble}
                  title={liveTrouble.title}
                  onAbort={() => troubleAbortRef.current?.abort()}
                  onRetry={() => void askTroubleshoot()}
                  onDismiss={() => setLiveTrouble(null)}
                />
              )}

              {!liveTrouble && step.trouble_trace && (
                <RehearsalAIProcess
                  trace={step.trouble_trace}
                  title="AI 报错根因推理过程"
                  defaultOpen={freshTrouble}
                />
              )}

              {step.proposal && (
                <div
                  className={`rh-proposal${freshTrouble ? " is-fresh-proposal" : ""}`}
                >
                  <div className="rh-proposal-head">
                    <b>
                      <Spark size={14} rainbow />{" "}
                      {step.proposal.action === "insert_before"
                        ? `建议插入前置步骤：${step.proposal.title || "前置准备"}`
                        : "建议原位更新此步命令"}
                    </b>
                  </div>
                  <div className="rh-proposal-diag">
                    <RehearsalThinkingContent
                      text={step.proposal.diagnosis}
                      compact
                    />
                  </div>
                  <ShellCodeBlock
                    code={step.proposal.command}
                    title="修正后命令"
                    compact
                  />
                  <div className="row-gap">
                    <Button
                      size="small"
                      type="primary"
                      icon={<IconCheck />}
                      loading={busy === "apply"}
                      onClick={() => void applyProposal()}
                    >
                      采纳并重新验证
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Smooth>

        {(step.revisions || []).length > 0 && (
          <details className="rh-rev-log">
            <summary>已打磨修订 {step.revisions!.length} 次</summary>
            <ul>
              {step.revisions!.map((rv, i) => (
                <li key={i}>
                  <span className="faint num">{ago(rv.at)}</span>
                  <span>{rv.diagnosis}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="rh-step-bar">
          <div className="rh-step-inputs">
            <Input
              size="small"
              className="rh-in-elapsed"
              value={elapsed}
              onChange={setElapsed}
              onBlur={() => {
                if (elapsed !== (step.elapsed || "")) {
                  void patchStep({ elapsed });
                }
              }}
              placeholder="耗时 如 45s"
              aria-label="实测耗时"
            />
            <Input
              size="small"
              className="rh-in-note"
              value={note}
              onChange={setNote}
              onBlur={() => {
                if (note !== (step.note || "")) {
                  void patchStep({ note });
                }
              }}
              placeholder="实测备注（将同步写入生产实施方案）"
              aria-label="实测备注"
            />
          </div>
          <div className="rh-step-actions">
            <button
              type="button"
              disabled={busy === "patch"}
              className={`rh-act-btn pass ${step.status === "passed" ? "on" : ""}`}
              onClick={() => void patchStep({ status: "passed" })}
            >
              <IconCheck />
              <span>通过</span>
            </button>
            <button
              type="button"
              className={`rh-act-btn trouble ${troubleOpen ? "on" : ""}`}
              onClick={() => setTroubleOpen((v) => !v)}
            >
              <Spark size={13} />
              <span>报错排障</span>
            </button>
            <button
              type="button"
              disabled={busy === "patch"}
              className={`rh-act-btn skip ${step.status === "skipped" ? "on" : ""}`}
              onClick={() => void patchStep({ status: "skipped" })}
            >
              <span>跳过</span>
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

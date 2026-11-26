import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@arco-design/web-react";
import {
  IconBulb,
  IconCheck,
  IconClose,
  IconCopy,
  IconDown,
  IconExclamationCircle,
  IconRecordStop,
  IconRefresh,
  IconUp,
} from "@arco-design/web-react/icon";
import { ApiError, authToken, can, copy, csrfToken } from "./shared";
import type {
  AIAttemptDiag,
  AICallDiag,
  RehearsalTrace,
  RehearsalTraceStep,
} from "./shared";
import { go } from "../app/router";
import { Smooth } from "../design/ui";
import { Spark } from "../modules/ai/aichat";
import { bi, getLang, useLang } from "../app/i18n";
import "./ai-process.css";

export type LiveAIState<TKind extends string = string> = {
  kind: TKind;
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

function cleanClientErrText(raw: string): string {
  let s = (raw || "").trim();
  const fallback = bi(
    "AI 模型通道调用中断，请稍后重试",
    "AI model channel interrupted; please try again later",
  );
  if (!s) return fallback;
  // Strip empty proxy JSON tails such as `: {"error":{"code":"server_error","message":""}}`
  s = s.replace(
    /[:\s]*\{\s*"error"\s*:\s*\{[^}]*"message"\s*:\s*""[^}]*\}\s*\}\s*$/i,
    "",
  );
  s = s.replace(/[:\s]*\{\s*\}\s*$/, "").trim();
  return s || fallback;
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

export function markLiveStateError<TKind extends string = string>(
  prev: LiveAIState<TKind>,
  rawErr: unknown,
): LiveAIState<TKind> {
  const msg = cleanClientErrText(
    rawErr instanceof Error
      ? rawErr.message
      : String(rawErr || bi("AI 模型通道调用中断", "AI model channel interrupted")),
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
        ? bi(
            `已接收 ${diag.in_tokens.toLocaleString("en-US")} 输入 Token${
              diag.cached_tokens
                ? `（缓存 ${diag.cached_tokens.toLocaleString("en-US")}）`
                : ""
            }`,
            `received ${diag.in_tokens.toLocaleString("en-US")} input tokens${
              diag.cached_tokens
                ? ` (${diag.cached_tokens.toLocaleString("en-US")} cached)`
                : ""
            }`,
          )
        : bi("已返回成功状态码", "returned success status");
    return {
      badge: bi(
        `HTTP ${httpStatus || 200} · 空输出响应 (0 Token)`,
        `HTTP ${httpStatus || 200} · Empty output (0 tokens)`,
      ),
      summary: bi(
        `上游模型网关${inPart}，但响应体 output: [] 为空，未生成任何有效输出 Token。`,
        `Upstream gateway ${inPart}, but output: [] was empty with 0 tokens generated.`,
      ),
      hint: bi(
        "常见于中转网关（如 Magpie / OneAPI）在 Responses 协议下转译 Claude 等非 OpenAI 模型时丢失输出流，或上游渠道中途断流、欠费截断。建议前往「设置 → AI」将该供应商接口方式改为「Chat Completions（通用）」，或检查上游渠道额度后重试。",
        "Often caused by proxy gateways (e.g. Magpie / OneAPI) dropping streams when translating non-OpenAI models via Responses API, or upstream truncation/quota limits. Switch the provider API mode to Chat Completions in Settings → AI or check upstream quota and retry.",
      ),
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
      badge: bi(
        `HTTP ${httpStatus || 402} · 额度或计费受限`,
        `HTTP ${httpStatus || 402} · Quota or billing limit`,
      ),
      summary: afterFallback
        ? bi(
            `平台自动回退兼容重试后，上游模型渠道返回 HTTP ${httpStatus || 402} 配额或计费限制（Payment Required）。`,
            `After automatic fallback retry, upstream returned HTTP ${httpStatus || 402} (Payment Required).`,
          )
        : bi(
            `上游模型网关返回 HTTP ${httpStatus || 402} 配额或计费限制（Payment Required），当前渠道未能接收推演请求。`,
            `Upstream gateway returned HTTP ${httpStatus || 402} (Payment Required); the channel rejected the request.`,
          ),
      hint: bi(
        "您填写的变更诉求与截图已完整保留。请核查网关下游渠道余额，或前往「设置 → AI」切换其他可用模型后点击「重新发起」。",
        "Your change goal and screenshots are preserved. Check channel balance or switch models in Settings → AI, then click Retry.",
      ),
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
        ? bi(`HTTP ${httpStatus} · 模型鉴权未通过`, `HTTP ${httpStatus} · Auth failed`)
        : bi("模型鉴权未通过", "Authentication failed"),
      summary: bi(
        `上游模型网关返回 ${httpStatus ? `HTTP ${httpStatus} ` : ""}鉴权拒绝，当前访问密钥无效或无权调用该模型。`,
        `Upstream gateway rejected ${httpStatus ? `(HTTP ${httpStatus}) ` : ""}authentication; API key is invalid or lacks model access.`,
      ),
      hint: bi(
        "请前往「设置 → AI」核对模型供应商密钥与变更演练绑定模型，保存后点击「重新发起」。",
        "Verify the provider API key and bound model in Settings → AI, save, and click Retry.",
      ),
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
      badge: bi(
        `HTTP ${httpStatus || 429} · 网关并发限流`,
        `HTTP ${httpStatus || 429} · Rate limited`,
      ),
      summary: bi(
        `上游模型通道返回 HTTP ${httpStatus || 429} 速率或并发保护限制。`,
        `Upstream channel returned HTTP ${httpStatus || 429} rate or concurrency limit.`,
      ),
      hint: bi(
        "稍候几秒即可点击「重新发起」重试，或在「设置 → AI」中配置备用模型节点。",
        "Wait a few seconds and click Retry, or configure a fallback model in Settings → AI.",
      ),
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
        ? bi(`HTTP ${httpStatus} · 端点或模型未找到`, `HTTP ${httpStatus} · Endpoint or model not found`)
        : bi("模型标识未找到", "Model ID not found"),
      summary: bi(
        `上游网关返回 ${httpStatus ? `HTTP ${httpStatus}` : "404"}，未找到目标接口路径或当前配置的模型标识。`,
        `Upstream gateway returned ${httpStatus ? `HTTP ${httpStatus}` : "404"}; endpoint path or configured model ID was not found.`,
      ),
      hint: bi(
        "请前往「设置 → AI」检查模型名称与 Base URL；若使用中转网关且不支持 /responses，建议切换接口方式为「Chat Completions（通用）」。",
        "Check the model name and Base URL in Settings → AI; if your proxy does not support /responses, switch API mode to Chat Completions.",
      ),
      suggestSettings: true,
    };
  }

  if (reasonCode === "incomplete") {
    return {
      badge: bi(
        `${httpStatus ? `HTTP ${httpStatus} · ` : ""}模型输出截断`,
        `${httpStatus ? `HTTP ${httpStatus} · ` : ""}Output truncated`,
      ),
      summary: bi(
        `上游模型在完成完整结构化输出前提前中止（状态：${diag?.upstream_status || "incomplete"}）。`,
        `Upstream model stopped before completing structured output (status: ${diag?.upstream_status || "incomplete"}).`,
      ),
      hint: bi(
        "常见于网关单次最大输出 Token 限制偏小或响应中途断流；可直接点击「重新发起」或在「设置 → AI」切换模型。",
        "Usually caused by low max-output token limits or mid-stream drops. Click Retry or switch models in Settings → AI.",
      ),
      suggestSettings: true,
    };
  }

  if (reasonCode === "invalid_output") {
    return {
      badge: bi(
        `${httpStatus ? `HTTP ${httpStatus} · ` : ""}返回格式不完整`,
        `${httpStatus ? `HTTP ${httpStatus} · ` : ""}Malformed output`,
      ),
      summary: bi(
        "上游模型已返回文本，但未包含完整可解析的 JSON 结果（可能输出中途截断或模型未按结构化要求输出）。",
        "Model returned text without complete parseable JSON (output may be truncated or unstructured).",
      ),
      hint: bi(
        "您的输入已完整保留；可展开下方「查看网关原始诊断报文」查看模型实际输出，或直接点击「重新发起」重试。",
        "Your input is preserved; expand Raw Gateway Diagnostics below to inspect output, or click Retry.",
      ),
      suggestSettings: true,
    };
  }

  if (reasonCode === "sse_error") {
    return {
      badge: bi(
        `${httpStatus ? `HTTP ${httpStatus} · ` : ""}SSE 流式帧报错`,
        `${httpStatus ? `HTTP ${httpStatus} · ` : ""}SSE stream error`,
      ),
      summary: bi(
        "模型网关建立流式连接后，在推送 SSE 事件流中途返回了上游错误帧。",
        "Gateway opened stream but returned an upstream error frame mid-stream.",
      ),
      hint: bi(
        "可展开下方「查看网关原始诊断报文」定位上游具体错误内容，修复或切换模型后点击「重新发起」。",
        "Expand Raw Gateway Diagnostics below for upstream details, then fix or switch model and click Retry.",
      ),
      suggestSettings: true,
    };
  }

  if (
    reasonCode === "timeout" ||
    reasonCode === "network_error" ||
    errCode === 0 ||
    httpStatus === 504 ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("unable to connect") ||
    lower.includes("disconnected") ||
    errMsg.includes("超时") ||
    errMsg.includes("无法连接") ||
    errMsg.includes("断开")
  ) {
    return {
      badge: bi(
        `${httpStatus ? `HTTP ${httpStatus} · ` : ""}网关连接超时或中断`,
        `${httpStatus ? `HTTP ${httpStatus} · ` : ""}Connection timeout or drop`,
      ),
      summary: bi(
        "连接上游模型服务超时或网络层中断，本次推演已安全中止。",
        "Connection to upstream AI service timed out or dropped; run safely aborted.",
      ),
      hint: bi(
        "您输入的变更内容已完整保留；确认模型网关网络可达后点击「重新发起」即可继续。",
        "Your inputs are preserved; ensure gateway connectivity and click Retry.",
      ),
      suggestSettings: true,
    };
  }

  if (httpStatus && httpStatus >= 400) {
    return {
      badge: bi(
        `HTTP ${httpStatus} · 网关错误响应`,
        `HTTP ${httpStatus} · Gateway error`,
      ),
      summary: bi(
        `上游模型网关返回 HTTP ${httpStatus}${diag?.endpoint ? `（${diag.endpoint}）` : ""}，本次推演未完成落库。`,
        `Upstream gateway returned HTTP ${httpStatus}${diag?.endpoint ? ` (${diag.endpoint})` : ""}; nothing was saved.`,
      ),
      hint: bi(
        "您填写的内容均已保留；可展开下方「查看网关原始诊断报文」核查上游具体报错，或前往「设置 → AI」切换模型重试。",
        "Your inputs are preserved; expand Raw Gateway Diagnostics or switch models in Settings → AI.",
      ),
      suggestSettings: true,
    };
  }

  return {
    badge: bi("模型通道调用异常", "Model channel error"),
    summary: bi(
      "模型网关未返回可解析的演练结果，本次推演未写入残缺记录。",
      "Gateway returned no parseable result; no partial record was saved.",
    ),
    hint: bi(
      "您填写的内容均已保留，可直接点击「重新发起」重试；若持续报错请查看网关诊断详情或在「设置 → AI」切换可用模型。",
      "Your inputs are preserved. Click Retry, or check diagnostics / switch model in Settings → AI.",
    ),
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
    return bi("空响应 (0 Token)", "Empty (0 tokens)");
  }
  if (att.http_status === 402) return "Payment Required";
  if (att.http_status === 401 || att.http_status === 403)
    return bi("鉴权拒绝", "Auth denied");
  if (att.http_status === 429) return bi("速率受限", "Rate limited");
  if (att.http_status === 404) return bi("端点未找到", "Not found");
  if (att.upstream_status) return att.upstream_status;
  return "";
}


export async function streamPipelineSSE<T, TKind extends string = string>(
  path: string,
  body: unknown,
  onEvent: (updater: (prev: LiveAIState<TKind>) => LiveAIState<TKind>) => void,
  signal?: AbortSignal,
  extractDone?: (ev: Record<string, unknown>) => T | null,
): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${path}${sep}stream=1`;
  let res: Response;
  try {
    const tok = authToken();
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-CSRF-Token": csrfToken(),
        "X-Lang": getLang(),
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiError(
      navigator.onLine
        ? bi(
            "无法连接到 Kyndryl Delivery Studio 后端服务（可能正在重启），请稍后重试",
            "Unable to connect to Kyndryl Delivery Studio backend (may be restarting); please try again later",
          )
        : bi("本机网络已断开，请检查网络连接", "Device network disconnected"),
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
      if (!res.ok) {
        throw new ApiError(
          bi(
            `Kyndryl Delivery Studio 后端服务暂时不可用（HTTP ${res.status}）`,
            `Kyndryl Delivery Studio backend temporarily unavailable (HTTP ${res.status})`,
          ),
          res.status,
        );
      }
    }
    if (!res.ok) {
      throw new ApiError(
        (typeof parsed.error === "string" && parsed.error) ||
          bi(`请求失败（${res.status}）`, `Request failed (${res.status})`),
        res.status,
        parsed,
      );
    }
    return parsed as unknown as T;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finalResult: T | null = null;

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
    if (kind === "steps" && Array.isArray(ev.steps)) {
      const serverSteps = ev.steps as RehearsalTraceStep[];
      onEvent((prev) => ({
        ...prev,
        steps: serverSteps,
      }));
    } else if (kind === "step" && ev.step) {
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
    } else if (kind === "done") {
      const extracted = extractDone
        ? extractDone(ev)
        : ((ev.result ?? ev.rehearsal ?? null) as T | null);
      if (extracted !== null && extracted !== undefined) {
        finalResult = extracted;
      }
    } else if (kind === "error") {
      const msg =
        typeof ev.v === "string" && ev.v
          ? ev.v
          : bi("AI 处理中断，请稍后重试", "AI processing interrupted; please try again later");
      const code = typeof ev.code === "number" ? ev.code : 502;
      const diag =
        ev.diag && typeof ev.diag === "object"
          ? (ev.diag as AICallDiag)
          : undefined;
      throw new ApiError(msg, code, diag ? { diag } : undefined);
    }
  };

  const onAbortRead = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbortRead, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
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
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (buf.trim()) {
      for (const line of buf.split("\n")) {
        handlePayload(line);
      }
    }
  } catch (e) {
    if (signal?.aborted || (e as Error)?.name === "AbortError") throw e;
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      bi(
        "与 Kyndryl Delivery Studio 后端服务的流式连接意外中断（可能正在重启或网络抖动），请重试",
        "Streaming connection to Kyndryl Delivery Studio backend was interrupted; please retry",
      ),
      0,
    );
  } finally {
    signal?.removeEventListener("abort", onAbortRead);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!finalResult) {
    throw new ApiError(
      bi(
        "与 Kyndryl Delivery Studio 后端服务的连接在生成完成前关闭，请重试",
        "Connection to Kyndryl Delivery Studio backend closed before generation completed; please retry",
      ),
      502,
    );
  }
  return finalResult;
}


/* ---------- Live & Persisted AI Choreographed Pipeline Card ---------- */

export function fmtElapsedMs(ms?: number) {
  if (!ms || ms < 80) return "";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

export function fmtStepDuration(ms?: number) {
  if (!ms || ms < 30) return bi("已就绪", "Ready");
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

type StageDomain = "rehearsal" | "import-parse" | "import-probe" | "import-diagnose";

function stageDomainOf(kind?: string): StageDomain {
  if (kind === "import-parse") return "import-parse";
  if (kind === "import-probe") return "import-probe";
  if (kind === "import-diagnose") return "import-diagnose";
  return "rehearsal";
}

function pendingHintForStep(st: RehearsalTraceStep, kind?: string): string {
  const dom = stageDomainOf(kind);
  switch (st.kind) {
    case "guard":
      if (dom === "import-parse") {
        return bi(
          "等待线索预扫描完成后自动剥离口令与私钥",
          "Waiting for pre-scan before scrubbing passwords & keys",
        );
      }
      if (dom === "import-probe") {
        return bi(
          "等待场景加载完成后注入 100% 静态只读安全护栏",
          "Waiting to lock 100% read-only safety guardrails",
        );
      }
      return bi(
        "等待基线上下文读取完成后执行脱敏与安全红线校验",
        "Waiting for baseline read to scrub secrets & run safety checks",
      );
    case "connect":
      return bi(
        "等待前序安全校验完成后建立模型流式通道",
        "Waiting for safety checks to open AI model stream",
      );
    case "think":
      if (dom === "import-parse") {
        return bi(
          "等待模型首包返回后开始识别主机、伴生组件与访问入口",
          "Waiting for first token to extract hosts, companions & endpoints",
        );
      }
      if (dom === "import-probe") {
        return bi(
          "等待模型首包返回后按场景编写精炼只读探针脚本",
          "Waiting for first token to craft tailored read-only probe",
        );
      }
      if (dom === "import-diagnose") {
        return bi(
          "等待模型首包返回后扫描架构盲区与缺失基线项",
          "Waiting for first token to audit baseline blind spots",
        );
      }
      return bi(
        "等待模型网关返回首包 Token 后展开实时推演",
        "Waiting for first token from model gateway",
      );
    case "synthesize":
      if (dom === "import-parse") {
        return bi(
          "等待多组件架构识别完成后合成可编辑纳管基线草稿",
          "Waiting for extraction to assemble editable baseline draft",
        );
      }
      if (dom === "import-probe") {
        return bi(
          "等待脚本编写完成后执行 100% 静态只读安全门禁扫描",
          "Waiting for script generation to run static read-only gate",
        );
      }
      if (dom === "import-diagnose") {
        return bi(
          "等待盲区审计完成后收敛高价值只读补采清单",
          "Waiting for audit to compile read-only gap checklist",
        );
      }
      return bi(
        "等待架构风险推演完成后编排结构化结果",
        "Waiting for analysis to structure final output",
      );
    default:
      return bi("等待前序环节完成", "Waiting for previous step");
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

const LiveElapsedSpan = React.memo(function LiveElapsedSpan({
  startedAt,
  endedAt,
  integer = false,
  prefix = "",
  suffix = "s",
  className,
}: {
  startedAt: number;
  endedAt?: number;
  integer?: boolean;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const [now, setNow] = useState(() => endedAt || Date.now());
  useEffect(() => {
    if (endedAt) {
      setNow(endedAt);
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 120);
    return () => window.clearInterval(timer);
  }, [startedAt, endedAt]);

  const end = endedAt || now;
  const sec = Math.max(0.1, (end - startedAt) / 1000);
  const formatted = integer ? String(Math.floor(sec)) : sec.toFixed(1);
  return (
    <span className={className}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
});

const RehearsalStageCartoon = React.memo(function RehearsalStageCartoon({
  kind,
  scene,
  stepTitle,
  stepDetail,
  provider,
  model,
  waitStartedAt,
  errorBadge,
}: {
  kind?: string;
  scene: CartoonScene;
  stepTitle: string;
  stepDetail?: string;
  provider?: string;
  model?: string;
  waitStartedAt?: number;
  errorBadge?: string;
}) {
  useLang();
  const domain = stageDomainOf(kind);

  const actMeta: Record<
    CartoonScene,
    { tag: string; headline: string; sub: React.ReactNode }
  > = {
    inspect:
      domain === "import-parse"
        ? {
            tag: bi("ACT 01 · 线索采样", "ACT 01 · EVIDENCE SCAN"),
            headline:
              stepTitle ||
              bi(
                "扫描终端回显与现场截图线索",
                "Scanning terminal outputs & screenshot clues",
              ),
            sub:
              stepDetail ||
              bi(
                "规则引擎同步扫描文本回显与截图，提取主机、端口与伴生组件初步线索",
                "Pre-scanning terminal logs & screenshots for hosts, ports & companion clues",
              ),
          }
        : domain === "import-probe"
          ? {
              tag: bi("ACT 01 · 场景解析", "ACT 01 · SCENARIO CONTEXT"),
              headline:
                stepTitle ||
                bi(
                  "装载中间件类型与定制场景需求",
                  "Loading middleware type & tailored scenario hints",
                ),
              sub:
                stepDetail ||
                bi(
                  "结合所选中间件、部署形态与勾选的场景卡片规划采集重点",
                  "Planning probe coverage from middleware type, runtime & selected scenario cards",
                ),
            }
          : domain === "import-diagnose"
            ? {
                tag: bi("ACT 01 · 档案通读", "ACT 01 · BASELINE AUDIT"),
                headline:
                  stepTitle ||
                  bi(
                    "通读存量基线档案与历史变更台账",
                    "Reading existing baseline archive & change history",
                  ),
                sub:
                  stepDetail ||
                  bi(
                    "读取主机角色、伴生栈、配置路径与近期变更，准备排查高价值盲区",
                    "Loading hosts, companions, config paths & history to locate blind spots",
                  ),
              }
            : {
                tag: bi("ACT 01 · 基线扫描", "ACT 01 · BASELINE SCAN"),
                headline:
                  stepTitle ||
                  bi(
                    "扫描集群初始交付拓扑与参数基线",
                    "Scanning initial delivery topology & baseline params",
                  ),
                sub:
                  stepDetail ||
                  bi(
                    "逐节点提取主从角色、端口与关键配置，构建演练数字沙盘",
                    "Extracting node roles, ports & key configs to build rehearsal sandbox",
                  ),
              },
    guard:
      domain === "import-probe"
        ? {
            tag: bi("ACT 02 · 只读护栏", "ACT 02 · READ-ONLY POLICY"),
            headline:
              stepTitle ||
              bi(
                "注入 100% 静态只读安全红线规则",
                "Injecting 100% static read-only safety guardrails",
              ),
            sub:
              stepDetail ||
              bi(
                "锁定零写入、零服务重启、零文件重定向与凭据脱敏约束，确保生产绝对安全",
                "Locking zero-write, zero-restart, zero-redirect & secret redaction constraints",
              ),
          }
        : {
            tag: bi("ACT 02 · 安全脱敏", "ACT 02 · REDACTION"),
            headline:
              stepTitle ||
              bi(
                "敏感凭据自动剥离与安全边界锁定",
                "Stripping credentials & locking safety guardrails",
              ),
            sub:
              stepDetail ||
              bi(
                "口令、私钥与连接串在本地安检门全部擦除，仅放行架构元数据",
                "Passwords, keys & DSNs scrubbed locally; only topology metadata passes",
              ),
          },
    connect: {
      tag: bi("ACT 03 · 网关握手", "ACT 03 · GATEWAY HANDSHAKE"),
      headline:
        stepTitle ||
        bi(
          "平台底座正在与所选 AI 模型建立流式握手",
          "Handshaking with selected AI model gateway",
        ),
      sub: stepDetail || (
        <>
          {bi(
            `正在向 ${provider || "模型网关"}${model ? ` (${model})` : ""} 投递脱敏上下文并等待首包响应`,
            `Sending redacted context to ${provider || "model gateway"}${model ? ` (${model})` : ""} and awaiting first token`,
          )}
          {waitStartedAt ? (
            <LiveElapsedSpan
              startedAt={waitStartedAt}
              prefix=" · "
              suffix="s"
              className="num"
            />
          ) : null}
        </>
      ),
    },
    think:
      domain === "import-parse"
        ? {
            tag: bi("ACT 04 · 拓扑拼装", "ACT 04 · TOPOLOGY EXTRACTION"),
            headline:
              stepTitle ||
              bi(
                "识别主机角色、多组件伴生栈与访问入口",
                "Extracting hosts, companion stack & access endpoints",
              ),
            sub:
              stepDetail ||
              bi(
                "交叉解析回显与多张截图，结构化拼装主中间件、伴生高可用栈与 VIP 入口",
                "Cross-referencing logs & screenshots to assemble hosts, companions & VIP endpoints",
              ),
          }
        : domain === "import-probe"
          ? {
              tag: bi("ACT 04 · 探针编排", "ACT 04 · SCRIPT CRAFTING"),
              headline:
                stepTitle ||
                bi(
                  "编排精炼 100% 只读 Bash 采集探针",
                  "Crafting concise 100% read-only Bash probe",
                ),
              sub:
                stepDetail ||
                bi(
                  "按所选现场场景逐段编写轻量、零副作用的只读采集命令与脱敏过滤",
                  "Writing targeted, zero-side-effect read-only commands & secret filters",
                ),
            }
          : domain === "import-diagnose"
            ? {
                tag: bi("ACT 04 · 盲区审计", "ACT 04 · BLIND-SPOT AUDIT"),
                headline:
                  stepTitle ||
                  bi(
                    "对照生产高可用与演练标准扫描基线盲区",
                    "Auditing baseline blind spots against HA & rehearsal standards",
                  ),
                sub:
                  stepDetail ||
                  bi(
                    "深入排查复制机制、备份归档、容量水位与高可用参数中的遗漏项",
                    "Inspecting replication, backup, capacity & HA boundaries for missing signals",
                  ),
              }
            : {
                tag: bi("ACT 04 · 沙盘推演", "ACT 04 · REASONING"),
                headline:
                  stepTitle ||
                  bi(
                    "握手已建立 · 正在推演高可用变更路径",
                    "Connected · Reasoning HA-safe change path",
                  ),
                sub:
                  stepDetail ||
                  bi(
                    "遵循「从库先行、主库守卫、随时可回退」原则逐节点模拟变更影响",
                    "Simulating impact node-by-node: replicas first, primary guarded, always reversible",
                  ),
              },
    synthesize:
      domain === "import-parse"
        ? {
            tag: bi("ACT 05 · 基线落盘", "ACT 05 · BASELINE DRAFT"),
            headline:
              stepTitle ||
              bi(
                "合成结构化存量纳管基线草稿",
                "Synthesizing structured import baseline draft",
              ),
            sub:
              stepDetail ||
              bi(
                "合并规则预检与 AI 识别结果，输出可逐项核对微调的架构拓扑草稿",
                "Merging deterministic & AI findings into an editable topology baseline draft",
              ),
          }
        : domain === "import-probe"
          ? {
              tag: bi("ACT 05 · 静态安检", "ACT 05 · STATIC RO GATE"),
              headline:
                stepTitle ||
                bi(
                  "100% 静态只读安全门禁复核",
                  "Running 100% static read-only safety gate",
                ),
              sub:
                stepDetail ||
                bi(
                  "逐行静态扫描生成脚本，拦截任何写操作或服务变更指令后放行使用",
                  "Scanning every line to guarantee zero write or service-mutation commands",
                ),
            }
          : domain === "import-diagnose"
            ? {
                tag: bi("ACT 05 · 缺口清单", "ACT 05 · GAP CHECKLIST"),
                headline:
                  stepTitle ||
                  bi(
                    "收敛高价值只读补采建议与优先级",
                    "Compiling prioritized read-only backfill checklist",
                  ),
                sub:
                  stepDetail ||
                  bi(
                    "按高/中/低优先级整理缺失项与 100% 只读核验动作，一键勾选生成补采探针",
                    "Organizing gaps by priority with 100% read-only verification actions",
                  ),
              }
            : {
                tag: bi("ACT 05 · 方案签章", "ACT 05 · FINALIZING"),
                headline:
                  stepTitle ||
                  bi(
                    "编排结构化演练清单并加盖安全校验章",
                    "Structuring runbook & stamping safety verification",
                  ),
                sub:
                  stepDetail ||
                  bi(
                    "收敛模型推演结论，完成静态安全红线复核与可执行步骤封装",
                    "Consolidating findings, verifying safety rules & packaging executable steps",
                  ),
              },
    error: {
      tag: errorBadge || bi("通道熔断保护", "CIRCUIT BREAKER"),
      headline: bi(
        "模型网关调用中断 · 本地安全熔断已介入",
        "Gateway call interrupted · Safety breaker active",
      ),
      sub: bi(
        "您填写的内容与上传的截图已完整保留，切换模型或确认网络后可随时重试",
        "Your inputs and screenshots are preserved; switch model or retry anytime",
      ),
    },
  };

  const cur = actMeta[scene];

  return (
    <div className={`rh-cartoon-stage is-${scene}`} aria-hidden>
      <div className="rh-cartoon-canvas" key={`${domain}-${scene}`}>
        {scene === "inspect" && domain === "import-parse" && (
          <svg viewBox="0 0 360 96" fill="none" className="rh-cartoon-svg">
            <defs>
              <linearGradient id="ct-scan-grad-imp" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--brand)" stopOpacity="0" />
                <stop offset="100%" stopColor="var(--brand)" stopOpacity="0.22" />
              </linearGradient>
            </defs>
            {/* Terminal Output Window + Screenshot Stack */}
            <g className="ct-rack">
              <rect x="10" y="10" width="122" height="44" rx="7" className="ct-node-box" />
              <circle cx="20" cy="20" r="2.6" className="ct-led ok" />
              <circle cx="29" cy="20" r="2.6" className="ct-led brand" />
              <text x="40" y="20" textAnchor="start" dominantBaseline="central" className="ct-mini-txt">
                $_ PROBE LOG
              </text>
              <rect x="18" y="30" width="84" height="4.5" rx="2.2" className="ct-bar" />
              <rect x="18" y="40" width="64" height="4.5" rx="2.2" className="ct-bar" />

              <rect x="10" y="60" width="58" height="26" rx="6" className="ct-node-box" />
              <circle cx="22" cy="73" r="3.2" className="ct-led brand" />
              <text x="31" y="73" textAnchor="start" dominantBaseline="central" className="ct-mini-txt">
                IMG 1
              </text>
              <rect x="74" y="60" width="58" height="26" rx="6" className="ct-node-box" />
              <circle cx="86" cy="73" r="3.2" className="ct-led ok" />
              <text x="95" y="73" textAnchor="start" dominantBaseline="central" className="ct-mini-txt">
                IMG N
              </text>
            </g>
            <g className="ct-scan-beam">
              <rect x="10" y="6" width="26" height="84" rx="4" fill="url(#ct-scan-grad-imp)" />
              <line x1="36" y1="6" x2="36" y2="90" className="ct-scan-line" />
            </g>
            <path d="M134 28 C176 28, 192 48, 234 48" className="ct-dash-path is-moving" />
            <path d="M134 72 C176 72, 192 48, 234 48" className="ct-dash-path is-moving" />
            <g className="ct-float-card c1">
              <rect x="154" y="14" width="52" height="20" rx="6" className="ct-pill-card" />
              <text x="180" y="24" textAnchor="middle" dominantBaseline="central" className="ct-pill-txt">
                HOST
              </text>
            </g>
            <g className="ct-float-card c2">
              <rect x="160" y="62" width="52" height="20" rx="6" className="ct-pill-card" />
              <text x="186" y="72" textAnchor="middle" dominantBaseline="central" className="ct-pill-txt">
                STACK
              </text>
            </g>
            <g className="ct-capsule">
              <rect x="236" y="20" width="114" height="56" rx="12" className="ct-hub-pod" />
              <circle cx="258" cy="48" r="10.5" className="ct-check-disc" />
              <path d="M253.5 48.2l3 3 6-6.2" className="ct-check-white" />
              <text x="276" y="41" textAnchor="start" dominantBaseline="central" className="ct-pod-title">
                {bi("现场线索", "Evidence")}
              </text>
              <text x="276" y="56" textAnchor="start" dominantBaseline="central" className="ct-pod-sub ok">
                READY
              </text>
            </g>
          </svg>
        )}

        {scene === "inspect" && domain === "import-probe" && (
          <svg viewBox="0 0 360 96" fill="none" className="rh-cartoon-svg">
            <g className="ct-rack">
              <rect x="10" y="11" width="120" height="20" rx="5.5" className="ct-node-box" />
              <circle cx="22" cy="21" r="3.2" className="ct-led brand" />
              <text x="33" y="21" textAnchor="start" dominantBaseline="central" className="ct-mini-txt">
                {bi("高可用栈 · HA", "HA Stack")}
              </text>

              <rect x="10" y="38" width="120" height="20" rx="5.5" className="ct-node-box" />
              <circle cx="22" cy="48" r="3.2" className="ct-led ok" />
              <text x="33" y="48" textAnchor="start" dominantBaseline="central" className="ct-mini-txt">
                {bi("备份与归档", "Backup & WAL")}
              </text>

              <rect x="10" y="65" width="120" height="20" rx="5.5" className="ct-node-box" />
              <circle cx="22" cy="75" r="3.2" className="ct-led brand" />
              <text x="33" y="75" textAnchor="start" dominantBaseline="central" className="ct-mini-txt">
                {bi("TLS / VIP 代理", "TLS & Proxy")}
              </text>
            </g>
            <path d="M134 24 C176 24, 192 48, 234 48" className="ct-dash-path is-moving" />
            <path d="M134 72 C176 72, 192 48, 234 48" className="ct-dash-path is-moving" />
            <g className="ct-float-card c1">
              <rect x="154" y="14" width="54" height="20" rx="6" className="ct-pill-card" />
              <text x="181" y="24" textAnchor="middle" dominantBaseline="central" className="ct-pill-txt">
                RO-ONLY
              </text>
            </g>
            <g className="ct-float-card c2">
              <rect x="160" y="62" width="52" height="20" rx="6" className="ct-pill-card" />
              <text x="186" y="72" textAnchor="middle" dominantBaseline="central" className="ct-pill-txt">
                BASH
              </text>
            </g>
            <g className="ct-capsule">
              <rect x="236" y="20" width="114" height="56" rx="12" className="ct-hub-pod" />
              <circle cx="258" cy="48" r="10.5" className="ct-check-disc" />
              <path d="M253.5 48.2l3 3 6-6.2" className="ct-check-white" />
              <text x="276" y="41" textAnchor="start" dominantBaseline="central" className="ct-pod-title">
                {bi("探针蓝图", "Blueprint")}
              </text>
              <text x="276" y="56" textAnchor="start" dominantBaseline="central" className="ct-pod-sub ok">
                READY
              </text>
            </g>
          </svg>
        )}

        {scene === "inspect" && domain !== "import-parse" && domain !== "import-probe" && (
          <svg viewBox="0 0 360 96" fill="none" className="rh-cartoon-svg">
            <defs>
              <linearGradient id="ct-scan-grad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--brand)" stopOpacity="0" />
                <stop offset="100%" stopColor="var(--brand)" stopOpacity="0.22" />
              </linearGradient>
            </defs>

            {/* Server Rack Nodes */}
            <g className="ct-rack">
              <rect x="10" y="11" width="120" height="20" rx="5.5" className="ct-node-box" />
              <circle cx="22" cy="21" r="3.2" className="ct-led ok" />
              <rect x="32" y="18.5" width="48" height="5" rx="2.5" className="ct-bar" />
              <rect x="89" y="14" width="32" height="14" rx="4" className="ct-role-chip" />
              <text x="105" y="21" textAnchor="middle" dominantBaseline="central" className="ct-mini-txt">
                PRI
              </text>

              <rect x="10" y="38" width="120" height="20" rx="5.5" className="ct-node-box" />
              <circle cx="22" cy="48" r="3.2" className="ct-led brand" />
              <rect x="32" y="45.5" width="42" height="5" rx="2.5" className="ct-bar" />
              <rect x="89" y="41" width="32" height="14" rx="4" className="ct-role-chip" />
              <text x="105" y="48" textAnchor="middle" dominantBaseline="central" className="ct-mini-txt">
                REP
              </text>

              <rect x="10" y="65" width="120" height="20" rx="5.5" className="ct-node-box" />
              <circle cx="22" cy="75" r="3.2" className="ct-led brand" />
              <rect x="32" y="72.5" width="45" height="5" rx="2.5" className="ct-bar" />
              <rect x="89" y="68" width="32" height="14" rx="4" className="ct-role-chip" />
              <text x="105" y="75" textAnchor="middle" dominantBaseline="central" className="ct-mini-txt">
                REP
              </text>
            </g>

            {/* Gradient Laser Scanner Beam */}
            <g className="ct-scan-beam">
              <rect x="10" y="6" width="26" height="84" rx="4" fill="url(#ct-scan-grad)" />
              <line x1="36" y1="6" x2="36" y2="90" className="ct-scan-line" />
            </g>

            {/* Animated Data Bus & Extracted Chips */}
            <path d="M134 26 C176 26, 192 48, 234 48" className="ct-dash-path is-moving" />
            <path d="M134 70 C176 70, 192 48, 234 48" className="ct-dash-path is-moving" />
            <g className="ct-float-card c1">
              <rect x="154" y="14" width="50" height="20" rx="6" className="ct-pill-card" />
              <text x="179" y="24" textAnchor="middle" dominantBaseline="central" className="ct-pill-txt">
                YAML
              </text>
            </g>
            <g className="ct-float-card c2">
              <rect x="162" y="62" width="50" height="20" rx="6" className="ct-pill-card" />
              <text x="187" y="72" textAnchor="middle" dominantBaseline="central" className="ct-pill-txt">
                TOPO
              </text>
            </g>

            {/* Baseline Snapshot Receiver Pod */}
            <g className="ct-capsule">
              <rect x="236" y="20" width="114" height="56" rx="12" className="ct-hub-pod" />
              <circle cx="258" cy="48" r="10.5" className="ct-check-disc" />
              <path d="M253.5 48.2l3 3 6-6.2" className="ct-check-white" />
              <text x="276" y="41" textAnchor="start" dominantBaseline="central" className="ct-pod-title">
                {domain === "import-diagnose" ? bi("基线档案", "Archive") : bi("基线快照", "Baseline")}
              </text>
              <text x="276" y="56" textAnchor="start" dominantBaseline="central" className="ct-pod-sub ok">
                READY
              </text>
            </g>
          </svg>
        )}

        {scene === "guard" && (
          <svg viewBox="0 0 360 96" fill="none" className="rh-cartoon-svg">
            {/* Conveyor Track */}
            <line x1="12" y1="48" x2="348" y2="48" className="ct-dash-path is-moving" />

            {/* Incoming Raw Secret Pills (Left -> Shield Gate) */}
            <g className="ct-raw-pill p1">
              <rect x="14" y="34" width="84" height="28" rx="8" className="ct-pill-warn" />
              <circle cx="26" cy="48" r="3" className="ct-led warn" />
              <text x="35" y="48" textAnchor="start" dominantBaseline="central" className="ct-pill-warn-txt">
                {domain === "import-probe" ? "write/rm" : "pwd=••••"}
              </text>
            </g>
            <g className="ct-raw-pill p2">
              <rect x="14" y="34" width="80" height="28" rx="8" className="ct-pill-warn" />
              <circle cx="26" cy="48" r="3" className="ct-led warn" />
              <text x="35" y="48" textAnchor="start" dominantBaseline="central" className="ct-pill-warn-txt">
                {domain === "import-probe" ? "restart" : "ssh_key"}
              </text>
            </g>

            {/* Outgoing Sanitized Safe Pills (Shield Gate -> Right) */}
            <g className="ct-clean-pill p1">
              <rect x="196" y="34" width="88" height="28" rx="8" className="ct-pill-ok" />
              <circle cx="211" cy="48" r="6" className="ct-check-disc" />
              <path d="M208.3 48.1l1.9 1.9 3.7-3.9" className="ct-check-white sm" />
              <text x="223" y="48" textAnchor="start" dominantBaseline="central" className="ct-pill-ok-txt">
                {domain === "import-probe" ? bi("零写入", "Zero-Write") : bi("已脱敏", "Redacted")}
              </text>
            </g>
            <g className="ct-clean-pill p2">
              <rect x="196" y="34" width="90" height="28" rx="8" className="ct-pill-ok" />
              <circle cx="211" cy="48" r="6" className="ct-check-disc" />
              <path d="M208.3 48.1l1.9 1.9 3.7-3.9" className="ct-check-white sm" />
              <text x="223" y="48" textAnchor="start" dominantBaseline="central" className="ct-pill-ok-txt">
                {domain === "import-parse" ? bi("纯元数据", "Meta-Only") : bi("纯只读", "Read-Only")}
              </text>
            </g>

            {/* Central Security Shield Gate (Layered above pills) */}
            <g className="ct-shield-gate">
              <circle cx="180" cy="48" r="34" className="ct-gate-pulse" />
              <circle cx="180" cy="48" r="29" className="ct-gate-halo" />
              <line x1="180" y1="8" x2="180" y2="88" className="ct-gate-laser" />
              <path
                d="M180 21L159 29.8v14.8c0 12.2 8.8 22.4 21 25.8 12.2-3.4 21-13.6 21-25.8V29.8L180 21z"
                className="ct-shield-body"
              />
              <path d="M172.5 48.2l5 5 10.2-10.5" className="ct-shield-tick" />
            </g>
          </svg>
        )}

        {scene === "connect" && (
          <svg viewBox="0 0 360 96" fill="none" className="rh-cartoon-svg">
            {/* Signal Bridge & Concentric Ripples */}
            <line x1="86" y1="48" x2="274" y2="48" className="ct-bridge-line" />
            <circle cx="180" cy="48" r="18" className="ct-hs-ring r1" />
            <circle cx="180" cy="48" r="29" className="ct-hs-ring r2" />

            {/* Bidirectional Encrypted Data Packets */}
            <circle cx="104" cy="48" r="3.4" className="ct-pkt p1" />
            <circle cx="256" cy="48" r="3.4" className="ct-pkt p2" />

            {/* Left Hub Station Pod */}
            <g className="ct-endpoint left">
              <rect x="10" y="20" width="76" height="56" rx="11" className="ct-hub-pod" />
              <circle cx="22" cy="31" r="2.8" className="ct-led brand" />
              <text x="48" y="42" textAnchor="middle" dominantBaseline="central" className="ct-pod-title">
                HUB
              </text>
              <text x="48" y="58" textAnchor="middle" dominantBaseline="central" className="ct-pod-sub">
                {bi("平台底座", "Platform")}
              </text>
            </g>

            {/* Right AI Gateway Station Pod */}
            <g className="ct-endpoint right">
              <rect x="274" y="20" width="76" height="56" rx="11" className="ct-gw-pod" />
              <circle cx="286" cy="31" r="2.8" className="ct-led ok" />
              <text x="312" y="42" textAnchor="middle" dominantBaseline="central" className="ct-pod-title">
                AI GW
              </text>
              <text x="312" y="58" textAnchor="middle" dominantBaseline="central" className="ct-pod-sub">
                {bi("模型网关", "Gateway")}
              </text>
            </g>

            {/* Sleek Left Interlocking Handshake Link */}
            <g className="ct-hand-left">
              <rect x="92" y="41" width="28" height="14" rx="7" className="ct-sleeve-left" />
              <rect x="114" y="38" width="32" height="20" rx="10" className="ct-palm-left" />
              <circle cx="136" cy="48" r="3.2" className="ct-led brand" />
            </g>

            {/* Sleek Right Interlocking Handshake Link */}
            <g className="ct-hand-right">
              <rect x="240" y="41" width="28" height="14" rx="7" className="ct-sleeve-right" />
              <rect x="214" y="38" width="32" height="20" rx="10" className="ct-palm-right" />
              <circle cx="224" cy="48" r="3.2" className="ct-led ok" />
            </g>

            {/* Center Handshake Spark Star */}
            <g className="ct-hs-spark">
              <path
                d="M180 12l2.1 5.2 5.2 2.1-5.2 2.1-2.1 5.2-2.1-5.2-5.2-2.1 5.2-2.1 2.1-5.2z"
                className="ct-spark-star"
              />
            </g>
          </svg>
        )}

        {scene === "think" && domain === "import-parse" && (
          <svg viewBox="0 0 360 96" fill="none" className="rh-cartoon-svg">
            <defs>
              <linearGradient id="ct-cone-grad-imp" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.32" />
                <stop offset="100%" stopColor="var(--brand)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <g className="ct-hs-locked">
              <rect x="10" y="6" width="102" height="22" rx="11" className="ct-pill-ok" />
              <circle cx="22" cy="17" r="6.5" className="ct-check-disc" />
              <path d="M19 17.1l2.1 2.1 4.1-4.2" className="ct-check-white sm" />
              <text x="34" y="17" textAnchor="start" dominantBaseline="central" className="ct-pill-ok-txt">
                {bi("握手已连通", "Connected")}
              </text>
            </g>
            <path d="M108 69 L128 69 M220 69 L240 69" className="ct-flow-line" />
            <g className="ct-sim-node n1">
              <rect x="16" y="54" width="92" height="30" rx="8.5" className="ct-node-box" />
              <circle cx="30" cy="69" r="3.6" className="ct-led ok" />
              <text x="41" y="69" textAnchor="start" dominantBaseline="central" className="ct-sim-lbl">
                {bi("主机节点", "Hosts")}
              </text>
            </g>
            <g className="ct-sim-node n2">
              <rect x="128" y="54" width="92" height="30" rx="8.5" className="ct-node-box" />
              <circle cx="142" cy="69" r="3.6" className="ct-led brand" />
              <text x="153" y="69" textAnchor="start" dominantBaseline="central" className="ct-sim-lbl">
                {bi("伴生栈", "Stack")}
              </text>
            </g>
            <g className="ct-sim-node n3">
              <rect x="240" y="52" width="106" height="34" rx="9.5" className="ct-hub-pod" />
              <circle cx="255" cy="69" r="4" className="ct-led ok" />
              <text x="267" y="69" textAnchor="start" dominantBaseline="central" className="ct-pod-title">
                {bi("入口 VIP", "Endpoints")}
              </text>
            </g>
            <g className="ct-think-rover">
              <path d="M51 54 L62 41 L73 54 Z" fill="url(#ct-cone-grad-imp)" />
              <circle cx="62" cy="38" r="8.5" className="ct-rover-halo" />
              <circle cx="62" cy="38" r="4" className="ct-rover-core" />
              <line x1="62" y1="43" x2="62" y2="53" className="ct-rover-beam" />
            </g>
          </svg>
        )}

        {scene === "think" && domain === "import-probe" && (
          <svg viewBox="0 0 360 96" fill="none" className="rh-cartoon-svg">
            <defs>
              <linearGradient id="ct-cone-grad-prb" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.32" />
                <stop offset="100%" stopColor="var(--brand)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <g className="ct-hs-locked">
              <rect x="10" y="6" width="102" height="22" rx="11" className="ct-pill-ok" />
              <circle cx="22" cy="17" r="6.5" className="ct-check-disc" />
              <path d="M19 17.1l2.1 2.1 4.1-4.2" className="ct-check-white sm" />
              <text x="34" y="17" textAnchor="start" dominantBaseline="central" className="ct-pill-ok-txt">
                {bi("握手已连通", "Connected")}
              </text>
            </g>
            <path d="M150 69 L174 69 M262 69 L280 69" className="ct-flow-line" />
            <g className="ct-sim-node n1">
              <rect x="16" y="44" width="134" height="44" rx="8.5" className="ct-doc-sheet" />
              <text x="26" y="57" textAnchor="start" dominantBaseline="central" className="ct-mini-txt">
                #!/usr/bin/env bash
              </text>
              <line x1="26" y1="69" x2="118" y2="69" className="ct-draw-line l1" />
              <line x1="26" y1="79" x2="96" y2="79" className="ct-draw-line l2" />
            </g>
            <g className="ct-sim-node n2">
              <rect x="174" y="54" width="88" height="30" rx="8.5" className="ct-pill-ok" />
              <circle cx="187" cy="69" r="3.6" className="ct-led ok" />
              <text x="197" y="69" textAnchor="start" dominantBaseline="central" className="ct-pill-ok-txt">
                {bi("纯只读", "100% RO")}
              </text>
            </g>
            <g className="ct-sim-node n3">
              <rect x="280" y="54" width="68" height="30" rx="8.5" className="ct-node-box" />
              <circle cx="292" cy="69" r="3.4" className="ct-led brand" />
              <text x="301" y="69" textAnchor="start" dominantBaseline="central" className="ct-sim-lbl">
                {bi("脱敏", "Safe")}
              </text>
            </g>
            <g className="ct-think-rover">
              <path d="M51 44 L62 32 L73 44 Z" fill="url(#ct-cone-grad-prb)" />
              <circle cx="62" cy="30" r="8" className="ct-rover-halo" />
              <circle cx="62" cy="30" r="3.8" className="ct-rover-core" />
            </g>
          </svg>
        )}

        {scene === "think" && domain === "import-diagnose" && (
          <svg viewBox="0 0 360 96" fill="none" className="rh-cartoon-svg">
            <defs>
              <linearGradient id="ct-cone-grad-diag" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.32" />
                <stop offset="100%" stopColor="var(--brand)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <g className="ct-hs-locked">
              <rect x="10" y="6" width="102" height="22" rx="11" className="ct-pill-ok" />
              <circle cx="22" cy="17" r="6.5" className="ct-check-disc" />
              <path d="M19 17.1l2.1 2.1 4.1-4.2" className="ct-check-white sm" />
              <text x="34" y="17" textAnchor="start" dominantBaseline="central" className="ct-pill-ok-txt">
                {bi("握手已连通", "Connected")}
              </text>
            </g>
            <path d="M108 69 L128 69 M220 69 L240 69" className="ct-flow-line" />
            <g className="ct-sim-node n1">
              <rect x="16" y="54" width="92" height="30" rx="8.5" className="ct-node-box" />
              <circle cx="30" cy="69" r="3.6" className="ct-led ok" />
              <text x="41" y="69" textAnchor="start" dominantBaseline="central" className="ct-sim-lbl">
                {bi("复制机制", "Sync")}
              </text>
            </g>
            <g className="ct-sim-node n2">
              <rect x="128" y="54" width="92" height="30" rx="8.5" className="ct-node-box" />
              <circle cx="142" cy="69" r="3.6" className="ct-led warn" />
              <text x="153" y="69" textAnchor="start" dominantBaseline="central" className="ct-sim-lbl">
                {bi("容量水位", "Storage")}
              </text>
            </g>
            <g className="ct-sim-node n3">
              <rect x="240" y="52" width="106" height="34" rx="9.5" className="ct-hub-pod" />
              <circle cx="255" cy="69" r="4" className="ct-led brand" />
              <text x="267" y="69" textAnchor="start" dominantBaseline="central" className="ct-pod-title">
                {bi("高可用边界", "HA Rules")}
              </text>
            </g>
            <g className="ct-think-rover">
              <path d="M51 54 L62 41 L73 54 Z" fill="url(#ct-cone-grad-diag)" />
              <circle cx="62" cy="38" r="8.5" className="ct-rover-halo" />
              <circle cx="62" cy="38" r="4" className="ct-rover-core" />
              <line x1="62" y1="43" x2="62" y2="53" className="ct-rover-beam" />
            </g>
          </svg>
        )}

        {scene === "think" && domain === "rehearsal" && (
          <svg viewBox="0 0 360 96" fill="none" className="rh-cartoon-svg">
            <defs>
              <linearGradient id="ct-cone-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.32" />
                <stop offset="100%" stopColor="var(--brand)" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* Top-Left Connected Status Pill — generous spacing between vector tick & label */}
            <g className="ct-hs-locked">
              <rect x="10" y="6" width="102" height="22" rx="11" className="ct-pill-ok" />
              <circle cx="22" cy="17" r="6.5" className="ct-check-disc" />
              <path d="M19 17.1l2.1 2.1 4.1-4.2" className="ct-check-white sm" />
              <text x="34" y="17" textAnchor="start" dominantBaseline="central" className="ct-pill-ok-txt">
                {bi("握手已连通", "Connected")}
              </text>
            </g>

            {/* HA Cluster Topology Flow Track — drawn strictly in the inter-node gaps so lines never bleed across pills */}
            <path d="M108 69 L128 69 M220 69 L240 69" className="ct-flow-line" />

            {/* Replica 01 */}
            <g className="ct-sim-node n1">
              <rect x="16" y="54" width="92" height="30" rx="8.5" className="ct-node-box" />
              <circle cx="30" cy="69" r="3.6" className="ct-led ok" />
              <text x="41" y="69" textAnchor="start" dominantBaseline="central" className="ct-sim-lbl">
                {bi("从库 01", "Rep 01")}
              </text>
            </g>

            {/* Replica 02 */}
            <g className="ct-sim-node n2">
              <rect x="128" y="54" width="92" height="30" rx="8.5" className="ct-node-box" />
              <circle cx="142" cy="69" r="3.6" className="ct-led ok" />
              <text x="153" y="69" textAnchor="start" dominantBaseline="central" className="ct-sim-lbl">
                {bi("从库 02", "Rep 02")}
              </text>
            </g>

            {/* Guarded Primary */}
            <g className="ct-sim-node n3">
              <rect x="240" y="52" width="106" height="34" rx="9.5" className="ct-hub-pod" />
              <circle cx="255" cy="69" r="4" className="ct-led kyndryl" />
              <text x="267" y="69" textAnchor="start" dominantBaseline="central" className="ct-pod-title">
                {bi("主库守卫", "Primary")}
              </text>
            </g>

            {/* Roaming AI Reasoning Probe — orbits cleanly below top pill (cy=38) */}
            <g className="ct-think-rover">
              <path d="M51 54 L62 41 L73 54 Z" fill="url(#ct-cone-grad)" />
              <circle cx="62" cy="38" r="8.5" className="ct-rover-halo" />
              <circle cx="62" cy="38" r="4" className="ct-rover-core" />
              <line x1="62" y1="43" x2="62" y2="53" className="ct-rover-beam" />
            </g>
          </svg>
        )}

        {scene === "synthesize" && (
          <svg viewBox="0 0 360 96" fill="none" className="rh-cartoon-svg">
            {/* Structured Output Document Sheet */}
            <rect x="14" y="10" width="196" height="76" rx="10" className="ct-doc-sheet" />
            <circle cx="30" cy="26" r="3.6" className="ct-led ok" />
            <line x1="42" y1="26" x2="164" y2="26" className="ct-draw-line l1" />
            <circle cx="30" cy="42" r="3.6" className="ct-led brand" />
            <line x1="42" y1="42" x2="190" y2="42" className="ct-draw-line l2" />
            <circle cx="30" cy="58" r="3.6" className="ct-led ok" />
            <line x1="42" y1="58" x2="156" y2="58" className="ct-draw-line l3" />
            <circle cx="30" cy="74" r="3.4" className="ct-led warn" />
            <line x1="42" y1="74" x2="134" y2="74" className="ct-draw-line l4" />

            {/* Centered Verification Seal Impact */}
            <circle cx="286" cy="48" r="26" className="ct-seal-ring" />
            <g className="ct-stamp-badge">
              <rect x="226" y="22" width="120" height="52" rx="12" className="ct-pill-ok" />
              <circle cx="246" cy="48" r="10" className="ct-check-disc" />
              <path d="M241.5 48.2l3 3 5.8-6" className="ct-check-white" />
              <text x="263" y="40" textAnchor="start" dominantBaseline="central" className="ct-pill-ok-txt lg">
                {domain === "import-parse"
                  ? "DRAFT"
                  : domain === "import-probe"
                    ? "100% RO"
                    : domain === "import-diagnose"
                      ? "AUDIT"
                      : "SAFE"}
              </text>
              <text x="263" y="56" textAnchor="start" dominantBaseline="central" className="ct-mini-ok">
                {domain === "import-parse"
                  ? bi("拓扑草稿就绪", "Draft Ready")
                  : domain === "import-probe"
                    ? bi("静态只读通过", "RO Verified")
                    : domain === "import-diagnose"
                      ? bi("补采清单就绪", "Checklist Ready")
                      : bi("安全校验通过", "Verified")}
              </text>
            </g>
          </svg>
        )}

        {scene === "error" && (
          <svg viewBox="0 0 360 96" fill="none" className="rh-cartoon-svg">
            {/* Preserved Draft Pod */}
            <rect x="12" y="22" width="102" height="52" rx="11" className="ct-hub-pod" />
            <circle cx="30" cy="48" r="9" className="ct-check-disc" />
            <path d="M26 48.2l2.7 2.7 5.2-5.4" className="ct-check-white" />
            <text x="46" y="40" textAnchor="start" dominantBaseline="central" className="ct-pod-title">
              {bi("草稿完好", "Draft OK")}
            </text>
            <text x="46" y="56" textAnchor="start" dominantBaseline="central" className="ct-mini-ok">
              {bi("已安全保护", "Preserved")}
            </text>

            <line x1="118" y1="48" x2="148" y2="48" className="ct-broken-line" />
            <line x1="212" y1="48" x2="242" y2="48" className="ct-broken-line" />

            {/* Central Circuit-Breaker Shield */}
            <circle cx="180" cy="48" r="27" className="ct-err-halo" />
            <path
              d="M180 25L160 33.4v13.8c0 11.4 8.2 20.8 20 24 11.8-3.2 20-12.6 20-24V33.4L180 25z"
              className="ct-err-shield"
            />
            <path d="M180 38v11M180 54.5h.01" className="ct-err-bang" />

            {/* Blocked AI Gateway Pod */}
            <rect x="246" y="22" width="102" height="52" rx="11" className="ct-err-pod" />
            <circle cx="264" cy="48" r="4.5" className="ct-led bad" />
            <text x="276" y="40" textAnchor="start" dominantBaseline="central" className="ct-err-pod-title">
              {bi("AI 网关", "AI GW")}
            </text>
            <text x="276" y="56" textAnchor="start" dominantBaseline="central" className="ct-err-pod-sub">
              {bi("响应受阻", "Blocked")}
            </text>
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
});

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
    // Never split right after a digit+dot (IP addresses like 172.30.4.26 or versions like 17.11.1)
    if (/\d\.$/.test(before)) {
      continue;
    }
    const afterPunct = /(?:[。；！？;!?]\s*|\.\s+)$/.test(before);
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

export function renderThinkingInline(text: string): React.ReactNode {
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
      const inner = rawTok.slice(1, -1);
      out.push(
        <code
          key={k++}
          className={`rh-think-code mono${inner.length <= 24 ? " is-atom" : ""}`}
        >
          {inner}
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
          <code
            key={k++}
            className={`rh-think-code mono${cleanTok.length <= 24 ? " is-atom" : ""}`}
          >
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

export const RehearsalThinkingContent = React.memo(function RehearsalThinkingContent({
  text,
  streaming = false,
  compact = false,
}: {
  text: string;
  streaming?: boolean;
  compact?: boolean;
}) {
  const blocks = useMemo(() => parseThinkingBlocks(text), [text]);
  if (!blocks.length) {
    const trimmed = (text || "").trim();
    if (!trimmed) return null;
    return (
      <div className={`rh-think-flow ${compact ? "is-compact" : ""}`}>
        <p className="rh-think-para is-single">
          {renderThinkingInline(trimmed)}
          {streaming && <span className="rh-ai-caret" aria-hidden />}
        </p>
      </div>
    );
  }

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
});

export function RehearsalAIProcess({
  live,
  trace,
  title,
  defaultOpen = false,
  onAbort,
  onRetry,
  onDismiss,
  extraErrorActions,
}: {
  live?: LiveAIState | null;
  trace?: RehearsalTrace | null;
  title: string;
  defaultOpen?: boolean;
  onAbort?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
  extraErrorActions?: React.ReactNode;
}) {
  useLang();
  const [open, setOpen] = useState(defaultOpen || Boolean(live));
  const [rawDiagOpen, setRawDiagOpen] = useState(false);
  const [slowHandshake, setSlowHandshake] = useState(false);
  const [playState, setPlayState] = useState<{
    startedAt: number;
    idx: number;
    enteredAt: number;
  }>(() => {
    const resuming = Boolean(live && Date.now() - live.startedAt > 1000);
    return {
      startedAt: live?.startedAt ?? 0,
      idx: live && (live.error || resuming) ? computeTargetStepIndex(live.steps) : 0,
      enteredAt: Date.now(),
    };
  });
  const procRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledStartRef = useRef<number>(0);
  const thinkBoxRef = useRef<HTMLDivElement | null>(null);
  const thinkStickRef = useRef<boolean>(true);
  const thinkScrollRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  const hasLive = Boolean(live);
  const liveStartedAt = live?.startedAt ?? 0;
  const hasLiveError = Boolean(live?.error);

  useEffect(() => {
    setRawDiagOpen(false);
    thinkStickRef.current = true;
  }, [liveStartedAt]);

  useEffect(() => {
    if (!liveStartedAt || lastScrolledStartRef.current === liveStartedAt) {
      return;
    }
    lastScrolledStartRef.current = liveStartedAt;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const alignIntoSafeViewport = () => {
      const el = procRef.current;
      if (!el || typeof window === "undefined") return;
      const rect = el.getBoundingClientRect();
      const safeTop = 104;
      const safeBottom = window.innerHeight - 24;
      if (rect.top < safeTop || rect.bottom > safeBottom) {
        el.scrollIntoView({
          behavior: reduced ? "auto" : "smooth",
          block: rect.top < safeTop ? "start" : "nearest",
        });
      }
    };
    const timer = window.setTimeout(alignIntoSafeViewport, reduced ? 0 : 120);
    return () => window.clearTimeout(timer);
  }, [liveStartedAt]);

  useEffect(() => {
    if (hasLive) {
      setOpen(true);
    }
  }, [hasLive, liveStartedAt]);

  const targetIdx = useMemo(
    () => (live ? computeTargetStepIndex(live.steps) : 0),
    [live?.steps],
  );

  // Stage-by-stage choreography sequencer:
  // Fast local steps animate one-by-one (~260ms each), then hold honestly on
  // Step 3 ("connect-model") until the upstream LLM handshakes/returns tokens.
  // Depends ONLY on scalar primitives & targetIdx so high-frequency SSE chunks
  // (think/progress/phase) NEVER cancel the step-advance timer!
  useEffect(() => {
    if (!hasLive) return;
    if (playState.startedAt !== liveStartedAt) {
      const resuming = Date.now() - liveStartedAt > 1000;
      setPlayState({
        startedAt: liveStartedAt,
        idx: hasLiveError || resuming ? targetIdx : 0,
        enteredAt: Date.now(),
      });
      return;
    }
    if (hasLiveError && playState.idx !== targetIdx) {
      setPlayState((prev) => ({
        ...prev,
        idx: targetIdx,
        enteredAt: Date.now(),
      }));
      return;
    }
    if (playState.idx >= targetIdx) return;
    const minHold = targetIdx >= 3 ? 140 : 260;
    const elapsed = Date.now() - playState.enteredAt;
    if (elapsed >= minHold) {
      setPlayState((prev) => {
        if (prev.startedAt !== liveStartedAt || prev.idx >= targetIdx) return prev;
        return {
          startedAt: prev.startedAt,
          idx: prev.idx + 1,
          enteredAt: Date.now(),
        };
      });
      return;
    }
    const wait = minHold - elapsed;
    const timer = window.setTimeout(() => {
      setPlayState((prev) => {
        if (prev.startedAt !== liveStartedAt || prev.idx >= targetIdx) return prev;
        return {
          startedAt: prev.startedAt,
          idx: prev.idx + 1,
          enteredAt: Date.now(),
        };
      });
    }, wait);
    return () => window.clearTimeout(timer);
  }, [
    hasLive,
    liveStartedAt,
    hasLiveError,
    playState.startedAt,
    playState.idx,
    playState.enteredAt,
    targetIdx,
  ]);

  const activeLivePlayIdx = live
    ? live.error
      ? targetIdx
      : playState.startedAt === live.startedAt
        ? playState.idx
        : 0
    : 0;
  const activeLiveStepId = live
    ? live.steps[
        Math.min(
          Math.max(activeLivePlayIdx, 0),
          Math.max(live.steps.length - 1, 0),
        )
      ]?.id || ""
    : "";
  const activeStepEnteredAt = live
    ? playState.startedAt === live.startedAt
      ? playState.enteredAt
      : live.startedAt
    : 0;
  const liveThinkingConsoleVisible = Boolean(
    live && !live.error && activeLivePlayIdx >= 3,
  );

  // One-shot 25s slow-handshake notice without 120ms full-tree polling
  useEffect(() => {
    if (
      !hasLive ||
      hasLiveError ||
      activeLiveStepId !== "connect-model" ||
      !activeStepEnteredAt
    ) {
      setSlowHandshake(false);
      return;
    }
    const elapsed = Date.now() - activeStepEnteredAt;
    if (elapsed >= 25000) {
      setSlowHandshake(true);
      return;
    }
    setSlowHandshake(false);
    const timer = window.setTimeout(
      () => setSlowHandshake(true),
      25000 - elapsed,
    );
    return () => window.clearTimeout(timer);
  }, [hasLive, hasLiveError, activeLiveStepId, activeStepEnteredAt]);

  // Passive scroll listener to respect user scroll-up lock while reading live thoughts
  useEffect(() => {
    if (!liveThinkingConsoleVisible) return;
    const el = thinkBoxRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      thinkStickRef.current = dist <= 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [liveThinkingConsoleVisible, liveStartedAt]);

  // Coalesce streaming auto-scroll via requestAnimationFrame (zero synchronous layout thrash)
  useEffect(() => {
    if (
      !live?.thinking ||
      !liveThinkingConsoleVisible ||
      !thinkStickRef.current ||
      !thinkBoxRef.current
    ) {
      return;
    }
    if (thinkScrollRafRef.current !== null) return;
    thinkScrollRafRef.current = window.requestAnimationFrame(() => {
      thinkScrollRafRef.current = null;
      const el = thinkBoxRef.current;
      if (el && thinkStickRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, [live?.thinking, liveThinkingConsoleVisible]);

  useEffect(() => {
    return () => {
      if (thinkScrollRafRef.current !== null) {
        window.cancelAnimationFrame(thinkScrollRafRef.current);
        thinkScrollRafRef.current = null;
      }
    };
  }, []);

  if (live) {
    const steps = live.steps;
    const hasError = Boolean(live.error);
    const activePlayIdx = activeLivePlayIdx;
    const stepEnteredAt = activeStepEnteredAt;
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
      !hasError && currentStep?.id === "connect-model" && slowHandshake;
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
            <b>{hasError ? bi("AI 推演通道受阻", "AI Pipeline Interrupted") : live.title}</b>
            {steps.length > 0 && (
              <span
                className={`rh-ai-stage-pill num ${hasError ? "is-error" : ""}`}
              >
                {hasError
                  ? bi(
                      `中断于阶段 ${stageHumanIdx}/${steps.length}`,
                      `Stopped at ${stageHumanIdx}/${steps.length}`,
                    )
                  : bi(
                      `阶段 ${stageHumanIdx}/${steps.length}`,
                      `Stage ${stageHumanIdx}/${steps.length}`,
                    )}
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
                    <span className="rh-ai-chip-fb">
                      {bi("备用节点", "Fallback")}
                    </span>
                  </>
                )}
              </span>
            )}
            {live.chars > 0 && showThinkingConsole && (
              <span className="rh-ai-chip num">
                {bi(
                  `已输出 ${live.chars.toLocaleString("en-US")} 字`,
                  `${live.chars.toLocaleString("en-US")} chars`,
                )}
              </span>
            )}
          </div>
          <div className="rh-ai-head-right">
            <LiveElapsedSpan
              startedAt={live.startedAt}
              endedAt={hasError ? live.errorAt || live.startedAt : undefined}
              suffix="s"
              className={`rh-ai-timer num ${hasError ? "is-error" : ""}`}
            />
            {!hasError && onAbort && (
              <button
                type="button"
                className="rh-ai-stop"
                onClick={onAbort}
                title={bi("停止当前生成", "Stop generation")}
              >
                <IconRecordStop />
                <span>{bi("停止", "Stop")}</span>
              </button>
            )}
            {hasError && onDismiss && (
              <button
                type="button"
                className="rh-ai-dismiss-top"
                onClick={onDismiss}
                title={bi("收起提示", "Dismiss")}
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
                        ? bi(
                            "因前序模型连接受阻，本环节未执行",
                            "Skipped due to upstream connection failure",
                          )
                        : pendingHintForStep(st, live.kind)
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
                                ? bi("连接受阻", "Blocked")
                                : vStatus === "warn"
                                  ? bi("需留意", "Warning")
                                  : vStatus === "running"
                                    ? st.id === "connect-model"
                                      ? (
                                          <>
                                            {bi("握手 ", "Handshake ")}
                                            <LiveElapsedSpan
                                              startedAt={stepEnteredAt}
                                              suffix="s"
                                            />
                                          </>
                                        )
                                      : bi("进行中", "Running")
                                    : hasError
                                      ? bi("已中止", "Aborted")
                                      : bi("待执行", "Pending")}
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
              kind={live.kind}
              scene={cartoonScene}
              stepTitle={currentStep?.title || live.title}
              stepDetail={currentStep?.detail}
              provider={live.provider}
              model={live.model}
              waitStartedAt={
                !hasError && currentStep?.id === "connect-model"
                  ? stepEnteredAt
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
                      <span>{bi("通道实时动态", "Live Channel Status")}</span>
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
                      bi(
                        "正在准备集群架构上下文并建立流式推演通道…",
                        "Preparing cluster architecture context & opening AI stream…",
                      )}
                  </p>
                  <Smooth>
                    {isSlowHandshake && (
                      <div className="rh-pstep-slow">
                        {bi("已等待 ", "Waiting ")}
                        <LiveElapsedSpan
                          startedAt={stepEnteredAt}
                          integer
                          suffix="s"
                          className="num"
                        />
                        {bi(
                          " 暂未收到正文首字（开启深度思考或中转网关自动重试上游渠道时，首包等待 20～90s 属正常现象；若使用中转网关调用 Claude 等非 OpenAI 模型，建议在「设置 → AI」将接口方式设为 Chat Completions 以直连流式输出）。",
                          " for first token (20–90s is normal with deep reasoning or proxy retries; for non-OpenAI models via proxy gateways, try setting API mode to Chat Completions in Settings → AI).",
                        )}
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
                  <span>
                    {bi(
                      "自动剥离口令与私钥 · 仅投递架构拓扑与非敏感参数",
                      "Passwords & keys scrubbed · Topology & non-sensitive params only",
                    )}
                  </span>
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
                        {bi(
                          `已尝试兼容回退 ${diag.fallback_used}`,
                          `Fallback tried: ${diag.fallback_used}`,
                        )}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="rh-err-copy-btn"
                    onClick={() => void copy(formatDiagReport(live, diag))}
                    title={bi(
                      "复制完整脱敏诊断 JSON",
                      "Copy full redacted diagnostic JSON",
                    )}
                  >
                    <IconCopy />
                    <span>{bi("复制完整诊断", "Copy Diagnostics")}</span>
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
                        <dt>{bi("协议端点", "Endpoint")}</dt>
                        <dd className="mono">{diag.endpoint}</dd>
                      </div>
                    )}
                    {(diag.http_status !== undefined ||
                      diag.upstream_status ||
                      diag.reason_code) && (
                      <div className="rh-err-kv">
                        <dt>{bi("HTTP 状态", "HTTP Status")}</dt>
                        <dd className="num">
                          {diag.http_status && diag.http_status > 0
                            ? `HTTP ${diag.http_status}`
                            : bi("网络层中断", "Network error")}
                          {diag.upstream_status
                            ? ` · ${diag.upstream_status}`
                            : ""}
                        </dd>
                      </div>
                    )}
                    {Boolean(diag.ms && diag.ms > 0) && (
                      <div className="rh-err-kv">
                        <dt>{bi("耗时", "Duration")}</dt>
                        <dd className="num">{fmtStepDuration(diag.ms)}</dd>
                      </div>
                    )}
                    {hasTokens && (
                      <div className="rh-err-kv">
                        <dt>{bi("Token 计量", "Tokens")}</dt>
                        <dd className="num">
                          {bi(
                            `输入 ${(diag.in_tokens ?? 0).toLocaleString("en-US")} · 缓存 ${(diag.cached_tokens ?? 0).toLocaleString("en-US")} · 输出 ${(diag.out_tokens ?? 0).toLocaleString("en-US")}`,
                            `In ${(diag.in_tokens ?? 0).toLocaleString("en-US")} · Cached ${(diag.cached_tokens ?? 0).toLocaleString("en-US")} · Out ${(diag.out_tokens ?? 0).toLocaleString("en-US")}`,
                          )}
                        </dd>
                      </div>
                    )}
                    {diag.response_id && (
                      <div className="rh-err-kv">
                        <dt>{bi("上游响应 ID", "Upstream ID")}</dt>
                        <dd>
                          <button
                            type="button"
                            className="rh-err-copy-id mono"
                            onClick={() => void copy(diag.response_id!)}
                            title={bi(
                              "点击复制上游响应 ID",
                              "Click to copy upstream response ID",
                            )}
                          >
                            <span>{diag.response_id}</span>
                            <IconCopy />
                          </button>
                        </dd>
                      </div>
                    )}
                    {hasSSE && (
                      <div className="rh-err-kv is-wide">
                        <dt>{bi("SSE 事件链", "SSE Events")}</dt>
                        <dd
                          className={
                            diag.sse_events && diag.sse_events.length > 0
                              ? "mono"
                              : undefined
                          }
                        >
                          {diag.sse_events && diag.sse_events.length > 0
                            ? diag.sse_events.join(" → ")
                            : bi("无数据帧", "No data frames")}
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
                      {bi(
                        `自动重试与回退链路（${diag.attempts.length} 次尝试）`,
                        `Retry & fallback chain (${diag.attempts.length} attempts)`,
                      )}
                    </span>
                    <ol className="rh-err-attempt-list">
                      {diag.attempts.map((att, aIdx) => {
                        const outcome = describeAttemptOutcome(att);
                        const httpLabel =
                          att.http_status && att.http_status > 0
                            ? `HTTP ${att.http_status}`
                            : bi("网络中断", "Network error");
                        const isBad = !att.http_status || att.http_status >= 400;
                        const hasAttTok =
                          typeof att.in_tokens === "number" ||
                          typeof att.out_tokens === "number";
                        const tokPart = hasAttTok
                          ? bi(
                              `输入 ${(att.in_tokens ?? 0).toLocaleString("en-US")}${
                                att.cached_tokens
                                  ? ` (缓存 ${att.cached_tokens.toLocaleString("en-US")})`
                                  : ""
                              } / 输出 ${(att.out_tokens ?? 0).toLocaleString("en-US")}`,
                              `In ${(att.in_tokens ?? 0).toLocaleString("en-US")}${
                                att.cached_tokens
                                  ? ` (${att.cached_tokens.toLocaleString("en-US")} cached)`
                                  : ""
                              } / Out ${(att.out_tokens ?? 0).toLocaleString("en-US")}`,
                            )
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
                              <span>
                                {bi("请求参数摘要（已脱敏）", "Request Summary (Redacted)")}
                              </span>
                              <button
                                type="button"
                                className="rh-err-raw-mini-copy"
                                onClick={() => void copy(diag.request_summary!)}
                              >
                                <IconCopy />
                                <span>{bi("复制", "Copy")}</span>
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
                              <span>
                                {bi("网关原始响应 / SSE 报文", "Raw Gateway Response / SSE")}
                              </span>
                              <button
                                type="button"
                                className="rh-err-raw-mini-copy"
                                onClick={() => void copy(diag.response_raw!)}
                              >
                                <IconCopy />
                                <span>{bi("复制", "Copy")}</span>
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
                      {bi("重新发起", "Retry")}
                    </Button>
                  )}
                  {extraErrorActions}
                  {errGuide.suggestSettings && can("ai.settings|ai.usage") && (
                    <>
                      <Button
                        size="small"
                        type="secondary"
                        onClick={() => go({ name: "settings", id: "ai" })}
                      >
                        {bi("前往 AI 设置切换模型", "Switch Model in AI Settings")}
                      </Button>
                      <Button
                        size="small"
                        type="secondary"
                        onClick={() => go({ name: "settings", id: "ai-usage" })}
                      >
                        {bi("查看 AI 用量明细", "View AI Usage")}
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
                          ? bi("收起网关原始诊断报文", "Hide Raw Gateway Diagnostics")
                          : bi("查看网关原始诊断报文", "View Raw Gateway Diagnostics")}
                      </span>
                      {rawDiagOpen ? <IconUp /> : <IconDown />}
                    </button>
                  )}
                  {onDismiss && (
                    <Button size="small" type="text" onClick={onDismiss}>
                      {bi("收起提示", "Dismiss")}
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
                    <span>{bi("AI 实时思考推演", "AI Live Reasoning")}</span>
                  </span>
                  {activePlayIdx >= 4 && (
                    <span className="rh-ai-think-done-tag">
                      {bi("推演已收敛", "Converged")}
                    </span>
                  )}
                </div>
                <div className="rh-ai-think-box" ref={thinkBoxRef}>
                  {live.thinking && live.thinking.trim() ? (
                    <RehearsalThinkingContent
                      text={live.thinking}
                      streaming={activePlayIdx === 3}
                    />
                  ) : activePlayIdx >= 4 ? (
                    <p className="rh-ai-think-wait">
                      {bi(
                        `模型已完成思考收敛，正在组装与校验结构化方案${
                          live.chars > 0
                            ? `（已接收 ${live.chars.toLocaleString("en-US")} 字）`
                            : ""
                        }…`,
                        `Reasoning converged; assembling & validating structured output${
                          live.chars > 0
                            ? ` (${live.chars.toLocaleString("en-US")} chars received)`
                            : ""
                        }…`,
                      )}
                      <span className="rh-ai-caret" aria-hidden />
                    </p>
                  ) : (
                    <p className="rh-ai-think-wait">
                      {stageDomainOf(live.kind) === "import-parse"
                        ? bi(
                            "已接收模型流式通道，正在从终端回显与截图中识别主机角色、伴生组件栈与访问入口…",
                            "Stream connected; extracting hosts, companion stack & access endpoints…",
                          )
                        : stageDomainOf(live.kind) === "import-probe"
                          ? bi(
                              "已接收模型流式通道，正在按所选现场场景编排精炼 100% 只读采集命令…",
                              "Stream connected; crafting tailored 100% read-only probe commands…",
                            )
                          : stageDomainOf(live.kind) === "import-diagnose"
                            ? bi(
                                "已接收模型流式通道，正在对照高可用与演练标准扫描架构基线盲区…",
                                "Stream connected; scanning baseline blind spots against HA & rehearsal standards…",
                              )
                            : bi(
                                "已接收模型流式通道，正在解码架构风险与变更边界推演…",
                                "Stream connected; decoding architecture risks & boundary analysis…",
                              )}
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
          ? bi(`${steps.length} 步通过`, `${steps.length} passed`)
          : bi(`${steps.length} 步记录`, `${steps.length} steps`)}
      </span>,
    );
  }
  if (dur) {
    metaItems.push(
      <span key="dur" className="rh-ai-meta-item num">
        {bi(`耗时 ${dur}`, dur)}
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
          <span>{bi("AI 架构研判与思考路径", "AI Reasoning & Risk Assessment")}</span>
        </span>
        {thinkStepCount >= 2 && (
          <span className="rh-ai-think-count num">
            {bi(`${thinkStepCount} 项研判要点`, `${thinkStepCount} key points`)}
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
              title={bi(
                `上游 Responses 协议返回空内容或不兼容，已自动降级完成调用（${fallbackUsed}）`,
                `Upstream Responses API returned empty or unsupported output; fell back automatically (${fallbackUsed})`,
              )}
            >
              {fallbackUsed.includes("chat")
                ? bi("已自动回退兼容 Chat Completions", "Fallback to Chat Completions")
                : bi(`已自动兼容回退 (${fallbackUsed})`, `Auto fallback (${fallbackUsed})`)}
            </span>
          )}
        </div>
        <div className="rh-ai-head-right">
          <span className="rh-ai-toggle-txt">
            {open ? bi("收起推演", "Collapse") : bi("查看完整推演", "View reasoning")}
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


export const AIProcessCard = RehearsalAIProcess;

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
  Checkbox,
  Dropdown,
  Input,
  Menu,
  Message,
  Modal,
  Popconfirm,
  Skeleton,
  Tag,
  Tooltip,
  Upload,
} from "@arco-design/web-react";
import {
  IconApps,
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
  IconMore,
  IconPlus,
  IconRecordStop,
  IconRefresh,
  IconRight,
  IconSearch,
  IconShareExternal,
  IconShrink,
  IconUp,
  IconUpload,
} from "@arco-design/web-react/icon";
import { VexTriageEditor } from "./vextriage";
import {
  ImportTemplateBar,
  PropagateRehearsalModal,
  RolloutBoardDrawer,
  RolloutProgressStrip,
  type RolloutBoardResponse,
} from "./rehearsal_rollout";
import {
  ApiError,
  ago,
  api,
  cached,
  can,
  copy,
  csrfToken,
  toPasteSafeShell,
  unwrapOuterPasteGroup,
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
  RehearsalAppliedChange,
  RehearsalSecurityContext,
  RehearsalStep,
  RehearsalStepCommand,
  RehearsalTrace,
  RehearsalTraceStep,
  ScopeQuestion,
} from "./shared";
import { SchemeInfo, schemeName } from "./scheme";
import { go } from "./router";
import { Segmented, Smooth } from "./ui";
import { REHEARSAL_CHANGED, Spark, useAIDock } from "./aichat";
import { ModelPicker, useModelPick } from "./modelpick";
import { ThinkLevel, useAIOptions, useSpaciousComposer } from "./aitools";
import { bi, biv, getLang, useLang, withLang } from "./i18n";
import {
  REHEARSAL_INTENT_EVENT,
  REHEARSAL_INTENT_KEY,
  hasRehearsalIntentFor,
  launchRehearsalIntent,
  launchSecurityRehearsalIntent,
} from "./rehearsal_intent";
import {
  abortRehearsalTask,
  clearRehearsalTask,
  getRehearsalTask,
  hasRunningTaskForSession,
  isRehearsalTaskLive,
  rehearsalTaskKey,
  startRehearsalTask,
  useActiveRehearsalTasks,
  useRehearsalTask,
} from "./rehearsal_live";
import type {
  RehearsalIntentPayload,
  RehearsalModeChoice,
  RehearsalPresetKind,
  RehearsalSourceContext,
} from "./rehearsal_intent";
export {
  launchRehearsalIntent,
  launchSecurityRehearsalIntent,
  type RehearsalModeChoice,
  type RehearsalPresetKind,
};
import "./rehearsal.css";

const STAGE_ORDER: ChangeRehearsal["stage"][] = [
  "scoping",
  "probing",
  "rehearsing",
  "finalized",
];

const LIGHT_STAGE_ORDER: ChangeRehearsal["stage"][] = [
  "probing",
  "rehearsing",
  "finalized",
];

const QUICK_STAGE_ORDER: ChangeRehearsal["stage"][] = [
  "rehearsing",
  "finalized",
];

const STAGE_META: Record<
  ChangeRehearsal["stage"],
  { short: string; title: string; sub: string }
> = {
  scoping: {
    get short() {
      return bi("边界对齐", "Scope Alignment");
    },
    get title() {
      return bi("变更诉求与边界对齐", "Change Scope & Boundary");
    },
    get sub() {
      return bi("确认维护窗口与高可用约束", "Confirm maintenance window & HA");
    },
  },
  probing: {
    get short() {
      return bi("只读探针", "Read-Only Probe");
    },
    get title() {
      return bi("现场只读采集与漂移识别", "Live Probe & Drift Detection");
    },
    get sub() {
      return bi("零修改采集生产真实角色与参数", "Collect live roles & params safely");
    },
  },
  rehearsing: {
    get short() {
      return bi("测试演练", "Test Rehearsal");
    },
    get title() {
      return bi("测试环境分步验证", "Step-by-Step Verification");
    },
    get sub() {
      return bi("逐步实测耗时并就地排障修订", "Measure timings & fix inline");
    },
  },
  finalized: {
    get short() {
      return bi("生产 SOP", "Production SOP");
    },
    get title() {
      return bi("生产变更实施方案", "Production Change SOP");
    },
    get sub() {
      return bi("映射生产节点并导出 Word", "Map prod nodes & export Word");
    },
  },
};

const LIGHT_STAGE_META: Record<
  ChangeRehearsal["stage"],
  { short: string; title: string; sub: string }
> = {
  scoping: STAGE_META.scoping,
  probing: {
    get short() {
      return bi("极简探针", "Quick Probe");
    },
    get title() {
      return bi("现场只读快采与状态核实", "Quick Read-Only Live Check");
    },
    get sub() {
      return bi("一屏采集核心状态，零修改生产", "Single-screen read-only check");
    },
  },
  rehearsing: {
    get short() {
      return bi("快速验证", "Quick Verify");
    },
    get title() {
      return bi("3～5 步精简执行与验证", "Concise 3–5 Step Verification");
    },
    get sub() {
      return bi("粘贴输出或截图，AI 自动判定通过", "Paste output/image for AI verdict");
    },
  },
  finalized: {
    get short() {
      return bi("变更报告", "Change Report");
    },
    get title() {
      return bi("集群变更报告已归档", "Change Report Archived");
    },
    get sub() {
      return bi("留档可追溯，支持导出 Word", "Archived & Word exportable");
    },
  },
};

const QUICK_STAGE_META: Record<
  ChangeRehearsal["stage"],
  { short: string; title: string; sub: string }
> = {
  scoping: STAGE_META.scoping,
  probing: LIGHT_STAGE_META.probing,
  rehearsing: {
    get short() {
      return bi("执行与核验", "Execute & Verify");
    },
    get title() {
      return bi("2～3 步极速执行与核验", "2–3 Step Quick Execution");
    },
    get sub() {
      return bi("按步骤执行并贴回输出，AI 自动验收", "Run steps & paste output for AI check");
    },
  },
  finalized: {
    get short() {
      return bi("变更报告", "Change Report");
    },
    get title() {
      return bi("集群变更报告已归档", "Change Report Archived");
    },
    get sub() {
      return bi("写入集群文档，支持导出 Word", "Saved to Cluster Docs & Word export");
    },
  },
};

const PHASE_LABEL: Record<RehearsalStep["phase"], string> = {
  get precheck() {
    return bi("预检", "Precheck");
  },
  get execute() {
    return bi("执行", "Execute");
  },
  get verify() {
    return bi("验收", "Verify");
  },
  get rollback() {
    return bi("回退", "Rollback");
  },
};

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/* ---------- Streaming SSE State & Client ---------- */

type LivePipelineKind =
  | "create"
  | "create-quick"
  | "create-light"
  | "scope"
  | "probe"
  | "verify"
  | "troubleshoot";

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
        title: bi("锁定变更边界与窗口约束", "Lock scope & window constraints"),
        detail: bi(
          "对齐维护窗口前提，装载组件巡检规则字典…",
          "Aligning window constraints & loading check rules…",
        ),
        ok: true,
        status: "running",
      },
      {
        id: "inject-ro-policy",
        kind: "guard",
        title: bi("注入纯只读安全红线规则", "Inject read-only safety guardrails"),
        detail: bi(
          "锁定零修改、零服务控制、零文件重定向及凭据过滤约束",
          "Enforcing zero-write, zero-restart, zero-redirect & secret masking",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "connect-model",
        kind: "connect",
        title: bi("连接模型网关与投递上下文", "Connect model gateway & send context"),
        detail: bi(
          "等待前序安全校验完成后建立模型流式连接",
          "Waiting for safety checks before opening AI stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "model-think",
        kind: "think",
        title: bi("设计生产现场纯只读采集策略", "Design read-only live probe strategy"),
        detail: bi(
          "等待模型通道返回首包后展开推演",
          "Waiting for first token from model stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "readonly-ast-guard",
        kind: "guard",
        title: bi("生成探针与静态安全红线扫描", "Generate probe & run safety AST scan"),
        detail: bi(
          "等待脚本编写完成后执行 15 类高危写操作静态扫描",
          "Scanning generated script against 15 write-op rules",
        ),
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
        title: bi("解析现场采集证据与交付基线", "Parse probe evidence & baseline"),
        detail: bi(
          "提取现场回显/截图与集群初始交付拓扑…",
          "Extracting probe outputs, images & initial topology…",
        ),
        ok: true,
        status: "running",
      },
      {
        id: "scrub-probe",
        kind: "guard",
        title: bi("现场回显敏感凭据二次脱敏", "Second-pass secret scrubbing"),
        detail: bi(
          "自动擦除回显中的口令、密钥与连接串",
          "Redacting passwords, keys & DSNs in probe output",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "connect-model",
        kind: "connect",
        title: bi("连接模型网关与投递上下文", "Connect model gateway & send context"),
        detail: bi(
          "等待脱敏完成后建立模型流式连接",
          "Waiting for redaction before opening AI stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "model-think",
        kind: "think",
        title: bi("逐节点比对拓扑角色与参数漂移", "Compare node roles & param drift"),
        detail: bi(
          "等待模型通道返回首包后展开推演",
          "Waiting for first token from model stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "build-rehearsal-plan",
        kind: "synthesize",
        title: bi("完成漂移诊断与分步演练编排", "Build drift report & rehearsal plan"),
        detail: bi(
          "等待漂移研判完成后编排预检/执行/验收/回退步骤",
          "Structuring precheck, execute, verify & rollback steps",
        ),
        ok: true,
        status: "pending",
      },
    ];
  }
  if (kind === "verify") {
    return [
      {
        id: "inspect-step-evid",
        kind: "inspect",
        title: bi("读取步骤判据与实测证据", "Load step criteria & execution evidence"),
        detail: bi(
          "装载本步执行命令、核心目标判据与前序轮次记录…",
          "Loading step command, core pass criteria & prior rounds…",
        ),
        ok: true,
        status: "running",
      },
      {
        id: "scrub-step-evid",
        kind: "guard",
        title: bi("回显凭据二次脱敏", "Scrub credentials from output"),
        detail: bi(
          "自动剥离输出中的口令与私钥，结合前序事实客观核验",
          "Redacting secrets and loading prior round context",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "connect-model",
        kind: "connect",
        title: bi("连接模型网关与投递上下文", "Connect model gateway & send context"),
        detail: bi(
          "等待脱敏完成后建立模型流式连接",
          "Waiting for redaction before opening AI stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "model-think",
        kind: "think",
        title: bi("对照预期判据自动核验结果", "Verify output against expected criteria"),
        detail: bi(
          "等待模型通道返回首包后展开核验推演",
          "Waiting for first token from model stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "verify-verdict",
        kind: "synthesize",
        title: bi("输出核验结论与后续动作", "Emit verification verdict & next action"),
        detail: bi(
          "通过则自动回写实测记录；未通过则直接给出根因与最小补救方案",
          "Recording verified summary if passed, or proposing minimal fix if failed",
        ),
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
        title: bi("定位受阻步骤与报错证据", "Inspect failed step & error evidence"),
        detail: bi(
          "读取当前演练步骤命令、判据与报错输出…",
          "Loading step command, criteria & error output…",
        ),
        ok: true,
        status: "running",
      },
      {
        id: "scrub-err-context",
        kind: "guard",
        title: bi("报错回显脱敏与上下文封装", "Scrub secrets & package error context"),
        detail: bi(
          "剥离报错输出中的敏感凭据，锁定演练步骤边界",
          "Masking credentials & locking step context",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "connect-model",
        kind: "connect",
        title: bi("连接模型网关与投递上下文", "Connect model gateway & send context"),
        detail: bi(
          "等待脱敏完成后建立模型流式连接",
          "Waiting for redaction before opening AI stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "model-think",
        kind: "think",
        title: bi("诊断报错信号与环境根因推理", "Diagnose error & analyze root cause"),
        detail: bi(
          "等待模型通道返回首包后展开推演",
          "Waiting for first token from model stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "propose-fix",
        kind: "synthesize",
        title: bi("生成命令修订提案", "Generate command fix proposal"),
        detail: bi(
          "等待根因明确后生成就地替换或前置步骤命令",
          "Proposing in-place replacement or pre-step command",
        ),
        ok: true,
        status: "pending",
      },
    ];
  }
  if (kind === "create-quick") {
    return [
      {
        id: "read-baseline",
        kind: "inspect",
        title: bi("读取集群交付基线与节点拓扑", "Read cluster baseline & topology"),
        detail: bi(
          "装载集群节点地址、组件版本与运行方案基线…",
          "Loading cluster hosts, component version & scheme baseline…",
        ),
        ok: true,
        status: "running",
      },
      {
        id: "scrub-context",
        kind: "guard",
        title: bi("敏感凭据脱敏与极速通道校验", "Scrub secrets & quick-change guard"),
        detail: bi(
          "跳过边界问答与前置探针，直通极速变更步骤编排",
          "Skipping scope Q&A & probe; routing directly to executable steps",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "connect-model",
        kind: "connect",
        title: bi("连接模型网关与投递上下文", "Connect model gateway & send context"),
        detail: bi(
          "等待脱敏完成后建立模型流式连接",
          "Waiting for redaction before opening AI stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "model-think",
        kind: "think",
        title: bi("直出极速变更步骤与核验判据", "Draft direct change & verify steps"),
        detail: bi(
          "等待模型通道返回首包后展开推演",
          "Waiting for first token from model stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "build-quick-steps",
        kind: "synthesize",
        title: bi("编排可执行步骤与应急回退预案", "Assemble steps & rollback plan"),
        detail: bi(
          "生成 2～3 步正向命令、验收判据与独立回退命令，完成后可一键出变更报告",
          "Structuring 2–3 forward steps, checks & rollback for Change Report archival",
        ),
        ok: true,
        status: "pending",
      },
    ];
  }
  if (kind === "create-light") {
    return [
      {
        id: "read-baseline",
        kind: "inspect",
        title: bi("读取集群初始交付基线", "Read initial delivery baseline"),
        detail: bi(
          "装载集群节点拓扑、组件版本与运行方案基线…",
          "Loading cluster topology, versions & scheme baseline…",
        ),
        ok: true,
        status: "running",
      },
      {
        id: "scrub-context",
        kind: "guard",
        title: bi("敏感凭据脱敏与只读边界检查", "Scrub credentials & read-only guard"),
        detail: bi(
          "跳过冗长窗口问答，锁定极简只读核查与安全红线",
          "Skipping scope Q&A; enforcing concise read-only safety boundary",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "connect-model",
        kind: "connect",
        title: bi("连接模型网关与投递上下文", "Connect model gateway & send context"),
        detail: bi(
          "等待脱敏完成后建立模型流式连接",
          "Waiting for redaction before opening AI stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "model-think",
        kind: "think",
        title: bi("设计极简只读核查策略", "Design concise read-only probe"),
        detail: bi(
          "等待模型通道返回首包后展开推演",
          "Waiting for first token from model stream",
        ),
        ok: true,
        status: "pending",
      },
      {
        id: "readonly-ast-guard",
        kind: "guard",
        title: bi("生成探针与静态安全红线扫描", "Generate probe & run safety AST scan"),
        detail: bi(
          "等待极简脚本编写完成后执行只读红线静态校验",
          "Running static read-only safety scan on generated script",
        ),
        ok: true,
        status: "pending",
      },
    ];
  }
  return [
    {
      id: "read-baseline",
      kind: "inspect",
      title: bi("读取集群初始交付基线", "Read initial delivery baseline"),
      detail: bi(
        "装载集群节点拓扑、组件版本与运行方案基线…",
        "Loading cluster topology, versions & scheme baseline…",
      ),
      ok: true,
      status: "running",
    },
    {
      id: "scrub-context",
      kind: "guard",
      title: bi("敏感凭据脱敏与边界检查", "Scrub credentials & check boundaries"),
      detail: bi(
        "自动剥离敏感口令与私钥字段，锁定只读边界",
        "Stripping passwords & private keys, locking read-only boundary",
      ),
      ok: true,
      status: "pending",
    },
    {
      id: "connect-model",
      kind: "connect",
      title: bi("连接模型网关与投递上下文", "Connect model gateway & send context"),
      detail: bi(
        "等待脱敏完成后建立模型流式连接",
        "Waiting for redaction before opening AI stream",
      ),
      ok: true,
      status: "pending",
    },
    {
      id: "model-think",
      kind: "think",
      title: bi("研判变更诉求与集群高可用边界", "Assess change goal & HA constraints"),
      detail: bi(
        "等待模型通道返回首包后展开推演",
        "Waiting for first token from model stream",
      ),
      ok: true,
      status: "pending",
    },
    {
      id: "build-scope",
      kind: "synthesize",
      title: bi("生成变更边界澄清清单", "Generate scope alignment checklist"),
      detail: bi(
        "等待风险推演完成后提炼维护窗口与前提问题",
        "Summarizing maintenance window & prerequisite questions",
      ),
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

function markLiveStateError(prev: LiveAIState, rawErr: unknown): LiveAIState {
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
        "X-Lang": getLang(),
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
    } else if (kind === "done" && ev.rehearsal) {
      finalResult = ev.rehearsal as ChangeRehearsal;
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
    r.onerror = () => reject(new Error(bi("读取图片失败", "Failed to read image")));
    r.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(bi("解码图片失败", "Failed to decode image")));
    img.src = src;
  });
}

async function prepareDraftImage(file: File): Promise<DraftImage> {
  if (!ALLOWED_IMAGE_MIME.test(file.type)) {
    throw new Error(
      bi(
        `不支持的图片格式：${file.name || file.type}`,
        `Unsupported image format: ${file.name || file.type}`,
      ),
    );
  }
  if (file.size > 18 * 1024 * 1024) {
    throw new Error(
      bi(
        `图片 ${file.name} 过大，请控制在 18 MiB 以内`,
        `Image ${file.name} exceeds 18 MiB limit`,
      ),
    );
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
      name: file.name || bi("剪贴板截图.png", "clipboard-screenshot.png"),
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
    throw new Error(
      bi(
        "浏览器不支持图片画布压缩",
        "Browser canvas image compression unavailable",
      ),
    );
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
    throw new Error(
      bi(
        `图片 ${file.name} 压缩后仍超过 4 MiB，请裁剪关键区域后重试`,
        `Image ${file.name} still exceeds 4 MiB after compression; crop key region and retry`,
      ),
    );
  }
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || bi("剪贴板截图.webp", "clipboard-screenshot.webp"),
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
            : new File(
                [f],
                `${bi("截图", "screenshot")}-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.${ext}`,
                {
                  type: f.type,
                },
              );
        out.push(named);
      }
    }
  }
  return out;
}

function rehearsalImgUrl(clusterId: string, rehearsalId: string, name: string) {
  return `/api/clusters/${encodeURIComponent(clusterId)}/rehearsals/${encodeURIComponent(rehearsalId)}/img/${encodeURIComponent(name)}`;
}

function formatProbeFileStamp(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const valid = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${valid.getFullYear()}${pad(valid.getMonth() + 1)}${pad(valid.getDate())}-${pad(valid.getHours())}${pad(valid.getMinutes())}${pad(valid.getSeconds())}`;
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
  "lsof",
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
  label,
  title,
  className = "",
}: {
  text: string;
  label?: string;
  title?: string;
  className?: string;
}) {
  useLang();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  const btnLabel = label ?? bi("复制", "Copy");
  return (
    <button
      type="button"
      className={`rh-code-btn ${className} ${done ? "copied" : ""}`.trim()}
      title={title}
      onClick={() => {
        void copy(text);
        setDone(true);
      }}
    >
      {done ? <IconCheck /> : <IconCopy />}
      <span>{done ? bi("已复制", "Copied") : btnLabel}</span>
    </button>
  );
}

const ShellCodeBlock = React.memo(function ShellCodeBlock({
  code,
  title,
  compact = false,
  pasteSafe = false,
  copyLabel,
  onDownload,
  onEdit,
  onAskAI,
}: {
  code: string;
  title: string;
  compact?: boolean;
  pasteSafe?: boolean;
  copyLabel?: string;
  onDownload?: () => void;
  onEdit?: () => void;
  onAskAI?: () => void;
}) {
  useLang();
  const [expanded, setExpanded] = useState(false);
  const safeCopy = useMemo(
    () =>
      pasteSafe
        ? toPasteSafeShell(code)
        : { text: code, pasteSafe: false, autoWrapped: false },
    [code, pasteSafe],
  );
  const tokenizedLines = useMemo(() => {
    const clean = code.replace(/\r\n/g, "\n").replace(/\n$/, "");
    return clean.split("\n").map((ln) => tokenizeBashLine(ln));
  }, [code]);
  const collapsible = tokenizedLines.length > (compact ? 10 : 16);

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
          <span className="rh-code-lines num">
            {bi(
              `${tokenizedLines.length} 行`,
              tokenizedLines.length === 1
                ? "1 line"
                : `${tokenizedLines.length} lines`,
            )}
          </span>
          {safeCopy.pasteSafe && (
            <Tooltip
              mini
              content={
                safeCopy.autoWrapped
                  ? bi(
                      "复制时自动封装为 ( ... ) </dev/null，防止堡垒机/WebSSH 下 sudo、psql 或慢命令吞掉后续行，粘贴后按一次回车即可按序完整执行",
                      "Auto-wrapped in ( ... ) </dev/null on copy so bastion/WebSSH terminals and sudo/psql never swallow subsequent lines — paste and press Enter once",
                    )
                  : bi(
                      "已封装为 ( ... ) </dev/null 子 Shell，防止堡垒机/WebSSH 下 sudo、psql 或慢命令吞掉后续行，粘贴后按一次回车即可按序完整执行",
                      "Wrapped in ( ... ) </dev/null subshell so bastion/WebSSH terminals and sudo/psql never swallow subsequent lines — paste and press Enter once",
                    )
              }
            >
              <span className="rh-code-safe-pill">
                {bi("整块防吞行", "Paste-safe")}
              </span>
            </Tooltip>
          )}
        </div>
        <div className="rh-code-acts">
          {collapsible && (
            <button
              type="button"
              className="rh-code-btn"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <IconShrink /> : <IconExpand />}
              <span>{expanded ? bi("收起", "Collapse") : bi("展开全部", "Expand all")}</span>
            </button>
          )}
          {onDownload && (
            <button
              type="button"
              className="rh-code-btn"
              onClick={onDownload}
            >
              <IconDownload />
              <span>{bi("下载 .sh", "Download .sh")}</span>
            </button>
          )}
          {onEdit && (
            <button type="button" className="rh-code-btn" onClick={onEdit}>
              <IconEdit />
              <span>{bi("微调", "Edit")}</span>
            </button>
          )}
          {onAskAI && (
            <button
              type="button"
              className="rh-code-btn is-ai"
              onClick={onAskAI}
              title={bi(
                "在右下角 AI 助手中讨论或对话修改此演练步骤",
                "Discuss or modify this step with AI Assistant",
              )}
            >
              <Spark size={12} />
              <span>{bi("问 AI 修改", "Ask AI")}</span>
            </button>
          )}
          <CopyCodeBtn
            text={safeCopy.text}
            label={copyLabel}
            title={
              safeCopy.pasteSafe
                ? bi(
                    "已启用堡垒机整块防吞行封装 ( ... ) </dev/null，粘贴后按一次回车即可完整执行",
                    "Copies paste-safe ( ... ) </dev/null block for WebSSH/bastion terminals",
                  )
                : undefined
            }
          />
        </div>
      </div>
      <div className="rh-code-scroll">
        <pre className="rh-code-pre mono">
          <code>
            {tokenizedLines.map((toks, idx) => (
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
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
});

/* ---------- Live & Persisted AI Choreographed Pipeline Card ---------- */

function fmtElapsedMs(ms?: number) {
  if (!ms || ms < 80) return "";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function fmtStepDuration(ms?: number) {
  if (!ms || ms < 30) return bi("已就绪", "Ready");
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function pendingHintForStep(st: RehearsalTraceStep): string {
  switch (st.kind) {
    case "guard":
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
      return bi(
        "等待模型网关返回首包 Token 后展开实时推演",
        "Waiting for first token from model gateway",
      );
    case "synthesize":
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
  scene,
  stepTitle,
  stepDetail,
  provider,
  model,
  waitStartedAt,
  errorBadge,
}: {
  scene: CartoonScene;
  stepTitle: string;
  stepDetail?: string;
  provider?: string;
  model?: string;
  waitStartedAt?: number;
  errorBadge?: string;
}) {
  useLang();
  const actMeta: Record<
    CartoonScene,
    { tag: string; headline: string; sub: React.ReactNode }
  > = {
    inspect: {
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
    guard: {
      tag: bi("ACT 02 · 安全脱敏", "ACT 02 · REDACTION"),
      headline:
        stepTitle ||
        bi(
          "敏感凭据自动剥离与只读红线锁定",
          "Stripping credentials & locking read-only guardrails",
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
          "平台底座正在与 AI 模型网关双向握手",
          "Handshaking with AI model gateway",
        ),
      sub: stepDetail || (
        <>
          {bi(
            `正在向 ${provider || "模型网关"}${model ? ` (${model})` : ""} 投递脱敏基线并等待首包响应`,
            `Sending redacted baseline to ${provider || "model gateway"}${model ? ` (${model})` : ""} and awaiting first token`,
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
    think: {
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
    synthesize: {
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
        "模型网关握手中断 · 本地安全熔断已介入",
        "Gateway handshake interrupted · Safety breaker active",
      ),
      sub: bi(
        "生产与测试数据零改动，您填写的变更诉求与截图已完整保留，可随时重试",
        "Zero changes made; your inputs and screenshots are preserved for retry",
      ),
    },
  };

  const cur = actMeta[scene];

  return (
    <div className={`rh-cartoon-stage is-${scene}`} aria-hidden>
      <div className="rh-cartoon-canvas" key={scene}>
        {scene === "inspect" && (
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
                {bi("基线快照", "Baseline")}
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
                pwd=••••
              </text>
            </g>
            <g className="ct-raw-pill p2">
              <rect x="14" y="34" width="80" height="28" rx="8" className="ct-pill-warn" />
              <circle cx="26" cy="48" r="3" className="ct-led warn" />
              <text x="35" y="48" textAnchor="start" dominantBaseline="central" className="ct-pill-warn-txt">
                ssh_key
              </text>
            </g>

            {/* Outgoing Sanitized Safe Pills (Shield Gate -> Right) */}
            <g className="ct-clean-pill p1">
              <rect x="196" y="34" width="88" height="28" rx="8" className="ct-pill-ok" />
              <circle cx="211" cy="48" r="6" className="ct-check-disc" />
              <path d="M208.3 48.1l1.9 1.9 3.7-3.9" className="ct-check-white sm" />
              <text x="223" y="48" textAnchor="start" dominantBaseline="central" className="ct-pill-ok-txt">
                {bi("已脱敏", "Redacted")}
              </text>
            </g>
            <g className="ct-clean-pill p2">
              <rect x="196" y="34" width="90" height="28" rx="8" className="ct-pill-ok" />
              <circle cx="211" cy="48" r="6" className="ct-check-disc" />
              <path d="M208.3 48.1l1.9 1.9 3.7-3.9" className="ct-check-white sm" />
              <text x="223" y="48" textAnchor="start" dominantBaseline="central" className="ct-pill-ok-txt">
                {bi("纯只读", "Read-Only")}
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

        {scene === "think" && (
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
            {/* Runbook Blueprint Document Sheet */}
            <rect x="14" y="10" width="196" height="76" rx="10" className="ct-doc-sheet" />
            <circle cx="30" cy="26" r="3.6" className="ct-led ok" />
            <line x1="42" y1="26" x2="164" y2="26" className="ct-draw-line l1" />
            <circle cx="30" cy="42" r="3.6" className="ct-led brand" />
            <line x1="42" y1="42" x2="190" y2="42" className="ct-draw-line l2" />
            <circle cx="30" cy="58" r="3.6" className="ct-led ok" />
            <line x1="42" y1="58" x2="156" y2="58" className="ct-draw-line l3" />
            <circle cx="30" cy="74" r="3.4" className="ct-led warn" />
            <line x1="42" y1="74" x2="134" y2="74" className="ct-draw-line l4" />

            {/* Centered Safety Verification Seal Impact */}
            <circle cx="286" cy="48" r="26" className="ct-seal-ring" />
            <g className="ct-stamp-badge">
              <rect x="226" y="22" width="120" height="52" rx="12" className="ct-pill-ok" />
              <circle cx="246" cy="48" r="10" className="ct-check-disc" />
              <path d="M241.5 48.2l3 3 5.8-6" className="ct-check-white" />
              <text x="263" y="40" textAnchor="start" dominantBaseline="central" className="ct-pill-ok-txt lg">
                SAFE
              </text>
              <text x="263" y="56" textAnchor="start" dominantBaseline="central" className="ct-mini-ok">
                {bi("安全校验通过", "Verified")}
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

const RehearsalThinkingContent = React.memo(function RehearsalThinkingContent({
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
                      {bi(
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
  useLang();
  useEffect(() => {
    if (index === null || items.length === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "ArrowLeft" && index > 0) {
        e.preventDefault();
        onIndexChange(index - 1);
      } else if (e.key === "ArrowRight" && index < items.length - 1) {
        e.preventDefault();
        onIndexChange(index + 1);
      } else if (
        e.key === "Escape" &&
        !(e.target as HTMLElement | null)?.closest?.(".arco-modal-wrapper")
      ) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [index, items.length, onClose, onIndexChange]);

  if (index === null || !items[index]) return null;
  const cur = items[index];
  return (
    <Modal
      visible
      alignCenter
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
              {bi("上一张", "Previous")}
            </Button>
            <Button
              size="small"
              disabled={index >= items.length - 1}
              onClick={() => onIndexChange(index + 1)}
            >
              {bi("下一张", "Next")}
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
  useLang();
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  if (!images.length) return null;
  const lbItems = images.map((im, idx) => ({
    src: im.dataUrl,
    label: im.name
      ? `${im.name} (${im.sizeKB} KB)`
      : bi(`待发送截图 ${idx + 1}`, `Draft screenshot ${idx + 1}`),
  }));
  return (
    <>
      <div
        className="rh-img-strip"
        aria-label={bi("已粘贴或选择的截图", "Attached screenshots")}
      >
        {images.map((im, idx) => (
          <div key={im.id} className="rh-img-thumb">
            <button
              type="button"
              className="rh-img-open"
              onClick={() => setPreviewIdx(idx)}
              title={bi("点击放大查看截图", "Click to zoom")}
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
              aria-label={bi(`移除 ${im.name}`, `Remove ${im.name}`)}
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
  label,
}: {
  clusterId: string;
  rehearsalId: string;
  names?: string[];
  label?: string;
}) {
  useLang();
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  if (!names || names.length === 0) return null;
  const heading = label ?? bi("现场截图", "Screenshots");
  const items = names.map((n, i) => ({
    src: rehearsalImgUrl(clusterId, rehearsalId, n),
    label: `${heading} ${i + 1} (${n})`,
  }));
  return (
    <>
      <div className="rh-saved-imgs">
        <span className="rh-saved-imgs-k">
          <IconImage /> {heading} ({names.length})
        </span>
        <div className="rh-img-strip">
          {items.map((it, idx) => (
            <div key={names[idx]} className="rh-img-thumb saved">
              <button
                type="button"
                className="rh-img-open"
                onClick={() => setPreviewIdx(idx)}
                title={bi("点击放大查看截图", "Click to zoom")}
              >
                <img src={it.src} alt={it.label} loading="lazy" />
              </button>
              <span className="rh-img-caption">
                <span className="rh-img-name">
                  {bi(`截图 ${idx + 1}`, `Image ${idx + 1}`)}
                </span>
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

const DeliveryBaselineAside = React.memo(function DeliveryBaselineAside({
  c,
  onClose,
  onReturnToDelivery,
  inModal = false,
}: {
  c: ClusterView;
  onClose: () => void;
  onReturnToDelivery: (tab?: "overview" | "config" | "plans" | "docs") => void;
  inModal?: boolean;
}) {
  const lang = useLang();
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
      roles:
        (roleByHost.get(h.name) || []).join(" / ") ||
        bi("集群节点", "Cluster Node"),
    }));
  }, [detail, lang]);

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
    <aside
      className={`rh-delivery-aside${inModal ? " in-modal" : ""}`}
      aria-label={bi("集群初始交付基线", "Cluster Initial Delivery Baseline")}
    >
      {inModal ? (
        <div className="rh-aside-head is-modal-sub">
          <span className="faint small">
            {c.app_name} {c.version}
            {c.platform ? ` · ${platformShort(c.platform)}` : ""}
          </span>
        </div>
      ) : (
        <div className="rh-aside-head">
          <div>
            <b>{bi("当前交付基线", "Delivery Baseline")}</b>
            <span className="faint small">
              {c.app_name} {c.version}
              {c.platform ? ` · ${platformShort(c.platform)}` : ""}
            </span>
          </div>
          <button
            type="button"
            className="rh-aside-close"
            onClick={onClose}
            aria-label={bi("收起交付基线面板", "Close delivery baseline panel")}
            title={bi("收起面板 (Esc)", "Close panel (Esc)")}
          >
            <IconClose />
          </button>
        </div>
      )}

      <div className="rh-aside-scroll">
        <div className="rh-aside-sec">
          <SchemeInfo
            scheme={c.scheme}
            detail
            label={bi("当前部署架构", "Current deployment architecture")}
          />
        </div>

        <div className="rh-aside-sec">
          <div className="rh-aside-sec-title">
            <span>{bi("初始节点与角色拓扑", "Initial Nodes & Roles")}</span>
            <span className="num faint">
              {bi(
                `${hostRows.length || c.hosts} 台`,
                `${hostRows.length || c.hosts} nodes`,
              )}
            </span>
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
                      title={bi("点击复制节点 IP", "Click to copy node IP")}
                    >
                      <span>{h.ip}</span>
                      <IconCopy />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">
              {bi(
                `共 ${c.hosts} 台节点（点击下方可查看完整配置）`,
                `${c.hosts} nodes total (view full config below)`,
              )}
            </p>
          )}
        </div>

        {endpoints.length > 0 && (
          <div className="rh-aside-sec">
            <div className="rh-aside-sec-title">
              <span>{bi("服务端口与入口", "Service Ports & Endpoints")}</span>
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
              <span>{bi("交付关键参数", "Key Delivery Parameters")}</span>
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
            <span>{bi("跳转集群页面", "Cluster Navigation")}</span>
          </div>
          <div className="rh-aside-nav">
            <button
              type="button"
              onClick={() => onReturnToDelivery("overview")}
            >
              {bi("集群概览", "Cluster Overview")} <IconRight />
            </button>
            <button
              type="button"
              onClick={() => onReturnToDelivery("config")}
            >
              {bi("部署配置", "Deploy Config")} <IconRight />
            </button>
            <button
              type="button"
              onClick={() => onReturnToDelivery("plans")}
            >
              {bi("查看部署手册", "Deployment Runbook")} <IconRight />
            </button>
            <button
              type="button"
              onClick={() => onReturnToDelivery("docs")}
            >
              {bi("集群文档", "Cluster Docs")} <IconRight />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
});

/* ---------- Bespoke Business SVG Visuals ---------- */

function RehearsalPipelineArt() {
  useLang();
  return (
    <div
      className="rh-pipe"
      aria-label={bi(
        "变更演练四阶段流程：边界对齐、只读探针、测试演练、生产 SOP",
        "4-stage change rehearsal flow: Scope Alignment, Read-Only Probe, Test Rehearsal, Production SOP",
      )}
    >
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
            <i className="num">01</i>
            {bi("边界对齐", "Scope Alignment")}
          </b>
          <small>{bi("目标与窗口", "Goal & window")}</small>
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
            <i className="num">02</i>
            {bi("只读探针", "Read-Only Probe")}
          </b>
          <small>{bi("识别现场漂移", "Detect live drift")}</small>
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
            <i className="num">03</i>
            {bi("测试演练", "Test Rehearsal")}
          </b>
          <small>{bi("逐步实测打磨", "Verify & refine")}</small>
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
            <i className="num">04</i>
            {bi("生产 SOP", "Production SOP")}
          </b>
          <small>{bi("导出 Word 审批", "Export Word SOP")}</small>
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
  const hostPhrase =
    c.hosts > 0
      ? bi(`现有 ${c.hosts} 台节点`, `the existing ${c.hosts} nodes`)
      : bi("现有集群拓扑", "the current cluster topology");
  return [
    {
      kind: "upgrade" as RehearsalPresetKind,
      label: bi("版本平滑升级", "Rolling Upgrade"),
      sub: bi("从库先行 · 最小闪断", "Replicas first · Minimal blip"),
      title: bi(`${c.app_name} 小版本平滑升级`, `${c.app_name} Minor Rolling Upgrade`),
      goal: bi(
        `将集群 ${c.id} 的 ${c.app_name}（基线版本 ${c.version}）平滑升级到目标小版本，优先从节点滚动先行、最后无损切主，控制业务闪断在秒级以内。`,
        `Perform a rolling minor upgrade of ${c.app_name} on cluster ${c.id} (baseline ${c.version}) to the target patch version: upgrade replicas first, then switchover primary cleanly within sub-second disruption.`,
      ),
    },
    {
      kind: "scale" as RehearsalPresetKind,
      label: bi("在线节点扩缩", "Online Scaling"),
      sub: bi("接入复制 · 读写不断", "Join replication · Zero downtime"),
      title: bi(`${c.app_name} 在线扩容备节点`, `${c.app_name} Online Replica Scale-Out`),
      goal: bi(
        `在${hostPhrase}基础上在线新增 1 台只读备节点并接入复制拓扑，全程不中断主节点读写服务。`,
        `Add 1 read-only replica node on top of ${hostPhrase} and join it to the replication topology without interrupting primary read/write traffic.`,
      ),
    },
    {
      kind: "tune" as RehearsalPresetKind,
      label: bi("运行参数调优", "Parameter Tuning"),
      sub: bi("核对现值 · 热更或重启", "Check live · Reload or restart"),
      title: bi(`${c.app_name} 关键参数调优`, `${c.app_name} Parameter Tuning`),
      goal: bi(
        `调整集群 ${c.id} 关键连接或内存参数，先核对现场当前生效值，明确动态热加载或滚动重启顺序，并准备回退命令。`,
        `Tune key connection or memory parameters on cluster ${c.id}: verify live active values first, determine hot-reload vs rolling restart order, and prepare rollback commands.`,
      ),
    },
    {
      kind: "switch" as RehearsalPresetKind,
      label: bi("主备切换演练", "Failover Drill"),
      sub: bi("计划切主 · 连通验证", "Planned switchover · Verify"),
      title: bi(`${c.app_name} 计划内主备切换演练`, `${c.app_name} Planned Failover Drill`),
      goal: bi(
        `在维护窗口内对集群 ${c.id} 执行一次计划内主备切换与回切演练，验证业务入口切换耗时并沉淀标准操作手册。`,
        `Execute a planned primary/replica switchover and switchback drill on cluster ${c.id} within the maintenance window, verify endpoint switchover time, and produce a standard SOP.`,
      ),
    },
  ];
}

function parseRehearsalGoalSections(
  input?: string,
): { label?: string; body: string }[] {
  const raw = (input || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  const headingRe =
    /(?<=。)\s*(?=(?:变更对象|当前基线|现状|背景|目标方案|变更目标|改造方案|核心约束|约束条件|约束|前置核对|现场需先核实的只读探针|只读探针|演练范围|测试环境演练要求|测试演练|演练要求|验证要点|待用户确认项|待确认项|回退要求|回退方案|预期产出|产出)(?:[（(][^）)\n]{1,24}[）)])?\s*[：:])/g;
  const chunks: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    for (const part of t.split(headingRe)) {
      const p = part.trim();
      if (p) chunks.push(p);
    }
  }
  const labelRe =
    /^([^\n：:，,。；;]{2,18}(?:[（(][^）)\n]{1,24}[）)])?)\s*[：:]\s*(.+)$/;
  return chunks.map((chunk) => {
    const m = chunk.match(labelRe);
    if (m) {
      return { label: m[1].trim(), body: m[2].trim() };
    }
    return { body: chunk };
  });
}

function rehearsalDotClass(item?: ChangeRehearsal | null): string {
  if (!item) return "st-scoping";
  if (item.voided) return "st-voided";
  if (item.stage === "finalized") {
    return item.applied ? "st-applied" : "st-pending-apply";
  }
  return `st-${item.stage}`;
}

function stepSummary(item: ChangeRehearsal) {
  if (item.voided) {
    return item.superseded_by
      ? bi("已被替代", "Superseded")
      : bi("已作废", "Voided");
  }
  const steps = item.steps || [];
  const isQuick = item.mode === "quick";
  const isLight = item.mode === "light";
  if (item.stage === "finalized") {
    if (item.applied) return bi("✓ 已落地", "✓ Applied");
    return isQuick || isLight
      ? bi("变更报告 · 待实施", "Report · Pending")
      : bi("生产 SOP · 待实施", "SOP · Pending");
  }
  if (item.stage === "rehearsing" && steps.length > 0) {
    const req = steps.filter((s) => !s.optional && s.phase !== "rollback");
    const done = req.filter(
      (s) => s.status === "passed" || s.status === "skipped",
    ).length;
    return isQuick
      ? bi(`执行 ${done}/${req.length}`, `Run ${done}/${req.length}`)
      : isLight
        ? bi(`验证 ${done}/${req.length}`, `Verify ${done}/${req.length}`)
        : bi(`演练 ${done}/${req.length}`, `Step ${done}/${req.length}`);
  }
  const metaMap = isQuick
    ? QUICK_STAGE_META
    : isLight
      ? LIGHT_STAGE_META
      : STAGE_META;
  return metaMap[item.stage]?.short || bi("进行中", "In progress");
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
  onClusterChanged,
}: {
  c: ClusterView;
  rehearsalId?: string;
  initialList?: ChangeRehearsal[] | null;
  focused?: boolean;
  onFocusChange?: (v: boolean) => void;
  onListUpdated?: () => void;
  onClusterChanged?: () => void;
}) {
  const lang = useLang();
  const listUrl = rehearsalsListPath(c.id);
  const createKey = rehearsalTaskKey.create(c.id);
  const createTask = useRehearsalTask<LiveAIState, ChangeRehearsal>(createKey);
  const activeRehearsalTasks = useActiveRehearsalTasks();
  const liveCreate =
    createTask && (createTask.status === "running" || createTask.status === "error")
      ? createTask.live
      : null;

  const [list, setList] = useState<ChangeRehearsal[] | null>(
    () => initialList ?? cached<ChangeRehearsal[]>(listUrl) ?? null,
  );
  const [loadErr, setLoadErr] = useState("");
  const [creating, setCreating] = useState(
    () =>
      hasRehearsalIntentFor(c.id) ||
      isRehearsalTaskLive(getRehearsalTask(rehearsalTaskKey.create(c.id))),
  );
  const creatingRef = useRef(creating);
  creatingRef.current = creating;
  const [pickedPreset, setPickedPreset] = useState<RehearsalPresetKind | null>(
    null,
  );
  const [launchMode, setLaunchMode] = useState<RehearsalModeChoice>(
    () =>
      (getRehearsalTask(rehearsalTaskKey.create(c.id))?.draft?.launchMode as
        | RehearsalModeChoice
        | undefined) || "auto",
  );
  const [goal, setGoal] = useState(
    () =>
      String(
        getRehearsalTask(rehearsalTaskKey.create(c.id))?.draft?.goal || "",
      ),
  );
  const [title, setTitle] = useState(
    () =>
      String(
        getRehearsalTask(rehearsalTaskKey.create(c.id))?.draft?.title || "",
      ),
  );
  const [secCtxDraft, setSecCtxDraft] =
    useState<RehearsalSecurityContext | null>(
      () =>
        (getRehearsalTask(rehearsalTaskKey.create(c.id))?.draft?.secCtxDraft as
          | RehearsalSecurityContext
          | null
          | undefined) || null,
    );
  const [srcCtxDraft, setSrcCtxDraft] =
    useState<RehearsalSourceContext | null>(
      () =>
        (getRehearsalTask(rehearsalTaskKey.create(c.id))?.draft?.srcCtxDraft as
          | RehearsalSourceContext
          | null
          | undefined) || null,
    );
  const [goalImages, setGoalImages] = useState<DraftImage[]>(
    () =>
      (getRehearsalTask(rehearsalTaskKey.create(c.id))?.draft?.goalImages as
        | DraftImage[]
        | undefined) || [],
  );
  const [dragGoal, setDragGoal] = useState(false);
  useEffect(() => {
    if (!dragGoal) return;
    const clear = () => setDragGoal(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragGoal]);
  const [ledgerCollapsed, setLedgerCollapsed] = useState(false);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [sessMenuOpen, setSessMenuOpen] = useState(false);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [ledgerQuery, setLedgerQuery] = useState("");
  const [ledgerFilter, setLedgerFilter] = useState<
    "all" | "active" | "finalized"
  >("all");

  const seededMapRef = useRef<Map<string, ChangeRehearsal>>(new Map());
  const composeRef = useRef<HTMLDivElement | null>(null);
  const goalRef = useRef<HTMLTextAreaElement | null>(null);
  const [goalEl, setGoalEl] = useState<HTMLTextAreaElement | null>(null);
  const bindGoalRef = useCallback((node: HTMLTextAreaElement | null) => {
    goalRef.current = node;
    setGoalEl(node);
  }, []);
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
  const spacious = useSpaciousComposer(
    composeRef,
    Boolean(
      goal.trim() ||
        title.trim() ||
        goalImages.length > 0 ||
        dragGoal ||
        creatingBusy,
    ),
  );
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
    [c.id, c.app_name, c.version, c.hosts, lang],
  );

  // Auto-grow launcher textarea height smoothly whenever the textarea mounts, text changes, or width changes
  const hasLiveCreate = Boolean(liveCreate);
  useLayoutEffect(() => {
    const el = goalEl;
    if (!el) return;
    const syncHeight = () => {
      if (!goal) {
        el.style.height = "";
        el.style.overflowY = "hidden";
        return;
      }
      const minH = hasLiveCreate ? 72 : 104;
      const maxH = hasLiveCreate
        ? 220
        : Math.max(360, Math.min(560, Math.floor(window.innerHeight * 0.56)));
      el.style.minHeight = "0px";
      el.style.height = "0px";
      const contentH = el.scrollHeight;
      el.style.minHeight = "";
      const next = Math.min(Math.max(contentH, minH), maxH);
      el.style.height = `${next}px`;
      el.style.overflowY = contentH > maxH ? "auto" : "hidden";
    };
    syncHeight();
    let raf = window.requestAnimationFrame(syncHeight);
    const onResize = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(syncHeight);
    };
    let lastW = el.clientWidth;
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            const w = el.clientWidth;
            if (w > 0 && w !== lastW) {
              lastW = w;
              onResize();
            }
          })
        : null;
    ro?.observe(el);
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [goalEl, goal, hasLiveCreate]);

  // Reset rail collapse and side drawer when switching clusters (preserving any active background create task on target cluster)
  useEffect(() => {
    setLedgerCollapsed(false);
    setDeliveryOpen(false);
    const existingTask = getRehearsalTask<LiveAIState, ChangeRehearsal>(
      rehearsalTaskKey.create(c.id),
    );
    if (isRehearsalTaskLive(existingTask)) {
      setCreating(true);
      const d = existingTask?.draft;
      setTitle(String(d?.title || ""));
      setGoal(String(d?.goal || ""));
      setGoalImages((d?.goalImages as DraftImage[] | undefined) || []);
      setLaunchMode((d?.launchMode as RehearsalModeChoice | undefined) || "auto");
    } else {
      setGoalImages([]);
    }
    setLedgerQuery("");
    setLedgerFilter("all");
  }, [c.id]);

  // Consume one-shot deep-link intent from Cluster Overview / AI Chat / Security if present
  const consumeIntent = useCallback(() => {
    try {
      const raw = sessionStorage.getItem(REHEARSAL_INTENT_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as Partial<RehearsalIntentPayload>;
      if (parsed.cluster !== c.id) return false;
      sessionStorage.removeItem(REHEARSAL_INTENT_KEY);
      creatingRef.current = true;
      setCreating(true);
      const curCreate = getRehearsalTask(rehearsalTaskKey.create(c.id));
      if (curCreate && curCreate.status !== "running") {
        clearRehearsalTask(rehearsalTaskKey.create(c.id));
      }
      if (parsed.securityContext) {
        setPickedPreset(null);
        setSrcCtxDraft(null);
        setSecCtxDraft(parsed.securityContext);
        setLaunchMode("full");
        setTitle(parsed.title || "");
        setGoal(parsed.goal || "");
      } else {
        setSecCtxDraft(null);
        setLaunchMode(
          parsed.mode === "quick" ||
            parsed.mode === "light" ||
            parsed.mode === "full" ||
            parsed.mode === "auto"
            ? parsed.mode
            : "auto",
        );
        const found = parsed.kind
          ? presets.find((p) => p.kind === parsed.kind)
          : undefined;
        const resolvedTitle = parsed.title || found?.title || "";
        const resolvedGoal = parsed.goal || found?.goal || "";
        setPickedPreset(found?.kind ?? null);
        setTitle(resolvedTitle);
        setGoal(resolvedGoal);
        if (parsed.sourceContext) {
          setSrcCtxDraft(parsed.sourceContext);
        } else if (found || resolvedTitle || resolvedGoal) {
          const appVer = `${c.app_name}${c.version ? ` ${c.version}` : ""}`.trim();
          setSrcCtxDraft({
            source: "overview",
            badge: found
              ? bi(`快捷发起 · ${found.label}`, `Quick Launch · ${found.label}`)
              : bi("外部带入 · 变更演练", "Imported · Change Rehearsal"),
            subject: resolvedTitle || found?.label || bi("变更演练", "Change Rehearsal"),
            tags: [c.id, appVer].filter(Boolean),
          });
        } else {
          setSrcCtxDraft(null);
        }
      }
      requestAnimationFrame(() => goalRef.current?.focus({ preventScroll: true }));
      return true;
    } catch {
      return false;
    }
  }, [c.id, presets]);

  useEffect(() => {
    consumeIntent();
    const onIntent = () => {
      consumeIntent();
    };
    window.addEventListener(REHEARSAL_INTENT_EVENT, onIntent);
    return () => window.removeEventListener(REHEARSAL_INTENT_EVENT, onIntent);
  }, [consumeIntent]);

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
        if (
          allowRedirect &&
          !rehearsalId &&
          r.length > 0 &&
          !creatingRef.current &&
          !hasRehearsalIntentFor(c.id)
        ) {
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
        setLoadErr((e as Error).message || bi("读取失败", "Failed to load"));
      }
    },
    [c.id, listUrl, rehearsalId],
  );

  const syncSessionInList = useCallback(
    (updated: ChangeRehearsal) => {
      if (!updated?.id) return;
      seededMapRef.current.set(updated.id, updated);
      putCached(rehearsalItemPath(c.id, updated.id), updated);
      let notified = false;
      setList((prev) => {
        if (!prev) return prev;
        let changed = false;
        const next = prev.map((it) => {
          if (it.id !== updated.id) return it;
          if (it === updated) return it;
          const prevSig = `${it.stage}|${it.title}|${it.updated_at}|${it.applied}|${it.voided}|${(it.steps || []).map((s) => `${s.id}:${s.status}:${s.optional ? 1 : 0}:${s.phase}`).join(",")}`;
          const nextSig = `${updated.stage}|${updated.title}|${updated.updated_at}|${updated.applied}|${updated.voided}|${(updated.steps || []).map((s) => `${s.id}:${s.status}:${s.optional ? 1 : 0}:${s.phase}`).join(",")}`;
          if (prevSig === nextSig) return it;
          changed = true;
          return updated;
        });
        if (!changed) return prev;
        putCached(listUrl, next);
        if (!notified) {
          notified = true;
          queueMicrotask(() => onListUpdatedRef.current?.());
        }
        return next;
      });
    },
    [c.id, listUrl],
  );

  // Keep left sidebar ledger synced when background tasks or AI Dock update any rehearsal on this cluster
  useEffect(() => {
    const onChanged = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{ clusterId?: string; rehearsalId?: string }>
      ).detail;
      if (detail?.clusterId && detail.clusterId !== c.id) return;
      if (detail?.rehearsalId) {
        const hit = cached<ChangeRehearsal>(rehearsalItemPath(c.id, detail.rehearsalId));
        if (hit) {
          syncSessionInList(hit);
          return;
        }
      }
      void loadList(false);
    };
    window.addEventListener(REHEARSAL_CHANGED, onChanged);
    return () => window.removeEventListener(REHEARSAL_CHANGED, onChanged);
  }, [c.id, loadList, syncSessionInList]);

  useEffect(() => {
    const hit = initialList ?? cached<ChangeRehearsal[]>(listUrl) ?? null;
    setList(hit);
    const liveCreateActive = isRehearsalTaskLive(
      getRehearsalTask(rehearsalTaskKey.create(c.id)),
    );
    const pendingIntent =
      creatingRef.current || hasRehearsalIntentFor(c.id) || liveCreateActive;
    if (hit && hit.length > 0 && !rehearsalId && !pendingIntent) {
      const runningSessTask = activeRehearsalTasks.find(
        (t) =>
          t.status === "running" &&
          t.clusterId === c.id &&
          t.rehearsalId &&
          hit.some((x) => x.id === t.rehearsalId),
      );
      go(
        {
          name: "deliveries",
          id: c.id,
          tab: "rehearsal",
          rehearsal: runningSessTask?.rehearsalId || hit[0].id,
        },
        { replace: true, instant: true },
      );
    }
    void loadList(!pendingIntent);
  }, [c.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Consume completed background/foreground create task seamlessly
  useEffect(() => {
    if (createTask?.status !== "done" || !createTask.result) return;
    const created = createTask.result;
    clearRehearsalTask(createKey);
    seededMapRef.current.set(created.id, created);
    setFreshId(created.id);
    setCreating(false);
    setPickedPreset(null);
    setLaunchMode("auto");
    setSecCtxDraft(null);
    setSrcCtxDraft(null);
    setGoal("");
    setTitle("");
    setGoalImages([]);
    void loadList(false);
    go({
      name: "deliveries",
      id: c.id,
      tab: "rehearsal",
      rehearsal: created.id,
    });
  }, [createTask, createKey, c.id, loadList]);

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
        bi(
          "当前所选模型不支持识别图片，请在输入栏底部切换支持看图的模型",
          "Selected model does not support images; switch to a vision-capable model below",
        ),
      );
      return;
    }
    const room = MAX_IMAGES - goalImages.length;
    if (room <= 0) {
      Message.warning(
        bi(
          `单次最多附加 ${MAX_IMAGES} 张截图`,
          `Up to ${MAX_IMAGES} screenshots allowed per batch`,
        ),
      );
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
        <b>{bi("当前集群暂不支持变更演练", "Change rehearsal unavailable for this cluster")}</b>
        <p className="muted">
          {c.delivery_mode === "configuration"
            ? bi(
                "此记录仅生成配置文件，不代表现场已安装运行的集群。",
                "This record only generated config files and does not represent a running cluster.",
              )
            : bi(
                "请先完成集群部署并确认运行结果，再基于运行基线发起变更演练。",
                "Complete cluster deployment and confirm its run status before launching a change rehearsal.",
              )}
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
              {bi("查看部署详情", "View Deployment")}
            </Button>
          )}
          <Button
            onClick={() =>
              go({ name: "deliveries", id: c.id }, { replace: true })
            }
          >
            {bi("返回集群概览", "Back to Overview")}
          </Button>
        </div>
      </section>
    );
  }

  if (loadErr && list === null) {
    return (
      <section className="dsec rh-state" role="alert">
        <IconExclamationCircle className="bad" />
        <b>{bi("演练记录读取失败", "Failed to load rehearsals")}</b>
        <p className="muted small">{loadErr}</p>
        <Button icon={<IconRefresh />} onClick={() => void loadList(true)}>
          {bi("重试", "Retry")}
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
    setSecCtxDraft(null);
    setSrcCtxDraft(null);
    setPickedPreset(p.kind);
    setTitle(p.title);
    setGoal(p.goal);
    requestAnimationFrame(() => goalRef.current?.focus());
  };

  const startNew = async () => {
    if (
      !goal.trim() ||
      creatingBusy ||
      offline ||
      getRehearsalTask(createKey)?.status === "running"
    ) {
      return;
    }
    engageFocus();
    const effectiveMode: RehearsalModeChoice = secCtxDraft ? "full" : launchMode;
    const initialLive = createInitialLiveState(
      effectiveMode === "quick"
        ? "create-quick"
        : effectiveMode === "light"
          ? "create-light"
          : "create",
      effectiveMode === "quick"
        ? bi(
            "AI 正在按极速变更直出执行步骤",
            "AI is generating direct steps (Quick Change)",
          )
        : effectiveMode === "light"
          ? bi(
              "AI 正在按简单推演直出极简只读探针",
              "AI is generating concise probe (Light Rehearsal)",
            )
          : effectiveMode === "auto"
            ? bi(
                "AI 正在评估复杂度并自动选择变更档位",
                "AI is evaluating complexity & change workflow depth",
              )
            : bi(
                "AI 正在研判变更诉求与集群高可用边界",
                "AI is analyzing change goal & HA boundaries",
              ),
      effectiveMode === "quick"
        ? bi(
            "跳过边界问答与前置探针，正在直出 2～3 步执行核验与独立回退预案…",
            "Skipping scope & probe; drafting 2–3 direct execution steps & rollback plan…",
          )
        : effectiveMode === "light"
          ? bi(
              "跳过窗口问答，正在筛选 2～4 项核心核查点并校验只读红线…",
              "Skipping scope Q&A; selecting 2–4 core live checks & validating read-only safety…",
            )
          : bi(
              "正在读取集群基线并建立模型连接…",
              "Loading cluster baseline & connecting to AI model…",
            ),
      pick.current,
    );
    const payload = {
      title: title.trim() || undefined,
      goal: goal.trim(),
      mode: effectiveMode,
      images:
        goalImages.length > 0
          ? goalImages.map((im) => im.dataUrl)
          : undefined,
      model: pick.ref || undefined,
      effort: pick.current?.effort?.includes(aiOpts.pref.think)
        ? aiOpts.pref.think
        : undefined,
      security_context: secCtxDraft || undefined,
    };
    const cid = c.id;
    startRehearsalTask<LiveAIState, ChangeRehearsal>({
      key: createKey,
      kind: "create",
      clusterId: cid,
      initialLive,
      draft: {
        title,
        goal,
        goalImages: [...goalImages],
        launchMode,
        secCtxDraft,
        srcCtxDraft,
      },
      run: (updateLive, signal) =>
        streamRehearsalAPI(
          `/api/clusters/${encodeURIComponent(cid)}/rehearsals`,
          payload,
          updateLive,
          signal,
        ),
      markError: markLiveStateError,
      onSuccessPersist: (created) => {
        putCached(rehearsalItemPath(cid, created.id), created);
        window.dispatchEvent(
          new CustomEvent(REHEARSAL_CHANGED, {
            detail: { clusterId: cid, rehearsalId: created.id },
          }),
        );
      },
      onBackgroundDone: (created) => {
        Message.success(
          bi(
            `${cid}：变更演练「${created.title || created.id}」已生成，可返回查看`,
            `${cid}: rehearsal "${created.title || created.id}" is ready`,
          ),
        );
      },
      onBackgroundError: () => {
        Message.error(
          bi(
            `${cid}：发起变更演练执行失败，请返回「变更演练」查看诊断`,
            `${cid}: failed to create rehearsal — return to Rehearsals to inspect`,
          ),
        );
      },
    });
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
    c.hosts > 0 ? bi(`${c.hosts} 台机器`, `${c.hosts} hosts`) : "",
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

  const clearStaleCreateErr = () => {
    const cur = getRehearsalTask(createKey);
    if (cur && cur.status !== "running") clearRehearsalTask(createKey);
  };

  const selectSession = (item: ChangeRehearsal) => {
    setSessMenuOpen(false);
    setCreating(false);
    clearStaleCreateErr();
    go({
      name: "deliveries",
      id: c.id,
      tab: "rehearsal",
      rehearsal: item.id,
    });
  };

  const sessionDroplist = (
    <div
      className="rh-sess-menu"
      role="listbox"
      aria-label={bi("切换演练记录", "Switch rehearsal")}
    >
      <div className="rh-sess-menu-head">
        <span className="num">
          {bi(`演练记录（${list.length}）`, `Rehearsals (${list.length})`)}
        </span>
        <button
          type="button"
          className="rh-sess-menu-new"
          onClick={() => {
            setSessMenuOpen(false);
            setCreating(true);
            clearStaleCreateErr();
            requestAnimationFrame(() => goalRef.current?.focus({ preventScroll: true }));
          }}
        >
          <IconPlus /> {bi("新建演练", "New Rehearsal")}
        </button>
      </div>
      {showLedgerSearch && (
        <div className="rh-ledger-search in-menu" onClick={(e) => e.stopPropagation()}>
          <IconSearch />
          <input
            type="search"
            value={ledgerQuery}
            onChange={(e) => setLedgerQuery(e.target.value)}
            placeholder={bi("搜索演练标题或诉求…", "Search title or goal…")}
            aria-label={bi("搜索演练记录", "Search rehearsals")}
          />
          {ledgerQuery && (
            <button
              type="button"
              onClick={() => setLedgerQuery("")}
              aria-label={bi("清空搜索", "Clear search")}
            >
              <IconClose />
            </button>
          )}
        </div>
      )}
      <div className="rh-sess-menu-list">
        {filteredSessions.length === 0 ? (
          <div className="rh-ledger-empty-filter">
            <span>{bi("无匹配演练记录", "No matching rehearsals")}</span>
            <button
              type="button"
              className="link small"
              onClick={() => {
                setLedgerQuery("");
                setLedgerFilter("all");
              }}
            >
              {bi("重置", "Reset")}
            </button>
          </div>
        ) : (
          [...filteredSessions]
            .sort((a, b) => Number(Boolean(a.voided)) - Number(Boolean(b.voided)))
            .map((item) => {
            const on = !showLauncher && item.id === activeId;
            const hasConflict = Boolean(
              !item.applied &&
                !item.voided &&
                item.conflict_alerts?.some((a) => a.severity === "conflict"),
            );
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={on}
                className={`rh-sess-menu-item ${on ? "on" : ""}${item.voided ? " is-voided" : ""}`}
                onClick={() => selectSession(item)}
              >
                <span className={`rh-sdot ${rehearsalDotClass(item)}`} aria-hidden />
                <span className="rh-sess-menu-main">
                  <b>{item.title}</b>
                  <small>
                    <span
                      className={`rh-sess-st${item.applied ? " is-applied" : item.voided ? " is-voided" : item.stage === "finalized" ? " is-pending" : ""}`}
                    >
                      {stepSummary(item)}
                    </span>
                    {hasConflict && (
                      <span className="rh-sess-conflict">
                        {bi("· 冲突提醒", "· Conflict")}
                      </span>
                    )}
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
              title={bi(
                "收起专注模式，显示左侧交付集群列表与顶部标签",
                "Exit focus mode and show cluster list & tabs",
              )}
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
              <span>{bi("交付视图", "Delivery View")}</span>
            </button>
          ) : (
            <button
              type="button"
              className="rh-nav-pill focus"
              onClick={() => {
                setLedgerCollapsed(false);
                onFocusChange?.(true);
                document
                  .querySelector(".md-detail")
                  ?.scrollTo({ top: 0, behavior: "smooth" });
              }}
              title={bi(
                "隐藏周围交付列表，展开演练记录栏与专注工作台",
                "Hide delivery list and expand rehearsal ledger & workspace",
              )}
            >
              <IconExpand />
              <span>{bi("专注演练", "Focus Mode")}</span>
            </button>
          )}

          {focused && !narrow && !ledgerOpen && (
            <button
              type="button"
              className="rh-nav-pill ledger-toggle"
              onClick={() => setLedgerCollapsed(false)}
              title={bi("展开左侧演练记录栏", "Expand rehearsal ledger")}
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
              <span>{bi("展开记录栏", "Show Ledger")}</span>
            </button>
          )}

          {focused && (
            <span
              className="rh-cluster-crumb"
              title={`${c.id} · ${c.app_name} ${c.version}`.trim()}
            >
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
                ? bi(
                    `共 ${list.length} 次记录 · ${finalizedSessions.length} 份已定稿`,
                    `${list.length} sessions · ${finalizedSessions.length} finalized`,
                  )
                : bi("尚无演练记录", "No rehearsals yet")}
            </span>
          )}

          {(narrow || !focused || !ledgerOpen) && hasSessions && (
            <div className="rh-sess-bar">
              <Dropdown
                trigger="click"
                position="bl"
                popupVisible={sessMenuOpen}
                onVisibleChange={setSessMenuOpen}
                getPopupContainer={(node) =>
                  (node.closest(".rh-topbar") as HTMLElement) ||
                  node.parentElement ||
                  document.body
                }
                triggerProps={{ autoFitPosition: true, updateOnScroll: true }}
                droplist={sessionDroplist}
              >
                <button
                  type="button"
                  className="rh-sess-trigger"
                  aria-label={bi("切换演练记录", "Switch rehearsal")}
                >
                  <span
                    className={`rh-sdot ${rehearsalDotClass(activeSessionSummary)}`}
                    aria-hidden
                  />
                  <span className="rh-sess-trigger-txt">
                    {showLauncher
                      ? bi("切换历史演练", "Switch Rehearsal")
                      : activeSessionSummary?.title || bi("切换演练", "Switch Rehearsal")}
                  </span>
                  <span className="rh-sess-count num">{list.length}</span>
                  <IconDown />
                </button>
              </Dropdown>

              <button
                type="button"
                className={`rh-new-btn ${creating ? "on" : ""}`}
                onClick={() => {
                  setSessMenuOpen(false);
                  if (creating) {
                    setCreating(false);
                    clearStaleCreateErr();
                  } else {
                    setCreating(true);
                    clearStaleCreateErr();
                    requestAnimationFrame(() => goalRef.current?.focus({ preventScroll: true }));
                  }
                }}
              >
                {creating ? (
                  <>{bi("返回当前演练", "Back to Session")}</>
                ) : (
                  <>
                    <IconPlus /> {bi("新建", "New")}
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
            title={
              deliveryOpen
                ? bi("收起交付基线 (Esc)", "Close baseline (Esc)")
                : bi("查看当前交付基线", "View delivery baseline")
            }
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
            <span>
              {deliveryOpen
                ? bi("收起交付基线", "Hide Baseline")
                : bi("查看交付基线", "Baseline")}
            </span>
            {c.hosts > 0 && (
              <em className="num">{bi(`${c.hosts} 节点`, `${c.hosts} nodes`)}</em>
            )}
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
            <aside
              className="rh-ledger-rail"
              aria-label={bi("演练记录", "Rehearsal Ledger")}
            >
              <div className="rh-ledger-head">
                <div className="rh-ledger-head-title">
                  <b>{bi("演练记录", "Rehearsals")}</b>
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
                          clearStaleCreateErr();
                        } else {
                          setCreating(true);
                          clearStaleCreateErr();
                          requestAnimationFrame(() => goalRef.current?.focus({ preventScroll: true }));
                        }
                      }}
                    >
                      {creating ? (
                        <span>{bi("返回", "Back")}</span>
                      ) : (
                        <>
                          <IconPlus />
                          <span>{bi("新建", "New")}</span>
                        </>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rh-ledger-collapse"
                    onClick={() => setLedgerCollapsed(true)}
                    aria-label={bi("收起演练记录栏", "Collapse rehearsal ledger")}
                    title={bi("收起演练记录栏", "Collapse rehearsal ledger")}
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
                        placeholder={bi("搜索演练记录…", "Search rehearsals…")}
                        aria-label={bi("搜索演练记录", "Search rehearsals")}
                      />
                      {ledgerQuery && (
                        <button
                          type="button"
                          onClick={() => setLedgerQuery("")}
                          aria-label={bi("清空搜索", "Clear search")}
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
                      aria-label={bi("按演练状态筛选", "Filter rehearsals by status")}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={ledgerFilter === "all"}
                        className={ledgerFilter === "all" ? "on" : ""}
                        onClick={() => setLedgerFilter("all")}
                      >
                        <span>{bi("全部", "All")}</span>
                        <i className="num">{list.length}</i>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={ledgerFilter === "active"}
                        className={ledgerFilter === "active" ? "on" : ""}
                        onClick={() => setLedgerFilter("active")}
                      >
                        <span>{bi("进行中", "Active")}</span>
                        <i className="num">{inProgressSessions.length}</i>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={ledgerFilter === "finalized"}
                        className={ledgerFilter === "finalized" ? "on" : ""}
                        onClick={() => setLedgerFilter("finalized")}
                      >
                        <span>{bi("已定稿", "Finalized")}</span>
                        <i className="num">{finalizedSessions.length}</i>
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="rh-ledger-body">
                {showLauncher && (
                  <div className="rh-ledger-group">
                    <span className="rh-ledger-gtitle">
                      {bi("当前草稿", "Current Draft")}
                    </span>
                    <div className="rh-ledger-card on is-draft">
                      <div className="rh-ledger-card-top">
                        <span className="rh-sdot is-draft-dot" aria-hidden />
                        <b>{title.trim() || bi("新建变更演练", "New Change Rehearsal")}</b>
                      </div>
                      <div className="rh-ledger-card-meta">
                        <span className="rh-ledger-pill draft">
                          {liveCreate?.error
                            ? bi("通道受阻 · 待重试", "Blocked · Retry")
                            : creatingBusy
                              ? bi("AI 推演中…", "AI thinking…")
                              : activePresetMeta
                                ? activePresetMeta.label
                                : bi("待录入诉求", "Enter goal")}
                        </span>
                        <span>{bi("未保存", "Unsaved")}</span>
                      </div>
                    </div>
                  </div>
                )}

                {visibleInProgress.length > 0 && (
                  <div className="rh-ledger-group">
                    <span className="rh-ledger-gtitle num">
                      {bi(
                        `进行中 (${visibleInProgress.length})`,
                        `In Progress (${visibleInProgress.length})`,
                      )}
                    </span>
                    {visibleInProgress.map((item) => {
                      const on = !showLauncher && item.id === activeId;
                      const sessionRunning = hasRunningTaskForSession(
                        activeRehearsalTasks,
                        c.id,
                        item.id,
                      );
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`rh-ledger-card ${on ? "on" : ""}${sessionRunning ? " is-ai-live" : ""}`}
                          onClick={() => selectSession(item)}
                        >
                          <div className="rh-ledger-card-top">
                            <span
                              className={`rh-sdot st-${item.stage}${sessionRunning ? " is-live" : ""}`}
                              aria-hidden
                            />
                            <b>{item.title}</b>
                          </div>
                          <div className="rh-ledger-card-meta">
                            {sessionRunning ? (
                              <span className="rh-ledger-pill is-live">
                                <i aria-hidden />
                                {bi("AI 推演中", "AI running")}
                              </span>
                            ) : (
                              <span className={`rh-ledger-pill st-${item.stage}`}>
                                {stepSummary(item)}
                              </span>
                            )}
                            {item.mode === "quick" && (
                              <span className="rh-mode-pill is-quick is-xs">
                                {bi("极速", "Quick")}
                              </span>
                            )}
                            {item.mode === "light" && (
                              <span className="rh-mode-pill is-light is-xs">
                                {bi("简单", "Light")}
                              </span>
                            )}
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
                      {bi(
                        `已归档 (${visibleFinalized.length})`,
                        `Archived (${visibleFinalized.length})`,
                      )}
                    </span>
                    {[...visibleFinalized]
                      .sort((a, b) => Number(Boolean(a.voided)) - Number(Boolean(b.voided)))
                      .map((item) => {
                      const on = !showLauncher && item.id === activeId;
                      const hasConflict = Boolean(
                        !item.applied &&
                          !item.voided &&
                          item.conflict_alerts?.some((a) => a.severity === "conflict"),
                      );
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`rh-ledger-card ${on ? "on" : ""}${item.voided ? " is-voided" : ""}`}
                          onClick={() => selectSession(item)}
                        >
                          <div className="rh-ledger-card-top">
                            <span className={`rh-sdot ${rehearsalDotClass(item)}`} aria-hidden />
                            <b>{item.title}</b>
                          </div>
                          <div className="rh-ledger-card-meta">
                            <span
                              className={`rh-ledger-pill st-finalized${item.voided ? " is-voided" : item.applied ? " is-applied" : " is-pending-apply"}`}
                            >
                              {stepSummary(item)}
                            </span>
                            {hasConflict && (
                              <span className="rh-ledger-conflict">
                                {bi("冲突", "Conflict")}
                              </span>
                            )}
                            {item.mode === "quick" && (
                              <span className="rh-mode-pill is-quick is-xs">
                                {bi("极速", "Quick")}
                              </span>
                            )}
                            {item.mode === "light" && (
                              <span className="rh-mode-pill is-light is-xs">
                                {bi("简单", "Light")}
                              </span>
                            )}
                            <span className="num">{ago(item.updated_at)}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {hasSessions && filteredSessions.length === 0 && (
                  <div className="rh-ledger-empty-filter">
                    <span>
                      {bi("未找到匹配的演练记录", "No matching rehearsals found")}
                    </span>
                    <button
                      type="button"
                      className="link small"
                      onClick={() => {
                        setLedgerQuery("");
                        setLedgerFilter("all");
                      }}
                    >
                      {bi("清除筛选条件", "Clear filters")}
                    </button>
                  </div>
                )}

                {!hasSessions && (
                  <p className="rh-ledger-empty-hint">
                    {bi("尚无已归档记录", "No archived rehearsals yet")}
                  </p>
                )}
              </div>
            </aside>
          </div>
        )}

        <div className="rh-work-col">
          {loadErr && (
            <div className="rh-sync-err" role="status">
              <IconExclamationCircle />
              <span>
                {bi(`演练记录同步失败：${loadErr}`, `Failed to sync rehearsals: ${loadErr}`)}
              </span>
              <button
                type="button"
                className="link small"
                onClick={() => void loadList(false)}
              >
                {bi("重试", "Retry")}
              </button>
            </div>
          )}

          {offline && (
            <div className="rh-offline" role="status">
              <span className="sdot s-warn" />
              {bi(
                "网络已断开：已加载的采集脚本与命令仍可查看复制，连接恢复后可继续提交。",
                "Network disconnected: loaded scripts and commands remain readable; submit once back online.",
              )}
            </div>
          )}

          {showLauncher ? (
            <div
              className={`rh-launcher ${liveCreate ? "has-live" : ""}`.trim()}
            >
              <div className="rh-launch-top">
                <div className="rh-launch-title">
                  <h2>
                    <Spark size={18} rainbow />{" "}
                    {bi("新建变更演练", "New Change Rehearsal")}
                  </h2>
                  <div
                    className="rh-baseline-pills"
                    aria-label={bi("集群基线", "Cluster baseline")}
                  >
                    {baselineFacts.map((f) => (
                      <span key={f} className="rh-base-pill" title={f}>
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
                <Smooth>
                  {!liveCreate && (
                    <div className="rh-launch-collapsible">
                      <ImportTemplateBar
                        cluster={c}
                        onImported={(rid) => {
                          creatingRef.current = false;
                          setCreating(false);
                          clearStaleCreateErr();
                          void loadList(false);
                          go({
                            name: "deliveries",
                            id: c.id,
                            tab: "rehearsal",
                            rehearsal: rid,
                          });
                        }}
                      />
                      <RehearsalPipelineArt />
                      <div
                        className="rh-preset-grid rh-presets"
                        role="group"
                        aria-label={bi("常见变更场景", "Common change presets")}
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

              {creatingBusy ? (
                <div className="rh-launch-busy-goal">
                  <span className="rh-launch-busy-k">
                    {bi("已提交变更诉求", "Submitted Goal")}
                  </span>
                  <span className="rh-launch-busy-v">
                    {title.trim() || goal.trim()}
                  </span>
                  {goalImages.length > 0 && (
                    <span className="rh-launch-busy-img num">
                      <IconImage /> {goalImages.length}
                    </span>
                  )}
                </div>
              ) : (
              <div
                ref={composeRef}
                className={`rh-compose ${offline ? "off" : ""} ${dragGoal ? "is-drag" : ""} ${creatingBusy ? "is-busy" : ""} ${spacious.expanded ? "is-writing" : ""}`}
                onDragOver={(e) => {
                  if (e.dataTransfer?.types?.includes("Files")) {
                    e.preventDefault();
                    if (!dragGoal) setDragGoal(true);
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setDragGoal(false);
                  }
                }}
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
                {secCtxDraft ? (
                  <div className="rh-sec-ctx-chip">
                    <div className="rh-sec-ctx-head">
                      <div className="rh-sec-ctx-info">
                        <span className="rh-sec-ctx-tag">
                          {secCtxDraft.kind === "cve_patch"
                            ? bi("安全修复 · 漏洞补丁升级", "Security · CVE Patch")
                            : secCtxDraft.kind === "cert_rotation"
                              ? bi("安全修复 · TLS 证书滚动轮换", "Security · Cert Rotation")
                              : bi("安全修复 · 配置基线加固", "Security · Config Hardening")}
                        </span>
                        {secCtxDraft.package ? (
                          <span className="mono rh-sec-ctx-ver">
                            {secCtxDraft.package}
                            {secCtxDraft.current_version ? ` ${secCtxDraft.current_version}` : ""}
                            {secCtxDraft.target_version ? ` → ${secCtxDraft.target_version}` : ""}
                          </span>
                        ) : secCtxDraft.cert_target ? (
                          <span className="mono rh-sec-ctx-ver">{secCtxDraft.cert_target}</span>
                        ) : title ? (
                          <span className="rh-sec-ctx-ver">{title}</span>
                        ) : null}
                        {secCtxDraft.repo_fix_ready && (
                          <span className="rh-sec-ctx-ok">
                            {bi("软件源已有修复版", "Fix in repo")}
                          </span>
                        )}
                      </div>
                      {!creatingBusy && (
                        <button
                          type="button"
                          className="rh-sec-ctx-x"
                          onClick={() => {
                            setPickedPreset(null);
                            setSecCtxDraft(null);
                            setTitle("");
                            setGoal("");
                            setGoalImages([]);
                            goalRef.current?.focus();
                          }}
                          aria-label={bi("清除安全演练草稿", "Clear security rehearsal draft")}
                          title={bi("清除并切换为普通演练", "Clear and switch to standard rehearsal")}
                        >
                          <IconClose />
                        </button>
                      )}
                    </div>
                    {secCtxDraft.cves && secCtxDraft.cves.length > 0 && (
                      <div className="rh-sec-ctx-cves">
                        {secCtxDraft.cves.slice(0, 8).map((id) => (
                          <span key={id} className="mono rh-sec-ctx-cve">
                            {id}
                          </span>
                        ))}
                        {secCtxDraft.cves.length > 8 && (
                          <span className="faint small">
                            +{secCtxDraft.cves.length - 8}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ) : srcCtxDraft ? (
                  <div className="rh-sec-ctx-chip">
                    <div className="rh-sec-ctx-head">
                      <div className="rh-sec-ctx-info">
                        <span className="rh-sec-ctx-tag">
                          {srcCtxDraft.badge}
                        </span>
                        {(srcCtxDraft.subject || title) && (
                          <span className="rh-sec-ctx-ver">
                            {srcCtxDraft.subject || title}
                          </span>
                        )}
                      </div>
                      {!creatingBusy && (
                        <button
                          type="button"
                          className="rh-sec-ctx-x"
                          onClick={() => {
                            setPickedPreset(null);
                            setSrcCtxDraft(null);
                            setTitle("");
                            setGoal("");
                            setGoalImages([]);
                            goalRef.current?.focus();
                          }}
                          aria-label={bi("清除带入的演练草稿", "Clear imported rehearsal draft")}
                          title={bi("清除并切换为手动新建演练", "Clear and switch to manual rehearsal")}
                        >
                          <IconClose />
                        </button>
                      )}
                    </div>
                    {srcCtxDraft.tags && srcCtxDraft.tags.length > 0 && (
                      <div className="rh-sec-ctx-cves">
                        {srcCtxDraft.tags.slice(0, 6).map((t) => (
                          <span key={t} className="mono rh-sec-ctx-cve">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rh-compose-title">
                    <input
                      type="text"
                      value={title}
                      disabled={creatingBusy}
                      onPointerDown={spacious.onFieldPointerDown}
                      onChange={(e) => setTitle(e.target.value)}
                      maxLength={100}
                      placeholder={bi(
                        "演练标题（可选，留空由 AI 按诉求自动归纳命名）",
                        "Rehearsal title (optional — AI auto-names from goal if blank)",
                      )}
                      aria-label={bi("演练标题", "Rehearsal title")}
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
                        aria-label={bi("清空输入", "Clear input")}
                        title={bi("清空", "Clear")}
                      >
                        <IconClose />
                      </button>
                    )}
                  </div>
                )}

                <textarea
                  ref={bindGoalRef}
                  value={goal}
                  disabled={creatingBusy}
                  rows={1}
                  maxLength={4000}
                  onPointerDown={spacious.onFieldPointerDown}
                  onChange={(e) => setGoal(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void startNew();
                    }
                  }}
                  placeholder={bi(
                    "写明变更目标（目标版本、新增节点或待调参数）、可接受的业务闪断窗口与测试环境情况；支持直接 Ctrl+V 粘贴架构图或工单截图…",
                    "Describe your change goal (target version, new nodes, or params), acceptable disruption window, and staging env; Ctrl+V to paste diagrams or screenshots…",
                  )}
                  aria-label={bi("变更诉求", "Change goal")}
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

                <div className="rh-mode-bar">
                  <Segmented<RehearsalModeChoice>
                    size="sm"
                    label={bi("变更档位", "Change workflow")}
                    value={secCtxDraft ? "full" : launchMode}
                    onChange={(v) => {
                      if (!creatingBusy && !secCtxDraft) setLaunchMode(v);
                    }}
                    options={[
                      {
                        value: "auto",
                        label: bi("自动判断", "Auto"),
                      },
                      {
                        value: "quick",
                        label: bi("极速变更", "Quick"),
                      },
                      {
                        value: "light",
                        label: bi("简单推演", "Light"),
                      },
                      {
                        value: "full",
                        label: bi("全量推演", "Full"),
                      },
                    ]}
                  />
                  <span className="rh-mode-hint">
                    {secCtxDraft
                      ? bi(
                          "安全漏洞与证书修复默认走全量推演，确保核验与 VEX 闭环",
                          "Security remediation runs Full Rehearsal for full verification & VEX sync",
                        )
                      : launchMode === "quick"
                        ? bi(
                            "两步直达：跳过问答与探针 · 直出 2～3 步执行核验 → 一键出《变更报告》",
                            "2-step direct: Skip scope & probe · 2–3 direct steps → 1-click Change Report",
                          )
                        : launchMode === "light"
                          ? bi(
                              "三步轻演练：单屏只读快采 → 精简核验 → 归档《变更报告》",
                              "3-step light: Concise probe → Quick verify → Change Report",
                            )
                          : launchMode === "full"
                            ? bi(
                                "完整四步：边界对齐 → 只读探针 → 测试演练 → 生产实施方案",
                                "Full 4-stage: Scope → Probe → Staging Rehearsal → Production SOP",
                              )
                            : bi(
                                "描述模糊先核对补全诉求；明确热改直出步骤，未知状态先快采，重启/切主走四步",
                                "Clarifies vague goals first; auto-routes clear tweaks to Quick, uncertain state to Light, high-risk to Full",
                              )}
                  </span>
                </div>

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
                          ? bi(
                              "当前所选模型不支持图片识别，可切换支持看图的模型",
                              "Selected model does not support images; switch to a vision model",
                            )
                          : bi(
                              "上传或直接 Ctrl+V 粘贴截图",
                              "Upload or Ctrl+V paste screenshots",
                            )
                      }
                    >
                      <IconImage />
                      <span>{bi("粘贴/添加截图", "Paste / Add Image")}</span>
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
                      <span>
                        {bi(
                          "只读探针 · 零直连生产",
                          "Read-only probe · Zero direct prod writes",
                        )}
                      </span>
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
                          ? bi("⌘ + Enter 发起推演 · Enter 换行", "⌘ + Enter Launch · Enter newline")
                          : bi("Ctrl + Enter 发起推演 · Enter 换行", "Ctrl + Enter Launch · Enter newline")
                      }
                      loading={creatingBusy}
                      disabled={!goal.trim() || offline}
                      onClick={() => void startNew()}
                    >
                      {secCtxDraft || launchMode === "full"
                        ? bi("对齐变更边界", "Align Scope")
                        : launchMode === "quick"
                          ? bi("直出执行步骤", "Generate Steps")
                          : launchMode === "light"
                            ? bi("直出极简探针", "Generate Probe")
                            : bi("智能研判并发起", "Analyze & Start")}
                    </Button>
                  </div>
                </div>
              </div>
              )}

              {liveCreate && (
                <RehearsalAIProcess
                  live={liveCreate}
                  title={liveCreate.title}
                  onAbort={() => abortRehearsalTask(createKey)}
                  onRetry={() => void startNew()}
                  onDismiss={() => clearRehearsalTask(createKey)}
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
              peers={list || []}
              autoExpandCreateTrace={freshId === activeId}
              offline={offline}
              noVision={effectiveNoVision}
              pick={pick}
              aiOpts={aiOpts}
              onListChanged={() => loadList(false)}
              onSessionSync={syncSessionInList}
              onClusterChanged={onClusterChanged}
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
          title={bi("当前交付基线", "Delivery Baseline")}
          onCancel={() => setDeliveryOpen(false)}
          style={{ width: "min(94vw, 480px)" }}
        >
          <DeliveryBaselineAside
            c={c}
            inModal
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
  const extra = withPkgOrNode
    ? bi("，可附包或节点说明", ", optional pkg/node note")
    : "";
  if (base && next) {
    return bi(
      `当前基线 ${base}，填写目标版本号（如 ${next}${extra}），回车确认…`,
      `Baseline ${base}; enter target version (e.g. ${next}${extra}), press Enter…`,
    );
  }
  return bi(
    `填写已确定的目标版本号（如 16.6 / 7.2.5${extra}），回车确认…`,
    `Enter confirmed target version (e.g. 16.6 / 7.2.5${extra}), press Enter…`,
  );
}

const UNDECIDED_HEAD_RE =
  /待定|未定|不明|未知|不清|不确定|尚未|暂未|暂无|暂不|未明确|未就绪|未准备|未到位|未规划|未分配|无独立|无测试|无演练|无需|不需要|不涉及|不指定|不升级|不变更|保持现状|按默认|保守|先确认|先核实|先评估|先排查|待确认|待评估|待规划|待申请|自动择优|\b(?:tbd|undecided|unknown|unclear|not\s+(?:yet|ready|decided|set|needed|applicable)|none|no\s+test|default|conservative|verify\s+first)\b/i;

function inferScopeSupplement(
  q: ScopeQuestion,
  cleanBase: string,
  headline: string,
  explicitHint: string,
  baselineVersion?: string,
): ScopeSupplementSpec | null {
  if (explicitHint) {
    if (/版本|小版本|大版本|补丁|镜像|tag|version|patch|release|image/i.test(explicitHint)) {
      return {
        tag: bi("目标版本", "Target Version"),
        badge: bi("填版本号", "Enter version"),
        placeholder: buildVersionPlaceholder(baselineVersion, false),
      };
    }
    if (/参数|配置|阈值|配额|连接|内存|param|config|threshold|quota|connection|memory/i.test(explicitHint)) {
      return {
        tag: bi("目标参数", "Target Param"),
        badge: bi("填目标值", "Enter value"),
        placeholder: bi(
          "填写待调参数名与目标值（如 max_connections=1000），回车确认…",
          "Enter parameter & target value (e.g. max_connections=1000), press Enter…",
        ),
      };
    }
    if (/节点|主机|机器|ip|地址|实例|node|host|server|address|instance/i.test(explicitHint)) {
      return {
        tag: bi("节点信息", "Node Info"),
        badge: bi("填节点信息", "Enter node"),
        placeholder: bi(
          "填写新增或目标节点 IP / 主机名（如 10.0.1.14），回车确认…",
          "Enter new or target node IP / hostname (e.g. 10.0.1.14), press Enter…",
        ),
      };
    }
    if (/窗口|时段|时间|排期|window|schedule|slot|time/i.test(explicitHint)) {
      return {
        tag: bi("维护时段", "Window"),
        badge: bi("填时间窗", "Enter window"),
        placeholder: bi(
          "填写已排定的变更时间窗（如周六 02:00-04:00），回车确认…",
          "Enter scheduled maintenance window (e.g. Sat 02:00-04:00), press Enter…",
        ),
      };
    }
    return {
      tag: bi(
        explicitHint.length <= 6 ? explicitHint : "补充说明",
        explicitHint.length <= 16 ? explicitHint : "Details",
      ),
      badge: bi(
        explicitHint.length <= 4 ? `填${explicitHint}` : "补充说明",
        explicitHint.length <= 14 ? `Enter ${explicitHint}` : "Add details",
      ),
      placeholder: bi(
        `填写具体${explicitHint}，回车确认…`,
        `Specify ${explicitHint}, press Enter…`,
      ),
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
    /(?:版本|小版本|大版本|补丁|镜像)(?:已定|已明确|明确|已确定|确定|已锁定|锁定|已选定|指定)|(?:已确定|已锁定|已明确|指定).*(?:版本|补丁|镜像)|(?:target\s+)?(?:version|patch|image)\s+(?:confirmed|locked|selected|decided)/i.test(
      cleanBase,
    );
  const qAsksTargetVersion =
    /(?:目标|升级|计划|待升|新|跨|小|大|补丁).*版本|版本.*(?:准备|就绪|哪一步|明确|确定|定了吗|是什么|多少)|升级到|target\s+version|upgrade\s+to/i.test(
      qText,
    );
  const optVersionAffirmative =
    /全部就绪|均已就绪|都已就绪|全面就绪|目标明确|目标已定|版本已定|版本明确|已就绪|已备妥|已到位|已在内网|包已就绪|直接升级|已准备|\ball\s+ready\b|\bversion\s+(?:confirmed|ready)\b/i.test(
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
      /离线包|安装包|节点|package|node/i.test(qText) &&
      /全部就绪|均已就绪|包与节点|all\s+ready/i.test(cleanBase);
    return {
      tag: bi("目标版本", "Target Version"),
      badge: bi("填版本号", "Enter version"),
      placeholder: buildVersionPlaceholder(baselineVersion, alsoHasPkgOrNode),
    };
  }

  // 2. Parameter / threshold / quota target decided
  const optExplicitParamDecided =
    /(?:参数|配置项|阈值|配额|目标值)(?:已定|已明确|明确|已确定|指定)|(?:已确定|已明确|指定).*(?:参数|阈值|配额|目标值)|(?:param|threshold|quota|target\s+value)\s+(?:confirmed|decided|set)/i.test(
      cleanBase,
    );
  const qAsksTargetParam =
    /(?:待调|调整|修改|目标|计划).*(?:参数|阈值|配额|目标值)|(?:参数|阈值|配额).*(?:目标值|明确|已定|哪些|多少|调到)|target\s+(?:param|config|value)/i.test(
      qText,
    );
  const optParamAffirmative =
    /参数已定|目标值已定|目标明确|目标已定|全部就绪|方案已定|已确定|已明确|指定参数|\bparam.*ready\b/i.test(
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
      tag: bi("目标参数", "Target Param"),
      badge: bi("填目标值", "Enter value"),
      placeholder: bi(
        "填写待调参数名与目标值（如 max_connections=1000），回车确认…",
        "Enter parameter & target value (e.g. max_connections=1000), press Enter…",
      ),
    };
  }

  // 3. Scale-out / replacement node IP or host ready
  const optExplicitNodeDecided =
    /(?:节点|机器|主机|备库|从库|实例|IP)(?:已定|已就绪|已到位|已分配|已准备|已备妥|已明确|指定)|(?:指定|已分配|已准备).*(?:节点|机器|主机|IP)|\b(?:node|host|ip)\s+(?:ready|assigned|confirmed)\b/i.test(
      cleanBase,
    );
  const qAsksNodeReady =
    /(?:新增|扩容|缩容|替换|下线|新|待加|目标).*(?:节点|机器|主机|备库|从库)|(?:节点|机器|主机).*(?:准备|就绪|到位|分配|哪一步|IP)|\b(?:new|target|replica)\s+(?:node|host)\b/i.test(
      qText,
    );
  const isTestEnvOnly =
    /测试环境|演练环境|沙箱|本地验证|staging|sandbox|test\s+env/i.test(qText) &&
    !/扩容|缩容|生产新增|scale/i.test(qText);
  if (
    !isTestEnvOnly &&
    (optExplicitNodeDecided ||
      (qAsksNodeReady &&
        /全部就绪|均已就绪|已就绪|已到位|已分配|已备妥|机器已|\ball\s+ready\b/i.test(cleanBase)))
  ) {
    return {
      tag: bi("节点信息", "Node Info"),
      badge: bi("填节点信息", "Enter node"),
      placeholder: bi(
        "填写新增或目标节点 IP / 主机名（如 10.0.1.14），回车确认…",
        "Enter new or target node IP / hostname (e.g. 10.0.1.14), press Enter…",
      ),
    };
  }

  // 4. Specific scheduled maintenance window
  if (
    /(?:窗口|时段|时间|排期)(?:已定|已排定|已确定|已批复)|指定(?:维护|变更)?(?:窗口|时段|时间)|\b(?:window|schedule)\s+(?:confirmed|scheduled|approved)\b/i.test(
      cleanBase,
    )
  ) {
    return {
      tag: bi("维护时段", "Window"),
      badge: bi("填时间窗", "Enter window"),
      placeholder: bi(
        "填写已排定的变更时间窗（如周六 02:00-04:00），回车确认…",
        "Enter scheduled maintenance window (e.g. Sat 02:00-04:00), press Enter…",
      ),
    };
  }

  // 5. Custom external VIP / proxy / domain
  if (
    /外部.*(?:代理|负载均衡|VIP)|自建.*(?:代理|负载均衡)|自定义(?:域名|VIP|入口)|指定.*(?:VIP|域名|入口)|external\s+(?:proxy|vip|lb)|custom\s+(?:vip|domain|endpoint)/i.test(
      cleanBase,
    )
  ) {
    return {
      tag: bi("接入入口", "Endpoint"),
      badge: bi("填入口信息", "Enter endpoint"),
      placeholder: bi(
        "填写外部 VIP、域名或负载均衡组件说明，回车确认…",
        "Enter external VIP, domain, or load balancer details, press Enter…",
      ),
    };
  }

  // 6. General explicit "X已定 / 已指定"
  if (/(?:已定|已指定|指定目标)$/.test(headline)) {
    return {
      tag: bi("具体目标", "Target"),
      badge: bi("填具体项", "Specify"),
      placeholder: bi(
        "填写已确定的具体目标或约束值，回车确认…",
        "Enter confirmed target or constraint value, press Enter…",
      ),
    };
  }

  return null;
}

function inferQuestionTopic(q: ScopeQuestion, index: number): string {
  const explicit = (q.label || "").trim();
  if (explicit) return explicit;
  const text = q.question || "";
  if (/版本|离线包|安装包|兼容|扩展|升级包|version|package|upgrade|compat/i.test(text))
    return bi("版本与离线包", "Version & Packages");
  if (/主从|拓扑|复制|巡检|漂移|健康|实例|stanza|etcd|sentinel|patroni|topolog|replic|drift|health|primary|standby/i.test(text)) {
    return bi("拓扑与现状", "Topology & State");
  }
  if (/窗口|闪断|中断|重连|入口|vip|排空|停机|window|downtime|disrupt|drain|reconnect/i.test(text))
    return bi("窗口与连接", "Window & Traffic");
  if (/备份|回退|回滚|演练环境|测试环境|虚拟机|backup|rollback|test\s*env|staging|sandbox/i.test(text))
    return bi("备份与演练", "Backup & Staging");
  if (/容量|内存|磁盘|连接数|参数|配置|capacity|memory|disk|connection|param|config/i.test(text))
    return bi("容量与参数", "Capacity & Params");
  return bi(`边界项 0${index + 1}`, `Scope 0${index + 1}`);
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
    /[（(]\s*(?:(?:请)?(?:补充|填写|注明|输入)|(?:please\s+)?(?:specify|enter|provide|note|fill\s+in))\s*([^）)]*)[）)]\s*$/i,
  );
  if (supMatch) {
    cleanBase = trimmed.slice(0, supMatch.index).trim();
    explicitHint = (supMatch[1] || bi("细节", "details")).trim();
  }
  const parts = cleanBase
    .split(/[，,]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  let headline = cleanBase;
  let sub = "";
  const sep = bi("，", ", ");
  if (parts.length >= 3 && parts[0].length <= 4) {
    headline = `${parts[0]} · ${parts[1]}`;
    sub = parts.slice(2).join(sep);
  } else if (parts.length > 1) {
    headline = parts[0];
    sub = parts.slice(1).join(sep);
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
  const pfxZh = `${opt.cleanBase}（`;
  if (a !== opt.raw && a.startsWith(pfxZh) && a.endsWith("）")) {
    const inner = a.slice(pfxZh.length, -1);
    const colonMatch = inner.match(/^[^：:]{1,24}[：:]\s?([\s\S]*)$/);
    return {
      matched: true,
      detail: colonMatch ? colonMatch[1] : inner,
    };
  }
  const pfxEn = `${opt.cleanBase} (`;
  if (a !== opt.raw && a.startsWith(pfxEn) && a.endsWith(")")) {
    const inner = a.slice(pfxEn.length, -1);
    const colonMatch = inner.match(/^[^：:]{1,24}[：:]\s?([\s\S]*)$/);
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

const ScopeAlignmentDeck = React.memo(function ScopeAlignmentDeck({
  rehearsalId,
  questions,
  answers,
  setAnswers,
  extraScope,
  setExtraScope,
  disabled,
  freshReveal = false,
  baselineVersion,
  intentUnclear = false,
  onRefineGoal,
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
  intentUnclear?: boolean;
  onRefineGoal?: () => void;
}) {
  const lang = useLang();
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
    const key = `${rehearsalId}:${questions.map((q) => `${q.id}:${q.question}`).join("|")}`;
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
  }, [questions, baselineVersion, lang]);

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

  const formatSupplement = (base: string, tag: string, detail: string) =>
    getLang() === "en-US"
      ? `${base} (${tag}: ${detail})`
      : `${base}（${tag}：${detail}）`;

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
        ? formatSupplement(opt.cleanBase, opt.supplement.tag, carryDetail)
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
    const sanitized = detailRaw.replace(/[（）()]/g, "");
    const finalDetail = trimEdges ? sanitized.trim() : sanitized;
    const nextVal = finalDetail.trim()
      ? formatSupplement(
          opt.cleanBase,
          opt.supplement?.tag || bi("补充", "Note"),
          finalDetail,
        )
      : opt.cleanBase;
    setAnswers((prev) => ({ ...prev, [q.id]: nextVal }));
  };

  return (
    <>
      <div
        className={`rh-sec-head rh-scope-sec-head ${freshReveal ? "is-fresh-head" : ""}`}
      >
        <div>
          <h3>
            {intentUnclear
              ? bi(
                  "核对 AI 识别到的诉求并补全边界",
                  "Confirm Recognized Intent & Complete Scope",
                )
              : bi("确认变更边界与窗口约束", "Confirm Scope & Window Constraints")}
          </h3>
          <p>
            {intentUnclear
              ? bi(
                  "原始描述较简略或主要依赖截图识别，请先确认下方诉求并补全目标后再生成纯只读探针；如 AI 识别方向有误，可随时点击「修正诉求」直接改写。",
                  "Your initial input was brief or screenshot-based. Confirm the recognized intent below before generating a probe, or click Refine Goal if AI misunderstood.",
                )
              : bi(
                  "点选最贴近现场的前提即可生成纯只读探针；暂未确认的维度将自动按生产保守策略兜底。",
                  "Select options matching your environment to build a read-only probe; unspecified items default to safe production settings.",
                )}
          </p>
        </div>
        {(questions.length > 0 || (intentUnclear && onRefineGoal)) && (
          <div className="rh-scope-head-tools">
            {intentUnclear && onRefineGoal && (
              <button
                type="button"
                className="rh-scope-mode-btn is-refine"
                disabled={disabled}
                onClick={onRefineGoal}
              >
                <IconEdit />
                <span>{bi("识别有误？修正诉求", "Misread? Refine Goal")}</span>
              </button>
            )}
            {questions.length > 0 && (
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
                    ? bi(
                        `已对齐 ${answeredCount}/${questions.length}`,
                        `Aligned ${answeredCount}/${questions.length}`,
                      )
                    : bi(
                        `已确认 ${answeredCount}/${questions.length}`,
                        `Confirmed ${answeredCount}/${questions.length}`,
                      )}
                </span>
              </span>
            )}
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
                {expandAll ? bi("逐项收起", "Collapse all") : bi("展开全部", "Expand all")}
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
                      {bi(
                        `第 ${qi + 1} / ${questions.length} 项`,
                        `${qi + 1} of ${questions.length}`,
                      )}
                    </span>
                  )}
                </div>
                <div className="rh-scope-row-right">
                  {isAnswered ? (
                    <span className="rh-scope-ans-pill" title={curAns}>
                      <span className="rh-scope-ans-txt">{summaryChip}</span>
                      {!isOpen && <em>{bi("修改", "Edit")}</em>}
                    </span>
                  ) : !isOpen ? (
                    <span className="rh-scope-pending-pill">
                      {bi("待点选", "Pending")}
                    </span>
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
                                          bi(
                                            `请${po.supplement.badge}`,
                                            po.supplement.badge,
                                          )
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
                              {parsedOpts.length > 0
                                ? bi("自由说明", "Custom")
                                : bi("现场说明", "Notes")}
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
                            placeholder={bi(
                              "直接简述现场实际安排或特殊约束…",
                              "Briefly describe your arrangement or constraints…",
                            )}
                            aria-label={bi(
                              `${q.question} 自定义说明`,
                              `${q.question} custom answer`,
                            )}
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
                                {bi("取消", "Cancel")}
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
                                {nextId && !expandAll
                                  ? bi("确认下一项", "Confirm & Next")
                                  : bi("确认", "Confirm")}
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
                              <span>{bi("已填自定义", "Custom")}</span>
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
                              {bi("修改", "Edit")}
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
                              {bi("清除", "Clear")}
                            </button>
                            {!expandAll && (
                              <button
                                type="button"
                                className="rh-skip-btn"
                                tabIndex={isOpen ? 0 : -1}
                                onClick={() => advanceFrom(q.id)}
                              >
                                <span>
                                  {nextId
                                    ? bi("继续下一项", "Next")
                                    : bi("完成确认", "Done")}
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
                              {bi("自由说明", "Custom")}
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
                                      ? bi("确认下一项", "Confirm & Next")
                                      : bi("完成确认", "Done")
                                    : nextId
                                      ? bi("下一项", "Next")
                                      : bi("收起", "Collapse")}
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
                              <span>{bi("其他现场情况（自由说明）", "Other (custom note)")}</span>
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
                                      ? bi("继续下一项", "Next")
                                      : bi("收起", "Collapse")
                                    : bi("暂不指定，按保守默认", "Skip (safe default)")}
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
              <span>{bi("补充其他现场背景说明", "Add extra environment context")}</span>
              <small>
                {bi(
                  "如近期发生过主备切换、演练节点数量差异等（可选）",
                  "e.g., recent failover or staging node differences (optional)",
                )}
              </small>
            </button>
          ) : (
            <div className="rh-extra-editor">
              <div className="rh-extra-head">
                <label
                  className="rh-field-label"
                  htmlFor={`extra-${rehearsalId}`}
                >
                  {bi("补充现场背景", "Extra Context")}{" "}
                  <span className="faint">{bi("（可选）", "(optional)")}</span>
                </label>
                {!extraScope.trim() && (
                  <button
                    type="button"
                    className="rh-inline-cancel"
                    onClick={() => setExtraOpen(false)}
                  >
                    {bi("收起", "Collapse")}
                  </button>
                )}
              </div>
              <Input.TextArea
                id={`extra-${rehearsalId}`}
                value={extraScope}
                disabled={disabled}
                onChange={setExtraScope}
                autoSize={{ minRows: 2, maxRows: 5 }}
                placeholder={bi(
                  "例如：生产近期发生过一次主备切换；测试环境为 2 台同系统虚拟机…",
                  "e.g., Production had a failover recently; staging uses 2 matching VMs…",
                )}
                aria-label={bi("补充约束说明", "Extra constraints")}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
});

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
  let tag = bi("执行要点", "Exec Note");
  let priority = 0;

  if (
    /认证|密码|口令|凭据|密钥|AUTH\b|TOKEN\b|_USER\b|ACL\b|脱敏|bash\s+-x|不要把密码|勿写|password|credential|secret|redact|mask/i.test(
      clean,
    )
  ) {
    tone = "auth";
    tag = bi("凭据与安全", "Security");
    priority = 0;
  } else if (
    /连接本机|默认.*连接|127\.0\.0\.1|localhost|:\d{4,5}\b|TLS\b|SSL\b|监控名|mymaster|socket|非默认端口|connect|port/i.test(
      clean,
    )
  ) {
    tone = "conn";
    tag = bi("连接与端口", "Connection");
    priority = 0;
  } else if (
    /分别使用|节点.*执行|执行脚本|运行脚本|同一时间段|任意.*节点|每台节点|不生成任何文件|终端输出|截图反馈|each\s+node|every\s+node|run.*script|terminal\s+output|screenshot/i.test(
      clean,
    )
  ) {
    tone = "exec";
    tag = bi("执行范围", "Scope");
    priority = 0;
  } else if (
    /持久化|appendonly|aof_|save=|maxmemory|内存|磁盘|容量|字节|RDB|persistence|memory|disk|capacity/i.test(clean)
  ) {
    tone = "judge";
    tag = bi("基线核对", "Baseline");
    priority = 1;
  } else if (
    /主从|主库|从库|漂移|Sentinel|哨兵|quorum|CKQUORUM|s_down|o_down|复制|lag|Leader|Follower|Patroni|primary|replica|standby|drift/i.test(
      clean,
    )
  ) {
    tone = "judge";
    tag = bi("拓扑判据", "Topology");
    priority = 1;
  }

  let headline = clean;
  let detail = "";
  const periodIdx = clean.indexOf("。");
  const enPeriodIdx = periodIdx >= 0 ? -1 : clean.indexOf(". ");
  if (periodIdx >= 8 && periodIdx < clean.length - 1) {
    headline = clean.slice(0, periodIdx).trim();
    detail = clean.slice(periodIdx + 1).trim();
  } else if (enPeriodIdx >= 16 && enPeriodIdx < clean.length - 2) {
    headline = clean.slice(0, enPeriodIdx + 1).trim();
    detail = clean.slice(enPeriodIdx + 2).trim();
  } else {
    const semiIdx = clean.indexOf("；");
    const enSemiIdx = semiIdx >= 0 ? -1 : clean.indexOf("; ");
    if (semiIdx >= 10 && semiIdx < clean.length - 1) {
      headline = clean.slice(0, semiIdx).trim();
      detail = clean.slice(semiIdx + 1).trim();
    } else if (enSemiIdx >= 16 && enSemiIdx < clean.length - 2) {
      headline = clean.slice(0, enSemiIdx + 1).trim();
      detail = clean.slice(enSemiIdx + 2).trim();
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

const ProbeExecutionKit = React.memo(function ProbeExecutionKit({
  script,
  fileName,
  probeSafe,
  warnings,
  notes,
  hasEchoInput,
  scriptUpdated,
  onDownload,
}: {
  script: string;
  fileName: string;
  probeSafe: boolean;
  warnings: string[];
  notes: string[];
  hasEchoInput: boolean;
  scriptUpdated?: boolean;
  onDownload: () => void;
}) {
  const lang = useLang();
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
  }, [notes, lang]);

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
              <b>
                {bi(
                  "在生产节点运行只读采集探针",
                  "Run Read-Only Probe on Production Nodes",
                )}
              </b>
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
                {probeSafe
                  ? bi("纯只读校验通过", "Read-Only Verified")
                  : bi("请人工复核只读性", "Manual Review Needed")}
              </span>
              {scriptUpdated && (
                <span className="rh-shield-pill ok">
                  {bi("已按报错自动修订", "Auto-fixed")}
                </span>
              )}
            </div>
            {script && (
              <div className="rh-probe-kit-meta">
                <span className="rh-probe-file-chip mono" title={fileName}>
                  <span className="rh-probe-file-name">{fileName}</span>
                  <span className="rh-probe-file-lines">
                    ·{" "}
                    {bi(
                      `${lineCount} 行`,
                      lineCount === 1 ? "1 line" : `${lineCount} lines`,
                    )}
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>

        {script && (
          <div className="rh-probe-kit-acts">
            <CopyCodeBtn
              text={script}
              label={bi("复制采集脚本", "Copy Script")}
              className="is-primary-ctl"
            />
            <button
              type="button"
              className="rh-kit-btn"
              onClick={onDownload}
            >
              <IconDownload />
              <span>{bi("下载 .sh", "Download .sh")}</span>
            </button>
            <button
              type="button"
              className={`rh-kit-btn is-ghost ${codeOpen ? "is-open" : ""}`}
              aria-expanded={codeOpen}
              onClick={() => setCodeOpen((v) => !v)}
            >
              <span>
                {codeOpen
                  ? bi("收起源码", "Hide Script")
                  : bi("查看脚本", "View Script")}
              </span>
              <IconDown className={`rh-kit-chev ${codeOpen ? "open" : ""}`} />
            </button>
          </div>
        )}
      </div>

      {script && (
        <div className="rh-probe-runbar">
          <div className="rh-probe-runbar-cmd">
            <span className="rh-probe-runbar-lbl">
              {bi("现场运行方式", "Run command")}
            </span>
            <code className="mono">{`bash /tmp/${fileName}`}</code>
            <span className="rh-probe-runbar-tip">
              {bi(
                "请用 bash 执行（勿用 sh，脚本已内置 bash 自切换保护）",
                "Run with bash (not sh; script includes auto bash guard)",
              )}
            </span>
          </div>
          <CopyCodeBtn
            text={`bash /tmp/${fileName}`}
            label={bi("复制命令", "Copy cmd")}
          />
        </div>
      )}

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
                  ? bi("收起补充核查判据", "Hide additional check notes")
                  : bi(
                      `展开其余 ${extraNotes.length} 条采集核查判据`,
                      `Show ${extraNotes.length} more check notes`,
                    )}
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
                copyLabel={bi("复制脚本", "Copy Script")}
                onDownload={onDownload}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

/* ---------- Session Detail View ---------- */

function RehearsalSessionView({
  c,
  id,
  initialSession,
  peers = [],
  autoExpandCreateTrace = false,
  offline,
  noVision,
  pick,
  aiOpts,
  onListChanged,
  onSessionSync,
  onClusterChanged,
  onEngageFocus,
}: {
  c: ClusterView;
  id: string;
  initialSession?: ChangeRehearsal;
  peers?: ChangeRehearsal[];
  autoExpandCreateTrace?: boolean;
  offline: boolean;
  noVision: boolean;
  pick: ReturnType<typeof useModelPick>;
  aiOpts: ReturnType<typeof useAIOptions>;
  onListChanged: () => Promise<void>;
  onSessionSync?: (updated: ChangeRehearsal) => void;
  onClusterChanged?: () => void;
  onEngageFocus?: () => void;
}) {
  useLang();
  const dock = useAIDock();
  const refineKey = rehearsalTaskKey.refine(c.id, id);
  const scopeKey = rehearsalTaskKey.scope(c.id, id);
  const probeKey = rehearsalTaskKey.probe(c.id, id);
  const refineTask = useRehearsalTask<LiveAIState, ChangeRehearsal>(refineKey);
  const scopeTask = useRehearsalTask<LiveAIState, ChangeRehearsal>(scopeKey);
  const probeTask = useRehearsalTask<LiveAIState, ChangeRehearsal>(probeKey);

  const liveRefine =
    refineTask && (refineTask.status === "running" || refineTask.status === "error")
      ? refineTask.live
      : null;
  const liveScope =
    scopeTask && (scopeTask.status === "running" || scopeTask.status === "error")
      ? scopeTask.live
      : null;
  const liveProbe =
    probeTask && (probeTask.status === "running" || probeTask.status === "error")
      ? probeTask.live
      : null;
  const [localProbeAction, setLocalProbeAction] = useState<"analyze" | "diagnose">(
    () => getRehearsalTask(probeKey)?.probeAction || "analyze",
  );
  const probeAction: "analyze" | "diagnose" =
    probeTask?.probeAction || localProbeAction;

  const [r, setR] = useState<ChangeRehearsal | null>(
    () => initialSession || null,
  );
  const [loadErr, setLoadErr] = useState("");
  const [viewStage, setViewStage] = useState<ChangeRehearsal["stage"]>(() => {
    const st = getRehearsalTask(scopeKey);
    if (isRehearsalTaskLive(st)) return "probing";
    const pt = getRehearsalTask(probeKey);
    if (isRehearsalTaskLive(pt)) {
      return pt?.probeAction === "diagnose" ? "probing" : "rehearsing";
    }
    return initialSession?.stage || "scoping";
  });
  const viewStageRef = useRef<ChangeRehearsal["stage"]>(viewStage);
  viewStageRef.current = viewStage;
  const [stageDir, setStageDir] = useState<"fwd" | "back">("fwd");
  const [stageAnimated, setStageAnimated] = useState(false);
  const [loading, setLoading] = useState(() => !initialSession);
  const [busyFinalize, setBusyFinalize] = useState(false);
  const busyFinalizeRef = useRef(false);
  const [busyDelete, setBusyDelete] = useState(false);
  const busyDeleteRef = useRef(false);
  const [exportingDoc, setExportingDoc] = useState(false);
  const exportCooldownRef = useRef<number | null>(null);

  const [freshTraceStage, setFreshTraceStage] = useState<string>(
    autoExpandCreateTrace ? "create" : "",
  );
  // Inline refine-goal state
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineTitle, setRefineTitle] = useState("");
  const [refineGoal, setRefineGoal] = useState("");
  const [refineMode, setRefineMode] = useState<RehearsalModeChoice>("auto");
  const [refineKeepImgs, setRefineKeepImgs] = useState<string[]>([]);
  const [refineAddImgs, setRefineAddImgs] = useState<DraftImage[]>([]);
  const [refinePreviewIdx, setRefinePreviewIdx] = useState<number | null>(null);
  const refineImgInputRef = useRef<HTMLInputElement | null>(null);
  const refineGoalRef = useRef<HTMLTextAreaElement | null>(null);
  const [stripPropagateOpen, setStripPropagateOpen] = useState(false);
  const [stripRolloutOpen, setStripRolloutOpen] = useState(false);
  const [rolloutBoardOverride, setRolloutBoardOverride] =
    useState<RolloutBoardResponse | null>(null);

  // Stage bar spring indicator
  const stageNavRef = useRef<HTMLElement | null>(null);
  const [stageThumb, setStageThumb] = useState<{ x: number; w: number } | null>(
    null,
  );

  // Step 1 state (restoring draft if scope task is live)
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const draftAns = getRehearsalTask(scopeKey)?.draft?.answers as
      | Record<string, string>
      | undefined;
    if (draftAns) return { ...draftAns };
    const init: Record<string, string> = {};
    (initialSession?.scope_questions || []).forEach((q) => {
      if (q.answer) init[q.id] = q.answer;
    });
    return init;
  });
  const [extraScope, setExtraScope] = useState(() => {
    const draftEx = getRehearsalTask(scopeKey)?.draft?.extraScope;
    if (typeof draftEx === "string") return draftEx;
    return initialSession?.extra_scope || "";
  });

  // Step 2 state (restoring draft if probe task is live)
  const [probeOut, setProbeOut] = useState(() => {
    const draftOut = getRehearsalTask(probeKey)?.draft?.probeOut;
    if (typeof draftOut === "string") return draftOut;
    return initialSession?.probe_output || initialSession?.manual_state || "";
  });
  const [probeImages, setProbeImages] = useState<DraftImage[]>(() => {
    const draftImgs = getRehearsalTask(probeKey)?.draft?.probeImages as
      | DraftImage[]
      | undefined;
    return draftImgs ? [...draftImgs] : [];
  });
  const [dragProbe, setDragProbe] = useState(false);
  useEffect(() => {
    if (!dragProbe) return;
    const clear = () => setDragProbe(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragProbe]);
  const [testEnvNote, setTestEnvNote] = useState(() => {
    const draftEnv = getRehearsalTask(probeKey)?.draft?.testEnvNote;
    if (typeof draftEnv === "string") return draftEnv;
    return initialSession?.test_env_note || "";
  });
  const [testEnvOpen, setTestEnvOpen] = useState(() =>
    Boolean(
      (typeof getRehearsalTask(probeKey)?.draft?.testEnvNote === "string" &&
        String(getRehearsalTask(probeKey)?.draft?.testEnvNote).trim()) ||
        initialSession?.test_env_note?.trim(),
    ),
  );
  const probeImgInputRef = useRef<HTMLInputElement | null>(null);

  // Step 3 state
  const [phaseFilter, setPhaseFilter] = useState<string>("all");
  const [doneExpandCmd, setDoneExpandCmd] = useState<{
    expand: boolean;
    seq: number;
  }>({ expand: false, seq: 0 });
  const [arrivalStepId, setArrivalStepId] = useState<string | null>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const timelineRef = useRef<HTMLOListElement | null>(null);
  const gateRef = useRef<HTMLDivElement | null>(null);
  const forwardStepsRef = useRef<RehearsalStep[]>([]);
  const arrivalTimerRef = useRef<number | null>(null);
  const settleRafRef = useRef<{ r1: number | null; r2: number | null }>({
    r1: null,
    r2: null,
  });

  const cancelSettleRaf = useCallback(() => {
    if (settleRafRef.current.r1 !== null) {
      window.cancelAnimationFrame(settleRafRef.current.r1);
      settleRafRef.current.r1 = null;
    }
    if (settleRafRef.current.r2 !== null) {
      window.cancelAnimationFrame(settleRafRef.current.r2);
      settleRafRef.current.r2 = null;
    }
  }, []);

  useEffect(() => {
    setGoalOpen(false);
    setRefineOpen(false);
    setRefineAddImgs([]);
    setRefinePreviewIdx(null);
    setRolloutBoardOverride(null);
    setStripPropagateOpen(false);
    setStripRolloutOpen(false);
    setArrivalStepId(null);
    cancelSettleRaf();
    if (arrivalTimerRef.current !== null) {
      window.clearTimeout(arrivalTimerRef.current);
      arrivalTimerRef.current = null;
    }
  }, [id, cancelSettleRaf]);

  useEffect(() => {
    return () => {
      cancelSettleRaf();
      if (arrivalTimerRef.current !== null) {
        window.clearTimeout(arrivalTimerRef.current);
      }
      if (exportCooldownRef.current !== null) {
        window.clearTimeout(exportCooldownRef.current);
      }
    };
  }, [cancelSettleRaf]);

  const handleStepSettled = useCallback(
    (completedStepId: string) => {
      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      cancelSettleRaf();
      settleRafRef.current.r1 = window.requestAnimationFrame(() => {
        settleRafRef.current.r1 = null;
        settleRafRef.current.r2 = window.requestAnimationFrame(() => {
          settleRafRef.current.r2 = null;
          const list = forwardStepsRef.current;
          const doneIdx = list.findIndex((s) => s.id === completedStepId);
          const isPending = (s: RehearsalStep) =>
            s.status !== "passed" && s.status !== "skipped";
          const nextStep =
            (doneIdx >= 0 ? list.slice(doneIdx + 1).find(isPending) : undefined) ||
            list.find(isPending);
          if (nextStep) {
            const el = timelineRef.current?.querySelector<HTMLElement>(
              `li[data-step-id="${nextStep.id.replace(/"/g, '\\"')}"]`,
            );
            if (el) {
              el.scrollIntoView({
                behavior: reduced ? "auto" : "smooth",
                block: "start",
              });
            }
            setArrivalStepId(nextStep.id);
            if (arrivalTimerRef.current !== null) {
              window.clearTimeout(arrivalTimerRef.current);
            }
            arrivalTimerRef.current = window.setTimeout(() => {
              setArrivalStepId(null);
              arrivalTimerRef.current = null;
            }, 1400);
          } else if (gateRef.current) {
            gateRef.current.scrollIntoView({
              behavior: reduced ? "auto" : "smooth",
              block: "start",
            });
          }
        });
      });
    },
    [cancelSettleRaf],
  );

  const switchStage = (
    next: ChangeRehearsal["stage"],
    isAutoReveal = false,
  ) => {
    if (!isAutoReveal) setFreshTraceStage("");
    const current = viewStageRef.current;
    if (next === current) return;
    const a = STAGE_ORDER.indexOf(current);
    const b = STAGE_ORDER.indexOf(next);
    viewStageRef.current = next;
    setStageDir(b >= a ? "fwd" : "back");
    setStageAnimated(true);
    setViewStage(next);
    if (isAutoReveal) {
      window.requestAnimationFrame(() => {
        stageNavRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    }
  };

  useEffect(() => {
    if (r) {
      putCached(rehearsalItemPath(c.id, r.id), r);
      onSessionSync?.(r);
    }
  }, [c.id, r, onSessionSync]);

  useEffect(() => {
    const onExternalRehearsalChange = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{ clusterId?: string; rehearsalId?: string }>
      ).detail;
      if (detail?.clusterId && detail.clusterId !== c.id) return;
      if (detail?.rehearsalId && detail.rehearsalId !== id) return;
      void api<ChangeRehearsal>(rehearsalItemPath(c.id, id))
        .then((next) => {
          setR(next);
          void onListChanged();
        })
        .catch(() => {});
    };
    window.addEventListener(REHEARSAL_CHANGED, onExternalRehearsalChange);
    return () =>
      window.removeEventListener(REHEARSAL_CHANGED, onExternalRehearsalChange);
  }, [c.id, id, onListChanged]);

  const load = async (syncStage = false) => {
    setLoadErr("");
    try {
      const data = await api<ChangeRehearsal>(
        rehearsalItemPath(c.id, id),
      );
      putCached(rehearsalItemPath(c.id, id), data);
      setR(data);
      const hasActiveStageTask =
        isRehearsalTaskLive(getRehearsalTask(scopeKey)) ||
        isRehearsalTaskLive(getRehearsalTask(probeKey));
      if (syncStage && !hasActiveStageTask) {
        viewStageRef.current = data.stage;
        setViewStage(data.stage);
      }
      const initAns: Record<string, string> = {};
      (data.scope_questions || []).forEach((q) => {
        if (q.answer) initAns[q.id] = q.answer;
      });
      setAnswers((prev) => ({ ...initAns, ...prev }));
      if (data.extra_scope) setExtraScope((ex) => ex || data.extra_scope || "");
      if (data.probe_output || data.manual_state) {
        setProbeOut((p) => p || data.probe_output || data.manual_state || "");
      }
      if (data.test_env_note) {
        setTestEnvNote((t) => t || data.test_env_note || "");
        setTestEnvOpen(true);
      }
    } catch (e) {
      setLoadErr((e as Error).message || bi("读取失败", "Failed to load"));
    } finally {
      setLoading(false);
    }
  };

  // Consume completed refine / scope / probe background tasks cleanly on mount or live arrival
  useEffect(() => {
    if (refineTask?.status !== "done" || !refineTask.result) return;
    const next = refineTask.result;
    clearRehearsalTask(refineKey);
    setRefineOpen(false);
    setRefineAddImgs([]);
    setR(next);
    const nextAns: Record<string, string> = {};
    (next.scope_questions || []).forEach((q) => {
      if (q.answer) nextAns[q.id] = q.answer;
    });
    setAnswers(nextAns);
    setExtraScope(next.extra_scope || "");
    setProbeOut("");
    setProbeImages([]);
    setPhaseFilter("all");
    setFreshTraceStage("create");
    switchStage(next.stage, true);
    void onListChanged();
    if (!refineTask.notified) {
      Message.success(
        next.intent_unclear
          ? bi(
              "已重新研判诉求，请核对下方识别结果并补全细节",
              "Goal re-analyzed; please verify the recognized intent below",
            )
          : bi(
              "已按新诉求重新研判并刷新演练方案",
              "Rehearsal refreshed with your refined goal",
            ),
      );
    }
  }, [refineTask, refineKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (scopeTask?.status !== "done" || !scopeTask.result) return;
    const next = scopeTask.result;
    clearRehearsalTask(scopeKey);
    setR(next);
    setFreshTraceStage("scope");
    switchStage(next.stage, true);
    void onListChanged();
    if (!scopeTask.notified) {
      Message.success(
        bi(
          "已生成只读状态采集脚本并通过静态安全扫描",
          "Read-only probe generated and passed static safety scan",
        ),
      );
    }
  }, [scopeTask, scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (probeTask?.status !== "done" || !probeTask.result) return;
    const next = probeTask.result;
    clearRehearsalTask(probeKey);
    setR(next);
    setProbeImages([]);
    setFreshTraceStage("probe");
    void onListChanged();
    if (next.probe_issue) {
      switchStage("probing", true);
      if (!probeTask.notified) {
        Message.warning(
          next.probe_issue.script_updated
            ? bi(
                "探针未拿到有效数据，已阻断漂移分析并自动更新修复版只读脚本，请重新采集",
                "Probe failed; blocked drift analysis and updated the read-only script—please re-run",
              )
            : bi(
                "未拿到有效现场结果，已阻断进入漂移分析，请按下方诊断修复后重新采集",
                "No valid live probe result; blocked drift analysis—follow fix guidance and re-run",
              ),
        );
      }
    } else {
      switchStage(next.stage, true);
      if (!probeTask.notified) {
        Message.success(
          bi(
            "现场采集核验通过，已完成漂移分析并生成测试演练步骤",
            "Probe verified; drift analysis and rehearsal steps generated",
          ),
        );
      }
    }
  }, [probeTask, probeKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const isQuickMode = Boolean(
    r && r.mode === "quick" && r.stage !== "scoping" && r.stage !== "probing",
  );
  const isLightMode = Boolean(r && r.mode === "light" && r.stage !== "scoping");
  const isChangeReportMode = isQuickMode || isLightMode;
  const visibleStages: ChangeRehearsal["stage"][] = isQuickMode
    ? QUICK_STAGE_ORDER
    : isLightMode
      ? LIGHT_STAGE_ORDER
      : STAGE_ORDER;
  const curIdx = STAGE_ORDER.indexOf(viewStage);
  const visIdx = Math.max(0, visibleStages.indexOf(viewStage));

  useLayoutEffect(() => {
    const el = stageNavRef.current;
    if (!el || loading || !r) return;
    const measure = () => {
      const btn =
        el.querySelectorAll<HTMLButtonElement>("button.rh-stage-btn")[visIdx];
      setStageThumb(
        btn ? { x: btn.offsetLeft, w: btn.offsetWidth } : null,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visIdx, isQuickMode, isLightMode, loading, r?.stage, r?.steps?.length, Boolean(liveScope), Boolean(liveProbe), busyFinalize]);

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
        Message.warning(
          bi("回显文本文件请控制在 2 MiB 以内", "Output text file must be under 2 MiB"),
        );
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setProbeOut(String(reader.result || ""));
        Message.success(bi(`已载入 ${tf.name}`, `Loaded ${tf.name}`));
      };
      reader.readAsText(tf);
    }

    if (!imgFiles.length) return;
    if (noVision) {
      Message.warning(
        bi(
          "当前所选模型不支持识别截图，请粘贴文字回显或在下方切换支持看图的模型",
          "Selected model does not support images; paste text output or switch to a vision model below",
        ),
      );
      return;
    }
    const room = MAX_IMAGES - probeImages.length;
    if (room <= 0) {
      Message.warning(
        bi(
          `单次最多上传 ${MAX_IMAGES} 张回显截图`,
          `Up to ${MAX_IMAGES} screenshots allowed`,
        ),
      );
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
      Message.success(
        bi(`已添加 ${added.length} 张回显截图`, `Added ${added.length} screenshot(s)`),
      );
    }
  };

  const probeStampSource =
    (r?.probe_issue?.fixed_script ? r.traces?.probe?.at : undefined) ||
    r?.traces?.scope?.at ||
    r?.traces?.create?.at ||
    r?.created_at ||
    r?.updated_at;
  const probeFileName = r
    ? `collect-${c.id}-${r.id.slice(0, 6)}-${formatProbeFileStamp(probeStampSource)}.sh`
    : "";

  const probeScript = r?.probe_script || "";
  const downloadProbe = useCallback(() => {
    if (!probeScript || !probeFileName) return;
    const blob = new Blob([probeScript], { type: "text/x-shellscript" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = probeFileName;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [probeScript, probeFileName]);

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
        <b>{bi("无法打开该演练记录", "Unable to open rehearsal")}</b>
        <p className="muted small">
          {loadErr || bi("记录不存在或已被删除", "Record does not exist or was deleted")}
        </p>
        <div className="row-gap">
          <Button icon={<IconRefresh />} onClick={() => void load(true)}>
            {bi("重试", "Retry")}
          </Button>
          <Button
            onClick={() =>
              go(
                { name: "deliveries", id: c.id, tab: "rehearsal" },
                { replace: true },
              )
            }
          >
            {bi("返回演练列表", "Back to Rehearsals")}
          </Button>
        </div>
      </div>
    );
  }

  const maxIdx = STAGE_ORDER.indexOf(r.stage);
  const refineBusy = Boolean(liveRefine && !liveRefine.error);
  const scopeBusy = Boolean(liveScope && !liveScope.error);
  const probeBusy = Boolean(liveProbe && !liveProbe.error);
  const anyBusy = refineBusy || scopeBusy || probeBusy || busyFinalize;
  const canRefine = r.stage !== "finalized" && !r.applied && !r.voided;

  const openRefine = () => {
    if (!canRefine || anyBusy) return;
    setGoalOpen(false);
    const curRef = getRehearsalTask(refineKey);
    if (curRef && curRef.status !== "running") clearRehearsalTask(refineKey);
    setRefineTitle(r.title || "");
    setRefineGoal(r.goal || "");
    setRefineMode(r.security_context ? "full" : "auto");
    setRefineKeepImgs(r.goal_images ? [...r.goal_images] : []);
    setRefineAddImgs([]);
    setRefineOpen(true);
    window.requestAnimationFrame(() => {
      refineGoalRef.current?.focus({ preventScroll: false });
    });
  };

  const attachRefineFiles = async (files: FileList | File[]) => {
    const imgFiles = Array.from(files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (!imgFiles.length) return;
    if (noVision) {
      Message.warning(
        bi(
          "当前所选模型不支持识别截图，请先在下方切换支持看图的模型",
          "Selected model does not support images; switch to a vision model below",
        ),
      );
      return;
    }
    const room = MAX_IMAGES - refineKeepImgs.length - refineAddImgs.length;
    if (room <= 0) {
      Message.warning(
        bi(
          `参考截图总数最多 ${MAX_IMAGES} 张`,
          `Up to ${MAX_IMAGES} reference screenshots allowed`,
        ),
      );
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
      setRefineAddImgs((prev) => [...prev, ...added]);
      Message.success(
        bi(`已添加 ${added.length} 张参考截图`, `Added ${added.length} screenshot(s)`),
      );
    }
  };

  const submitRefine = async () => {
    const trimmedGoal = refineGoal.trim();
    if (
      !trimmedGoal ||
      offline ||
      anyBusy ||
      getRehearsalTask(refineKey)?.status === "running"
    ) {
      return;
    }
    if (Array.from(trimmedGoal).length < 4) {
      Message.warning(
        bi(
          "请把变更诉求写清楚（至少 4 个字）",
          "Please describe your change goal clearly (at least 4 characters)",
        ),
      );
      return;
    }
    const totalImgs = refineKeepImgs.length + refineAddImgs.length;
    if (totalImgs > 0 && noVision) {
      Message.warning(
        bi(
          "当前包含参考截图，所选模型不支持看图，请切换支持看图的模型或移除截图",
          "Reference screenshots are attached but the selected model does not support vision",
        ),
      );
      return;
    }
    onEngageFocus?.();
    const effectiveMode: RehearsalModeChoice = r.security_context
      ? "full"
      : refineMode;
    const effortVal = pick.current?.effort?.includes(aiOpts.pref.think)
      ? aiOpts.pref.think
      : undefined;
    const initialLive = createInitialLiveState(
      effectiveMode === "quick"
        ? "create-quick"
        : effectiveMode === "light"
          ? "create-light"
          : "create",
      bi("AI 正在按修正后的诉求重新研判", "AI is re-analyzing with your refined goal"),
      bi(
        "正在核对集群基线与新诉求，重新生成需求确认项、探针或步骤…",
        "Re-checking cluster baseline against the revised goal…",
      ),
      pick.current,
    );
    const nextTitle = refineTitle.trim();
    const customTitle =
      nextTitle && nextTitle !== (r.title || "").trim() ? nextTitle : "";
    const payload = {
      title: customTitle || undefined,
      goal: trimmedGoal,
      mode: effectiveMode,
      keep_images: refineKeepImgs,
      add_images:
        refineAddImgs.length > 0
          ? refineAddImgs.map((x) => x.dataUrl)
          : undefined,
      model: pick.ref || undefined,
      effort: effortVal,
    };
    const cid = c.id;
    const rid = r.id;
    startRehearsalTask<LiveAIState, ChangeRehearsal>({
      key: refineKey,
      kind: "refine",
      clusterId: cid,
      rehearsalId: rid,
      initialLive,
      run: (updateLive, signal) =>
        streamRehearsalAPI(
          `/api/clusters/${encodeURIComponent(cid)}/rehearsals/${encodeURIComponent(rid)}/refine`,
          payload,
          updateLive,
          signal,
        ),
      markError: markLiveStateError,
      onSuccessPersist: (next) => {
        putCached(rehearsalItemPath(cid, next.id), next);
        window.dispatchEvent(
          new CustomEvent(REHEARSAL_CHANGED, {
            detail: { clusterId: cid, rehearsalId: next.id },
          }),
        );
      },
      onBackgroundDone: (next) => {
        Message.success(
          bi(
            `${cid}：演练诉求重新研判完成（${next.title || rid}），可返回查看`,
            `${cid}: refined rehearsal "${next.title || rid}" is ready`,
          ),
        );
      },
      onBackgroundError: () => {
        Message.error(
          bi(
            `${cid}：重新研判演练失败，请返回「变更演练」查看诊断`,
            `${cid}: rehearsal refinement failed — return to Rehearsals to inspect`,
          ),
        );
      },
    });
  };

  const submitScope = async () => {
    if (
      offline ||
      scopeBusy ||
      getRehearsalTask(scopeKey)?.status === "running"
    ) {
      return;
    }
    onEngageFocus?.();
    const effortVal = pick.current?.effort?.includes(aiOpts.pref.think)
      ? aiOpts.pref.think
      : undefined;
    const initialLive = createInitialLiveState(
      "scope",
      bi("AI 正在定制生产只读采集探针", "AI is building read-only production probe"),
      bi(
        "正在锁定只读安全红线并建立模型连接…",
        "Locking read-only safety guardrails & connecting…",
      ),
      pick.current,
    );
    switchStage("probing", true);
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
    const cid = c.id;
    const rid = r.id;
    startRehearsalTask<LiveAIState, ChangeRehearsal>({
      key: scopeKey,
      kind: "scope",
      clusterId: cid,
      rehearsalId: rid,
      initialLive,
      draft: {
        answers: { ...answers },
        extraScope,
      },
      run: (updateLive, signal) =>
        streamRehearsalAPI(
          `/api/clusters/${encodeURIComponent(cid)}/rehearsals/${encodeURIComponent(rid)}/scope`,
          payload,
          updateLive,
          signal,
        ),
      markError: markLiveStateError,
      onSuccessPersist: (next) => {
        putCached(rehearsalItemPath(cid, next.id), next);
        window.dispatchEvent(
          new CustomEvent(REHEARSAL_CHANGED, {
            detail: { clusterId: cid, rehearsalId: next.id },
          }),
        );
      },
      onBackgroundDone: () => {
        Message.success(
          bi(
            `${cid}：只读采集探针已生成并通过安全扫描，可返回「变更演练」查看`,
            `${cid}: read-only probe is ready in Rehearsals`,
          ),
        );
      },
      onBackgroundError: () => {
        Message.error(
          bi(
            `${cid}：生成只读探针失败，请返回「变更演练」查看诊断`,
            `${cid}: probe generation failed — return to Rehearsals to inspect`,
          ),
        );
      },
    });
  };

  const submitProbe = async (action: "analyze" | "diagnose" = "analyze") => {
    if (
      offline ||
      probeBusy ||
      getRehearsalTask(probeKey)?.status === "running"
    ) {
      return;
    }
    onEngageFocus?.();
    setLocalProbeAction(action);
    const effortVal = pick.current?.effort?.includes(aiOpts.pref.think)
      ? aiOpts.pref.think
      : undefined;
    const initialLive = createInitialLiveState(
      "probe",
      action === "diagnose"
        ? bi(
            "AI 正在诊断探针报错并修订只读脚本",
            "AI is diagnosing probe error & revising read-only script",
          )
        : bi(
            "AI 正在校验探针结果并比对现场漂移",
            "AI is verifying probe results & analyzing live drift",
          ),
      action === "diagnose"
        ? bi(
            "正在脱敏报错回显并定位脚本兼容性或权限问题…",
            "Redacting error output & analyzing script compatibility...",
          )
        : bi(
            "正在脱敏现场证据并先核验采集结果有效性…",
            "Redacting live evidence & checking probe validity first...",
          ),
      pick.current,
    );
    if (action === "analyze") {
      switchStage("rehearsing", true);
    } else {
      window.requestAnimationFrame(() => {
        stageNavRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    }
    const imgs =
      probeImages.length > 0
        ? probeImages.map((im) => im.dataUrl)
        : undefined;
    const modelRef = pick.ref || undefined;
    const payload = {
      probe_output: probeOut,
      test_env_note: testEnvNote,
      images: imgs,
      mode: action,
      model: modelRef,
      effort: effortVal,
    };
    const cid = c.id;
    const rid = r.id;
    startRehearsalTask<LiveAIState, ChangeRehearsal>({
      key: probeKey,
      kind: "probe",
      clusterId: cid,
      rehearsalId: rid,
      probeAction: action,
      initialLive,
      draft: {
        probeOut,
        testEnvNote,
        probeImages: [...probeImages],
      },
      run: (updateLive, signal) =>
        streamRehearsalAPI(
          `/api/clusters/${encodeURIComponent(cid)}/rehearsals/${encodeURIComponent(rid)}/probe`,
          payload,
          updateLive,
          signal,
        ),
      markError: markLiveStateError,
      onSuccessPersist: (next) => {
        putCached(rehearsalItemPath(cid, next.id), next);
        window.dispatchEvent(
          new CustomEvent(REHEARSAL_CHANGED, {
            detail: { clusterId: cid, rehearsalId: next.id },
          }),
        );
      },
      onBackgroundDone: (next) => {
        if (next.probe_issue) {
          Message.warning(
            bi(
              `${cid}：探针结果未通过核验，请返回「变更演练」查看诊断`,
              `${cid}: probe did not pass verification — return to Rehearsals for diagnosis`,
            ),
          );
        } else {
          Message.success(
            bi(
              `${cid}：现场漂移比对与演练步骤已生成，可返回「变更演练」查看`,
              `${cid}: drift analysis and rehearsal steps are ready`,
            ),
          );
        }
      },
      onBackgroundError: () => {
        Message.error(
          bi(
            `${cid}：探针分析中断，请返回「变更演练」查看诊断`,
            `${cid}: probe analysis failed — return to Rehearsals to inspect`,
          ),
        );
      },
    });
  };

  const finalizeSOP = async () => {
    if (offline || busyFinalize || busyFinalizeRef.current) return;
    busyFinalizeRef.current = true;
    setBusyFinalize(true);
    switchStage("finalized", true);
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
      Message.success(
        isChangeReportMode
          ? bi(
              "《变更报告》已归档至集群文档，支持在线审阅与 Word 导出",
              "Change Report archived to Cluster Docs with Word export",
            )
          : bi(
              "《生产变更实施方案》已存入集群文档",
              "Production Change SOP saved to Cluster Docs",
            ),
      );
    } catch (e) {
      if (r.stage !== "finalized") {
        switchStage("rehearsing");
      }
      err(e);
    } finally {
      busyFinalizeRef.current = false;
      setBusyFinalize(false);
    }
  };

  const removeSession = async () => {
    if (offline || busyDeleteRef.current) return;
    busyDeleteRef.current = true;
    setBusyDelete(true);
    try {
      await api(
        `/api/clusters/${encodeURIComponent(c.id)}/rehearsals/${encodeURIComponent(r.id)}`,
        { method: "DELETE" },
      );
      Message.success(bi("已删除演练记录", "Rehearsal deleted"));
      await onListChanged();
      go(
        { name: "deliveries", id: c.id, tab: "rehearsal" },
        { replace: true },
      );
    } catch (e) {
      err(e);
    } finally {
      busyDeleteRef.current = false;
      setBusyDelete(false);
    }
  };

  const steps = r.steps || [];
  const forwardSteps = steps.filter((s) => s.phase !== "rollback");
  forwardStepsRef.current = forwardSteps;
  const rollbackSteps = steps.filter((s) => s.phase === "rollback");
  const doneForwardCount = forwardSteps.filter(
    (s) => s.status === "passed" || s.status === "skipped",
  ).length;
  const requiredSteps = forwardSteps.filter((s) => !s.optional);
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
      ? forwardSteps
      : steps.filter((s) => s.phase === phaseFilter);

  const hasProbeInput =
    probeImages.length > 0 || Boolean(probeOut.trim());
  const archivedProbeImgCount = r.probe_images?.length || 0;
  const hasArchivedProbeEvidence = !hasProbeInput && archivedProbeImgCount > 0;

  const isFreshCreate = freshTraceStage === "create" && curIdx === 0;
  const isFreshScope = freshTraceStage === "scope" && curIdx === 1;
  const isFreshProbe = freshTraceStage === "probe" && curIdx === 2;
  const isFreshFinal = freshTraceStage === "finalized" && curIdx === 3;

  const hasScopeSummary = Boolean(
    r.scope_summary && r.scope_summary.trim() !== r.goal.trim(),
  );
  const goalSections = parseRehearsalGoalSections(r.goal);
  const isLongGoal = r.goal.trim().length > 140 || goalSections.length > 1;
  const canToggleGoal = Boolean(r.goal.trim()) && (hasScopeSummary || isLongGoal);
  const hasDownstreamProgress = Boolean(
    r.probe_output ||
      r.manual_state ||
      (r.probe_images && r.probe_images.length > 0) ||
      steps.some((s) => s.status !== "pending"),
  );
  const refineHasImages = refineKeepImgs.length + refineAddImgs.length > 0;
  const refineCanSubmit =
    Boolean(refineGoal.trim()) &&
    !offline &&
    !anyBusy &&
    !(refineHasImages && noVision);

  return (
    <div className={`rh-session${isFreshCreate ? " is-fresh-session" : ""}`}>
      <header className="rh-shead">
        <div className="rh-shead-top">
          <div className="rh-shead-heading">
            <h2>{r.title}</h2>
            <div className="rh-shead-meta">
              <span
                className={`rh-mode-pill ${isQuickMode ? "is-quick" : isLightMode ? "is-light" : "is-full"}`}
              >
                {isQuickMode
                  ? bi("极速变更", "Quick Change")
                  : isLightMode
                    ? bi("简单推演", "Light Rehearsal")
                    : bi("全量推演", "Full Rehearsal")}
              </span>
              <span className="rh-shead-dot" aria-hidden>
                ·
              </span>
              <span className="faint small">
                {bi(`更新于 ${ago(r.updated_at)}`, `Updated ${ago(r.updated_at)}`)}
              </span>
              {canToggleGoal && !refineOpen && (
                <>
                  <span className="rh-shead-dot" aria-hidden>
                    ·
                  </span>
                  <button
                    type="button"
                    className={`rh-shead-toggle ${goalOpen ? "on" : ""}`}
                    aria-expanded={goalOpen}
                    onClick={() => setGoalOpen((v) => !v)}
                  >
                    <span>
                      {goalOpen
                        ? hasScopeSummary
                          ? bi("收起原始诉求", "Hide original goal")
                          : bi("收起完整诉求", "Collapse goal")
                        : hasScopeSummary
                          ? bi("查看原始诉求", "View original goal")
                          : bi("展开完整诉求", "Expand full goal")}
                    </span>
                    <IconDown className={goalOpen ? "open" : ""} />
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="rh-shead-acts">
            {canRefine && (
              <Button
                size="small"
                type={refineOpen ? "secondary" : "text"}
                icon={<IconEdit />}
                disabled={anyBusy || offline}
                onClick={() =>
                  refineOpen ? setRefineOpen(false) : openRefine()
                }
                aria-expanded={refineOpen}
              >
                {refineOpen
                  ? bi("收起修正", "Close")
                  : bi("修正诉求", "Refine Goal")}
              </Button>
            )}
            <Popconfirm
              position="br"
              title={bi(
                `确认删除演练「${r.title}」？`,
                `Delete rehearsal "${r.title}"?`,
              )}
              content={bi(
                "已定稿的实施方案仍会保留在集群文档中。",
                "Finalized SOP documents will remain in Cluster Docs.",
              )}
              okText={bi("删除", "Delete")}
              cancelText={bi("取消", "Cancel")}
              okButtonProps={{ status: "danger", loading: busyDelete }}
              onOk={removeSession}
            >
              <Button
                size="small"
                type="text"
                status="danger"
                icon={<IconDelete />}
                loading={busyDelete}
                disabled={offline || busyDelete}
                aria-label={bi("删除演练", "Delete rehearsal")}
              >
                {bi("删除", "Delete")}
              </Button>
            </Popconfirm>
          </div>
        </div>

        {refineOpen && canRefine ? (
          <div
            className="rh-refine-panel"
            role="region"
            aria-label={bi("修正变更诉求并重新研判", "Refine change goal and re-analyze")}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submitRefine();
              } else if (e.key === "Escape" && !anyBusy) {
                e.preventDefault();
                setRefineOpen(false);
              }
            }}
          >
            <div className="rh-refine-head">
              <div className="rh-refine-head-l">
                <span className="rh-refine-title">
                  {bi("修正诉求并重新研判", "Refine Goal & Re-analyze")}
                </span>
                {hasDownstreamProgress && (
                  <span className="rh-refine-warn">
                    {bi(
                      "将按新诉求重置当前探针回显与步骤",
                      "Will reset current probe outputs & steps",
                    )}
                  </span>
                )}
              </div>
              {hasScopeSummary &&
                r.scope_summary!.trim() !== refineGoal.trim() && (
                  <button
                    type="button"
                    className="rh-refine-fill-btn"
                    disabled={anyBusy}
                    onClick={() => {
                      setRefineGoal(r.scope_summary!.trim());
                      window.requestAnimationFrame(() => {
                        const el = refineGoalRef.current;
                        if (el) {
                          el.focus();
                          el.selectionStart = el.selectionEnd = el.value.length;
                        }
                      });
                    }}
                  >
                    <Spark size={12} />
                    <span>
                      {bi("填入 AI 识别摘要改写", "Use AI Summary as Draft")}
                    </span>
                  </button>
                )}
            </div>

            <input
              type="text"
              className="rh-refine-title-input"
              value={refineTitle}
              disabled={anyBusy}
              onChange={(e) => setRefineTitle(e.target.value)}
              placeholder={bi(
                "演练标题（可选；留空或未改动将由 AI 按新诉求自动归纳）",
                "Title (optional; leave blank or unchanged for AI to re-summarize)",
              )}
              maxLength={60}
            />

            <textarea
              ref={refineGoalRef}
              className="rh-refine-textarea"
              rows={3}
              value={refineGoal}
              disabled={anyBusy}
              onChange={(e) => setRefineGoal(e.target.value)}
              onPaste={(e) => {
                const items = e.clipboardData?.files;
                if (items && items.length > 0) {
                  const hasImg = Array.from(items).some((f) =>
                    f.type.startsWith("image/"),
                  );
                  if (hasImg) {
                    e.preventDefault();
                    void attachRefineFiles(items);
                  }
                }
              }}
              placeholder={bi(
                "补充或改写你的真实变更诉求、目标参数/节点范围，或直接 Ctrl+V 粘贴新截图…",
                "Clarify or rewrite your actual change goal, target parameters/scope, or Ctrl+V paste screenshots…",
              )}
            />

            {(refineKeepImgs.length > 0 || refineAddImgs.length > 0) && (
              <>
                <div className="rh-img-strip rh-refine-imgs">
                  {refineKeepImgs.map((name, idx) => (
                    <div key={name} className="rh-img-thumb">
                      <button
                        type="button"
                        className="rh-img-open"
                        onClick={() => setRefinePreviewIdx(idx)}
                        title={bi("点击放大查看截图", "Click to zoom")}
                      >
                        <img
                          src={rehearsalImgUrl(c.id, r.id, name)}
                          alt={bi(`已有截图 ${idx + 1}`, `Saved image ${idx + 1}`)}
                        />
                      </button>
                      <button
                        type="button"
                        className="rh-img-rm"
                        disabled={anyBusy}
                        aria-label={bi("移除截图", "Remove screenshot")}
                        onClick={() =>
                          setRefineKeepImgs((prev) =>
                            prev.filter((x) => x !== name),
                          )
                        }
                      >
                        <IconClose />
                      </button>
                    </div>
                  ))}
                  {refineAddImgs.map((im, idx) => (
                    <div key={im.id} className="rh-img-thumb">
                      <button
                        type="button"
                        className="rh-img-open"
                        onClick={() =>
                          setRefinePreviewIdx(refineKeepImgs.length + idx)
                        }
                        title={bi("点击放大查看截图", "Click to zoom")}
                      >
                        <img src={im.dataUrl} alt={im.name} />
                      </button>
                      <button
                        type="button"
                        className="rh-img-rm"
                        disabled={anyBusy}
                        aria-label={bi("移除截图", "Remove screenshot")}
                        onClick={() =>
                          setRefineAddImgs((prev) =>
                            prev.filter((x) => x.id !== im.id),
                          )
                        }
                      >
                        <IconClose />
                      </button>
                    </div>
                  ))}
                </div>
                <ImageLightbox
                  items={[
                    ...refineKeepImgs.map((name, idx) => ({
                      src: rehearsalImgUrl(c.id, r.id, name),
                      label: `${bi("已有截图", "Saved image")} ${idx + 1} (${name})`,
                    })),
                    ...refineAddImgs.map((im, idx) => ({
                      src: im.dataUrl,
                      label: im.name
                        ? `${im.name} (${im.sizeKB} KB)`
                        : bi(`新增截图 ${idx + 1}`, `New screenshot ${idx + 1}`),
                    })),
                  ]}
                  index={refinePreviewIdx}
                  onClose={() => setRefinePreviewIdx(null)}
                  onIndexChange={setRefinePreviewIdx}
                />
              </>
            )}

            <div className="rh-mode-bar rh-refine-mode-bar">
              <Segmented
                size="sm"
                value={r.security_context ? "full" : refineMode}
                onChange={(v) => setRefineMode(v as RehearsalModeChoice)}
                options={[
                  {
                    value: "auto",
                    label: bi("自动判断", "Auto"),
                    disabled: Boolean(r.security_context),
                  },
                  {
                    value: "quick",
                    label: bi("极速变更", "Quick"),
                    disabled: Boolean(r.security_context),
                  },
                  {
                    value: "light",
                    label: bi("简单推演", "Light"),
                    disabled: Boolean(r.security_context),
                  },
                  {
                    value: "full",
                    label: bi("全量推演", "Full"),
                  },
                ]}
              />
              <span className="rh-mode-hint">
                {r.security_context
                  ? bi(
                      "安全漏洞与证书演练固定走全量推演",
                      "Security rehearsals always use Full Rehearsal",
                    )
                  : refineMode === "quick"
                    ? bi(
                        "两步直出执行步骤与回退预案",
                        "2-step direct steps & rollback",
                      )
                    : refineMode === "light"
                      ? bi(
                          "直出单屏只读探针 → 快速验证",
                          "Direct read-only probe → quick verify",
                        )
                      : refineMode === "full"
                        ? bi(
                            "走完整四步：边界对齐 → 只读探针 → 演练 → SOP",
                            "Full 4-stage: Scope → Probe → Rehearsal → SOP",
                          )
                        : bi(
                            "诉求未写清先核对补全，写清后按风险自动路由",
                            "Confirms unclear goals first; auto-routes clear goals by risk",
                          )}
              </span>
            </div>

            <div className="rh-compose-foot rh-refine-foot">
              <div className="rh-compose-tools">
                <input
                  ref={refineImgInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files?.length) {
                      void attachRefineFiles(e.target.files);
                    }
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="rh-attach-btn"
                  disabled={anyBusy || noVision}
                  onClick={() => refineImgInputRef.current?.click()}
                >
                  <IconImage />
                  <span>{bi("粘贴/添加截图", "Paste / Add Image")}</span>
                </button>
              </div>
              <div className="rh-compose-submit">
                <ThinkLevel
                  levels={pick.current?.effort}
                  value={aiOpts.pref.think}
                  onChange={(v) => aiOpts.update({ think: v })}
                  compact
                />
                <ModelPicker pick={pick} compact />
                <Button
                  size="small"
                  disabled={refineBusy}
                  onClick={() => setRefineOpen(false)}
                >
                  {bi("取消", "Cancel")}
                </Button>
                <Button
                  type="primary"
                  size="small"
                  shape="round"
                  className={`ai-pill ${refineCanSubmit ? "ai-pill-primary" : ""}`}
                  icon={<Spark size={13} rainbow={!refineCanSubmit} />}
                  loading={refineBusy}
                  disabled={!refineCanSubmit}
                  onClick={() => void submitRefine()}
                >
                  {bi("重新研判并刷新", "Re-analyze & Refresh")}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {hasScopeSummary ? (
              <div
                className={`rh-shead-summary${r.intent_unclear ? " is-intent" : ""}`}
              >
                <span className="rh-shead-sum-tag">
                  {r.intent_unclear
                    ? bi("AI 识别诉求", "AI Recognized")
                    : bi("收敛边界", "Scope Summary")}
                </span>
                <span className="rh-shead-sum-txt">
                  {renderThinkingInline(r.scope_summary!)}
                </span>
                {canRefine && (
                  <button
                    type="button"
                    className="rh-shead-refine-link"
                    disabled={anyBusy || offline}
                    onClick={openRefine}
                  >
                    <IconEdit />
                    <span>
                      {r.intent_unclear
                        ? bi("识别有偏？修正", "Misread? Edit")
                        : bi("修正", "Edit")}
                    </span>
                  </button>
                )}
              </div>
            ) : r.goal.trim() && !goalOpen ? (
              <div className="rh-shead-summary is-goal">
                <span className="rh-shead-sum-tag">
                  {bi("变更诉求", "Change Goal")}
                </span>
                <span
                  className={`rh-shead-sum-txt ${isLongGoal ? "is-clamped" : ""}`}
                >
                  {renderThinkingInline(r.goal)}
                </span>
              </div>
            ) : null}

            {goalOpen && goalSections.length > 0 && (
              <div
                className="rh-shead-goal-panel"
                role="region"
                aria-label={bi("完整变更诉求", "Full change goal")}
              >
                <div className="rh-shead-goal-head">
                  <span className="rh-shead-goal-title">
                    {hasScopeSummary
                      ? bi("原始变更诉求", "Original Change Goal")
                      : bi("完整变更诉求", "Full Change Goal")}
                  </span>
                  <div className="rh-shead-goal-acts">
                    {canRefine && (
                      <button
                        type="button"
                        className="rh-shead-goal-edit"
                        disabled={anyBusy || offline}
                        onClick={openRefine}
                      >
                        <IconEdit />
                        <span>{bi("修改并重新研判", "Edit & Re-analyze")}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="rh-shead-goal-close"
                      onClick={() => setGoalOpen(false)}
                    >
                      {bi("收起", "Collapse")}
                    </button>
                  </div>
                </div>
                <div className="rh-shead-goal-list">
                  {goalSections.map((sec, idx) => (
                    <div key={idx} className="rh-shead-goal-row">
                      {sec.label && (
                        <span className="rh-shead-goal-lbl">{sec.label}</span>
                      )}
                      <p className="rh-shead-goal-body">
                        {renderThinkingInline(sec.body)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {r.goal_images && r.goal_images.length > 0 && (
              <SavedImageGallery
                clusterId={c.id}
                rehearsalId={r.id}
                names={r.goal_images}
                label={bi("诉求参考截图", "Reference Screenshots")}
              />
            )}
          </>
        )}
      </header>

      {liveRefine ? (
        <RehearsalAIProcess
          live={liveRefine}
          title={liveRefine.title}
          onAbort={() => abortRehearsalTask(refineKey)}
          onRetry={() => void submitRefine()}
          onDismiss={() => clearRehearsalTask(refineKey)}
        />
      ) : (
        <>

      {r.source?.rollout_id && (
        <RolloutProgressStrip
          rehearsal={r}
          currentClusterId={c.id}
          boardOverride={rolloutBoardOverride}
          onOpenPropagate={
            r.stage === "finalized" && r.applied && !r.voided
              ? () => setStripPropagateOpen(true)
              : undefined
          }
        />
      )}

      {r.security_context && (
        <RehearsalSecurityBanner
          clusterId={c.id}
          rehearsal={r}
          onUpdated={setR}
        />
      )}

      <nav
        className={`rh-stages${isQuickMode ? " cols-2 is-quick" : isLightMode ? " cols-3 is-light" : ""}`}
        ref={stageNavRef}
        aria-label={bi("变更演练阶段", "Change rehearsal stages")}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const liveTarget: ChangeRehearsal["stage"] | "" = liveScope
            ? "probing"
            : liveProbe
              ? probeAction === "diagnose"
                ? "probing"
                : "rehearsing"
              : busyFinalize
                ? "finalized"
                : "";
          const maxVis = Math.max(
            0,
            visibleStages.indexOf(r.stage),
            liveTarget ? visibleStages.indexOf(liveTarget) : -1,
          );
          const unlocked = visibleStages.filter((_, idx) => idx <= maxVis);
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
        {visibleStages.map((st, idx) => {
          const liveTarget: ChangeRehearsal["stage"] | "" = liveScope
            ? "probing"
            : liveProbe
              ? probeAction === "diagnose"
                ? "probing"
                : "rehearsing"
              : busyFinalize
                ? "finalized"
                : "";
          const maxVis = Math.max(
            0,
            visibleStages.indexOf(r.stage),
            liveTarget ? visibleStages.indexOf(liveTarget) : -1,
          );
          const metaMap = isQuickMode
            ? QUICK_STAGE_META
            : isLightMode
              ? LIGHT_STAGE_META
              : STAGE_META;
          const busyTargetStage: ChangeRehearsal["stage"] | "" = scopeBusy
            ? "probing"
            : probeBusy
              ? probeAction === "diagnose"
                ? "probing"
                : "rehearsing"
              : busyFinalize
                ? "finalized"
                : "";
          const isGenerating = busyTargetStage === st;
          const unlocked = idx <= maxVis;
          const isDone =
            idx < maxVis ||
            r.stage === "finalized" ||
            (scopeBusy && st === "scoping");
          const active = viewStage === st;
          const subText = isGenerating
            ? st === "probing"
              ? probeBusy
                ? bi("诊断修订探针中…", "Diagnosing probe…")
                : bi("定制只读探针中…", "Building probe…")
              : st === "rehearsing"
                ? bi("校验结果与编排中…", "Verifying & planning…")
                : isChangeReportMode
                  ? bi("生成变更报告中…", "Generating report…")
                  : bi("生成生产 SOP 中…", "Finalizing SOP…")
            : st === "rehearsing" && requiredSteps.length > 0
              ? bi(
                  `必测 ${doneRequired}/${requiredSteps.length}`,
                  `Required ${doneRequired}/${requiredSteps.length}`,
                )
              : metaMap[st].sub;
          return (
            <button
              key={st}
              type="button"
              disabled={!unlocked}
              aria-current={active ? "step" : undefined}
              className={`rh-stage-btn ${active ? "on" : ""} ${isDone ? "done" : ""} ${isGenerating ? "is-generating" : ""}`}
              onClick={() => unlocked && switchStage(st)}
            >
              <span className="rh-stage-num num">
                {isGenerating ? (
                  <span className="rh-stage-pulse" aria-hidden />
                ) : isDone && !active ? (
                  <IconCheck />
                ) : (
                  idx + 1
                )}
              </span>
              <span className="rh-stage-txt">
                <b>{metaMap[st].short}</b>
                <small>{subText}</small>
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
                title={bi(
                  "AI 诉求研判与边界分析过程",
                  "AI Goal Analysis & Scope Alignment",
                )}
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
              disabled={scopeBusy || refineBusy}
              freshReveal={isFreshCreate}
              baselineVersion={c.version}
              intentUnclear={Boolean(r.intent_unclear)}
              onRefineGoal={canRefine ? openRefine : undefined}
            />

            <div className="rh-sec-foot">
              <div className="rh-sec-foot-tools">
                <span className="rh-foot-note">
                  {bi(
                    "仅生成静态只读采集命令，零重启与写操作",
                    "Generates static read-only commands only; zero restarts or writes",
                  )}
                </span>
              </div>
              <div className="rh-compose-submit">
                <ThinkLevel
                  levels={pick.current?.effort}
                  value={aiOpts.pref.think}
                  onChange={(v) => aiOpts.update({ think: v })}
                  compact
                />
                <ModelPicker pick={pick} compact />
                <Button
                  type="primary"
                  shape="round"
                  className={`ai-pill ${!offline ? "ai-pill-primary" : ""}`}
                  icon={<Spark size={14} rainbow={offline} />}
                  title={
                    isMac
                      ? bi("⌘ + Enter 提交", "⌘ + Enter Submit")
                      : bi("Ctrl + Enter 提交", "Ctrl + Enter Submit")
                  }
                  loading={scopeBusy}
                  disabled={offline}
                  onClick={() => void submitScope()}
                >
                  {r.probe_script
                    ? bi("重新生成只读探针", "Regenerate Probe")
                    : bi("生成只读采集脚本", "Generate Probe")}
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
                !probeBusy &&
                !liveScope
              ) {
                e.preventDefault();
                void submitProbe();
              }
            }}
          >
            {liveScope ? (
              <RehearsalAIProcess
                live={liveScope}
                title={liveScope.title}
                onAbort={() => {
                  abortRehearsalTask(scopeKey);
                  switchStage("scoping");
                  Message.info(
                    bi(
                      "已停止生成，已返回「边界对齐」",
                      "Stopped — returned to Scope Alignment",
                    ),
                  );
                }}
                onRetry={() => void submitScope()}
                onDismiss={() => {
                  clearRehearsalTask(scopeKey);
                  switchStage("scoping");
                }}
              />
            ) : liveProbe && probeAction === "diagnose" ? (
              <RehearsalAIProcess
                live={liveProbe}
                title={liveProbe.title}
                onAbort={() => {
                  abortRehearsalTask(probeKey);
                  Message.info(bi("已停止诊断", "Diagnosis stopped"));
                }}
                onRetry={() => void submitProbe("diagnose")}
                onDismiss={() => clearRehearsalTask(probeKey)}
              />
            ) : (
              <>
            {(r.traces?.scope || (isLightMode && r.traces?.create)) && (
              <RehearsalAIProcess
                trace={(r.traces?.scope || r.traces?.create)!}
                title={
                  isLightMode && !r.traces?.scope
                    ? bi(
                        "AI 简单推演研判与只读探针安全扫描过程",
                        "AI Light Rehearsal & Probe Safety Scan",
                      )
                    : bi(
                        "AI 只读探针设计与安全扫描过程",
                        "AI Probe Design & Safety Scan",
                      )
                }
                defaultOpen={
                  freshTraceStage === "scope" ||
                  (isLightMode && freshTraceStage === "create")
                }
              />
            )}

            <ProbeExecutionKit
              script={r.probe_script || ""}
              fileName={probeFileName}
              probeSafe={r.probe_safe !== false}
              warnings={r.probe_warnings || []}
              notes={r.probe_notes || []}
              hasEchoInput={hasProbeInput}
              scriptUpdated={Boolean(r.probe_issue?.script_updated)}
              onDownload={downloadProbe}
            />

            {r.probe_issue && (
              <section
                className="rh-probe-issue"
                role="alert"
                aria-label={bi("探针采集门禁拦截", "Probe validity gate")}
              >
                <div className="rh-probe-issue-head">
                  <div className="rh-probe-issue-title">
                    <IconExclamationCircle />
                    <b>
                      {r.probe_issue.status === "incomplete"
                        ? bi(
                            "现场采集结果不完整 · 已暂停进入漂移比对",
                            "Incomplete Probe Result · Drift Analysis Paused",
                          )
                        : bi(
                            "探针执行报错，未拿到有效现场结果 · 已阻断进入漂移比对",
                            "Probe Failed Without Valid Live Data · Drift Analysis Blocked",
                          )}
                    </b>
                  </div>
                  <span className="rh-probe-issue-pill">
                    {bi("请修复后重新采集", "Fix & Re-collect")}
                  </span>
                </div>
                {r.probe_issue.summary && (
                  <p className="rh-probe-issue-sum">{r.probe_issue.summary}</p>
                )}
                {r.probe_issue.cause && (
                  <div className="rh-probe-issue-row">
                    <span>{bi("报错根因", "Root Cause")}</span>
                    <p>{r.probe_issue.cause}</p>
                  </div>
                )}
                {r.probe_issue.script_updated && (
                  <div className="rh-probe-issue-updated">
                    <IconCheck />
                    <span>
                      {bi(
                        "已自动生成通过纯只读扫描的修订版脚本并更新至上方，请重新复制或下载运行。",
                        "A revised read-only probe script passed safety checks and replaced the script above. Copy or download it to re-run.",
                      )}
                    </span>
                  </div>
                )}
                {r.probe_issue.fix_command && (
                  <div className="rh-probe-fix-cmd">
                    <div className="rh-probe-fix-cmd-head">
                      <span>{bi("建议立即执行", "Recommended command")}</span>
                      <CopyCodeBtn
                        text={r.probe_issue.fix_command}
                        label={bi("复制命令", "Copy")}
                      />
                    </div>
                    <pre className="mono">{r.probe_issue.fix_command}</pre>
                  </div>
                )}
                {r.probe_issue.fix_steps &&
                  r.probe_issue.fix_steps.length > 0 && (
                    <div className="rh-probe-issue-row">
                      <span>{bi("处理步骤", "Next Steps")}</span>
                      <ol className="rh-probe-fix-list">
                        {r.probe_issue.fix_steps.map((st, idx) => (
                          <li key={idx}>{st}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                {r.probe_issue.missing_items &&
                  r.probe_issue.missing_items.length > 0 && (
                    <div className="rh-probe-issue-row">
                      <span>{bi("待补采项", "Missing Evidence")}</span>
                      <div className="rh-probe-missing">
                        {r.probe_issue.missing_items.map((it, idx) => (
                          <span key={idx}>{it}</span>
                        ))}
                      </div>
                    </div>
                  )}
              </section>
            )}

            <div className="rh-echo-workspace">
              <div className="rh-echo-ws-head">
                <div className="rh-echo-ws-left">
                  <span
                    className={`rh-step-num-badge is-active num ${hasProbeInput || hasArchivedProbeEvidence ? "is-done" : ""}`}
                    aria-hidden
                  >
                    {hasProbeInput || hasArchivedProbeEvidence ? <IconCheck /> : 2}
                  </span>
                  <div className="rh-echo-ws-titles">
                    <b>{bi("回填现场采集结果", "Submit Live Probe Output")}</b>
                    <span
                      className={`rh-echo-status-pill ${hasProbeInput || hasArchivedProbeEvidence ? "is-ready" : ""}`}
                    >
                      {hasProbeInput
                        ? probeOut.trim()
                          ? bi(
                              `已录入 ${probeOut.trim().split("\n").length} 行内容${probeImages.length > 0 ? ` · ${probeImages.length} 张截图` : ""}`,
                              `${probeOut.trim().split("\n").length} line(s) entered${probeImages.length > 0 ? ` · ${probeImages.length} image(s)` : ""}`,
                            )
                          : bi(
                              `已添加 ${probeImages.length} 张终端截图`,
                              `${probeImages.length} screenshot(s) added`,
                            )
                        : hasArchivedProbeEvidence
                          ? bi(
                              `已归档 ${archivedProbeImgCount} 张截图 · 可粘贴新回显重测`,
                              `${archivedProbeImgCount} archived screenshot(s) · paste new output to re-analyze`,
                            )
                          : bi(
                              "粘贴回显、截图或直接文字说明现状",
                              "Paste output, screenshots, or describe status",
                            )}
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
                  <span>
                    {bi(
                      "口令与密钥自动二次脱敏 · 识别主从与参数漂移",
                      "Auto-redacts credentials · Detects role & parameter drift",
                    )}
                  </span>
                </span>
              </div>

              <div className="rh-probe-input">
                <div
                  className={`rh-probe-box is-focal ${offline ? "off" : ""} ${dragProbe ? "is-drag" : ""} ${probeBusy ? "is-busy" : ""}`}
                  onDragOver={(e) => {
                    if (e.dataTransfer?.types?.includes("Files")) {
                      e.preventDefault();
                      if (!dragProbe) setDragProbe(true);
                    }
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setDragProbe(false);
                    }
                  }}
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
                    <span className="rh-probe-head-title">
                      {bi(
                        "现场回显 / 状态说明",
                        "Live Output / Status Notes",
                      )}
                    </span>
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
                            ? bi(
                                "当前所选模型不支持图片识别，可在下方切换支持看图的模型",
                                "Selected model does not support images; switch to a vision model below",
                              )
                            : bi(
                                "上传或直接 Ctrl+V 粘贴回显截图",
                                "Upload or Ctrl+V paste output screenshots",
                              )
                        }
                        onClick={() => probeImgInputRef.current?.click()}
                      >
                        <IconImage />
                        <span>{bi("上传回显截图", "Upload Image")}</span>
                      </button>
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
                          <span>{bi("上传 .log / .txt", "Upload .log / .txt")}</span>
                        </button>
                      </Upload>
                      {Boolean(probeOut.trim()) && (
                        <button
                          type="button"
                          className="rh-inline-cancel"
                          disabled={probeBusy}
                          onClick={() => setProbeOut("")}
                        >
                          {bi("清空文本", "Clear")}
                        </button>
                      )}
                    </div>
                  </div>

                  <Input.TextArea
                    value={probeOut}
                    disabled={probeBusy}
                    onChange={setProbeOut}
                    autoSize={{ minRows: 9, maxRows: 20 }}
                    className="mono rh-echo-area"
                    placeholder={bi(
                      "粘贴采集脚本终端回显、按 Ctrl+V 粘贴堡垒机/终端截图，或直接打字说明生产当前主从角色、版本与配置现状…",
                      "Paste probe terminal output, Ctrl+V screenshots, or directly describe current primary/replica roles, version, and active config…",
                    )}
                    aria-label={bi("现场回显或状态说明", "Probe output or status notes")}
                  />

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
                          {bi("测试演练环境节点映射", "Staging Node Mapping")}{" "}
                          <span className="faint">{bi("（可选）", "(optional)")}</span>
                        </label>
                        {!testEnvNote.trim() && (
                          <button
                            type="button"
                            className="rh-inline-cancel"
                            onClick={() => setTestEnvOpen(false)}
                          >
                            {bi("收起", "Collapse")}
                          </button>
                        )}
                      </div>
                      <Input
                        id={`tenv-${r.id}`}
                        value={testEnvNote}
                        disabled={probeBusy}
                        onChange={setTestEnvNote}
                        placeholder={bi(
                          "例如：测试环境机器为 192.168.56.11~13，操作系统及架构与生产一致",
                          "e.g., Staging hosts: 192.168.56.11–13, matching OS & arch",
                        )}
                        aria-label={bi("测试环境说明", "Staging environment note")}
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
                          <span>
                            {bi("映射测试演练节点（可选）", "Map Staging Nodes (optional)")}
                          </span>
                        </button>
                      )}
                      <span className="rh-foot-note">
                        {isMac
                          ? bi("⌘ + Enter 提交分析", "⌘ + Enter Analyze")
                          : bi("Ctrl + Enter 提交分析", "Ctrl + Enter Analyze")}
                      </span>
                    </div>
                    <div className="rh-compose-submit">
                      <ThinkLevel
                        levels={pick.current?.effort}
                        value={aiOpts.pref.think}
                        onChange={(v) => aiOpts.update({ think: v })}
                        compact
                      />
                      <ModelPicker pick={pick} compact />
                      <Button
                        shape="round"
                        type="secondary"
                        loading={probeBusy && probeAction === "diagnose"}
                        disabled={offline || !hasProbeInput || probeBusy}
                        onClick={() => void submitProbe("diagnose")}
                        title={bi(
                          "探针脚本在现场报错或未出结果时点此诊断修复，不进入漂移比对",
                          "Diagnose and fix probe script errors without running drift analysis",
                        )}
                      >
                        {bi("探针报错？诊断修复", "Fix Probe Error")}
                      </Button>
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
                        title={
                          isMac
                            ? bi("⌘ + Enter 校验并分析", "⌘ + Enter Verify & Analyze")
                            : bi("Ctrl + Enter 校验并分析", "Ctrl + Enter Verify & Analyze")
                        }
                        loading={probeBusy && probeAction === "analyze"}
                        disabled={offline || !hasProbeInput || probeBusy}
                        onClick={() => void submitProbe("analyze")}
                      >
                        {bi("校验结果并分析漂移", "Verify & Analyze Drift")}
                      </Button>
                    </div>
                  </div>
                </div>

                {r.probe_images && r.probe_images.length > 0 && (
                  <SavedImageGallery
                    clusterId={c.id}
                    rehearsalId={r.id}
                    names={r.probe_images}
                    label={bi("已归档现场回显截图", "Archived Probe Screenshots")}
                  />
                )}
              </div>
            </div>

              </>
            )}
          </section>
        )}

        {/* ---- Stage 3: Test Rehearsal ---- */}
        {curIdx === 2 && (
          <div className={`rh-rehearse-wrap${isFreshProbe ? " is-fresh-reveal" : ""}`}>
            {liveProbe && probeAction === "analyze" ? (
              <RehearsalAIProcess
                live={liveProbe}
                title={liveProbe.title}
                onAbort={() => {
                  abortRehearsalTask(probeKey);
                  switchStage("probing");
                  const probeLabel = isLightMode
                    ? bi("极简探针", "Quick Probe")
                    : bi("只读探针", "Read-Only Probe");
                  Message.info(
                    bi(
                      `已停止分析，已返回「${probeLabel}」`,
                      `Stopped — returned to ${probeLabel}`,
                    ),
                  );
                }}
                onRetry={() => void submitProbe("analyze")}
                onDismiss={() => {
                  clearRehearsalTask(probeKey);
                  switchStage("probing");
                }}
              />
            ) : (
              <>
            {(r.traces?.probe || (isQuickMode && r.traces?.create)) && (
              <RehearsalAIProcess
                trace={(r.traces?.probe || r.traces?.create)!}
                title={
                  isQuickMode && !r.traces?.probe
                    ? bi(
                        "AI 极速变更步骤编排思考",
                        "AI Quick Change Step Synthesis",
                      )
                    : bi(
                        "AI 现场漂移比对与演练编排思考",
                        "AI Drift Comparison & Plan Synthesis",
                      )
                }
                defaultOpen={
                  freshTraceStage === "probe" ||
                  (isQuickMode && freshTraceStage === "create")
                }
              />
            )}

            {r.drift && (() => {
              const hosts = r.drift.hosts || [];
              const driftUnverified =
                hosts.length > 0 &&
                hosts.every((h) =>
                  /未知|unknown|未采集|未获取/i.test(
                    `${h.actual_role || ""} ${h.status || ""}`,
                  ),
                );
              const showWarn = r.drift.drifted || driftUnverified;
              return (
              <section
                className={`rh-drift-sec ${showWarn ? "is-drifted" : ""}`}
                aria-label={bi("基线与现场比对", "Baseline vs Live Comparison")}
              >
                <div className="rh-drift-top">
                  <div className="rh-drift-title">
                    <span
                      className={`sdot ${showWarn ? "s-warn" : "s-done"}`}
                    />
                    <b>
                      {driftUnverified
                        ? bi(
                            "现场状态未采集完整，尚不能判定与基线一致",
                            "Live state unverified — cannot confirm baseline match",
                          )
                        : r.drift.drifted
                          ? bi(
                              "检测到现场状态与初始交付存在漂移",
                              "Live state drifted from initial baseline",
                            )
                          : bi(
                              "现场状态与初始交付基线一致",
                              "Live state matches initial baseline",
                            )}
                    </b>
                    <span className="rh-drift-tag">
                      {driftUnverified
                        ? bi("待补采核实", "Re-collection Needed")
                        : r.drift.drifted
                          ? bi("已按现场拓扑对齐", "Aligned to Live State")
                          : bi("基线一致", "Baseline Matched")}
                    </span>
                    {driftUnverified && (
                      <Button
                        size="mini"
                        type="outline"
                        onClick={() => switchStage("probing")}
                      >
                        {bi("返回第 2 步修复探针", "Back to Step 2 to Fix Probe")}
                      </Button>
                    )}
                  </div>
                  {r.drift.summary && (
                    <p className="rh-drift-sum">
                      {renderThinkingInline(r.drift.summary)}
                    </p>
                  )}
                </div>

                {(r.drift.hosts || []).length > 0 && (
                  <div className="rh-drift-block">
                    <div className="rh-drift-block-h">
                      <span>{bi("节点角色与状态", "Node Roles & Status")}</span>
                      <span className="rh-drift-cnt num">
                        {bi(`${r.drift.hosts.length} 台节点`, `${r.drift.hosts.length} nodes`)}
                      </span>
                    </div>
                    <div className="rh-drift-tbl-box">
                      <table className="rh-drift-tbl">
                        <colgroup>
                          <col style={{ width: "86px" }} />
                          <col style={{ width: "120px" }} />
                          <col style={{ width: "26%" }} />
                          <col style={{ width: "22%" }} />
                          <col />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>{bi("节点", "Node")}</th>
                            <th>{bi("地址", "Address")}</th>
                            <th>{bi("角色比对（初始 → 现场）", "Role (Initial → Live)")}</th>
                            <th>{bi("版本", "Version")}</th>
                            <th>{bi("运行状态", "Status")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.drift.hosts.map((h) => {
                            const initRole = (h.initial_role || "").trim();
                            const liveRole = (h.actual_role || "").trim();
                            const changed = Boolean(
                              initRole && liveRole && initRole !== liveRole,
                            );
                            const compactRole =
                              initRole.length <= 12 && liveRole.length <= 14;
                            const verText = (h.version || c.version || "—").trim();
                            const isVerPlaceholder =
                              !verText ||
                              /^(—|-|待采集|未采集|未在本机采集|未知|pending|n\/a|unknown)$/i.test(
                                verText,
                              );
                            const isShortVer =
                              !isVerPlaceholder &&
                              verText.length <= 24 &&
                              !/[\u4e00-\u9fa5]/.test(verText);
                            const roleSample = `${liveRole} ${initRole}`.toLowerCase();
                            const roleTone = /(leader|primary|master|主库|主节点|读写|writer)/i.test(
                              roleSample,
                            )
                              ? "primary"
                              : /(standby|replica|slave|secondary|follower|从库|从节点|备库|只读|reader)/i.test(
                                    roleSample,
                                  )
                                ? "replica"
                                : "neutral";
                            const statusText = (
                              h.status || bi("正常", "Healthy")
                            ).trim();
                            const cleanedStatus = statusText
                              .replace(
                                /(?:接收及回放\s*)?(?:lag|延迟)\s*(?:均为|为|=|:|：)?\s*0(?:\s*(?:bytes?|kb|mb|ms|s))?/gi,
                                "",
                              )
                              .replace(/无\s*(?:pending_restart|延迟|lag|异常)/gi, "");
                            const statusTone =
                              /(异常|down|fail|error|stopped|lag|延迟|断开|未知|未采集)/i.test(
                                cleanedStatus,
                              )
                                ? "warn"
                                : "ok";
                            return (
                              <tr key={h.name + h.ip}>
                                <td className="rh-cell-node">
                                  <b>{h.name}</b>
                                </td>
                                <td className="rh-cell-ip mono">{h.ip || "—"}</td>
                                <td className="rh-cell-role">
                                  {changed ? (
                                    compactRole ? (
                                      <span
                                        className={`rh-role-shift${r.drift!.drifted ? "" : ` is-soft tone-${roleTone}`}`}
                                      >
                                        <i className="rh-role-dot" aria-hidden />
                                        <span>{initRole}</span>
                                        <span aria-hidden>→</span>
                                        <b>{liveRole}</b>
                                      </span>
                                    ) : (
                                      <div className="rh-role-stack">
                                        <div className="rh-role-row">
                                          <span className="rh-mini-lbl is-base">
                                            {bi("初始", "Init")}
                                          </span>
                                          <span className="rh-role-from">
                                            {initRole}
                                          </span>
                                        </div>
                                        <div className="rh-role-row">
                                          <span
                                            className={`rh-mini-lbl ${r.drift!.drifted ? "is-warn" : "is-live"}`}
                                          >
                                            {bi("现场", "Live")}
                                          </span>
                                          <b className="rh-role-to">{liveRole}</b>
                                        </div>
                                      </div>
                                    )
                                  ) : (
                                    <span className={`rh-role-same tone-${roleTone}`}>
                                      <i className="rh-role-dot" aria-hidden />
                                      <span>{liveRole || initRole || "—"}</span>
                                    </span>
                                  )}
                                </td>
                                <td
                                  className={`rh-cell-ver${isShortVer ? " mono" : ""}${isVerPlaceholder ? " is-placeholder" : ""}`}
                                >
                                  {isShortVer ? (
                                    <span className="rh-ver-pill mono">{verText}</span>
                                  ) : (
                                    verText
                                  )}
                                </td>
                                <td className="rh-cell-status">
                                  <span className={`rh-status-chip is-${statusTone}`}>
                                    <i aria-hidden />
                                    <span>{statusText}</span>
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {(r.drift.param_diffs || []).length > 0 && (
                  <div className="rh-drift-block">
                    <div className="rh-drift-block-h">
                      <span>{bi("参数与配置比对", "Parameter & Config Comparison")}</span>
                      <span className="rh-drift-cnt num">
                        {bi(
                          `${r.drift.param_diffs!.length} 项`,
                          `${r.drift.param_diffs!.length} items`,
                        )}
                      </span>
                    </div>
                    <div className="rh-drift-tbl-box">
                      <table className="rh-pdiff-tbl">
                        <colgroup>
                          <col style={{ width: "22%" }} />
                          <col style={{ width: "39%" }} />
                          <col style={{ width: "39%" }} />
                        </colgroup>
                        <thead>
                          <tr>
                            <th>{bi("参数项", "Parameter")}</th>
                            <th>{bi("基线 → 现场实测", "Baseline → Live Value")}</th>
                            <th>{bi("影响与变更要点", "Impact & Change Note")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.drift.param_diffs!.map((p, idx) => {
                            const keyTokens = (p.key || "")
                              .split(/\s*\/\s*/)
                              .map((s) => s.trim())
                              .filter(Boolean);
                            const initVal = (p.initial || "").trim();
                            const liveVal = (p.actual || "—").trim();
                            const isUndeclaredBase =
                              !initVal ||
                              /^(—|-|未显式声明|未配置|未声明|默认|default|unset|n\/a)$/i.test(
                                initVal,
                              );
                            const hasConcreteDiff =
                              !isUndeclaredBase &&
                              liveVal !== "—" &&
                              initVal.toLowerCase() !== liveVal.toLowerCase();
                            const liveValTone = /^(on|true|enabled|开启|启用)$/i.test(
                              liveVal,
                            )
                              ? "is-on"
                              : /^(off|false|disabled|关闭|未开启)$/i.test(liveVal)
                                ? "is-off"
                                : "";
                            const isMonoLive =
                              liveVal.length <= 48 && !/[\u4e00-\u9fa5]/.test(liveVal);
                            return (
                              <tr key={`${p.key}-${idx}`}>
                                <td className="rh-pdiff-col-key">
                                  <div className="rh-pdiff-keys">
                                    {keyTokens.length > 1 ? (
                                      keyTokens.map((tk) => (
                                        <code key={tk} className="mono">
                                          {tk}
                                        </code>
                                      ))
                                    ) : (
                                      <code className="mono">{p.key}</code>
                                    )}
                                  </div>
                                </td>
                                <td className="rh-pdiff-col-val">
                                  <div className="rh-pdiff-vals">
                                    {p.initial && (
                                      <div className="rh-pdiff-val-row">
                                        <span className="rh-mini-lbl is-base">
                                          {bi("基线", "Base")}
                                        </span>
                                        <span className="rh-pdiff-base">
                                          {p.initial}
                                        </span>
                                      </div>
                                    )}
                                    <div className="rh-pdiff-val-row">
                                      <span
                                        className={`rh-mini-lbl ${hasConcreteDiff ? "is-warn" : "is-live"}`}
                                      >
                                        {bi("现场", "Live")}
                                      </span>
                                      <b
                                        className={`rh-pdiff-live${isMonoLive ? " mono" : ""}${liveValTone ? ` ${liveValTone}` : ""}`}
                                      >
                                        {liveVal}
                                      </b>
                                    </div>
                                  </div>
                                </td>
                                <td className="rh-pdiff-col-risk">
                                  {p.risk ? (
                                    <span className="rh-pdiff-risk">
                                      {renderThinkingInline(p.risk)}
                                    </span>
                                  ) : (
                                    <span className="faint">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
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
                    label={bi("现场采集回显截图", "Live Probe Screenshots")}
                  />
                )}
              </section>
              );
            })()}

            <div className="rh-gate" ref={gateRef}>
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
                  <div className="rh-gate-title-row">
                    <b className="num">
                      {bi(
                        `必测步骤 ${doneRequired} / ${requiredSteps.length}`,
                        `Required ${doneRequired} / ${requiredSteps.length}`,
                      )}
                    </b>
                    {doneForwardCount > 0 && (
                      <button
                        type="button"
                        className="rh-done-toggle-btn"
                        onClick={() =>
                          setDoneExpandCmd((prev) => ({
                            expand: !prev.expand,
                            seq: prev.seq + 1,
                          }))
                        }
                      >
                        {doneExpandCmd.expand
                          ? bi(
                              `收起已完成 (${doneForwardCount})`,
                              `Fold done (${doneForwardCount})`,
                            )
                          : bi(
                              `展开已完成 (${doneForwardCount})`,
                              `Expand done (${doneForwardCount})`,
                            )}
                      </button>
                    )}
                  </div>
                  <span className="muted small">
                    {gateReady
                      ? isChangeReportMode
                        ? bi(
                            "全部必测步骤已验收，可一键生成《变更报告》归档留痕",
                            "All required steps verified; ready to generate & archive Change Report",
                          )
                        : bi(
                            "全部必测步骤已验证，可定稿生成生产实施方案",
                            "All required steps verified; ready to finalize Production SOP",
                          )
                      : bi(
                          "贴入每步终端输出或截图，由 AI 对照预期判据自动核验通过或给出修正方案",
                          "Paste terminal output or screenshots for each step—AI verifies pass criteria or proposes fixes inline",
                        )}
                  </span>
                </div>
              </div>
              <div className="rh-gate-right">
                <Segmented<string>
                  label={bi("阶段筛选", "Phase filter")}
                  value={phaseFilter}
                  onChange={setPhaseFilter}
                  options={[
                    {
                      value: "all",
                      label: bi("正向步骤", "Forward"),
                      count: forwardSteps.length,
                    },
                    { value: "precheck", label: bi("预检", "Precheck") },
                    { value: "execute", label: bi("执行", "Execute") },
                    { value: "verify", label: bi("验收", "Verify") },
                    {
                      value: "rollback",
                      label: bi("应急回退", "Rollback"),
                      count: rollbackSteps.length > 0 ? rollbackSteps.length : undefined,
                    },
                  ]}
                />
                <Tooltip
                  content={
                    gateReady
                      ? isChangeReportMode
                        ? bi(
                            "汇总已核验的执行步骤、实测记录与回退预案，生成集群《变更报告》",
                            "Compile verified steps, results & rollback plan into a Cluster Change Report",
                          )
                        : bi(
                            "将已验证命令与实测耗时映射回生产节点并生成实施方案",
                            "Map verified commands & timings back to production nodes and generate SOP",
                          )
                      : bi(
                          `完成剩余 ${requiredSteps.length - doneRequired} 个必测步骤后可${isChangeReportMode ? "生成报告" : "定稿"}`,
                          `Complete remaining ${requiredSteps.length - doneRequired} required step(s) first`,
                        )
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
                      {isChangeReportMode
                        ? bi("生成变更报告", "Generate Change Report")
                        : bi("定稿实施方案", "Finalize SOP")}
                    </Button>
                  </span>
                </Tooltip>
              </div>
            </div>

            {phaseFilter !== "rollback" &&
              (r.restoration_alerts || []).length > 0 && (() => {
                const alerts = r.restoration_alerts!;
                const first = alerts[0];
                const aiReady = Boolean(
                  dock &&
                    !offline &&
                    dock.available(`step:rehearsal:${r.id}:${first.step_id}`),
                );
                const askAIRestore = () => {
                  if (!dock) return;
                  const summaryLines = alerts
                    .map(
                      (a, idx) =>
                        `${idx + 1}. ${a.summary}（建议：${a.suggestion}）`,
                    )
                    .join("\n");
                  dock.open({
                    key: `step:rehearsal:${r.id}:${first.step_id}`,
                    title: bi(
                      `补全临时状态复位步骤 · ${r.title}`,
                      `Add State Restoration Steps · ${r.title}`,
                    ),
                    context: `${r.title} · ${c.id}`,
                    step: {
                      kind: "rehearsal_step",
                      cluster_id: c.id,
                      rehearsal_id: r.id,
                      rehearsal_title: r.title,
                      step_id: first.step_id,
                      restoration_alerts: alerts,
                    },
                    hello: bi(
                      "系统检测到本次演练包含尚未配齐恢复/清理命令的临时状态变更。直接发送下方草稿，我会读取演练完整步骤并给出「一键插入复位步骤」卡片。",
                      "Detected temporary state changes without forward restoration steps. Send the draft below and I will generate 1-click step insertion card(s).",
                    ),
                    draft: bi(
                      `请调用 read_rehearsal 读取演练 #${r.id} 的完整步骤，针对以下未配齐的临时状态变更，使用 propose_rehearsal_step_edit（insert_after）在合适位置补充显式的复位/恢复/清理步骤（执行机器与 IP 写清楚，命令 1～6 行可直接复制）：\n${summaryLines}`,
                      `Please inspect rehearsal #${r.id} via read_rehearsal and use propose_rehearsal_step_edit (insert_after) to add explicit forward restoration/cleanup step(s) for:\n${summaryLines}`,
                    ),
                  });
                };
                return (
                  <div className="rh-restore-guard" role="note">
                    <div className="rh-restore-guard-head">
                      <div className="rh-restore-guard-title">
                        <IconExclamationCircle />
                        <b>
                          {bi(
                            `临时状态复位检查 · 发现 ${alerts.length} 项改动未配齐恢复/清理步骤`,
                            `State Restoration Check · ${alerts.length} temporary change(s) missing cleanup/restore`,
                          )}
                        </b>
                      </div>
                      {aiReady && (
                        <button
                          type="button"
                          className="rh-restore-ai-btn"
                          onClick={askAIRestore}
                        >
                          <Spark size={12} />
                          <span>
                            {bi("让 AI 补全复位步骤", "Ask AI to Add Restore Step")}
                          </span>
                        </button>
                      )}
                    </div>
                    <ul className="rh-restore-guard-list">
                      {alerts.map((a, idx) => (
                        <li key={`${a.kind}-${a.step_id}-${idx}`}>
                          <span className="rh-restore-guard-sum">
                            {a.summary}
                          </span>
                          <span className="rh-restore-guard-sug">
                            {bi("建议：", "Suggestion: ")}
                            {a.suggestion}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()}

            {r.source?.strict_precheck &&
              steps[0]?.phase === "precheck" &&
              steps[0]?.status !== "passed" &&
              phaseFilter !== "rollback" && (
                <div className="ro-strict-gate" role="alert">
                  <IconExclamationCircle className="ro-strict-gate-ic" />
                  <div className="ro-strict-gate-body">
                    <b>
                      {bi(
                        "严格前置预检门禁（强制阻断 · 不可跳过）",
                        "Strict Precheck Hard Gate (Mandatory · Non-Skippable)",
                      )}
                    </b>
                    <p>
                      {bi(
                        `本方案由样板集群 ${r.source.origin_cluster_id} 按同架构快车道引入（跳过了独立探针）。请先在目标集群执行第 1 步并核验通过（确认节点 IP、软件实测版本、主从健康、无全局 Pending restart / 阻塞长事务、目标参数现值无冲突且磁盘充足）；预检通过前，系统会阻断直接跳过第 1 步或提前推进后续步骤。`,
                        `Fast-track imported from pilot ${r.source.origin_cluster_id} without standalone probe. Run and verify Step 1 first (node identity, exact versions, healthy topology, zero global pending_restart / blocking long tx, clean target parameters, disk headroom). Skipping Step 1 or passing later steps is blocked until Step 1 passes.`,
                      )}
                    </p>
                  </div>
                </div>
              )}

            {phaseFilter === "rollback" && rollbackSteps.length > 0 && (
              <div className="rh-rollback-banner" role="note">
                <IconExclamationCircle />
                <div>
                  <b>{bi("应急回退预案 · 仅变更异常或受阻时按需执行", "Emergency Rollback Plan · Run ONLY if Change Fails")}</b>
                  <span>
                    {bi(
                      "正常完成正向步骤并通过验收后切勿顺手执行下方命令；回退预案已自动收录至最终生产实施方案「应急回退」章节。",
                      "Do NOT execute these after a normal successful change; rollback steps are automatically included in the finalized SOP.",
                    )}
                  </span>
                </div>
              </div>
            )}

            {shownSteps.length === 0 ? (
              <div className="rh-empty-filter muted small">
                {bi(
                  "该阶段下暂无步骤，切换到「正向步骤」查看完整执行清单。",
                  "No steps in this phase; switch to Forward to view the execution checklist.",
                )}
              </div>
            ) : (
              <ol className="rh-timeline" ref={timelineRef}>
                {(() => {
                  const isRollbackTab = phaseFilter === "rollback";
                  const activeStepId = isRollbackTab
                    ? undefined
                    : shownSteps.find(
                        (s) => s.status !== "passed" && s.status !== "skipped",
                      )?.id;
                  return shownSteps.map((step, idx) => (
                    <StepRow
                      key={step.id}
                      c={c}
                      rehearsalId={r.id}
                      rehearsalTitle={r.title}
                      step={step}
                      index={idx + 1}
                      nodeLabel={isRollbackTab ? `R${idx + 1}` : undefined}
                      forwardDone={gateReady}
                      doneExpandCmd={doneExpandCmd}
                      isActiveStep={step.id === activeStepId}
                      isArrival={!isRollbackTab && step.id === arrivalStepId}
                      staggerIndex={isFreshProbe ? Math.min(idx, 7) : undefined}
                      offline={offline}
                      noVision={noVision}
                      pick={pick}
                      aiOpts={aiOpts}
                      onUpdated={setR}
                      onEngageFocus={onEngageFocus}
                      onStepSettled={isRollbackTab ? undefined : handleStepSettled}
                    />
                  ));
                })()}
              </ol>
            )}

            {phaseFilter === "all" && rollbackSteps.length > 0 && (() => {
              const hasExecutedRollback = rollbackSteps.some(
                (s) => s.status === "passed" || s.status === "failed",
              );
              const autoSkipped = gateReady && !hasExecutedRollback;
              return (
                <details
                  className={`rh-rollback-vault${autoSkipped ? " is-auto-skipped" : ""}`}
                >
                  <summary>
                    <span className="rh-rollback-vault-left">
                      {autoSkipped ? <IconCheck /> : <IconExclamationCircle />}
                      <b>
                        {bi(
                          `应急回退预案（${rollbackSteps.length} 步）`,
                          `Emergency Rollback Plan (${rollbackSteps.length})`,
                        )}
                      </b>
                      {autoSkipped ? (
                        <span className="rh-rollback-ok-pill">
                          {bi("✓ 已默认跳过 · 无需处理", "✓ Auto-Skipped · No Action Needed")}
                        </span>
                      ) : (
                        <span className="rh-rollback-warn-pill">
                          {bi(
                            "仅异常时执行 · 勿随正向步骤顺手操作",
                            "Emergency only · Do NOT run sequentially",
                          )}
                        </span>
                      )}
                    </span>
                    <span className="rh-rollback-vault-hint">
                      {autoSkipped
                        ? isChangeReportMode
                          ? bi(
                              "正向已全部通过 · 回退命令已自动收录进变更报告（无需点开点跳过，如需查看可展开）",
                              "All forward steps passed · Included in Change Report (no need to open/skip)",
                            )
                          : bi(
                              "正向已全部通过 · 回退命令已自动收录进定稿 SOP（无需点开点跳过，如需查看可展开）",
                              "All forward steps passed · Included in SOP (no need to open/skip)",
                            )
                        : isChangeReportMode
                          ? bi(
                              "默认自动跳过 · 无需点开操作 · 已自动纳入变更报告",
                              "Auto-skipped by default · Included in Change Report",
                            )
                          : bi(
                              "默认自动跳过 · 无需点开操作 · 已自动纳入定稿 SOP",
                              "Auto-skipped by default · Included in SOP",
                            )}
                    </span>
                  </summary>
                  <div className="rh-rollback-vault-body">
                    <div className="rh-rollback-banner" role="note">
                      <IconExclamationCircle />
                      <div>
                        <b>
                          {bi(
                            "高危防误操作提示：此处为变更失败或指标异常时的回退命令",
                            "Safety Warning: Rollback commands for failed changes only",
                          )}
                        </b>
                        <span>
                          {isChangeReportMode
                            ? bi(
                                "正向步骤全部通过后，本区回退预案会自动跳过并完整写入《变更报告》，您无需执行也无需手动点击跳过；仅在确实需要演练回退或触发应急回滚时使用。",
                                "Automatically skipped and archived into the Change Report once forward steps pass; run only when rehearsing or executing an emergency rollback.",
                              )
                            : bi(
                                "正向步骤全部通过后，本区回退预案会自动跳过并完整写入定稿 SOP，您无需执行也无需手动点击跳过；仅在确实需要演练回退或触发应急回滚时使用。",
                                "Automatically skipped and archived into the finalized SOP once forward steps pass; run only when rehearsing or executing an emergency rollback.",
                              )}
                        </span>
                      </div>
                    </div>
                    <ol className="rh-timeline is-rollback-list">
                      {rollbackSteps.map((step, idx) => (
                        <StepRow
                          key={step.id}
                          c={c}
                          rehearsalId={r.id}
                          rehearsalTitle={r.title}
                          step={step}
                          index={idx + 1}
                          nodeLabel={`R${idx + 1}`}
                          forwardDone={gateReady}
                          isActiveStep={false}
                          offline={offline}
                          noVision={noVision}
                          pick={pick}
                          aiOpts={aiOpts}
                          onUpdated={setR}
                          onEngageFocus={onEngageFocus}
                        />
                      ))}
                    </ol>
                  </div>
                </details>
              );
            })()}
              </>
            )}
          </div>
        )}

        {/* ---- Stage 4: Finalized Production SOP ---- */}
        {curIdx === 3 && (
          <section className={`rh-sec rh-final-sec${isFreshFinal ? " is-fresh-reveal" : ""}`}>
            {busyFinalize ? (
              <div className="rh-finalize-busy" role="status">
                <span className="rh-stage-pulse" aria-hidden />
                <div>
                  <b>
                    {isChangeReportMode
                      ? bi("正在整理实测记录并归档《变更报告》…", "Compiling verification records & archiving Change Report…")
                      : bi("正在映射生产节点拓扑并定稿《生产变更实施方案》…", "Mapping verified steps onto production topology & finalizing SOP…")}
                  </b>
                  <p className="muted small">
                    {bi(
                      "将自动汇总各步命令、实测核验结论、参数变更与回退预案并写入集群文档。",
                      "Consolidating executed commands, verification notes, parameter changes, and rollback steps into Cluster Docs.",
                    )}
                  </p>
                </div>
              </div>
            ) : (
            <>
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
                  <span
                    className={`rh-doc-badge${r.voided ? " is-voided" : r.applied ? " is-applied" : " is-pending-apply"}`}
                  >
                    {r.voided
                      ? r.superseded_by
                        ? bi("⊘ 已被替代", "⊘ Superseded")
                        : bi("⊘ 已作废", "⊘ Voided")
                      : r.applied
                        ? bi("✓ 生产已落地", "✓ Applied to Prod")
                        : isChangeReportMode
                          ? bi("已归档 · 待确认落地", "Archived · Pending Apply")
                          : bi("已定稿 · 待生产实施", "Finalized · Pending Apply")}
                  </span>
                  <span className="mono faint small">
                    {r.doc_id || `sop-${r.id}`}
                  </span>
                </div>
                <h3>
                  {isChangeReportMode
                    ? bi(`${r.title} · 变更报告`, `${r.title} · Change Report`)
                    : bi(
                        `${r.title} · 生产变更实施方案`,
                        `${r.title} · Production Change SOP`,
                      )}
                </h3>
                <p className="muted">
                  {isChangeReportMode
                    ? biv(
                        <>
                          已汇总集群 <b className="mono">{c.id}</b>{" "}
                          本次变更的实际执行命令、核验结论与回退预案，归档至集群「文档」供追溯与审计。
                        </>,
                        <>
                          Compiled executed commands, verification outcomes, and
                          rollback plan for cluster <b className="mono">{c.id}</b>{" "}
                          into Cluster Docs for auditability.
                        </>,
                      )
                    : biv(
                        <>
                          已将测试环境验证通过的步骤、实测耗时与回退预案映射回集群{" "}
                          <b className="mono">{c.id}</b> 的生产节点拓扑，并归档至集群文档。
                        </>,
                        <>
                          Mapped verified steps, measured durations, and rollback
                          procedures onto production topology for cluster{" "}
                          <b className="mono">{c.id}</b> and archived to Cluster Docs.
                        </>,
                      )}
                </p>
                <dl className="rh-doc-facts">
                  <div>
                    <dt>{bi("验证步骤", "Steps")}</dt>
                    <dd className="num">
                      {bi(`${steps.length} 步`, `${steps.length}`)}
                    </dd>
                  </div>
                  <div>
                    <dt>{bi("必测通过", "Required Passed")}</dt>
                    <dd className="num">
                      {doneRequired}/{requiredSteps.length}
                    </dd>
                  </div>
                  {totalRevisions > 0 && (
                    <div>
                      <dt>{bi("排障修订", "Revisions")}</dt>
                      <dd className="num">
                        {bi(`${totalRevisions} 次`, `${totalRevisions}`)}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>{bi("目标组件", "Component")}</dt>
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
                      {bi("打开文档审阅", "Open Document")} <IconRight />
                    </Button>
                  )}
                  {r.doc_id && can("report.export") && (
                    <Button
                      icon={<IconDownload />}
                      disabled={exportingDoc}
                      loading={exportingDoc}
                      onClick={() => {
                        if (exportingDoc) return;
                        setExportingDoc(true);
                        if (exportCooldownRef.current !== null) {
                          window.clearTimeout(exportCooldownRef.current);
                        }
                        exportCooldownRef.current = window.setTimeout(() => {
                          exportCooldownRef.current = null;
                          setExportingDoc(false);
                        }, 1500);
                        window.location.href = withLang(
                          `/api/clusters/${encodeURIComponent(c.id)}/export?docs=${encodeURIComponent(r.doc_id!)}`,
                        );
                      }}
                    >
                      {bi("导出 Word (.docx)", "Export Word (.docx)")}
                    </Button>
                  )}
                  <Button
                    type="text"
                    icon={<IconRefresh />}
                    loading={busyFinalize}
                    disabled={offline}
                    onClick={() => void finalizeSOP()}
                  >
                    {isChangeReportMode
                      ? bi("重新同步报告", "Re-sync Report")
                      : bi("重新同步生成", "Re-sync SOP")}
                  </Button>
                </div>
              </div>
            </div>

            <RehearsalProductionApplyCard
              clusterId={c.id}
              rehearsal={r}
              peers={peers}
              offline={offline}
              onRolloutBoardChange={(b) => setRolloutBoardOverride(b)}
              onUpdated={(next) => {
                setR(next);
                putCached(rehearsalItemPath(c.id, next.id), next);
                void onListChanged();
                onClusterChanged?.();
              }}
            />
            </>
            )}
          </section>
        )}
      </div>
        </>
      )}

      {r.stage === "finalized" && r.applied && !r.voided && (
        <PropagateRehearsalModal
          clusterId={c.id}
          rehearsal={r}
          visible={stripPropagateOpen}
          onClose={() => setStripPropagateOpen(false)}
          onPropagated={(res) => {
            if (res.board) setRolloutBoardOverride(res.board);
            setStripRolloutOpen(true);
            void api<ChangeRehearsal>(rehearsalItemPath(c.id, r.id))
              .then((fresh) => {
                setR(fresh);
                putCached(rehearsalItemPath(c.id, fresh.id), fresh);
                void onListChanged();
                onClusterChanged?.();
              })
              .catch(() => undefined);
          }}
        />
      )}

      {(rolloutBoardOverride?.rollout_id || r.source?.rollout_id) && (
        <RolloutBoardDrawer
          rolloutId={
            rolloutBoardOverride?.rollout_id || r.source?.rollout_id || ""
          }
          visible={stripRolloutOpen}
          currentClusterId={c.id}
          initialBoard={rolloutBoardOverride}
          onClose={() => setStripRolloutOpen(false)}
          onAddMore={
            r.stage === "finalized" && r.applied && !r.voided
              ? () => {
                  setStripRolloutOpen(false);
                  setStripPropagateOpen(true);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/* ---------- Continuous Timeline Step Row ---------- */

const RE_ROLLING_ACTION =
  /\b(patronictl\b[^\n]*\b(restart|reinit|reload|switchover|failover|pause|resume)\b|systemctl\b[^\n]*\b(restart|stop|reload)\b|service\s+\S+\s+(restart|stop|reload)\b|pg_ctl\b[^\n]*\b(restart|stop|promote|reload)\b|redis-cli\b[^\n]*\b(failover|shutdown|replicaof|slaveof)\b|etcdctl\b[^\n]*\b(move-leader|member\s+(remove|add|replace))\b|set\s+server\s+\S+\s+state\s+(maint|drain|ready)\b|nginx\s+-s\s+(reload|stop)\b|repmgr\b[^\n]*\b(switchover|promote|follow)\b)/i;
const RE_SYSTEMCTL_DAEMON = /\bsystemctl\b[^\n]*\bdaemon-reload\b/i;
const RE_SYSTEMCTL_RESTART_STOP = /\bsystemctl\b[^\n]*\b(restart|stop)\b/i;
const RE_PATRONI_NODE =
  /\bpatronictl\b[^\n]*\b(?:restart|reinit|reload)\s+(?:-[^\s]+\s+\S+\s+)*[^\s-]+\s+([a-zA-Z0-9][a-zA-Z0-9._-]{1,40})\b/i;
const RE_NODE_HINT =
  /\b((?:node|pg|db|etcd|redis|master|primary|standby|replica|host|srv|vm)[-_]?[0-9]{1,3}|[0-9]{1,3}(?:\.[0-9]{1,3}){3})\b/;
const RE_HEREDOC_START = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;
const RE_BLOCK_OPEN = /(?:^|[;&|]\s*)(if|for|while|until|case)\b/i;
const RE_BLOCK_CLOSE = /(?:^|[;&|]\s*)(fi|done|esac)\b/i;

function isRollingActionLine(trimmed: string): boolean {
  if (!trimmed || trimmed.startsWith("#")) return false;
  if (RE_SYSTEMCTL_DAEMON.test(trimmed) && !RE_SYSTEMCTL_RESTART_STOP.test(trimmed)) {
    return false;
  }
  return RE_ROLLING_ACTION.test(trimmed);
}

function extractRollingHint(lines: string[]): string {
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    const pm = t.match(RE_PATRONI_NODE);
    if (pm?.[1] && !pm[1].startsWith("-")) return pm[1];
    if (isRollingActionLine(t)) {
      const low = t.toLowerCase();
      if (low.includes("switchover") || low.includes("failover")) return "switchover";
      const nm = t.match(RE_NODE_HINT);
      if (nm?.[1]) return nm[1];
    }
  }
  for (const raw of lines) {
    const t = raw.trim();
    if (t.startsWith("#")) {
      const c = t.replace(/^#+\s*/, "").trim();
      if (c) return c.slice(0, 28);
    }
  }
  return "";
}

function splitSequentialRollingCommands(cmd: string): RehearsalStepCommand[] {
  const rawLines = unwrapOuterPasteGroup(cmd).split("\n");
  if (rawLines.length < 2) return [];
  const segs: { lines: string[]; hasRolling: boolean }[] = [];
  let cur: { lines: string[]; hasRolling: boolean } = {
    lines: [],
    hasRolling: false,
  };
  let heredocEnd = "";
  let blockDepth = 0;
  let prevCont = false;

  for (const line of rawLines) {
    const trimmed = line.trim();
    const inMulti = Boolean(heredocEnd) || blockDepth > 0 || prevCont;
    if (!inMulti && isRollingActionLine(trimmed) && cur.hasRolling) {
      const carry: string[] = [];
      while (cur.lines.length > 0) {
        const last = cur.lines[cur.lines.length - 1].trim();
        if (!last || last.startsWith("#")) {
          carry.unshift(cur.lines.pop()!);
        } else {
          break;
        }
      }
      while (carry.length > 0 && !carry[0].trim()) carry.shift();
      if (cur.lines.length > 0) segs.push(cur);
      cur = { lines: carry, hasRolling: false };
    }
    cur.lines.push(line);
    if (!inMulti && isRollingActionLine(trimmed)) cur.hasRolling = true;

    if (heredocEnd) {
      if (trimmed === heredocEnd) heredocEnd = "";
    } else if (!trimmed.startsWith("#")) {
      const hm = trimmed.match(RE_HEREDOC_START);
      if (hm?.[1]) heredocEnd = hm[1];
      if (RE_BLOCK_OPEN.test(trimmed) && !RE_BLOCK_CLOSE.test(trimmed)) {
        blockDepth++;
      } else if (RE_BLOCK_CLOSE.test(trimmed) && blockDepth > 0) {
        blockDepth--;
      }
    }
    prevCont = /[\\]\s*$/.test(line);
  }
  if (cur.lines.length > 0) segs.push(cur);
  if (segs.length < 2) return [];

  const out: RehearsalStepCommand[] = [];
  for (let i = 0; i < segs.length; i++) {
    const body = segs[i].lines.join("\n").trim();
    if (!body) continue;
    const hint = extractRollingHint(segs[i].lines);
    const label =
      hint === "switchover"
        ? bi(`第 ${i + 1} 段 · 切主`, `Part ${i + 1} · Switchover`)
        : hint
          ? bi(`第 ${i + 1} 段 · ${hint}`, `Part ${i + 1} · ${hint}`)
          : bi(`第 ${i + 1} 段`, `Part ${i + 1}`);
    const gate =
      i < segs.length - 1
        ? hint && hint !== "switchover"
          ? bi(
              `暂停核验：确认 ${hint} 恢复健康（如 streaming / Lag=0 / 无告警）后，再复制执行下一段`,
              `Pause & verify: confirm ${hint} is healthy (streaming / Lag=0 / no alerts) before running the next block`,
            )
          : bi(
              "暂停核验：确认本段执行成功且集群恢复健康后，再复制执行下一段",
              "Pause & verify: confirm this block succeeded and cluster is healthy before running the next block",
            )
        : "";
    out.push({ label, command: body, gate });
  }
  return out.length >= 2 ? out : [];
}

const RE_CLOSE_SUBSHELL = /^\)\s*(<\s*\/dev\/null\s*)?(2>&1\s*)?$/;
const RE_CLOSE_BRACE = /^\}\s*(<\s*\/dev\/null\s*)?(2>&1\s*)?$/;
const RE_SUBCMD_TARGET_HINT =
  /(各子命令|子命令框|分步执行|逐段|sub-?command)/i;
const RE_SUBCMD_HOST_PREFIX =
  /^(node[-_]?\d+|第\s*\d+\s*段|part\s*\d+|三节点|全节点|所有节点|主库|从库|主节点|从节点|备库|跳板机|集群外|客户端)/i;

/**
 * Recovers separate sub-command boxes from a flattened `joinStepCommandsFallback` string
 * (`# <label>\n<cmd>\n\n# <label2>\n<cmd2>`) while respecting heredoc/subshell nesting.
 */
function splitFlattenedSubCommands(
  cmd: string,
  targetRole?: string,
): RehearsalStepCommand[] {
  const raw = (cmd || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  const lines = raw.split("\n");
  if (lines.length < 4) return [];

  const blocks: string[][] = [];
  let cur: string[] = [];
  let heredocEnd = "";
  let subDepth = 0;
  let blockDepth = 0;
  let prevCont = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const inMulti =
      Boolean(heredocEnd) || subDepth > 0 || blockDepth > 0 || prevCont;
    if (!inMulti && !trimmed) {
      if (cur.length > 0) {
        blocks.push(cur);
        cur = [];
      }
      continue;
    }
    cur.push(line);
    if (heredocEnd) {
      if (trimmed === heredocEnd) heredocEnd = "";
      prevCont = false;
      continue;
    }
    if (!trimmed.startsWith("#")) {
      const hm = trimmed.match(RE_HEREDOC_START);
      if (hm?.[1]) heredocEnd = hm[1];
      if (trimmed === "(" || trimmed === "{") {
        subDepth++;
      } else if (
        (RE_CLOSE_SUBSHELL.test(trimmed) || RE_CLOSE_BRACE.test(trimmed)) &&
        subDepth > 0
      ) {
        subDepth--;
      }
      if (RE_BLOCK_OPEN.test(trimmed) && !RE_BLOCK_CLOSE.test(trimmed)) {
        blockDepth++;
      } else if (RE_BLOCK_CLOSE.test(trimmed) && blockDepth > 0) {
        blockDepth--;
      }
    }
    prevCont = /[\\]\s*$/.test(line);
  }
  if (cur.length > 0) blocks.push(cur);
  if (blocks.length < 2) return [];

  const parsed: { label: string; body: string }[] = [];
  let subshellCount = 0;
  let hostLabelCount = 0;

  for (const rawBlk of blocks) {
    const blk = rawBlk.slice();
    while (blk.length > 0 && !blk[0].trim()) blk.shift();
    if (blk.length < 2) return [];
    const first = blk[0].trim();
    if (!first.startsWith("#")) return [];
    const label = first.replace(/^#+\s*/, "").trim();
    const body = blk.slice(1).join("\n").trim();
    if (!label || !body) return [];
    const hasExec = blk
      .slice(1)
      .some((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    if (!hasExec) return [];
    const bodyLines = body.split("\n");
    const isSubshell =
      bodyLines.length >= 3 &&
      ((bodyLines[0].trim() === "(" &&
        RE_CLOSE_SUBSHELL.test(bodyLines[bodyLines.length - 1].trim())) ||
        (bodyLines[0].trim() === "{" &&
          RE_CLOSE_BRACE.test(bodyLines[bodyLines.length - 1].trim())));
    if (isSubshell) subshellCount++;
    if (RE_SUBCMD_HOST_PREFIX.test(label)) hostLabelCount++;
    parsed.push({ label, body });
  }
  if (parsed.length < 2) return [];

  const strongSignal =
    subshellCount >= 1 ||
    RE_SUBCMD_TARGET_HINT.test(targetRole || "") ||
    hostLabelCount === parsed.length;
  if (!strongSignal) return [];

  return parsed.map((p) => ({
    label: p.label,
    command: p.body,
  }));
}

const StepRow = React.memo(function StepRow({
  c,
  rehearsalId,
  rehearsalTitle,
  step,
  index,
  nodeLabel,
  forwardDone = false,
  doneExpandCmd,
  isActiveStep = false,
  isArrival = false,
  staggerIndex,
  offline,
  noVision,
  pick,
  aiOpts,
  onUpdated,
  onEngageFocus,
  onStepSettled,
}: {
  c: ClusterView;
  rehearsalId: string;
  rehearsalTitle?: string;
  step: RehearsalStep;
  index: number;
  nodeLabel?: string;
  forwardDone?: boolean;
  doneExpandCmd?: { expand: boolean; seq: number };
  isActiveStep?: boolean;
  isArrival?: boolean;
  staggerIndex?: number;
  offline: boolean;
  noVision: boolean;
  pick: ReturnType<typeof useModelPick>;
  aiOpts: ReturnType<typeof useAIOptions>;
  onUpdated: (r: ChangeRehearsal) => void;
  onEngageFocus?: () => void;
  onStepSettled?: (stepId: string) => void;
}) {
  useLang();
  const dock = useAIDock();
  const verifyKey = rehearsalTaskKey.verify(c.id, rehearsalId, step.id);
  const verifyTask = useRehearsalTask<LiveAIState, ChangeRehearsal>(verifyKey);
  const liveVerify =
    verifyTask && (verifyTask.status === "running" || verifyTask.status === "error")
      ? verifyTask.live
      : null;

  const isRollback = step.phase === "rollback";
  const isDone = step.status === "passed" || step.status === "skipped";
  const [collapsed, setCollapsed] = useState(
    () => isDone && !isRehearsalTaskLive(getRehearsalTask(verifyKey)),
  );
  const [tearing, setTearing] = useState(false);
  const [justSettled, setJustSettled] = useState(false);
  const prevStatusRef = useRef(step.status);
  const prevStepIdRef = useRef(step.id);
  const [note, setNote] = useState(step.note || "");
  const [editingNote, setEditingNote] = useState(false);
  const [editingCmd, setEditingCmd] = useState(false);
  const resolvedSubCmds = useMemo<RehearsalStepCommand[]>(() => {
    if (step.commands && step.commands.length > 1) return step.commands;
    const flat = splitFlattenedSubCommands(step.command, step.target_role);
    if (flat.length > 1) return flat;
    return splitSequentialRollingCommands(step.command);
  }, [step.commands, step.command, step.target_role]);
  const [cmdDraft, setCmdDraft] = useState(step.command);
  const [subCmdDrafts, setSubCmdDrafts] = useState<RehearsalStepCommand[]>([]);
  const [editingProposalCmd, setEditingProposalCmd] = useState(false);
  const [proposalCmdDraft, setProposalCmdDraft] = useState(
    step.proposal?.command || "",
  );
  const [proposalRoleDraft, setProposalRoleDraft] = useState(
    step.proposal?.target_role || "",
  );
  const [verifyOpen, setVerifyOpen] = useState(
    () =>
      isRehearsalTaskLive(getRehearsalTask(verifyKey)) ||
      (!isRollback && isActiveStep) ||
      step.status === "failed" ||
      Boolean(step.proposal),
  );
  const [evidText, setEvidText] = useState(() => {
    const d = getRehearsalTask(verifyKey)?.draft?.evidText;
    return typeof d === "string" ? d : step.last_error || "";
  });
  const [evidImages, setEvidImages] = useState<DraftImage[]>(() => {
    const d = getRehearsalTask(verifyKey)?.draft?.evidImages as
      | DraftImage[]
      | undefined;
    return d ? [...d] : [];
  });
  const [dragEvid, setDragEvid] = useState(false);
  useEffect(() => {
    if (!dragEvid) return;
    const clear = () => setDragEvid(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", onKey);
    };
  }, [dragEvid]);
  const [freshVerify, setFreshVerify] = useState(false);
  const [verifyFlash, setVerifyFlash] = useState(false);
  const [busy, setBusy] = useState("");
  const stepBusyRef = useRef(false);
  const flashTimerRef = useRef<number | null>(null);
  const focusScrollTimerRef = useRef<number | null>(null);

  const evidImgInputRef = useRef<HTMLInputElement | null>(null);
  const verifyBoxRef = useRef<HTMLDivElement | null>(null);
  const onStepSettledRef = useRef(onStepSettled);
  onStepSettledRef.current = onStepSettled;

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
      if (focusScrollTimerRef.current !== null) {
        window.clearTimeout(focusScrollTimerRef.current);
      }
    };
  }, []);

  // Trigger Ichiban Kuji tear-off peel animation when a step freshly transitions to passed/skipped
  useEffect(() => {
    if (prevStepIdRef.current !== step.id) {
      prevStepIdRef.current = step.id;
      prevStatusRef.current = step.status;
      setTearing(false);
      setJustSettled(false);
      setCollapsed(step.status === "passed" || step.status === "skipped");
      return;
    }
    const prev = prevStatusRef.current;
    prevStatusRef.current = step.status;
    const wasDone = prev === "passed" || prev === "skipped";
    const nowDone = step.status === "passed" || step.status === "skipped";
    if (!wasDone && nowDone) {
      setTearing(true);
      setCollapsed(false);
      const t1 = window.setTimeout(() => {
        setTearing(false);
        setCollapsed(true);
        setJustSettled(true);
        if (!isRollback) {
          onStepSettledRef.current?.(step.id);
        }
      }, 720);
      const t2 = window.setTimeout(() => {
        setJustSettled(false);
      }, 1350);
      return () => {
        window.clearTimeout(t1);
        window.clearTimeout(t2);
      };
    }
    if (wasDone && !nowDone) {
      setTearing(false);
      setJustSettled(false);
      setCollapsed(false);
    }
  }, [step.id, step.status]);

  // Follow parent's global "Expand / Fold all completed" button
  useEffect(() => {
    if (!doneExpandCmd || doneExpandCmd.seq === 0) return;
    if (isDone && !tearing) {
      setCollapsed(!doneExpandCmd.expand);
    }
  }, [doneExpandCmd, isDone, tearing]);

  const focusVerifyBox = useCallback((clearInput: boolean) => {
    setVerifyOpen(true);
    if (clearInput) {
      setEvidText("");
      setEvidImages([]);
    }
    setVerifyFlash(true);
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setVerifyFlash(false);
    }, 1600);
    if (focusScrollTimerRef.current !== null) {
      window.clearTimeout(focusScrollTimerRef.current);
    }
    focusScrollTimerRef.current = window.setTimeout(() => {
      focusScrollTimerRef.current = null;
      const box = verifyBoxRef.current;
      if (!box) return;
      box.scrollIntoView({ behavior: "smooth", block: "center" });
      const ta = box.querySelector("textarea");
      if (ta) {
        ta.focus({ preventScroll: true });
      }
    }, 80);
  }, []);

  useEffect(() => {
    setCmdDraft(step.command);
    setSubCmdDrafts(
      resolvedSubCmds.length > 1
        ? resolvedSubCmds.map((s) => ({ ...s }))
        : [],
    );
    setNote(step.note || "");
    setProposalCmdDraft(step.proposal?.command || "");
    setProposalRoleDraft(step.proposal?.target_role || "");
    if (!step.proposal) {
      setEditingProposalCmd(false);
    }
    if (
      step.status === "failed" ||
      step.proposal ||
      isRehearsalTaskLive(getRehearsalTask(verifyKey))
    ) {
      setVerifyOpen(true);
    } else if (step.status === "passed" || step.status === "skipped") {
      setVerifyOpen(false);
    }
  }, [step.command, resolvedSubCmds, step.note, step.status, step.proposal, verifyKey]);

  useEffect(() => {
    if (!isRollback && isActiveStep && step.status === "pending") {
      setVerifyOpen(true);
    }
  }, [isActiveStep, isRollback, step.status]);

  const baseUrl = `/api/clusters/${encodeURIComponent(c.id)}/rehearsals/${encodeURIComponent(rehearsalId)}/steps/${encodeURIComponent(step.id)}`;

  const attachEvidFiles = async (files: FileList | File[]) => {
    const all = Array.from(files);
    const txtFiles = all.filter(
      (f) =>
        !f.type.startsWith("image/") &&
        (/\.(log|txt|out|json|conf|yaml|yml)$/i.test(f.name) ||
          f.type.startsWith("text/")),
    );
    for (const tf of txtFiles.slice(0, 1)) {
      if (tf.size > 2 * 1024 * 1024) {
        Message.warning(
          bi("日志文件请控制在 2 MiB 以内", "Log file must be under 2 MiB"),
        );
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setVerifyOpen(true);
        setEvidText(String(reader.result || ""));
        Message.success(bi(`已载入 ${tf.name}`, `Loaded ${tf.name}`));
      };
      reader.readAsText(tf);
    }

    const imgs = all.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    if (noVision) {
      Message.warning(
        bi(
          "当前所选模型不支持识别截图，请粘贴终端输出或在下方切换支持看图的模型",
          "Selected model does not support images; paste text output or switch to a vision model below",
        ),
      );
      return;
    }
    const room = MAX_IMAGES - evidImages.length;
    if (room <= 0) {
      Message.warning(
        bi(
          `单次最多附加 ${MAX_IMAGES} 张结果截图`,
          `Up to ${MAX_IMAGES} screenshots allowed`,
        ),
      );
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
      setVerifyOpen(true);
      setEvidImages((prev) => [...prev, ...added]);
    }
  };

  const patchStep = async (
    patch: Partial<
      Pick<RehearsalStep, "status" | "note" | "command" | "commands">
    > & {
      proposal_command?: string;
      proposal_target_role?: string;
    },
  ) => {
    if (offline || stepBusyRef.current) return;
    stepBusyRef.current = true;
    setBusy("patch");
    try {
      const next = await api<ChangeRehearsal>(baseUrl, {
        method: "PATCH",
        body: JSON.stringify({
          note,
          ...patch,
        }),
      });
      onUpdated(next);
      setEditingCmd(false);
      setEditingNote(false);
      setEditingProposalCmd(false);
      if (patch.proposal_command !== undefined) {
        Message.success(
          bi("已保存微调后的建议命令", "Saved edited recommended command"),
        );
      }
    } catch (e) {
      err(e);
    } finally {
      stepBusyRef.current = false;
      setBusy("");
    }
  };

  const verifyBusy = Boolean(liveVerify && !liveVerify.error);
  const hasEvidInput = Boolean(evidText.trim()) || evidImages.length > 0;

  // Consume completed background/foreground step verification task cleanly
  useEffect(() => {
    if (verifyTask?.status !== "done" || !verifyTask.result) return;
    const next = verifyTask.result;
    clearRehearsalTask(verifyKey);
    setEvidImages([]);
    setFreshVerify(true);
    onUpdated(next);
    const updatedStep = (next.steps || []).find((s) => s.id === step.id);
    if (updatedStep?.status === "passed") {
      setEvidText("");
      setVerifyOpen(false);
      if (!verifyTask.notified) {
        Message.success(
          bi(
            `步骤 #${step.order || index} AI 核验通过，已自动回写实测结论`,
            `Step #${step.order || index} verified PASSED by AI`,
          ),
        );
      }
    } else if (!verifyTask.notified) {
      Message.warning(
        bi(
          `步骤 #${step.order || index} 未通过核验，请查看下方 AI 诊断与修正建议`,
          `Step #${step.order || index} did not pass—see AI diagnosis below`,
        ),
      );
    }
  }, [verifyTask, verifyKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const askVerify = async () => {
    if (
      !hasEvidInput ||
      offline ||
      verifyBusy ||
      getRehearsalTask(verifyKey)?.status === "running"
    ) {
      return;
    }
    onEngageFocus?.();
    const effortVal = pick.current?.effort?.includes(aiOpts.pref.think)
      ? aiOpts.pref.think
      : undefined;
    const initialLive = createInitialLiveState(
      "verify",
      bi(
        "AI 正在对照预期判据核验此步执行结果",
        "AI is verifying step output against pass criteria",
      ),
      bi(
        "正在脱敏执行证据并核验是否通过，未通过将给出根因与修正方案…",
        "Redacting output & evaluating pass criteria or diagnosing issues...",
      ),
      pick.current,
    );
    const payload = {
      output: evidText,
      images:
        evidImages.length > 0
          ? evidImages.map((im) => im.dataUrl)
          : undefined,
      model: pick.ref || undefined,
      effort: effortVal,
    };
    const cid = c.id;
    const rid = rehearsalId;
    const sid = step.id;
    const stepNo = step.order || index;
    startRehearsalTask<LiveAIState, ChangeRehearsal>({
      key: verifyKey,
      kind: "verify",
      clusterId: cid,
      rehearsalId: rid,
      stepId: sid,
      initialLive,
      draft: {
        evidText,
        evidImages: [...evidImages],
      },
      run: (updateLive, signal) =>
        streamRehearsalAPI(`${baseUrl}/verify`, payload, updateLive, signal),
      markError: markLiveStateError,
      onSuccessPersist: (next) => {
        putCached(rehearsalItemPath(cid, next.id), next);
        window.dispatchEvent(
          new CustomEvent(REHEARSAL_CHANGED, {
            detail: { clusterId: cid, rehearsalId: next.id },
          }),
        );
      },
      onBackgroundDone: (next) => {
        const updatedStep = (next.steps || []).find((s) => s.id === sid);
        if (updatedStep?.status === "passed") {
          Message.success(
            bi(
              `${cid} 步骤 #${stepNo} AI 核验已通过`,
              `${cid} Step #${stepNo} verified PASSED by AI`,
            ),
          );
        } else {
          Message.warning(
            bi(
              `${cid} 步骤 #${stepNo} 未通过核验，请返回「变更演练」查看诊断`,
              `${cid} Step #${stepNo} failed verification — return to Rehearsals for diagnosis`,
            ),
          );
        }
      },
      onBackgroundError: () => {
        Message.error(
          bi(
            `${cid} 步骤 #${stepNo} AI 核验失败，请返回「变更演练」查看诊断`,
            `${cid} Step #${stepNo} verification failed — return to Rehearsals`,
          ),
        );
      },
    });
  };

  const applyProposal = async () => {
    if (offline || stepBusyRef.current) return;
    stepBusyRef.current = true;
    setBusy("apply");
    try {
      const next = await api<ChangeRehearsal>(`${baseUrl}/apply`, {
        method: "POST",
      });
      onUpdated(next);
      setEvidText("");
      Message.success(
        bi("已更新步骤命令，请在测试环境复测并贴回结果", "Step command updated; re-test and paste output"),
      );
    } catch (e) {
      err(e);
    } finally {
      stepBusyRef.current = false;
      setBusy("");
    }
  };

  const num = step.order || index;
  const canAskStepAI = Boolean(
    dock && !offline && dock.available(`step:rehearsal:${rehearsalId}:${step.id}`),
  );
  const openStepInAIDock = useCallback(() => {
    if (!dock) return;
    const key = `step:rehearsal:${rehearsalId}:${step.id}`;
    const stepMeta: Record<string, unknown> = {
      kind: "rehearsal_step",
      cluster_id: c.id,
      rehearsal_id: rehearsalId,
      rehearsal_title: rehearsalTitle || "",
      step_id: step.id,
      order: num,
      phase: step.phase,
      title: step.title,
      target_role: step.target_role,
      command: step.command,
      expect: step.expect,
      rollback: step.rollback || "",
      risk_note: step.risk_note || "",
      status: step.status,
      note: step.note || "",
    };
    if (step.last_error) stepMeta.last_error = step.last_error;
    if (step.proposal?.diagnosis) stepMeta.diagnosis = step.proposal.diagnosis;
    dock.open({
      key,
      title: bi(`演练步骤 #${num} · ${step.title}`, `Rehearsal #${num} · ${step.title}`),
      context: `${rehearsalTitle || rehearsalId} · ${c.id}`,
      step: stepMeta,
      hello: bi(
        `正在聚焦演练步骤 #${num}「${step.title}」。直接告诉我哪里有问题或想怎么调整（例如拆成两步、修改命令或目标机器、放宽/调整判据、删除冗余步），我会和你确认后给出「一键更新演练步骤」卡片。`,
        `Focused on rehearsal step #${num} "${step.title}". Tell me what looks off or how you want to change it (split steps, revise command/target host, adjust criteria), and I'll generate a 1-click update card.`,
      ),
    });
  }, [c.id, dock, num, rehearsalId, rehearsalTitle, step]);
  const statusInfo =
    step.status === "passed"
      ? { label: bi("实测通过", "Passed"), cls: "passed" }
      : step.status === "failed"
        ? { label: bi("执行受阻", "Blocked"), cls: "failed" }
        : step.status === "skipped"
          ? {
              label: isRollback
                ? bi("默认已跳过", "Auto-Skipped")
                : bi("已跳过", "Skipped"),
              cls: "skipped",
            }
          : isRollback
            ? {
                label: forwardDone
                  ? bi("默认已跳过 · 仅异常时执行", "Auto-Skipped · Emergency Only")
                  : bi("仅异常时执行 · 默认跳过", "Emergency Only · Auto-Skip"),
                cls: forwardDone ? "skipped" : "rollback-idle",
              }
            : { label: bi("待演练", "Pending"), cls: "pending" };

  const showStub = isDone && collapsed && !tearing;
  const stubNote =
    step.status === "skipped"
      ? step.note || bi("已跳过本步（点击可展开查看命令或重置）", "Skipped (click to expand or reset)")
      : step.note ||
        (step.verified_by_ai
          ? bi("AI 已核验通过（点击展开查看核验依据与命令）", "AI verified (click to inspect details)")
          : bi("已标记通过（点击展开查看命令或补充结论）", "Marked passed (click to inspect or add note)"));
  const roundCount = step.verify_history?.length || 0;

  return (
    <li
      data-step-id={step.id}
      className={`rh-step st-${step.status}${isRollback ? " is-rollback" : ""}${showStub ? " is-stub" : ""}${tearing ? " is-tearing" : ""}${justSettled ? " is-stub-settled" : ""}${isArrival ? " is-arrival-focus" : ""}${staggerIndex !== undefined ? " is-fresh-step" : ""}`}
      style={
        staggerIndex !== undefined
          ? ({ "--rh-stagger": staggerIndex } as React.CSSProperties)
          : undefined
      }
    >
      <span
        className={`rh-step-node st-${step.status}${isRollback ? " is-rollback" : ""}${tearing ? " is-stamp-pop" : ""}`}
        aria-hidden
      >
        {step.status === "passed" ? (
          <IconCheck />
        ) : step.status === "failed" ? (
          "!"
        ) : step.status === "skipped" ? (
          "–"
        ) : (
          <span className="num">{nodeLabel || num}</span>
        )}
      </span>

      <div className="rh-step-body">
        {showStub ? (
          <button
            type="button"
            className={`rh-step-stub is-${step.status}`}
            onClick={() => setCollapsed(false)}
            aria-expanded={false}
          >
            <div className="rh-step-stub-main">
              <div className="rh-step-stub-top">
                <span className={`rh-phase ph-${step.phase}`}>
                  {PHASE_LABEL[step.phase]}
                </span>
                <b className="rh-step-stub-title">{step.title}</b>
                {step.optional && (
                  <Tag size="small">{bi("可选", "Optional")}</Tag>
                )}
              </div>
              <p className="rh-step-stub-note">{stubNote}</p>
            </div>
            <div className="rh-step-stub-right">
              {roundCount > 1 && (
                <span className="rh-stub-rounds num">
                  {bi(`历 ${roundCount} 轮`, `${roundCount} rounds`)}
                </span>
              )}
              <span className={`rh-status-pill ${statusInfo.cls}`}>
                {step.status === "passed" && step.verified_by_ai && (
                  <Spark size={11} />
                )}
                {statusInfo.label}
              </span>
              <span className="rh-stub-expand">
                <span>{bi("展开详情", "Details")}</span>
                <IconDown />
              </span>
            </div>
          </button>
        ) : (
          <>
            <div className="rh-step-head">
              <div className="rh-step-title">
                <span className={`rh-phase ph-${step.phase}`}>
                  {PHASE_LABEL[step.phase]}
                </span>
                <b>{step.title}</b>
                {step.optional && (
                  <Tag size="small">{bi("可选", "Optional")}</Tag>
                )}
              </div>
              <div className="rh-step-head-right">
                {!editingCmd && !tearing && (
                  <button
                    type="button"
                    className="rh-code-btn"
                    onClick={() => {
                      setCmdDraft(step.command);
                      setSubCmdDrafts(
                        resolvedSubCmds.length > 1
                          ? resolvedSubCmds.map((s) => ({ ...s }))
                          : [],
                      );
                      setEditingCmd(true);
                    }}
                  >
                    <IconEdit />
                    <span>{bi("微调", "Edit")}</span>
                  </button>
                )}
                {canAskStepAI && !tearing && (
                  <button
                    type="button"
                    className="rh-code-btn is-ai"
                    onClick={openStepInAIDock}
                    title={bi(
                      "在右下角 AI 助手中讨论或对话修改此演练步骤",
                      "Discuss or modify this step with AI Assistant",
                    )}
                  >
                    <Spark size={12} />
                    <span>{bi("问 AI 修改", "Ask AI")}</span>
                  </button>
                )}
                {tearing && (
                  <span
                    className={`rh-tear-stamp is-${step.status}`}
                    aria-hidden
                  >
                    {step.status === "passed"
                      ? bi("✓ 已撕票完成", "✓ COMPLETED")
                      : bi("已跳过", "SKIPPED")}
                  </span>
                )}
                <span className={`rh-status-pill ${statusInfo.cls}`}>
                  {statusInfo.label}
                </span>
                {isDone && !tearing && (
                  <button
                    type="button"
                    className="rh-stub-collapse-btn"
                    onClick={() => setCollapsed(true)}
                  >
                    <span>{bi("收起存根", "Fold")}</span>
                    <IconUp />
                  </button>
                )}
              </div>
            </div>

            {tearing && (
              <div className="rh-tear-seam" aria-hidden>
                <span className="rh-tear-line" />
                <span className="rh-tear-spark" />
              </div>
            )}

            <div className={`rh-step-sheet-wrap${tearing ? " is-tearing" : ""}`}>
              <div className="rh-step-sheet">

        {step.target_role && (() => {
          const tr = step.target_role.trim();
          const tone = /集群外|跳板机|客户端|ELB|VIP/i.test(tr)
            ? "tone-external"
            : /从库|备库|备节点|standby|replica/i.test(tr) && !/主库|leader|primary/i.test(tr)
              ? "tone-replica"
              : /主库|leader|primary/i.test(tr) && !/所有|三台|全节点|逐台/i.test(tr)
                ? "tone-primary"
                : "";
          return (
            <div className={`rh-step-where ${tone}`.trim()}>
              <span className="rh-step-where-k">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden
                >
                  <rect
                    x="2"
                    y="2.5"
                    width="12"
                    height="8.5"
                    rx="1.6"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="M5.5 13.5h5M8 11v2.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
                {bi("执行机器", "Run On")}
              </span>
              <span className="rh-step-where-v">{tr}</span>
            </div>
          );
        })()}

        {editingCmd ? (() => {
          const saveSubDrafts = () => {
            const cleaned = subCmdDrafts
              .map((s) => ({
                label: (s.label || "").trim(),
                target_role: (s.target_role || "").trim() || undefined,
                command: (s.command || "").trim(),
                gate: (s.gate || "").trim() || undefined,
              }))
              .filter((s) => s.command.length > 0);
            if (cleaned.length === 0) {
              Message.warning(
                bi("请至少保留一条非空命令", "At least one non-empty command is required"),
              );
              return;
            }
            void patchStep({ commands: cleaned, status: "pending" });
          };
          const cancelEdit = () => {
            setCmdDraft(step.command);
            setSubCmdDrafts(
              resolvedSubCmds.length > 1
                ? resolvedSubCmds.map((s) => ({ ...s }))
                : [],
            );
            setEditingCmd(false);
          };

          if (subCmdDrafts.length > 1) {
            return (
              <div
                className="rh-cmd-edit"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    saveSubDrafts();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
              >
                <div className="rh-cmd-edit-stack">
                  {subCmdDrafts.map((sub, si) => (
                    <div key={si} className="rh-cmd-edit-card">
                      <div className="rh-cmd-edit-head">
                        <span className="rh-cmd-edit-idx num">
                          {bi(
                            `子命令 ${si + 1}/${subCmdDrafts.length}`,
                            `Block ${si + 1}/${subCmdDrafts.length}`,
                          )}
                        </span>
                        <Input
                          size="mini"
                          className="rh-cmd-edit-lbl"
                          value={sub.label || ""}
                          placeholder={bi(
                            "本段标题（如：查看日志路径与集群健康）",
                            "Block label (optional)",
                          )}
                          onChange={(v) =>
                            setSubCmdDrafts((prev) =>
                              prev.map((x, idx) =>
                                idx === si ? { ...x, label: v } : x,
                              ),
                            )
                          }
                        />
                        <Input
                          size="mini"
                          className="rh-cmd-edit-role"
                          value={sub.target_role || ""}
                          placeholder={bi("执行机器（选填）", "Run on (optional)")}
                          onChange={(v) =>
                            setSubCmdDrafts((prev) =>
                              prev.map((x, idx) =>
                                idx === si ? { ...x, target_role: v } : x,
                              ),
                            )
                          }
                        />
                        <Tooltip content={bi("移除本子命令段", "Remove block")} mini>
                          <Button
                            size="mini"
                            type="text"
                            status="danger"
                            icon={<IconDelete />}
                            onClick={() => {
                              const next = subCmdDrafts.filter((_, idx) => idx !== si);
                              if (next.length === 1) {
                                setCmdDraft(next[0].command);
                                setSubCmdDrafts([]);
                              } else {
                                setSubCmdDrafts(next);
                              }
                            }}
                          />
                        </Tooltip>
                      </div>
                      <Input.TextArea
                        value={sub.command}
                        onChange={(v) =>
                          setSubCmdDrafts((prev) =>
                            prev.map((x, idx) =>
                              idx === si ? { ...x, command: v } : x,
                            ),
                          )
                        }
                        autoSize={{ minRows: 2, maxRows: 10 }}
                        className="mono"
                        aria-label={bi(
                          `编辑子命令 ${si + 1}`,
                          `Edit sub-command ${si + 1}`,
                        )}
                      />
                      {si < subCmdDrafts.length - 1 && (
                        <Input
                          size="mini"
                          className="rh-cmd-edit-gate"
                          prefix={
                            <span className="rh-cmd-edit-gate-k">
                              {bi("段间核验", "Gate")}
                            </span>
                          }
                          value={sub.gate || ""}
                          placeholder={bi(
                            "选填：执行完本段后需要人工确认的条件再继续下一段",
                            "Optional pause-and-verify note before running next block",
                          )}
                          onChange={(v) =>
                            setSubCmdDrafts((prev) =>
                              prev.map((x, idx) =>
                                idx === si ? { ...x, gate: v } : x,
                              ),
                            )
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
                <div className="rh-cmd-edit-foot">
                  <Button
                    size="small"
                    icon={<IconPlus />}
                    onClick={() =>
                      setSubCmdDrafts((prev) => [
                        ...prev,
                        {
                          label: bi(
                            `第 ${prev.length + 1} 段`,
                            `Part ${prev.length + 1}`,
                          ),
                          command: "",
                        },
                      ])
                    }
                  >
                    {bi("新增子命令段", "Add Sub-Command")}
                  </Button>
                  <div className="row-gap">
                    <Button
                      size="small"
                      type="primary"
                      loading={busy === "patch"}
                      onClick={saveSubDrafts}
                    >
                      {bi("保存子命令", "Save Sub-Commands")}
                    </Button>
                    <Button size="small" onClick={cancelEdit}>
                      {bi("取消", "Cancel")}
                    </Button>
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div
              className="rh-cmd-edit"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void patchStep({ command: cmdDraft, status: "pending" });
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
            >
              <Input.TextArea
                value={cmdDraft}
                onChange={setCmdDraft}
                autoSize={{ minRows: 3, maxRows: 12 }}
                className="mono"
                aria-label={bi("编辑步骤命令", "Edit step command")}
              />
              <div className="rh-cmd-edit-foot">
                <Button
                  size="small"
                  icon={<IconPlus />}
                  onClick={() =>
                    setSubCmdDrafts([
                      {
                        label: bi("第 1 段", "Part 1"),
                        command: cmdDraft.trim(),
                      },
                      {
                        label: bi("第 2 段", "Part 2"),
                        command: "",
                      },
                    ])
                  }
                >
                  {bi("拆分为多段子命令", "Split into Sub-Commands")}
                </Button>
                <div className="row-gap">
                  <Button
                    size="small"
                    type="primary"
                    loading={busy === "patch"}
                    onClick={() =>
                      void patchStep({ command: cmdDraft, status: "pending" })
                    }
                  >
                    {bi("保存命令", "Save Command")}
                  </Button>
                  <Button size="small" onClick={cancelEdit}>
                    {bi("取消", "Cancel")}
                  </Button>
                </div>
              </div>
            </div>
          );
        })() : (() => {
          const subCmds = resolvedSubCmds;
          if (subCmds.length > 1) {
            return (
              <div className="rh-cmd-stack">
                {subCmds.map((sub, ci) => {
                  const subTitle = sub.label
                    ? bi(
                        `执行命令 ${ci + 1}/${subCmds.length} · ${sub.label}`,
                        `Command ${ci + 1}/${subCmds.length} · ${sub.label}`,
                      )
                    : bi(
                        `执行命令 ${ci + 1}/${subCmds.length}`,
                        `Command ${ci + 1}/${subCmds.length}`,
                      );
                  return (
                    <React.Fragment key={ci}>
                      <div className="rh-cmd-part">
                        {sub.target_role && (
                          <div className="rh-cmd-part-where">
                            {bi("本段执行机器：", "Run on: ")}
                            <span>{sub.target_role}</span>
                          </div>
                        )}
                        <ShellCodeBlock
                          code={sub.command}
                          title={subTitle}
                          compact
                          pasteSafe
                        />
                      </div>
                      {ci < subCmds.length - 1 && (
                        <div className="rh-cmd-gate" role="note">
                          <IconExclamationCircle />
                          <span>
                            {sub.gate ||
                              bi(
                                "暂停核验：确认上一段执行成功且节点恢复健康后，再复制执行下一段",
                                "Pause & verify: confirm the previous command succeeded and node is healthy before running the next block",
                              )}
                          </span>
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            );
          }
          return (
            <ShellCodeBlock
              code={step.command}
              title={bi("执行命令", "Command")}
              compact
              pasteSafe
            />
          );
        })()}

        <dl className="rh-step-facts">
          <div>
            <dt>{bi("预期判据", "Expected")}</dt>
            <dd>
              {step.expect ||
                bi("返回码为 0 且服务状态正常", "Exit code 0 & healthy service status")}
            </dd>
          </div>
          {step.risk_note && (
            <div>
              <dt>{bi("注意事项", "Caution")}</dt>
              <dd className="warn-ink">{step.risk_note}</dd>
            </div>
          )}
          {step.rollback && (
            <div>
              <dt>{bi("回退方式", "Rollback")}</dt>
              <dd className="mono">{step.rollback}</dd>
            </div>
          )}
        </dl>

        <Smooth>
          {(verifyOpen || step.proposal || step.trouble_trace || liveVerify) && (
            <div className="rh-drawer-stack">
              {verifyOpen && (
                <div
                  ref={verifyBoxRef}
                  className={`rh-step-verify ${offline ? "off" : ""} ${dragEvid ? "is-drag" : ""} ${verifyBusy ? "is-busy" : ""} ${verifyFlash ? "is-flash" : ""}`}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void askVerify();
                    }
                  }}
                  onDragOver={(e) => {
                    if (e.dataTransfer?.types?.includes("Files")) {
                      e.preventDefault();
                      if (!dragEvid) setDragEvid(true);
                    }
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setDragEvid(false);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragEvid(false);
                    if (e.dataTransfer?.files?.length) {
                      void attachEvidFiles(e.dataTransfer.files);
                    }
                  }}
                  onPaste={(e) => {
                    const imgs = extractClipboardImageFiles(e);
                    if (imgs.length > 0) {
                      if (!e.clipboardData?.getData("text/plain")) {
                        e.preventDefault();
                      }
                      void attachEvidFiles(imgs);
                    }
                  }}
                >
                  <div className="rh-step-verify-head">
                    <div className="rh-step-verify-title">
                      <Spark size={13} />
                      <b>{bi("回填执行结果", "Submit Step Output")}</b>
                      <span className="rh-step-verify-hint">
                        {(step.proposal?.verified_facts?.length || 0) > 0
                          ? bi(
                              `已自动记住前序证实的 ${step.proposal!.verified_facts!.length} 项达标事实，本轮只需贴剩余节点或补测结果`,
                              `${step.proposal!.verified_facts!.length} prior verified fact(s) remembered automatically; paste only the remaining item(s)`,
                            )
                          : bi(
                              "AI 对照预期判据自动判定通过，未通过则直接给出修正方案",
                              "AI judges pass/fail against expected criteria and proposes fixes on error",
                            )}
                      </span>
                    </div>
                    <div className="rh-step-manual-links">
                      <button
                        type="button"
                        disabled={busy === "patch" || verifyBusy}
                        className="rh-manual-link pass"
                        onClick={() => void patchStep({ status: "passed" })}
                      >
                        {isRollback
                          ? bi("标记回退已演练", "Mark Rollback Tested")
                          : bi("直接标记通过", "Mark Passed")}
                      </button>
                      {!isRollback && (
                        <button
                          type="button"
                          disabled={busy === "patch" || verifyBusy}
                          className="rh-manual-link"
                          onClick={() => void patchStep({ status: "skipped" })}
                        >
                          {bi("跳过", "Skip")}
                        </button>
                      )}
                      {!isActiveStep && (
                        <button
                          type="button"
                          className="rh-manual-link"
                          onClick={() => setVerifyOpen(false)}
                        >
                          {bi("收起", "Collapse")}
                        </button>
                      )}
                    </div>
                  </div>
                  <Input.TextArea
                    value={evidText}
                    disabled={verifyBusy}
                    onChange={setEvidText}
                    autoSize={{ minRows: 3, maxRows: 10 }}
                    className="mono rh-step-verify-area"
                    placeholder={bi(
                      "粘贴本步在测试机器上的完整终端输出，或直接按 Ctrl+V 粘贴终端结果截图（敏感信息自动脱敏）…",
                      "Paste terminal output from running this step, or press Ctrl+V to paste screenshots (secrets auto-redacted)…",
                    )}
                    aria-label={bi("步骤执行输出", "Step execution output")}
                  />
                  {(evidImages.length > 0 ||
                    (step.evidence_images && step.evidence_images.length > 0) ||
                    (step.error_images && step.error_images.length > 0)) && (
                    <div className="rh-compose-imgs">
                      <DraftImageStrip
                        images={evidImages}
                        onRemove={(imgId) =>
                          setEvidImages((prev) =>
                            prev.filter((x) => x.id !== imgId),
                          )
                        }
                      />
                      {step.evidence_images &&
                        step.evidence_images.length > 0 && (
                          <SavedImageGallery
                            clusterId={c.id}
                            rehearsalId={rehearsalId}
                            names={step.evidence_images}
                            label={bi("实测截图", "Verification Screenshots")}
                          />
                        )}
                      {step.error_images && step.error_images.length > 0 && (
                        <SavedImageGallery
                          clusterId={c.id}
                          rehearsalId={rehearsalId}
                          names={step.error_images}
                          label={bi("报错截图", "Error Screenshots")}
                        />
                      )}
                    </div>
                  )}
                  <div className="rh-trouble-foot">
                    <div className="rh-trouble-tools">
                      <input
                        ref={evidImgInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        multiple
                        hidden
                        onChange={(e) => {
                          if (e.target.files?.length) {
                            void attachEvidFiles(e.target.files);
                          }
                          e.target.value = "";
                        }}
                      />
                      <button
                        type="button"
                        className="rh-attach-btn is-sm"
                        disabled={verifyBusy || noVision}
                        title={
                          noVision
                            ? bi(
                                "当前所选模型不支持图片识别，可切换支持看图的模型",
                                "Selected model does not support images; switch to a vision model",
                              )
                            : bi(
                                "上传或直接 Ctrl+V 粘贴执行结果截图",
                                "Upload or Ctrl+V paste output screenshots",
                              )
                        }
                        onClick={() => evidImgInputRef.current?.click()}
                      >
                        <IconImage />
                        <span>{bi("上传/粘贴截图", "Upload / Paste Image")}</span>
                      </button>
                      <Upload
                        accept=".log,.txt,.out,.json"
                        showUploadList={false}
                        disabled={verifyBusy}
                        beforeUpload={(file) => {
                          void attachEvidFiles([file]);
                          return false;
                        }}
                      >
                        <button
                          type="button"
                          className="rh-attach-btn is-sm"
                          disabled={verifyBusy}
                        >
                          <IconUpload />
                          <span>{bi("上传 .log / .txt", "Upload .log / .txt")}</span>
                        </button>
                      </Upload>
                      <span className="rh-foot-note">
                        {isMac
                          ? bi("⌘ + Enter AI 核验", "⌘ + Enter Verify")
                          : bi("Ctrl + Enter AI 核验", "Ctrl + Enter Verify")}
                      </span>
                    </div>
                    <div className="rh-compose-submit">
                      <ThinkLevel
                        levels={pick.current?.effort}
                        value={aiOpts.pref.think}
                        onChange={(v) => aiOpts.update({ think: v })}
                        compact
                      />
                      <ModelPicker pick={pick} compact />
                      <Button
                        size="small"
                        type="primary"
                        shape="round"
                        className={`ai-pill ${hasEvidInput && !offline ? "ai-pill-primary" : ""}`}
                        icon={
                          <Spark
                            size={13}
                            rainbow={!hasEvidInput || offline}
                          />
                        }
                        loading={verifyBusy}
                        disabled={!hasEvidInput || offline}
                        onClick={() => void askVerify()}
                      >
                        {bi("AI 核验结果", "AI Verify Output")}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {liveVerify && (
                <RehearsalAIProcess
                  live={liveVerify}
                  title={liveVerify.title}
                  onAbort={() => abortRehearsalTask(verifyKey)}
                  onRetry={() => void askVerify()}
                  onDismiss={() => clearRehearsalTask(verifyKey)}
                />
              )}

              {!liveVerify && step.trouble_trace && (
                <RehearsalAIProcess
                  trace={step.trouble_trace}
                  title={
                    step.status === "passed"
                      ? bi("AI 核验通过依据", "AI Verification Reasoning")
                      : bi("AI 核验与根因诊断过程", "AI Verification & Root Cause")
                  }
                  defaultOpen={freshVerify}
                />
              )}

              {step.proposal && (
                <div
                  className={`rh-proposal${freshVerify ? " is-fresh-proposal" : ""}`}
                >
                  <div className="rh-proposal-head">
                    <b>
                      <Spark size={14} rainbow />{" "}
                      {step.proposal.action === "insert_before"
                        ? bi(
                            `建议插入前置步骤：${step.proposal.title || "前置准备"}`,
                            `Insert prerequisite step: ${step.proposal.title || "Prerequisite"}`,
                          )
                        : step.proposal.action === "retry"
                          ? bi("核验未通过 · 复测建议", "Verification Failed · Retry Guidance")
                          : bi("核验未通过 · 建议更新此步命令", "Verification Failed · Update Command")}
                    </b>
                  </div>
                  <div className="rh-proposal-diag">
                    <RehearsalThinkingContent
                      text={step.proposal.diagnosis}
                      compact
                    />
                  </div>
                  {((step.proposal.verified_facts &&
                    step.proposal.verified_facts.length > 0) ||
                    (step.proposal.missing_items &&
                      step.proposal.missing_items.length > 0)) && (
                    <div className="rh-vmem-grid">
                      {step.proposal.verified_facts &&
                        step.proposal.verified_facts.length > 0 && (
                          <div className="rh-vmem-row is-ok">
                            <span className="rh-vmem-k">
                              {bi(
                                "已证实（下轮自动沿用，无需重贴）",
                                "Already verified (carried forward)",
                              )}
                            </span>
                            <div className="rh-vmem-chips">
                              {step.proposal.verified_facts.map((vf, i) => (
                                <span key={i} className="rh-vmem-chip is-ok">
                                  <IconCheck />
                                  <span>{vf}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      {step.proposal.missing_items &&
                        step.proposal.missing_items.length > 0 && (
                          <div className="rh-vmem-row is-miss">
                            <span className="rh-vmem-k">
                              {bi("仅需补传以下剩余项", "Remaining item(s) only")}
                            </span>
                            <div className="rh-vmem-chips">
                              {step.proposal.missing_items.map((mi, i) => (
                                <span key={i} className="rh-vmem-chip is-miss">
                                  {mi}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                    </div>
                  )}
                  {(() => {
                    const propRole =
                      (step.proposal.target_role || "").trim() ||
                      (step.target_role || "").trim();
                    if (!propRole) return null;
                    const tone = /集群外|跳板机|客户端|ELB|VIP/i.test(propRole)
                      ? "tone-external"
                      : /从库|备库|备节点|standby|replica/i.test(propRole) &&
                          !/主库|leader|primary/i.test(propRole)
                        ? "tone-replica"
                        : /主库|leader|primary/i.test(propRole) &&
                            !/所有|三台|全节点|逐台/i.test(propRole)
                          ? "tone-primary"
                          : "";
                    return (
                      <div className={`rh-step-where ${tone}`.trim()}>
                        <span className="rh-step-where-k">
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 16 16"
                            fill="none"
                            aria-hidden
                          >
                            <rect
                              x="2"
                              y="2.5"
                              width="12"
                              height="8.5"
                              rx="1.6"
                              stroke="currentColor"
                              strokeWidth="1.4"
                            />
                            <path
                              d="M5.5 13.5h5M8 11v2.5"
                              stroke="currentColor"
                              strokeWidth="1.4"
                              strokeLinecap="round"
                            />
                          </svg>
                          {step.proposal.action === "retry"
                            ? bi("复测执行机器", "Retry On")
                            : bi("执行机器", "Run On")}
                        </span>
                        <span className="rh-step-where-v">{propRole}</span>
                      </div>
                    );
                  })()}
                  {step.proposal.command &&
                    (editingProposalCmd ? (
                      <div
                        className="rh-cmd-edit-card rh-prop-cmd-edit"
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                            e.preventDefault();
                            if (!proposalCmdDraft.trim()) {
                              Message.warning(
                                bi("建议命令不能为空", "Command cannot be empty"),
                              );
                              return;
                            }
                            void patchStep({
                              proposal_command: proposalCmdDraft,
                              proposal_target_role: proposalRoleDraft,
                            });
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setProposalCmdDraft(step.proposal?.command || "");
                            setProposalRoleDraft(
                              step.proposal?.target_role || "",
                            );
                            setEditingProposalCmd(false);
                          }
                        }}
                      >
                        <div className="rh-cmd-edit-head">
                          <span className="rh-cmd-edit-idx">
                            {step.proposal.action === "retry"
                              ? bi("微调建议复测命令", "Edit Recommended Command")
                              : bi("微调修正后命令", "Edit Revised Command")}
                          </span>
                          <Input
                            size="small"
                            className="rh-cmd-edit-lbl"
                            value={proposalRoleDraft}
                            onChange={setProposalRoleDraft}
                            placeholder={
                              step.proposal.action === "retry"
                                ? bi(
                                    "复测执行机器（选填，如：在 node-2 上执行）",
                                    "Retry target host (optional)",
                                  )
                                : bi(
                                    "执行机器（选填）",
                                    "Target host (optional)",
                                  )
                            }
                            aria-label={bi(
                              "微调建议执行机器",
                              "Edit recommended target host",
                            )}
                          />
                        </div>
                        <Input.TextArea
                          value={proposalCmdDraft}
                          onChange={setProposalCmdDraft}
                          autoSize={{ minRows: 2, maxRows: 10 }}
                          className="mono"
                          aria-label={bi(
                            "微调建议复测命令",
                            "Edit recommended command",
                          )}
                        />
                        <div className="rh-cmd-edit-foot">
                          <span className="rh-cmd-edit-hint">
                            {bi(
                              "可直接微调端口、主机或参数后保存复制（Ctrl/⌘+Enter 保存）",
                              "Adjust host, port, or flags and save to copy (Ctrl/⌘+Enter)",
                            )}
                          </span>
                          <div className="row-gap">
                            <Button
                              size="small"
                              type="primary"
                              loading={busy === "patch"}
                              onClick={() => {
                                if (!proposalCmdDraft.trim()) {
                                  Message.warning(
                                    bi(
                                      "建议命令不能为空",
                                      "Command cannot be empty",
                                    ),
                                  );
                                  return;
                                }
                                void patchStep({
                                  proposal_command: proposalCmdDraft,
                                  proposal_target_role: proposalRoleDraft,
                                });
                              }}
                            >
                              {bi("保存微调", "Save")}
                            </Button>
                            <Button
                              size="small"
                              onClick={() => {
                                setProposalCmdDraft(
                                  step.proposal?.command || "",
                                );
                                setProposalRoleDraft(
                                  step.proposal?.target_role || "",
                                );
                                setEditingProposalCmd(false);
                              }}
                            >
                              {bi("取消", "Cancel")}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <ShellCodeBlock
                        code={step.proposal.command}
                        title={
                          step.proposal.action === "retry"
                            ? bi("建议复测命令", "Recommended Command")
                            : bi("修正后命令", "Revised Command")
                        }
                        compact
                        pasteSafe
                        onEdit={() => {
                          setProposalCmdDraft(step.proposal?.command || "");
                          setProposalRoleDraft(
                            step.proposal?.target_role || "",
                          );
                          setEditingProposalCmd(true);
                        }}
                      />
                    ))}
                  <div className="row-gap">
                    {step.proposal.action !== "retry" ? (
                      <Button
                        size="small"
                        type="primary"
                        icon={<IconCheck />}
                        loading={busy === "apply"}
                        onClick={() => void applyProposal()}
                      >
                        {bi("采纳并重新验证", "Accept & Re-test")}
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        type="outline"
                        onClick={() => focusVerifyBox(true)}
                      >
                        {bi("处理后重新贴回结果", "Clear & Re-submit Output")}
                      </Button>
                    )}
                    {canAskStepAI && (
                      <Button
                        size="small"
                        type="text"
                        icon={<Spark size={12} />}
                        onClick={openStepInAIDock}
                      >
                        {bi("找 AI 对话修改此步", "Discuss / Edit with AI")}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </Smooth>

        {(step.verify_history || []).length > 0 && (() => {
          const hist = step.verify_history!;
          const failCount = hist.filter((h) => h.verdict !== "passed").length;
          const summaryLabel =
            failCount > 0 && step.status === "passed"
              ? bi(
                  `核验历史（共 ${hist.length} 轮 · 曾未通过 ${failCount} 轮）`,
                  `Verification history (${hist.length} rounds · ${failCount} failed)`,
                )
              : failCount > 0
                ? bi(
                    `核验历史（已核验 ${hist.length} 轮 · 未通过 ${failCount} 轮）`,
                    `Verification history (${hist.length} rounds · ${failCount} failed)`,
                  )
                : bi(
                    `核验历史（共 ${hist.length} 轮）`,
                    `Verification history (${hist.length} round${hist.length > 1 ? "s" : ""})`,
                  );
          return (
            <details className="rh-vhist">
              <summary>
                <span className="rh-vhist-sum-title">{summaryLabel}</span>
                {failCount > 0 && (
                  <span className="rh-vhist-sum-fail num">
                    {bi(`${failCount} 次未通过`, `${failCount} failed`)}
                  </span>
                )}
              </summary>
              <ol className="rh-vhist-list">
                {hist.map((att, idx) => {
                  const passed = att.verdict === "passed";
                  return (
                    <li
                      key={`${att.round}-${att.at}-${idx}`}
                      className={`rh-vhist-item ${passed ? "is-pass" : "is-fail"}`}
                    >
                      <div className="rh-vhist-head">
                        <span className="rh-vhist-round num">
                          {bi(`第 ${att.round || idx + 1} 轮`, `Round ${att.round || idx + 1}`)}
                        </span>
                        <span
                          className={`rh-vhist-verdict ${passed ? "is-pass" : "is-fail"}`}
                        >
                          {passed
                            ? bi("核验通过", "Passed")
                            : bi("未通过", "Failed")}
                        </span>
                        {att.model && (
                          <span className="rh-vhist-model mono">{att.model}</span>
                        )}
                        {att.at && (
                          <span className="rh-vhist-time num">{ago(att.at)}</span>
                        )}
                      </div>
                      {(att.summary || att.diagnosis) && (
                        <p className="rh-vhist-msg">
                          {att.summary || att.diagnosis}
                        </p>
                      )}
                      {att.verified_facts && att.verified_facts.length > 0 && (
                        <div className="rh-vmem-chips is-compact">
                          {att.verified_facts.map((vf, vi) => (
                            <span key={vi} className="rh-vmem-chip is-ok">
                              <IconCheck />
                              <span>{vf}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {att.fix_command && (
                        <div className="rh-vhist-cmd">
                          <span className="rh-vhist-cmd-k">
                            {bi("当时建议命令", "Suggested command")}
                            {att.target_role ? ` · ${att.target_role}` : ""}
                          </span>
                          <pre className="mono">{att.fix_command}</pre>
                        </div>
                      )}
                      {att.output && (
                        <details className="rh-vhist-out">
                          <summary>{bi("查看当时回传输出", "View submitted output")}</summary>
                          <pre className="mono">{att.output}</pre>
                        </details>
                      )}
                      {att.images && att.images.length > 0 && (
                        <div className="rh-vhist-imgs">
                          <SavedImageGallery
                            clusterId={c.id}
                            rehearsalId={rehearsalId}
                            names={att.images}
                            label={bi(
                              `第 ${att.round || idx + 1} 轮截图`,
                              `Round ${att.round || idx + 1} screenshots`,
                            )}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </details>
          );
        })()}

        {(step.revisions || []).length > 0 && (
          <details className="rh-rev-log">
            <summary>
              {bi(
                `已打磨修订 ${step.revisions!.length} 次`,
                `Revised ${step.revisions!.length} time(s)`,
              )}
            </summary>
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

        {!verifyOpen &&
          (step.status === "passed" || step.status === "skipped" ? (
            <div className={`rh-step-verified-bar is-${step.status}`}>
              <div className="rh-step-verified-main">
                <span className="rh-step-verified-badge">
                  {step.status === "passed" ? (
                    step.verified_by_ai ? (
                      <>
                        <Spark size={12} />{" "}
                        {(step.verify_history?.length || 0) > 1
                          ? bi(
                              `AI 核验通过 · 历 ${step.verify_history!.length} 轮`,
                              `AI Verified · ${step.verify_history!.length} rounds`,
                            )
                          : bi("AI 核验通过", "AI Verified")}
                      </>
                    ) : (
                      <>
                        <IconCheck /> {bi("已标记通过", "Marked Passed")}
                      </>
                    )
                  ) : (
                    bi("已跳过", "Skipped")
                  )}
                </span>
                {editingNote ? (
                  <div className="rh-step-note-edit">
                    <Input
                      size="small"
                      value={note}
                      onChange={setNote}
                      autoFocus
                      onPressEnter={() => void patchStep({ note })}
                      onBlur={() => {
                        if (note !== (step.note || "")) {
                          void patchStep({ note });
                        } else {
                          setEditingNote(false);
                        }
                      }}
                      placeholder={bi("补充实测说明（同步写入 SOP）", "Verification note (synced into SOP)")}
                    />
                  </div>
                ) : (
                  <span
                    className="rh-step-verified-note"
                    onClick={() => setEditingNote(true)}
                    title={bi("点击编辑实测结论", "Click to edit note")}
                  >
                    {step.note ||
                      bi("点击补充实测结论（同步写入生产实施方案）", "Click to add note for Production SOP")}
                  </span>
                )}
              </div>
              <div className="rh-step-manual-links">
                <button
                  type="button"
                  className="rh-manual-link"
                  onClick={() => focusVerifyBox(false)}
                >
                  {bi("补充输出 / 复测", "Re-verify")}
                </button>
                <button
                  type="button"
                  disabled={busy === "patch"}
                  className="rh-manual-link"
                  onClick={() => void patchStep({ status: "pending" })}
                >
                  {bi("重置", "Reset")}
                </button>
              </div>
              {step.evidence_images && step.evidence_images.length > 0 && (
                <div className="rh-step-verified-imgs">
                  <SavedImageGallery
                    clusterId={c.id}
                    rehearsalId={rehearsalId}
                    names={step.evidence_images}
                    label={bi("已留存核验截图", "Saved Verification Screenshots")}
                  />
                </div>
              )}
            </div>
          ) : (
            <div
              className="rh-step-verify-bar"
              onClick={() => setVerifyOpen(true)}
              onPaste={(e) => {
                const imgs = extractClipboardImageFiles(e);
                if (imgs.length > 0) {
                  e.preventDefault();
                  void attachEvidFiles(imgs);
                }
              }}
            >
              <div className="rh-step-verify-bar-prompt">
                <IconImage />
                <span>
                  {isRollback
                    ? bi(
                        "正常变更无需执行也无需点跳过；仅在演练回退或触发应急回滚时，点击此处贴回输出核验…",
                        "Auto-skipped on normal success; click here only if rehearsing or executing rollback…",
                      )
                    : bi(
                        "点击贴入终端执行输出，或直接 Ctrl+V 粘贴结果截图，由 AI 自动核验是否通过…",
                        "Click to paste terminal output or Ctrl+V a screenshot for AI verification…",
                      )}
                </span>
              </div>
              <div
                className="rh-step-actions"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="rh-act-btn trouble"
                  onClick={() => setVerifyOpen(true)}
                >
                  <Spark size={13} />
                  <span>{bi("AI 核验", "AI Verify")}</span>
                </button>
                <button
                  type="button"
                  disabled={busy === "patch"}
                  className="rh-act-btn pass"
                  onClick={() => void patchStep({ status: "passed" })}
                >
                  <IconCheck />
                  <span>
                    {isRollback
                      ? bi("标记已演练", "Tested")
                      : bi("直接通过", "Pass")}
                  </span>
                </button>
                {!isRollback && (
                  <button
                    type="button"
                    disabled={busy === "patch"}
                    className="rh-act-btn skip"
                    onClick={() => void patchStep({ status: "skipped" })}
                  >
                    <span>{bi("跳过", "Skip")}</span>
                  </button>
                )}
              </div>
            </div>
          ))}
              </div>
            </div>
          </>
        )}
      </div>
    </li>
  );
});

function RehearsalSecurityBanner({
  clusterId,
  rehearsal,
  onUpdated,
}: {
  clusterId: string;
  rehearsal: ChangeRehearsal;
  onUpdated: (next: ChangeRehearsal) => void;
}) {
  const sc = rehearsal.security_context;
  const [modalOpen, setModalOpen] = useState(false);
  const [vexStatus, setVexStatus] = useState<string>(
    rehearsal.stage === "finalized" ? "mitigated" : "not_affected",
  );
  const [vexNote, setVexNote] = useState("");
  const [busy, setBusy] = useState(false);
  const vexBusyRef = useRef(false);

  if (!sc) return null;

  const canSyncVex =
    can("security.manage") && Boolean(sc.cves && sc.cves.length > 0);

  const openModal = (preset?: string) => {
    const nextStatus =
      preset || (rehearsal.stage === "finalized" ? "mitigated" : "not_affected");
    setVexStatus(nextStatus);
    if (nextStatus === "not_affected") {
      setVexNote(
        bi(
          `经集群 ${clusterId} 只读探针核实，当前生产环境未启用该漏洞对应的脆弱模块或已处于修复版本（演练 ${rehearsal.id}）。`,
          `Verified via read-only probe on ${clusterId}: vulnerable feature is disabled or fixed version is already deployed (rehearsal ${rehearsal.id}).`,
        ),
      );
    } else if (rehearsal.doc_id) {
      setVexNote(
        bi(
          `已通过集群 ${clusterId} 安全修复演练「${rehearsal.title}」完成测试环境验证，并固化生产 SOP（${rehearsal.doc_id}）。`,
          `Validated in staging via security rehearsal "${rehearsal.title}" on ${clusterId} with finalized SOP (${rehearsal.doc_id}).`,
        ),
      );
    } else {
      setVexNote(
        bi(
          `已在集群 ${clusterId} 启动安全修复演练「${rehearsal.title}」并排期处理。`,
          `Scheduled security remediation rehearsal "${rehearsal.title}" on ${clusterId}.`,
        ),
      );
    }
    setModalOpen(true);
  };

  const submitSyncVex = async () => {
    if (vexBusyRef.current) return;
    vexBusyRef.current = true;
    setBusy(true);
    try {
      const res = await api<{ rehearsal: ChangeRehearsal; updated: number }>(
        `/api/clusters/${encodeURIComponent(clusterId)}/rehearsals/${encodeURIComponent(rehearsal.id)}/sync-vex`,
        {
          method: "POST",
          body: JSON.stringify({
            status: vexStatus,
            note: vexNote.trim(),
            justification:
              vexStatus === "not_affected"
                ? "vulnerable_code_not_in_execute_path"
                : "rehearsal_verified",
          }),
        },
      );
      onUpdated(res.rehearsal);
      Message.success(
        bi(
          `已回写 ${res.updated} 条 CVE 的 VEX 状态并关联本演练`,
          `Synced VEX status for ${res.updated} CVE(s)`,
        ),
      );
      setModalOpen(false);
    } catch (e) {
      err(e);
    } finally {
      vexBusyRef.current = false;
      setBusy(false);
    }
  };

  const kindText =
    sc.kind === "cve_patch"
      ? bi("安全修复 · 漏洞补丁升级", "Security · CVE Patch")
      : sc.kind === "cert_rotation"
        ? bi("安全修复 · TLS 证书轮换", "Security · Cert Rotation")
        : bi("安全修复 · 配置基线加固", "Security · Config Hardening");

  const vexLabelMap: Record<string, string> = {
    planned: bi("已排期", "Planned"),
    mitigated: bi("已缓解", "Mitigated"),
    not_affected: bi("不受影响", "Not affected"),
    accepted: bi("风险豁免", "Accepted"),
  };

  return (
    <>
      <div className="rh-sec-banner">
        <div className="rh-sec-banner-main">
          <div className="rh-sec-banner-row">
            <span className="rh-sec-ctx-tag">{kindText}</span>
            {sc.package && (
              <span className="mono rh-sec-ctx-ver">
                {sc.package}
                {sc.current_version ? ` ${sc.current_version}` : ""}
                {sc.target_version ? ` → ${sc.target_version}` : ""}
              </span>
            )}
            {sc.repo_fix_ready && (
              <span className="rh-sec-ctx-ok">
                {bi("源已有修复版", "Fix in repo")}
              </span>
            )}
            {sc.cert_target && (
              <span className="mono rh-sec-ctx-ver">{sc.cert_target}</span>
            )}
            {sc.vex_synced && (
              <span className="rh-sec-ctx-ok">
                {bi(
                  `已回写 VEX：${vexLabelMap[sc.vex_status || ""] || sc.vex_status || ""}`,
                  `VEX Synced: ${vexLabelMap[sc.vex_status || ""] || sc.vex_status || ""}`,
                )}
              </span>
            )}
          </div>
          {sc.cves && sc.cves.length > 0 && (
            <div className="rh-sec-ctx-cves">
              {sc.cves.slice(0, 10).map((id) => (
                <span key={id} className="mono rh-sec-ctx-cve">
                  {id}
                </span>
              ))}
              {sc.cves.length > 10 && (
                <span className="faint small">+{sc.cves.length - 10}</span>
              )}
            </div>
          )}
        </div>
        <div className="rh-sec-banner-actions">
          <Button
            size="mini"
            type="secondary"
            onClick={() =>
              go({ name: "deliveries", id: clusterId, tab: "security" })
            }
          >
            {bi("集群安全页", "Cluster Security")}
          </Button>
          {canSyncVex && (
            <Button
              size="mini"
              type={rehearsal.stage === "finalized" && !sc.vex_synced ? "primary" : "outline"}
              onClick={() => openModal()}
            >
              {sc.vex_synced
                ? bi("更新 VEX 状态", "Update VEX")
                : rehearsal.stage === "finalized"
                  ? bi("回写 VEX 并关联 SOP", "Sync VEX & Link SOP")
                  : bi("依据探针回写 VEX", "Sync VEX from Probe")}
            </Button>
          )}
        </div>
      </div>

      <Modal
        visible={modalOpen}
        title={bi("回写安全中心 VEX 处置状态", "Sync VEX Status to Security Center")}
        onCancel={() => !busy && setModalOpen(false)}
        onOk={() => void submitSyncVex()}
        confirmLoading={busy}
        okText={bi("确认回写", "Sync VEX")}
        cancelText={bi("取消", "Cancel")}
        style={{ width: 580, maxWidth: "94vw" }}
      >
        <div className="rh-vex-form">
          <p className="muted small" style={{ marginTop: 0, marginBottom: 4 }}>
            {bi(
              `将为本次演练关联的 ${sc.cves?.length || 0} 条 CVE 同步更新 VEX 状态，并自动记录演练编号${rehearsal.doc_id ? `与生产 SOP（${rehearsal.doc_id}）` : ""}作为审计证据。`,
              `Updates VEX status for ${sc.cves?.length || 0} linked CVE(s) and attaches this rehearsal${rehearsal.doc_id ? ` and SOP (${rehearsal.doc_id})` : ""} as audit evidence.`,
            )}
          </p>
          <VexTriageEditor
            context={{
              kind: "vex",
              cves: sc.cves,
              package: sc.package,
              ecosystem: sc.ecosystem,
              installed_version: sc.current_version,
              fixed_in: sc.target_version ? [sc.target_version] : [],
              cluster_id: clusterId,
            }}
            status={vexStatus}
            onStatusChange={setVexStatus}
            note={vexNote}
            onNoteChange={setVexNote}
            includeOpen={false}
            showContextCard={false}
            showJustification={false}
            showExpires={false}
          />
        </div>
      </Modal>
    </>
  );
}

/* ---------- Production Completion & Cluster Sync Card / Modal ---------- */

const HBA_RULE_RE =
  /\b((?:hostssl|hostnossl|hostgssenc|hostnogssenc|host|local)\s+[a-zA-Z0-9_,.-]+\s+[a-zA-Z0-9_,.-]+(?:\s+[0-9a-fA-F.:/]+(?:\s+[0-9.]+)?)?\s+(?:scram-sha-256|md5|trust|reject|peer|ident|cert|ldap|radius|pam|password))\b/i;

function extractHBARuleClient(r: ChangeRehearsal, stepCmd: string, stepNote?: string, stepTitle?: string): string {
  for (const src of [stepCmd, stepNote || "", r.goal || "", r.title || ""]) {
    const m = src.match(HBA_RULE_RE);
    if (m?.[1]) {
      const rule = m[1].replace(/\s+/g, " ").trim();
      const low = `${r.title || ""} ${stepTitle || ""}`.toLowerCase();
      const prefix =
        /删除|移除|\b(?:remove|delete|revoke)\b/.test(low) ? "- " : "+ ";
      return `${prefix}${rule}`.slice(0, 120);
    }
  }
  return (r.title || stepTitle || "更新访问控制规则").trim().slice(0, 100);
}

function suggestAppliedChangesClient(
  r: ChangeRehearsal,
): { summary: string; changes: RehearsalAppliedChange[] } {
  const execNotes = (r.steps || [])
    .filter((s) => s.phase === "execute" && s.status === "passed" && s.note?.trim())
    .map((s) => s.note!.trim().replace(/[。；;\s]+$/, ""))
    .filter(Boolean);
  const joinedNotes = execNotes.length > 0 ? `${execNotes.join("；")}。` : "";
  const rawScope = (r.scope_summary || "").trim();
  const isProbeCopy = /探针|不改变任何生产配置|只读采集|read-only probe/i.test(rawScope);
  const summary = (
    r.applied_summary ||
    joinedNotes ||
    (!isProbeCopy ? rawScope : "") ||
    r.title ||
    r.goal ||
    ""
  )
    .trim()
    .slice(0, 260);
  if (r.applied_changes && r.applied_changes.length > 0) {
    return { summary, changes: r.applied_changes.map((x) => ({ ...x })) };
  }
  const beforeMap = new Map<string, string>();
  let hbaBefore = "";
  for (const p of r.drift?.param_diffs || []) {
    const k = (p.key || "").trim();
    const v = (p.actual || p.initial || "").trim();
    if (k && v) {
      const lk = k.toLowerCase();
      beforeMap.set(lk, v.slice(0, 80));
      if (!hbaBefore && lk.includes("pg_hba")) hbaBefore = v.slice(0, 80);
    }
  }
  if (hbaBefore && !beforeMap.has("pg_hba")) {
    beforeMap.set("pg_hba", hbaBefore);
  }
  const out: RehearsalAppliedChange[] = [];
  const seen = new Set<string>();
  const add = (key: string, before: string, after: string, note = "") => {
    const k = key.trim().slice(0, 64);
    const a = after.trim().slice(0, 120);
    if (!k || !a || out.length >= 12) return;
    const lk = k.toLowerCase();
    if (seen.has(lk)) return;
    seen.add(lk);
    out.push({
      key: k,
      before: (before.trim() || beforeMap.get(lk) || "").slice(0, 80),
      after: a,
      ...(note.trim() ? { note: note.trim().slice(0, 120) } : {}),
    });
  };
  if (r.security_context?.package && r.security_context?.target_version) {
    add(
      r.security_context.package,
      r.security_context.current_version || "",
      r.security_context.target_version,
      (r.security_context.cves || []).slice(0, 3).join(", "),
    );
  }
  const patroniRe =
    /(?:^|\s)-[ps]\s+(?:'([a-zA-Z0-9_.-]+)=([^']+)'|"([a-zA-Z0-9_.-]+)=([^"]+)"|([a-zA-Z0-9_.-]+)=(?:'([^']+)'|"([^"]+)"|([^\s'"\\]+)))/gi;
  const alterRe =
    /\bALTER\s+SYSTEM\s+SET\s+([a-zA-Z0-9_.-]+)\s*(?:=|TO)\s*'?([^';\n]+)'?/gi;
  const redisRe = /\bCONFIG\s+SET\s+([a-zA-Z0-9_.-]+)\s+([^\s'"\n;]+)/gi;
  for (const st of r.steps || []) {
    if (st.phase !== "execute" || st.status === "skipped") continue;
    const cmd = st.command || "";
    for (const m of cmd.matchAll(patroniRe)) {
      const k = m[1] || m[3] || m[5] || "";
      const v = m[2] || m[4] || m[6] || m[7] || m[8] || "";
      if (k && v) add(k, "", v);
    }
    for (const m of cmd.matchAll(alterRe)) add(m[1], "", m[2]);
    for (const m of cmd.matchAll(redisRe)) add(m[1], "", m[2]);
    if (/\b(pg_hba|hostssl\s+\S+|hostnossl\s+\S+|host\s+\S+)/i.test(cmd)) {
      add("pg_hba", "", extractHBARuleClient(r, cmd, st.note, st.title));
    }
  }
  return { summary, changes: out };
}

function extractRehearsalTopicKeysClient(r: ChangeRehearsal): Map<string, string> {
  const keys = new Map<string, string>();
  const add = (k: string) => {
    const t = k.trim();
    if (!t) return;
    const lk = t.toLowerCase();
    if (!keys.has(lk)) keys.set(lk, t);
  };
  const srcChanges =
    r.applied_changes && r.applied_changes.length > 0
      ? r.applied_changes
      : suggestAppliedChangesClient(r).changes;
  for (const ch of srcChanges) add(ch.key || "");
  const execCmd = (r.steps || [])
    .filter((s) => s.phase === "execute" && s.status !== "skipped")
    .map((s) => s.command || "")
    .join("\n");
  const low = execCmd.toLowerCase();
  if (/\b(pg_hba|hostssl\s+\S+|hostnossl\s+\S+|host\s+\S+)/i.test(execCmd)) {
    add("pg_hba");
  }
  if (low.includes("haproxy.cfg")) add("haproxy.cfg");
  if (low.includes("nginx.conf") || low.includes("stream.d")) add("nginx配置");
  if (keys.size === 0 && (low.includes("patroni.yml") || low.includes("edit-config"))) {
    add("Patroni DCS配置");
  }
  return keys;
}

export type EffectiveClusterChange = {
  key: string;
  before?: string;
  after: string;
  note?: string;
  source_id: string;
  source_title: string;
  source_doc_id?: string;
  applied_at: string;
  applied_by?: string;
  update_count: number;
};

/**
 * Folds all applied (non-voided) rehearsals chronologically so every parameter/config key
 * shows its latest effective value while preserving earliest `before`, update count, and
 * a `latestByKey` lookup to mark superseded historical deltas.
 */
export function computeEffectiveClusterChanges(
  rehearsals: ChangeRehearsal[] | null | undefined,
): {
  items: EffectiveClusterChange[];
  latestByKey: Map<string, EffectiveClusterChange>;
} {
  const applied = (rehearsals || [])
    .filter((r) => r && r.stage === "finalized" && r.applied && !r.voided)
    .slice()
    .sort((a, b) => {
      const ta = a.applied_at || a.updated_at || a.created_at || "";
      const tb = b.applied_at || b.updated_at || b.created_at || "";
      if (ta !== tb) return ta.localeCompare(tb);
      return a.id.localeCompare(b.id);
    });
  const order: string[] = [];
  const latestByKey = new Map<string, EffectiveClusterChange>();
  for (const rh of applied) {
    const at = rh.applied_at || rh.updated_at || "";
    const by = rh.applied_by || rh.owner || "";
    for (const ch of rh.applied_changes || []) {
      const k = (ch.key || "").trim();
      if (!k) continue;
      const lk = k.toLowerCase();
      const prev = latestByKey.get(lk);
      if (prev) {
        prev.after = ch.after;
        if (ch.note) prev.note = ch.note;
        prev.source_id = rh.id;
        prev.source_title = rh.title;
        prev.source_doc_id = rh.doc_id;
        prev.applied_at = at;
        prev.applied_by = by;
        prev.update_count += 1;
      } else {
        order.push(lk);
        latestByKey.set(lk, {
          key: k,
          before: ch.before,
          after: ch.after,
          note: ch.note,
          source_id: rh.id,
          source_title: rh.title,
          source_doc_id: rh.doc_id,
          applied_at: at,
          applied_by: by,
          update_count: 1,
        });
      }
    }
  }
  const items = order
    .map((lk) => latestByKey.get(lk)!)
    .filter(Boolean);
  return { items, latestByKey };
}

type ApplyModalDraft = {
  seed: number;
  summary: string;
  note: string;
  changes: RehearsalAppliedChange[];
};

const ProductionApplyModal = React.memo(function ProductionApplyModal({
  visible,
  draft,
  clusterId,
  rehearsal,
  peers,
  isApplied,
  hasConflict,
  guardAlerts,
  busy,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  draft: ApplyModalDraft;
  clusterId: string;
  rehearsal: ChangeRehearsal;
  peers: ChangeRehearsal[];
  isApplied: boolean;
  hasConflict: boolean;
  guardAlerts: NonNullable<ChangeRehearsal["conflict_alerts"]>;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: {
    summary: string;
    note: string;
    changes: RehearsalAppliedChange[];
    supersedeIds: string[];
  }) => void;
}) {
  useLang();
  const [prevSeed, setPrevSeed] = useState(draft.seed);
  const [summary, setSummary] = useState(draft.summary);
  const [note, setNote] = useState(draft.note);
  const [changes, setChanges] = useState<RehearsalAppliedChange[]>(draft.changes);
  const [supersedeIds, setSupersedeIds] = useState<string[]>([]);

  if (draft.seed !== prevSeed) {
    setPrevSeed(draft.seed);
    setSummary(draft.summary);
    setNote(draft.note);
    setChanges(draft.changes);
    setSupersedeIds([]);
  }

  const peerTopics = useMemo(() => {
    if (!visible || isApplied) return [];
    const out: { plan: ChangeRehearsal; keys: Map<string, string> }[] = [];
    for (const p of peers) {
      if (
        p.id === rehearsal.id ||
        p.stage !== "finalized" ||
        p.applied ||
        p.voided
      ) {
        continue;
      }
      out.push({ plan: p, keys: extractRehearsalTopicKeysClient(p) });
    }
    return out;
  }, [peers, rehearsal.id, visible, isApplied]);

  const baseMyKeys = useMemo(
    () => (visible && !isApplied ? extractRehearsalTopicKeysClient(rehearsal) : null),
    [rehearsal, visible, isApplied],
  );

  const { overlappingPending, parallelPending } = useMemo(() => {
    if (!visible || isApplied || peerTopics.length === 0) {
      return {
        overlappingPending: [] as { plan: ChangeRehearsal; keys: string[] }[],
        parallelPending: [] as ChangeRehearsal[],
      };
    }
    const myKeys = new Map<string, string>(baseMyKeys || []);
    for (const ch of changes) {
      const k = (ch.key || "").trim();
      if (k) myKeys.set(k.toLowerCase(), k);
    }
    const overlapping: { plan: ChangeRehearsal; keys: string[] }[] = [];
    const parallel: ChangeRehearsal[] = [];
    for (const { plan: p, keys: pKeys } of peerTopics) {
      const shared: string[] = [];
      for (const [lk, disp] of myKeys.entries()) {
        if (pKeys.has(lk)) shared.push(disp);
      }
      if (shared.length > 0) {
        overlapping.push({ plan: p, keys: shared });
      } else {
        parallel.push(p);
      }
    }
    return { overlappingPending: overlapping, parallelPending: parallel };
  }, [visible, isApplied, peerTopics, baseMyKeys, changes]);

  const otherAppliedEffective = useMemo(() => {
    if (!visible || isApplied) return null;
    return computeEffectiveClusterChanges(
      peers.filter((p) => p.id !== rehearsal.id),
    );
  }, [peers, rehearsal.id, visible, isApplied]);

  const liveOverwrites = useMemo(() => {
    if (!visible || isApplied || !otherAppliedEffective) return [];
    const hits: {
      key: string;
      prevAfter: string;
      nextAfter: string;
      sourceTitle: string;
      sourceId: string;
    }[] = [];
    for (const ch of changes) {
      const k = (ch.key || "").trim();
      const a = (ch.after || "").trim();
      if (!k || !a) continue;
      const prev = otherAppliedEffective.latestByKey.get(k.toLowerCase());
      if (prev && prev.after !== a) {
        hits.push({
          key: k,
          prevAfter: prev.after,
          nextAfter: a,
          sourceTitle: prev.source_title,
          sourceId: prev.source_id,
        });
      }
    }
    return hits;
  }, [visible, changes, isApplied, otherAppliedEffective]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || busy) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".arco-modal-wrapper")) return;
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, busy, onCancel]);

  return (
    <Modal
      visible={visible}
      alignCenter
      wrapClassName="ad-wu-wrap"
      className="rh-apply-modal"
      style={{ transformOrigin: "center center" }}
      focusLock={false}
      autoFocus={false}
      title={
        isApplied
          ? bi("更新生产变更落地记录", "Update Production Change Record")
          : bi(
              "确认生产已实施完成并同步到集群",
              "Confirm Production Completion & Sync Cluster",
            )
      }
      onCancel={onCancel}
      onOk={() => onSubmit({ summary, note, changes, supersedeIds })}
      confirmLoading={busy}
      okText={
        isApplied
          ? bi("保存更新", "Save Changes")
          : bi("确认已落地并同步集群", "Confirm & Sync to Cluster")
      }
      cancelText={bi("取消", "Cancel")}
      okButtonProps={{
        status: hasConflict && !isApplied ? "warning" : "success",
        className:
          hasConflict && !isApplied ? undefined : "rh-apply-ok-btn",
      }}
      maskClosable={false}
    >
      <div className="rh-apply-form">
        {/* Anti-misclick Full Identity Confirmation Banner */}
        <div className="rh-apply-ident">
          <div className="rh-apply-ident-row">
            <span className="rh-apply-ident-cluster mono">{clusterId}</span>
            <span className="rh-apply-ident-doc mono">
              {rehearsal.doc_id || `sop-${rehearsal.id}`}
            </span>
          </div>
          <div className="rh-apply-ident-title">{rehearsal.title}</div>
        </div>

        {/* Conflict / Overwrite Guard inside Modal */}
        {!isApplied && (guardAlerts.length > 0 || liveOverwrites.length > 0) && (
          <div
            className={`rh-apply-modal-guard ${hasConflict ? "is-danger" : "is-warn"}`}
          >
            <div className="rh-apply-modal-guard-h">
              <IconExclamationCircle />
              <b>
                {hasConflict
                  ? bi(
                      "请二次核对：此方案与近期已落地变更存在重叠",
                      "Double-Check: Overlaps with Recently Applied Change",
                    )
                  : bi(
                      "参数覆盖提示：确认后将以本次新值作为当前最新生效配置",
                      "Value Update Preview: New values will become active baseline",
                    )}
              </b>
            </div>
            {guardAlerts.length > 0 && (
              <ul className="rh-apply-modal-guard-list">
                {guardAlerts.map((a, i) => (
                  <li key={`${a.other_id}-${i}`}>{a.summary}</li>
                ))}
              </ul>
            )}
            {liveOverwrites.length > 0 && (
              <div className="rh-apply-overwrite-list">
                {liveOverwrites.map((o) => (
                  <div key={o.key} className="rh-apply-overwrite-item">
                    <code className="mono">{o.key}</code>
                    <span className="rh-apply-before">{o.prevAfter}</span>
                    <span>→</span>
                    <b className="mono">{o.nextAfter}</b>
                    <span className="faint">
                      {bi(
                        `（将覆盖此前《${o.sourceTitle}》的生效值）`,
                        `(updates prior "${o.sourceTitle}")`,
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="rh-apply-form-lead">
          {bi(
            "确认后，以下变更结果将正式反映到该集群的「概览」「配置」「交付报告」以及后续 AI 助手与演练的基准上下文中。",
            "Once confirmed, these effective changes will appear in Cluster Overview, Config, Delivery Report, and future AI/rehearsal baselines.",
          )}
        </p>

        <div className="rh-apply-field">
          <label>{bi("生效变更摘要", "Effective Change Summary")}</label>
          <textarea
            className="rh-apply-textarea"
            rows={4}
            value={summary}
            placeholder={bi(
              "简明概括本次在生产环境实际落地生效的改动…",
              "Briefly describe what changed in production…",
            )}
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>

        <div className="rh-apply-field">
          <div className="rh-apply-field-h">
            <label>
              {bi(
                "关键配置 / 参数 / 规则变动（将自动与历史生效值归并展示）",
                "Key Config / Parameter / Rule Deltas (auto-merged with prior state)",
              )}
            </label>
            <Button
              size="mini"
              type="text"
              icon={<IconPlus />}
              onClick={() =>
                setChanges((prev) => [
                  ...prev,
                  { key: "", before: "", after: "" },
                ])
              }
            >
              {bi("添加变更项", "Add Item")}
            </Button>
          </div>
          {changes.length === 0 ? (
            <div className="rh-apply-empty-deltas">
              {bi(
                "未自动解析到具体参数键值；如需在集群配置页高亮展示参数变动，可点右上角「添加变更项」。",
                "No specific key/value deltas auto-detected; click Add Item to list specific config changes.",
              )}
            </div>
          ) : (
            <div className="rh-apply-delta-editor">
              <div className="rh-apply-delta-head" aria-hidden>
                <span>{bi("参数/配置项", "Key / Item")}</span>
                <span>{bi("变更前", "Before")}</span>
                <span>{bi("变更后生效值", "After (Active)")}</span>
                <span />
              </div>
              {changes.map((ch, idx) => (
                <div key={idx} className="rh-apply-delta-row">
                  <input
                    type="text"
                    className="rh-apply-input"
                    placeholder={bi("参数/配置项", "Key / Item")}
                    title={ch.key || undefined}
                    value={ch.key}
                    onChange={(e) => {
                      const v = e.target.value;
                      setChanges((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, key: v } : x)),
                      );
                    }}
                  />
                  <input
                    type="text"
                    className="rh-apply-input"
                    placeholder={bi("变更前（可选）", "Before (opt)")}
                    title={ch.before || undefined}
                    value={ch.before || ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setChanges((prev) =>
                        prev.map((x, i) =>
                          i === idx ? { ...x, before: v } : x,
                        ),
                      );
                    }}
                  />
                  <input
                    type="text"
                    className="rh-apply-input"
                    placeholder={bi("变更后生效值", "After (active)")}
                    title={ch.after || undefined}
                    value={ch.after}
                    onChange={(e) => {
                      const v = e.target.value;
                      setChanges((prev) =>
                        prev.map((x, i) =>
                          i === idx ? { ...x, after: v } : x,
                        ),
                      );
                    }}
                  />
                  <button
                    type="button"
                    className="rh-apply-row-del"
                    aria-label={bi("删除该项", "Remove item")}
                    onClick={() =>
                      setChanges((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    <IconClose />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rh-apply-field">
          <label>
            {bi(
              "现场执行备注 / 变更单号（可选）",
              "Execution Note / Ticket ID (Optional)",
            )}
          </label>
          <input
            type="text"
            className="rh-apply-input is-md"
            value={note}
            placeholder={bi(
              "例如：CHG-20261123 · 低峰窗口执行完成，业务零感知",
              "e.g. CHG-20261123 · Applied cleanly during maintenance window",
            )}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {/* Optional: ONLY offer supersede checkbox for pending peers that modify the SAME config keys */}
        {!isApplied && overlappingPending.length > 0 && (
          <div className="rh-apply-supersede">
            <div className="rh-apply-supersede-h">
              <b>
                {bi(
                  "检测到改动相同配置项的待实施方案（可选处置）",
                  "Overlapping Pending Plans Detected (Optional)",
                )}
              </b>
              <span>
                {bi(
                  "以下旧方案与本次变更修改了相同配置项：如本次方案已取代旧方案，可勾选自动标为「已被替代」；如仍需保留先后执行，请不要勾选",
                  "These pending plans touch the same config keys: check only if replaced by this change; leave unchecked to keep both",
                )}
              </span>
            </div>
            <div className="rh-apply-supersede-list">
              {overlappingPending.map(({ plan: p, keys }) => {
                const checked = supersedeIds.includes(p.id);
                const toggleSupersede = (next?: boolean) =>
                  setSupersedeIds((prev) => {
                    const want = next !== undefined ? next : !prev.includes(p.id);
                    return want
                      ? Array.from(new Set([...prev, p.id]))
                      : prev.filter((x) => x !== p.id);
                  });
                return (
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={checked}
                    className={`rh-apply-supersede-item${checked ? " is-checked" : ""}`}
                    onClick={() => toggleSupersede()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleSupersede();
                      }
                    }}
                  >
                    <span onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={checked}
                        onChange={(v) => toggleSupersede(Boolean(v))}
                      />
                    </span>
                    <span className="rh-apply-supersede-main">
                      <span className="rh-apply-supersede-title">
                        {p.title}
                      </span>
                      <span className="rh-apply-supersede-keys">
                        {bi("重叠项：", "Overlap: ")}
                        {keys.join("、")}
                      </span>
                    </span>
                    <span className="rh-apply-supersede-meta num">
                      {ago(p.updated_at)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Read-only notice for unrelated parallel pending plans so user knows they coexist & are NOT deleted */}
        {!isApplied && parallelPending.length > 0 && (
          <div className="rh-apply-parallel">
            <div className="rh-apply-parallel-h">
              <b>
                {bi(
                  "同集群并存待实施变更（独立保留，互不覆盖）",
                  "Coexisting Pending Changes on Cluster (Preserved)",
                )}
              </b>
              <span>
                {bi(
                  "以下方案涉及不同配置项，与本方案属于并存/前后演进关系；本次确认不会删除或作废它们，后续完成后可各自独立落地叠加",
                  "These plans modify different configs and coexist with this change; they remain untouched for independent production sign-off",
                )}
              </span>
            </div>
            <div className="rh-apply-parallel-list">
              {parallelPending.map((p) => (
                <div key={p.id} className="rh-apply-parallel-item">
                  <span className="rh-sdot st-pending-apply" aria-hidden />
                  <span className="rh-apply-supersede-title">{p.title}</span>
                  <span className="rh-apply-parallel-tag">
                    {bi("独立保留", "Kept")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
});

const ProductionVoidModal = React.memo(function ProductionVoidModal({
  visible,
  openSeed,
  clusterId,
  rehearsal,
  peers,
  busy,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  openSeed: number;
  clusterId: string;
  rehearsal: ChangeRehearsal;
  peers: ChangeRehearsal[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: { reason: string; supersededBy: string }) => void;
}) {
  useLang();
  const [prevSeed, setPrevSeed] = useState(openSeed);
  const [voidReason, setVoidReason] = useState("");
  const [voidSupersededBy, setVoidSupersededBy] = useState("");

  if (openSeed !== prevSeed) {
    setPrevSeed(openSeed);
    setVoidReason("");
    setVoidSupersededBy("");
  }

  const replacementCandidates = useMemo(
    () =>
      visible
        ? peers.filter(
            (p) =>
              p.id !== rehearsal.id &&
              p.stage === "finalized" &&
              !p.voided,
          )
        : [],
    [peers, rehearsal.id, visible],
  );

  const voidPresets = [
    bi("已被新版方案替代", "Superseded by newer plan"),
    bi("变更窗口取消，暂不执行", "Maintenance window cancelled"),
    bi("现场执行异常，已触发回退", "Rolled back during execution"),
    bi("仅作演练参考，不上生产", "Staging reference only"),
  ];

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || busy) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".arco-modal-wrapper")) return;
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, busy, onCancel]);

  return (
    <Modal
      visible={visible}
      alignCenter
      wrapClassName="ad-wu-wrap"
      className="rh-void-modal"
      style={{ transformOrigin: "center center" }}
      focusLock={false}
      autoFocus={false}
      title={bi("标记变更方案为作废 / 不再执行", "Mark Change Plan Void / Obsolete")}
      onCancel={onCancel}
      onOk={() => onSubmit({ reason: voidReason, supersededBy: voidSupersededBy })}
      confirmLoading={busy}
      okText={bi("确认标记作废", "Confirm Void")}
      cancelText={bi("取消", "Cancel")}
      okButtonProps={{ status: "warning" }}
      maskClosable={false}
    >
      <div className="rh-apply-form">
        <div className="rh-apply-ident is-void">
          <div className="rh-apply-ident-row">
            <span className="rh-apply-ident-cluster mono">{clusterId}</span>
            <span className="rh-apply-ident-doc mono">
              {rehearsal.doc_id || `sop-${rehearsal.id}`}
            </span>
          </div>
          <div className="rh-apply-ident-title">{rehearsal.title}</div>
        </div>

        <p className="rh-apply-form-lead">
          {bi(
            "作废后该方案会保留全部演练步骤与归档文档供追溯审计，但会锁定「确认生产已实施完成」入口避免后续误点；如有需要随时可一键恢复。",
            "Voided plans retain all rehearsal steps and archived docs for audit while locking sign-off against misclicks; you can restore anytime.",
          )}
        </p>

        <div className="rh-apply-field">
          <label>{bi("作废原因", "Void Reason")}</label>
          <div className="rh-void-presets">
            {voidPresets.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`rh-void-chip${voidReason === preset ? " on" : ""}`}
                onClick={() => setVoidReason(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
          <textarea
            className="rh-apply-textarea is-void"
            rows={3}
            value={voidReason}
            placeholder={bi(
              "填写作废原因（可选，留空将记录默认说明）…",
              "Explain why this plan will not be applied (optional)…",
            )}
            onChange={(e) => setVoidReason(e.target.value)}
          />
        </div>

        {replacementCandidates.length > 0 && (
          <div className="rh-apply-field">
            <label>
              {bi(
                "关联替代的新方案（可选）",
                "Link Replacement Plan (Optional)",
              )}
            </label>
            <div className="rh-void-peers">
              <button
                type="button"
                className={`rh-void-peer${voidSupersededBy === "" ? " on" : ""}`}
                onClick={() => setVoidSupersededBy("")}
              >
                {bi("不关联特定方案", "None")}
              </button>
              {replacementCandidates.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`rh-void-peer${voidSupersededBy === p.id ? " on" : ""}`}
                  onClick={() => {
                    setVoidSupersededBy(p.id);
                    if (!voidReason.trim()) {
                      setVoidReason(
                        bi(`已被方案「${p.title}」替代`, `Superseded by "${p.title}"`),
                      );
                    }
                  }}
                >
                  <span className={`rh-sdot ${rehearsalDotClass(p)}`} />
                  <span className="rh-void-peer-t">{p.title}</span>
                  {p.applied && (
                    <em className="rh-void-peer-tag">
                      {bi("已落地", "Applied")}
                    </em>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
});

export function RehearsalProductionApplyCard({
  clusterId,
  rehearsal,
  peers = [],
  offline = false,
  compact = false,
  onUpdated,
  onRolloutBoardChange,
}: {
  clusterId: string;
  rehearsal: ChangeRehearsal;
  peers?: ChangeRehearsal[];
  offline?: boolean;
  compact?: boolean;
  onUpdated?: (next: ChangeRehearsal) => void;
  onRolloutBoardChange?: (board: RolloutBoardResponse) => void;
}) {
  useLang();
  const dock = useAIDock();
  const reconcileDockKey = `step:rehearsal:${rehearsal.id}:conflict`;
  const aiReady = Boolean(
    dock && !offline && dock.available(reconcileDockKey),
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [applyDraft, setApplyDraft] = useState<ApplyModalDraft | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidSeed, setVoidSeed] = useState(0);
  const [propagateOpen, setPropagateOpen] = useState(false);
  const [rolloutBoardOpen, setRolloutBoardOpen] = useState(false);
  const [rolloutBoardData, setRolloutBoardData] =
    useState<RolloutBoardResponse | null>(null);

  useEffect(() => {
    setModalOpen(false);
    setApplyDraft(null);
    setVoidOpen(false);
    setVoidSeed(0);
    setPropagateOpen(false);
    setRolloutBoardOpen(false);
    setRolloutBoardData(null);
  }, [clusterId, rehearsal.id]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const isApplied = Boolean(rehearsal.applied);
  const isVoided = Boolean(rehearsal.voided);
  const isReportMode = rehearsal.mode === "quick" || rehearsal.mode === "light";

  const alerts = rehearsal.conflict_alerts || [];
  const conflictAlerts = alerts.filter((a) => a.severity === "conflict");
  const staleAlerts = alerts.filter((a) => a.severity === "stale");
  const earlierPendingAlerts = alerts.filter(
    (a) => a.severity === "earlier_pending",
  );
  const guardAlerts = useMemo(
    () => [...conflictAlerts, ...staleAlerts],
    [rehearsal.conflict_alerts],
  );
  const hasConflict = conflictAlerts.length > 0;
  const hasStale = staleAlerts.length > 0;

  // Merge all applied rehearsals (including current if already applied) to detect superseded params
  const effectiveAll = useMemo(() => {
    const mergedPeers = peers.some((p) => p.id === rehearsal.id)
      ? peers.map((p) => (p.id === rehearsal.id ? rehearsal : p))
      : [...peers, rehearsal];
    return computeEffectiveClusterChanges(mergedPeers);
  }, [peers, rehearsal]);

  const jumpToPeer = (peerId: string) => {
    if (!peerId) return;
    go({
      name: "deliveries",
      id: clusterId,
      tab: "rehearsal",
      rehearsal: peerId,
    });
  };

  const openModal = () => {
    const def = suggestAppliedChangesClient(rehearsal);
    setApplyDraft((prev) => ({
      seed: (prev?.seed || 0) + 1,
      summary: def.summary,
      note: rehearsal.applied_note || "",
      changes: def.changes,
    }));
    setModalOpen(true);
  };

  const openVoidModal = () => {
    setVoidSeed((s) => s + 1);
    setVoidOpen(true);
  };

  const askAIReconcile = () => {
    if (!dock) return;
    const lines = guardAlerts
      .map(
        (a, i) =>
          `${i + 1}. [${a.severity === "conflict" ? "冲突" : "基线更新"}] ${a.summary}${a.overlapping_keys?.length ? `（涉及：${a.overlapping_keys.join("、")}）` : ""}`,
      )
      .join("\n");
    dock.open({
      key: reconcileDockKey,
      title: bi(
        `按最新集群基线复核方案 · ${rehearsal.title}`,
        `Review Plan Against Latest Baseline · ${rehearsal.title}`,
      ),
      context: `${rehearsal.title} · ${clusterId}`,
      step: {
        kind: "rehearsal_step",
        cluster_id: clusterId,
        rehearsal_id: rehearsal.id,
        rehearsal_title: rehearsal.title,
      },
      hello: bi(
        "同集群已有其他变更在生产落地。发送下方草稿后，我会读取当前方案与最新生产基线，逐项核对是否会互相覆盖或需要微调命令。",
        "Another production change landed on this cluster. Send the draft below and I will audit this plan against the latest production baseline for overwrites or needed adjustments.",
      ),
      draft: bi(
        `请调用 read_rehearsal 读取演练 #${rehearsal.id}（「${rehearsal.title}」）的完整步骤，并对照当前集群最新已落地的生产基线，帮我核对以下冲突/变化提醒，判断直接执行是否会覆盖先前变更或需要调整命令：\n${lines}`,
        `Please call read_rehearsal for #${rehearsal.id} ("${rehearsal.title}") and compare it against the latest applied cluster baseline to verify whether executing it would overwrite prior changes or requires command updates:\n${lines}`,
      ),
    });
  };

  const submitApply = useCallback(
    async (
      applied: boolean,
      payload?: {
        summary: string;
        note: string;
        changes: RehearsalAppliedChange[];
        supersedeIds: string[];
      },
    ) => {
      if (offline || busy || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const nextSummary = payload?.summary ?? "";
        const nextNote = payload?.note ?? "";
        const nextChanges = payload?.changes ?? [];
        const nextSupersedeIds = payload?.supersedeIds ?? [];
        const next = await api<ChangeRehearsal>(
          `/api/clusters/${encodeURIComponent(clusterId)}/rehearsals/${encodeURIComponent(rehearsal.id)}/apply`,
          {
            method: "POST",
            body: JSON.stringify(
              applied
                ? {
                    applied: true,
                    summary: nextSummary.trim(),
                    note: nextNote.trim(),
                    changes: nextChanges.filter(
                      (c) => c.key.trim() || c.after.trim(),
                    ),
                    ...(nextSupersedeIds.length > 0
                      ? { supersede_ids: nextSupersedeIds }
                      : {}),
                  }
                : { applied: false },
            ),
          },
        );
        setModalOpen(false);
        onUpdated?.(next);
        Message.success(
          applied
            ? nextSupersedeIds.length > 0
              ? bi(
                  `已确认生产落地，同步至集群并自动归档作废 ${nextSupersedeIds.length} 个旧方案`,
                  `Confirmed applied to production and marked ${nextSupersedeIds.length} older plan(s) superseded`,
                )
              : bi(
                  "已确认生产实施完成，变更结果已同步至集群概览、配置与交付报告",
                  "Marked applied to production; synced to cluster overview, config, and delivery report",
                )
            : bi("已撤销生产落地标记", "Production applied status reverted"),
        );
      } catch (e) {
        err(e);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [offline, busy, clusterId, rehearsal.id, onUpdated],
  );

  const submitVoid = useCallback(
    async (
      wantVoid: boolean,
      payload?: { reason: string; supersededBy: string },
    ) => {
      if (offline || busy || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const nextReason = payload?.reason ?? "";
        const nextSupersededBy = payload?.supersededBy ?? "";
        const next = await api<ChangeRehearsal>(
          `/api/clusters/${encodeURIComponent(clusterId)}/rehearsals/${encodeURIComponent(rehearsal.id)}/void`,
          {
            method: "POST",
            body: JSON.stringify(
              wantVoid
                ? {
                    voided: true,
                    reason: nextReason.trim(),
                    ...(nextSupersededBy
                      ? { superseded_by: nextSupersededBy }
                      : {}),
                  }
                : { voided: false },
            ),
          },
        );
        setVoidOpen(false);
        onUpdated?.(next);
        Message.success(
          wantVoid
            ? bi(
                "已将该方案标记为作废并锁定，防止误操作确认落地",
                "Plan marked voided and locked against accidental sign-off",
              )
            : bi("已恢复为「待生产实施」状态", "Plan restored to pending apply"),
        );
      } catch (e) {
        err(e);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [offline, busy, clusterId, rehearsal.id, onUpdated],
  );

  const closeApplyModal = useCallback(() => {
    if (!busy) setModalOpen(false);
  }, [busy]);

  const handleApplySubmit = useCallback(
    (payload: {
      summary: string;
      note: string;
      changes: RehearsalAppliedChange[];
      supersedeIds: string[];
    }) => {
      void submitApply(true, payload);
    },
    [submitApply],
  );

  const closeVoidModal = useCallback(() => {
    if (!busy) setVoidOpen(false);
  }, [busy]);

  const handleVoidSubmit = useCallback(
    (payload: { reason: string; supersededBy: string }) => {
      void submitVoid(true, payload);
    },
    [submitVoid],
  );

  const stateClass = isVoided
    ? "is-voided"
    : isApplied
      ? "is-applied"
      : hasConflict
        ? "is-conflict"
        : hasStale
          ? "is-stale"
          : "is-pending";

  return (
    <>
      <div
        className={`rh-closure ${stateClass}${compact ? " is-compact" : ""}`}
        role="region"
        aria-label={bi("生产变更状态控制台", "Production Change Status Console")}
      >
        {/* Top 3-stage lifecycle progress rail */}
        <div className="rh-closure-rail">
          <div className="rh-closure-steps" aria-label={bi("变更生命周期", "Change lifecycle")}>
            <span className="rh-cstep is-done">
              <i className="rh-cstep-dot" aria-hidden>
                <IconCheck />
              </i>
              {isReportMode
                ? bi("报告已归档", "Archived")
                : bi("方案已定稿", "Finalized")}
            </span>
            <span className="rh-cstep-line is-done" aria-hidden />
            <span
              className={`rh-cstep ${
                isVoided
                  ? "is-voided"
                  : isApplied
                    ? "is-done"
                    : hasConflict
                      ? "is-danger"
                      : hasStale
                        ? "is-warn"
                        : "is-active"
              }`}
            >
              <i className="rh-cstep-dot" aria-hidden>
                {isApplied ? (
                  <IconCheck />
                ) : isVoided ? (
                  <IconClose />
                ) : hasConflict || hasStale ? (
                  <IconExclamationCircle />
                ) : (
                  <span className="rh-cstep-pulse" />
                )}
              </i>
              {isVoided
                ? rehearsal.superseded_by
                  ? bi("已被替代", "Superseded")
                  : bi("已作废", "Voided")
                : isApplied
                  ? bi("生产已落地", "Applied to Prod")
                  : hasConflict
                    ? bi("存在配置冲突", "Conflict Alert")
                    : hasStale
                      ? bi("基线已更新", "Baseline Updated")
                      : bi("待生产实施", "Pending Apply")}
            </span>
            <span
              className={`rh-cstep-line${isApplied ? " is-done" : ""}`}
              aria-hidden
            />
            <span
              className={`rh-cstep ${
                isApplied ? "is-done" : isVoided ? "is-voided" : "is-todo"
              }`}
            >
              <i className="rh-cstep-dot" aria-hidden>
                {isApplied ? <IconCheck /> : isVoided ? <IconClose /> : null}
              </i>
              {isApplied
                ? bi("已同步集群", "Synced to Cluster")
                : isVoided
                  ? bi("不计入基线", "Excluded")
                  : bi("待同步集群", "Pending Sync")}
            </span>
          </div>

          <div className="rh-closure-rail-meta">
            {isApplied && (rehearsal.applied_by || rehearsal.applied_at) && (
              <span className="rh-closure-stamp is-applied num">
                {bi(
                  `${rehearsal.applied_by || rehearsal.owner} · ${ago(rehearsal.applied_at || rehearsal.updated_at)}确认`,
                  `${rehearsal.applied_by || rehearsal.owner} · confirmed ${ago(rehearsal.applied_at || rehearsal.updated_at)}`,
                )}
              </span>
            )}
            {isVoided && (rehearsal.voided_by || rehearsal.voided_at) && (
              <span className="rh-closure-stamp is-voided num">
                {bi(
                  `${rehearsal.voided_by || rehearsal.owner} · ${ago(rehearsal.voided_at || rehearsal.updated_at)}作废`,
                  `${rehearsal.voided_by || rehearsal.owner} · voided ${ago(rehearsal.voided_at || rehearsal.updated_at)}`,
                )}
              </span>
            )}
            {!isApplied && !isVoided && (
              <span className={`rh-closure-pill ${hasConflict ? "is-danger" : hasStale ? "is-warn" : "is-pending"}`}>
                {hasConflict
                  ? bi("执行前请先核对冲突", "Check Conflict First")
                  : hasStale
                    ? bi("建议复核最新基线", "Review Latest Baseline")
                    : bi("等待生产确认", "Awaiting Confirmation")}
              </span>
            )}
          </div>
        </div>

        {/* Inline Conflict / Baseline Drift Guard Banner (Pending only) */}
        {!isApplied && !isVoided && guardAlerts.length > 0 && (
          <div
            className={`rh-closure-guard ${hasConflict ? "is-danger" : "is-warn"}`}
            role="alert"
          >
            <div className="rh-closure-guard-head">
              <div className="rh-closure-guard-title">
                <IconExclamationCircle />
                <b>
                  {hasConflict
                    ? bi(
                        "变更冲突提醒 · 集群已有新变更改动了相同配置项",
                        "Conflict Alert · Overlapping Config Changed in Production",
                      )
                    : bi(
                        "集群基线已更新 · 此方案定稿后已有其他变更在生产落地",
                        "Cluster Updated · Another Change Landed After Finalization",
                      )}
                </b>
              </div>
              {aiReady && dock && (
                <button
                  type="button"
                  className="rh-restore-ai-btn"
                  onClick={askAIReconcile}
                >
                  <Spark size={12} rainbow />
                  {bi("让 AI 按最新基线复核", "AI Baseline Review")}
                </button>
              )}
            </div>
            <ul className="rh-closure-guard-list">
              {guardAlerts.map((a, idx) => (
                <li key={`${a.other_id}-${idx}`}>
                  <div className="rh-closure-guard-row">
                    <span>{a.summary}</span>
                    {a.overlapping_keys && a.overlapping_keys.length > 0 && (
                      <span className="rh-closure-guard-keys">
                        {a.overlapping_keys.map((k) => (
                          <code key={k} className="mono">
                            {k}
                          </code>
                        ))}
                      </span>
                    )}
                    {a.other_id && (
                      <button
                        type="button"
                        className="rh-closure-jump"
                        onClick={() => jumpToPeer(a.other_id)}
                      >
                        {bi("查看该方案", "View Plan")} <IconRight />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Subtle notice when earlier unapplied peer plans exist (and no harder conflict/stale banner) */}
        {!isApplied &&
          !isVoided &&
          guardAlerts.length === 0 &&
          earlierPendingAlerts.length > 0 && (
            <div className="rh-closure-hint">
              <span>
                {bi(
                  `提示：同集群还有 ${earlierPendingAlerts.length} 个更早定稿但未确认落地的方案（如《${earlierPendingAlerts[0].other_title}》）；如本方案已替代旧方案，可在确认落地时顺手勾选作废。`,
                  `Note: ${earlierPendingAlerts.length} earlier finalized plan(s) remain unapplied (e.g. "${earlierPendingAlerts[0].other_title}"); you can mark obsolete ones superseded when confirming.`,
                )}
              </span>
            </div>
          )}

        {/* Main Console Action Body */}
        <div className="rh-closure-body">
          <div className="rh-closure-head">
            <div className="rh-closure-head-left">
              <span className={`rh-closure-ico ${stateClass}`} aria-hidden>
                {isVoided ? (
                  <IconRecordStop />
                ) : isApplied ? (
                  <IconCheck />
                ) : hasConflict ? (
                  <IconExclamationCircle />
                ) : (
                  <IconThunderboltSafe />
                )}
              </span>
              <div className="rh-closure-title-row">
                <b>
                  {isVoided
                    ? rehearsal.superseded_by
                      ? bi("此变更方案已被新方案替代", "Superseded by a Newer Plan")
                      : bi("此变更方案已标记作废", "Change Plan Voided")
                    : isApplied
                      ? bi("生产已实施落地并同步至集群", "Applied to Production & Synced")
                      : bi("生产变更闭环确认", "Production Closure Sign-Off")}
                </b>
                {isApplied && (
                  <div className="rh-closure-sync-pills" aria-label={bi("已同步位置", "Synced targets")}>
                    <span>{bi("概览", "Overview")}</span>
                    <span>{bi("配置", "Config")}</span>
                    <span>{bi("交付报告", "Delivery")}</span>
                    <span>{bi("AI 基线", "AI")}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="rh-closure-acts">
              {isVoided ? (
                <Button
                  size="small"
                  icon={<IconRefresh />}
                  disabled={offline || busy}
                  loading={busy}
                  onClick={() => void submitVoid(false)}
                >
                  {bi("恢复为待实施", "Restore to Pending")}
                </Button>
              ) : isApplied ? (
                <>
                  {rehearsal.stage === "finalized" && (
                    <Button
                      size="small"
                      type="primary"
                      icon={<IconShareExternal />}
                      disabled={offline || busy}
                      onClick={() => setPropagateOpen(true)}
                    >
                      {bi("推广到其他集群", "Propagate")}
                    </Button>
                  )}
                  {rehearsal.source?.rollout_id && (
                    <Button
                      size="small"
                      icon={<IconApps />}
                      disabled={offline || busy}
                      onClick={() => {
                        setRolloutBoardData(null);
                        setRolloutBoardOpen(true);
                      }}
                    >
                      {bi("推广看板", "Rollout Board")}
                    </Button>
                  )}
                  {rehearsal.stage !== "finalized" && !rehearsal.source?.rollout_id && (
                    <Button
                      size="small"
                      icon={<IconEdit />}
                      disabled={offline || busy}
                      onClick={openModal}
                    >
                      {bi("编辑落地记录", "Edit Record")}
                    </Button>
                  )}
                  <Dropdown
                    trigger="click"
                    position="br"
                    triggerProps={{ autoFitPosition: true, updateOnScroll: true }}
                    getPopupContainer={(node) =>
                      (node.closest(".rh-workbench") as HTMLElement) ||
                      document.body
                    }
                    droplist={
                      <Menu
                        onClickMenuItem={(k) => {
                          if (k === "edit") {
                            openModal();
                          } else if (k === "revert") {
                            Modal.confirm({
                              title: bi("撤销此变更的生产落地标记？", "Revert production applied status?"),
                              content: bi(
                                "撤销后将从集群「已落地生产变更」列表中移除，文档与演练记录保留。",
                                "Removes this item from active production changes on the cluster while preserving docs.",
                              ),
                              okText: bi("确认撤销", "Revert"),
                              cancelText: bi("取消", "Cancel"),
                              okButtonProps: { status: "warning" },
                              onOk: () => submitApply(false),
                            });
                          }
                        }}
                      >
                        {(rehearsal.stage === "finalized" || rehearsal.source?.rollout_id) && (
                          <Menu.Item key="edit">
                            <span className="menu-row">
                              <IconEdit />
                              <span>{bi("编辑落地记录", "Edit Record")}</span>
                            </span>
                          </Menu.Item>
                        )}
                        {(rehearsal.stage === "finalized" || rehearsal.source?.rollout_id) && (
                          <div className="menu-sep" />
                        )}
                        <Menu.Item key="revert" className="danger-item">
                          <span className="menu-row">
                            <IconRefresh />
                            <span>{bi("撤销落地", "Revert Sign-Off")}</span>
                          </span>
                        </Menu.Item>
                      </Menu>
                    }
                  >
                    <Button
                      size="small"
                      className="rh-closure-more"
                      icon={<IconMore />}
                      disabled={offline || busy}
                      aria-label={bi("更多落地记录操作", "More record actions")}
                    />
                  </Dropdown>
                </>
              ) : (
                <>
                  <Tooltip
                    mini
                    content={bi(
                      "若此方案不再执行或已被新方案替代，标记作废可保留文档并锁定防误点",
                      "Mark obsolete to preserve docs while locking accidental sign-off",
                    )}
                  >
                    <Button
                      size="small"
                      disabled={offline || busy}
                      onClick={openVoidModal}
                    >
                      {bi("标记作废", "Mark Void")}
                    </Button>
                  </Tooltip>
                  <Button
                    size="small"
                    type="primary"
                    status={hasConflict ? "warning" : "success"}
                    icon={<IconCheck />}
                    disabled={offline || busy}
                    loading={busy}
                    onClick={openModal}
                  >
                    {hasConflict
                      ? bi("核对后确认落地", "Review & Confirm")
                      : bi("确认生产已实施完成", "Confirm Applied to Prod")}
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="rh-closure-detail">
            {isVoided ? (
              <div className="rh-closure-void-info">
                <p className="rh-closure-desc">
                  {rehearsal.void_reason ||
                    bi(
                      "已手动标记不再执行，文档与历史演练记录保留供审计。",
                      "Marked obsolete; documents and history remain preserved for audit.",
                    )}
                </p>
                {rehearsal.superseded_by && (
                  <button
                    type="button"
                    className="rh-closure-superseded-link"
                    onClick={() => jumpToPeer(rehearsal.superseded_by!)}
                  >
                    {bi(
                      `查看替代方案：《${rehearsal.superseded_title || rehearsal.superseded_by}》`,
                      `Open replacement: "${rehearsal.superseded_title || rehearsal.superseded_by}"`,
                    )}{" "}
                    <IconRight />
                  </button>
                )}
                <span className="rh-closure-lock-note">
                  {bi(
                    "已锁定「确认落地」入口，防止后续误点污染集群配置",
                    "Sign-off locked to prevent accidental baseline pollution",
                  )}
                </span>
              </div>
            ) : isApplied ? (
              <p className="rh-closure-desc">
                {rehearsal.applied_summary ||
                  bi(
                    "本次变更已正式记入集群运行台账、配置叠加视图、交付报告与后续 AI 上下文。",
                    "Synced into cluster overview, config overlays, delivery report, and future AI context.",
                  )}
              </p>
            ) : (
              <p className="rh-closure-desc">
                {bi(
                  "按方案在生产环境完成实施与验收后点击「确认生产已实施完成」同步到集群；若方案已放弃或被新方案替代，可「标记作废」锁定防误触。",
                  "Confirm completion once executed and verified in production to sync cluster state, or mark voided if obsolete to lock against misclicks.",
                )}
              </p>
            )}
          </div>
        </div>

        {/* Applied Deltas & Field Note Footer */}
        {isApplied &&
          ((rehearsal.applied_changes && rehearsal.applied_changes.length > 0) ||
            rehearsal.applied_note) && (
            <div className="rh-closure-foot">
              {rehearsal.applied_changes &&
                rehearsal.applied_changes.length > 0 && (
                  <div className="rh-apply-deltas">
                    {rehearsal.applied_changes.map((ch, idx) => {
                      const latest = effectiveAll.latestByKey.get(
                        (ch.key || "").trim().toLowerCase(),
                      );
                      const isOverwritten = Boolean(
                        latest && latest.source_id !== rehearsal.id,
                      );
                      const chip = (
                        <span
                          key={`${ch.key}-${idx}`}
                          className={`rh-apply-delta${isOverwritten ? " is-overwritten" : ""}`}
                        >
                          <code className="mono">{ch.key}</code>
                          {ch.before ? (
                            <>
                              <span className="rh-apply-before">{ch.before}</span>
                              <span className="rh-apply-arrow" aria-hidden>
                                →
                              </span>
                            </>
                          ) : (
                            <span className="rh-apply-arrow" aria-hidden>
                              =
                            </span>
                          )}
                          <b className="mono">{ch.after}</b>
                          {isOverwritten && (
                            <em className="rh-apply-overwritten-tag">
                              {bi("已被更新", "Updated")}
                            </em>
                          )}
                        </span>
                      );
                      return isOverwritten && latest ? (
                        <Tooltip
                          key={`${ch.key}-${idx}`}
                          mini
                          content={bi(
                            `后续变更《${latest.source_title}》已将该项更新为 ${latest.after}`,
                            `Later updated to "${latest.after}" by "${latest.source_title}"`,
                          )}
                        >
                          {chip}
                        </Tooltip>
                      ) : (
                        chip
                      );
                    })}
                  </div>
                )}
              {rehearsal.applied_note && (
                <div className="rh-apply-note">
                  <span>{bi("现场备注：", "Note: ")}</span>
                  {rehearsal.applied_note}
                </div>
              )}
            </div>
          )}
      </div>

      {/* Modal A: Confirm Production Completion (lazy-mounted & isolated for instant first open) */}
      {applyDraft && (
        <ProductionApplyModal
          visible={modalOpen}
          draft={applyDraft}
          clusterId={clusterId}
          rehearsal={rehearsal}
          peers={peers}
          isApplied={isApplied}
          hasConflict={hasConflict}
          guardAlerts={guardAlerts}
          busy={busy}
          onCancel={closeApplyModal}
          onSubmit={handleApplySubmit}
        />
      )}

      {/* Modal B: Mark Plan Void / Obsolete (lazy-mounted & isolated) */}
      {voidSeed > 0 && (
        <ProductionVoidModal
          visible={voidOpen}
          openSeed={voidSeed}
          clusterId={clusterId}
          rehearsal={rehearsal}
          peers={peers}
          busy={busy}
          onCancel={closeVoidModal}
          onSubmit={handleVoidSubmit}
        />
      )}

      {rehearsal.stage === "finalized" && isApplied && !isVoided && (
        <PropagateRehearsalModal
          clusterId={clusterId}
          rehearsal={rehearsal}
          visible={propagateOpen}
          onClose={() => setPropagateOpen(false)}
          onPropagated={(res) => {
            if (res.board) {
              setRolloutBoardData(res.board);
              onRolloutBoardChange?.(res.board);
            }
            setRolloutBoardOpen(true);
            void api<ChangeRehearsal>(rehearsalItemPath(clusterId, rehearsal.id))
              .then((fresh) => {
                putCached(rehearsalItemPath(clusterId, fresh.id), fresh);
                onUpdated?.(fresh);
              })
              .catch(() => undefined);
          }}
        />
      )}

      {(rolloutBoardData?.rollout_id || rehearsal.source?.rollout_id) && (
        <RolloutBoardDrawer
          rolloutId={
            rolloutBoardData?.rollout_id || rehearsal.source?.rollout_id || ""
          }
          visible={rolloutBoardOpen}
          currentClusterId={clusterId}
          initialBoard={rolloutBoardData}
          onClose={() => setRolloutBoardOpen(false)}
          onAddMore={
            rehearsal.stage === "finalized" && isApplied && !isVoided
              ? () => {
                  setRolloutBoardOpen(false);
                  setPropagateOpen(true);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

function IconThunderboltSafe() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9 1.5L3.5 9h4.2L7 14.5 12.5 7H8.3L9 1.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

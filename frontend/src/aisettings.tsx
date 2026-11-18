import React, { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  InputNumber,
  Message,
  Modal,
  Popover,
  Select,
  Skeleton,
  Switch,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconCheck,
  IconCheckCircleFill,
  IconClose,
  IconCloseCircleFill,
  IconCopy,
  IconDelete,
  IconDown,
  IconEdit,
  IconExclamationCircleFill,
  IconPlus,
  IconRefresh,
  IconSend,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  cached,
  can,
  copy,
  err,
  fetchCached,
  fullTime,
  putCached,
  refreshAIStatus,
  useAIStatus,
} from "./shared";
import type { AIStatus } from "./shared";
import { UnderlineTabs } from "./ui";
import { PROVIDER_LOGOS } from "./providerlogos";
import { ProviderLogo } from "./ailogo";
export { ProviderLogo } from "./ailogo";
import {
  Spark,
  formatAICallDiag,
  prettyDiagPayload,
  reasonCodeLabel,
} from "./aichat";
import type { AIAttemptDiag, AICallDiag } from "./aichat";
export type { AIAttemptDiag, AICallDiag } from "./aichat";
import "./aisettings.css";

const aiTabIco = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  style: { display: "block", flex: "none" } as React.CSSProperties,
  "aria-hidden": true,
};

const AITabIcons = {
  all: (
    <svg {...aiTabIco}>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </svg>
  ),
  mine: (
    <svg {...aiTabIco}>
      <path d="M2.5 4.5L3.7 5.7L5.5 3.7M2.5 8L3.7 9.2L5.5 7.2M2.5 11.5L3.7 12.7L5.5 10.7" />
      <path d="M7.2 4.6H13.5M7.2 8.1H13.5M7.2 11.6H13.5" />
    </svg>
  ),
  remote: (
    <svg {...aiTabIco}>
      <rect x="2.5" y="2.8" width="11" height="4.2" rx="1.3" />
      <rect x="2.5" y="9" width="11" height="4.2" rx="1.3" />
      <circle cx="5" cy="4.9" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="5" cy="11.1" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  ),
  features: (
    <svg {...aiTabIco}>
      <path d="M2.5 5H13.5M2.5 11H13.5" />
      <circle cx="6" cy="5" r="1.8" fill="var(--surface)" />
      <circle cx="10" cy="11" r="1.8" fill="var(--surface)" />
    </svg>
  ),
  boundary: (
    <svg {...aiTabIco}>
      <path d="M8 2.2L13 4.2V7.8C13 10.9 10.9 13 8 13.8C5.1 13 3 10.9 3 7.8V4.2L8 2.2Z" />
      <path d="M6 8L7.4 9.4L10.2 6.6" />
    </svg>
  ),
};

/* Platform settings → AI: the model providers (each with the models it offers), where the assistant is used, and the data boundary. */

export type AIModel = {
  id: string;
  name?: string;
  enabled: boolean;
  context?: number;
  declared?: string;
  tools?: string;
  vision?: string;
  tested?: string;
  test_ok?: boolean;
  test_ms?: number;
  test_err?: string;
  test_warn?: string;
  test_diag?: AICallDiag;
  price_in?: number;
  price_out?: number;
  price_cached?: number;
  price_default?: {
    in: number;
    cached: number;
    out: number;
    currency: string;
    vendor: string;
    source?: string;
  };
  efforts?: string[];
  think?: string;
};

/** The thinking depths a person can be offered; each is passed on as the request's reasoning_effort. */
export const EFFORTS = [
  { id: "low", name: "低" },
  { id: "medium", name: "中" },
  { id: "high", name: "高" },
  { id: "xhigh", name: "很高" },
  { id: "max", name: "最高" },
  { id: "ultra", name: "ultra" },
];
export type AIProvider = {
  id: string;
  name: string;
  preset: string;
  url: string;
  private: boolean;
  enabled: boolean;
  api_version?: string;
  api?: string;
  timeout_sec?: number;
  max_tokens?: number;
  currency?: string;
  key_set: boolean;
  key_last4?: string;
  models: AIModel[];
  icon?: string;
  color?: string;
};
type Preset = {
  id: string;
  name: string;
  group: string;
  url: string;
  private?: boolean;
  hint?: string;
  soon?: boolean;
};
type Feature = { enabled: boolean; primary?: string; backup?: string };
type AISettings = {
  enabled: boolean;
  providers: AIProvider[];
  features: Record<string, Feature>;
  redact_hosts: boolean;
  private_only: boolean;
  monthly_limit: number;
  user_models: string[];
  presets: Preset[];
  feature_list: { ID: string; Title: string; Help: string }[];
};

const GROUPS: [string, string][] = [
  ["intl", "国际"],
  ["cn", "国内"],
  ["local", "本地模型"],
  ["soon", "即将支持"],
];

const cap = (m: AIModel, k: "tools" | "vision") => {
  const v = m[k];
  const label = k === "tools" ? "工具调用" : "看图";
  if (v === "yes") return <span className="ai-cap yes">{label}</span>;
  if (v === "no") return <span className="ai-cap no">不支持{label}</span>;
  if (k === "vision" && m.declared === "yes")
    return (
      <span
        className="ai-cap decl"
        title="供应商的模型列表声明支持，测试后才确认"
      >
        看图（声明）
      </span>
    );
  return <span className="ai-cap unk">{label}未测</span>;
};

const ctxText = (n?: number) =>
  n
    ? n >= 1e6
      ? `${+(n / 1e6).toFixed(1)}M`
      : `${Math.round(n / 1000)}K`
    : "";

const SWATCHES = [
  "#5856d6",
  "#0a84ff",
  "#30b0c7",
  "#34c759",
  "#ff9f0a",
  "#ff6b35",
  "#ff375f",
  "#af52de",
  "#636366",
  "#1d1d1f",
];

function ModelDiagPopover({
  m,
  providerName,
  providerApi,
  onSwitchToChat,
  children,
}: {
  m: AIModel;
  providerName?: string;
  providerApi?: string;
  onSwitchToChat?: () => void;
  children: React.ReactNode;
}) {
  const diag = m.test_diag;
  const isBad = !m.test_ok;
  const isWarn = !!m.test_ok && !!m.test_warn;
  const hasTokens =
    diag?.in_tokens != null ||
    diag?.out_tokens != null ||
    diag?.cached_tokens != null;
  const statusParts = [
    diag?.http_status != null
      ? diag.http_status > 0
        ? `HTTP ${diag.http_status}`
        : "网络未连通"
      : "",
    diag?.upstream_status ? `上游状态 ${diag.upstream_status}` : "",
    diag?.reason_code ? reasonCodeLabel(diag.reason_code) : "",
  ].filter(Boolean);
  const latency = diag?.ms ?? m.test_ms;
  const suggestChat =
    providerApi === "responses" &&
    (isWarn ||
      diag?.api === "responses" ||
      diag?.reason_code === "empty_output");

  return (
    <Popover
      trigger="click"
      position="bl"
      triggerProps={{ autoFitPosition: true }}
      content={
        <div className="ai-diag-pop">
          <div className="ai-diag-h">
            <span
              className={`ai-diag-badge ${isBad ? "bad" : isWarn ? "warn" : "ok"}`}
            >
              {isBad ? (
                <>
                  <IconCloseCircleFill /> 测试未通过
                </>
              ) : isWarn ? (
                <>
                  <IconExclamationCircleFill /> 连通
                  {m.test_ms ? ` ${m.test_ms} ms` : ""} · 兼容告警
                </>
              ) : (
                <>
                  <IconCheckCircleFill /> 连通
                  {m.test_ms ? ` ${m.test_ms} ms` : ""}
                </>
              )}
            </span>
            <code className="ai-diag-mid" title={m.id}>
              {m.id}
            </code>
            <span className="ai-sp" />
            <button
              type="button"
              className="ai-diag-copy"
              onClick={() =>
                copy(
                  formatAICallDiag(diag, {
                    title: isBad
                      ? "模型连通测试失败诊断"
                      : isWarn
                        ? "模型连通测试兼容告警"
                        : "模型连通测试诊断",
                    provider: providerName,
                    model: m.id,
                    testedAt: m.tested ? fullTime(m.tested) : undefined,
                    warn: m.test_warn,
                    error: isBad ? m.test_err : undefined,
                    ms: m.test_ms,
                  }),
                )
              }
            >
              <IconCopy /> 复制诊断
            </button>
          </div>

          {isBad && m.test_err && (
            <div className="ai-diag-alert bad">
              <b>错误摘要</b>
              <p>{m.test_err}</p>
              {suggestChat && (
                <small>
                  当前供应商配置为 Responses 接口；若使用 Magpie / OneAPI
                  等中转网关，建议切换为「Chat Completions（通用）」。
                </small>
              )}
              {suggestChat && onSwitchToChat && (
                <div>
                  <Button size="small" type="outline" onClick={onSwitchToChat}>
                    切换为 Chat Completions（通用）
                  </Button>
                </div>
              )}
            </div>
          )}

          {isWarn && m.test_warn && (
            <div className="ai-diag-alert warn">
              <b>网关协议兼容告警</b>
              <p>{m.test_warn}</p>
              <small>
                建议将该供应商的「接口方式」改为「Chat
                Completions（通用）」，避免每次调用先走 Responses
                空流再自动回退重试。
              </small>
              {onSwitchToChat && providerApi === "responses" && (
                <div>
                  <Button size="small" type="outline" onClick={onSwitchToChat}>
                    切换为 Chat Completions（通用）
                  </Button>
                </div>
              )}
            </div>
          )}

          <dl className="ai-diag-dl">
            {(diag?.endpoint || diag?.api) && (
              <>
                <dt>协议端点</dt>
                <dd>
                  <span className="mono">{diag.endpoint || diag.api}</span>
                  {diag.fallback_used && (
                    <span className="ai-diag-fb">
                      已回退 <span className="mono">{diag.fallback_used}</span>
                    </span>
                  )}
                </dd>
              </>
            )}
            {statusParts.length > 0 && (
              <>
                <dt>HTTP 状态</dt>
                <dd>{statusParts.join(" · ")}</dd>
              </>
            )}
            {(latency != null || m.tested) && (
              <>
                <dt>耗时</dt>
                <dd className="num">
                  {latency != null ? `${latency} ms` : "—"}
                  {m.tested ? (
                    <span className="faint"> · {fullTime(m.tested)}</span>
                  ) : null}
                </dd>
              </>
            )}
            {hasTokens && (
              <>
                <dt>Token</dt>
                <dd className="num">
                  输入 {diag?.in_tokens ?? 0}
                  {diag?.cached_tokens != null
                    ? ` · 缓存 ${diag.cached_tokens}`
                    : ""}
                  {` · 输出 ${diag?.out_tokens ?? 0}`}
                </dd>
              </>
            )}
            {diag?.response_id && (
              <>
                <dt>响应 ID</dt>
                <dd className="mono">{diag.response_id}</dd>
              </>
            )}
            {diag?.sse_events && diag.sse_events.length > 0 && (
              <>
                <dt>SSE 事件</dt>
                <dd>
                  <span className="mono">{diag.sse_events.join(" → ")}</span>
                  {diag.keepalives ? (
                    <span className="faint">{`（心跳 ${diag.keepalives} 次）`}</span>
                  ) : null}
                </dd>
              </>
            )}
          </dl>

          {diag?.attempts && diag.attempts.length > 0 && (
            <div className="ai-diag-sec">
              <div className="ai-diag-sec-t">
                重试与回退链路（{diag.attempts.length} 次）
              </div>
              <ol className="ai-diag-attempts">
                {diag.attempts.map((a, idx) => (
                  <li key={idx}>
                    <span className="ai-diag-att-api">{a.api}</span>
                    <code className="ai-diag-att-ep">{a.endpoint}</code>
                    <span
                      className={`ai-diag-att-st ${a.http_status && a.http_status >= 200 && a.http_status < 300 ? "ok" : "bad"}`}
                    >
                      {a.http_status ? `HTTP ${a.http_status}` : "连接失败"}
                    </span>
                    <span className="num">{a.ms} ms</span>
                    {(a.in_tokens != null || a.out_tokens != null) && (
                      <span className="num">
                        ↓{a.in_tokens ?? 0}
                        {a.cached_tokens ? ` 缓${a.cached_tokens}` : ""} ↑
                        {a.out_tokens ?? 0}
                      </span>
                    )}
                    {a.upstream_status && <span>状态 {a.upstream_status}</span>}
                    {a.response_id && (
                      <code className="faint">{a.response_id}</code>
                    )}
                    {(a.reason || a.request_note) && (
                      <span className="ai-diag-att-why">
                        {a.reason || a.request_note}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {diag?.request_summary && (
            <div className="ai-diag-sec">
              <div className="ai-diag-sec-t">请求参数摘要</div>
              <pre className="ai-diag-raw">
                {prettyDiagPayload(diag.request_summary)}
              </pre>
            </div>
          )}

          {diag?.response_raw && (
            <div className="ai-diag-sec">
              <div className="ai-diag-sec-t">网关原始响应</div>
              <pre className="ai-diag-raw">
                {prettyDiagPayload(diag.response_raw)}
              </pre>
            </div>
          )}

          {!diag && (
            <p className="ai-diag-empty faint">
              在「管理模型」中重新点击测试按钮，可采集网关端点、HTTP
              状态、响应 ID 与原始返回帧。
            </p>
          )}
        </div>
      }
    >
      {children}
    </Popover>
  );
}

/** How a provider is drawn: a picture of its own, a vendor's logo, or a coloured letter. */
function IconPick({
  p,
  presets,
  set,
}: {
  p: Partial<AIProvider>;
  presets: Preset[];
  set: (f: Partial<AIProvider>) => void;
}) {
  const [open, setOpen] = useState(false);
  const upload = (f?: File) => {
    if (!f) return;
    if (f.size > 150 << 10) return Message.warning("图片不能超过 150 KiB");
    const r = new FileReader();
    r.onload = () => {
      set({ icon: String(r.result) });
      setOpen(false);
    };
    r.readAsDataURL(f);
  };
  return (
    <Popover
      trigger="click"
      position="bl"
      popupVisible={open}
      onVisibleChange={setOpen}
      content={
        <div className="ip">
          <div className="ip-h">
            <b>图标</b>
            <label className="ip-up">
              上传图片…
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                hidden
                onChange={(e) => upload(e.target.files?.[0])}
              />
            </label>
            {p.icon && (
              <button
                type="button"
                className="ip-clear"
                onClick={() => set({ icon: "" })}
              >
                去掉图标
              </button>
            )}
          </div>
          <div className="ip-grid">
            {presets
              .filter((x) => x.id !== "custom")
              .map((x) => (
                <Tooltip key={x.id} content={x.name} mini>
                  <button
                    type="button"
                    className={p.icon === `preset:${x.id}` ? "on" : ""}
                    onClick={() => (
                      set({ icon: `preset:${x.id}` }),
                      setOpen(false)
                    )}
                    aria-label={`使用 ${x.name} 的图标`}
                  >
                    <ProviderLogo preset={x.id} name={x.name} size={22} />
                  </button>
                </Tooltip>
              ))}
          </div>
          <div className="ip-h">
            <b>没有图标时的颜色</b>
          </div>
          <div className="ip-sw">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={p.color === c ? "on" : ""}
                style={{ background: c }}
                onClick={() =>
                  set({
                    color: c,
                    icon: p.icon?.startsWith("preset:") ? "" : p.icon,
                  })
                }
                aria-label={`颜色 ${c}`}
              />
            ))}
          </div>
        </div>
      }
    >
      <button type="button" className="ip-btn" aria-label="选择图标">
        <ProviderLogo
          preset={p.preset || ""}
          name={p.name}
          icon={p.icon}
          color={p.color}
          size={26}
        />
      </button>
    </Popover>
  );
}

/* ---------------------------------------------------------------- add / edit a provider */

function modelChannelPrefix(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "";
}

function chipModelName(m: AIModel, siblings: AIModel[]): string {
  const base = m.name || m.id;
  if (!m.name || m.name === m.id) return base;
  const dup = siblings.filter((x) => (x.name || x.id) === base);
  if (dup.length <= 1) return base;
  const ch = modelChannelPrefix(m.id);
  if (ch && dup.filter((x) => modelChannelPrefix(x.id) === ch).length === 1) {
    return `${m.name} · ${ch}`;
  }
  return `${m.name} (${m.id})`;
}

function normEffortsSig(efforts?: string[]): string {
  return efforts === undefined ? "__all__" : efforts.join(",");
}

function isProviderDirty(
  p: Partial<AIProvider>,
  models: AIModel[],
  key: string,
  snap: AIProvider | null,
): boolean {
  if (!snap?.id) return true;
  if (key.trim() !== "") return true;
  const trimUrl = (u?: string) => (u || "").trim().replace(/\/+$/, "");
  if ((p.name || "").trim() !== (snap.name || "").trim()) return true;
  if (trimUrl(p.url) !== trimUrl(snap.url)) return true;
  if ((p.api || "") !== (snap.api || "")) return true;
  if ((p.api_version || "") !== (snap.api_version || "")) return true;
  if ((p.preset || "") !== (snap.preset || "")) return true;
  if (!!p.private !== !!snap.private) return true;
  if (!!p.enabled !== !!snap.enabled) return true;
  if ((p.currency || "CNY") !== (snap.currency || "CNY")) return true;
  if ((p.icon || "") !== (snap.icon || "")) return true;
  if ((p.color || "") !== (snap.color || "")) return true;
  if ((p.timeout_sec || 0) !== (snap.timeout_sec || 0)) return true;
  if ((p.max_tokens || 0) !== (snap.max_tokens || 0)) return true;
  if (models.length !== snap.models.length) return true;
  for (let i = 0; i < models.length; i++) {
    const a = models[i];
    const b = snap.models[i];
    if (a.id.trim() !== b.id.trim()) return true;
    if ((a.name || "").trim() !== (b.name || "").trim()) return true;
    if (!!a.enabled !== !!b.enabled) return true;
    if (normEffortsSig(a.efforts) !== normEffortsSig(b.efforts)) return true;
    if ((a.think || "") !== (b.think || "")) return true;
    if ((a.price_in || 0) !== (b.price_in || 0)) return true;
    if ((a.price_out || 0) !== (b.price_out || 0)) return true;
    if ((a.price_cached || 0) !== (b.price_cached || 0)) return true;
  }
  return false;
}

function ProviderModal({
  open,
  presets,
  edit,
  close,
  saved,
}: {
  open: boolean;
  presets: Preset[];
  edit: AIProvider | null;
  close: () => void;
  saved: (p: AIProvider, auto?: boolean) => Promise<void> | void;
}) {
  const [step, setStep] = useState<"pick" | "form">("pick");
  const [savedProvider, setSavedProvider] = useState<AIProvider | null>(edit);
  const [p, setP] = useState<Partial<AIProvider>>({});
  const [key, setKey] = useState("");
  const [models, setModels] = useState<AIModel[]>([]);
  const [remote, setRemote] = useState<AIModel[]>([]);
  const [tab, setTab] = useState<"mine" | "remote">("mine");
  const [filter, setFilter] = useState("");
  const [newId, setNewId] = useState("");
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState("");
  const [more, setMore] = useState(false);
  const curId = savedProvider?.id;
  useEffect(() => {
    if (!open) return;
    setKey("");
    setRemote([]);
    setFilter("");
    setNewId("");
    setMore(false);
    setTab("mine");
    if (edit) {
      setSavedProvider(edit);
      setP({ ...edit });
      setModels(edit.models.map((m) => ({ ...m })));
      setStep("form");
    } else {
      setSavedProvider(null);
      setP({});
      setModels([]);
      setStep("pick");
    }
  }, [open, edit]);
  const preset = presets.find((x) => x.id === p.preset);
  const pick = (pr: Preset) => {
    if (pr.soon) return;
    setP({
      preset: pr.id,
      name: pr.id === "custom" ? "" : pr.name,
      url: pr.url,
      private: !!pr.private,
      enabled: true,
      currency: "CNY",
    });
    setStep("form");
  };
  const has = (mid: string) => models.some((m) => m.id === mid);
  const addModel = (m: AIModel) =>
    !has(m.id) && setModels((x) => [...x, { ...m, enabled: true }]);
  const patch = (mid: string, f: Partial<AIModel>) =>
    setModels((x) => x.map((m) => (m.id === mid ? { ...m, ...f } : m)));
  const fetchModels = async () => {
    setFetching(true);
    try {
      const r = await api<{ models: AIModel[] }>("/api/settings/ai/models", {
        method: "POST",
        body: JSON.stringify({
          id: curId,
          url: p.url,
          key,
          preset: p.preset,
          api_version: p.api_version,
        }),
      });
      setRemote(r.models || []);
      setTab("remote");
      if (!r.models?.length)
        Message.warning("供应商没有返回模型，请手填模型名");
    } catch (e) {
      err(e);
    } finally {
      setFetching(false);
    }
  };
  const isDirty = useMemo(
    () => isProviderDirty(p, models, key, savedProvider),
    [p, models, key, savedProvider],
  );
  const canSave =
    !!p.name?.trim() &&
    !!p.url?.trim() &&
    models.some((m) => m.enabled);

  const persistProvider = async (auto: boolean): Promise<AIProvider | null> => {
    if (!p.name?.trim()) {
      Message.warning("请先填写供应商名称");
      return null;
    }
    if (!p.url?.trim()) {
      Message.warning("请先填写接口地址");
      return null;
    }
    if (!models.some((m) => m.enabled)) {
      Message.warning("请至少启用一个模型");
      return null;
    }
    setBusy(true);
    try {
      const r = await api<AIProvider>(
        curId
          ? `/api/settings/ai/providers/${curId}`
          : "/api/settings/ai/providers",
        {
          method: curId ? "PUT" : "POST",
          body: JSON.stringify({ ...p, models, key }),
        },
      );
      setSavedProvider(r);
      setP({ ...r });
      setModels(r.models.map((m) => ({ ...m })));
      setKey("");
      await saved(r, auto);
      return r;
    } catch (e) {
      err(e);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const hadSavedId = !!curId;
    const r = await persistProvider(false);
    if (!r) return;
    if (edit || hadSavedId) {
      Message.success("已保存");
      close();
    } else {
      Message.success("已保存，现在可以逐个测试模型");
    }
  };

  const runSingleTest = async (
    providerId: string,
    mid: string,
  ): Promise<AIModel | null> => {
    const targetMid = mid.trim();
    setTesting(targetMid);
    try {
      const m = await api<AIModel>(
        `/api/settings/ai/providers/${providerId}/test?model=${encodeURIComponent(targetMid)}`,
        { method: "POST" },
      );
      const mergedPatch: Partial<AIModel> = {
        test_err: undefined,
        test_warn: undefined,
        test_diag: undefined,
        ...m,
      };
      setModels((xs) =>
        xs.map((x) => (x.id === targetMid ? { ...x, ...mergedPatch } : x)),
      );
      setSavedProvider((sp) =>
        sp
          ? {
              ...sp,
              models: sp.models.map((x) =>
                x.id === targetMid ? { ...x, ...mergedPatch } : x,
              ),
            }
          : sp,
      );
      return m;
    } catch (e) {
      err(e);
      return null;
    } finally {
      setTesting("");
    }
  };

  const ensureSavedForTest = async (): Promise<AIProvider | null> => {
    if (!savedProvider?.id || isDirty) {
      return await persistProvider(true);
    }
    return savedProvider;
  };

  const test = async (mid: string) => {
    const active = await ensureSavedForTest();
    if (!active?.id) return;
    const tested = await runSingleTest(active.id, mid);
    if (tested) await saved(active, true);
  };

  const testAll = async () => {
    const active = await ensureSavedForTest();
    if (!active?.id) return;
    let anyTested = false;
    for (const m of active.models.filter((x) => x.enabled)) {
      const res = await runSingleTest(active.id, m.id);
      if (res) anyTested = true;
    }
    if (anyTested) await saved(active, true);
  };

  const shown = useMemo(
    () =>
      remote.filter(
        (m) =>
          !filter.trim() ||
          (m.id + (m.name || ""))
            .toLowerCase()
            .includes(filter.trim().toLowerCase()),
      ),
    [remote, filter],
  );
  const needsAutoSave = !curId || isDirty;
  return (
    <Modal
      visible={open}
      onCancel={close}
      title={
        edit
          ? "编辑供应商"
          : step === "pick"
            ? "选择模型供应商"
            : `添加 ${preset?.name || ""}`
      }
      footer={step === "pick" ? null : undefined}
      onOk={save}
      confirmLoading={busy}
      okText="保存"
      okButtonProps={{
        disabled:
          !p.name?.trim() ||
          !p.url?.trim() ||
          models.filter((m) => m.enabled).length === 0,
      }}
      style={{ width: step === "pick" ? 760 : 820, maxWidth: "96vw" }}
    >
      {step === "pick" ? (
        <div className="ai-picker">
          {GROUPS.map(([g, label]) => {
            const items = presets.filter((x) => x.group === g);
            if (!items.length) return null;
            return (
              <section key={g}>
                <h3>{label}</h3>
                <div className="ai-grid">
                  {items.map((x) => (
                    <button
                      key={x.id}
                      type="button"
                      className={`ai-pick ${x.soon ? "soon" : ""}`}
                      disabled={x.soon}
                      onClick={() => pick(x)}
                    >
                      <ProviderLogo preset={x.id} name={x.name} size={22} />
                      <span>{x.name}</span>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
          <button
            type="button"
            className="ai-custom"
            onClick={() => pick(presets.find((x) => x.id === "custom")!)}
          >
            <IconPlus /> <b>自定义供应商</b>
            <span>任意 OpenAI 兼容的地址，里面可以管理很多模型</span>
          </button>
        </div>
      ) : (
        <div className="st-form">
          <div className="ai-two">
            <div className="st-field">
              <span>名称与图标</span>
              <div className="ai-namerow">
                <IconPick
                  p={p}
                  presets={presets}
                  set={(f) => setP({ ...p, ...f })}
                />
                <Input
                  value={p.name}
                  onChange={(v) => setP({ ...p, name: v })}
                  maxLength={40}
                  placeholder={
                    p.preset === "custom" ? "例如：公司内网网关" : ""
                  }
                  aria-label="名称"
                />
              </div>
            </div>
            <div className="st-field">
              <span>API Key</span>
              <Input.Password
                value={key}
                onChange={setKey}
                placeholder={
                  savedProvider?.key_set
                    ? `已保存（…${savedProvider.key_last4 || ""}），留空保持不变`
                    : p.private
                      ? "本地模型可留空"
                      : ""
                }
                autoComplete="new-password"
                aria-label="API Key"
              />
            </div>
          </div>
          <div className="st-field">
            <span>接口地址</span>
            <Input
              value={p.url}
              onChange={(v) => setP({ ...p, url: v })}
              placeholder="https://…/v1"
              aria-label="接口地址"
            />
            <small>
              {preset?.hint ||
                "OpenAI 兼容接口的根地址，平台会请求其下的 /chat/completions；密钥加密保存，保存后不再显示。"}
            </small>
          </div>
          <div className="st-field">
            <span>接口方式</span>
            <Select
              value={p.api || "chat"}
              onChange={(v) => setP({ ...p, api: v === "chat" ? "" : v })}
              aria-label="接口方式"
              triggerProps={{ autoFitPosition: true }}
            >
              <Select.Option value="chat">
                Chat Completions（通用）
              </Select.Option>
              <Select.Option value="responses">
                Responses（能显示模型的思考摘要）
              </Select.Option>
            </Select>
            <small>
              Responses 适用于原生 OpenAI 推理模型；若通过 Magpie / OneAPI
              等中转网关接入 Claude、DeepSeek、通义等模型，建议保持「Chat
              Completions（通用）」（Responses
              返回空流时平台也会自动回退重试）。
            </small>
          </div>

          <div className="ai-models">
            <div className="ai-models-h">
              <b>模型</b>
              <span className="faint small">
                {models.length
                  ? `已添加 ${models.length} 个，启用 ${models.filter((m) => m.enabled).length} 个`
                  : "还没有模型"}
              </span>
              <span className="ai-sp" />
              {models.some((m) => m.enabled) && (
                <Tooltip
                  content={
                    !canSave
                      ? "请先填写名称、接口地址并启用至少一个模型"
                      : needsAutoSave
                        ? "自动保存当前更改并测试所有已启用模型"
                        : "逐个测试所有已启用模型的连通、工具调用与看图能力"
                  }
                  mini
                >
                  <Button
                    size="small"
                    icon={<IconSend />}
                    loading={!!testing}
                    disabled={busy || !canSave}
                    onClick={() => void testAll()}
                  >
                    测试全部
                  </Button>
                </Tooltip>
              )}
              <Button
                size="small"
                icon={<IconRefresh />}
                loading={fetching}
                onClick={fetchModels}
                disabled={!p.url?.trim()}
              >
                获取模型列表
              </Button>
            </div>
            <UnderlineTabs
              className="ai-modal-tabs"
              label="模型来源"
              value={tab}
              onChange={setTab}
              items={[
                {
                  value: "mine",
                  label: "已添加",
                  count: models.length,
                  icon: AITabIcons.mine,
                },
                {
                  value: "remote",
                  label: "供应商列表",
                  count: remote.length || undefined,
                  icon: AITabIcons.remote,
                },
              ]}
            />
            {tab === "remote" ? (
              <div className="ai-remote">
                <div className="ai-remote-bar">
                  <Input
                    size="small"
                    allowClear
                    placeholder="筛选模型"
                    value={filter}
                    onChange={setFilter}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setFilter("");
                        (e.target as HTMLElement).blur();
                      }
                    }}
                    style={{ width: 200 }}
                    aria-label="筛选模型"
                  />
                  <Button
                    size="small"
                    onClick={() => shown.forEach(addModel)}
                    disabled={!shown.length}
                  >
                    全部添加
                  </Button>
                </div>
                {remote.length === 0 ? (
                  <p className="faint small">
                    点「获取模型列表」读取这个供应商提供的模型。
                  </p>
                ) : (
                  <div className="ai-chips">
                    {shown.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`ai-chip ${has(m.id) ? "on" : ""}`}
                        title={m.id}
                        onClick={() =>
                          has(m.id)
                            ? setModels((x) => x.filter((y) => y.id !== m.id))
                            : addModel(m)
                        }
                        aria-pressed={has(m.id)}
                      >
                        {has(m.id) ? <IconCheck /> : <IconPlus />}
                        <span>{chipModelName(m, remote)}</span>
                        {m.context ? <em>{ctxText(m.context)}</em> : null}
                        {m.declared === "yes" && <em className="v">看图</em>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="ai-add">
                  <Input
                    size="small"
                    value={newId}
                    onChange={setNewId}
                    placeholder="添加模型 ID，回车确认"
                    onPressEnter={() =>
                      newId.trim() &&
                      (addModel({ id: newId.trim(), enabled: true }),
                      setNewId(""))
                    }
                    aria-label="添加模型 ID"
                  />
                  <Button
                    size="small"
                    disabled={!newId.trim()}
                    onClick={() => (
                      addModel({ id: newId.trim(), enabled: true }),
                      setNewId("")
                    )}
                  >
                    添加模型
                  </Button>
                </div>
                {models.length > 0 && (
                  <div className="ai-mtable" role="table" aria-label="模型">
                    <div className="ai-mrow head" role="row">
                      <span />
                      <span>模型</span>
                      <span>能力</span>
                      <span title="用户在对话输入框里能选的思考档位">
                        思考档位
                      </span>
                      <span title="每百万 Token">输入价</span>
                      <span>缓存价</span>
                      <span>输出价</span>
                      <span />
                    </div>
                    {models.map((m) => (
                      <div
                        key={m.id}
                        className={`ai-mrow ${m.enabled ? "" : "off"}`}
                        role="row"
                      >
                        <Switch
                          size="small"
                          checked={m.enabled}
                          onChange={(v) => patch(m.id, { enabled: v })}
                          aria-label={`启用 ${m.id}`}
                        />
                        <span className="ai-mname">
                          <b title={m.id}>{m.name || m.id}</b>
                          {m.name && <small className="mono">{m.id}</small>}
                          {m.price_default && !m.price_in && !m.price_out && (
                            <small
                              className="ai-defprice"
                              title={`${m.price_default.vendor} 官方价（每百万 Token，输入 / 缓存 / 输出）`}
                            >
                              官方价{" "}
                              {m.price_default.currency === "USD" ? "$" : "¥"}
                              {m.price_default.in} / {m.price_default.cached} /{" "}
                              {m.price_default.out}
                            </small>
                          )}
                          {(m.tested || m.test_err || m.test_diag) &&
                            (!m.test_ok ? (
                              <div className="ai-mtest is-bad">
                                <span
                                  className="ai-mtest-sum"
                                  title={m.test_err}
                                >
                                  <IconCloseCircleFill />
                                  <span>
                                    {m.test_err || "测试未通过"}
                                    {m.tested ? ` · ${ago(m.tested)}` : ""}
                                  </span>
                                </span>
                                <ModelDiagPopover
                                  m={m}
                                  providerName={p.name}
                                  providerApi={p.api || "chat"}
                                  onSwitchToChat={() => {
                                    setP({ ...p, api: "" });
                                    Message.info(
                                      "已切换为 Chat Completions（通用），可直接重新测试或点击右下角「保存」",
                                    );
                                  }}
                                >
                                  <button
                                    type="button"
                                    className="ai-diag-trig bad"
                                  >
                                    诊断详情
                                  </button>
                                </ModelDiagPopover>
                              </div>
                            ) : m.test_warn ? (
                              <div className="ai-mtest is-warn">
                                <ModelDiagPopover
                                  m={m}
                                  providerName={p.name}
                                  providerApi={p.api || "chat"}
                                  onSwitchToChat={() => {
                                    setP({ ...p, api: "" });
                                    Message.info(
                                      "已切换为 Chat Completions（通用），可直接重新测试或点击右下角「保存」",
                                    );
                                  }}
                                >
                                  <button
                                    type="button"
                                    className="ai-mtest-warnbtn"
                                  >
                                    <IconExclamationCircleFill />
                                    <span>
                                      连通
                                      {m.test_ms ? ` ${m.test_ms} ms` : ""} ·
                                      兼容告警
                                      {m.tested ? ` · ${ago(m.tested)}` : ""}
                                    </span>
                                    <em>诊断详情</em>
                                  </button>
                                </ModelDiagPopover>
                              </div>
                            ) : (
                              <div className="ai-mtest is-ok">
                                <small
                                  className="ok"
                                  title={m.tested ? fullTime(m.tested) : ""}
                                >
                                  <IconCheckCircleFill /> 连通 {m.test_ms} ms
                                  {m.tested ? ` · ${ago(m.tested)}` : ""}
                                </small>
                                {m.test_diag && (
                                  <ModelDiagPopover
                                    m={m}
                                    providerName={p.name}
                                    providerApi={p.api || "chat"}
                                  >
                                    <button
                                      type="button"
                                      className="ai-diag-trig subtle"
                                    >
                                      详情
                                    </button>
                                  </ModelDiagPopover>
                                )}
                              </div>
                            ))}
                        </span>
                        <span className="ai-caps">
                          {cap(m, "tools")}
                          {cap(m, "vision")}
                          {m.context ? (
                            <span className="ai-cap unk">
                              {ctxText(m.context)}
                            </span>
                          ) : null}
                        </span>
                        <Popover
                          trigger="click"
                          position="bl"
                          triggerProps={{ autoFitPosition: true }}
                          content={
                            <div className="ai-eff">
                              <b>可选的思考档位</b>
                              <small>
                                用户在输入框里选，选到哪档，就把对应的参数（reasoning_effort）传给模型；模型不认的档位不会有效果，也不会报错。
                              </small>
                              <Checkbox.Group
                                value={m.efforts ?? EFFORTS.map((e) => e.id)}
                                onChange={(v) =>
                                  patch(m.id, {
                                    efforts: EFFORTS.map((e) => e.id).filter(
                                      (e) => (v as string[]).includes(e),
                                    ),
                                  })
                                }
                                options={EFFORTS.map((e) => ({
                                  value: e.id,
                                  label:
                                    e.name === e.id
                                      ? e.id
                                      : `${e.name}（${e.id}）`,
                                }))}
                                direction="vertical"
                              />
                              <Button
                                size="small"
                                type="text"
                                onClick={() =>
                                  patch(m.id, {
                                    efforts: undefined,
                                    think: undefined,
                                  })
                                }
                              >
                                恢复默认（全部）
                              </Button>
                            </div>
                          }
                        >
                          <button
                            type="button"
                            className="ai-eff-btn"
                            aria-label={`${m.id} 思考档位`}
                          >
                            {m.efforts === undefined
                              ? "全部 6 档"
                              : m.efforts.length
                                ? `${m.efforts.length} 档`
                                : "不提供"}
                          </button>
                        </Popover>
                        <InputNumber
                          size="small"
                          min={0}
                          precision={3}
                          hideControl
                          value={m.price_in || undefined}
                          onChange={(v) =>
                            patch(m.id, { price_in: Number(v) || 0 })
                          }
                          placeholder={
                            m.price_default ? String(m.price_default.in) : "—"
                          }
                          aria-label={`${m.id} 输入价`}
                        />
                        <InputNumber
                          size="small"
                          min={0}
                          precision={3}
                          hideControl
                          value={m.price_cached || undefined}
                          onChange={(v) =>
                            patch(m.id, { price_cached: Number(v) || 0 })
                          }
                          placeholder={
                            m.price_default
                              ? String(m.price_default.cached)
                              : "同输入"
                          }
                          aria-label={`${m.id} 缓存价`}
                        />
                        <InputNumber
                          size="small"
                          min={0}
                          precision={3}
                          hideControl
                          value={m.price_out || undefined}
                          onChange={(v) =>
                            patch(m.id, { price_out: Number(v) || 0 })
                          }
                          placeholder={
                            m.price_default ? String(m.price_default.out) : "—"
                          }
                          aria-label={`${m.id} 输出价`}
                        />
                        <span className="ai-macts">
                          <Tooltip
                            content={
                              !canSave
                                ? "请先填写名称、地址并启用至少一个模型"
                                : needsAutoSave
                                  ? "自动保存当前更改并测试连通、工具调用与看图"
                                  : "测试连通、工具调用、看图"
                            }
                            mini
                          >
                            <Button
                              size="small"
                              icon={<IconSend />}
                              loading={testing === m.id}
                              disabled={
                                busy ||
                                (!!testing && testing !== m.id) ||
                                !canSave
                              }
                              onClick={() => void test(m.id)}
                              aria-label={`测试 ${m.id}`}
                            />
                          </Tooltip>
                          <Button
                            size="small"
                            status="danger"
                            icon={<IconClose />}
                            onClick={() =>
                              setModels((x) => x.filter((y) => y.id !== m.id))
                            }
                            aria-label={`移除 ${m.id}`}
                          />
                        </span>
                      </div>
                    ))}
                    <p className="ai-note">
                      留空就用平台内置的官方价格（见「模型价格」页）；在这里填的价格优先，币种见「更多设置」。看图要点测试才能确认。
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          <button
            type="button"
            className="ai-more"
            onClick={() => setMore(!more)}
            aria-expanded={more}
          >
            更多设置 {more ? "▾" : "▸"}
          </button>
          {more && (
            <div className="ai-moreform">
              {p.preset === "azure" && (
                <div className="st-field">
                  <span>API 版本</span>
                  <Input
                    value={p.api_version}
                    onChange={(v) => setP({ ...p, api_version: v })}
                    placeholder="2024-10-21"
                    aria-label="API 版本"
                  />
                </div>
              )}
              <div className="ai-three">
                <label>
                  超时（秒）
                  <InputNumber
                    min={10}
                    max={600}
                    value={p.timeout_sec || 120}
                    onChange={(v) => setP({ ...p, timeout_sec: Number(v) })}
                    aria-label="超时"
                  />
                </label>
                <label>
                  单次输出上限（Token，0 不限）
                  <InputNumber
                    min={0}
                    max={200000}
                    step={500}
                    value={p.max_tokens || 0}
                    onChange={(v) => setP({ ...p, max_tokens: Number(v) })}
                    aria-label="输出上限"
                  />
                </label>
                <label>
                  价格币种
                  <Select
                    value={p.currency || "CNY"}
                    onChange={(v) => setP({ ...p, currency: v })}
                    options={[
                      { value: "CNY", label: "人民币 ¥" },
                      { value: "USD", label: "美元 $" },
                    ]}
                    aria-label="币种"
                    triggerProps={{ autoFitPosition: true }}
                  />
                </label>
              </div>
              <label className="ai-check">
                <Switch
                  size="small"
                  checked={!!p.private}
                  onChange={(v) => setP({ ...p, private: v })}
                />{" "}
                部署在本单位内网，数据不出网
              </label>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------- the page */

type AssignGroup = { p: AIProvider; models: AIModel[] };

function assignModelLabel(m: AIModel, siblings: AIModel[]): string {
  const base = m.name || m.id.replace(/^.*\//, "");
  if (!m.name || m.name === m.id) return base;
  const dup = siblings.filter(
    (x) => (x.name || x.id.replace(/^.*\//, "")) === base,
  );
  if (dup.length <= 1) return base;
  const ch = modelChannelPrefix(m.id);
  if (ch && dup.filter((x) => modelChannelPrefix(x.id) === ch).length === 1) {
    return `${m.name} · ${ch}`;
  }
  const shortId = m.id.replace(/^.*\//, "");
  return shortId && shortId !== m.name
    ? `${m.name} · ${shortId}`
    : `${m.name} · ${m.id}`;
}

function AssignModelPicker({
  value,
  placeholder,
  clearLabel,
  disabled,
  align = "start",
  groups,
  onChange,
  label,
}: {
  value?: string;
  placeholder: string;
  clearLabel: string;
  disabled?: boolean;
  align?: "start" | "end";
  groups: AssignGroup[];
  onChange: (v: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const cur = useMemo(() => {
    if (!value) return null;
    const [pid, mid] = value.split("|");
    for (const g of groups) {
      if (g.p.id !== pid) continue;
      const m = g.models.find((x) => x.id === mid);
      if (m) return { p: g.p, m, models: g.models };
    }
    return null;
  }, [value, groups]);

  const curText = cur ? assignModelLabel(cur.m, cur.models) : placeholder;
  const fullTitle = cur
    ? `${cur.p.name} · ${cur.m.name ? `${cur.m.name} (${cur.m.id})` : cur.m.id}`
    : placeholder;

  const trigger = (
    <div
      role="combobox"
      aria-expanded={!disabled && open}
      aria-haspopup="listbox"
      aria-disabled={disabled || undefined}
      aria-label={label}
      tabIndex={disabled ? -1 : 0}
      title={fullTitle}
      className={`ai-mp ${open ? "is-open" : ""} ${disabled ? "is-disabled" : ""}`}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
          e.preventDefault();
          setOpen((v) => !v);
        } else if (e.key === "Escape" && open) {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      {cur && (
        <ProviderLogo
          preset={cur.p.preset}
          icon={cur.p.icon}
          color={cur.p.color}
          name={cur.p.name}
          size={16}
        />
      )}
      <span className={`ai-mp-txt ${cur ? "" : "ph"}`}>{curText}</span>
      <span className="ai-mp-acts">
        {cur && !disabled && (
          <button
            type="button"
            className="ai-mp-clear"
            aria-label={`清空${label}`}
            title={clearLabel}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onChange("");
              setOpen(false);
            }}
          >
            <IconClose />
          </button>
        )}
        <IconDown className={`ai-mp-chev ${open ? "open" : ""}`} />
      </span>
    </div>
  );

  if (disabled) return trigger;

  return (
    <Popover
      trigger="click"
      position={align === "end" ? "br" : "bl"}
      popupVisible={open}
      onVisibleChange={setOpen}
      className="ai-mp-pop-wrap"
      triggerProps={{ autoFitPosition: true, showArrow: false }}
      content={
        <div className="ai-mp-pop" role="listbox" aria-label={label}>
          {groups.length === 0 ? (
            <div className="ai-mp-empty">
              暂无已启用模型，请先在供应商中添加并启用模型
            </div>
          ) : (
            <>
              <button
                type="button"
                role="option"
                aria-selected={!cur}
                className={`ai-mp-opt ai-mp-opt-reset ${!cur ? "on" : ""}`}
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                <span className="ai-mp-opt-t">
                  <b>{clearLabel}</b>
                </span>
                {!cur && <IconCheck className="ai-mp-check" />}
              </button>
              {groups.map(({ p, models }) => (
                <div key={p.id} className="ai-mp-grp">
                  <div className="ai-mp-grp-h">
                    <ProviderLogo
                      preset={p.preset}
                      icon={p.icon}
                      color={p.color}
                      name={p.name}
                      size={14}
                    />
                    <span>{p.name}</span>
                  </div>
                  {models.map((m) => {
                    const ref = `${p.id}|${m.id}`;
                    const isOn = value === ref;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={isOn}
                        className={`ai-mp-opt ${isOn ? "on" : ""}`}
                        onClick={() => {
                          onChange(ref);
                          setOpen(false);
                        }}
                      >
                        <ProviderLogo
                          preset={p.preset}
                          icon={p.icon}
                          color={p.color}
                          name={p.name}
                          size={18}
                        />
                        <span className="ai-mp-opt-t">
                          <b>{assignModelLabel(m, models)}</b>
                          <small className="mono">{m.id}</small>
                        </span>
                        <span className="ai-mp-opt-caps">
                          {m.vision === "yes" && <em>看图</em>}
                          {m.tools === "no" && <em className="no">无工具</em>}
                        </span>
                        {isOn && <IconCheck className="ai-mp-check" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </div>
      }
    >
      {trigger}
    </Popover>
  );
}

export function AISettingsView() {
  const canEdit = can("ai.settings");
  const globalStatus = useAIStatus();
  const [d, setD] = useState<AISettings | null>(() =>
    canEdit ? cached<AISettings>("/api/settings/ai") ?? null : null,
  );
  const [modal, setModal] = useState<{ edit: AIProvider | null } | null>(null);
  const [error, setError] = useState("");
  const [toggling, setToggling] = useState(false);
  const [pane, setPane] = useState<
    "all" | "providers" | "features" | "boundary"
  >("all");
  const load = (fresh = false) => {
    if (!canEdit) return Promise.resolve(null);
    return (fresh ? api : fetchCached)<AISettings>("/api/settings/ai")
      .then((r) => {
        putCached("/api/settings/ai", r);
        setD(r);
        setError("");
        return r;
      })
      .catch((e) => {
        setError((e as Error).message);
        return null;
      });
  };
  useEffect(() => {
    void load();
  }, [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  const validRefs = useMemo(() => {
    const s = new Set<string>();
    for (const p of d?.providers || []) {
      for (const m of p.models) {
        s.add(`${p.id}|${m.id}`);
      }
    }
    return s;
  }, [d?.providers]);
  const optionGroups = useMemo(
    () =>
      (d?.providers || [])
        .map((p) => ({ p, models: p.models.filter((m) => m.enabled) }))
        .filter((g) => g.models.length),
    [d?.providers],
  );
  const selectableRefs = useMemo(() => {
    const s = new Set<string>();
    for (const { p, models } of optionGroups) {
      for (const m of models) {
        s.add(`${p.id}|${m.id}`);
      }
    }
    return s;
  }, [optionGroups]);
  const allEnabledRefs = useMemo(() => [...selectableRefs], [selectableRefs]);

  const put = async (next: AISettings) => {
    if (!canEdit) return;
    const refsNow = new Set<string>();
    for (const p of next.providers || []) {
      for (const m of p.models) {
        refsNow.add(`${p.id}|${m.id}`);
      }
    }
    const resolveValidRef = (ref?: string) => {
      if (!ref) return "";
      if (!ref.includes("|")) {
        const p = (next.providers || []).find((x) => x.id === ref);
        const m = p?.models.find((x) => x.enabled) || p?.models[0];
        return p && m ? `${p.id}|${m.id}` : "";
      }
      return refsNow.has(ref) ? ref : "";
    };
    const cleanFeatures: Record<string, Feature> = {};
    for (const [k, fv] of Object.entries(next.features || {})) {
      const pri = resolveValidRef(fv.primary);
      const bak = resolveValidRef(fv.backup);
      cleanFeatures[k] = {
        enabled: fv.enabled,
        ...(pri ? { primary: pri } : {}),
        ...(bak ? { backup: bak } : {}),
      };
    }
    const seenUm = new Set<string>();
    const cleanUserModels = (next.user_models || []).filter((r) => {
      if (!refsNow.has(r) || seenUm.has(r)) return false;
      seenUm.add(r);
      return true;
    });
    const cleaned: AISettings = {
      ...next,
      features: cleanFeatures,
      user_models: cleanUserModels,
    };
    const prev = d;
    putCached("/api/settings/ai", cleaned);
    setD(cleaned);
    try {
      await api("/api/settings/ai", {
        method: "PUT",
        body: JSON.stringify({
          enabled: cleaned.enabled,
          features: cleaned.features,
          redact_hosts: cleaned.redact_hosts,
          private_only: cleaned.private_only,
          monthly_limit: cleaned.monthly_limit,
          user_models: cleaned.user_models,
        }),
      });
      await refreshAIStatus();
    } catch (e) {
      setD(prev);
      err(e);
    }
  };
  const remove = (p: AIProvider) =>
    Modal.confirm({
      title: `删除「${p.name}」？`,
      content: "用到它的功能会改用备用或其他可用的模型。",
      okButtonProps: { status: "danger" },
      okText: "删除",
      onOk: async () => {
        try {
          await api(`/api/settings/ai/providers/${p.id}`, { method: "DELETE" });
          await load(true);
          await refreshAIStatus();
        } catch (e) {
          err(e);
        }
      },
    });
  const toggle = async (p: AIProvider) => {
    try {
      await api(`/api/settings/ai/providers/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...p, enabled: !p.enabled }),
      });
      await load(true);
      await refreshAIStatus();
    } catch (e) {
      err(e);
    }
  };
  // an assignment is "<provider>|<model>"; bare provider IDs resolve to their first enabled model, and stale/deleted refs fall back cleanly to undefined
  const norm = (ref?: string) => {
    if (!ref) return undefined;
    if (!ref.includes("|")) {
      const p = d?.providers.find((x) => x.id === ref);
      const m = p?.models.find((x) => x.enabled);
      return p && m ? `${p.id}|${m.id}` : undefined;
    }
    if (!validRefs.has(ref) || !selectableRefs.has(ref)) return undefined;
    return ref;
  };
  const find = (ref?: string) => {
    const [pid, mid] = (norm(ref) || "").split("|");
    const p = d?.providers.find((x) => x.id === pid);
    return { p, m: p?.models.find((x) => x.id === mid) };
  };
  const picker = (
    value: string | undefined,
    placeholder: string,
    clearLabel: string,
    align: "start" | "end",
    onChange: (v: string) => void,
    label: string,
  ) => (
    <AssignModelPicker
      value={norm(value)}
      placeholder={placeholder}
      clearLabel={clearLabel}
      align={align}
      disabled={!canEdit}
      groups={optionGroups}
      onChange={onChange}
      label={label}
    />
  );
  const flipMaster = async (enabled: boolean) => {
    if (!canEdit || !d || toggling) return;
    const prev = d;
    setToggling(true);
    setD({ ...d, enabled });
    try {
      const res = await api<AIStatus>("/api/ai/toggle", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      await refreshAIStatus();
      if (enabled) {
        if (res.enabled) {
          Message.success("AI 能力套件已启用");
        } else {
          Message.info("AI 套件总开关已开启，请先配置并启用模型供应商");
        }
      } else {
        Message.info("AI 能力套件已停用");
      }
    } catch (e) {
      setD(prev);
      err(e);
    } finally {
      setToggling(false);
    }
  };
  const activeModelsCount = (d?.providers || [])
    .filter((p) => p.enabled)
    .reduce((sum, p) => sum + p.models.filter((m) => m.enabled).length, 0);
  const masterChecked = canEdit
    ? !!d?.enabled
    : !!(globalStatus.master_enabled ?? globalStatus.enabled);
  const suiteLive = canEdit
    ? !!d?.enabled && activeModelsCount > 0
    : !!globalStatus.enabled;
  const suitePending = canEdit
    ? !!d?.enabled && activeModelsCount === 0
    : !!(globalStatus.master_enabled && !globalStatus.enabled);
  const showProviders = pane === "all" || pane === "providers";
  const showFeatures = pane === "all" || pane === "features";
  const showBoundary = pane === "all" || pane === "boundary";
  return (
    <article className="sx-page st-main ai-settings enter">
      <header className="sx-page-h">
        <div>
          <h1>AI 套件与模型</h1>
          <p>
            AI
            只读取、分析和建议，不会直接改动任何东西。密码、密钥、证书不会发给模型。
          </p>
        </div>
      </header>
      {!canEdit ? (
        <>
          <section
            className={`ai-master-card ${suiteLive ? "is-on" : suitePending ? "is-warn" : "is-off"}`}
            aria-label="AI 能力套件总开关"
          >
            <div className="ai-master-main">
              <span className="ai-master-icon" aria-hidden>
                <Spark size={17} rainbow={suiteLive} />
              </span>
              <div className="ai-master-copy">
                <div className="ai-master-title-row">
                  <strong>AI 能力套件总开关</strong>
                  <span
                    className={`ai-master-pill ${suiteLive ? "is-on" : suitePending ? "is-warn" : "is-off"}`}
                  >
                    <i />
                    {suiteLive
                      ? "已启用"
                      : suitePending
                        ? "已开启 · 待配置模型"
                        : "未启用"}
                  </span>
                </div>
                <p>
                  统一控制全平台的 AI 助手、知识库、技能、MCP
                  服务、组件辅助编写与已运行集群的变更演练。
                </p>
              </div>
            </div>
            <div className="ai-master-ctrl">
              <Switch
                checked={masterChecked}
                disabled
                checkedText="已启用"
                uncheckedText="未启用"
                aria-label="启用 AI 能力套件（只读）"
              />
            </div>
          </section>
          <div className="ai-readonly-note" role="status">
            当前账号仅具备只读查看权限；如需启停 AI 能力套件、管理模型供应商或调整数据安全边界，请联系拥有「AI 设置」权限的管理员。
          </div>
        </>
      ) : (
        <>
          {error && (
            <div className="note warn" role="alert">
              <span>{error}</span>
              <Button
                size="small"
                icon={<IconRefresh />}
                onClick={() => void load(true)}
                style={{ marginLeft: 12 }}
              >
                重试
              </Button>
            </div>
          )}
          {!d && !error && (
            <div className="ai-skel" aria-label="载入中">
              <Skeleton
                animation
                text={{
                  rows: 6,
                  width: ["38%", "82%", "65%", "90%", "74%", "52%"],
                }}
              />
            </div>
          )}
          {d && (
            <>
              <section
                className={`ai-master-card ${suiteLive ? "is-on" : suitePending ? "is-warn" : "is-off"}`}
                aria-label="AI 能力套件总开关"
              >
                <div className="ai-master-main">
                  <span className="ai-master-icon" aria-hidden>
                    <Spark size={17} rainbow={suiteLive} />
                  </span>
                  <div className="ai-master-copy">
                    <div className="ai-master-title-row">
                      <strong>AI 能力套件总开关</strong>
                      <span
                        className={`ai-master-pill ${suiteLive ? "is-on" : suitePending ? "is-warn" : "is-off"}`}
                      >
                        <i />
                        {suiteLive
                          ? `已启用 · ${activeModelsCount} 个可用模型`
                          : suitePending
                            ? "已开启 · 待配置模型"
                            : "未启用"}
                      </span>
                    </div>
                    <p>
                      统一控制全平台的 AI 助手、知识库、技能、MCP
                      服务、组件辅助编写与已运行集群的变更演练。右上角状态栏向全体成员只读展示当前套件状态。
                    </p>
                  </div>
                </div>
                <div className="ai-master-ctrl">
                  <Switch
                    checked={d.enabled}
                    loading={toggling}
                    onChange={flipMaster}
                    checkedText="已启用"
                    uncheckedText="未启用"
                    aria-label="启用 AI 能力套件"
                  />
                </div>
              </section>
              {!d.enabled && (
                <div className="ai-paused-note" role="status">
                  当前总开关处于关闭状态，全平台 AI 入口已收起；下方供应商与功能模型预设可正常编辑保存，开启总开关后立即生效。
                </div>
              )}
              <UnderlineTabs
                className="ai-view-tabs"
                label="AI 设置分类"
                value={pane}
                onChange={setPane}
                items={[
                  { value: "all", label: "全部设置", icon: AITabIcons.all },
                  {
                    value: "providers",
                    label: "供应商与可选模型",
                    count: d.providers.length,
                    icon: AITabIcons.remote,
                  },
                  {
                    value: "features",
                    label: "场景默认模型",
                    count: d.feature_list.length,
                    icon: AITabIcons.features,
                  },
                  {
                    value: "boundary",
                    label: "数据边界",
                    icon: AITabIcons.boundary,
                  },
                ]}
              />
              {showProviders && (
                <>
                  <section className="sx-sec">
                    <div className="ai-sec-h">
                      <h2>模型供应商</h2>
                      <Button
                        type="primary"
                        icon={<IconPlus />}
                        onClick={() => setModal({ edit: null })}
                      >
                        添加供应商
                      </Button>
                    </div>
                    {d.providers.length === 0 ? (
                      <div className="st-empty">
                        <b>还没有供应商</b>
                        <span>
                          支持 OpenAI、DeepSeek、通义、Kimi、智谱、火山方舟等所有
                          OpenAI 兼容的服务，也可以接 Ollama、vLLM
                          等本地模型。一个供应商里可以管理很多模型。
                        </span>
                      </div>
                    ) : (
                      <ul className="ai-provs">
                        {d.providers.map((p) => {
                          const on = p.models.filter((m) => m.enabled);
                          return (
                            <li key={p.id} className={p.enabled ? "" : "off"}>
                              <ProviderLogo
                                preset={p.preset}
                                name={p.name}
                                icon={p.icon}
                                color={p.color}
                                size={36}
                              />
                              <div className="ai-pinfo">
                                <b>
                                  {p.name}
                                  {p.private && <em className="ai-tag">内网</em>}
                                </b>
                                <small className="mono">{p.url}</small>
                                <span className="ai-pmodels">
                                  {on.length === 0 ? (
                                    <small className="faint">
                                      没有启用的模型
                                    </small>
                                  ) : (
                                    on.slice(0, 6).map((m) => {
                                      const hasTest = !!(
                                        m.tested ||
                                        m.test_err ||
                                        m.test_diag
                                      );
                                      const switchProviderChat =
                                        p.api === "responses"
                                          ? async () => {
                                              try {
                                                await api(
                                                  `/api/settings/ai/providers/${p.id}`,
                                                  {
                                                    method: "PUT",
                                                    body: JSON.stringify({
                                                      ...p,
                                                      api: "",
                                                    }),
                                                  },
                                                );
                                                await load(true);
                                                await refreshAIStatus();
                                                Message.success(
                                                  "已切换为 Chat Completions（通用）",
                                                );
                                              } catch (e) {
                                                err(e);
                                              }
                                            }
                                          : undefined;
                                      const pmLabel = chipModelName(m, on);
                                      if (hasTest && !m.test_ok) {
                                        return (
                                          <ModelDiagPopover
                                            key={m.id}
                                            m={m}
                                            providerName={p.name}
                                            providerApi={p.api || "chat"}
                                            onSwitchToChat={switchProviderChat}
                                          >
                                            <button
                                              type="button"
                                              className="ai-pm is-bad"
                                              title={`${m.id} · ${m.test_err || "测试未通过，点击查看诊断详情"}`}
                                            >
                                              <IconCloseCircleFill className="bad" />
                                              <span>{pmLabel}</span>
                                              <u className="ai-pm-act bad">
                                                诊断详情
                                              </u>
                                            </button>
                                          </ModelDiagPopover>
                                        );
                                      }
                                      if (hasTest && m.test_ok && m.test_warn) {
                                        return (
                                          <ModelDiagPopover
                                            key={m.id}
                                            m={m}
                                            providerName={p.name}
                                            providerApi={p.api || "chat"}
                                            onSwitchToChat={switchProviderChat}
                                          >
                                            <button
                                              type="button"
                                              className="ai-pm is-warn"
                                              title={`${m.id} · ${m.test_warn}`}
                                            >
                                              <IconExclamationCircleFill className="warn" />
                                              <span>{pmLabel}</span>
                                              <u className="ai-pm-act warn">
                                                连通
                                                {m.test_ms
                                                  ? ` ${m.test_ms}ms`
                                                  : ""}{" "}
                                                · 兼容告警
                                              </u>
                                            </button>
                                          </ModelDiagPopover>
                                        );
                                      }
                                      if (hasTest && m.test_ok && m.test_diag) {
                                        return (
                                          <ModelDiagPopover
                                            key={m.id}
                                            m={m}
                                            providerName={p.name}
                                            providerApi={p.api || "chat"}
                                          >
                                            <button
                                              type="button"
                                              className="ai-pm is-ok"
                                              title={`${m.id} · 连通 ${m.test_ms} ms · 点击查看诊断`}
                                            >
                                              <IconCheckCircleFill className="ok" />
                                              <span>{pmLabel}</span>
                                              {m.vision === "yes" && (
                                                <em>看图</em>
                                              )}
                                            </button>
                                          </ModelDiagPopover>
                                        );
                                      }
                                      return (
                                        <span
                                          key={m.id}
                                          className="ai-pm"
                                          title={
                                            m.tested && m.test_ok
                                              ? `${m.id} · 连通 ${m.test_ms} ms`
                                              : `${m.id} · 还没有测试`
                                          }
                                        >
                                          {m.tested && m.test_ok ? (
                                            <IconCheckCircleFill className="ok" />
                                          ) : (
                                            <i className="ai-dot" />
                                          )}
                                          <span>{pmLabel}</span>
                                          {m.vision === "yes" && <em>看图</em>}
                                        </span>
                                      );
                                    })
                                  )}
                                  {on.length > 6 && (
                                    <small className="faint">
                                      另 {on.length - 6} 个
                                    </small>
                                  )}
                                </span>
                              </div>
                              <Switch
                                checked={p.enabled}
                                onChange={() => toggle(p)}
                                aria-label={`启用 ${p.name}`}
                              />
                              <div className="ai-acts">
                                <Button
                                  size="small"
                                  icon={<IconEdit />}
                                  onClick={() => setModal({ edit: p })}
                                >
                                  管理模型
                                </Button>
                                <Button
                                  size="small"
                                  status="danger"
                                  icon={<IconDelete />}
                                  onClick={() => remove(p)}
                                  aria-label="删除"
                                />
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                  <section className="sx-sec">
                    <div className="ai-sec-h ai-um-top">
                      <div>
                        <h2>用户可以选的模型</h2>
                        <small className="faint">
                          勾选的模型会出现在对话输入框旁的模型菜单里；不勾选，大家就用下面为每个功能设定的模型。
                        </small>
                      </div>
                      {allEnabledRefs.length > 0 && (
                        <div className="ai-um-acts">
                          <span className="ai-um-cnt num">
                            已选{" "}
                            {
                              (d.user_models || []).filter((r) =>
                                selectableRefs.has(r),
                              ).length
                            }{" "}
                            / {allEnabledRefs.length}
                          </span>
                          <Button
                            size="small"
                            disabled={allEnabledRefs.every((r) =>
                              (d.user_models || []).includes(r),
                            )}
                            onClick={() =>
                              put({
                                ...d,
                                user_models: [
                                  ...(d.user_models || []).filter(
                                    (r) =>
                                      !selectableRefs.has(r) &&
                                      validRefs.has(r),
                                  ),
                                  ...allEnabledRefs,
                                ],
                              })
                            }
                          >
                            全选已启用模型
                          </Button>
                          <Button
                            size="small"
                            disabled={
                              (d.user_models || []).filter((r) =>
                                validRefs.has(r),
                              ).length === 0
                            }
                            onClick={() => put({ ...d, user_models: [] })}
                          >
                            清空
                          </Button>
                        </div>
                      )}
                    </div>
                    {optionGroups.length === 0 ? (
                      <p className="faint small">先添加供应商并启用模型。</p>
                    ) : (
                      <div className="ai-um">
                        {optionGroups.map(({ p, models }) => (
                          <div key={p.id} className="ai-um-g">
                            <div className="ai-um-h">
                              <ProviderLogo
                                preset={p.preset}
                                name={p.name}
                                icon={p.icon}
                                color={p.color}
                                size={18}
                              />
                              <b>{p.name}</b>
                            </div>
                            {models.map((m) => {
                              const ref = `${p.id}|${m.id}`;
                              const on = (d.user_models || []).includes(ref);
                              return (
                                <label
                                  key={ref}
                                  className={`ai-um-m ${on ? "on" : ""}`}
                                >
                                  <Checkbox
                                    checked={on}
                                    onChange={(v) =>
                                      put({
                                        ...d,
                                        user_models: v
                                          ? [...(d.user_models || []), ref]
                                          : (d.user_models || []).filter(
                                              (x) => x !== ref,
                                            ),
                                      })
                                    }
                                  />
                                  <span>
                                    <b title={m.id}>
                                      {chipModelName(m, models)}
                                    </b>
                                    {m.name && m.name !== m.id && (
                                      <code className="ai-um-id mono" title={m.id}>
                                        {m.id}
                                      </code>
                                    )}
                                    <small>
                                      {m.vision === "yes"
                                        ? "看图 · "
                                        : m.vision === "no"
                                          ? "不能看图 · "
                                          : ""}
                                      {m.tools === "no"
                                        ? "不支持工具"
                                        : "工具调用"}
                                    </small>
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </>
              )}
              {showFeatures && (
                <section className="sx-sec">
                  <h2>每个功能默认用的模型</h2>
                  <div className="ds-set">
                    {d.feature_list.map((f) => {
                      const x = d.features[f.ID] || { enabled: true };
                      const main = find(
                        x.primary ||
                          (optionGroups[0]
                            ? `${optionGroups[0].p.id}|${optionGroups[0].models[0].id}`
                            : ""),
                      );
                      const blind =
                        main.m &&
                        main.m.vision !== "yes" &&
                        ["troubleshoot", "review"].includes(f.ID);
                      return (
                        <div className="ds-set-row" key={f.ID}>
                          <div>
                            <b>{f.Title}</b>
                            <small>{f.Help}</small>
                            {blind && (
                              <small className="ai-warn">
                                主模型
                                {main.m!.vision === "no"
                                  ? "不能看图"
                                  : "还没确认能不能看图"}
                                ：
                                {main.m!.vision === "no"
                                  ? "排障时截图不可用，用户只能贴文字"
                                  : "到「管理模型」里测试一下"}
                              </small>
                            )}
                          </div>
                          <div className="ai-assign">
                            {picker(
                              x.primary,
                              "主模型（缺省自动匹配）",
                              "恢复缺省（取第一个可用模型）",
                              "start",
                              (v) =>
                                put({
                                  ...d,
                                  features: {
                                    ...d.features,
                                    [f.ID]: { ...x, primary: v },
                                  },
                                }),
                              `${f.Title}主模型`,
                            )}
                            {picker(
                              x.backup,
                              "备用模型（主模型失败时）",
                              "不设备用模型",
                              "end",
                              (v) =>
                                put({
                                  ...d,
                                  features: {
                                    ...d.features,
                                    [f.ID]: { ...x, backup: v },
                                  },
                                }),
                              `${f.Title}备用模型`,
                            )}
                            <Switch
                              checked={x.enabled}
                              onChange={(v) =>
                                put({
                                  ...d,
                                  features: {
                                    ...d.features,
                                    [f.ID]: { ...x, enabled: v },
                                  },
                                })
                              }
                              aria-label={`启用${f.Title}`}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
              {showBoundary && (
                <section className="sx-sec">
                  <h2>数据边界</h2>
                  <div className="ds-set">
                    <div className="ds-set-row">
                      <div>
                        <b>替换 IP 和主机名</b>
                        <small>
                          发给模型前换成代号，答案里再还原。开启后回答不再逐字显示。默认关闭，因为现场排障需要真实名称。
                        </small>
                      </div>
                      <Switch
                        checked={d.redact_hosts}
                        onChange={(v) => put({ ...d, redact_hosts: v })}
                        aria-label="替换 IP 和主机名"
                      />
                    </div>
                    <div className="ds-set-row">
                      <div>
                        <b>只允许私有模型</b>
                        <small>
                          只使用标记为「内网」的供应商，数据不会发往公网。
                        </small>
                      </div>
                      <Switch
                        checked={d.private_only}
                        onChange={(v) => put({ ...d, private_only: v })}
                        aria-label="只允许私有模型"
                      />
                    </div>
                    <div className="ds-set-row">
                      <div>
                        <b>每人每月次数上限</b>
                        <small>按调用次数统计，0 为不限制。</small>
                      </div>
                      <InputNumber
                        style={{ width: 120 }}
                        min={0}
                        max={100000}
                        value={d.monthly_limit}
                        onChange={(v) =>
                          setD({ ...d, monthly_limit: Number(v) })
                        }
                        onBlur={() => put(d)}
                        aria-label="每月次数上限"
                      />
                    </div>
                  </div>
                  <p className="ai-never">
                    永远不会发送：密码、私钥、证书、凭据文件，以及交付里的
                    secrets 目录。命中这些模式的内容在发出前就被替换为［已隐去］。
                  </p>
                </section>
              )}
            </>
          )}
        </>
      )}
      {canEdit && (
        <ProviderModal
          open={!!modal}
          presets={d?.presets || []}
          edit={modal?.edit || null}
          close={() => {
            setModal(null);
            void load(true).then(() => refreshAIStatus());
          }}
          saved={async () => {
            await load(true);
            await refreshAIStatus();
          }}
        />
      )}
    </article>
  );
}

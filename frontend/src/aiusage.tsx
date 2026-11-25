import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input, Pagination, Select, Tooltip } from "@arco-design/web-react";
import {
  IconCheckCircleFill,
  IconCloseCircleFill,
  IconCopy,
  IconInfoCircle,
  IconSearch,
} from "@arco-design/web-react/icon";
import { api, cached, copy, money, num, putCached, stamp } from "./shared";
import { bi, useLang } from "./i18n";
import {
  formatAICallDiag,
  prettyDiagPayload,
  reasonCodeLabel,
} from "./aichat";
import type { AIAttemptDiag, AICallDiag } from "./aichat";
export type { AIAttemptDiag, AICallDiag } from "./aichat";
import { HBars, StackedBars, compact } from "./charts";
import type { Point } from "./charts";
import { RangeBar, rangeOf } from "./rangebar";
import type { Range } from "./rangebar";
import "./charts.css";
import "./aiusage.css";

/* AI usage: every call with its details, and the cost analysis built from the same records. */

export type Usage = {
  id: string;
  at: string;
  user: string;
  ip?: string;
  feature: string;
  job?: string;
  target?: string;
  provider: string;
  model: string;
  endpoint?: string;
  stream?: boolean;
  in: number;
  out: number;
  cached?: number;
  reasoning?: number;
  rounds?: number;
  tools?: number;
  first_ms?: number;
  ms: number;
  ok: boolean;
  error?: string;
  failover?: boolean;
  cost?: number;
  currency?: string;
  http_status?: number;
  response_id?: string;
  diag?: AICallDiag;
};
type Agg = {
  key: string;
  label?: string;
  calls: number;
  errors: number;
  in: number;
  out: number;
  cached: number;
  cost: number;
  ms: number;
  first_ms: number;
  first_n: number;
};
type Stats = {
  total: Agg;
  series: Agg[];
  hourly: boolean;
  by_user: Agg[];
  by_model: Agg[];
  by_feature: Agg[];
  by_target: Agg[];
  currency: string;
};

const FEATURE: Record<string, string> = {
  get change_rehearsal() {
    return bi("变更演练", "Change rehearsal");
  },
  get review() {
    return bi("交付评审", "Delivery review");
  },
  get troubleshoot() {
    return bi("现场排障", "Troubleshooting");
  },
  get component() {
    return bi("组件工作台", "Component workbench");
  },
  get assistant() {
    return bi("AI 助手", "AI Assistant");
  },
  get form() {
    return bi("智能填表", "Smart form fill");
  },
  get docs() {
    return bi("文档起草", "Doc drafting");
  },
};

function isSuspectZeroTruncated(u: Usage): boolean {
  const inTok = u.in || u.diag?.in_tokens || 0;
  const outTok = u.out || u.diag?.out_tokens || 0;
  return u.ok && inTok === 0 && outTok === 0 && u.ms >= 115000;
}
const secs = (ms?: number) =>
  ms == null || ms <= 0
    ? "—"
    : ms < 1000
      ? `${ms} ms`
      : `${(ms / 1000).toFixed(2)} s`;

function useFilters() {
  const [range, setRange] = useState<Range>(() => rangeOf("7d"));
  const [user, setUser] = useState("");
  const [model, setModel] = useState("");
  const [feature, setFeature] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const qs = useCallback(
    (extra: Record<string, string | number> = {}) => {
      const p = new URLSearchParams({
        from: range.from,
        to: range.to,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      for (const [k, v] of Object.entries({
        user,
        model,
        feature,
        status,
        q,
        ...extra,
      }))
        if (v !== "" && v != null) p.set(k, String(v));
      return p.toString();
    },
    [range, user, model, feature, status, q],
  );
  return {
    range,
    setRange,
    user,
    setUser,
    model,
    setModel,
    feature,
    setFeature,
    status,
    setStatus,
    q,
    setQ,
    qs,
  };
}
type Filters = ReturnType<typeof useFilters>;

function FilterBar({
  f,
  users,
  models,
}: {
  f: Filters;
  users: string[];
  models: string[];
}) {
  useLang();
  return (
    <div className="au-filters">
      <RangeBar value={f.range} onChange={f.setRange} />
      <div className="au-row">
        <Input
          allowClear
          prefix={<IconSearch />}
          placeholder={bi("搜索用户、IP、对象、错误…", "Search user, IP, target, error…")}
          value={f.q}
          onChange={f.setQ}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              f.setQ("");
              (e.target as HTMLElement).blur();
            }
          }}
          style={{ width: 240 }}
          aria-label={bi("搜索", "Search")}
        />
        <Select
          allowClear
          placeholder={bi("用户", "User")}
          value={f.user || undefined}
          onChange={(v) => f.setUser(v || "")}
          options={users.map((u) => ({ value: u, label: u }))}
          style={{ width: 148 }}
          triggerProps={{ autoAlignPopupWidth: false, autoFitPosition: true }}
          aria-label={bi("用户", "User")}
        />
        <Select
          allowClear
          placeholder={bi("模型", "Model")}
          value={f.model || undefined}
          onChange={(v) => f.setModel(v || "")}
          options={models.map((m) => ({ value: m, label: m }))}
          style={{ width: 236 }}
          triggerProps={{ autoAlignPopupWidth: false, autoFitPosition: true }}
          aria-label={bi("模型", "Model")}
        />
        <Select
          allowClear
          placeholder={bi("功能", "Feature")}
          value={f.feature || undefined}
          onChange={(v) => f.setFeature(v || "")}
          options={Object.entries(FEATURE).map(([value, label]) => ({
            value,
            label,
          }))}
          style={{ width: 144 }}
          triggerProps={{ autoAlignPopupWidth: false, autoFitPosition: true }}
          aria-label={bi("功能", "Feature")}
        />
        <Select
          allowClear
          placeholder={bi("状态", "Status")}
          value={f.status || undefined}
          onChange={(v) => f.setStatus(v || "")}
          options={[
            { value: "ok", label: bi("成功", "Success") },
            { value: "error", label: bi("失败", "Failed") },
          ]}
          style={{ width: 116 }}
          triggerProps={{ autoAlignPopupWidth: false, autoFitPosition: true }}
          aria-label={bi("状态", "Status")}
        />
      </div>
    </div>
  );
}

function Tokens({ u }: { u: Usage }) {
  useLang();
  const total = u.in + u.out;
  return (
    <Tooltip
      position="left"
      content={
        <dl className="au-tip">
          <dt>{bi("输入 Token", "Input tokens")}</dt>
          <dd>{num(u.in)}</dd>
          <dt>{bi("输出 Token", "Output tokens")}</dt>
          <dd>{num(u.out)}</dd>
          {!!u.cached && (
            <>
              <dt>{bi("缓存读取 Token", "Cached read tokens")}</dt>
              <dd>{num(u.cached)}</dd>
            </>
          )}
          {!!u.reasoning && (
            <>
              <dt>{bi("推理 Token", "Reasoning tokens")}</dt>
              <dd>{num(u.reasoning)}</dd>
            </>
          )}
          <dt className="sum">{bi("总 Token", "Total tokens")}</dt>
          <dd className="sum">{num(total)}</dd>
        </dl>
      }
    >
      <span className="au-tok">
        <span>
          <i className="in">↓</i> {num(u.in)} <i className="out">↑</i>{" "}
          {num(u.out)}
        </span>
        {!!u.cached && (
          <small>
            {bi("缓存", "Cached")} {num(u.cached)} <IconInfoCircle />
          </small>
        )}
      </span>
    </Tooltip>
  );
}

const UsageMore = React.memo(function UsageMore({ u }: { u: Usage }) {
  useLang();
  const diag = u.diag;
  const prettyReq = useMemo(
    () => prettyDiagPayload(diag?.request_summary),
    [diag?.request_summary],
  );
  const prettyRaw = useMemo(
    () => prettyDiagPayload(diag?.response_raw),
    [diag?.response_raw],
  );
  const httpStatus = u.http_status ?? diag?.http_status;
  const responseId = u.response_id || diag?.response_id;
  const endpoint = diag?.endpoint || u.endpoint || "/chat/completions";
  const inTok = u.in || diag?.in_tokens || 0;
  const outTok = u.out || diag?.out_tokens || 0;
  const cachedTok = u.cached ?? diag?.cached_tokens;
  const showTokRow =
    !u.ok &&
    (inTok > 0 ||
      outTok > 0 ||
      cachedTok != null ||
      diag?.in_tokens != null ||
      diag?.out_tokens != null);
  const canCopy = !!(diag || u.error || httpStatus != null || responseId);
  const suspectTrunc = isSuspectZeroTruncated(u);

  return (
    <dl className="au-more">
      <dt>{bi("调用编号", "Call ID")}</dt>
      <dd className="au-dd-head">
        <span className="mono">{u.id}</span>
        {canCopy && (
          <button
            type="button"
            className="au-copy-btn"
            onClick={() =>
              copy(
                formatAICallDiag(diag, {
                  title: bi("AI 用量调用诊断", "AI Usage Call Diagnostics"),
                  callId: u.id,
                  provider: u.provider,
                  model: u.model,
                  testedAt: stamp(u.at),
                  error: u.error,
                  httpStatus,
                  responseId,
                  endpoint,
                  ms: u.ms,
                }),
              )
            }
          >
            <IconCopy /> {bi("复制诊断", "Copy diagnostics")}
          </button>
        )}
      </dd>
      <dt>{bi("调用结果", "Outcome")}</dt>
      <dd className="au-dd-inline">
        {!u.ok ? (
          <span className="au-state-pill bad">{bi("失败", "Failed")}</span>
        ) : suspectTrunc ? (
          <span className="au-state-pill warn">
            {bi("疑似中途截断 (0 Token)", "Suspected truncation (0 tokens)")}
          </span>
        ) : (
          <span className="au-state-pill ok">{bi("成功", "Success")}</span>
        )}
        {u.ok && diag?.fallback_used && (
          <span className="au-fb-badge">
            {bi("协议自动回退", "Protocol fallback")}{" "}
            <span className="mono">{diag.fallback_used}</span>
          </span>
        )}
        {!u.ok && u.error && <span className="bad">{u.error}</span>}
      </dd>
      <dt>{bi("接口", "Endpoint")}</dt>
      <dd className="mono">{endpoint}</dd>
      {(httpStatus != null || diag?.upstream_status || diag?.reason_code) && (
        <>
          <dt>{bi("HTTP 状态", "HTTP status")}</dt>
          <dd className="au-dd-inline">
            {httpStatus != null && (
              <span
                className={`au-http ${
                  httpStatus >= 200 && httpStatus < 300 && u.ok
                    ? "ok"
                    : httpStatus >= 400 || httpStatus === 0
                      ? "bad"
                      : "warn"
                }`}
              >
                {httpStatus > 0
                  ? `HTTP ${httpStatus}`
                  : bi("网络未连通", "Network unreachable")}
              </span>
            )}
            {diag?.upstream_status && (
              <span>
                {bi(
                  `上游状态 ${diag.upstream_status}`,
                  `Upstream status ${diag.upstream_status}`,
                )}
              </span>
            )}
            {diag?.reason_code && (
              <span className="faint">{reasonCodeLabel(diag.reason_code)}</span>
            )}
          </dd>
        </>
      )}
      {responseId && (
        <>
          <dt>{bi("上游响应 ID", "Upstream response ID")}</dt>
          <dd className="mono">{responseId}</dd>
        </>
      )}
      {diag?.fallback_used && (
        <>
          <dt>{bi("协议回退", "Protocol fallback")}</dt>
          <dd>
            <span className="au-fb-badge">
              {bi("已回退", "Fell back to")}{" "}
              <span className="mono">{diag.fallback_used}</span>
            </span>
          </dd>
        </>
      )}
      <dt>{bi("轮次", "Rounds")}</dt>
      <dd>
        {bi(
          `${u.rounds || 1} 次模型调用，${u.tools || 0} 次工具调用`,
          `${u.rounds || 1} model call${(u.rounds || 1) === 1 ? "" : "s"}, ${u.tools || 0} tool call${(u.tools || 0) === 1 ? "" : "s"}`,
        )}
      </dd>
      {showTokRow && (
        <>
          <dt>{bi("Token 明细", "Token breakdown")}</dt>
          <dd className="num">
            {bi(`输入 ${num(inTok)}`, `In ${num(inTok)}`)}
            {cachedTok != null
              ? bi(` · 缓存 ${num(cachedTok)}`, ` · Cached ${num(cachedTok)}`)
              : ""}
            {bi(` · 输出 ${num(outTok)}`, ` · Out ${num(outTok)}`)}
          </dd>
        </>
      )}
      {!!u.reasoning && (
        <>
          <dt>{bi("推理 Token", "Reasoning tokens")}</dt>
          <dd>{num(u.reasoning)}</dd>
        </>
      )}
      {diag?.sse_events && diag.sse_events.length > 0 && (
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
      {u.error && (
        <>
          <dt>{bi("错误", "Error")}</dt>
          <dd className="bad au-err-msg">{u.error}</dd>
        </>
      )}
      {diag?.attempts && diag.attempts.length > 0 && (
        <>
          <dt>{bi("尝试链路", "Attempts")}</dt>
          <dd className="au-dd-block">
            <ol className="au-attempts">
              {diag.attempts.map((a, idx) => (
                <li key={idx}>
                  <span className="au-att-api">{a.api}</span>
                  <code className="au-att-ep">{a.endpoint}</code>
                  <span
                    className={`au-att-st ${a.http_status && a.http_status >= 200 && a.http_status < 300 ? "ok" : "bad"}`}
                  >
                    {a.http_status
                      ? `HTTP ${a.http_status}`
                      : bi("连接失败", "Connection failed")}
                  </span>
                  <span className="num">{secs(a.ms)}</span>
                  {(a.in_tokens != null || a.out_tokens != null) && (
                    <span className="num">
                      ↓{num(a.in_tokens ?? 0)}
                      {a.cached_tokens
                        ? bi(
                            ` 缓${num(a.cached_tokens)}`,
                            ` c:${num(a.cached_tokens)}`,
                          )
                        : ""}{" "}
                      ↑{num(a.out_tokens ?? 0)}
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
                  {a.response_id && (
                    <code className="faint">{a.response_id}</code>
                  )}
                  {(a.reason || a.request_note) && (
                    <span className="au-att-why">
                      {a.reason || a.request_note}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </dd>
        </>
      )}
      {prettyReq && (
        <>
          <dt>{bi("请求摘要", "Request summary")}</dt>
          <dd className="au-dd-block">
            <div className="au-raw-box">
              <div className="au-raw-bar">
                <span>{bi("请求参数摘要", "Request parameter summary")}</span>
                <button
                  type="button"
                  onClick={() => copy(prettyReq)}
                >
                  <IconCopy /> {bi("复制", "Copy")}
                </button>
              </div>
              <pre className="au-raw">{prettyReq}</pre>
            </div>
          </dd>
        </>
      )}
      {prettyRaw && (
        <>
          <dt>{bi("原始响应", "Raw response")}</dt>
          <dd className="au-dd-block">
            <div className="au-raw-box">
              <div className="au-raw-bar">
                <span>
                  {bi(
                    "网关原始响应 / 关键帧",
                    "Gateway raw response / key frames",
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => copy(prettyRaw)}
                >
                  <IconCopy /> {bi("复制", "Copy")}
                </button>
              </div>
              <pre className="au-raw">{prettyRaw}</pre>
            </div>
          </dd>
        </>
      )}
    </dl>
  );
});

const UsageRow = React.memo(function UsageRow({
  u,
  expanded,
  onToggle,
}: {
  u: Usage;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  useLang();
  const suspectTrunc = isSuspectZeroTruncated(u);
  return (
    <div
      className={`au-item ${!u.ok ? "is-bad" : suspectTrunc ? "is-warn" : ""}`}
    >
      <button
        type="button"
        className="au-row-b"
        role="row"
        onClick={() => onToggle(u.id)}
        aria-expanded={expanded}
      >
        <span className="au-time num">{stamp(u.at)}</span>
        <span className="au-status-cell">
          {!u.ok ? (
            <span
              className="au-state-pill bad"
              title={u.error || bi("调用失败", "Call failed")}
            >
              <IconCloseCircleFill /> {bi("失败", "Failed")}
            </span>
          ) : suspectTrunc ? (
            <span
              className="au-state-pill warn"
              title={bi(
                "达到旧版 120s 上限截断且未返回 Token 计量",
                "Truncated at legacy 120s timeout with no token usage returned",
              )}
            >
              {bi("截断", "Truncated")}
            </span>
          ) : (
            <span className="au-state-pill ok">
              <IconCheckCircleFill /> {bi("成功", "OK")}
            </span>
          )}
        </span>
        <span className="au-user" title={u.user}>
          {u.user}
        </span>
        <span className="au-what">
          <b>{FEATURE[u.feature] || u.feature}</b>
          <small title={u.target || u.job || undefined}>
            {u.target || u.job || "—"}
          </small>
        </span>
        <span className="au-model">
          <b className="mono au-model-id" title={u.model}>
            {u.model}
          </b>
          <small>
            {u.provider}
            {u.failover ? bi(" · 备用", " · Failover") : ""}
            {u.diag?.fallback_used ? bi(" · 协议回退", " · Fallback") : ""}
            {u.stream ? bi(" · 流式", " · Stream") : ""}
          </small>
        </span>
        {u.ok || u.in || u.out || u.diag?.in_tokens ? (
          <Tokens
            u={{
              ...u,
              in: u.in || u.diag?.in_tokens || 0,
              out: u.out || u.diag?.out_tokens || 0,
              cached: u.cached ?? u.diag?.cached_tokens,
            }}
          />
        ) : (
          <span className="faint">—</span>
        )}
        <span className="au-time2">
          <span>
            <small>{bi("首字", "TTFT")}</small> {secs(u.first_ms)}
          </span>
          <span>
            <small>{bi("总耗时", "Total")}</small> {secs(u.ms)}
          </span>
        </span>
        <span className="au-cost num">
          {u.cost ? money(u.cost, u.currency) : "—"}
        </span>
        <span
          className={u.ip ? "au-ip mono" : "au-ip faint"}
          title={u.ip || undefined}
        >
          {u.ip || "—"}
        </span>
      </button>
      {expanded && <UsageMore u={u} />}
    </div>
  );
});

/* ---------------------------------------------------------------- detail */

export function UsageView() {
  useLang();
  const f = useFilters();
  const [page, setPage] = useState(1);
  const size = 30;
  const usageUrl = `/api/settings/ai/usage?${f.qs({ page, size })}`;
  const [d, setD] = useState<{
    rows: Usage[];
    total: number;
    users: string[];
    models: string[];
  } | null>(() => cached(usageUrl) ?? null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState("");
  const prevQ = useRef(f.q);
  useEffect(() => setPage(1), [f.qs()]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    const url = `/api/settings/ai/usage?${f.qs({ page, size })}`;
    const hit = cached<NonNullable<typeof d>>(url);
    if (hit) setD(hit);
    const delay = prevQ.current !== f.q ? 200 : 0;
    prevQ.current = f.q;
    const run = () => {
      api<NonNullable<typeof d>>(url)
        .then((r) => {
          putCached(url, r);
          if (live) {
            setD(r);
            setError("");
          }
        })
        .catch((e) => live && setError((e as Error).message));
    };
    if (delay === 0) {
      run();
      return () => {
        live = false;
      };
    }
    const t = window.setTimeout(run, delay);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [f.qs, f.q, page]);
  const toggleRow = useCallback(
    (id: string) => setOpen((cur) => (cur === id ? "" : id)),
    [],
  );
  return (
    <article className="sx-page st-main au-page enter">
      <header className="sx-page-h">
        <div>
          <h1>{bi("用量明细", "Usage log")}</h1>
          <p>
            {bi(
              "每一次模型调用：谁、在哪个交付或组件里、用了哪个模型、多少 Token、花了多久。",
              "Every model call: who ran it, which delivery or component it served, which model was used, token counts, and latency.",
            )}
          </p>
        </div>
      </header>
      <FilterBar f={f} users={d?.users || []} models={d?.models || []} />
      {error && <div className="note warn">{error}</div>}
      <div className="au-count">
        {d
          ? bi(`${num(d.total)} 条`, `${num(d.total)} records`)
          : bi("载入中…", "Loading…")}
      </div>
      <div
        className="au-table"
        role="table"
        aria-label={bi("模型调用", "Model calls")}
      >
        <div className="au-head" role="row">
          <span>{bi("时间", "Time")}</span>
          <span>{bi("状态", "Status")}</span>
          <span>{bi("用户", "User")}</span>
          <span>{bi("功能与对象", "Feature & target")}</span>
          <span>{bi("模型", "Model")}</span>
          <span>Token</span>
          <span>{bi("耗时", "Latency")}</span>
          <span className="au-cost">{bi("费用", "Cost")}</span>
          <span className="au-ip-h">{bi("来源 IP", "Source IP")}</span>
        </div>
        {d?.rows.map((u) => (
          <UsageRow
            key={u.id}
            u={u}
            expanded={open === u.id}
            onToggle={toggleRow}
          />
        ))}
        {d && d.rows.length === 0 && (
          <div className="au-empty">
            {bi("这个范围里没有调用记录。", "No usage records in this range.")}
          </div>
        )}
      </div>
      {d && d.total > size && (
        <Pagination
          className="au-pager"
          total={d.total}
          pageSize={size}
          current={page}
          onChange={setPage}
          sizeCanChange={false}
          showTotal={false}
        />
      )}
    </article>
  );
}

/* ---------------------------------------------------------------- cost */

const Tile = ({
  label,
  value,
  sub,
  tone,
  subTone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "kyndryl" | "teal" | "ok";
  subTone?: "warn" | "bad" | "ok";
}) => (
  <div className={`au-kpi ${tone ? `is-${tone}` : ""}`}>
    <small>{label}</small>
    <b>{value}</b>
    {sub && <span className={subTone ? `is-${subTone}` : ""}>{sub}</span>}
  </div>
);

export function CostView() {
  const lang = useLang();
  const f = useFilters();
  const statsUrl = `/api/settings/ai/usage/stats?${f.qs()}`;
  const metaUrl = `/api/settings/ai/usage?${f.qs({ size: 1 })}`;
  const initMeta = cached<{ users: string[]; models: string[] }>(metaUrl);
  const [s, setS] = useState<Stats | null>(() => cached<Stats>(statsUrl) ?? null);
  const [users, setUsers] = useState<string[]>(() => initMeta?.users ?? []);
  const [models, setModels] = useState<string[]>(() => initMeta?.models ?? []);
  const [error, setError] = useState("");
  const [by, setBy] = useState<"cost" | "tokens">("cost");
  const prevQ = useRef(f.q);
  useEffect(() => {
    let live = true;
    const u = `/api/settings/ai/usage?${f.qs({ size: 1 })}`;
    api<{ users: string[]; models: string[] }>(u)
      .then((r) => {
        putCached(u, r);
        if (!live) return;
        setUsers(r.users);
        setModels(r.models);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [f.range]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    const url = `/api/settings/ai/usage/stats?${f.qs()}`;
    const hit = cached<Stats>(url);
    if (hit) setS(hit);
    const delay = prevQ.current !== f.q ? 200 : 0;
    prevQ.current = f.q;
    const run = () => {
      api<Stats>(url)
        .then((r) => {
          putCached(url, r);
          if (live) {
            setS(r);
            setError("");
          }
        })
        .catch((e) => live && setError((e as Error).message));
    };
    if (delay === 0) {
      run();
      return () => {
        live = false;
      };
    }
    const t = window.setTimeout(run, delay);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [f.qs, f.q]);
  const cur = s?.currency || "CNY";
  const hasCost = !!s && s.total.cost > 0;
  // nothing is priced yet: show tokens, the only thing there is to rank by
  useEffect(() => {
    if (s && !hasCost) setBy("tokens");
  }, [s, hasCost]);
  const tot = s?.total;
  const points = useMemo(
    () =>
      (s?.series || []).map((p): Point => ({
        key: p.key,
        label: s?.hourly ? p.key.slice(11, 16) : p.key.slice(5),
        values:
          by === "cost"
            ? { cost: p.cost }
            : {
                fresh: Math.max(0, p.in - p.cached),
                cached: p.cached,
                out: p.out,
              },
      })),
    [s, by],
  );
  const fmtCost = useCallback(
    (n: number) => (n === 0 ? "0" : money(n, cur)),
    [cur],
  );
  const fmt = by === "cost" ? fmtCost : num;
  const makeBars = useCallback(
    (list: Agg[], label?: (a: Agg) => string) =>
      list.map((a) => ({
        key: a.key,
        label: label ? label(a) : a.key,
        value: by === "cost" ? a.cost : a.in + a.out,
        sub: bi(
          `${num(a.calls)} 次 · ${num(a.in + a.out)} Token${a.cost ? ` · ${money(a.cost, cur)}` : ""}`,
          `${num(a.calls)} call${a.calls === 1 ? "" : "s"} · ${num(a.in + a.out)} tokens${a.cost ? ` · ${money(a.cost, cur)}` : ""}`,
        ),
      })),
    [by, cur, lang], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const modelBars = useMemo(
    () => (s ? makeBars(s.by_model) : []),
    [s, makeBars],
  );
  const userBars = useMemo(
    () => (s ? makeBars(s.by_user) : []),
    [s, makeBars],
  );
  const featureBars = useMemo(
    () => (s ? makeBars(s.by_feature, (a) => FEATURE[a.key] || a.key) : []),
    [s, makeBars],
  );
  const targetBars = useMemo(
    () => (s ? makeBars(s.by_target, (a) => a.label || a.key) : []),
    [s, makeBars],
  );
  return (
    <article className="sx-page st-main au-page enter">
      <header className="sx-page-h">
        <div>
          <h1>{bi("用量与成本", "Usage & cost")}</h1>
          <p>
            {bi(
              "费用按官方公布的 API 价格（或你在「模型价格」里设的价格）估算，只是估算，以厂商账单为准。",
              "Costs are estimated from official API pricing (or your overrides in Model Pricing) and are for reference only; refer to vendor bills.",
            )}
            {s
              ? bi(
                  `按${s.currency === "USD" ? "美元" : "人民币"}显示。`,
                  ` Shown in ${s.currency === "USD" ? "USD" : "CNY"}. `,
                )
              : ""}
            <a href="#/settings/ai-prices">
              {bi("调整价格与汇率", "Adjust pricing & rate")}
            </a>
            {!hasCost && s && s.total.calls > 0
              ? bi(
                  " 这段时间的调用没有匹配到价格，请在模型价格页添加。",
                  " No pricing matched calls in this period—add rates on the Model Pricing page.",
                )
              : ""}
          </p>
        </div>
      </header>
      <FilterBar f={f} users={users} models={models} />
      {error && <div className="note warn">{error}</div>}
      {tot && (
        <>
          <div className="au-kpis">
            <Tile
              label={bi("估算费用", "Estimated cost")}
              value={hasCost ? money(tot.cost, cur) : "—"}
              tone={hasCost ? "kyndryl" : undefined}
              sub={
                hasCost
                  ? bi(
                      `平均每次 ${money(tot.cost / Math.max(1, tot.calls), cur)}`,
                      `Avg ${money(tot.cost / Math.max(1, tot.calls), cur)} / call`,
                    )
                  : bi("未设置单价", "No pricing configured")
              }
            />
            <Tile
              label={bi("调用次数", "Calls")}
              value={num(tot.calls)}
              subTone={
                tot.errors
                  ? tot.errors / Math.max(1, tot.calls) >= 0.1
                    ? "bad"
                    : "warn"
                  : tot.calls > 0
                    ? "ok"
                    : undefined
              }
              sub={
                tot.errors
                  ? bi(
                      `${num(tot.errors)} 次失败（${((tot.errors / tot.calls) * 100).toFixed(1)}%）`,
                      `${num(tot.errors)} failed (${((tot.errors / tot.calls) * 100).toFixed(1)}%)`,
                    )
                  : bi("全部成功", "All succeeded")
              }
            />
            <Tile
              label={bi("Token 总量", "Total tokens")}
              value={num(tot.in + tot.out)}
              tone="teal"
              sub={bi(
                `输入 ${num(tot.in)} · 输出 ${num(tot.out)}`,
                `In ${num(tot.in)} · Out ${num(tot.out)}`,
              )}
            />
            <Tile
              label={bi("缓存命中", "Cache hit")}
              value={
                tot.in ? `${((tot.cached / tot.in) * 100).toFixed(1)}%` : "—"
              }
              tone={
                tot.in && tot.cached / tot.in >= 0.5 ? "ok" : undefined
              }
              sub={bi(
                `读取 ${num(tot.cached)} Token`,
                `${num(tot.cached)} cached tokens`,
              )}
            />
            <Tile
              label={bi("平均首字", "Avg TTFT")}
              value={
                tot.first_n ? secs(Math.round(tot.first_ms / tot.first_n)) : "—"
              }
              sub={
                tot.calls
                  ? bi(
                      `平均总耗时 ${secs(Math.round(tot.ms / tot.calls))}`,
                      `Avg latency ${secs(Math.round(tot.ms / tot.calls))}`,
                    )
                  : ""
              }
            />
          </div>

          <section className="sx-sec">
            <div className="au-sec-h">
              <h2>
                {s.hourly
                  ? bi("按小时", "Hourly")
                  : bi("按天", "Daily")}
              </h2>
              <div
                className="au-seg"
                role="group"
                aria-label={bi("口径", "Metric")}
              >
                <button
                  type="button"
                  className={by === "cost" ? "on" : ""}
                  onClick={() => setBy("cost")}
                  disabled={!hasCost}
                  title={
                    hasCost
                      ? undefined
                      : bi("先在供应商里设置单价", "Configure pricing first")
                  }
                >
                  {bi("费用", "Cost")}
                </button>
                <button
                  type="button"
                  className={by === "tokens" ? "on" : ""}
                  onClick={() => setBy("tokens")}
                >
                  Token
                </button>
              </div>
            </div>
            <StackedBars
              points={points}
              label={
                by === "cost"
                  ? bi("每段时间的估算费用", "Estimated cost over time")
                  : bi("每段时间的 Token 用量", "Token usage over time")
              }
              format={fmt}
              tick={by === "cost" ? fmtCost : compact}
              series={
                by === "cost"
                  ? [
                      {
                        id: "cost",
                        label: bi("估算费用", "Estimated cost"),
                        color: "var(--teal)",
                      },
                    ]
                  : [
                      {
                        id: "fresh",
                        label: bi("输入（未缓存）", "Input (uncached)"),
                        color: "var(--teal)",
                      },
                      {
                        id: "cached",
                        label: bi("输入（缓存命中）", "Input (cached)"),
                        color: "var(--ok)",
                      },
                      {
                        id: "out",
                        label: bi("输出", "Output"),
                        color: "var(--kyndryl)",
                      },
                    ]
              }
            />
          </section>

          <div className="au-cols">
            <section className="sx-sec">
              <h2>{bi("按模型", "By model")}</h2>
              <HBars
                rows={modelBars}
                format={fmt}
                color="var(--teal)"
              />
            </section>
            <section className="sx-sec">
              <h2>{bi("按用户", "By user")}</h2>
              <HBars
                rows={userBars}
                format={fmt}
                color="var(--cobalt)"
              />
            </section>
            <section className="sx-sec">
              <h2>{bi("按功能", "By feature")}</h2>
              <HBars
                rows={featureBars}
                format={fmt}
                color="var(--kyndryl)"
              />
            </section>
            <section className="sx-sec">
              <h2>{bi("按交付与组件", "By delivery & component")}</h2>
              <HBars
                rows={targetBars}
                format={fmt}
                color="var(--ok)"
              />
            </section>
          </div>
        </>
      )}
    </article>
  );
}

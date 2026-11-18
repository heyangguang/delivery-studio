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
  change_rehearsal: "变更演练",
  review: "交付评审",
  troubleshoot: "现场排障",
  component: "组件工作台",
  assistant: "AI 助手",
  form: "智能填表",
  docs: "文档起草",
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
  return (
    <div className="au-filters">
      <RangeBar value={f.range} onChange={f.setRange} />
      <div className="au-row">
        <Input
          allowClear
          prefix={<IconSearch />}
          placeholder="搜索用户、IP、对象、错误…"
          value={f.q}
          onChange={f.setQ}
          style={{ width: 240 }}
          aria-label="搜索"
        />
        <Select
          allowClear
          placeholder="用户"
          value={f.user || undefined}
          onChange={(v) => f.setUser(v || "")}
          options={users.map((u) => ({ value: u, label: u }))}
          style={{ width: 148 }}
          triggerProps={{ autoAlignPopupWidth: false, autoFitPosition: true }}
          aria-label="用户"
        />
        <Select
          allowClear
          placeholder="模型"
          value={f.model || undefined}
          onChange={(v) => f.setModel(v || "")}
          options={models.map((m) => ({ value: m, label: m }))}
          style={{ width: 236 }}
          triggerProps={{ autoAlignPopupWidth: false, autoFitPosition: true }}
          aria-label="模型"
        />
        <Select
          allowClear
          placeholder="功能"
          value={f.feature || undefined}
          onChange={(v) => f.setFeature(v || "")}
          options={Object.entries(FEATURE).map(([value, label]) => ({
            value,
            label,
          }))}
          style={{ width: 144 }}
          triggerProps={{ autoAlignPopupWidth: false, autoFitPosition: true }}
          aria-label="功能"
        />
        <Select
          allowClear
          placeholder="状态"
          value={f.status || undefined}
          onChange={(v) => f.setStatus(v || "")}
          options={[
            { value: "ok", label: "成功" },
            { value: "error", label: "失败" },
          ]}
          style={{ width: 116 }}
          triggerProps={{ autoAlignPopupWidth: false, autoFitPosition: true }}
          aria-label="状态"
        />
      </div>
    </div>
  );
}

function Tokens({ u }: { u: Usage }) {
  const total = u.in + u.out;
  return (
    <Tooltip
      position="left"
      content={
        <dl className="au-tip">
          <dt>输入 Token</dt>
          <dd>{num(u.in)}</dd>
          <dt>输出 Token</dt>
          <dd>{num(u.out)}</dd>
          {!!u.cached && (
            <>
              <dt>缓存读取 Token</dt>
              <dd>{num(u.cached)}</dd>
            </>
          )}
          {!!u.reasoning && (
            <>
              <dt>推理 Token</dt>
              <dd>{num(u.reasoning)}</dd>
            </>
          )}
          <dt className="sum">总 Token</dt>
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
            缓存 {num(u.cached)} <IconInfoCircle />
          </small>
        )}
      </span>
    </Tooltip>
  );
}

function UsageMore({ u }: { u: Usage }) {
  const diag = u.diag;
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
      <dt>调用编号</dt>
      <dd className="au-dd-head">
        <span className="mono">{u.id}</span>
        {canCopy && (
          <button
            type="button"
            className="au-copy-btn"
            onClick={() =>
              copy(
                formatAICallDiag(diag, {
                  title: "AI 用量调用诊断",
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
            <IconCopy /> 复制诊断
          </button>
        )}
      </dd>
      <dt>调用结果</dt>
      <dd className="au-dd-inline">
        {!u.ok ? (
          <span className="au-state-pill bad">失败</span>
        ) : suspectTrunc ? (
          <span className="au-state-pill warn">疑似中途截断 (0 Token)</span>
        ) : (
          <span className="au-state-pill ok">成功</span>
        )}
        {u.ok && diag?.fallback_used && (
          <span className="au-fb-badge">
            协议自动回退 <span className="mono">{diag.fallback_used}</span>
          </span>
        )}
        {!u.ok && u.error && <span className="bad">{u.error}</span>}
      </dd>
      <dt>接口</dt>
      <dd className="mono">{endpoint}</dd>
      {(httpStatus != null || diag?.upstream_status || diag?.reason_code) && (
        <>
          <dt>HTTP 状态</dt>
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
                {httpStatus > 0 ? `HTTP ${httpStatus}` : "网络未连通"}
              </span>
            )}
            {diag?.upstream_status && (
              <span>上游状态 {diag.upstream_status}</span>
            )}
            {diag?.reason_code && (
              <span className="faint">{reasonCodeLabel(diag.reason_code)}</span>
            )}
          </dd>
        </>
      )}
      {responseId && (
        <>
          <dt>上游响应 ID</dt>
          <dd className="mono">{responseId}</dd>
        </>
      )}
      {diag?.fallback_used && (
        <>
          <dt>协议回退</dt>
          <dd>
            <span className="au-fb-badge">
              已回退 <span className="mono">{diag.fallback_used}</span>
            </span>
          </dd>
        </>
      )}
      <dt>轮次</dt>
      <dd>
        {u.rounds || 1} 次模型调用，{u.tools || 0} 次工具调用
      </dd>
      {showTokRow && (
        <>
          <dt>Token 明细</dt>
          <dd className="num">
            输入 {num(inTok)}
            {cachedTok != null ? ` · 缓存 ${num(cachedTok)}` : ""}
            {` · 输出 ${num(outTok)}`}
          </dd>
        </>
      )}
      {!!u.reasoning && (
        <>
          <dt>推理 Token</dt>
          <dd>{num(u.reasoning)}</dd>
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
      {u.error && (
        <>
          <dt>错误</dt>
          <dd className="bad au-err-msg">{u.error}</dd>
        </>
      )}
      {diag?.attempts && diag.attempts.length > 0 && (
        <>
          <dt>尝试链路</dt>
          <dd className="au-dd-block">
            <ol className="au-attempts">
              {diag.attempts.map((a, idx) => (
                <li key={idx}>
                  <span className="au-att-api">{a.api}</span>
                  <code className="au-att-ep">{a.endpoint}</code>
                  <span
                    className={`au-att-st ${a.http_status && a.http_status >= 200 && a.http_status < 300 ? "ok" : "bad"}`}
                  >
                    {a.http_status ? `HTTP ${a.http_status}` : "连接失败"}
                  </span>
                  <span className="num">{secs(a.ms)}</span>
                  {(a.in_tokens != null || a.out_tokens != null) && (
                    <span className="num">
                      ↓{num(a.in_tokens ?? 0)}
                      {a.cached_tokens ? ` 缓${num(a.cached_tokens)}` : ""} ↑
                      {num(a.out_tokens ?? 0)}
                    </span>
                  )}
                  {a.upstream_status && <span>状态 {a.upstream_status}</span>}
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
      {diag?.request_summary && (
        <>
          <dt>请求摘要</dt>
          <dd className="au-dd-block">
            <div className="au-raw-box">
              <div className="au-raw-bar">
                <span>请求参数摘要</span>
                <button
                  type="button"
                  onClick={() => copy(prettyDiagPayload(diag.request_summary))}
                >
                  <IconCopy /> 复制
                </button>
              </div>
              <pre className="au-raw">
                {prettyDiagPayload(diag.request_summary)}
              </pre>
            </div>
          </dd>
        </>
      )}
      {diag?.response_raw && (
        <>
          <dt>原始响应</dt>
          <dd className="au-dd-block">
            <div className="au-raw-box">
              <div className="au-raw-bar">
                <span>网关原始响应 / 关键帧</span>
                <button
                  type="button"
                  onClick={() => copy(prettyDiagPayload(diag.response_raw))}
                >
                  <IconCopy /> 复制
                </button>
              </div>
              <pre className="au-raw">
                {prettyDiagPayload(diag.response_raw)}
              </pre>
            </div>
          </dd>
        </>
      )}
    </dl>
  );
}

/* ---------------------------------------------------------------- detail */

export function UsageView() {
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
  return (
    <article className="sx-page st-main enter">
      <header className="sx-page-h">
        <div>
          <h1>用量明细</h1>
          <p>
            每一次模型调用：谁、在哪个交付或组件里、用了哪个模型、多少
            Token、花了多久。
          </p>
        </div>
      </header>
      <FilterBar f={f} users={d?.users || []} models={d?.models || []} />
      {error && <div className="note warn">{error}</div>}
      <div className="au-count">{d ? `${num(d.total)} 条` : "载入中…"}</div>
      <div className="au-table" role="table" aria-label="模型调用">
        <div className="au-head" role="row">
          <span>时间</span>
          <span>状态</span>
          <span>用户</span>
          <span>功能与对象</span>
          <span>模型</span>
          <span>Token</span>
          <span>耗时</span>
          <span>费用</span>
          <span>来源 IP</span>
        </div>
        {d?.rows.map((u) => {
          const suspectTrunc = isSuspectZeroTruncated(u);
          return (
          <div key={u.id} className={`au-item ${!u.ok ? "bad" : suspectTrunc ? "warn" : ""}`}>
            <button
              type="button"
              className="au-row-b"
              role="row"
              onClick={() => setOpen(open === u.id ? "" : u.id)}
              aria-expanded={open === u.id}
            >
              <span className="au-time num">{stamp(u.at)}</span>
              <span className="au-status-cell">
                {!u.ok ? (
                  <span className="au-state-pill bad" title={u.error || "调用失败"}>
                    <IconCloseCircleFill /> 失败
                  </span>
                ) : suspectTrunc ? (
                  <span className="au-state-pill warn" title="达到旧版 120s 上限截断且未返回 Token 计量">
                    截断
                  </span>
                ) : (
                  <span className="au-state-pill ok">
                    <IconCheckCircleFill /> 成功
                  </span>
                )}
              </span>
              <span className="au-user">{u.user}</span>
              <span className="au-what">
                <b>{FEATURE[u.feature] || u.feature}</b>
                <small>{u.target || u.job || "—"}</small>
              </span>
              <span className="au-model">
                <b className="mono au-model-id">{u.model}</b>
                <small>
                  {u.provider}
                  {u.failover ? " · 备用" : ""}
                  {u.diag?.fallback_used ? " · 协议回退" : ""}
                  {u.stream ? " · 流式" : ""}
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
                  <small>首字</small> {secs(u.first_ms)}
                </span>
                <span>
                  <small>总耗时</small> {secs(u.ms)}
                </span>
              </span>
              <span className="au-cost num">
                {u.cost ? money(u.cost, u.currency) : "—"}
              </span>
              <span className={u.ip ? "au-ip mono" : "au-ip faint"}>
                {u.ip || "—"}
              </span>
            </button>
            {open === u.id && <UsageMore u={u} />}
          </div>
          );
        })}
        {d && d.rows.length === 0 && (
          <div className="au-empty">这个范围里没有调用记录。</div>
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
}: {
  label: string;
  value: string;
  sub?: string;
}) => (
  <div className="au-kpi">
    <small>{label}</small>
    <b>{value}</b>
    {sub && <span>{sub}</span>}
  </div>
);

export function CostView() {
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
    const u = `/api/settings/ai/usage?${f.qs({ size: 1 })}`;
    api<{ users: string[]; models: string[] }>(u)
      .then((r) => {
        putCached(u, r);
        setUsers(r.users);
        setModels(r.models);
      })
      .catch(() => undefined);
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
  const fmtCost = (n: number) => (n === 0 ? "0" : money(n, cur));
  const value = (a: Agg) => (by === "cost" ? a.cost : a.in + a.out);
  const fmt = by === "cost" ? fmtCost : num;
  const bars = (list: Agg[], label?: (a: Agg) => string) =>
    list.map((a) => ({
      key: a.key,
      label: label ? label(a) : a.key,
      value: value(a),
      sub: `${num(a.calls)} 次 · ${num(a.in + a.out)} Token${a.cost ? ` · ${money(a.cost, cur)}` : ""}`,
    }));
  return (
    <article className="sx-page st-main enter">
      <header className="sx-page-h">
        <div>
          <h1>用量与成本</h1>
          <p>
            费用按官方公布的 API
            价格（或你在「模型价格」里设的价格）估算，只是估算，以厂商账单为准。
            {s ? `按${s.currency === "USD" ? "美元" : "人民币"}显示。` : ""}
            <a href="#/settings/ai-prices">调整价格与汇率</a>
            {!hasCost && s && s.total.calls > 0
              ? " 这段时间的调用没有匹配到价格，请在模型价格页添加。"
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
              label="估算费用"
              value={hasCost ? money(tot.cost, cur) : "—"}
              sub={
                hasCost
                  ? `平均每次 ${money(tot.cost / Math.max(1, tot.calls), cur)}`
                  : "未设置单价"
              }
            />
            <Tile
              label="调用次数"
              value={num(tot.calls)}
              sub={
                tot.errors
                  ? `${num(tot.errors)} 次失败（${((tot.errors / tot.calls) * 100).toFixed(1)}%）`
                  : "全部成功"
              }
            />
            <Tile
              label="Token 总量"
              value={num(tot.in + tot.out)}
              sub={`输入 ${num(tot.in)} · 输出 ${num(tot.out)}`}
            />
            <Tile
              label="缓存命中"
              value={
                tot.in ? `${((tot.cached / tot.in) * 100).toFixed(1)}%` : "—"
              }
              sub={`读取 ${num(tot.cached)} Token`}
            />
            <Tile
              label="平均首字"
              value={
                tot.first_n ? secs(Math.round(tot.first_ms / tot.first_n)) : "—"
              }
              sub={
                tot.calls
                  ? `平均总耗时 ${secs(Math.round(tot.ms / tot.calls))}`
                  : ""
              }
            />
          </div>

          <section className="sx-sec">
            <div className="au-sec-h">
              <h2>{s.hourly ? "按小时" : "按天"}</h2>
              <div className="au-seg" role="group" aria-label="口径">
                <button
                  type="button"
                  className={by === "cost" ? "on" : ""}
                  onClick={() => setBy("cost")}
                  disabled={!hasCost}
                  title={hasCost ? undefined : "先在供应商里设置单价"}
                >
                  费用
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
                by === "cost" ? "每段时间的估算费用" : "每段时间的 Token 用量"
              }
              format={fmt}
              tick={by === "cost" ? fmtCost : compact}
              series={
                by === "cost"
                  ? [{ id: "cost", label: "估算费用", color: "var(--brand)" }]
                  : [
                      {
                        id: "fresh",
                        label: "输入（未缓存）",
                        color: "#6250d6",
                      },
                      {
                        id: "cached",
                        label: "输入（缓存命中）",
                        color: "#1baf7a",
                      },
                      { id: "out", label: "输出", color: "#eb6834" },
                    ]
              }
            />
          </section>

          <div className="au-cols">
            <section className="sx-sec">
              <h2>按模型</h2>
              <HBars rows={bars(s.by_model)} format={fmt} />
            </section>
            <section className="sx-sec">
              <h2>按用户</h2>
              <HBars rows={bars(s.by_user)} format={fmt} />
            </section>
            <section className="sx-sec">
              <h2>按功能</h2>
              <HBars
                rows={bars(s.by_feature, (a) => FEATURE[a.key] || a.key)}
                format={fmt}
              />
            </section>
            <section className="sx-sec">
              <h2>按交付与组件</h2>
              <HBars
                rows={bars(s.by_target, (a) => a.label || a.key)}
                format={fmt}
              />
            </section>
          </div>
        </>
      )}
    </article>
  );
}

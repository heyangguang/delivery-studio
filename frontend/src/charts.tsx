import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { bi, useLang } from "./i18n";

/* The two charts the platform needs: a stacked bar series over time, and horizontal bars for a ranking. Marks are thin
   with a 2px gap between stacked parts, the grid is quiet, one axis only, and every chart has a table view. */

export type Series = { id: string; label: string; color: string };
export type Point = {
  key: string;
  label: string;
  values: Record<string, number>;
};

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

export const compact = (n: number) =>
  n >= 1e9
    ? `${+(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${+(n / 1e6).toFixed(1)}M`
      : n >= 1e4
        ? `${+(n / 1e3).toFixed(0)}K`
        : n.toLocaleString("en-US");

export function StackedBars({
  points,
  series,
  format,
  tick,
  label,
  height = 190,
  emptyText,
}: {
  points: Point[];
  series: Series[];
  format: (n: number) => string;
  tick?: (n: number) => string;
  label: string;
  height?: number;
  emptyText?: string;
}) {
  useLang();
  const emptyLabel = emptyText ?? bi("这段时间没有数据", "No data in this period");
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const [off, setOff] = useState<Record<string, boolean>>({});
  const box = useRef<HTMLDivElement>(null);
  const live = series.filter((s) => !off[s.id]);
  const totals = points.map((p) =>
    live.reduce((n, s) => n + (p.values[s.id] || 0), 0),
  );
  const max = niceMax(Math.max(0, ...totals));
  const any = totals.some((t) => t > 0);
  const [W, setW] = useState(720);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setW(Math.max(280, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [table, any]);
  const H = height;
  const pad = { l: 48, r: 8, t: 8, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / Math.max(1, points.length);
  const bw = Math.max(2, Math.min(28, slot * 0.62));
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const every = Math.ceil(points.length / 8);
  const sum = useMemo(
    () =>
      Object.fromEntries(
        series.map((s) => [
          s.id,
          points.reduce((n, p) => n + (p.values[s.id] || 0), 0),
        ]),
      ),
    [points, series],
  );

  return (
    <figure className="ch" aria-label={label}>
      <div className="ch-bar">
        <ul className="ch-legend">
          {series.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={off[s.id] ? "off" : ""}
                aria-pressed={!off[s.id]}
                onClick={() => setOff({ ...off, [s.id]: !off[s.id] })}
              >
                <i style={{ background: s.color }} />
                {s.label}
                <b>{format(sum[s.id] || 0)}</b>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="ch-view"
          onClick={() => setTable(!table)}
        >
          {table ? bi("看图表", "Chart") : bi("看表格", "Table")}
        </button>
      </div>
      {table ? (
        <div className="ch-table">
          <table>
            <thead>
              <tr>
                <th>{bi("时间", "Time")}</th>
                {series.map((s) => (
                  <th key={s.id}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.key}>
                  <td>{p.label}</td>
                  {series.map((s) => (
                    <td key={s.id}>{format(p.values[s.id] || 0)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !any ? (
        <div className="ch-empty" style={{ height }}>
          {emptyLabel}
        </div>
      ) : (
        <div className="ch-plot" ref={box} onMouseLeave={() => setHover(null)}>
          <svg width={W} height={H} role="img" aria-label={label}>
            {ticks.map((t) => {
              const y = pad.t + ih - (t / max) * ih;
              return (
                <g key={t}>
                  <line
                    x1={pad.l}
                    x2={W - pad.r}
                    y1={y}
                    y2={y}
                    className="ch-grid"
                  />
                  <text
                    x={pad.l - 8}
                    y={y + 4}
                    className="ch-tick"
                    textAnchor="end"
                  >
                    {(tick || format)(t)}
                  </text>
                </g>
              );
            })}
            {points.map((p, i) => {
              const cx = pad.l + slot * i + slot / 2;
              let y = pad.t + ih;
              return (
                <g key={p.key}>
                  <rect
                    x={pad.l + slot * i}
                    y={pad.t}
                    width={slot}
                    height={ih}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onMouseMove={() => setHover(i)}
                  />
                  {hover === i && (
                    <rect
                      x={pad.l + slot * i}
                      y={pad.t}
                      width={slot}
                      height={ih}
                      className="ch-hover"
                      pointerEvents="none"
                    />
                  )}
                  {live.map((s, k) => {
                    const v = p.values[s.id] || 0;
                    if (v <= 0) return null;
                    const h = Math.max(1.5, (v / max) * ih);
                    y -= h;
                    const top =
                      k === live.length - 1 ||
                      live.slice(k + 1).every((q) => !(p.values[q.id] > 0));
                    return (
                      <rect
                        key={s.id}
                        x={cx - bw / 2}
                        y={y}
                        width={bw}
                        height={Math.max(0, h - (top ? 0 : 2))}
                        rx={top ? Math.min(4, bw / 2) : 0}
                        fill={s.color}
                        pointerEvents="none"
                      />
                    );
                  })}
                  {i % every === 0 && (
                    <text
                      x={cx}
                      y={H - 5}
                      className="ch-tick"
                      textAnchor="middle"
                    >
                      {p.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div
              className="ch-tip"
              style={{
                left: Math.min(
                  W - 80,
                  Math.max(80, pad.l + slot * hover + slot / 2),
                ),
              }}
              role="status"
            >
              <b>{points[hover].label}</b>
              {series.map((s) => (
                <span key={s.id}>
                  <i style={{ background: s.color }} />
                  {s.label}
                  <em>{format(points[hover].values[s.id] || 0)}</em>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

export type Bar = { key: string; label: string; value: number; sub?: string };

/** A ranking: the label, a bar scaled to the largest, the value. */
export function HBars({
  rows,
  format,
  color = "var(--brand)",
  empty,
}: {
  rows: Bar[];
  format: (n: number) => string;
  color?: string;
  empty?: string;
}) {
  useLang();
  const emptyLabel = empty ?? bi("没有数据", "No data");
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max <= 0)
    return <div className="ch-empty small">{emptyLabel}</div>;
  return (
    <ul className="hb">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="hb-l" title={r.label}>
            {r.label}
          </span>
          <span className="hb-t" aria-hidden>
            <i
              style={{
                width: `${Math.max(1.5, (r.value / max) * 100)}%`,
                background: color,
              }}
            />
          </span>
          <b className="hb-v">{format(r.value)}</b>
          {r.sub && <small className="hb-s">{r.sub}</small>}
        </li>
      ))}
    </ul>
  );
}

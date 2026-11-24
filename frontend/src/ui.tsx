import {displayInstances,displayFlows,componentOrder as order} from "./topology";
import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Tag } from "@arco-design/web-react";
import { IconCheck, IconClose } from "@arco-design/web-react/icon";
import { running, states, useMedia } from "./shared";
import type { InstanceView, Job } from "./shared";
import { iconShape, isBrandIcon, styleOf } from "./glyphs";
import { bi, canonicalCat, useLang } from "./i18n";

/* ---------- identity ---------- */

export function BrandMark({ size = 24 }: { size?: number }) {
  useLang();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const bgId = `bm-bg-${uid}`;
  const sheenId = `bm-sh-${uid}`;
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      style={{ display: "block", flex: "none" }}
      aria-hidden
    >
      <defs>
        <linearGradient id={bgId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF5A42" />
          <stop offset="0.55" stopColor="#FF462D" />
          <stop offset="1" stopColor="#DC311B" />
        </linearGradient>
        <linearGradient id={sheenId} x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity=".22" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7.5" fill={`url(#${bgId})`} />
      <rect width="32" height="16" rx="7.5" fill={`url(#${sheenId})`} />
      {/* Precision geometric K emblem */}
      <path
        d="M10.5 8.5v15M21.2 9L13.2 16l8.3 7.2"
        stroke="#FFFFFF"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity=".18"
        strokeWidth="1"
      />
    </svg>
  );
}

/* ---------- app identity ---------- */

/** Icon colours by category; an app with no category falls back to neutral grey. */
const TINTS: Record<string, [string, string]> = {
  数据库: ["#5d8fd8", "#2f5fa8"],
  缓存: ["#f2806a", "#c23a28"],
  消息队列: ["#3cc4ae", "#12796b"],
  对象存储: ["#dc7fc8", "#98388a"],
  搜索: ["#f4b552", "#c47a12"],
};
export const tintOf = (category?: string): [string, string] =>
  TINTS[canonicalCat(category)] || ["#9a9aa2", "#6e6e76"];

/** Component logo: authentic full-colour brand SVG on a sculpted porcelain tile, or a tinted icon tile for generic shapes. */
export const AppGlyph = React.memo(function AppGlyph({
  id,
  category,
  size = 40,
  muted,
  icon,
  color,
}: {
  id: string;
  category?: string;
  size?: number;
  muted?: boolean;
  icon?: string;
  color?: string;
}) {
  const st = styleOf(id, category, icon, color);
  const brand = isBrandIcon(st.icon);
  const [c0, c1] = st.color.tile;
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gid = `ag-${uid}`;
  if (brand) {
    return (
      <svg
        className={`app-glyph is-brand ${muted ? "muted" : ""}`}
        width={size}
        height={size}
        viewBox="0 0 40 40"
        aria-hidden
      >
        <rect
          className="app-glyph-tile"
          x="0.6"
          y="0.6"
          width="38.8"
          height="38.8"
          rx="9.5"
          strokeWidth="1.2"
        />
        {iconShape(st.icon)}
      </svg>
    );
  }
  return (
    <svg
      className={`app-glyph ${muted ? "muted" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c0} />
          <stop offset="1" stopColor={c1} />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill={`url(#${gid})`} />
      {iconShape(st.icon)}
    </svg>
  );
});

/** A removable filter, whose close button says what it removes. */
export function FilterChip({
  label,
  onClose,
  size,
  children,
}: {
  label: string;
  onClose: () => void;
  size?: "small";
  children?: React.ReactNode;
}) {
  return (
    <Tag
      size={size}
      closable
      onClose={onClose}
      __closeIconProps={{
        "aria-label": bi(`移除筛选：${label}`, `Remove filter: ${label}`),
        title: bi("移除", "Remove"),
      }}
    >
      {children ?? label}
    </Tag>
  );
}

/* ---------- status ---------- */

export function StatusDot({ state }: { state: string }) {
  return <span className={`sdot s-${state}`} aria-hidden />;
}
export function StatusBadge({
  state,
  label,
}: {
  state: string;
  label?: string;
}) {
  return (
    <span className={`sbadge s-${state}`}>
      <StatusDot state={state} />
      <span className="sbadge-lbl">{label || states[state] || state}</span>
    </span>
  );
}

/* ---------- delivery mode badge & search helpers ---------- */

export type NormalizedDeliveryMode =
  | "automatic"
  | "offline"
  | "configuration"
  | "imported";

export function normalizeDeliveryMode(mode?: string): NormalizedDeliveryMode {
  if (mode === "automatic") return "automatic";
  if (mode === "configuration") return "configuration";
  if (mode === "imported") return "imported";
  return "offline";
}

export function deliveryModeLabel(mode?: string, compact?: boolean): string {
  const m = normalizeDeliveryMode(mode);
  if (m === "automatic") {
    return compact ? bi("自动", "Auto") : bi("自动化部署", "Automated");
  }
  if (m === "configuration") {
    return compact ? bi("仅配置", "Config") : bi("配置交付", "Config Only");
  }
  if (m === "imported") {
    return compact ? bi("纳管", "Imported") : bi("存量纳管", "Imported Cluster");
  }
  return compact ? bi("离线", "Offline") : bi("离线部署", "Offline Manual");
}

export function deliveryModeKeywords(mode?: string): string {
  const m = normalizeDeliveryMode(mode);
  if (m === "automatic") {
    return "自动 自动化 自动部署 自动执行 远程执行 auto automatic automated runner";
  }
  if (m === "configuration") {
    return "配置 仅配置 配置交付 config configuration";
  }
  if (m === "imported") {
    return "纳管 导入 存量 已有 imported adopted brownfield";
  }
  return "离线 手动 手工 离线部署 离线手动 离线包 offline manual";
}

export function DeliveryModeIcon({
  mode,
  size = 11,
}: {
  mode?: string;
  size?: number;
}) {
  const m = normalizeDeliveryMode(mode);
  if (m === "imported") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
      >
        <path
          d="M8 2.2v6.6m0 0l-2.6-2.5M8 8.8l2.6-2.5M2.6 10.2v1.6a1.4 1.4 0 0 0 1.4 1.4h8a1.4 1.4 0 0 0 1.4-1.4v-1.6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (m === "automatic") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
      >
        <path
          d="M9.1 1.5L3.3 8.8h4.2l-.7 5.7 5.9-7.4H8.4l.7-5.6z"
          fill="currentColor"
        />
      </svg>
    );
  }
  if (m === "configuration") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
      >
        <path
          d="M3 4.5h10M3 8h10M3 11.5h10"
          stroke="currentColor"
          strokeWidth="1.45"
          strokeLinecap="round"
        />
        <circle cx="6" cy="4.5" r="1.5" fill="currentColor" />
        <circle cx="10.5" cy="8" r="1.5" fill="currentColor" />
        <circle cx="7" cy="11.5" r="1.5" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path
        d="M2.8 5.2L8 2.4l5.2 2.8v5.6L8 13.6l-5.2-2.8V5.2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M2.8 5.2L8 8l5.2-2.8M8 8v5.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DeliveryModeTag({
  mode,
  compact,
  className = "",
}: {
  mode?: string;
  compact?: boolean;
  className?: string;
}) {
  useLang();
  const m = normalizeDeliveryMode(mode);
  const label = deliveryModeLabel(m, compact);
  const tip =
    m === "automatic"
      ? bi(
          "自动化部署：通过授权执行节点自动执行并回传状态与日志",
          "Automated deployment via authorized execution runner",
        )
      : m === "configuration"
        ? bi(
            "配置交付：仅生成配置文件包，不执行现场部署",
            "Config-only delivery without on-site deployment",
          )
        : m === "imported"
          ? bi(
              "存量纳管：直接导入已有运行中集群，用于基线档案、变更演练与安全治理",
              "Imported brownfield cluster onboarded for baseline tracking, change rehearsals, and security audits",
            )
          : bi(
              "离线部署：下载离线安装包与执行手册，在现场手工执行",
              "Offline manual deployment using generated bundles & runbook",
            );
  return (
    <span
      className={`dm-tag dm-${m}${compact ? " is-xs" : ""}${className ? ` ${className}` : ""}`}
      title={tip}
    >
      <DeliveryModeIcon mode={m} size={compact ? 10 : 11.5} />
      <span>{label}</span>
    </span>
  );
}

/* ---------- segmented control with a sliding thumb ---------- */

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  size = "md",
  label,
}: {
  options: {
    value: T;
    label: React.ReactNode;
    count?: number;
    disabled?: boolean;
    sig?: string | number;
  }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md" | "lg";
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);
  const idx = options.findIndex((o) => o.value === value);
  const optSig = options
    .map(
      (o) =>
        `${String(o.value)}:${o.count ?? ""}:${o.disabled ? 1 : 0}:${o.sig ?? ""}`,
    )
    .join("|");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const btns = [...el.querySelectorAll<HTMLButtonElement>("button")];
    const measure = () => {
      const curBtns = el.querySelectorAll<HTMLButtonElement>("button");
      const b = idx >= 0 ? curBtns[idx] : undefined;
      const next = b ? { x: b.offsetLeft, w: b.offsetWidth } : null;
      setThumb((prev) => {
        if (!next) return prev === null ? prev : null;
        if (prev && prev.x === next.x && prev.w === next.w) return prev;
        return next;
      });
    };
    measure();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(el);
    btns.forEach((b) => ro?.observe(b));
    return () => ro?.disconnect();
  }, [idx, optSig]);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const move = (d: number) => {
    let i = idx < 0 ? 0 : idx;
    for (let n = 0; n < options.length; n++) {
      i = (i + d + options.length) % options.length;
      if (!options[i].disabled) return onChange(options[i].value);
    }
  };
  return (
    <div
      ref={ref}
      className={`seg seg-${size}`}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown")
          (e.preventDefault(), move(1));
        if (e.key === "ArrowLeft" || e.key === "ArrowUp")
          (e.preventDefault(), move(-1));
      }}
    >
      {thumb && (
        <span
          className={`seg-thumb${ready ? " ready" : ""}`}
          style={{
            transform: `translate3d(${thumb.x}px, 0, 0)`,
            width: thumb.w,
          }}
          aria-hidden
        />
      )}
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={o.disabled}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          <span className="seg-label">{o.label}</span>
          {o.count !== undefined && (
            <span className="seg-count num">{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ---------- optical 14-15px linear vector tab icons ---------- */

export type TabIconName =
  | "overview"
  | "config"
  | "deploy"
  | "rehearsal"
  | "docs"
  | "packages"
  | "users"
  | "security"
  | "audit"
  | "layers"
  | "terminal"
  | "spark"
  | "settings";

function renderTabGlyph(name: TabIconName): React.ReactNode {
  switch (name) {
    case "overview":
      return (
        <>
          <rect x="2.25" y="2.25" width="4.5" height="4.5" rx="1.15" />
          <rect x="9.25" y="2.25" width="4.5" height="4.5" rx="1.15" />
          <rect x="2.25" y="9.25" width="4.5" height="4.5" rx="1.15" />
          <rect x="9.25" y="9.25" width="4.5" height="4.5" rx="1.15" />
        </>
      );
    case "config":
      return (
        <>
          <path d="M2.25 5.25H4.1M7.4 5.25H13.75" />
          <circle cx="5.75" cy="5.25" r="1.65" />
          <path d="M2.25 10.75H8.6M11.9 10.75H13.75" />
          <circle cx="10.25" cy="10.75" r="1.65" />
        </>
      );
    case "deploy":
      return (
        <>
          <path d="M8 2.1L13.4 5.1V10.9L8 13.9L2.6 10.9V5.1L8 2.1Z" />
          <path d="M2.6 5.1L8 8.1L13.4 5.1" />
          <path d="M8 8.1V13.9" />
        </>
      );
    case "rehearsal":
      return (
        <>
          <circle cx="4.2" cy="4.2" r="1.55" />
          <circle cx="11.8" cy="4.2" r="1.55" />
          <circle cx="8" cy="11.9" r="1.65" />
          <path d="M4.95 5.6L7.25 10.35M11.05 5.6L8.75 10.35" />
        </>
      );
    case "docs":
      return (
        <>
          <rect x="3" y="2" width="10" height="12" rx="1.8" />
          <path d="M5.5 5.6H10.5M5.5 8H10.5M5.5 10.4H8.6" />
        </>
      );
    case "packages":
      return (
        <>
          <path d="M8 2.3L13.6 5.3L8 8.3L2.4 5.3L8 2.3Z" />
          <path d="M2.4 8.35L8 11.25L13.6 8.35" />
          <path d="M2.4 11.05L8 13.85L13.6 11.05" />
        </>
      );
    case "users":
      return (
        <>
          <circle cx="8" cy="5.4" r="2.3" />
          <path d="M3.35 13.25C3.35 10.8 5.35 9.45 8 9.45C10.65 9.45 12.65 10.8 12.65 13.25" />
        </>
      );
    case "security":
      return (
        <>
          <path d="M8 2.1L13 4.1V7.8C13 10.9 10.9 13 8 13.9C5.1 13 3 10.9 3 7.8V4.1L8 2.1Z" />
          <path d="M6 8.05L7.4 9.45L10.2 6.6" />
        </>
      );
    case "audit":
      return (
        <>
          <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.3" />
          <path d="M4.45 8H6.15L7.25 5.5L8.75 10.5L9.85 8H11.55" />
        </>
      );
    case "layers":
      return (
        <>
          <path d="M8 2.4L13.6 5.4L8 8.4L2.4 5.4L8 2.4Z" />
          <path d="M2.4 8.2L8 11.2L13.6 8.2" />
          <path d="M2.4 10.8L8 13.8L13.6 10.8" />
        </>
      );
    case "terminal":
      return (
        <>
          <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2" />
          <path d="M5 6.2L7.2 8L5 9.8M8.6 9.8H11" />
        </>
      );
    case "spark":
      return (
        <path d="M8 2.1L9.55 6.45L13.9 8L9.55 9.55L8 13.9L6.45 9.55L2.1 8L6.45 6.45L8 2.1Z" />
      );
    case "settings":
      return (
        <>
          <circle cx="8" cy="8" r="2.15" />
          <circle cx="8" cy="8" r="4.55" strokeDasharray="2.2 1.95" />
        </>
      );
  }
}

export function TabIcon({
  name,
  size = 14,
  className,
}: {
  name: TabIconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden
    >
      {renderTabGlyph(name)}
    </svg>
  );
}

/* ---------- underline tablist with a spring-guided sliding bar ---------- */

export type UnderlineTabItem<T extends string = string> = {
  value: T;
  label: React.ReactNode;
  count?: number;
  icon?: React.ReactNode;
  error?: boolean;
  disabled?: boolean;
  badge?: React.ReactNode;
};

export function UnderlineTabs<T extends string>({
  items,
  value,
  onChange,
  onHover,
  label,
  className,
}: {
  items: UnderlineTabItem<T>[];
  value: T;
  onChange: (v: T) => void;
  onHover?: (v: T) => void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);
  const idx = items.findIndex((o) => o.value === value);
  const itemSig = items
    .map(
      (it) =>
        `${it.value}:${it.count ?? ""}:${it.icon ? 1 : 0}:${it.error ? 1 : 0}:${it.disabled ? 1 : 0}`,
    )
    .join("|");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tabs = [
      ...el.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
    ];
    const measure = () => {
      const curTabs = el.querySelectorAll<HTMLButtonElement>(
        'button[role="tab"]',
      );
      const b = idx >= 0 ? curTabs[idx] : undefined;
      const next = b ? { x: b.offsetLeft, w: b.offsetWidth } : null;
      setBar((prev) => {
        if (!next) return prev === null ? prev : null;
        if (prev && prev.x === next.x && prev.w === next.w) return prev;
        return next;
      });
    };
    measure();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(el);
    tabs.forEach((t) => ro?.observe(t));
    let cancelled = false;
    document.fonts?.ready
      ?.then(() => {
        if (!cancelled) measure();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      ro?.disconnect();
    };
  }, [idx, itemSig]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || idx < 0 || el.scrollWidth <= el.clientWidth) return;
    const b = el.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[idx];
    if (!b) return;
    const pad = 16;
    const left = b.offsetLeft;
    const right = left + b.offsetWidth;
    if (left - pad < el.scrollLeft) {
      el.scrollTo({
        left: Math.max(0, left - pad),
        behavior: ready ? "smooth" : "auto",
      });
    } else if (right + pad > el.scrollLeft + el.clientWidth) {
      el.scrollTo({
        left: right - el.clientWidth + pad,
        behavior: ready ? "smooth" : "auto",
      });
    }
  }, [idx, ready]);

  return (
    <div
      ref={ref}
      className={`utabs ${className || ""}`.trim()}
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        if (
          e.key !== "ArrowLeft" &&
          e.key !== "ArrowRight" &&
          e.key !== "Home" &&
          e.key !== "End"
        )
          return;
        const tabs = [
          ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
            'button[role="tab"]:not(:disabled)',
          ),
        ];
        if (!tabs.length) return;
        const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
        if (i < 0) return;
        e.preventDefault();
        const nextIdx =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                tabs.length;
        tabs[nextIdx]?.focus();
        tabs[nextIdx]?.click();
      }}
    >
      {bar && (
        <span
          className={`utabs-bar${ready ? " ready" : ""}`}
          style={{
            transform: `translate3d(${bar.x}px, 0, 0)`,
            width: bar.w,
          }}
          aria-hidden
        />
      )}
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            tabIndex={on ? 0 : -1}
            aria-selected={on}
            disabled={it.disabled}
            className={`${on ? "on" : ""}${it.error ? " is-err" : ""}`.trim()}
            onMouseEnter={() => !it.disabled && onHover?.(it.value)}
            onFocus={() => !it.disabled && onHover?.(it.value)}
            onClick={() => !it.disabled && onChange(it.value)}
          >
            {it.icon != null && (
              <span className="utabs-ic" aria-hidden>
                {it.icon}
              </span>
            )}
            <span
              className="utabs-txt"
              data-text={typeof it.label === "string" ? it.label : undefined}
            >
              {it.label}
            </span>
            {it.count !== undefined && (
              <em className="utabs-count num">{it.count}</em>
            )}
            {it.badge}
            {it.error && <span className="utabs-err" aria-label={bi("存在异常", "Has issues")} />}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- deployment graph ---------- */

/** Short instance colours; the stylesheet gives each class its tint. */
const tintClass = (i: number) => `c${i % 6}`;

type Pt = [number, number];

/** A polyline with rounded corners, so the lanes read as wires rather than as boxes. */
function roundPath(pts: Pt[], r = 6) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const l1 = Math.hypot(cx - px, cy - py);
    const l2 = Math.hypot(nx - cx, ny - cy);
    if (!l1 || !l2) continue;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    d += ` L${cx + ((px - cx) / l1) * rr} ${cy + ((py - cy) / l1) * rr} Q${cx} ${cy} ${cx + ((nx - cx) / l2) * rr} ${cy + ((ny - cy) / l2) * rr}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return `${d} L${lx} ${ly}`;
}

/** Width of a label in the drawing's small type: letters are narrow, Chinese characters are wide. */
const labelWidth = (t: string, mono = 6.6) =>
  [...t].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 11.5 : mono), 0);
const clip = (t: string, max: number) => {
  if (labelWidth(t) <= max) return t;
  let out = "";
  for (const c of t) {
    if (labelWidth(out + c + "…") > max) break;
    out += c;
  }
  return out + "…";
};

/** Shortens a label in the middle, keeping its start and its end (the port of an address), to fit a width. */
const clipMid = (t: string, max: number, mono = 6.6) => {
  if (labelWidth(t, mono) <= max) return t;
  const cs = [...t];
  let head = Math.ceil(cs.length / 2);
  let tail = cs.length - head;
  const fits = () =>
    labelWidth(
      cs.slice(0, head).join("") + "…" + cs.slice(cs.length - tail).join(""),
      mono,
    ) <= max;
  while (!fits() && head + tail > 2) {
    // take from the longer side so both ends stay recognisable
    if (head >= tail) head--;
    else tail--;
  }
  return cs.slice(0, head).join("") + "…" + cs.slice(cs.length - tail).join("");
};

/**
 * The deployment as the platform will build it: machines as cards, the components placed on each as pills, and the
 * connections between them as wires that carry moving dashes (and a light spot) in the direction the data travels.
 * What flows where is declared by the components (flows) and by the load balancers (fronts); nothing here knows any
 * particular product. A wire starts at the pill of the component it belongs to, each kind of wire has its own lane,
 * and where two wires cross the later one passes over the earlier with a small gap.
 *
 * Stack layout lists machines top to bottom (entries on the left, component wires on the right) so it fits a narrow
 * column however many machines there are; row layout puts machines side by side, entries above and wires below.
 */
export const InstanceGraph = React.memo(function InstanceGraph({
  hosts,
  instances,
  controller,
  layout = "stack",
}: {
  hosts: { name: string; ip: string }[];
  instances: InstanceView[];
  controller?: string;
  layout?: "row" | "stack";
}) {
  useLang();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const calm = useMedia("(prefers-reduced-motion: reduce)");
  const real = displayInstances(instances).filter(i=>!i.external);
  const chips = (host: string) =>
    real.flatMap((inst, ii) =>
      Object.entries(inst.roles)
        .filter(([, hs]) => (hs || []).includes(host))
        .map(([role]) => ({ inst, ii, role })),
    );
  const used = hosts.filter(
    (h) => chips(h.name).length > 0 || h.name === controller,
  );
  const index = new Map(used.map((h, i) => [h.name, i]));
  type Front = {
    key: string;
    epName: string;
    badge: string;
    title: string;
    label: string;
    targets: string[];
    external: boolean;
    tone: number; // 0 = primary brand, 1 = sky/read, 2 = violet
  };
  const frontShortBadge = (
    epName: string,
    epTitle: string | undefined,
    external: boolean,
    multi: boolean,
  ) => {
    const low = epName.toLowerCase();
    const t = (epTitle || "").trim();
    if (low === "writer" || low === "write" || low === "rw" || /写入|读写/.test(t)) {
      if (multi) return external ? bi("外部·写入", "EXT RW") : bi("写入", "RW");
      return external ? bi("外部", "EXT") : bi("入口", "VIP");
    }
    if (low === "reader" || low === "read" || low === "ro" || /只读/.test(t)) {
      return external ? bi("外部·只读", "EXT RO") : bi("只读", "RO");
    }
    if (multi && t) {
      const clean = t
        .replace(/[（(].*?[）)]/g, "")
        .replace(/入口$/g, "")
        .trim();
      if (clean) return external ? `${bi("外部·", "EXT ")}${clip(clean, 48)}` : clip(clean, 56);
    }
    return external ? bi("外部", "EXT") : bi("入口", "VIP");
  };
  const rawFronts: {
    key: string;
    epName: string;
    epTitle?: string;
    order: number;
    listen: number;
    label: string;
    targets: string[];
    external: boolean;
  }[] = [];
  instances.forEach((inst, instIdx) => {
    const eps = inst.endpoints || [];
    Object.entries(inst.fronts || {}).forEach(([epName, f]) => {
      const epIdx = eps.findIndex((e) => e.name === epName);
      const ep = epIdx >= 0 ? eps[epIdx] : undefined;
      const epBackends =
        ep?.backends && ep.backends.length > 0
          ? [...new Set(ep.backends.map((b) => b.host))].filter((h) =>
              index.has(h),
            )
          : [];
      const fallbackTargets = inst.hosts.filter((h) => index.has(h));
      rawFronts.push({
        key: `${inst.id}:${epName}:${f.listen}`,
        epName,
        epTitle: ep?.title,
        order: instIdx * 100 + (epIdx >= 0 ? epIdx : 50),
        listen: f.listen || 0,
        label: `${f.address || "?"}:${f.listen}`,
        targets: epBackends.length > 0 ? epBackends : fallbackTargets,
        external: f.external,
      });
    });
  });
  rawFronts.sort((a, b) => a.order - b.order || a.listen - b.listen);
  const multiFront = rawFronts.length > 1;
  const fronts: Front[] = rawFronts.map((rf, idx) => {
    const isReader =
      rf.epName.toLowerCase() === "reader" ||
      rf.epName.toLowerCase() === "ro" ||
      /只读/.test(rf.epTitle || "");
    const tone = !multiFront ? 0 : isReader ? 1 : idx % 3;
    return {
      key: rf.key,
      epName: rf.epName,
      badge: frontShortBadge(rf.epName, rf.epTitle, rf.external, multiFront),
      title:
        rf.epTitle ||
        (rf.external ? bi("外部入口", "External entry") : bi("访问入口", "Entrypoint")),
      label: rf.label,
      targets: rf.targets,
      external: rf.external,
      tone,
    };
  });
  const flows = displayFlows(real).map(f=>({...f,from:(f.from||[]).filter(h=>index.has(h)),to:(f.to||[]).filter(h=>index.has(h))})).filter(f=>f.from.length&&f.to.length);
  const sources = new Set(
    flows.filter((f) => f.kind === "replication").flatMap((f) => f.from),
  );
  const targeted = new Set(fronts.flatMap((f) => f.targets));
  // a row of machines that does not fit its column (a phone, a narrow pane) is drawn as a stack instead
  const wrap = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(0);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setCw(el.clientWidth));
    ro.observe(el);
    setCw(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const rowCardW = used.length <= 2 ? 216 : used.length === 3 ? 198 : 176;
  const rowGap = used.length <= 2 ? 28 : used.length === 3 ? 22 : 20;
  const rowNeed = Math.max(
    used.length * rowCardW + Math.max(0, used.length - 1) * rowGap + 48,
    360,
  );
  const stack = layout === "stack" || (cw > 0 && cw < rowNeed * 0.78);
  const roleLabel = (c: { inst: InstanceView; role: string }) =>
    c.inst.role_titles?.[c.role] || c.role;
  const chipLabel = (c: { inst: InstanceView; role: string }) =>
    `${c.inst.title || c.inst.id} · ${roleLabel(c)}`;
  const arrow = (kind: string, sync?: boolean, tone?: number) =>
    kind === "live" && tone
      ? `${uid}-live-${tone}`
      : `${uid}-${kind}${sync ? "-sync" : ""}`;

  // ---- geometry
  const pillH = 34;
  const nFront = fronts.length;
  const PAD = stack ? 12 : 10;
  const maxIpWidth = stack
    ? Math.max(
        96,
        ...used.map((h) => ((h.ip || "—").length || 1) * 6.8),
      )
    : 0;
  const leftColW = stack ? Math.ceil(Math.max(114, maxIpWidth + 10)) : 0;
  const bw = stack ? 14 + leftColW + 12 + 158 + PAD : rowCardW;
  const CW = stack ? 158 : bw - 20; // symmetric 10px side inset inside host card
  const CH = stack ? 20 : 20;
  const PITCH = stack ? 27 : 26;
  const top0 = stack ? 38 : 50; // first pill's offset inside a card
  const cardH = (n: number, ctrl: boolean) =>
    stack ? Math.max(ctrl ? 78 : 64, PAD + n * PITCH + 6) : 58 + n * PITCH;
  const gutL = stack ? (nFront ? 20 + nFront * 18 : 6) : 0;
  const lanes = flows.length;
  const gutR = stack ? (lanes ? 30 + lanes * 24 : 6) : 0;
  const gap = stack ? 18 : rowGap;
  const n = Math.max(used.length, 1);

  // Measure front pills cleanly; in row layout arrange entrypoints horizontally side-by-side
  // so curves fan downward cleanly and NEVER pierce another entrypoint box.
  const frontGapX = 16;
  const frontGapY = 10;
  const rawPillW = (f: Front) =>
    Math.ceil(Math.max(182, 34 + labelWidth(f.badge, 7.2) + 8 + labelWidth(f.label, 7.4)));
  const baseRowW = Math.max(n * bw + (n - 1) * gap + 48, 320);
  const maxColsRow = nFront <= 3 ? Math.max(nFront, 1) : 3;
  const cappedRowPillW = (f: Front) =>
    Math.min(nFront > 1 ? 248 : Math.max(baseRowW - 24, 280), rawPillW(f));
  // Split fronts into horizontal rows in row layout (usually 1 single row for 1..3 fronts)
  const frontRows: { idx: number; f: Front; w: number }[][] = [];
  if (!stack && nFront > 0) {
    let cur: { idx: number; f: Front; w: number }[] = [];
    let curW = 0;
    const maxLineW = Math.max(baseRowW - 32, 720);
    fronts.forEach((f, idx) => {
      const w = cappedRowPillW(f);
      if (
        cur.length > 0 &&
        (cur.length >= maxColsRow || curW + frontGapX + w > maxLineW)
      ) {
        frontRows.push(cur);
        cur = [];
        curW = 0;
      }
      cur.push({ idx, f, w });
      curW += (cur.length > 1 ? frontGapX : 0) + w;
    });
    if (cur.length) frontRows.push(cur);
  }
  const widestFrontRow = frontRows.reduce(
    (mx, row) =>
      Math.max(
        mx,
        row.reduce((s, it) => s + it.w, 0) +
          Math.max(0, row.length - 1) * frontGapX,
      ),
    0,
  );
  const W = stack
    ? gutL + bw + gutR
    : Math.max(baseRowW, widestFrontRow + 36);
  const x0 = stack ? gutL : (W - (n * bw + (n - 1) * gap)) / 2;

  const frontBoxes: {
    x: number;
    y: number;
    w: number;
    h: number;
    cx: number;
    row: number;
  }[] = new Array(nFront);
  if (stack) {
    const centre = x0 + bw / 2;
    fronts.forEach((f, k) => {
      const w = Math.min(bw, rawPillW(f));
      const y = 8 + k * (pillH + 8);
      frontBoxes[k] = { x: centre - w / 2, y, w, h: pillH, cx: centre, row: k };
    });
  } else {
    frontRows.forEach((row, rIdx) => {
      const totalW =
        row.reduce((s, it) => s + it.w, 0) +
        Math.max(0, row.length - 1) * frontGapX;
      let cursor = (W - totalW) / 2;
      const y = 8 + rIdx * (pillH + frontGapY);
      row.forEach((it) => {
        frontBoxes[it.idx] = {
          x: cursor,
          y,
          w: it.w,
          h: pillH,
          cx: cursor + it.w / 2,
          row: rIdx,
        };
        cursor += it.w + frontGapX;
      });
    });
  }
  const frontsH = nFront
    ? stack
      ? 14 + nFront * (pillH + 8) + 6
      : 8 +
        frontRows.length * pillH +
        Math.max(0, frontRows.length - 1) * frontGapY +
        (multiFront ? 56 : 44)
    : stack
      ? 6
      : 4;
  const heights = used.map((h) =>
    cardH(chips(h.name).length, h.name === controller),
  );
  const rowBox = Math.max(...heights, 60);
  const cards = used.map((h, i) => {
    if (stack) {
      const y = frontsH + heights.slice(0, i).reduce((s, v) => s + v + gap, 0);
      return { x: x0, y, w: bw, h: heights[i] };
    }
    return { x: x0 + i * (bw + gap), y: frontsH, w: bw, h: rowBox };
  });
  const belowH = stack ? 0 : lanes ? 30 + lanes * 22 : 0;
  const H = stack
    ? frontsH + heights.reduce((s, v) => s + v + gap, 0)
    : frontsH + rowBox + belowH + 18;
  const cardMid = (name: string) => {
    const c = cards[index.get(name) ?? 0];
    return c.y + c.h / 2;
  };
  // where the pill of (instance, role) sits on a machine
  const pillY = (
    host: string,
    inst: InstanceView,
    role: string | undefined,
  ) => {
    const c = cards[index.get(host) ?? 0];
    const list = chips(host);
    let k = list.findIndex((x) => x.inst === inst && x.role === role);
    if (k < 0)
      k = Math.max(
        0,
        list.findIndex((x) => x.inst === inst),
      );
    return c.y + (stack ? PAD : top0) + k * PITCH + CH / 2;
  };

  // ---- wires: every wire is a polyline from where the data leaves to where it arrives
  type Wire = {
    key: string;
    d: string;
    halo: string;
    kind: "wal" | "mesh" | "front";
    sync?: boolean;
    tone?: number;
    title: string;
  };
  const wires: Wire[] = [];
  const lanePath = (k: number) => x0 + bw + 22 + k * 24;
  flows.forEach((f, k) => {
    const pairs: [string, string][] =
      f.kind === "mesh"
        ? f.from.slice(1).map((h, i) => [f.from[i], h] as [string, string])
        : f.from.flatMap((a) =>
            f.to.filter((b) => b !== a).map((b) => [a, b] as [string, string]),
          );
    pairs.forEach(([a, b], j) => {
      let d: string;
      let halo = "";
      if (stack) {
        const lx = lanePath(k);
        const ya = pillY(a, f.inst, f.from_role);
        const yb = pillY(b, f.inst, f.to_role);
        const edge = x0 + bw; // the card's border; the pill ends PAD inside it
        d = roundPath(
          [
            [edge - PAD, ya],
            [lx, ya],
            [lx, yb],
            [edge - PAD + 1, yb],
          ],
          8,
        );
        halo = roundPath(
          [
            [edge, ya],
            [lx, ya],
            [lx, yb],
            [edge, yb],
          ],
          8,
        ); // the gap where wires cross is cut only outside the card
      } else {
        const ya = frontsH + rowBox;
        const ly = ya + 20 + k * 22;
        // Offset each flow's stem slightly on the card's bottom edge so parallel stems don't blur together
        const stemDx = lanes > 1 ? (k - (lanes - 1) / 2) * 12 : 0;
        const ca = cards[index.get(a) ?? 0].x + bw / 2 + stemDx;
        const cb = cards[index.get(b) ?? 0].x + bw / 2 + stemDx;
        d = roundPath(
          [
            [ca, ya],
            [ca, ly],
            [cb, ly],
            [cb, ya + 1],
          ],
          7,
        );
      }
      wires.push({
        key: `${f.id}-${f.inst.id}-${j}`,
        d,
        halo: halo || d,
        kind: f.kind === "mesh" ? "mesh" : "wal",
        sync: f.sync,
        title: f.title,
      });
    });
  });

  // Track which fronts target each host so landing ports & arrowheads never collide on a shared backend
  const hostFrontSlots = new Map<string, number[]>();
  fronts.forEach((f, k) => {
    used
      .filter((h) => f.targets.includes(h.name))
      .forEach((h) => {
        const arr = hostFrontSlots.get(h.name) || [];
        arr.push(k);
        hostFrontSlots.set(h.name, arr);
      });
  });

  fronts.forEach((f, k) => {
    const box = frontBoxes[k];
    const pyMid = box.y + box.h / 2;
    const pyBottom = box.y + box.h;
    const targetHosts = used.filter((h) => f.targets.includes(h.name));
    targetHosts.forEach((h, i) => {
      const slots = hostFrontSlots.get(h.name) || [k];
      const slotIdx = Math.max(0, slots.indexOf(k));
      const slotCount = slots.length;
      let d: string;
      if (stack) {
        const lx = x0 - 16 - (nFront - 1 - k) * 18;
        const dy = slotCount > 1 ? (slotIdx - (slotCount - 1) / 2) * 12 : 0;
        const ty = cardMid(h.name) + dy;
        d = roundPath(
          [
            [box.x, pyMid],
            [lx, pyMid],
            [lx, ty],
            [x0 - 1, ty],
          ],
          8,
        );
      } else {
        const card = cards[index.get(h.name) ?? 0];
        const spreadX = slotCount > 1 ? Math.min(24, (bw - 56) / slotCount) : 0;
        const tx = card.x + bw / 2 + (slotIdx - (slotCount - 1) / 2) * spreadX;
        // Spread departure slightly along the bottom of this front box when fanning to multiple hosts
        const depSpan = Math.min(box.w * 0.42, Math.max(0, (targetHosts.length - 1) * 16));
        const sx =
          targetHosts.length > 1
            ? box.cx - depSpan / 2 + (i / (targetHosts.length - 1)) * depSpan
            : box.cx;
        const hasLowerRow = frontRows.length > 1 && box.row < frontRows.length - 1;
        if (hasLowerRow) {
          // Route around the outer side channel so wires from upper rows never cross lower entrypoint pills
          const sideX = box.cx <= W / 2 ? 10 + k * 6 : W - 10 - k * 6;
          const busY = frontsH - 22 - box.row * 6;
          d = roundPath(
            [
              [box.cx <= W / 2 ? box.x : box.x + box.w, pyMid],
              [sideX, pyMid],
              [sideX, busY],
              [tx, busY],
              [tx, frontsH - 1],
            ],
            8,
          );
        } else {
          const spanY = frontsH - pyBottom;
          const c1y = pyBottom + spanY * (0.42 + (k % 2) * 0.14);
          const c2y = frontsH - spanY * (0.36 - (k % 2) * 0.08);
          d = `M${sx} ${pyBottom} C ${sx} ${c1y}, ${tx} ${c2y}, ${tx} ${frontsH - 1}`;
        }
      }
      wires.push({
        key: `front-${k}-${i}`,
        d,
        halo: d,
        kind: "front",
        tone: f.tone,
        title: `${f.title} (${f.label}) → ${h.name}`,
      });
    });
  });
  const wireClass = (w: Wire) =>
    w.kind === "front"
      ? `link-live${w.tone ? ` f${w.tone}` : ""}`
      : w.kind === "mesh"
        ? "link-mesh"
        : `link-wal ${w.sync ? "sync" : ""}`;
  const wireArrow = (w: Wire) =>
    w.kind === "mesh"
      ? undefined
      : `url(#${arrow(w.kind === "front" ? "live" : "wal", w.sync, w.tone)})`;
  const legend = [
    ...flows
      .filter(
        (f, i) =>
          flows.findIndex((g) => g.id === f.id && g.title === f.title) === i,
      )
      .map((f) => ({
        key: f.id,
        cls:
          f.kind === "mesh" ? "link-mesh" : `link-wal ${f.sync ? "sync" : ""}`,
        text: f.title,
        tag: f.sync
          ? bi("同步", "Sync")
          : f.kind === "replication"
            ? bi("异步", "Async")
            : "",
      })),
    ...(multiFront
      ? fronts.map((f, idx) => ({
          key: `front-${idx}`,
          cls: `link-live${f.tone ? ` f${f.tone}` : ""}`,
          text: `${f.title} (${f.label.split(":").pop()})`,
          tag: f.external ? bi("外部", "EXT") : "",
        }))
      : fronts.length
        ? [
            {
              key: "front",
              cls: "link-live",
              text: bi("客户端 → 入口 → 后端", "Client → Entry → Backend"),
              tag: "",
            },
          ]
        : []),
  ];
  return (
    <div className="topo-scroll" ref={wrap}>
      <svg
        className={`topo ig ${stack ? "stack" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        style={
          stack
            ? { maxWidth: W }
            : { maxWidth: W, minWidth: Math.min(W, 480) }
        }
        role="img"
        aria-label={bi(
          `${used.length} 台机器，${real.length} 个组件实例，${flows.length + fronts.length} 条连接`,
          `${used.length} hosts, ${real.length} instances, ${flows.length + fronts.length} links`,
        )}
      >
        <defs>
          {["wal", "wal-sync", "live", "live-1", "live-2"].map((k) => (
            <marker
              key={k}
              id={`${uid}-${k}`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0 0.8 L7 4 L0 7.2 Z" className={`ig-arrow ${k}`} />
            </marker>
          ))}
        </defs>
        {used.map((h, i) => {
          const c = cards[i];
          const list = chips(h.name);
          const name = clip(h.name, stack ? leftColW : 100);
          const ipText = clip(h.ip || "—", stack ? leftColW : bw - 28);
          return (
            <g
              key={h.name}
              className={`ig-host ${targeted.has(h.name) ? "targeted" : ""} ${sources.has(h.name) ? "source" : ""}`}
              transform={`translate(${c.x} ${c.y})`}
            >
              <rect
                className="ig-card-shadow"
                x={0}
                y={2}
                width={c.w}
                height={c.h}
                rx={8}
              />
              <rect className="ig-card-body" width={c.w} height={c.h} rx={8} />
              <line
                className="ig-card-rim"
                x1={10}
                y1={1}
                x2={c.w - 10}
                y2={1}
              />
              <text x={14} y={stack ? 24 : 20} className="t-name">
                {name}
              </text>
              {h.name === controller && (
                <g
                  transform={`translate(${stack ? 14 : c.w - 44} ${stack ? 32 : 8})`}
                  className="ig-badge"
                >
                  <rect width={30} height={15} rx={4} />
                  <text x={15} y={11} textAnchor="middle">
                    {bi("控制", "Ctrl")}
                  </text>
                </g>
              )}
              <text
                x={14}
                y={stack ? (h.name === controller ? 64 : 44) : 35}
                className="t-ip"
              >
                <title>{h.ip || "—"}</title>
                {ipText}
              </text>
              {list.map((ch, k) => {
                const isPrim =
                  ch.role === "primary" ||
                  ch.role === "master" ||
                  ch.role === "leader";
                return (
                  <g
                    key={k}
                    className={`ig-chip ${tintClass(order[ch.inst.component] ?? ch.ii)} ${isPrim ? "is-primary" : ""} ${ch.inst.auto ? "auto" : ""}`}
                    transform={
                      stack
                        ? `translate(${c.w - PAD - CW} ${PAD + k * PITCH})`
                        : `translate(10 ${top0 + k * PITCH})`
                    }
                  >
                    <title>{chipLabel(ch)}</title>
                    <rect width={CW} height={CH} rx={5} />
                    <text x={10} y={CH / 2 + 4}>
                      {clip(chipLabel(ch), CW - 18)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
        <g className="topo-links">
          {wires.map((w) => (
            <path key={`h-${w.key}`} d={w.halo} className="halo" />
          ))}
        </g>
        <g className="topo-links">
          {wires.map((w) => (
            <path
              key={w.key}
              d={w.d}
              className={wireClass(w)}
              markerEnd={wireArrow(w)}
            >
              <title>{w.title}</title>
            </path>
          ))}
          {!calm &&
            wires
              .filter((w) => w.kind !== "mesh")
              .map((w, i) => {
                /* Keep particle travel speed uniform across short and long wires (~88px/s) without CPU blur filters. */
                const pts = (w.d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
                let len = 0;
                for (let p = 2; p + 1 < pts.length; p += 2) {
                  len += Math.hypot(pts[p] - pts[p - 2], pts[p + 1] - pts[p - 1]);
                }
                const dur = `${Math.min(4.6, Math.max(2.0, len / 88)).toFixed(2)}s`;
                const delay = `${((i % 4) * 0.45).toFixed(2)}s`;
                const tone =
                  w.kind === "front"
                    ? `live${w.tone ? ` live-${w.tone}` : ""}`
                    : w.sync
                      ? "sync"
                      : "";
                return (
                  <g key={`pulse-${w.key}`} opacity={0}>
                    <circle r={5.2} className={`pulse-halo ${tone}`} />
                    <circle r={2.5} className={`pulse ${tone}`} />
                    {/* Delayed particles stay hidden until motion starts at their path. */}
                    <animate
                      attributeName="opacity"
                      values="0;1;1;0"
                      keyTimes="0;0.06;0.94;1"
                      dur={dur}
                      begin={delay}
                      repeatCount="indefinite"
                    />
                    <animateMotion
                      dur={dur}
                      begin={delay}
                      calcMode="paced"
                      repeatCount="indefinite"
                      path={w.d}
                    />
                  </g>
                );
              })}
        </g>
        {/* Entrypoint pills render above wire anchors so labels & borders stay crisp */}
        {fronts.map((f, k) => {
          const box = frontBoxes[k];
          return (
            <g
              key={f.key}
              className={`topo-elb${f.tone ? ` f${f.tone}` : ""}`}
            >
              <title>{`${f.title} · ${f.label} → ${f.targets.join(", ")}`}</title>
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={7}
              />
              <text x={box.cx} y={box.y + 21} textAnchor="middle">
                <tspan className="t-k">{f.badge}</tspan>
                {/* the pill has a fixed width: a long domain is shortened in the middle, never spilled over the wires */}
                <tspan dx="6">
                  {clipMid(
                    f.label,
                    box.w - 30 - labelWidth(f.badge, 7.2),
                    7.4,
                  )}
                </tspan>
              </text>
            </g>
          );
        })}
        {stack &&
          flows.map((f, k) => {
            const ys = [
              ...f.from.map((h) => pillY(h, f.inst, f.from_role)),
              ...f.to.map((h) => pillY(h, f.inst, f.to_role)),
            ];
            const lx = lanePath(k);
            const short = (f.title.split(/[\s（(，,]/)[0] || f.title).slice(
              0,
              6,
            );
            return (
              <g key={`lane-${f.id}-${f.inst.id}`}>
                {(f.kind === "mesh" ? f.from : [...f.from, ...f.to]).map(
                  (h) => (
                    <circle
                      key={h + (f.kind === "mesh" ? "m" : "")}
                      cx={x0 + bw}
                      cy={pillY(
                        h,
                        f.inst,
                        f.kind === "mesh"
                          ? f.from_role
                          : f.from.includes(h)
                            ? f.from_role
                            : f.to_role,
                      )}
                      r={f.kind === "mesh" ? 3.2 : f.from.includes(h) ? 3.2 : 0}
                      className={`port ${f.kind === "mesh" ? "mesh" : f.sync ? "sync" : ""}`}
                    />
                  ),
                )}
                <text
                  x={lx}
                  y={Math.min(...ys) - 12}
                  textAnchor="middle"
                  className={`lane-label ${f.kind === "mesh" ? "mesh" : f.sync ? "sync" : ""}`}
                >
                  {short}
                </text>
              </g>
            );
          })}
      </svg>
      {legend.length > 0 && (
        <ul className="ig-legend" aria-label={bi("连线说明", "Topology legend")}>
          {legend.map((l) => (
            <li key={l.key}>
              <svg width="30" height="8" aria-hidden>
                <path d="M1 4 H29" className={l.cls} />
              </svg>
              <span>{l.text}</span>
              {l.tag && (
                <em
                  className={
                    l.cls.includes("sync")
                      ? "is-sync"
                      : l.cls.includes("link-live")
                        ? "is-live"
                        : l.cls.includes("link-mesh")
                          ? "is-mesh"
                          : "is-wal"
                  }
                >
                  {l.tag}
                </em>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

/* ---------- generation stages ---------- */

const STAGE_PAIRS: [string, string][] = [
  ["校验规格与离线材料", "Validate spec & offline artifacts"],
  ["生成手册与结构化步骤", "Render handbook & playbooks"],
  ["打包各机器", "Package per-host bundles"],
  ["复制离线材料", "Stage offline packages"],
  ["计算校验清单", "Compute checksums"],
];

export function StageTrack({ job }: { job: Job }) {
  useLang();
  const seen: Record<number, string> = {};
  for (const l of job.logs) {
    const m = /^\[(\d)\/5\]\s*(.*)$/.exec(l);
    if (m) seen[Number(m[1]) - 1] = m[2];
  }
  const reached = Math.max(-1, ...Object.keys(seen).map(Number));
  return (
    <ol className="stages">
      {STAGE_PAIRS.map(([zh, en], i) => {
        const title = bi(zh, en);
        let st = "todo";
        if (job.state === "succeeded" || i < reached) st = "done";
        else if (i === reached)
          st =
            job.state === "failed"
              ? "fail"
              : running(job.state)
                ? "now"
                : "done";
        else if (job.state === "failed" && reached < 0 && i === 0) st = "fail";
        return (
          <li key={i} className={`stage st-${st}`}>
            <span className="stage-mark" aria-hidden>
              {st === "done" ? (
                <IconCheck />
              ) : st === "fail" ? (
                <IconClose />
              ) : (
                <span className="num">{i + 1}</span>
              )}
            </span>
            <div>
              <b>{title}</b>
              {seen[i] && <small>{seen[i]}</small>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- empty-state art ---------- */

export function PackagesArt() {
  return (
    <svg
      className="art"
      width="180"
      height="120"
      viewBox="0 0 180 120"
      aria-hidden
    >
      <defs>
        <linearGradient id="pa-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--brand)" stopOpacity=".9" />
          <stop offset="1" stopColor="var(--brand)" stopOpacity=".55" />
        </linearGradient>
      </defs>
      <ellipse cx="90" cy="108" rx="70" ry="7" fill="var(--line)" />
      <g className="art-box b1">
        <rect
          x="22"
          y="52"
          width="44"
          height="46"
          rx="8"
          fill="var(--surface)"
          stroke="var(--line-strong)"
        />
        <rect
          x="30"
          y="62"
          width="28"
          height="4"
          rx="2"
          fill="var(--line-strong)"
        />
        <rect x="30" y="70" width="18" height="4" rx="2" fill="var(--line)" />
      </g>
      <g className="art-box b2">
        <rect x="68" y="30" width="44" height="68" rx="8" fill="url(#pa-g)" />
        <rect
          x="76"
          y="42"
          width="28"
          height="4"
          rx="2"
          fill="#fff"
          fillOpacity=".8"
        />
        <rect
          x="76"
          y="50"
          width="18"
          height="4"
          rx="2"
          fill="#fff"
          fillOpacity=".5"
        />
        <circle
          cx="90"
          cy="80"
          r="7"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
        />
        <path
          d="M90 76v8M86.5 81l3.5 3.5 3.5-3.5"
          stroke="#fff"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
      </g>
      <g className="art-box b3">
        <rect
          x="114"
          y="52"
          width="44"
          height="46"
          rx="8"
          fill="var(--surface)"
          stroke="var(--line-strong)"
        />
        <rect
          x="122"
          y="62"
          width="28"
          height="4"
          rx="2"
          fill="var(--line-strong)"
        />
        <rect x="122" y="70" width="18" height="4" rx="2" fill="var(--line)" />
      </g>
    </svg>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd>{children}</kbd>;
}

/** A block whose height follows its content smoothly: when something inside grows or shrinks (a list gets a row, a
 *  diagram another machine, an answer another line), what comes after it slides instead of jumping. Immediate when the
 *  person asked for less motion. */
export function Smooth({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    o.style.height = `${i.offsetHeight}px`;
    // only animate after the first size is known, or every block would grow in from nothing on page load
    const raf = requestAnimationFrame(() => o.classList.add("smooth-on"));
    const ro = new ResizeObserver(() => {
      o.style.height = `${i.offsetHeight}px`;
    });
    ro.observe(i);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);
  return (
    <div ref={outer} className={`smooth ${className || ""}`}>
      <div ref={inner} className="smooth-in">
        {children}
      </div>
    </div>
  );
}

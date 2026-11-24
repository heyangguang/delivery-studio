import React, { useEffect, useMemo, useRef, useState } from "react";
import { Popover, Switch } from "@arco-design/web-react";
import {
  IconBook,
  IconBulb,
  IconCheck,
  IconDown,
  IconEye,
  IconFolder,
  IconLink,
  IconPlus,
  IconSafe,
  IconSettings,
  IconStorage,
  IconThunderbolt,
  IconUpload,
} from "@arco-design/web-react/icon";
import { cached, can, fetchCached, useAIStatus } from "./shared";
import { go } from "./router";
import { bi, useLang } from "./i18n";
import "./aitools.css";

/* What a person switches on for their messages, the way chat apps put it behind a "+": think harder, search the
   web, sandbox permission tier, and which skills and outside services the assistant may use. */

export type SandboxMode = "ask" | "auto" | "open";
type NetPolicy = "deny" | "ask" | "auto" | "allow";

type Options = {
  web: boolean;
  web_provider?: string;
  sandbox?: boolean;
  sandbox_exec_policy?: SandboxMode;
  sandbox_net_policy?: NetPolicy;
  skills: {
    name: string;
    title: string;
    description: string;
    mine?: boolean;
  }[];
  mcp: { id: string; name: string; tools: number; mine?: boolean }[];
  kb?: number;
  kb_team?: number;
};
type Pref = {
  think: string;
  web: boolean;
  skillsOff: string[];
  mcpOff: string[];
  noKB?: boolean;
  sandboxMode?: "" | SandboxMode;
  sandboxAsk?: boolean; // legacy field migrated to sandboxMode="ask"
};
export type AIOpts = {
  think: string;
  web: boolean;
  skills: string[] | null;
  mcp: string[] | null;
  no_kb: boolean;
  sandbox_mode?: SandboxMode;
};

function resolveSandboxMode(
  platformDefault: SandboxMode,
  picked?: "" | SandboxMode,
): SandboxMode {
  return picked || platformDefault;
}

const KEY = "mh-ai-opts";
const readPref = (): Pref => {
  try {
    const p = {
      think: "",
      web: false,
      skillsOff: [],
      mcpOff: [],
      ...JSON.parse(localStorage.getItem(KEY) || "{}"),
    };
    if (p.think === true) p.think = "high";
    if (p.think === false) p.think = "";
    if (!p.sandboxMode && p.sandboxAsk) p.sandboxMode = "ask";
    return p;
  } catch {
    return { think: "", web: false, skillsOff: [], mcpOff: [] };
  }
};

export function useAIOptions() {
  const aiStatus = useAIStatus();
  const [o, setO] = useState<Options | undefined>(() =>
    cached<Options>("/api/ai/options"),
  );
  const [pref, setPref] = useState<Pref>(readPref);
  useEffect(() => {
    fetchCached<Options>("/api/ai/options")
      .then(setO)
      .catch(() => undefined);
  }, [aiStatus]);
  const update = (p: Partial<Pref>) =>
    setPref((cur) => {
      const next = { ...cur, ...p };
      if ("sandboxMode" in p) delete next.sandboxAsk;
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* a convenience only */
      }
      return next;
    });
  const opts: AIOpts = useMemo(() => {
    const skills = o?.skills.map((s) => s.name) || [];
    const mcp = o?.mcp.map((m) => m.id) || [];
    const platformDefault: SandboxMode = o?.sandbox_exec_policy || "auto";
    const effMode = resolveSandboxMode(platformDefault, pref.sandboxMode);
    return {
      think: pref.think,
      web: pref.web && !!o?.web,
      skills: pref.skillsOff.length
        ? skills.filter((n) => !pref.skillsOff.includes(n))
        : null,
      mcp: pref.mcpOff.length
        ? mcp.filter((n) => !pref.mcpOff.includes(n))
        : null,
      no_kb: !!pref.noKB,
      sandbox_mode: effMode !== platformDefault ? effMode : undefined,
    };
  }, [o, pref]);
  return { options: o, pref, update, opts };
}

/** A globe: the web. */
function Globe() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.7 3.8 2.7 6.2S9.8 12.5 8 14.2M8 1.8C6.2 3.5 5.3 5.6 5.3 8s.9 4.5 2.7 6.2" />
    </svg>
  );
}

/** The "+" menu and, beside it, what is switched on. */
const LEVELS: Record<string, string> = {
  get low() {
    return bi("低", "Low");
  },
  get medium() {
    return bi("中", "Medium");
  },
  get high() {
    return bi("高", "High");
  },
  get xhigh() {
    return bi("很高", "Very high");
  },
  get max() {
    return bi("最高", "Max");
  },
  get ultra() {
    return bi("极高", "Ultra");
  },
};
const LEVEL_HINT: Record<string, string> = {
  get low() {
    return bi("想得少，回答快", "Thinks less, replies faster");
  },
  get medium() {
    return bi("平衡速度与深度", "Balances speed and depth");
  },
  get high() {
    return bi("想得比较深", "Thinks fairly deeply");
  },
  get xhigh() {
    return bi("想得很深，明显更慢", "Thinks very deeply, noticeably slower");
  },
  get max() {
    return bi("想到最深，慢", "Deepest reasoning, slower");
  },
  get ultra() {
    return bi("最深的一档，最慢，费用也最高", "Maximum tier, slowest and highest cost");
  },
};

function ThinkPills({
  levels,
  value,
  onChange,
  layout = "inline",
}: {
  levels?: string[];
  value: string;
  onChange: (v: string) => void;
  layout?: "popover" | "inline";
}) {
  useLang();
  const validLevels = (levels || []).filter((l) => LEVELS[l]);
  const active = value && validLevels.includes(value) ? value : "";
  const stops = ["", ...validLevels];
  const maxIdx = Math.max(1, stops.length - 1);
  const idx = Math.max(0, stops.indexOf(active));
  const trackRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; moved: boolean } | null>(null);
  const [pressed, setPressed] = useState(false);
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  const ratioFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return idx / maxIdx;
    const r = el.getBoundingClientRect();
    const usable = Math.max(1, r.width - 30);
    return Math.max(0, Math.min(1, (clientX - r.left - 15) / usable));
  };

  const dragging = dragRatio !== null;
  const displayProgress = dragRatio !== null ? dragRatio : idx / maxIdx;
  const displayIdx = Math.round(displayProgress * maxIdx);
  const displayVal = stops[displayIdx] ?? "";
  const fillOpacity =
    displayProgress <= 0.005 ? 0 : Math.min(1, displayProgress / 0.12);
  const ultraOpacity = Math.max(
    0,
    Math.min(1, (displayProgress - 0.72) / 0.24),
  );

  const tierTone = !displayVal
    ? "auto"
    : displayVal === "ultra"
      ? "ultra"
      : displayVal === "max"
        ? "max"
        : displayVal === "xhigh" || displayVal === "high"
          ? "high"
          : displayVal === "medium"
            ? "medium"
            : "low";
  const label = displayVal ? LEVELS[displayVal] : bi("默认", "Default");
  const hint = displayVal
    ? LEVEL_HINT[displayVal]
    : bi("不指定，用模型自己的默认", "Unspecified; use model default");

  const finishPointer = (clientX: number, commit: boolean) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    setPressed(false);
    setDragRatio(null);
    if (!commit || !start) return;
    const finalRatio = ratioFromClientX(clientX);
    const nextIdx = Math.round(finalRatio * maxIdx);
    const nextVal = stops[nextIdx] ?? "";
    if (nextVal !== active) onChange(nextVal);
  };

  return (
    <div
      className={`thk thk-slider-wrap ${layout === "popover" ? "in-pop" : "in-menu"}`}
    >
      <div className={`thk-slider-head tone-${tierTone}`}>
        <span className="thk-slider-title">{label}</span>
        <small className="thk-slider-hint">{hint}</small>
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={bi("思考深度", "Thinking depth")}
        aria-valuemin={0}
        aria-valuemax={maxIdx}
        aria-valuenow={displayIdx}
        aria-valuetext={`${label} — ${hint}`}
        className={`thk-track ${displayVal ? "lit" : ""} tone-${tierTone} ${dragging ? "dragging" : ""} ${pressed ? "pressed" : ""}`}
        style={
          {
            "--p": displayProgress,
            "--fill-op": fillOpacity,
            "--ultra-op": ultraOpacity,
          } as React.CSSProperties
        }
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragStartRef.current = { x: e.clientX, moved: false };
          setPressed(true);
        }}
        onPointerMove={(e) => {
          const start = dragStartRef.current;
          if (!start) return;
          if (!start.moved && Math.abs(e.clientX - start.x) < 3) return;
          start.moved = true;
          setDragRatio(ratioFromClientX(e.clientX));
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
          finishPointer(e.clientX, true);
        }}
        onPointerCancel={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
          finishPointer(e.clientX, false);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            onChange(stops[Math.min(maxIdx, idx + 1)] ?? "");
          } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            onChange(stops[Math.max(0, idx - 1)] ?? "");
          } else if (e.key === "Home") {
            e.preventDefault();
            onChange("");
          } else if (e.key === "End") {
            e.preventDefault();
            onChange(stops[maxIdx] ?? "");
          }
        }}
      >
        <div
          className={`thk-fill ${displayProgress > 0.005 ? "on" : ""} tone-${tierTone}`}
          aria-hidden
        >
          <span className="thk-stars" />
        </div>
        <div className="thk-dots" aria-hidden>
          {stops.map((s, i) => {
            const p = i / maxIdx;
            const lit = displayProgress > 0.04 && p < displayProgress - 0.03;
            const covered = Math.abs(p - displayProgress) < 0.055;
            return (
              <span
                key={s || "default"}
                data-stop={s || "default"}
                title={s ? LEVELS[s] : bi("默认", "Default")}
                className={`thk-dot ${lit ? "in-fill" : ""} ${covered ? "active" : ""}`}
                style={{ left: `calc(15px + (100% - 30px) * ${p})` }}
              />
            );
          })}
        </div>
        <span className="thk-thumb" aria-hidden />
      </div>
    </div>
  );
}

type PopPos = "tl" | "tr" | "bl" | "br";

export type PopoverHandle = {
  updatePopupPosition?: (delay?: number) => void;
};

/** Keeps an open Arco Popover pixel-locked to its trigger during hover-expand animations, scroll, resize, or label width changes. */
export function useTrackPopoverPosition(
  open: boolean,
  popRef: React.RefObject<PopoverHandle | null>,
  btnRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let last = "";
    const sync = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const key = `${Math.round(r.left * 2)},${Math.round(r.top * 2)},${Math.round(r.width * 2)},${Math.round(r.height * 2)}`;
      if (key !== last) {
        last = key;
        popRef.current?.updatePopupPosition?.(0);
      }
    };
    const start = performance.now();
    const tick = (now: number) => {
      sync();
      if (now - start < 480) {
        raf = window.requestAnimationFrame(tick);
      }
    };
    raf = window.requestAnimationFrame(tick);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => sync())
        : null;
    if (ro && btnRef.current) {
      ro.observe(btnRef.current);
      if (btnRef.current.parentElement) ro.observe(btnRef.current.parentElement);
    }
    const onMove = () => sync();
    window.addEventListener("resize", onMove, { passive: true });
    window.addEventListener("scroll", onMove, { capture: true, passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, popRef, btnRef]);
}

function computePopPos(
  el: HTMLElement | null,
  estHeight: number,
  estWidth: number,
): PopPos {
  if (!el) return "tl";
  const r = el.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const down = below >= estHeight || (below > above && below >= 120);
  const rightSpace = window.innerWidth - r.left;
  const alignRight = rightSpace < estWidth && r.right > rightSpace;
  return `${down ? "b" : "t"}${alignRight ? "r" : "l"}` as PopPos;
}

export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 0) setW((prev) => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function ThinkLevel({
  levels,
  value,
  onChange,
  compact,
}: {
  levels?: string[];
  value: string;
  onChange: (v: string) => void;
  compact?: boolean;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopPos>("tl");
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<PopoverHandle>(null);
  useTrackPopoverPosition(open, popRef, btnRef);
  const validLevels = (levels || []).filter((l) => LEVELS[l]);
  if (validLevels.length === 0) return null;
  const active = value && validLevels.includes(value) ? value : "";
  const prefix = bi("思考", "Think");
  const defText = bi("默认", "Default");
  const allLabels = compact
    ? []
    : [
        `${prefix} · ${defText}`,
        ...validLevels.map((l) => `${prefix} · ${LEVELS[l]}`),
      ];
  return (
    <Popover
      ref={popRef as React.Ref<never>}
      trigger="click"
      position={pos}
      popupVisible={open}
      escToClose
      onVisibleChange={(v) => {
        if (v) setPos(computePopPos(btnRef.current, 128, 328));
        setOpen(v);
      }}
      className="tm-pop think-pop"
      triggerProps={{ autoFitPosition: false, updateOnScroll: true }}
      content={
        <ThinkPills
          layout="popover"
          levels={validLevels}
          value={active}
          onChange={onChange}
        />
      }
    >
      <button
        ref={btnRef}
        type="button"
        className={`tm-tog think ${compact ? "compact" : ""} ${active ? "on" : ""} ${open ? "tm-open" : ""}`}
        aria-expanded={open}
        title={
          active
            ? bi(
                `思考深度：${LEVELS[active]}（点击调整）`,
                `Thinking depth: ${LEVELS[active]} (click to adjust)`,
              )
            : bi("思考深度：默认（点击调整）", "Thinking depth: Default (click to adjust)")
        }
      >
        <IconBulb />
        <span className="tm-think-label">
          <span className="tm-think-cur">
            {prefix}
            {compact ? (
              active ? (
                <span className="tm-think-tier">·{LEVELS[active]}</span>
              ) : null
            ) : (
              <span className={`tm-think-tier ${active ? "" : "is-def"}`}>
                {" · "}
                {active ? LEVELS[active] : defText}
              </span>
            )}
          </span>
          {allLabels.map((lbl) => (
            <span key={lbl} className="tm-think-sizer" aria-hidden="true">
              {lbl}
            </span>
          ))}
        </span>
      </button>
    </Popover>
  );
}

const SB_MODES: {
  id: SandboxMode;
  icon: React.ReactNode;
  readonly label: string;
  readonly short: string;
  readonly desc: string;
}[] = [
  {
    id: "ask",
    icon: <IconEye />,
    get label() {
      return bi("每次询问", "Request Review");
    },
    get short() {
      return bi("每次询问", "Ask");
    },
    get desc() {
      return bi(
        "每次执行 Python、Shell 或脚本前都需要人工确认",
        "Every code run or shell command requires approval",
      );
    },
  },
  {
    id: "auto",
    icon: <IconSafe />,
    get label() {
      return bi("智能审批", "Auto");
    },
    get short() {
      return bi("智能审批", "Auto");
    },
    get desc() {
      return bi(
        "低风险计算自动放行，高风险调用与敏感联网再询问",
        "Auto-runs safe tasks; prompts before sensitive actions",
      );
    },
  },
  {
    id: "open",
    icon: <IconThunderbolt />,
    get label() {
      return bi("沙箱开放", "Turbo");
    },
    get short() {
      return bi("沙箱开放", "Open");
    },
    get desc() {
      return bi(
        "隔离沙箱边界内直接执行，不逐次弹窗确认",
        "Run commands inside the isolated sandbox without prompts",
      );
    },
  },
];

function netPolicyBadge(netPolicy?: NetPolicy): string {
  switch (netPolicy) {
    case "deny":
      return bi("网络：完全断网", "Net: Offline");
    case "auto":
      return bi("网络：智能审批", "Net: Smart Auto");
    case "allow":
      return bi("网络：允许外网", "Net: External");
    default:
      return bi("网络：每次询问", "Net: Ask");
  }
}

function SandboxPermList({
  platformDefault,
  netPolicy,
  value,
  onSelect,
  onOpenSettings,
}: {
  platformDefault: SandboxMode;
  netPolicy?: NetPolicy;
  value: SandboxMode;
  onSelect: (m: SandboxMode) => void;
  onOpenSettings?: () => void;
}) {
  useLang();
  return (
    <div className="sbp" role="menu" aria-label={bi("沙箱权限", "Sandbox permissions")}>
      <div className="sbp-head">
        <span>{bi("沙箱权限", "Sandbox Permissions")}</span>
        <em className={`sbp-net ${netPolicy === "auto" ? "auto" : ""}`}>
          {netPolicyBadge(netPolicy)}
        </em>
      </div>
      <div className="sbp-list">
        {SB_MODES.map((m) => {
          const selected = value === m.id;
          const isDef = platformDefault === m.id;
          return (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className={`sbp-row ${selected ? "on" : ""}`}
              onClick={() => onSelect(m.id)}
            >
              <span className={`sbp-ic m-${m.id}`}>{m.icon}</span>
              <span className="sbp-t">
                <span className="sbp-title">
                  <b>{m.label}</b>
                  {isDef && (
                    <em className="sbp-def">{bi("平台默认", "Default")}</em>
                  )}
                </span>
                <small>{m.desc}</small>
              </span>
              {selected && <IconCheck className="sbp-chk" />}
            </button>
          );
        })}
      </div>
      {can("settings.sandbox") && (
        <div className="sbp-foot">
          <button
            type="button"
            className="sbp-cfg"
            onClick={() => {
              onOpenSettings?.();
              go({ name: "settings", id: "sandbox" });
            }}
          >
            <IconSettings />
            <span>{bi("在 设置 → 代码沙箱 调整平台默认与网络策略", "Adjust defaults & network in Settings → Code Sandbox")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function SandboxPermPill({
  platformDefault,
  netPolicy,
  value,
  onSelect,
}: {
  platformDefault: SandboxMode;
  netPolicy?: NetPolicy;
  value: SandboxMode;
  onSelect: (m: SandboxMode) => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopPos>("tl");
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<PopoverHandle>(null);
  useTrackPopoverPosition(open, popRef, btnRef);
  const cur = SB_MODES.find((m) => m.id === value) || SB_MODES[1];
  const overridden = value !== platformDefault;

  return (
    <Popover
      ref={popRef as React.Ref<never>}
      trigger="click"
      position={pos}
      popupVisible={open}
      escToClose
      className="tm-pop sbp-pop"
      triggerProps={{ autoFitPosition: false, updateOnScroll: true }}
      onVisibleChange={(v) => {
        if (v) setPos(computePopPos(btnRef.current, 240, 316));
        setOpen(v);
      }}
      content={
        <SandboxPermList
          platformDefault={platformDefault}
          netPolicy={netPolicy}
          value={value}
          onSelect={(m) => {
            onSelect(m);
            setOpen(false);
          }}
          onOpenSettings={() => setOpen(false)}
        />
      }
    >
      <button
        ref={btnRef}
        type="button"
        className={`tm-tog sbp-pill m-${value} ${overridden ? "on" : ""} ${open ? "tm-open" : ""}`}
        aria-expanded={open}
        title={bi(
          "沙箱执行权限（个人选择优先于平台默认）",
          "Sandbox permission tier (your choice overrides platform default)",
        )}
      >
        {cur.icon}
        <span>{cur.short}</span>
        <IconDown className="sbp-caret" />
      </button>
    </Popover>
  );
}

/**
 * Coordinates spacious open-page composers so hovering gives tactile lift/glow with zero
 * toolbar shift, clicking/typing into the text area smoothly expands the canvas, and clicking
 * toolbar controls (e.g. Thinking/Model/Tools) or their portal popovers never shifts or collapses it.
 */
export function useSpaciousComposer(
  rootRef: React.RefObject<HTMLElement | null>,
  hasContent: boolean,
) {
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    if (!writing) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (
        target.closest(
          ".arco-trigger-popup, .arco-popover, .arco-dropdown-menu, .tm-pop, .think-pop, .mp-pop",
        )
      ) {
        return;
      }
      setWriting(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const active = document.activeElement as HTMLElement | null;
        if (!active || !rootRef.current?.contains(active)) setWriting(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [writing, rootRef]);

  return {
    expanded: writing || hasContent,
    onFieldPointerDown: () => setWriting(true),
    collapse: () => setWriting(false),
  };
}

/** compact: a narrow window keeps only the "+"; hidden controls move into its menu. */
export function ToolMenu({
  t,
  levels,
  attach,
  compact,
  hideThink,
  thinkInMenu,
}: {
  t: ReturnType<typeof useAIOptions>;
  levels?: string[];
  attach?: {
    upload?: () => void;
    pick?: () => void;
    uploadTitle?: string;
    uploadDesc?: string;
  };
  compact?: boolean;
  hideThink?: boolean;
  thinkInMenu?: boolean;
}) {
  useLang();
  const { options: o, pref, update, opts } = t;
  const [open, setOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [sbOpen, setSbOpen] = useState(false);
  const [pos, setPos] = useState<PopPos>("tl");
  const [room, setRoom] = useState(420);
  const btn = useRef<HTMLButtonElement>(null);
  const popRef = useRef<PopoverHandle>(null);
  useTrackPopoverPosition(open, popRef, btn);
  const showThinkInMenu = thinkInMenu ?? Boolean(compact);
  const sbDefault: SandboxMode = o?.sandbox_exec_policy || "auto";
  const sbEffective = resolveSandboxMode(sbDefault, pref.sandboxMode);
  const sbCurMeta = SB_MODES.find((m) => m.id === sbEffective) || SB_MODES[1];
  const selectSandboxMode = (m: SandboxMode) =>
    update({ sandboxMode: m === sbDefault ? "" : m });
  const skillsOn = (o?.skills || []).filter(
    (s) => !pref.skillsOff.includes(s.name),
  ).length;
  const panel = (
    <div
      className="tm"
      role="dialog"
      aria-label={bi("工具", "Tools")}
      style={{ maxHeight: room }}
    >
      {attach && (attach.upload || attach.pick) && (
        <div className="tm-sec tm-attach">
          {attach.upload && (
            <button
              type="button"
              className="tm-row"
              onClick={() => (setOpen(false), attach.upload?.())}
            >
              <span className="tm-ic upl">
                <IconUpload />
              </span>
              <span className="tm-t">
                <b>
                  {attach.uploadTitle ||
                    bi("上传文件或图片", "Upload file or image")}
                </b>
                <small>
                  {attach.uploadDesc ||
                    bi(
                      "也可以直接拖进来或粘贴；会存进「我的资料」",
                      "Or drag and drop / paste directly; saved to My Files",
                    )}
                </small>
              </span>
            </button>
          )}
          {attach.pick && (
            <button
              type="button"
              className="tm-row"
              onClick={() => (setOpen(false), attach.pick?.())}
            >
              <span className="tm-ic kb">
                <IconFolder />
              </span>
              <span className="tm-t">
                <b>{bi("从我的资料选择", "Choose from My Files")}</b>
                <small>{bi("用之前传过的文件", "Use previously uploaded files")}</small>
              </span>
            </button>
          )}
        </div>
      )}
      {showThinkInMenu && levels && levels.length > 0 && (
        <div className="tm-row tm-think">
          <span className="tm-ic think">
            <IconBulb />
          </span>
          <span className="tm-t">
            <b>{bi("思考深度", "Thinking depth")}</b>
            <ThinkPills
              layout="inline"
              levels={levels}
              value={pref.think}
              onChange={(v) => update({ think: v })}
            />
          </span>
        </div>
      )}
      <label className={`tm-row ${o?.web ? "" : "dis"}`}>
        <span className="tm-ic web">
          <Globe />
        </span>
        <span className="tm-t">
          <b>{bi("联网搜索与安全核查", "Web search & security lookup")}</b>
          <small>
            {o?.web
              ? bi(
                  "含网页搜索、网页正文读取，以及 OSV/PyPI 官方 CVE 安全公告与最新版本核查",
                  "Includes web search, page fetch, and official OSV/PyPI CVE & release lookup",
                )
              : can("ai.settings")
                ? bi(
                    "尚未开启联网搜索（可在 设置 → AI → 联网搜索 开启）",
                    "Web search is off (enable in Settings → AI → Web search)",
                  )
                : bi(
                    "管理员尚未开启联网搜索",
                    "Web search has not been enabled by an administrator",
                  )}
          </small>
        </span>
        <Switch
          size="small"
          checked={opts.web}
          disabled={!o?.web}
          onChange={(v) => update({ web: v })}
          aria-label={bi("联网搜索", "Web search")}
        />
      </label>
      {(o?.kb || 0) + (o?.kb_team || 0) > 0 && (
        <label className="tm-row">
          <span className="tm-ic kb">
            <IconStorage />
          </span>
          <span className="tm-t">
            <b>{bi("知识库", "Knowledge base")}</b>
            <small>
              {bi(
                `${[
                  o!.kb ? `你的 ${o!.kb} 份资料` : "",
                  o!.kb_team ? `团队的 ${o!.kb_team} 份资料` : "",
                ]
                  .filter(Boolean)
                  .join("和")}里先找相关内容`,
                `Search ${[
                  o!.kb ? `your ${o!.kb} doc${o!.kb === 1 ? "" : "s"}` : "",
                  o!.kb_team
                    ? `team's ${o!.kb_team} doc${o!.kb_team === 1 ? "" : "s"}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" and ")} first`,
              )}
            </small>
          </span>
          <Switch
            size="small"
            checked={!pref.noKB}
            onChange={(v) => update({ noKB: !v })}
            aria-label={bi("使用知识库", "Use knowledge base")}
          />
        </label>
      )}
      {compact && o?.sandbox && (
        <div className="tm-sec">
          <button
            type="button"
            className="tm-row tm-head"
            onClick={() => setSbOpen((v) => !v)}
            aria-expanded={sbOpen}
          >
            <span className="tm-ic sandbox">{sbCurMeta.icon}</span>
            <span className="tm-t">
              <b>
                {bi("沙箱权限", "Sandbox Permissions")} · {sbCurMeta.short}
              </b>
              <small>{netPolicyBadge(o.sandbox_net_policy)}</small>
            </span>
            <IconDown className={sbOpen ? "tm-flip" : ""} />
          </button>
          {sbOpen && (
            <div className="sbp-inline">
              <SandboxPermList
                platformDefault={sbDefault}
                netPolicy={o.sandbox_net_policy}
                value={sbEffective}
                onSelect={(m) => {
                  selectSandboxMode(m);
                  setSbOpen(false);
                }}
                onOpenSettings={() => setOpen(false)}
              />
            </div>
          )}
        </div>
      )}
      {(o?.skills.length || 0) > 0 && (
        <div className="tm-sec">
          <button
            type="button"
            className="tm-row tm-head"
            onClick={() => setSkillsOpen(!skillsOpen)}
            aria-expanded={skillsOpen}
          >
            <span className="tm-ic skill">
              <IconBook />
            </span>
            <span className="tm-t">
              <b>{bi("技能", "Skills")}</b>
              <small>
                {bi(
                  `用 ${skillsOn} / ${o!.skills.length} 个运维技能`,
                  `Using ${skillsOn} / ${o!.skills.length} ops skills`,
                )}
              </small>
            </span>
            <IconDown className={skillsOpen ? "tm-flip" : ""} />
          </button>
          {skillsOpen && (
            <div className="tm-list">
              <div className="tm-all">
                <button type="button" onClick={() => update({ skillsOff: [] })}>
                  {bi("全部启用", "Enable all")}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    update({ skillsOff: o!.skills.map((s) => s.name) })
                  }
                >
                  {bi("全部不用", "Disable all")}
                </button>
              </div>
              {o!.skills.map((s) => (
                <label key={s.name} className="tm-item" title={s.description}>
                  <Switch
                    size="small"
                    checked={!pref.skillsOff.includes(s.name)}
                    onChange={(v) =>
                      update({
                        skillsOff: v
                          ? pref.skillsOff.filter((x) => x !== s.name)
                          : [...pref.skillsOff, s.name],
                      })
                    }
                  />
                  <span>
                    {s.title}{" "}
                    {s.mine && (
                      <em className="tm-mine">{bi("我的", "Mine")}</em>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      {(o?.mcp.length || 0) > 0 && (
        <div className="tm-sec">
          <div className="tm-cap">
            {bi("外部服务（MCP）", "External services (MCP)")}
          </div>
          {o!.mcp.map((m) => (
            <label key={m.id} className="tm-row">
              <span className="tm-ic mcp">
                <IconLink />
              </span>
              <span className="tm-t">
                <b>
                  {m.name}{" "}
                  {m.mine && <em className="tm-mine">{bi("我的", "Mine")}</em>}
                </b>
                <small>
                  {bi(
                    `${m.tools} 个工具`,
                    `${m.tools} tool${m.tools === 1 ? "" : "s"}`,
                  )}
                </small>
              </span>
              <Switch
                size="small"
                checked={!pref.mcpOff.includes(m.id)}
                onChange={(v) =>
                  update({
                    mcpOff: v
                      ? pref.mcpOff.filter((x) => x !== m.id)
                      : [...pref.mcpOff, m.id],
                  })
                }
                aria-label={bi(`使用 ${m.name}`, `Use ${m.name}`)}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <>
      <Popover
        ref={popRef as React.Ref<never>}
        trigger="click"
        position={pos}
        popupVisible={open}
        escToClose
        triggerProps={{ autoFitPosition: false, updateOnScroll: true }}
        onVisibleChange={(v) => {
          if (v && btn.current) {
            const rect = btn.current.getBoundingClientRect();
            const free = window.innerHeight - rect.bottom;
            const up = rect.top;
            const down = free >= 260 || free >= up;
            setPos(computePopPos(btn.current, 260, 336));
            setRoom(Math.max(200, Math.min(420, (down ? free : up) - 24)));
          }
          setOpen(v);
        }}
        content={panel}
        className="tm-pop"
      >
        <button
          type="button"
          ref={btn}
          className={`tm-btn ${open ? "on tm-open" : ""} ${(showThinkInMenu && pref.think) || (compact && opts.web) ? "lit" : ""}`}
          aria-label={bi("工具与选项", "Tools & options")}
          aria-expanded={open}
        >
          <IconPlus />
        </button>
      </Popover>
      {!compact && (
        <>
          {!hideThink && (
            <ThinkLevel
              levels={levels}
              value={pref.think}
              onChange={(v) => update({ think: v })}
            />
          )}
          <button
            type="button"
            className={`tm-tog web ${opts.web ? "on" : ""}`}
            aria-pressed={opts.web}
            disabled={!o?.web}
            title={
              o?.web
                ? bi(
                    "含网页搜索、网页正文读取，以及 OSV/PyPI 官方 CVE 安全公告与最新版本核查",
                    "Includes web search, page reader, and official OSV/PyPI CVE & release lookup",
                  )
                : can("ai.settings")
                  ? bi(
                      "尚未开启联网搜索（可在 设置 → AI → 联网搜索 开启）",
                      "Web search is off (enable in Settings → AI → Web search)",
                    )
                  : bi(
                      "管理员尚未开启联网搜索",
                      "Web search has not been enabled by an administrator",
                    )
            }
            onClick={() => update({ web: !pref.web })}
          >
            <Globe />
            <span>{bi("联网", "Web")}</span>
          </button>
          {o?.sandbox && (
            <SandboxPermPill
              platformDefault={sbDefault}
              netPolicy={o.sandbox_net_policy}
              value={sbEffective}
              onSelect={selectSandboxMode}
            />
          )}
        </>
      )}
    </>
  );
}

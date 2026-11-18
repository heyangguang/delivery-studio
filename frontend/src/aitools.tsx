import React, { useEffect, useMemo, useRef, useState } from "react";
import { Popover, Switch } from "@arco-design/web-react";
import {
  IconBook,
  IconBulb,
  IconCode,
  IconDown,
  IconStorage,
  IconLink,
  IconPlus,
  IconUpload,
  IconFolder,
} from "@arco-design/web-react/icon";
import { cached, can, fetchCached, useAIStatus } from "./shared";
import { bi, useLang } from "./i18n";
import "./aitools.css";

/* What a person switches on for their messages, the way chat apps put it behind a "+": think harder, search the
   web, and which skills and outside services the assistant may use. The choice is remembered in this browser. */

type Options = {
  web: boolean;
  web_provider?: string;
  sandbox?: boolean;
  sandbox_exec_policy?: "ask" | "auto" | "open";
  sandbox_net_policy?: "deny" | "ask" | "allow";
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
  sandboxAsk?: boolean;
};
export type AIOpts = {
  think: string;
  web: boolean;
  skills: string[] | null;
  mcp: string[] | null;
  no_kb: boolean;
  sandbox_mode?: "ask";
};

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
      sandbox_mode: pref.sandboxAsk ? "ask" : undefined,
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
  const progress = idx / maxIdx;
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const pickByClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const usable = Math.max(1, r.width - 30);
    const ratio = Math.max(0, Math.min(1, (clientX - r.left - 15) / usable));
    const nextIdx = Math.round(ratio * maxIdx);
    const nextVal = stops[nextIdx] ?? "";
    if (nextVal !== active) onChange(nextVal);
  };

  const tierTone = !active
    ? "auto"
    : active === "ultra"
      ? "ultra"
      : active === "max" || active === "xhigh"
        ? "high"
        : "blue";
  const label = active ? LEVELS[active] : bi("默认", "Default");
  const hint = active
    ? LEVEL_HINT[active]
    : bi("不指定，用模型自己的默认", "Unspecified; use model default");

  return (
    <div className={`thk thk-slider-wrap ${layout === "popover" ? "in-pop" : "in-menu"}`}>
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
        aria-valuenow={idx}
        aria-valuetext={`${label} — ${hint}`}
        className={`thk-track ${active ? "lit" : ""} tone-${tierTone} ${dragging ? "dragging" : ""}`}
        style={{ "--p": progress } as React.CSSProperties}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          pickByClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging) pickByClientX(e.clientX);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
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
        <div className={`thk-fill ${active ? "on" : ""} tone-${tierTone}`} aria-hidden>
          <span className="thk-stars" />
        </div>
        <div className="thk-dots" aria-hidden>
          {stops.map((s, i) => {
            const p = i / maxIdx;
            const lit = active && i < idx;
            return (
              <span
                key={s || "default"}
                data-stop={s || "default"}
                title={s ? LEVELS[s] : bi("默认", "Default")}
                className={`thk-dot ${lit ? "in-fill" : ""} ${i === idx ? "active" : ""}`}
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

export function ThinkLevel({
  levels,
  value,
  onChange,
}: {
  levels?: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopPos>("tl");
  const btnRef = useRef<HTMLButtonElement>(null);
  const validLevels = (levels || []).filter((l) => LEVELS[l]);
  if (validLevels.length === 0) return null;
  const active = value && validLevels.includes(value) ? value : "";
  return (
    <Popover
      trigger="click"
      position={pos}
      popupVisible={open}
      onVisibleChange={(v) => {
        if (v) setPos(computePopPos(btnRef.current, 128, 296));
        setOpen(v);
      }}
      className="tm-pop think-pop"
      triggerProps={{ autoFitPosition: false }}
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
        className={`tm-tog think ${active ? "on" : ""}`}
        aria-expanded={open}
        title={bi("思考深度：让模型想多深", "Thinking depth: how hard the model thinks")}
      >
        <IconBulb />
        <span>
          {bi("思考", "Think")}
          {active ? ` · ${LEVELS[active]}` : ""}
        </span>
      </button>
    </Popover>
  );
}

/** compact: a narrow window keeps only the "+"; thinking depth and the web switch move into its menu. */
export function ToolMenu({
  t,
  levels,
  attach,
  compact,
}: {
  t: ReturnType<typeof useAIOptions>;
  levels?: string[];
  attach?: { upload: () => void; pick: () => void };
  compact?: boolean;
}) {
  useLang();
  const { options: o, pref, update, opts } = t;
  const [open, setOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [pos, setPos] = useState<PopPos>("tl");
  const [room, setRoom] = useState(420);
  const btn = useRef<HTMLButtonElement>(null);
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
      {attach && (
        <div className="tm-sec tm-attach">
          <button
            type="button"
            className="tm-row"
            onClick={() => (setOpen(false), attach.upload())}
          >
            <span className="tm-ic upl">
              <IconUpload />
            </span>
            <span className="tm-t">
              <b>{bi("上传文件或图片", "Upload file or image")}</b>
              <small>
                {bi(
                  "也可以直接拖进来或粘贴；会存进「我的资料」",
                  "Or drag and drop / paste directly; saved to My Files",
                )}
              </small>
            </span>
          </button>
          <button
            type="button"
            className="tm-row"
            onClick={() => (setOpen(false), attach.pick())}
          >
            <span className="tm-ic kb">
              <IconFolder />
            </span>
            <span className="tm-t">
              <b>{bi("从我的资料选择", "Choose from My Files")}</b>
              <small>{bi("用之前传过的文件", "Use previously uploaded files")}</small>
            </span>
          </button>
        </div>
      )}
      {compact && levels && levels.length > 0 && (
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
          <b>{bi("联网搜索", "Web search")}</b>
          <small>
            {o?.web
              ? bi(
                  "平台和交付里查不到时，去网上找官方文档、版本说明、报错含义",
                  "Search official docs, release notes, and error meanings online when not found locally",
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
      {o?.sandbox && (
        <label className="tm-row">
          <span className="tm-ic sandbox">
            <IconCode />
          </span>
          <span className="tm-t">
            <b>{bi("沙箱代码每次询问", "Ask before sandbox code")}</b>
            <small>
              {o.sandbox_exec_policy === "ask"
                ? bi(
                    "平台已统一开启每次询问授权",
                    "Platform enforces confirmation before every execution",
                  )
                : pref.sandboxAsk
                  ? bi(
                      "每次运行 Python 或技能脚本前先征得我同意",
                      "Ask my permission before each Python or skill script run",
                    )
                  : o.sandbox_exec_policy === "open"
                    ? bi(
                        "当前按平台开放策略运行，开启后改为每次问我",
                        "Currently runs under open policy; turn on to ask every time",
                      )
                    : bi(
                        "当前按 AI 风险分级自动判断，开启后改为每次问我",
                        "Currently auto-decided by risk level; turn on to ask every time",
                      )}
            </small>
          </span>
          <Switch
            size="small"
            checked={o.sandbox_exec_policy === "ask" || !!pref.sandboxAsk}
            disabled={o.sandbox_exec_policy === "ask"}
            onChange={(v) => update({ sandboxAsk: v })}
            aria-label={bi("沙箱代码每次询问", "Ask before sandbox code")}
          />
        </label>
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
        trigger="click"
        position={pos}
        popupVisible={open}
        triggerProps={{ autoFitPosition: false }}
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
          className={`tm-btn ${open ? "on" : ""} ${compact && (pref.think || opts.web) ? "lit" : ""}`}
          aria-label={bi("工具与选项", "Tools & options")}
          aria-expanded={open}
        >
          <IconPlus />
        </button>
      </Popover>
      {!compact && (
        <>
          <ThinkLevel
            levels={levels}
            value={pref.think}
            onChange={(v) => update({ think: v })}
          />
          <button
            type="button"
            className={`tm-tog web ${opts.web ? "on" : ""}`}
            aria-pressed={opts.web}
            disabled={!o?.web}
            title={
              o?.web
                ? bi(
                    "平台和交付里查不到时，去网上找官方文档、版本说明、报错含义",
                    "Search official docs, release notes, and error meanings online when not found locally",
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
        </>
      )}
    </>
  );
}

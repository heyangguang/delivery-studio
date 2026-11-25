import React, { useEffect, useMemo, useRef, useState } from "react";
import { Popover, Tooltip } from "@arco-design/web-react";
import { IconCheck, IconDown } from "@arco-design/web-react/icon";
import { cached, fetchCached, useAIStatus } from "./shared";
import { bi, useLang } from "./i18n";
import { ProviderLogo } from "./ailogo";
import { useTrackPopoverPosition, type PopoverHandle } from "./aitools";
import "./aiwork.css";

/* The model a person talks to. An administrator decides which models people may pick; the choice is remembered in this
   browser, per feature. With nothing to pick, the model set for the feature is shown and used. */

export type Pickable = {
  ref: string;
  provider: string;
  preset: string;
  icon?: string;
  color?: string;
  model: string;
  name?: string;
  vision?: string;
  tools?: string;
  context?: number;
  effort?: string[];
};
type Models = {
  models: Pickable[];
  defaults: Record<string, string>;
  default_models?: Record<string, Pickable>;
};

const KEY = "mh-ai-model";

const read = (feature: string) => {
  try {
    return (
      (JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, string>)[
        feature
      ] || ""
    );
  } catch {
    return "";
  }
};
const write = (feature: string, ref: string) => {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || "{}");
    all[feature] = ref;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* the choice is only a convenience */
  }
};

export const modelLabel = (m?: { name?: string; model: string }) =>
  m ? m.name || m.model.replace(/^.*\//, "") : "";

function channelPrefix(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "";
}

/** Disambiguates models sharing the same display name (e.g. kril/gpt-6.1-sol vs auto/gpt-6.1-sol -> "GPT-6.1 Sol · kril"). */
function disambiguatedLabel(m: Pickable | undefined, pool: Pickable[]): string {
  if (!m) return "";
  const base = modelLabel(m);
  const sameBase = pool.filter((x) => modelLabel(x) === base);
  if (sameBase.length <= 1) return base;
  const ch = channelPrefix(m.model);
  if (
    ch &&
    sameBase.filter((x) => channelPrefix(x.model) === ch).length === 1
  ) {
    return `${base} · ${ch}`;
  }
  if (sameBase.filter((x) => x.provider === m.provider).length === 1) {
    return `${base} · ${m.provider}`;
  }
  return ch ? `${base} · ${ch}` : `${base} · ${m.model}`;
}

/** The models on offer and the one in use for a feature; `ref` is what to send ("" means the feature's own). */
export function useModelPick(feature: string) {
  const aiStatus = useAIStatus();
  const [d, setD] = useState<Models | undefined>(() =>
    cached<Models>("/api/ai/models"),
  );
  const [pick, setPick] = useState(() => read(feature));
  useEffect(() => {
    fetchCached<Models>("/api/ai/models")
      .then(setD)
      .catch(() => undefined);
  }, [aiStatus]);
  const userModels = d?.models || [];
  const defModel = d?.default_models?.[feature];
  const defaultRef = defModel?.ref || d?.defaults?.[feature] || "";
  const offered = useMemo(() => {
    const list = d?.models || [];
    const dm = d?.default_models?.[feature];
    if (dm && !list.some((m) => m.ref === dm.ref)) {
      return [dm, ...list];
    }
    return list;
  }, [d, feature]);
  const valid = userModels.some((m) => m.ref === pick);
  const ref = valid ? pick : "";
  const activeRef = ref || defaultRef;
  const current =
    offered.find((m) => m.ref === activeRef) || defModel || offered[0];
  return {
    models: offered,
    ref,
    current,
    defaultRef,
    choose: (r: string) => {
      setPick(r);
      write(feature, r);
    },
  };
}

type PopPlacement = "tl" | "tr" | "bl" | "br";

export function ModelPicker({
  pick,
  compact,
}: {
  pick: ReturnType<typeof useModelPick>;
  compact?: boolean;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopPlacement>("tl");
  const [maxH, setMaxH] = useState(380);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<PopoverHandle>(null);
  useTrackPopoverPosition(open, popRef, btnRef);
  const groups = useMemo(() => {
    const m = new Map<string, Pickable[]>();
    pick.models.forEach((x) =>
      m.set(x.provider, [...(m.get(x.provider) || []), x]),
    );
    return [...m.entries()];
  }, [pick.models]);
  const labelByRef = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of pick.models) {
      map.set(m.ref, disambiguatedLabel(m, pick.models));
    }
    if (pick.current && !map.has(pick.current.ref)) {
      map.set(pick.current.ref, disambiguatedLabel(pick.current, pick.models));
    }
    return map;
  }, [pick.models, pick.current]);
  const cur = pick.current;
  if (pick.models.length === 0 && !cur) return null;
  const selected = pick.ref || pick.defaultRef || cur?.ref || "";
  const curText = cur
    ? labelByRef.get(cur.ref) || disambiguatedLabel(cur, pick.models)
    : bi("选择模型", "Select model");
  const hasMenu = pick.models.length > 1;
  const label = (
    <button
      ref={btnRef}
      type="button"
      className={`mp ${compact ? "compact" : ""} ${hasMenu ? "" : "static"} ${open ? "on tm-open" : ""}`}
      aria-expanded={hasMenu ? open : undefined}
      aria-label={
        hasMenu
          ? bi(`模型：${curText}，点击切换`, `Model: ${curText}, click to switch`)
          : bi(`当前模型：${curText}`, `Current model: ${curText}`)
      }
    >
      {cur && (
        <ProviderLogo
          preset={cur.preset}
          icon={cur.icon}
          color={cur.color}
          name={cur.provider}
          size={16}
        />
      )}
      <span>{curText}</span>
      {hasMenu && <IconDown className={open ? "mp-flip" : ""} />}
    </button>
  );
  if (!hasMenu)
    return (
      <Tooltip content={cur ? `${cur.provider} · ${cur.model}` : undefined}>
        {label}
      </Tooltip>
    );
  return (
    <Popover
      ref={popRef as React.Ref<never>}
      trigger="click"
      position={pos}
      popupVisible={open}
      escToClose
      className="mp-pop"
      triggerProps={{ autoFitPosition: false, updateOnScroll: true }}
      onVisibleChange={(v) => {
        if (v && btnRef.current) {
          const rect = btnRef.current.getBoundingClientRect();
          const below = window.innerHeight - rect.bottom;
          const above = rect.top;
          const goDown = below >= 260 || below >= above;
          const rightSpace = window.innerWidth - rect.left;
          const alignRight = rightSpace < 340 && rect.right > rightSpace;
          setPos(
            `${goDown ? "b" : "t"}${alignRight ? "r" : "l"}` as PopPlacement,
          );
          setMaxH(
            Math.max(180, Math.min(420, (goDown ? below : above) - 20)),
          );
        }
        setOpen(v);
      }}
      content={
        <div
          className="mp-menu"
          role="listbox"
          aria-label={bi("选择模型", "Select model")}
          style={{ maxHeight: maxH }}
        >
          {groups.map(([provider, items]) => (
            <div className="mp-group" key={provider}>
              <div className="mp-group-title">{provider}</div>
              {items.map((m) => {
                const isOn = m.ref === selected;
                return (
                  <button
                    key={m.ref}
                    type="button"
                    role="option"
                    aria-selected={isOn}
                    className={`mp-item ${isOn ? "mp-item-on" : ""}`}
                    onClick={() => {
                      pick.choose(m.ref === pick.defaultRef ? "" : m.ref);
                      setOpen(false);
                    }}
                  >
                    <span className="mp-row">
                      <ProviderLogo
                        preset={m.preset}
                        icon={m.icon}
                        color={m.color}
                        name={m.provider}
                        size={18}
                      />
                      <span className="mp-t">
                        <b>{labelByRef.get(m.ref) || disambiguatedLabel(m, pick.models)}</b>
                        <small>
                          <span className="mono">{m.model}</span>
                          {m.ref === pick.defaultRef
                            ? bi(" · 默认", " · Default")
                            : ""}
                        </small>
                      </span>
                      <span className="mp-caps">
                        {m.vision === "yes" && (
                          <em>{bi("看图", "Vision")}</em>
                        )}
                        {m.tools === "no" && (
                          <em className="no">{bi("无工具", "No tools")}</em>
                        )}
                      </span>
                      {isOn && <IconCheck className="mp-on" />}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      }
    >
      {label}
    </Popover>
  );
}

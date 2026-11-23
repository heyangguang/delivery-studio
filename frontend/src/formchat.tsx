import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Message } from "@arco-design/web-react";
import "./aipage.css";
import "./airainbow.css";
import {
  IconCheckCircleFill,
  IconClose,
  IconExclamationCircleFill,
  IconFile,
  IconRecordStop,
  IconSend,
  IconUndo,
} from "@arco-design/web-react/icon";
import { api, can, useAIStatusLite, useConnectivity } from "./shared";
import { bi, useLang } from "./i18n";
import { draftKey, formChatKey } from "./formdraft";
import type { Deployment, InstanceSpec, Schema } from "./shared";
import { AIEmblem, Bubble, Spark, newLive, stepLabel, streamChat } from "./aichat";
import type {
  AICallDiag,
  ChatErrorState,
  ChatStreamError,
  Live,
  Msg,
  MsgFile,
} from "./aichat";
import { ModelPicker, useModelPick } from "./modelpick";
import { ThinkLevel, ToolMenu, useAIOptions, useSpaciousComposer } from "./aitools";
import "./formchat.css";

/* Filling the new-delivery form by talking: the person describes the cluster in their own words, the assistant asks
   when something is unclear and writes into the form while the person watches (the page walks to each field it
   touches), and whatever it changed is confirmed once, or undone as a whole. The form is a draft either way: nothing
   is generated until the person does it. */

export type FormFill = {
  target_component?: string;
  summary?: string;
  deployment: Deployment;
  blocking: number;
  changes?: Change[];
};
/** One change, in the form's own words. path names the field on the page (its data-ai attribute); section the step. */
export type Change = {
  path: string;
  section: string;
  label: string;
  detail: string;
};
/** How the page lets the assistant show what it did: open a step, bring a field into view, report where the person is. */
export type Stage = {
  open: (section: string) => void;
  reveal: (path: string) => void;
  current: () => string;
  pane: () => HTMLElement | null;
  /** The step whose form the person is looking at now; empty while they are in the conversation. */
  viewing: () => string;
};
/** What the assistant's last fill is doing to the form: the changes come in one after another, step by step. */
export type Run = {
  id: number;
  all: Change[];
  items: Change[];
  stage: string;
  active: boolean;
};

export const ORDER = ["basics", "hosts", "placement", "params", "access"];
/** The form draft kept while someone is filling it in; the conversation lives only as long as it does. */
export { draftKey } from "./formdraft";
const store = formChatKey;
/** A delivery was created from the form: its conversation belongs to it now, the next new one starts empty. */
export const forgetFormChat = (app: string, scope = "") => {
  try {
    sessionStorage.removeItem(store(app, scope));
  } catch {
    /* optional local storage */
  }
};
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const show = (v: unknown) =>
  Array.isArray(v)
    ? v.join(bi("、", ", "))
    : v === true
      ? bi("开启", "On")
      : v === false
        ? bi("关闭", "Off")
        : v === undefined || v === null || v === ""
          ? bi("默认", "Default")
          : String(v);

/** JSON with sorted keys, so two specifications that only differ in key order compare equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const hostKey = (h: Deployment["hosts"][number]) => ({
  name: h.name,
  ip: h.ip || "",
  params: h.params || {},
  partition: h.partition || "",
  disk: h.disk || "",
  initialize: !!h.initialize,
});

type SchemaOf = (component: string, version?: string) => Schema | undefined;
const isEntry = (sc?: Schema) =>
  !!sc && (sc.kind === "external" || !!sc.provides?.includes("l4-lb"));

/** What changed between two forms, step by step, in the words the form uses. */
export function diffForm(
  prev: Deployment,
  next: Deployment,
  schemaOf: SchemaOf,
  app: string,
): Change[] {
  const out: Change[] = [];
  const add = (path: string, section: string, label: string, detail: string) =>
    out.push({ path, section, label, detail });
  if ((prev.id || "") !== (next.id || ""))
    add("id", "basics", bi("集群标识", "Cluster ID"), next.id || bi("（空）", "(empty)"));
  if ((prev.title || "") !== (next.title || ""))
    add("title", "basics", bi("说明", "Description"), next.title || bi("（空）", "(empty)"));
  if ((prev.platform || "") !== (next.platform || ""))
    add("platform", "basics", bi("操作系统", "OS"), next.platform || "");
  const pm = prev.instances.find((i) => i.component === app);
  const nm = next.instances.find((i) => i.component === app);
  if (nm && pm && (pm.version || "") !== (nm.version || ""))
    add("version", "basics", bi("版本", "Version"), nm.version || "");
  next.hosts.forEach((h, i) => {
    const p = prev.hosts[i];
    if (!p || !same(hostKey(p), hostKey(h)))
      add(
        `hosts[${i}]`,
        "hosts",
        bi("机器", "Hosts"),
        `${h.name} ${h.ip || bi("（IP 待填）", "(IP pending)")}${
          h.initialize ? bi(` · 格式化 ${h.disk}`, ` · Format ${h.disk}`) : ""
        }`,
      );
  });
  // fewer machines than before; machines only renamed in place are changes, not removals
  if (prev.hosts.length > next.hosts.length) {
    const removedCount = prev.hosts.length - next.hosts.length;
    const removedNames = prev.hosts.slice(next.hosts.length).map((h) => h.name);
    add(
      "",
      "hosts",
      bi("机器", "Hosts"),
      bi(
        `少了 ${removedCount} 台：${removedNames.join("、")}`,
        `Removed ${removedCount}: ${removedNames.join(", ")}`,
      ),
    );
  }
  if ((prev.controller || "") !== (next.controller || ""))
    add(
      "controller",
      "hosts",
      bi("控制节点", "Control node"),
      next.controller || bi("自动选择", "Auto"),
    );
  const roleText = (inst: InstanceSpec, sc?: Schema) =>
    Object.entries(inst.placement || {})
      .filter(([, hs]) => hs.length)
      .map(
        ([r, hs]) =>
          `${sc?.roles.find((x) => x.name === r)?.title || r} ${hs.join(bi("、", ", "))}`,
      )
      .join(bi("；", "; "));
  for (const inst of next.instances) {
    const sc = schemaOf(inst.component, inst.version);
    const p = prev.instances.find((x) => x.id === inst.id);
    const title = sc?.title || inst.component;
    if (isEntry(sc)) {
      if (
        !p ||
        !same({ ...p, version: undefined }, { ...inst, version: undefined })
      ) {
        const where = [inst.params?.address, inst.params?.resolve_ip]
          .filter(Boolean)
          .join(" · ");
        const binds = (inst.binds || [])
          .map((b) => `${b.listen ?? ""} → ${b.endpoint}`)
          .join(bi("，", ", "));
        add(
          `instances[${inst.id}]`,
          "access",
          bi("入口", "Access"),
          [title, where, binds].filter(Boolean).join(bi("：", ": ")),
        );
      }
      continue;
    }
    if (!p)
      add(
        `instances[${inst.id}].placement`,
        "placement",
        bi(`加入 ${title}`, `Add ${title}`),
        roleText(inst, sc),
      );
    else if (!same(p.placement || {}, inst.placement || {}))
      add(
        `instances[${inst.id}].placement`,
        "placement",
        bi(`${title} 的放置`, `${title} placement`),
        roleText(inst, sc),
      );
    const keys = new Set([
      ...Object.keys(p?.params || {}),
      ...Object.keys(inst.params || {}),
    ]);
    for (const k of keys) {
      if (same(p?.params?.[k], inst.params?.[k])) continue;
      const d = sc?.params.find((x) => x.key === k);
      add(
        `instances[${inst.id}].params.${k}`,
        "params",
        d?.label || k,
        show(inst.params?.[k]) +
          (d?.unit && inst.params?.[k] !== undefined ? ` ${d.unit}` : ""),
      );
    }
    if (!same(p?.addons || [], inst.addons || []))
      add(
        "",
        "params",
        bi(`${title} 的扩展`, `${title} addons`),
        (inst.addons || []).map((a) => a.id).join(bi("、", ", ")) ||
          bi("无", "None"),
      );
  }
  for (const p of prev.instances) {
    if (next.instances.some((x) => x.id === p.id)) continue;
    const sc = schemaOf(p.component, p.version);
    add(
      "",
      isEntry(sc) ? "access" : "placement",
      bi("去掉", "Remove"),
      sc?.title || p.component,
    );
  }
  return out;
}

/** The form as it is part way through a fill: the steps in `done` have taken the assistant's values, the rest still
 *  hold what the person had. The last step always lands on exactly what the assistant wrote. */
function blend(
  prev: Deployment,
  next: Deployment,
  done: Set<string>,
  schemaOf: SchemaOf,
  app: string,
): Deployment {
  const out: Deployment = { ...prev };
  if (done.has("basics"))
    Object.assign(out, {
      id: next.id,
      title: next.title,
      platform: next.platform,
    });
  if (done.has("hosts"))
    Object.assign(out, { hosts: next.hosts, controller: next.controller });
  const entry = (i: InstanceSpec) => isEntry(schemaOf(i.component, i.version));
  const nextOf = new Map(next.instances.map((i) => [i.id, i]));
  const plain = done.has("placement")
    ? next.instances
        .filter((n) => !entry(n))
        .map((n) => {
          const p = prev.instances.find((x) => x.id === n.id);
          const inst: InstanceSpec = p
            ? { ...p }
            : { ...n, params: {}, addons: undefined, binds: undefined };
          inst.placement = n.placement;
          if (!p || (done.has("basics") && n.component === app))
            inst.version = n.version;
          if (done.has("params"))
            Object.assign(inst, {
              params: n.params,
              addons: n.addons,
              version: n.version,
            });
          return inst;
        })
    : prev.instances
        .filter((p) => !entry(p))
        .map((p) => {
          const n = nextOf.get(p.id);
          const inst: InstanceSpec =
            n && done.has("basics") && p.component === app
              ? { ...p, version: n.version }
              : { ...p };
          if (n && done.has("params"))
            Object.assign(inst, {
              params: n.params,
              addons: n.addons,
              version: n.version,
            });
          return inst;
        });
  const fronts = done.has("access")
    ? next.instances.filter(entry)
    : prev.instances.filter(entry);
  out.instances = [...plain, ...fronts];
  return out;
}

/** used: the conversation has messages on the server (one that was never started is not asked for). */
type Saved = { chat: string; snapshot: Deployment | null; used?: boolean };

/** Everything the form conversation needs, kept by the page. */
export function useFormAI(o: {
  app: { id: string; name: string; version: string };
  dep: Deployment;
  setDep: (d: Deployment) => void;
  platforms: string[];
  schemaOf: SchemaOf;
  stage: Stage;
  chat?: string;
  enabled: boolean;
  onSwitch?: (target: string, dep: Deployment, chat: string) => void;
  draftScope?: string;
  canPersist?: () => boolean;
  /** Files the assistant worked out (a certificate taken out of a p7b…) go into the form's slots. */
  putFiles?: (
    list: { part: string; name: string; data: string }[],
    target?: { instance: string; name: string },
  ) => void;
}) {
  const lang = useLang();
  const on = useAIStatusLite("form") && can("ai.use") && o.enabled;
  const [saved, setSaved] = useState<Saved>(() => {
    try {
      const s = JSON.parse(
        sessionStorage.getItem(store(o.app.id, o.draftScope)) || "null",
      ) as Saved | null;
      // a conversation whose form is gone (it was created, or cleared) belongs to nothing: a new form starts afresh
      if (
        s?.chat &&
        !o.chat &&
        !sessionStorage.getItem(draftKey(o.app.id, o.draftScope))
      )
        sessionStorage.removeItem(store(o.app.id, o.draftScope));
      else if (s?.chat)
        return o.chat && o.chat !== s.chat
          ? { chat: o.chat, snapshot: null, used: true }
          : s;
    } catch {
      /* a broken value starts afresh */
    }
    return o.chat
      ? { chat: o.chat, snapshot: null, used: true }
      : { chat: newId(), snapshot: null };
  });
  useEffect(() => {
    if (!o.enabled || !saved.used || o.canPersist?.() === false) return;
    try {
      sessionStorage.setItem(
        store(o.app.id, o.draftScope),
        JSON.stringify(saved),
      );
    } catch {
      /* The conversation can still be used without local storage. */
    }
  }, [saved, o.app.id, o.draftScope, o.enabled]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const msgsRef = useRef(msgs);
  msgsRef.current = msgs;
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<ChatErrorState | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const ctl = useRef<{
    id: number;
    finish: () => void;
    cancel: () => void;
  } | null>(null);
  const seq = useRef(0);
  const [nudged, setNudged] = useState(0);
  const model = useModelPick("form");
  const tools = useAIOptions();
  const toolsRef = useRef(tools.opts);
  toolsRef.current = tools.opts;
  const abort = useRef<AbortController | null>(null);
  const depRef = useRef(o.dep);
  depRef.current = o.dep;
  const snapRef = useRef(saved.snapshot);
  snapRef.current = saved.snapshot;
  const oRef = useRef(o);
  oRef.current = o;

  useEffect(() => {
    if (!on) return;
    if (!saved.used) {
      setLoaded(true);
      return;
    }
    let alive = true;
    setLoaded(false);
    api<{ messages: Msg[] }>(`/api/ai/chats/${saved.chat}`)
      .then((c) => alive && setMsgs(c.messages || []))
      .catch(() => alive && setMsgs([]))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [saved.chat, on]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      abort.current?.abort();
      ctl.current?.cancel();
    },
    [],
  );

  const changes = useMemo(
    () =>
      saved.snapshot
        ? diffForm(saved.snapshot, o.dep, o.schemaOf, o.app.id)
        : [],
    [saved.snapshot, o.dep, o.schemaOf, o.app.id, lang],
  );
  const marks = useMemo(
    () => new Set(changes.map((c) => c.path).filter(Boolean)),
    [changes],
  );
  const sections = useMemo(
    () => new Set(changes.map((c) => c.section)),
    [changes],
  );

  /** The assistant wrote into the form: keep what was there before the first change, then let the changes come in one
   *  after another, step by step. Nothing the person does stops it; it can be skipped (all at once) from the card. */
  const onFill = useCallback((f: FormFill): Change[] => {
    // a fill still coming in when the next arrives is finished first
    ctl.current?.finish();
    const prev = depRef.current;
    const next: Deployment = {
      ...f.deployment,
      // a version the assistant left out stays what the form had
      instances: f.deployment.instances.map((i) =>
        i.version
          ? i
          : {
              ...i,
              version:
                prev.instances.find((x) => x.id === i.id)?.version ||
                (i.component === oRef.current.app.id
                  ? oRef.current.app.version
                  : undefined),
            },
      ),
    };
    if (!snapRef.current) {
      snapRef.current = prev;
      setSaved((s) => ({ ...s, snapshot: prev }));
    }
    const all = diffForm(
      prev,
      next,
      oRef.current.schemaOf,
      oRef.current.app.id,
    );
    const land = () => {
      depRef.current = next;
      oRef.current.setDep(next);
    };
    if (
      !all.length ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      land();
      setRun(
        all.length
          ? { id: ++seq.current, all, items: all, stage: "", active: false }
          : null,
      );
      return all;
    }
    const id = ++seq.current;
    const stages = ORDER.filter((x) => all.some((c) => c.section === x));
    let skip = false;
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      skip = true;
      land();
      setRun((r) =>
        r && r.id === id ? { ...r, items: all, stage: "", active: false } : r,
      );
      if (ctl.current?.id === id) ctl.current = null;
    };
    ctl.current = {
      id,
      finish: end,
      cancel: () => {
        over = true;
        skip = true;
        ctl.current = null;
      },
    };
    setRun({ id, all, items: [], stage: stages[0] || "", active: true });
    (async () => {
      const st = oRef.current.stage;
      const done = new Set<string>();
      for (const sec of stages) {
        if (skip) return;
        done.add(sec);
        const mixed = blend(
          prev,
          next,
          done,
          oRef.current.schemaOf,
          oRef.current.app.id,
        );
        depRef.current = mixed;
        oRef.current.setDep(mixed);
        setRun((r) => (r && r.id === id ? { ...r, stage: sec } : r));
        await wait(300);
        const here = all.filter((c) => c.section === sec);
        for (const c of here) {
          if (skip) return;
          setRun((r) =>
            r && r.id === id ? { ...r, items: [...r.items, c] } : r,
          );
          // someone looking at the step this field is on sees it light up
          if (c.path && st.viewing() === sec) {
            st.reveal(c.path);
            await wait(40);
            const el = st
              .pane()
              ?.querySelector<HTMLElement>(`[data-ai="${CSS.escape(c.path)}"]`);
            if (el) {
              el.scrollIntoView({ block: "nearest", behavior: "smooth" });
              el.setAttribute("data-ai-flash", "");
              window.setTimeout(
                () => el.removeAttribute("data-ai-flash"),
                1400,
              );
            }
          }
          await wait(Math.max(170, 460 - all.length * 14));
        }
      }
      await wait(250);
      end();
    })();
    return all;
  }, []);

  const send = useCallback(
    async (
      raw: string,
      attached: MsgFile[] = [],
      note = "",
      isRetry = false,
    ) => {
      const text = raw.trim();
      if (!text || live || !on) return;
      ctl.current?.finish();
      setError(null);
      setSaved((s) => (s.used ? s : { ...s, used: true }));
      const trimmed = [...msgsRef.current];
      while (
        trimmed.length > 0 &&
        trimmed[trimmed.length - 1].role === "assistant" &&
        trimmed[trimmed.length - 1].error &&
        !trimmed[trimmed.length - 1].text?.trim()
      ) {
        trimmed.pop();
      }
      const again = Boolean(
        isRetry &&
          trimmed.length > 0 &&
          trimmed[trimmed.length - 1].role === "user" &&
          trimmed[trimmed.length - 1].text === text,
      );
      if (again) {
        setMsgs(trimmed);
      } else {
        setMsgs((m) => [
          ...m,
          {
            role: "user",
            text,
            files: attached.length ? attached : undefined,
            at: new Date().toISOString(),
          },
        ]);
      }
      const cur = newLive();
      setLive({ ...cur });
      const ac = new AbortController();
      abort.current = ac;
      let filled: FormFill | undefined;
      const done = (): Msg => ({
        role: "assistant",
        text: cur.text,
        steps: cur.steps.map((x) => ({ ...x, running: false })),
        ms: Date.now() - cur.t0,
        ask: cur.ask,
        at: new Date().toISOString(),
        form: filled,
      });
      const d = depRef.current;
      try {
        await streamChat(
          `/api/ai/chats/${saved.chat}/chat`,
          {
            message: text,
            attachments: attached.length
              ? attached.map((f) => f.id)
              : undefined,
            note: note || undefined,
            ctx: { kind: "form", id: oRef.current.app.id },
            form: {
              deployment: { ...d, change: undefined, pins: undefined },
              platforms: oRef.current.platforms,
              allow_switch: !!oRef.current.onSwitch,
            },
            model: model.ref,
            options: toolsRef.current,
            retry: again,
          },
          ac.signal,
          cur,
          () =>
            setLive({
              ...cur,
              tools: [...cur.tools],
              steps: cur.steps.map((x) => ({ ...x })),
              sandboxConfirms: cur.sandboxConfirms
                ? [...cur.sandboxConfirms]
                : undefined,
            }),
          undefined,
          (e) => {
            if (e.t === "formfiles" && Array.isArray(e.v))
              oRef.current.putFiles?.(
                e.v,
                e.target as { instance: string; name: string } | undefined,
              );
            if (e.t === "form" && e.v) {
              filled = e.v as FormFill;
              // what the fill changed is kept with the message, so the conversation can show it later
              if (!filled.target_component) filled.changes = onFill(filled);
            }
          },
        );
        setMsgs((m) => [...m, done()]);
        if (filled?.target_component) {
          try {
            sessionStorage.removeItem(
              store(oRef.current.app.id, oRef.current.draftScope),
            );
          } catch {}
          oRef.current.onSwitch?.(
            filled.target_component,
            filled.deployment,
            saved.chat,
          );
        }
      } catch (e) {
        const stopped = (e as Error).name === "AbortError";
        const streamErr = e as ChatStreamError;
        const diag =
          streamErr.diag ??
          (e as { body?: { diag?: AICallDiag } }).body?.diag;
        if (cur.text || cur.steps.length || filled) {
          setMsgs((m) => [
            ...m,
            {
              ...done(),
              text:
                cur.text + (stopped ? bi("\n\n（已停止）", "\n\n(Stopped)") : ""),
              ...(stopped
                ? {}
                : { error: streamErr.message, error_diag: diag }),
            },
          ]);
        } else if (!stopped && streamErr.saved) {
          setMsgs((m) => [
            ...m,
            {
              role: "assistant",
              text: "",
              error: streamErr.message,
              error_diag: diag,
              at: new Date().toISOString(),
            },
          ]);
        } else if (!stopped) {
          setError({
            text: streamErr.message,
            retry: text,
            diag,
            kind: streamErr.kind,
            rawError: streamErr.rawError,
          });
        }
      } finally {
        setLive(null);
        abort.current = null;
      }
    },
    [live, on, saved.chat, model.ref, onFill],
  );

  const confirm = useCallback(() => {
    setSaved((s) => ({ ...s, snapshot: null }));
    Message.success(
      bi("已确认，表单保留这些内容", "Confirmed; changes kept in form"),
    );
  }, []);
  const undo = useCallback(() => {
    const snap = snapRef.current;
    if (!snap) return;
    ctl.current?.finish();
    oRef.current.setDep({
      ...snap,
    });
    setSaved((s) => ({ ...s, snapshot: null }));
    Message.info(
      bi(
        "已撤销，表单回到 AI 改动之前",
        "Undone; form restored to before AI edits",
      ),
    );
  }, []);
  const fresh = useCallback(() => {
    abort.current?.abort();
    setMsgs([]);
    setError(null);
    setSaved((s) => ({ ...s, chat: newId(), used: false }));
  }, []);
  /** Starting the whole form over forgets the conversation too. */
  const reset = useCallback(() => {
    abort.current?.abort();
    ctl.current?.cancel();
    setRun(null);
    setLive(null);
    setMsgs([]);
    setError(null);
    setSaved({ chat: newId(), snapshot: null, used: false });
  }, []);

  return {
    on,
    app: o.app,
    msgs,
    loaded,
    live,
    error,
    setError,
    started: msgs.length > 0 || !!live,
    busy: !!live,
    run,
    playing: !!run?.active,
    skipRun: () => ctl.current?.finish(),
    changes,
    marks,
    sections,
    pending: changes.length,
    model,
    tools,
    send,
    stopAnswer: () => abort.current?.abort(),
    confirm,
    undo,
    fresh,
    reset,
    nudged,
    /** Draws attention to the confirmation: the page refuses to generate while AI changes wait for it. */
    nudge: () => setNudged((n) => n + 1),
  };
}
export type FormAI = ReturnType<typeof useFormAI>;

/** Keeps the AI marks on the fields of the page in step with what is still unconfirmed. */
export function useAIMarks(
  pane: React.RefObject<HTMLElement | null>,
  marks: Set<string>,
  watchKey?: string,
) {
  useLayoutEffect(() => {
    pane.current?.querySelectorAll<HTMLElement>("[data-ai]").forEach((el) => {
      if (marks.has(el.dataset.ai || "")) el.setAttribute("data-ai-on", "");
      else el.removeAttribute("data-ai-on");
    });
  }, [pane, marks, watchKey]);
}

const getExamples = (): Record<string, string[]> => ({
  postgresql: [
    bi(
      "三台机器 172.30.2.44、172.30.2.50、172.30.2.61，一主两从，网段就是这些机器的网段",
      "3 hosts 172.30.2.44, 172.30.2.50, 172.30.2.61, 1 primary 2 replicas, same subnet as hosts",
    ),
    bi(
      "再加一个云 ELB 入口，域名 pg.example.com，解析到 172.30.2.120，端口 5434",
      "Add a cloud ELB access point: domain pg.example.com resolving to 172.30.2.120 on port 5434",
    ),
    bi(
      "这三台都是新盘 /dev/vdb，需要格式化",
      "All 3 hosts have fresh /dev/vdb disks that need formatting",
    ),
  ],
  redis: [
    bi(
      "三台机器 10.0.1.11-13，一主两从加哨兵，最大内存 6GB",
      "3 hosts 10.0.1.11-13, 1 primary 2 replicas with Sentinel, maxmemory 6GB",
    ),
    bi(
      "单节点，开发测试用，内存 2GB",
      "Single node for dev/test, 2GB memory",
    ),
  ],
  etcd: [
    bi(
      "三台机器 10.0.1.11、10.0.1.12、10.0.1.13 组成 etcd 集群，数据盘 /dev/vdb",
      "3-node etcd cluster on 10.0.1.11, 10.0.1.12, 10.0.1.13 with data disk /dev/vdb",
    ),
  ],
});

/** A placeholder that types out real examples one after another, so the box shows what to say without a row of chips.
 *  Still when the person asked for less motion. */
function useTypedHint(lines: string[], idle: string, run: boolean) {
  const [text, setText] = useState(idle);
  useEffect(() => {
    if (
      !run ||
      !lines.length ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setText(idle);
      return;
    }
    let li = 0;
    let ci = 0;
    let dir = 1;
    let t = 0;
    const prefix = bi("试试：", "Try: ");
    const tick = () => {
      const line = lines[li];
      ci += dir;
      setText(prefix + line.slice(0, ci));
      let next = dir > 0 ? 45 : 14;
      if (dir > 0 && ci >= line.length) {
        dir = -1;
        next = 2200;
      } else if (dir < 0 && ci <= 0) {
        dir = 1;
        li = (li + 1) % lines.length;
        next = 500;
      }
      t = window.setTimeout(tick, next);
    };
    t = window.setTimeout(tick, 900);
    return () => window.clearTimeout(t);
  }, [run, lines, idle]);
  return text;
}

/** The box you talk to the assistant in: the AI page's message box, with its rainbow edge. On the first screen it
 *  is the way of choosing the assistant; in the workspace it is the line under the conversation. */
/** Files the person gives the assistant to deal with (a certificate, a key, a p7b, a screenshot…): any file; the
 *  assistant looks at it and puts what belongs in the form's slots. */
export type Attach = {
  accept: string;
  /** Files waiting to be sent, and those the assistant has put in the form, for the chips. */
  list: { id: string; name: string; slot: string }[];
  /** The ids of files to send with the next message; they stop waiting once taken. */
  take?: () => MsgFile[];
  /** How many are waiting to be sent, and whether some are still uploading. */
  waiting?: number;
  busy?: boolean;
  add: (files: File[]) => Promise<void>;
  remove: (id: string) => void;
  /** What to tell the assistant about them with the next message (never the keys themselves). */
  note: () => string;
};

export function Composer({
  fa,
  variant,
  onSend,
  attach,
  focus: focusNow,
}: {
  fa: FormAI;
  variant: "start" | "work";
  attach?: Attach;
  /** Called before a message goes out (the page moves from the first screen to the form); the message waits for it, so
   *  the conversation appears in the form and not on the first screen while the page is being photographed. */
  onSend?: () => Promise<unknown> | void;
  /** Put the cursor in the box when it appears. */
  focus?: boolean;
}) {
  const lang = useLang();
  const net = useConnectivity();
  const online = net === "online";
  const [input, setInput] = useState("");
  const [focus, setFocus] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const isStart = variant === "start";
  const spacious = useSpaciousComposer(
    formRef,
    Boolean(input.trim() || attach?.list.length),
  );
  const examples = useMemo(
    () => getExamples()[fa.app.id] || [],
    [fa.app.id, lang],
  );
  const work = variant === "work";
  const open = !!variant && (isStart || work || focus || !!input);
  const hint = useTypedHint(
    examples,
    fa.started
      ? bi("接着说，或者回答上面的问题…", "Continue, or answer the question above…")
      : bi("说说你要的集群，AI 帮你填这张表", "Describe the cluster you need—AI will fill the form"),
    !fa.started && !open,
  );
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // folded and empty: let the stylesheet size it (measuring now would catch the height mid-animation)
    if (!input) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [input, open]);
  // "/" anywhere on the page puts you in the box, like a search field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        e.key !== "/" ||
        e.metaKey ||
        e.ctrlKey ||
        /INPUT|TEXTAREA|SELECT/.test(t.tagName) ||
        t.isContentEditable
      )
        return;
      e.preventDefault();
      box.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (variant === "start" || focusNow || work)
      box.current?.focus({ preventScroll: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [told, setTold] = useState("");
  const [dragging, setDragging] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const go = (t?: string) => {
    const text = (t ?? input).trim();
    if ((!text && !attach?.waiting) || fa.busy || !online || attach?.busy)
      return;
    // what was added since the last message goes along with this one, in words
    const note = attach?.note() || "";
    const fresh = note && note !== told ? note : "";
    setInput("");
    if (fresh) setTold(note);
    const files = attach?.take?.() || [];
    Promise.resolve(onSend?.()).then(() =>
      fa.send(
        text ||
          bi("我上传了文件，请帮我处理。", "I uploaded files—please process them."),
        files,
        fresh,
      ),
    );
  };
  return (
    <form
      ref={formRef}
      className={`ap-compose fc-compose ${isStart ? "start-box" : ""} ${isStart && spacious.expanded ? "is-writing" : ""} ${open ? "open" : ""} ${work ? "work" : ""} ${!online ? "off" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
      onFocus={() => setFocus(true)}
      onBlur={(e) =>
        !e.currentTarget.contains(e.relatedTarget as Node) && setFocus(false)
      }
      onDragOver={(e) => {
        if (attach && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) =>
        !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)
      }
      onDrop={(e) => {
        if (!attach || !e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        attach.add(Array.from(e.dataTransfer.files));
      }}
      onPaste={(e) => {
        if (attach && e.clipboardData.files.length) {
          e.preventDefault();
          attach.add(Array.from(e.clipboardData.files));
        }
      }}
    >
      {attach && attach.list.length > 0 && (
        <div className="fc-files">
          {attach.list.map((f) => (
            <span key={f.id} className="fc-file">
              <IconFile />
              <b>{f.slot}</b>
              <span title={f.name}>{f.name}</span>
              <button
                type="button"
                aria-label={bi(`移除 ${f.name}`, `Remove ${f.name}`)}
                onClick={() => attach.remove(f.id)}
              >
                <IconClose />
              </button>
            </span>
          ))}
        </div>
      )}
      {dragging && (
        <div className="fc-drop">
          {bi("松开即可添加文件", "Drop to attach files")}
        </div>
      )}
      <div className="fc-row">
        <span className="fc-orb" aria-hidden>
          <Spark size={16} rainbow />
        </span>
        <textarea
          ref={box}
          value={input}
          rows={1}
          onPointerDown={isStart ? spacious.onFieldPointerDown : undefined}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              go();
            } else if (e.key === "Escape") box.current?.blur();
          }}
          placeholder={
            !online
              ? bi(
                  "暂未连上 Middleware Hub 后端服务",
                  "Middleware Hub backend unavailable",
                )
              : hint
          }
          aria-label={bi("对 AI 说你要的集群", "Describe your cluster to AI")}
          disabled={!online}
        />
        {!open && !fa.busy && <kbd className="fc-kbd">/</kbd>}
      </div>
      {attach && (
        <input
          ref={pick}
          type="file"
          multiple
          hidden
          accept={attach.accept}
          onChange={(e) => {
            if (e.target.files) attach.add(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      )}
      <div className="fc-fold">
        <div>
          <div className="fc-tools">
            <ToolMenu
              t={fa.tools}
              levels={fa.model.current?.effort}
              compact={!isStart}
              hideThink
              thinkInMenu={false}
              attach={
                attach
                  ? {
                      upload: () => pick.current?.click(),
                      uploadTitle: bi(
                        "上传证书、配置或截图",
                        "Upload certs, configs, or screenshots",
                      ),
                      uploadDesc: bi(
                        "支持证书、私钥、p7b、报错截图与配置（可拖拽或粘贴）；私钥内容不会发给 AI",
                        "Certs, keys, p7b, error screenshots & configs (drag/paste); private keys stay local",
                      ),
                    }
                  : undefined
              }
            />
            <span className="fc-hint">
              {bi(
                "不要写密码，平台会生成",
                "Don't include passwords—the platform generates them",
              )}
            </span>
            <div className="fc-tools-right">
              <ThinkLevel
                levels={fa.model.current?.effort}
                value={fa.tools.pref.think}
                onChange={(v) => fa.tools.update({ think: v })}
              />
              <ModelPicker pick={fa.model} compact={!isStart} />
              {fa.busy ? (
                <button
                  type="button"
                  className={isStart ? "ap-send stop" : "ad-send stop"}
                  onClick={fa.stopAnswer}
                  aria-label={bi("停止", "Stop")}
                >
                  <IconRecordStop />
                </button>
              ) : (
                <button
                  type="submit"
                  className={isStart ? "ap-send" : "ad-send"}
                  disabled={
                    (!input.trim() && !attach?.waiting) ||
                    !online ||
                    attach?.busy
                  }
                  aria-label={bi("发送", "Send")}
                  title={bi(
                    "发送（Enter 发送 · Shift+Enter 换行）",
                    "Send (Enter to send · Shift+Enter for new line)",
                  )}
                >
                  <IconSend />
                </button>
              )}
            </div>
          </div>
          {!fa.started && examples.length > 0 && (
            <div className="fc-chips">
              {examples.map((x) => (
                <button
                  key={x}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(x)}
                  disabled={!online}
                >
                  {x}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </form>
  );
}

/** The first screen of a new cluster: the box is the way to choose the assistant, `onForm` the way to fill it in yourself. */
export function FormChat({
  fa,
  start,
  onSend,
  attach,
}: {
  fa: FormAI;
  start: { title: string; steps: string[]; onForm: () => void };
  onSend?: () => Promise<unknown> | void;
  attach?: Attach;
}) {
  useLang();
  if (!fa.on) return null;
  return (
    <section className="fc start" aria-label={bi("AI 填表", "AI form fill")}>
      <header className="fc-start-head">
        <span className="fc-start-orb" aria-hidden>
          <AIEmblem size={44} />
        </span>
        <h2>{start.title}</h2>
        <p>
          {bi(
            "说说你要的集群，AI 帮你把表填好；也可以自己按步骤填写。",
            "Describe the cluster you want and AI will fill out the form, or fill it out step by step yourself.",
          )}
        </p>
      </header>
      <Composer fa={fa} variant="start" onSend={onSend} attach={attach} />
      <button type="button" className="fc-start-form" onClick={start.onForm}>
        <span className="fc-start-or">{bi("或者", "Or")}</span>
        <b>{bi("自己按步骤填写", "Fill step by step manually")}</b>
        <span className="fc-start-steps">{start.steps.join(" → ")}</span>
        <span className="fc-start-go" aria-hidden>
          →
        </span>
      </button>
    </section>
  );
}

/** One slim bar to confirm what the assistant changed; the list opens from it. Nothing is generated before this is answered. */
export function ConfirmCard({
  fa,
  titles,
  blocking,
  issues,
}: {
  fa: FormAI;
  titles: Record<string, string>;
  blocking: number;
  issues: string[];
}) {
  useLang();
  const [list, setList] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fa.nudged) return;
    const c = card.current;
    if (!c) return;
    c.scrollIntoView({ block: "nearest", behavior: "smooth" });
    c.classList.remove("fc-nudge");
    void c.offsetWidth;
    c.classList.add("fc-nudge");
  }, [fa.nudged]);
  if (!(fa.pending > 0 && !fa.busy && !fa.playing)) return null;
  return (
    <div
      className={`fc-card ${list ? "open" : ""}`}
      ref={card}
      role="group"
      aria-label={bi("确认 AI 的改动", "Confirm AI changes")}
    >
      <div className="fc-card-row">
        <Spark size={15} rainbow />
        <b>
          {bi(
            `AI 改了 ${fa.pending} 处`,
            `AI edited ${fa.pending} field${fa.pending === 1 ? "" : "s"}`,
          )}
        </b>
        <button
          type="button"
          className="fc-card-more"
          onClick={() => setList(!list)}
          aria-expanded={list}
        >
          {list ? bi("收起", "Collapse") : bi("看改了什么", "View changes")}
        </button>
        <span
          className={`fc-check ${blocking ? "bad" : "ok"}`}
          title={issues.join(bi("；", "; "))}
        >
          {blocking ? <IconExclamationCircleFill /> : <IconCheckCircleFill />}
          {blocking
            ? bi(`还差 ${blocking} 项`, `${blocking} remaining`)
            : bi("校验通过", "Valid")}
        </span>
        <span className="fc-card-btns">
          <Button size="small" icon={<IconUndo />} onClick={fa.undo}>
            {bi("撤销", "Undo")}
          </Button>
          <Button size="small" type="primary" onClick={fa.confirm}>
            {bi("确认", "Confirm")}
          </Button>
        </span>
      </div>
      <div className="fc-fold">
        <div>
          <dl className="fc-card-list">
            {ORDER.filter((x) => fa.changes.some((c) => c.section === x)).map(
              (x) => (
                <React.Fragment key={x}>
                  <dt>{titles[x] || x}</dt>
                  <dd>
                    {fa.changes
                      .filter((c) => c.section === x)
                      .map((c, i) => (
                        <span key={i}>
                          {c.label !== titles[x] && <em>{c.label}</em>}{" "}
                          {c.detail}
                        </span>
                      ))}
                  </dd>
                </React.Fragment>
              ),
            )}
          </dl>
          {blocking > 0 && (
            <p className="fc-todo">
              {bi("生成前还要：", "Required before generating: ")}
              {issues.slice(0, 4).join(bi("；", "; "))}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The light around the form while the assistant works on it: at the edges only, nothing is covered. */
export function FormGlow({ on }: { on: boolean }) {
  return <div className={`fc-glow ${on ? "on" : ""}`} aria-hidden />;
}

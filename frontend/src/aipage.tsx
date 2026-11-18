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
  Dropdown,
  Input,
  Menu,
  Message,
  Modal,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowDown,
  IconBook,
  IconBug,
  IconCheckCircle,
  IconClose,
  IconDelete,
  IconEdit,
  IconFolder,
  IconImage,
  IconLaunch,
  IconMenuFold,
  IconMore,
  IconPlus,
  IconRecordStop,
  IconSearch,
  IconSend,
  IconSettings,
  IconStorage,
  IconUpload,
} from "@arco-design/web-react/icon";
import { go } from "./router";
import { ago, api, can, err, useConnectivity, useMedia } from "./shared";
import { reportDoc, useSubmitKB } from "./kb";
import type { Job, Session } from "./shared";
import { FileIcon, FilePicker, uploadFiles } from "./myfiles";
import type { FileNode } from "./myfiles";
import {
  AIEmblem,
  Bubble,
  LiveBubble,
  Spark,
  newLive,
  readFile,
  streamChat,
  useAIStatus,
} from "./aichat";
import { isGeneral } from "./aichat";
import type { AIReport, Live, Msg, StepProposal } from "./aichat";
import { Markdown } from "./aimd";
import { AIPrefs } from "./aiprefs";
import { ModelPicker, useModelPick } from "./modelpick";
import { ToolMenu, useAIOptions } from "./aitools";
import "./aichat.css";
import "./aipage.css";

/* The assistant's own page: every conversation a person has, in one place. Their own conversations (optionally tied
   to a delivery or a component) and the ones held inside their deliveries — a review, or troubleshooting a runbook
   step — open and continue here, proposals included. */

type Ctx = { kind: "" | "job" | "comp" | "form"; id: string; name: string };
/** What a conversation is tied to, in a word: a delivery, a component, or a new delivery being filled in. */
const ctxWord = (k: string) =>
  k === "job" ? "交付" : k === "form" ? "新建交付" : "组件";
type ChatRow = {
  id: string;
  title: string;
  ctx: Ctx;
  updated: string;
  archived?: boolean;
};
type Linked = {
  job: string;
  cluster: string;
  key: string;
  title: string;
  kind: string;
  updated: string;
  /** The delivery inside its cluster: 集群部署, 扩容方案 #3. */
  plan?: string;
};

const normPlanLabel = (s?: string) =>
  s === "首次部署" ? "集群部署" : s ? s.replace(/首次部署/g, "集群部署") : s;
type Chat = ChatRow & { messages: Msg[] };
type JobSession = {
  key: string;
  title: string;
  kind: string;
  step?: Record<string, unknown>;
  messages: Msg[];
  running?: boolean;
  running_since?: string;
};

const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

const dayKey = (s: string) => {
  const d = new Date(s);
  const t = new Date();
  const diff = Math.round(
    (new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86400000,
  );
  return diff <= 0
    ? "今天"
    : diff === 1
      ? "昨天"
      : diff < 7
        ? "最近 7 天"
        : "更早";
};
const greeting = () => {
  const h = new Date().getHours();
  return h < 6
    ? "夜深了"
    : h < 11
      ? "早上好"
      : h < 13
        ? "中午好"
        : h < 18
          ? "下午好"
          : "晚上好";
};

const SUGGEST = [
  {
    icon: <IconCheckCircle />,
    t: "查看我最近的交付进度与验收情况",
    d: "读取所有交付的执行状态",
  },
  {
    icon: <IconBug />,
    t: "帮我看看最近一次部署失败的原因",
    d: "结合执行记录与手册",
  },
  {
    icon: <IconStorage />,
    t: "Patroni 高可用的 PostgreSQL 上线前要检查什么？",
    d: "参考组件与运维技能",
  },
  {
    icon: <IconBook />,
    t: "etcd 报 database space exceeded 怎么处理？",
    d: "按步骤给出排查与修复",
  },
];

const plain = (t: string) =>
  t
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** A thin outline of the conversation at the left edge: one mark per question; hover to preview, click to jump. */
function Outline({
  messages,
  list,
}: {
  messages: Msg[];
  list: React.RefObject<HTMLDivElement | null>;
}) {
  const turns = useMemo(() => {
    const out: { prompt: string; reply: string }[] = [];
    messages.forEach((m, i) => {
      if (m.role === "user")
        out.push({
          prompt: plain(m.text) || "（只发了附件）",
          reply: plain(
            messages[i + 1]?.role === "assistant" ? messages[i + 1].text : "",
          ),
        });
    });
    return out;
  }, [messages]);
  const [active, setActive] = useState(() => Math.max(0, turns.length - 1));
  const [hover, setHover] = useState<number | null>(null);
  const pinned = useRef<{
    index: number;
    targetTop: number;
    until: number;
  } | null>(null);
  const prevLen = useRef(turns.length);

  useEffect(() => {
    if (prevLen.current !== turns.length) {
      prevLen.current = turns.length;
      pinned.current = null;
    }
    const el = list.current;
    if (!el || turns.length < 2) return;
    let raf = 0;

    const compute = () => {
      const nodes = el.querySelectorAll<HTMLElement>(".ad-msg.user");
      if (!nodes.length) return;

      // Hold explicit click selection while smooth-scrolling or clamped at maxScroll.
      if (pinned.current) {
        const targetIdx = Math.min(pinned.current.index, nodes.length - 1);
        if (performance.now() < pinned.current.until) {
          setActive(targetIdx);
          return;
        }
        if (Math.abs(el.scrollTop - pinned.current.targetTop) <= 6) {
          setActive(targetIdx);
          return;
        }
        pinned.current = null;
      }

      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const remaining = Math.max(0, maxScroll - el.scrollTop);
      if (maxScroll <= 2 || remaining <= 6) {
        setActive(nodes.length - 1);
        return;
      }

      // Slide the reading-line anchor toward the bottom near maxScroll so turns
      // in the lower portion of the final screen still highlight in order.
      const rect = el.getBoundingClientRect();
      const baseOffset = Math.min(96, rect.height * 0.18);
      const bottomOffset = Math.max(baseOffset, rect.height - 16);
      const tailSpan = Math.min(maxScroll, Math.max(180, rect.height * 0.65));
      const tailProgress =
        tailSpan > 0 ? Math.max(0, Math.min(1, 1 - remaining / tailSpan)) : 1;
      const anchorY =
        rect.top + baseOffset + tailProgress * (bottomOffset - baseOffset);

      let a = 0;
      nodes.forEach((u, i) => {
        if (u.getBoundingClientRect().top <= anchorY) a = i;
      });
      setActive(a);
    };

    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        compute();
      });
    };

    const clearPin = () => {
      if (!pinned.current) return;
      pinned.current = null;
      schedule();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "PageUp" ||
        e.key === "PageDown" ||
        e.key === "Home" ||
        e.key === "End" ||
        e.key === " "
      ) {
        clearPin();
      }
    };

    compute();
    el.addEventListener("scroll", schedule, { passive: true });
    el.addEventListener("wheel", clearPin, { passive: true });
    el.addEventListener("touchmove", clearPin, { passive: true });
    window.addEventListener("keydown", onKeyDown);

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(schedule)
        : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      el.removeEventListener("wheel", clearPin);
      el.removeEventListener("touchmove", clearPin);
      window.removeEventListener("keydown", onKeyDown);
      ro?.disconnect();
    };
  }, [turns.length, list]);

  if (turns.length < 2) return null;

  const jumpToTurn = (i: number) => {
    const el = list.current;
    const u = el?.querySelectorAll<HTMLElement>(".ad-msg.user")[i];
    if (!el || !u) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    const targetTop = Math.max(
      0,
      Math.min(
        maxScroll,
        el.scrollTop +
          (u.getBoundingClientRect().top - el.getBoundingClientRect().top) -
          18,
      ),
    );
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    pinned.current = {
      index: i,
      targetTop,
      until: performance.now() + (reduced ? 80 : 900),
    };
    setActive(i);
    el.scrollTo({
      top: targetTop,
      behavior: reduced ? "auto" : "smooth",
    });
  };

  const first = Math.max(0, turns.length - 40);
  return (
    <nav
      className="ap-outline"
      aria-label="对话目录"
      onMouseLeave={() => setHover(null)}
    >
      {turns.slice(first).map((t, k) => {
        const i = first + k;
        return (
          <div key={i} className="ap-ol-i">
            <button
              type="button"
              className={i === active ? "on" : ""}
              aria-label={`第 ${i + 1} 个问题：${t.prompt.slice(0, 30)}`}
              aria-current={i === active ? "true" : undefined}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => jumpToTurn(i)}
            >
              <i />
            </button>
            {hover === i && (
              <div className="ap-ol-card" role="tooltip">
                <b>{t.prompt.slice(0, 60)}</b>
                {t.reply && <p>{t.reply.slice(0, 140)}</p>}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function AIPage({
  me,
  chatId,
  job,
  sessionKey,
  comp,
  jobs,
}: {
  me: Session;
  chatId?: string;
  job?: string;
  sessionKey?: string;
  comp?: string;
  jobs: Job[];
}) {
  const status = useAIStatus();
  const net = useConnectivity();
  const linkedMode = !!(job && sessionKey);
  const feature = linkedMode
    ? isGeneral(sessionKey)
      ? "review"
      : "troubleshoot"
    : "assistant";
  const on = !!status.features[feature];
  const model = useModelPick(feature);
  const tools = useAIOptions();
  const narrowBar = useMedia("(max-width: 700px)");
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [linked, setLinked] = useState<Linked[]>([]);
  const [q, setQ] = useState("");
  const [chat, setChat] = useState<Chat | null>(null);
  const [js, setJs] = useState<JobSession | null>(null);
  const [props, setProps] = useState<Record<string, StepProposal>>({});
  const [deciding, setDeciding] = useState("");
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [imgs, setImgs] = useState<string[]>([]);
  const [atts, setAtts] = useState<FileNode[]>([]);
  const [uploading, setUploading] = useState(0);
  const [picker, setPicker] = useState(false);
  const [drop, setDrop] = useState(false);
  const [showArch, setShowArch] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  const [ctx, setCtx] = useState<Ctx>({ kind: "", id: "", name: "" });
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<{ text: string; retry?: string } | null>(
    null,
  );
  const [atBottom, setAtBottom] = useState(true);
  const [side, setSide] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [openSubmit, submitNode] = useSubmitKB();
  const sideRows = useRef<HTMLDivElement>(null);
  const initialRevealed = useRef(false);
  const orderSeeded = useRef(false);
  const topRank = useRef(0);
  const chatSlots = useRef<Map<string, { rank: number; group: string }>>(
    new Map(),
  );
  const clusterRanks = useRef<Map<string, number>>(new Map());
  const planRanks = useRef<Map<string, number>>(new Map());
  const linkedRanks = useRef<Map<string, number>>(new Map());
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);
  const seeded = useRef(false);
  const promotedId = useRef("");
  const [draftId, setDraftId] = useState(newId);
  const [remote, setRemote] = useState(false);
  const prefsMode = chatId === "~prefs";
  const id = chatId && !prefsMode ? chatId : draftId;
  const activeThreadId = linkedMode
    ? `linked:${job}:${sessionKey}`
    : prefsMode
      ? "prefs"
      : id;
  const threadRef = useRef(activeThreadId);
  threadRef.current = activeThreadId;
  const busy = !!live;
  const jobBase = job ? `/api/jobs/${job}/ai` : "";
  const jobRow = jobs.find((j) => j.id === job);

  const loadList = useCallback(() => {
    api<{ chats: ChatRow[]; linked: Linked[] }>("/api/ai/chats")
      .then((r) => {
        const chats = r.chats || [];
        const lnk = r.linked || [];
        if (!orderSeeded.current) {
          chats.forEach((c, idx) =>
            chatSlots.current.set(c.id, {
              rank: idx,
              group: dayKey(c.updated),
            }),
          );
          lnk.forEach((l, idx) => {
            if (!clusterRanks.current.has(l.cluster))
              clusterRanks.current.set(l.cluster, clusterRanks.current.size);
            if (!planRanks.current.has(l.job))
              planRanks.current.set(l.job, planRanks.current.size);
            linkedRanks.current.set(`${l.job}\0${l.key}`, idx);
          });
          orderSeeded.current = true;
        } else {
          for (let i = chats.length - 1; i >= 0; i--) {
            const c = chats[i];
            if (!chatSlots.current.has(c.id))
              chatSlots.current.set(c.id, {
                rank: --topRank.current,
                group: dayKey(c.updated),
              });
          }
          for (let i = lnk.length - 1; i >= 0; i--) {
            const l = lnk[i];
            const lk = `${l.job}\0${l.key}`;
            if (!clusterRanks.current.has(l.cluster))
              clusterRanks.current.set(l.cluster, --topRank.current);
            if (!planRanks.current.has(l.job))
              planRanks.current.set(l.job, --topRank.current);
            if (!linkedRanks.current.has(lk))
              linkedRanks.current.set(lk, --topRank.current);
          }
        }
        setRows(chats);
        setLinked(lnk);
      })
      .catch(() => setRows((prev) => prev ?? []));
  }, []);
  useEffect(loadList, [loadList]);

  const loadProps = useCallback(() => {
    if (!jobBase) return Promise.resolve();
    return api<{ proposals: StepProposal[] }>(`${jobBase}/proposals`)
      .then((r) =>
        setProps(Object.fromEntries((r.proposals || []).map((p) => [p.id, p]))),
      )
      .catch(() => undefined);
  }, [jobBase]);

  // open what the address names: a delivery's conversation, a saved one, or a blank one (possibly tied to something)
  useEffect(() => {
    if (!linkedMode && chatId && !prefsMode && promotedId.current === chatId) {
      promotedId.current = "";
      return;
    }
    promotedId.current = "";
    abort.current?.abort();
    abort.current = null;
    setLive(null);
    setRemote(false);
    setError(null);
    setInput("");
    setImgs([]);
    setAtts([]);
    setProps({});
    setDeciding("");
    setAtBottom(true);
    setSide(false);
    seeded.current = false;
    let alive = true;
    if (linkedMode) {
      setLoading(true);
      setChat(null);
      setJs(null);
      Promise.all([
        api<JobSession>(
          `${jobBase}/session?key=${encodeURIComponent(sessionKey!)}`,
        ),
        loadProps(),
      ])
        .then(([s]) => {
          if (!alive) return;
          setJs(s);
          if (s.running) {
            setLive({
              ...newLive(),
              t0: s.running_since
                ? Date.parse(s.running_since) || Date.now()
                : Date.now(),
              notice: "这段对话还在回答，写完会自动显示在这里",
            });
            setRemote(true);
          }
        })
        .catch((e) => {
          if (alive) setError({ text: (e as Error).message });
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
      return () => {
        alive = false;
      };
    }
    setJs(null);
    if (chatId && !prefsMode) {
      setLoading(true);
      setChat(null);
      api<Chat>(`/api/ai/chats/${chatId}`)
        .then((c) => {
          if (!alive) return;
          setChat(c);
          setCtx(c.ctx?.kind ? c.ctx : { kind: "", id: "", name: "" });
        })
        .catch((e) => {
          if (!alive) return;
          setChat(null);
          setError({ text: (e as Error).message });
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
      return () => {
        alive = false;
      };
    }
    setLoading(false);
    setChat(null);
    if (!prefsMode) setDraftId(newId());
    const j = job ? jobs.find((x) => x.id === job) : undefined;
    setCtx(
      j
        ? { kind: "job", id: j.id, name: j.cluster_id }
        : comp
          ? { kind: "comp", id: comp, name: comp }
          : { kind: "", id: "", name: "" },
    );
    return () => {
      alive = false;
    };
  }, [chatId, job, sessionKey, comp]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!linkedMode && !chatId && !prefsMode && job) {
      const j = jobs.find((x) => x.id === job);
      if (j)
        setCtx((c) =>
          c.kind === "job" && c.id === j.id && c.name === j.cluster_id
            ? c
            : { kind: "job", id: j.id, name: j.cluster_id },
        );
    }
  }, [linkedMode, chatId, prefsMode, job, jobs]);
  useEffect(() => {
    if (!remote || !linkedMode || !jobBase || !sessionKey) return;
    let alive = true;
    const t = window.setInterval(() => {
      api<JobSession>(
        `${jobBase}/session?key=${encodeURIComponent(sessionKey)}`,
      )
        .then((s) => {
          if (!alive || s.running) return;
          setJs(s);
          setLive(null);
          setRemote(false);
          loadProps();
          loadList();
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [remote, linkedMode, jobBase, sessionKey, loadProps, loadList]);
  useEffect(() => () => abort.current?.abort(), []);
  const savedSideScroll = useRef<number | null>(null);
  const keepSideScroll = (fn: () => void) => {
    if (sideRows.current) savedSideScroll.current = sideRows.current.scrollTop;
    fn();
  };
  useLayoutEffect(() => {
    if (savedSideScroll.current !== null && sideRows.current) {
      sideRows.current.scrollTop = savedSideScroll.current;
      savedSideScroll.current = null;
    }
  });
  // Reveal a deep-linked conversation only once on initial page entry; never move the sidebar scroll on user clicks.
  useLayoutEffect(() => {
    if (initialRevealed.current || rows === null) return;
    initialRevealed.current = true;
    const el = sideRows.current;
    if (!el || el.scrollTop > 0 || (!chatId && !linkedMode)) return;
    el.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({
      block: "nearest",
    });
  }, [rows, linked, chatId, linkedMode]);
  useEffect(() => {
    if (!loading && !window.matchMedia("(max-width: 900px)").matches)
      box.current?.focus({ preventScroll: true });
  }, [chatId, job, sessionKey, loading]);

  const messages = linkedMode ? js?.messages || [] : chat?.messages || [];
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [activeThreadId, messages.length, live, atBottom]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [input]);

  const attach = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    if (atts.length + list.length > 8)
      return Message.warning("一条消息最多附带 8 个文件");
    if (
      list.some((f) => f.type.startsWith("image/")) &&
      model.current?.vision === "no"
    )
      Message.warning(
        "当前模型看不了图片：图片会存进「我的资料」，但 AI 读不到画面内容",
      );
    setUploading((n) => n + list.length);
    try {
      const r = await uploadFiles(list, "", "chat");
      setAtts((x) => [...x, ...r.added]);
      r.failed.forEach((m) => Message.warning(m));
    } catch (e) {
      err(e);
    } finally {
      setUploading((n) => n - list.length);
    }
  };
  const addFiles = async (files: FileList | File[]) => {
    if (!linkedMode) return attach(files);
    const pics = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!pics.length || !linkedMode) return;
    if (model.current?.vision === "no")
      return Message.warning(
        "当前模型看不了图片，请把报错文字贴进来，或换一个能看图的模型",
      );
    if (imgs.length + pics.length > 3)
      return Message.warning("一次最多 3 张图片");
    try {
      const data = await Promise.all(pics.map(readFile));
      setImgs((x) => [...x, ...data]);
    } catch (e) {
      err(e);
    }
  };

  const flip = useRef<{ box: DOMRect; text: DOMRect } | null>(null);
  const stopRun = () => {
    abort.current?.abort();
    if (linkedMode && jobBase)
      api(`${jobBase}/stop`, {
        method: "POST",
        body: JSON.stringify({ key: sessionKey }),
      }).catch(() => undefined);
    if (remote && linkedMode && jobBase && sessionKey) {
      setRemote(false);
      setLive(null);
      api<JobSession>(
        `${jobBase}/session?key=${encodeURIComponent(sessionKey)}`,
      )
        .then((s) => setJs(s))
        .catch(() => undefined);
    }
  };
  const startNewChat = () => {
    if (!linkedMode && !chatId && !prefsMode) {
      abort.current?.abort();
      abort.current = null;
      setDraftId(newId());
      setChat(null);
      setLive(null);
      setError(null);
      setInput("");
      setImgs([]);
      setAtts([]);
      setCtx({ kind: "", id: "", name: "" });
      setSide(false);
      box.current?.focus({ preventScroll: true });
      return;
    }
    go({ name: "ai" });
  };
  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if ((!text && !imgs.length && !atts.length) || busy || !on || uploading > 0)
      return;
    const myThread = threadRef.current;
    const here = () => threadRef.current === myThread;
    setError(null);
    if (!linkedMode && messages.length === 0 && !live) {
      // remember where the start-page box and its text are, so the first message can travel from there into the thread
      const f = document.querySelector<HTMLElement>(".ap-hero .ap-compose");
      const t = f?.querySelector("textarea");
      if (f && t)
        flip.current = {
          box: f.getBoundingClientRect(),
          text: t.getBoundingClientRect(),
        };
    }
    const sent = imgs;
    const sentFiles = atts;
    const userMsg: Msg = {
      role: "user",
      text,
      images: sent,
      files: sentFiles.map((f) => ({
        id: f.id,
        name: f.name,
        mime: f.mime,
        size: f.size,
      })),
      at: new Date().toISOString(),
      by: me.username,
    };
    if (linkedMode)
      setJs((s) => (s ? { ...s, messages: [...s.messages, userMsg] } : s));
    else
      setChat((c) => ({
        ...(c || {
          id,
          title: text.slice(0, 40),
          ctx,
          updated: new Date().toISOString(),
          messages: [],
        }),
        messages: [...(c?.messages || []), userMsg],
      }));
    setInput("");
    setImgs([]);
    setAtts([]);
    setAtBottom(true);
    const cur = newLive();
    setLive({ ...cur });
    const ac = new AbortController();
    abort.current = ac;
    const finished = (): Msg => ({
      role: "assistant",
      text: cur.text,
      tools: cur.tools,
      steps: cur.steps.map((x) => ({ ...x, running: false })),
      ms: Date.now() - cur.t0,
      proposals: cur.made,
      ask: cur.ask,
      files: cur.files,
      at: new Date().toISOString(),
    });
    const push = (m: Msg) =>
      linkedMode
        ? setJs((s) => (s ? { ...s, messages: [...s.messages, m] } : s))
        : setChat((c) => (c ? { ...c, messages: [...c.messages, m] } : c));
    try {
      const url = linkedMode ? `${jobBase}/chat` : `/api/ai/chats/${id}/chat`;
      const body = linkedMode
        ? {
            key: sessionKey,
            message: text,
            images: sent,
            step: js?.step,
            model: model.ref,
            options: tools.opts,
          }
        : {
            message: text,
            attachments: sentFiles.map((f) => f.id),
            ctx: ctx.kind ? { kind: ctx.kind, id: ctx.id } : undefined,
            model: model.ref,
            options: tools.opts,
          };
      await streamChat(
        url,
        body,
        ac.signal,
        cur,
        () =>
          here() &&
          setLive({
            ...cur,
            tools: [...cur.tools],
            steps: cur.steps.map((x) => ({ ...x })),
            made: [...cur.made],
            sandboxConfirms: cur.sandboxConfirms
              ? [...cur.sandboxConfirms]
              : undefined,
          }),
        () => (here() ? loadProps() : Promise.resolve()),
      );
      if (!here()) {
        loadList();
        return;
      }
      push(finished());
      if (!linkedMode && !chatId) {
        promotedId.current = id;
        go({ name: "ai", id }, { replace: true, instant: true });
      }
      loadList();
    } catch (e) {
      if (!here()) {
        loadList();
        return;
      }
      const stopped = (e as Error).name === "AbortError";
      if (cur.text || cur.steps.length) {
        push({
          ...finished(),
          text: cur.text + (stopped ? "\n\n（已停止）" : ""),
        });
        if (!linkedMode && !chatId) {
          promotedId.current = id;
          go({ name: "ai", id }, { replace: true, instant: true });
        }
        loadList();
      }
      if (!stopped)
        setError({
          text: (e as Error).message,
          retry: cur.text ? undefined : text,
        });
    } finally {
      if (here()) {
        setLive(null);
        abort.current = null;
      }
    }
  };

  // a question another page prepared (for example "work out a plan for this CVE"): sent as soon as the page is ready
  useEffect(() => {
    if (
      seeded.current ||
      linkedMode ||
      chatId ||
      prefsMode ||
      !on ||
      busy ||
      loading
    )
      return;
    let seed = "";
    try {
      const raw = sessionStorage.getItem("mw-ai-seed");
      if (raw) {
        const v = JSON.parse(raw) as { text?: string; at?: number };
        if (v.text && Date.now() - (v.at || 0) < 120000) seed = v.text;
        sessionStorage.removeItem("mw-ai-seed");
      }
    } catch {
      /* no seed */
    }
    if (!seed) return;
    seeded.current = true;
    window.setTimeout(() => send(seed), 150);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (pid: string, verb: "accept" | "reject") => {
    setDeciding(pid);
    try {
      await api(`${jobBase}/proposals/${pid}/${verb}`, { method: "POST" });
      if (verb === "accept") Message.success("已写入执行手册和交付文档");
      await loadProps();
    } catch (e) {
      err(e);
    } finally {
      setDeciding("");
    }
  };
  const resolve = async () => {
    setResolving(true);
    try {
      const rep = await api<AIReport>(`${jobBase}/resolve`, {
        method: "POST",
        body: JSON.stringify({ key: sessionKey, to_kb: true }),
      });
      const where = `交付 ${jobRow?.cluster_id || job} · ${title}`;
      (can("kb.submit") ? Modal.confirm : Modal.success)({
        title: "已写入这份交付的执行记录",
        content: (
          <Markdown
            text={`**现象**　${rep.symptom}\n\n**原因**　${rep.cause}\n\n**处理**\n\n${rep.fix}`}
          />
        ),
        okText: can("kb.submit") ? "发布到团队（需审核）" : "好",
        cancelText: "只留在我的知识库",
        onOk: () => {
          if (can("kb.submit")) openSubmit(reportDoc(rep, where));
        },
      });
    } catch (e) {
      err(e);
    } finally {
      setResolving(false);
    }
  };

  const remove = (c: ChatRow) =>
    Modal.confirm({
      title: `删除「${c.title}」？`,
      content: "对话内容会删除，不能恢复。",
      okText: "删除",
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          await api(`/api/ai/chats/${c.id}`, { method: "DELETE" });
          if (c.id === chatId) go({ name: "ai" });
          loadList();
        } catch (e) {
          err(e);
        }
      },
    });
  const rename = (c: ChatRow) => {
    let title = c.title;
    Modal.confirm({
      title: "重命名对话",
      content: (
        <Input
          defaultValue={c.title}
          maxLength={60}
          onChange={(v) => (title = v)}
          aria-label="对话标题"
          autoFocus
        />
      ),
      okText: "保存",
      onOk: async () => {
        try {
          await api(`/api/ai/chats/${c.id}`, {
            method: "PATCH",
            body: JSON.stringify({ title }),
          });
          loadList();
          if (c.id === chatId) setChat((x) => (x ? { ...x, title } : x));
        } catch (e) {
          err(e);
        }
      },
    });
  };

  const archive = async (c: ChatRow, on: boolean) => {
    try {
      await api(`/api/ai/chats/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: on }),
      });
      Message.success(
        on ? "已归档，可以在列表底部的「已归档」里找到" : "已取消归档",
      );
      if (on && c.id === chatId) go({ name: "ai" });
      loadList();
    } catch (e) {
      err(e);
    }
  };
  const needle = q.trim().toLowerCase();
  const match = (c: ChatRow) =>
    !needle ||
    (c.title + " " + (c.ctx?.name || "")).toLowerCase().includes(needle);
  const rankOfChat = (c: ChatRow) => chatSlots.current.get(c.id)?.rank ?? 0;
  const groupOfChat = (c: ChatRow) =>
    chatSlots.current.get(c.id)?.group || dayKey(c.updated);
  const mine = useMemo(
    () =>
      (rows || [])
        .filter((c) => !c.archived && match(c))
        .sort((a, b) => rankOfChat(a) - rankOfChat(b)),
    [rows, needle],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const archived = useMemo(
    () =>
      (rows || [])
        .filter((c) => c.archived && match(c))
        .sort((a, b) => rankOfChat(a) - rankOfChat(b)),
    [rows, needle],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => {
    const m = new Map<string, ChatRow[]>();
    mine.forEach((c) => {
      const g = groupOfChat(c);
      m.set(g, [...(m.get(g) || []), c]);
    });
    return ["今天", "昨天", "最近 7 天", "更早"]
      .filter((k) => m.has(k))
      .map((k) => [k, m.get(k)!] as const);
  }, [mine]); // eslint-disable-line react-hooks/exhaustive-deps
  const byDelivery = useMemo(() => {
    const m = new Map<string, Linked[]>();
    linked
      .filter(
        (l) =>
          !needle ||
          (
            l.title +
            " " +
            l.cluster +
            " " +
            (normPlanLabel(l.plan) || "") +
            " " +
            (l.plan || "")
          )
            .toLowerCase()
            .includes(needle),
      )
      .forEach((l) => m.set(l.cluster, [...(m.get(l.cluster) || []), l]));
    // Keep clusters, plans and step conversations in their session-established positions so clicking or replying never jumps the list.
    return [...m.entries()]
      .sort(
        ([ca], [cb]) =>
          (clusterRanks.current.get(ca) ?? 0) -
          (clusterRanks.current.get(cb) ?? 0),
      )
      .map(
        ([k, items]) =>
          [
            k,
            [...items].sort(
              (a, b) =>
                (planRanks.current.get(a.job) ?? 0) -
                  (planRanks.current.get(b.job) ?? 0) ||
                (linkedRanks.current.get(`${a.job}\0${a.key}`) ?? 0) -
                  (linkedRanks.current.get(`${b.job}\0${b.key}`) ?? 0),
            ),
          ] as [string, Linked[]],
      );
  }, [linked, needle]);

  const started = messages.length > 0 || !!live;
  const offline = net !== "online";
  useLayoutEffect(() => {
    const f = flip.current;
    if (!f || !started) return;
    flip.current = null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ease = "cubic-bezier(.2,.8,.2,1)";
    const foot = document.querySelector<HTMLElement>(".ap-foot .ap-compose");
    const bubble = document.querySelector<HTMLElement>(
      ".ap-col .ad-msg.user:last-of-type .ad-u, .ap-col .ad-msg.user .ad-u",
    );
    const box = foot?.getBoundingClientRect();
    // the message box slides from the middle of the page down to its place under the thread
    foot?.animate(
      [
        {
          transform: `translate(${f.box.left - box!.left}px, ${f.box.top - box!.top}px)`,
        },
        { transform: "none" },
      ],
      { duration: 560, easing: ease },
    );
    // the text that was typed rises out of the box into its bubble
    if (bubble) {
      const b = bubble.getBoundingClientRect();
      bubble.animate(
        [
          {
            transform: `translate(${f.text.left + 20 - b.left}px, ${f.text.top - b.top}px) scale(.96)`,
            opacity: 0.35,
          },
          { transform: "none", opacity: 1 },
        ],
        { duration: 560, easing: ease },
      );
    }
    // the thread behind them fades up
    document
      .querySelector<HTMLElement>(".ap-col")
      ?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 420,
        easing: "ease-out",
      });
  }, [started]); // eslint-disable-line react-hooks/exhaustive-deps
  // one entry per cluster: the delivery that describes it now (the newest one carried out, else the newest generated)
  const doneJobs = (() => {
    const ok = jobs
      .filter((j) => j.state === "succeeded" && j.outcome !== "void")
      .sort((a, b) => b.created.localeCompare(a.created));
    const seen = new Set<string>();
    const out: typeof ok = [];
    for (const j of ok) {
      if (seen.has(j.cluster_id)) continue;
      const settled = ok.find(
        (x) =>
          x.cluster_id === j.cluster_id &&
          (x.outcome === "done" || x.outcome === "deviated"),
      );
      out.push(settled || j);
      seen.add(j.cluster_id);
    }
    return out;
  })();
  const title = linkedMode
    ? js?.title || (isGeneral(sessionKey) ? "对话" : "现场排障")
    : chat?.title || "新对话";
  const answered = messages.some((m) => m.role === "assistant");
  const ctxChip = linkedMode
    ? { kind: "job", id: job!, name: jobRow?.cluster_id || job!.slice(0, 8) }
    : ctx;

  // a conversation held while filling in a new delivery goes on next to that form: only there can it write into it
  const formBack = ctx.kind === "form" && (
    <div className="ap-formback">
      <span>
        这段对话是在新建 {ctx.name} 时边聊边填表的，要接着填请回到表单页面。
      </span>
      <Button
        type="primary"
        onClick={() => go({ name: "new", app: ctx.id, chat: chatId })}
      >
        回到表单继续
      </Button>
    </div>
  );
  const composer = formBack || (
    <form
      className={`ap-compose ${!on || offline ? "off" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      onPaste={(e) => {
        if (e.clipboardData.files.length) {
          e.preventDefault();
          addFiles(e.clipboardData.files);
        }
      }}
    >
      {imgs.length > 0 && (
        <div className="ap-thumbs">
          {imgs.map((im, i) => (
            <span key={i}>
              <img src={im} alt={`待发送的截图 ${i + 1}`} />
              <button
                type="button"
                aria-label="移除这张图片"
                onClick={() => setImgs(imgs.filter((_, k) => k !== i))}
              >
                <IconClose />
              </button>
            </span>
          ))}
        </div>
      )}
      {(atts.length > 0 || uploading > 0) && (
        <div className="ap-atts">
          {atts.map((a) => (
            <span key={a.id} className="ap-att" title={a.name}>
              <FileIcon n={a} size={32} />
              <em>{a.name}</em>
              <button
                type="button"
                aria-label={`移除 ${a.name}`}
                onClick={() => setAtts(atts.filter((x) => x.id !== a.id))}
              >
                <IconClose />
              </button>
            </span>
          ))}
          {uploading > 0 && (
            <span className="ap-att wait">正在上传 {uploading} 个文件…</span>
          )}
        </div>
      )}
      <textarea
        ref={box}
        value={input}
        rows={1}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={
          !on
            ? can("ai.settings")
              ? "AI 未开启，可在「设置 → AI」中开启"
              : "AI 未开启，请联系管理员启用"
            : offline
              ? "网络已断开"
              : linkedMode
                ? "继续这段对话，可以贴报错或截图…"
                : ctx.kind
                  ? `问问关于 ${ctx.name} 的事…`
                  : "有什么想问的？"
        }
        disabled={!on || offline}
        aria-label="消息"
      />
      <div className="ap-bar">
        <ToolMenu
          t={tools}
          levels={model.current?.effort}
          compact={narrowBar}
          attach={
            linkedMode
              ? undefined
              : {
                  upload: () => fileIn.current?.click(),
                  pick: () => setPicker(true),
                }
          }
        />
        {!linkedMode && !started && (
          <Dropdown
            trigger="click"
            position="tl"
            triggerProps={{ autoFitPosition: true }}
            droplist={
              <Menu
                onClickMenuItem={(k) =>
                  k === "none"
                    ? setCtx({ kind: "", id: "", name: "" })
                    : setCtx({
                        kind: "job",
                        id: k,
                        name: doneJobs.find((j) => j.id === k)?.cluster_id || k,
                      })
                }
              >
                <Menu.Item key="none">不关联</Menu.Item>
                <Menu.ItemGroup title="关联一份交付">
                  {doneJobs.map((j) => (
                    <Menu.Item key={j.id}>
                      {j.cluster_id}{" "}
                      <span className="faint small">· {j.app_name}</span>
                    </Menu.Item>
                  ))}
                </Menu.ItemGroup>
              </Menu>
            }
          >
            <button
              type="button"
              className={`ap-chipbtn ${ctx.kind ? "on" : ""}`}
              aria-label="关联交付"
            >
              <IconPlus />{" "}
              {ctx.kind ? `${ctxWord(ctx.kind)} ${ctx.name}` : "关联交付"}
            </button>
          </Dropdown>
        )}
        {linkedMode && (
          <Tooltip content="添加截图（也可以粘贴）" mini>
            <label className="ap-icon" aria-label="添加截图">
              <IconImage />
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => e.target.files && addFiles(e.target.files)}
              />
            </label>
          </Tooltip>
        )}
        <div className="ap-bar-right">
          <ModelPicker pick={model} />
          {busy ? (
            <button
              type="button"
              className="ap-send stop"
              onClick={stopRun}
              aria-label="停止生成"
              title="停止生成"
            >
              <IconRecordStop />
            </button>
          ) : (
            <button
              type="submit"
              className="ap-send"
              disabled={
                (!input.trim() && !imgs.length && !atts.length) ||
                !on ||
                offline ||
                uploading > 0
              }
              aria-label="发送"
              title="发送（Enter 发送 · Shift+Enter 换行）"
            >
              <IconSend />
            </button>
          )}
        </div>
      </div>
    </form>
  );

  return (
    <div className={`ap ${side ? "side-open" : ""}`}>
      <aside className="ap-side" aria-label="对话">
        <div className="ap-side-top">
          <div className="ap-brand">
            <span className="ap-brand-mark">
              <AIEmblem size={28} />
            </span>
            <b>AI 助手</b>
            <Tooltip content="新对话" mini>
              <button
                type="button"
                className="ap-new"
                onClick={() => keepSideScroll(startNewChat)}
                aria-label="新对话"
              >
                <IconEdit />
              </button>
            </Tooltip>
          </div>
          <Input
            allowClear
            prefix={<IconSearch />}
            placeholder="搜索对话"
            value={q}
            onChange={setQ}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQ("");
                (e.target as HTMLElement).blur();
              }
            }}
            aria-label="搜索对话"
          />
        </div>
        <div className="ap-rows" ref={sideRows}>
          {rows === null && <div className="ap-skel" aria-label="载入中" />}
          {rows &&
            mine.length === 0 &&
            archived.length === 0 &&
            byDelivery.length === 0 && (
              <p className="ap-none">
                {needle ? "没有匹配的对话" : "还没有对话，从右边开始吧。"}
              </p>
            )}
          {groups.map(([g, items]) => (
            <section key={g}>
              <h3>{g}</h3>
              {items.map((c) => (
                <div
                  key={c.id}
                  className={`ap-row ${c.id === chatId ? "on" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() =>
                      c.id === chatId
                        ? setSide(false)
                        : keepSideScroll(() => go({ name: "ai", id: c.id }))
                    }
                    aria-current={c.id === chatId ? "page" : undefined}
                  >
                    <b>{normPlanLabel(c.title) || "新对话"}</b>
                    {c.ctx?.name && (
                      <small>
                        {ctxWord(c.ctx.kind)} · {normPlanLabel(c.ctx.name)}
                      </small>
                    )}
                  </button>
                  <Dropdown
                    trigger="click"
                    position="br"
                    triggerProps={{ autoFitPosition: true }}
                    droplist={
                      <Menu
                        onClickMenuItem={(k) =>
                          k === "rename"
                            ? rename(c)
                            : k === "arch"
                              ? archive(c, true)
                              : remove(c)
                        }
                      >
                        <Menu.Item key="rename">
                          <IconEdit /> 重命名
                        </Menu.Item>
                        <Menu.Item key="arch">
                          <IconStorage /> 归档
                        </Menu.Item>
                        <Menu.Item key="del" className="danger-item">
                          <IconDelete /> 删除
                        </Menu.Item>
                      </Menu>
                    }
                  >
                    <button
                      type="button"
                      className="ap-more"
                      aria-label={`${c.title} 的更多操作`}
                    >
                      <IconMore />
                    </button>
                  </Dropdown>
                </div>
              ))}
            </section>
          ))}
          {archived.length > 0 && (
            <section>
              <h3>
                <button
                  type="button"
                  className="ap-fold"
                  aria-expanded={showArch || !!needle}
                  onClick={() => setShowArch(!showArch)}
                >
                  已归档 · {archived.length}
                </button>
              </h3>
              {(showArch || !!needle) &&
                archived.map((c) => (
                  <div
                    key={c.id}
                    className={`ap-row ${c.id === chatId ? "on" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        c.id === chatId
                          ? setSide(false)
                          : keepSideScroll(() => go({ name: "ai", id: c.id }))
                      }
                      aria-current={c.id === chatId ? "page" : undefined}
                    >
                      <b>{normPlanLabel(c.title) || "新对话"}</b>
                      <small>{ago(c.updated)}</small>
                    </button>
                    <Dropdown
                      trigger="click"
                      position="br"
                      triggerProps={{ autoFitPosition: true }}
                      droplist={
                        <Menu
                          onClickMenuItem={(k) =>
                            k === "un" ? archive(c, false) : remove(c)
                          }
                        >
                          <Menu.Item key="un">
                            <IconStorage /> 取消归档
                          </Menu.Item>
                          <Menu.Item key="del" className="danger-item">
                            <IconDelete /> 删除
                          </Menu.Item>
                        </Menu>
                      }
                    >
                      <button
                        type="button"
                        className="ap-more"
                        aria-label={`${c.title} 的更多操作`}
                      >
                        <IconMore />
                      </button>
                    </Dropdown>
                  </div>
                ))}
            </section>
          )}
          {byDelivery.length > 0 && (
            <section>
              <h3>交付里的对话</h3>
              {byDelivery.map(([jid, items]) => (
                <div key={jid} className="ap-dgroup">
                  <div className="ap-dhead">
                    <span className="ap-ddot" aria-hidden />
                    {items[0].cluster}
                  </div>
                  {items.map((l, i) => {
                    const planHead =
                      l.plan && (i === 0 || items[i - 1].job !== l.job);
                    const cur =
                      linkedMode && job === l.job && sessionKey === l.key;
                    return (
                      <React.Fragment key={l.job + l.key}>
                        {planHead && (
                          <div className="ap-dplan">
                            {normPlanLabel(l.plan)}
                          </div>
                        )}
                        <div className={`ap-row sub ${cur ? "on" : ""}`}>
                          <button
                            type="button"
                            onClick={() =>
                              cur
                                ? setSide(false)
                                : keepSideScroll(() =>
                                    go({ name: "ai", job: l.job, key: l.key }),
                                  )
                            }
                            aria-current={cur ? "page" : undefined}
                          >
                            <b>
                              <span className={`ap-kind k-${l.kind}`}>
                                {l.kind === "review" ? "评审" : "排障"}
                              </span>
                              {normPlanLabel(l.title)}
                            </b>
                            <small>{ago(l.updated)}</small>
                          </button>
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
              ))}
            </section>
          )}
        </div>
        <div className="ap-side-foot">
          <button
            type="button"
            className={prefsMode ? "on" : ""}
            onClick={() => keepSideScroll(() => go({ name: "ai", id: "~prefs" }))}
          >
            <IconSettings /> 个性化
          </button>
        </div>
      </aside>

      <main
        className="ap-main"
        onDragOver={(e) => {
          if (
            !linkedMode &&
            !prefsMode &&
            e.dataTransfer.types.includes("Files")
          ) {
            e.preventDefault();
            setDrop(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setDrop(false);
        }}
        onDrop={(e) => {
          if (linkedMode || prefsMode || !e.dataTransfer.files.length) return;
          e.preventDefault();
          setDrop(false);
          attach(e.dataTransfer.files);
        }}
      >
        {drop && <div className="ap-dropzone">松开，把文件添加到这条消息</div>}
        {prefsMode ? (
          <AIPrefs onBack={() => go({ name: "ai" })} />
        ) : (
          <>
            <header className="ap-head">
              <button
                type="button"
                className="ap-menu"
                onClick={() => setSide(!side)}
                aria-label="对话列表"
              >
                <IconMenuFold />
              </button>
              <div className="ap-title">
                <b>{started || linkedMode ? title : "新对话"}</b>
                {ctxChip.kind && (started || linkedMode) && (
                  <button
                    type="button"
                    className="ap-ctx"
                    onClick={() =>
                      ctxChip.kind === "job"
                        ? go({ name: "deliveries", id: ctxChip.id })
                        : ctxChip.kind === "form"
                          ? go({ name: "new", app: ctxChip.id, chat: chatId })
                          : go({ name: "components", id: ctxChip.id })
                    }
                  >
                    {ctxWord(ctxChip.kind)} {ctxChip.name} <IconLaunch />
                  </button>
                )}
                {linkedMode && (
                  <span className="ap-badge">
                    {isGeneral(sessionKey) ? "对话" : "现场排障"}
                  </span>
                )}
              </div>
              {!linkedMode && chat && chatId && (
                <Dropdown
                  trigger="click"
                  position="br"
                  triggerProps={{ autoFitPosition: true }}
                  droplist={
                    <Menu
                      onClickMenuItem={(k) =>
                        k === "rename"
                          ? rename(chat)
                          : k === "arch"
                            ? archive(chat, !chat.archived)
                            : remove(chat)
                      }
                    >
                      <Menu.Item key="rename">
                        <IconEdit /> 重命名
                      </Menu.Item>
                      <Menu.Item key="arch">
                        <IconStorage /> {chat.archived ? "取消归档" : "归档"}
                      </Menu.Item>
                      <Menu.Item key="del" className="danger-item">
                        <IconDelete /> 删除
                      </Menu.Item>
                    </Menu>
                  }
                >
                  <button
                    type="button"
                    className="ap-more on"
                    aria-label="更多操作"
                  >
                    <IconMore />
                  </button>
                </Dropdown>
              )}
            </header>

            {js?.step && (
              <div className="ap-step">
                <span>正在处理</span>
                <b>{String(js.step.title || "")}</b>
                {js.step.phase ? <em>{String(js.step.phase)}</em> : null}
                {Array.isArray(js.step.hosts) && (
                  <code>{(js.step.hosts as string[]).join(" → ")}</code>
                )}
              </div>
            )}

            {!started && !loading && !linkedMode ? (
              <div className="ap-hero">
                <div className="ap-hero-in">
                  <span className="ap-orb" aria-hidden>
                    <AIEmblem size={52} />
                  </span>
                  <h1>
                    {greeting()}，{me.username}
                  </h1>
                  <p>
                    {ctx.kind
                      ? `关于 ${ctx.name}，想了解什么？`
                      : "我可以读你的交付、执行手册和项目文件，也会用平台里的运维技能来回答。"}
                  </p>
                  {composer}
                  {error && (
                    <div className="ad-error" role="alert">
                      {error.text}
                    </div>
                  )}
                  <div className="ap-suggest">
                    {SUGGEST.map((s) => (
                      <button
                        key={s.t}
                        type="button"
                        onClick={() => send(s.t)}
                        disabled={!on || offline}
                      >
                        <span className="ap-sg-ic">{s.icon}</span>
                        <span>
                          <b>{s.t}</b>
                          <small>{s.d}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  {doneJobs.length > 0 && !ctx.kind && (
                    <div className="ap-recent">
                      <span>就某份交付提问</span>
                      {doneJobs.slice(0, 4).map((j) => (
                        <button
                          key={j.id}
                          type="button"
                          onClick={() =>
                            setCtx({
                              kind: "job",
                              id: j.id,
                              name: j.cluster_id,
                            })
                          }
                        >
                          {j.cluster_id}
                        </button>
                      ))}
                    </div>
                  )}
                  {!on && (
                    <p className="ap-off">
                      {can("ai.settings")
                        ? "AI 助手尚未开启，可在「设置 → AI」中开启并配置模型。"
                        : "AI 助手尚未开启，请联系管理员启用。"}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <>
                <Outline key={activeThreadId} messages={messages} list={list} />
                <div
                  className="ap-list"
                  ref={list}
                  onScroll={() => {
                    const el = list.current;
                    if (el)
                      setAtBottom(
                        el.scrollHeight - el.scrollTop - el.clientHeight < 40,
                      );
                  }}
                  aria-live="polite"
                  aria-busy={busy}
                >
                  <div className="ap-col">
                    {loading && (
                      <div className="ad-loading" aria-label="载入中">
                        <i />
                        <i />
                        <i />
                      </div>
                    )}
                    {!loading && linkedMode && messages.length === 0 && (
                      <p className="ap-none">这段对话还没有内容。</p>
                    )}
                    {messages.map((m, i) => (
                      <Bubble
                        key={`${activeThreadId}-${i}`}
                        m={m}
                        jobBase={jobBase}
                        props={props}
                        deciding={deciding}
                        decide={decide}
                        comp={false}
                        answer={
                          i === messages.length - 1 &&
                          !busy &&
                          on &&
                          !linkedMode
                            ? (t) => send(t)
                            : undefined
                        }
                      />
                    ))}
                    {live && (
                      <LiveBubble
                        live={live}
                        props={props}
                        deciding={deciding}
                        decide={decide}
                        comp={false}
                      />
                    )}
                    {error && (
                      <div className="ad-error" role="alert">
                        <span>{error.text}</span>
                        {error.retry !== undefined && (
                          <Button
                            size="mini"
                            onClick={() => send(error.retry)}
                            disabled={busy}
                          >
                            重试
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {!atBottom && (
                  <button
                    type="button"
                    className="ap-down"
                    onClick={() =>
                      list.current?.scrollTo({
                        top: list.current.scrollHeight,
                        behavior: "smooth",
                      })
                    }
                    aria-label="回到最新"
                  >
                    <IconArrowDown />
                  </button>
                )}
                <div className="ap-foot">
                  {linkedMode &&
                    !isGeneral(sessionKey) &&
                    answered &&
                    !busy && (
                      <div className="ap-solved">
                        <IconCheckCircle />
                        <span>
                          问题解决了？把经过整理成记录，写进这份交付的执行记录。
                        </span>
                        <Button
                          size="small"
                          type="outline"
                          loading={resolving}
                          onClick={resolve}
                        >
                          已解决，写入记录
                        </Button>
                      </div>
                    )}
                  {composer}
                </div>
              </>
            )}
          </>
        )}
      </main>
      {side && (
        <div className="ap-scrim" onClick={() => setSide(false)} aria-hidden />
      )}
      {submitNode}
      <input
        ref={fileIn}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) attach(e.target.files);
          e.target.value = "";
        }}
      />
      <FilePicker
        visible={picker}
        onClose={() => setPicker(false)}
        onPick={(ns) => {
          setPicker(false);
          setAtts((x) =>
            [...x, ...ns.filter((n) => !x.some((y) => y.id === n.id))].slice(
              0,
              8,
            ),
          );
        }}
      />
    </div>
  );
}

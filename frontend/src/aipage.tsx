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
  IconCode,
  IconDelete,
  IconEdit,
  IconFolder,
  IconHistory,
  IconImage,
  IconLaunch,
  IconMenuFold,
  IconMessage,
  IconMore,
  IconPlus,
  IconRecordStop,
  IconRight,
  IconSearch,
  IconSend,
  IconSettings,
  IconStorage,
  IconUpload,
} from "@arco-design/web-react/icon";
import { go } from "./router";
import { bi, useLang } from "./i18n";
import {
  ago,
  api,
  cached,
  can,
  err,
  fetchCached,
  putCached,
  useConnectivity,
  useMedia,
} from "./shared";
import { reportDoc, useSubmitKB } from "./kb";
import type { Job, Session } from "./shared";
import { FileIcon, FilePicker, uploadFiles } from "./myfiles";
import type { FileNode } from "./myfiles";
import { MessageQueueTray, useMessageQueue } from "./aiqueue";
import type { QueuedMsg } from "./aiqueue";
import {
  AIEmblem,
  Bubble,
  ChatErrorCard,
  LiveBubble,
  Spark,
  UnansweredTurnCard,
  newLive,
  readFile,
  streamChat,
  useAIStatus,
} from "./aichat";
import { isGeneral } from "./aichat";
import type {
  AICallDiag,
  AIReport,
  ChatErrorState,
  ChatStreamError,
  CompProposal,
  Live,
  Msg,
  StepProposal,
} from "./aichat";
import { Markdown } from "./aimd";
import { AIPrefs } from "./aiprefs";
import { ModelPicker, useModelPick } from "./modelpick";
import { ThinkLevel, ToolMenu, useAIOptions, useElementWidth, useSpaciousComposer } from "./aitools";
import type { AIOpts } from "./aitools";
import "./aichat.css";
import "./aipage.css";

/* The assistant's own page: every conversation a person has, in one place. Their own conversations (optionally tied
   to a delivery or a component) and the ones held inside their deliveries — a review, or troubleshooting a runbook
   step — open and continue here, proposals included. */

type Ctx = { kind: "" | "job" | "comp" | "form"; id: string; name: string };
/** What a conversation is tied to, in a word: a delivery, a component, or a new delivery being filled in. */
const ctxWord = (k: string) =>
  k === "job"
    ? bi("交付", "Delivery")
    : k === "form"
      ? bi("新建交付", "New delivery")
      : bi("组件", "Component");
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
type CompSession = {
  comp: string;
  comp_title: string;
  history_id?: string;
  title: string;
  label?: string;
  rev?: number;
  messages: number;
  accepted?: number;
  updated: string;
  active: boolean;
  has_draft?: boolean;
};
type CompThread = {
  comp: string;
  compTitle: string;
  title: string;
  historyId?: string;
  label?: string;
  rev?: number;
  at?: string;
  messages: Msg[];
  hasDraft: boolean;
};
type SideTab = "all" | "chat" | "delivery" | "comp";
type ChatListResp = {
  chats: ChatRow[];
  linked: Linked[];
  comp_sessions?: CompSession[];
};

const normPlanLabel = (s?: string) => {
  const lbl = bi("集群部署", "Cluster deploy");
  return s === "首次部署" ? lbl : s ? s.replace(/首次部署/g, lbl) : s;
};
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

type DayBucket = "today" | "yesterday" | "week" | "older";
const dayKey = (s: string): DayBucket => {
  const d = new Date(s);
  const t = new Date();
  const diff = Math.round(
    (new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86400000,
  );
  return diff <= 0
    ? "today"
    : diff === 1
      ? "yesterday"
      : diff < 7
        ? "week"
        : "older";
};
const DAY_LABEL: Record<DayBucket, string> = {
  get today() {
    return bi("今天", "Today");
  },
  get yesterday() {
    return bi("昨天", "Yesterday");
  },
  get week() {
    return bi("最近 7 天", "Last 7 days");
  },
  get older() {
    return bi("更早", "Older");
  },
};
const greeting = () => {
  const h = new Date().getHours();
  return h < 6
    ? bi("夜深了", "Working late")
    : h < 11
      ? bi("早上好", "Good morning")
      : h < 13
        ? bi("中午好", "Good afternoon")
        : h < 18
          ? bi("下午好", "Good afternoon")
          : bi("晚上好", "Good evening");
};

const getSuggest = () => [
  {
    icon: <IconCheckCircle />,
    t: bi(
      "查看我最近的交付进度与验收情况",
      "Check status & acceptance of my recent deliveries",
    ),
    d: bi("读取所有交付的执行状态", "Inspect execution status across deliveries"),
  },
  {
    icon: <IconBug />,
    t: bi(
      "帮我看看最近一次部署失败的原因",
      "Help diagnose why the latest deployment failed",
    ),
    d: bi("结合执行记录与手册", "Analyze execution logs and runbooks"),
  },
  {
    icon: <IconStorage />,
    t: bi(
      "Patroni 高可用的 PostgreSQL 上线前要检查什么？",
      "Pre-flight checklist for Patroni HA PostgreSQL?",
    ),
    d: bi("参考组件与运维技能", "Using component specs & ops skills"),
  },
  {
    icon: <IconBook />,
    t: bi(
      "etcd 报 database space exceeded 怎么处理？",
      "How to fix etcd database space exceeded?",
    ),
    d: bi("按步骤给出排查与修复", "Step-by-step diagnosis & remediation"),
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
  const lang = useLang();
  const turns = useMemo(() => {
    const out: { prompt: string; reply: string }[] = [];
    messages.forEach((m, i) => {
      if (m.role === "user")
        out.push({
          prompt: plain(m.text) || bi("（只发了附件）", "(Attachments only)"),
          reply: plain(
            messages[i + 1]?.role === "assistant" ? messages[i + 1].text : "",
          ),
        });
    });
    return out;
  }, [messages, lang]);
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
      aria-label={bi("对话目录", "Conversation outline")}
      onMouseLeave={() => setHover(null)}
    >
      {turns.slice(first).map((t, k) => {
        const i = first + k;
        return (
          <div key={i} className="ap-ol-i">
            <button
              type="button"
              className={i === active ? "on" : ""}
              aria-label={bi(
                `第 ${i + 1} 个问题：${t.prompt.slice(0, 30)}`,
                `Turn ${i + 1}: ${t.prompt.slice(0, 30)}`,
              )}
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

const NOOP_DECIDE = () => undefined;

const MemoMessageItem = React.memo(function MemoMessageItem({
  m,
  jobBase,
  props,
  deciding,
  decide,
  comp,
  busy,
  canRetry,
  retryText,
  canAnswer,
  onRetryText,
  onAnswerText,
}: {
  m: Msg;
  jobBase: string;
  props: Record<string, StepProposal | CompProposal>;
  deciding: string;
  decide: (
    id: string,
    v: "accept" | "reject",
    body?: Record<string, unknown>,
  ) => void;
  comp: boolean;
  busy: boolean;
  canRetry: boolean;
  retryText?: string;
  canAnswer: boolean;
  onRetryText: (t: string) => void;
  onAnswerText: (t: string) => void;
}) {
  const handleRetry = useCallback(() => {
    if (retryText) onRetryText(retryText);
  }, [retryText, onRetryText]);
  return (
    <Bubble
      m={m}
      jobBase={jobBase}
      props={props}
      deciding={deciding}
      decide={decide}
      comp={comp}
      busy={busy}
      onRetry={canRetry && retryText ? handleRetry : undefined}
      answer={canAnswer ? onAnswerText : undefined}
    />
  );
});

export function AIPage({
  me,
  chatId,
  job,
  sessionKey,
  comp,
  hist,
  jobs,
}: {
  me: Session;
  chatId?: string;
  job?: string;
  sessionKey?: string;
  comp?: string;
  hist?: string;
  jobs: Job[];
}) {
  useLang();
  const lang = useLang();
  const status = useAIStatus();
  const net = useConnectivity();
  const linkedMode = !!(job && sessionKey);
  const compArchMode = !!(comp && hist);
  const compMode = !!(comp && (sessionKey === "workbench" || hist));
  const compLiveMode = compMode && !compArchMode;
  const threadMode = linkedMode || compMode;
  const feature = compMode
    ? "component"
    : linkedMode
      ? isGeneral(sessionKey)
        ? "review"
        : "troubleshoot"
      : "assistant";
  const on = !!status.features[feature];
  const model = useModelPick(feature);
  const tools = useAIOptions();
  const narrowBar = useMedia("(max-width: 700px)");
  const initChats = cached<ChatListResp>("/api/ai/chats");
  const [rows, setRows] = useState<ChatRow[] | null>(
    () => initChats?.chats ?? null,
  );
  const [linked, setLinked] = useState<Linked[]>(() => initChats?.linked ?? []);
  const [compSessions, setCompSessions] = useState<CompSession[]>(
    () => initChats?.comp_sessions ?? [],
  );
  const [q, setQ] = useState("");
  const [sideTab, setSideTab] = useState<SideTab>("all");
  const [secOpen, setSecOpen] = useState<Record<string, boolean>>({
    chat: true,
    comp: true,
    delivery: true,
    form: false,
    arch: false,
  });
  const toggleSec = (k: string) =>
    setSecOpen((prev) => ({ ...prev, [k]: !prev[k] }));
  const [chat, setChat] = useState<Chat | null>(null);
  const [js, setJs] = useState<JobSession | null>(null);
  const [compThread, setCompThread] = useState<CompThread | null>(null);
  const [props, setProps] = useState<Record<string, StepProposal>>({});
  const [compProps, setCompProps] = useState<Record<string, CompProposal>>({});
  const [deciding, setDeciding] = useState("");
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [imgs, setImgs] = useState<string[]>([]);
  const [atts, setAtts] = useState<FileNode[]>([]);
  const [uploading, setUploading] = useState(0);
  const [picker, setPicker] = useState(false);
  const [drop, setDrop] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  const [ctx, setCtx] = useState<Ctx>({ kind: "", id: "", name: "" });
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<ChatErrorState | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [side, setSide] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [openSubmit, submitNode] = useSubmitKB();
  const sideRows = useRef<HTMLDivElement>(null);
  const initialRevealed = useRef(false);
  const orderSeeded = useRef(false);
  const topRank = useRef(0);
  const chatSlots = useRef<Map<string, { rank: number; group: DayBucket }>>(
    new Map(),
  );
  const clusterRanks = useRef<Map<string, number>>(new Map());
  const planRanks = useRef<Map<string, number>>(new Map());
  const linkedRanks = useRef<Map<string, number>>(new Map());
  const compGroupRanks = useRef<Map<string, number>>(new Map());
  const compSessRanks = useRef<Map<string, number>>(new Map());
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const composeRef = useRef<HTMLFormElement>(null);
  const composeW = useElementWidth(composeRef);
  const compactTools = narrowBar || (composeW > 0 && composeW < 680);
  const compactThink = narrowBar || (composeW > 0 && composeW < 760);
  const hideThinkOnBar = (composeW > 0 && composeW < 460) || (composeW === 0 && narrowBar);
  const spacious = useSpaciousComposer(
    composeRef,
    Boolean(input.trim() || imgs.length || atts.length),
  );
  const abort = useRef<AbortController | null>(null);
  const liveRafRef = useRef(0);
  const autoScrollRafRef = useRef(0);
  const scrollCheckRafRef = useRef(0);
  const atBottomRef = useRef(true);
  const userScrollLockRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const sendingRef = useRef(false);
  const decidingRef = useRef(false);
  const resolvingRef = useRef(false);
  const archivingRef = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  const promotedId = useRef("");
  const [draftId, setDraftId] = useState(newId);
  const [remote, setRemote] = useState(false);
  const prefsMode = chatId === "~prefs";
  const id = chatId && !prefsMode ? chatId : draftId;
  const activeThreadId = linkedMode
    ? `linked:${job}:${sessionKey}`
    : compMode
      ? `comp:${comp}:${hist || "workbench"}`
      : prefsMode
        ? "prefs"
        : id;
  const threadRef = useRef(activeThreadId);
  threadRef.current = activeThreadId;
  const queue = useMessageQueue<FileNode>(activeThreadId);
  const pendingJumpRef = useRef<{
    thread: string;
    item: QueuedMsg<FileNode>;
  } | null>(null);
  const busy = !!live;
  const jobBase = job ? `/api/jobs/${job}/ai` : "";
  const compBase = comp ? `/api/components/${encodeURIComponent(comp)}/ai` : "";
  const imgBase = compMode
    ? compArchMode
      ? `${compBase}/history/${encodeURIComponent(hist!)}`
      : compBase
    : jobBase;
  const jobRow = jobs.find((j) => j.id === job);

  const compSessionKey = (s: CompSession) =>
    `${s.comp}\0${s.history_id || "workbench"}`;

  const applyChatList = useCallback((r: Partial<ChatListResp>) => {
    const chats = r.chats || [];
    const lnk = r.linked || [];
    const comps = r.comp_sessions || [];
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
      comps.forEach((s, idx) => {
        if (!compGroupRanks.current.has(s.comp))
          compGroupRanks.current.set(s.comp, compGroupRanks.current.size);
        compSessRanks.current.set(compSessionKey(s), idx);
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
      for (let i = comps.length - 1; i >= 0; i--) {
        const s = comps[i];
        const sk = compSessionKey(s);
        if (!compGroupRanks.current.has(s.comp))
          compGroupRanks.current.set(s.comp, --topRank.current);
        if (!compSessRanks.current.has(sk))
          compSessRanks.current.set(sk, --topRank.current);
      }
    }
    setRows(chats);
    setLinked(lnk);
    setCompSessions(comps);
  }, []);

  if (initChats && !orderSeeded.current) {
    (initChats.chats || []).forEach((c, idx) =>
      chatSlots.current.set(c.id, { rank: idx, group: dayKey(c.updated) }),
    );
    (initChats.linked || []).forEach((l, idx) => {
      if (!clusterRanks.current.has(l.cluster))
        clusterRanks.current.set(l.cluster, clusterRanks.current.size);
      if (!planRanks.current.has(l.job))
        planRanks.current.set(l.job, planRanks.current.size);
      linkedRanks.current.set(`${l.job}\0${l.key}`, idx);
    });
    (initChats.comp_sessions || []).forEach((s, idx) => {
      if (!compGroupRanks.current.has(s.comp))
        compGroupRanks.current.set(s.comp, compGroupRanks.current.size);
      compSessRanks.current.set(compSessionKey(s), idx);
    });
    orderSeeded.current = true;
  }

  const loadList = useCallback(
    (fresh = true) => {
      (fresh ? api : fetchCached)<ChatListResp>("/api/ai/chats")
        .then((r) => {
          putCached("/api/ai/chats", r);
          applyChatList(r);
        })
        .catch(() => setRows((prev) => prev ?? []));
    },
    [applyChatList],
  );
  useEffect(() => {
    loadList(false);
  }, [loadList]);

  const loadProps = useCallback(() => {
    if (!jobBase) return Promise.resolve();
    return api<{ proposals: StepProposal[] }>(`${jobBase}/proposals`)
      .then((r) =>
        setProps(Object.fromEntries((r.proposals || []).map((p) => [p.id, p]))),
      )
      .catch(() => undefined);
  }, [jobBase]);

  const loadCompProps = useCallback(() => {
    if (!compBase || compArchMode) return Promise.resolve();
    return api<{ proposals: CompProposal[]; has_draft?: boolean }>(
      `${compBase}/session`,
    )
      .then((r) => {
        setCompProps(
          Object.fromEntries((r.proposals || []).map((p) => [p.id, p])),
        );
        if (typeof r.has_draft === "boolean") {
          setCompThread((prev) =>
            prev ? { ...prev, hasDraft: !!r.has_draft } : prev,
          );
        }
      })
      .catch(() => undefined);
  }, [compBase, compArchMode]);

  const compMetaRow = useMemo(
    () =>
      comp
        ? compSessions.find(
            (s) =>
              s.comp === comp &&
              (hist ? s.history_id === hist : s.active),
          ) || compSessions.find((s) => s.comp === comp)
        : undefined,
    [comp, hist, compSessions],
  );
  const compTitleOf = (name: string) =>
    compSessions.find((s) => s.comp === name)?.comp_title ||
    (name === "platform-shared" ? bi("平台公共流程", "Platform Shared") : name);

  // open what the address names: a delivery's conversation, a component workbench session, a saved one, or a blank one
  useEffect(() => {
    if (!threadMode && chatId && !prefsMode && promotedId.current === chatId) {
      promotedId.current = "";
      return;
    }
    promotedId.current = "";
    abort.current?.abort();
    abort.current = null;
    if (liveRafRef.current) {
      window.cancelAnimationFrame(liveRafRef.current);
      liveRafRef.current = 0;
    }
    setLive(null);
    setRemote(false);
    setError(null);
    setInput("");
    setImgs([]);
    setAtts([]);
    setProps({});
    setCompProps({});
    setDeciding("");
    userScrollLockRef.current = false;
    atBottomRef.current = true;
    setAtBottom(true);
    setSide(false);
    setDrop(false);
    seeded.current = false;
    let alive = true;
    if (linkedMode) {
      setLoading(true);
      setChat(null);
      setJs(null);
      setCompThread(null);
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
              notice: bi(
                "这段对话还在回答，写完会自动显示在这里",
                "This reply is still generating; it will appear here automatically once done",
              ),
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
    if (compMode && comp) {
      setLoading(true);
      setChat(null);
      setJs(null);
      setCompThread(null);
      const deriveTitle = (msgs: Msg[], fallback?: string) => {
        if (fallback?.trim()) return fallback.trim();
        const firstUser = msgs.find((m) => m.role === "user" && m.text?.trim());
        return firstUser
          ? plain(firstUser.text).slice(0, 60)
          : bi("组件工作台对话", "Component workbench chat");
      };
      if (compArchMode && hist) {
        api<{
          meta?: {
            id?: string;
            at?: string;
            label?: string;
            rev?: number;
            title?: string;
          };
          messages: Msg[];
          proposals: CompProposal[];
        }>(`${compBase}/history/${encodeURIComponent(hist)}`)
          .then((r) => {
            if (!alive) return;
            const ps = (r.proposals || []).map((p) =>
              p.status === "pending" ? { ...p, status: "withdrawn" } : p,
            );
            setCompProps(Object.fromEntries(ps.map((p) => [p.id, p])));
            setCompThread({
              comp,
              compTitle: compTitleOf(comp),
              title: deriveTitle(r.messages || [], r.meta?.title),
              historyId: hist,
              label: r.meta?.label,
              rev: r.meta?.rev,
              at: r.meta?.at,
              messages: r.messages || [],
              hasDraft: false,
            });
          })
          .catch((e) => {
            if (alive) setError({ text: (e as Error).message });
          })
          .finally(() => {
            if (alive) setLoading(false);
          });
      } else {
        api<{
          messages: Msg[];
          proposals: CompProposal[];
          has_draft?: boolean;
        }>(`${compBase}/session`)
          .then((r) => {
            if (!alive) return;
            setCompProps(
              Object.fromEntries((r.proposals || []).map((p) => [p.id, p])),
            );
            setCompThread({
              comp,
              compTitle: compTitleOf(comp),
              title: deriveTitle(r.messages || []),
              messages: r.messages || [],
              hasDraft: !!r.has_draft,
            });
          })
          .catch((e) => {
            if (alive) setError({ text: (e as Error).message });
          })
          .finally(() => {
            if (alive) setLoading(false);
          });
      }
      return () => {
        alive = false;
      };
    }
    setJs(null);
    setCompThread(null);
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
  }, [chatId, job, sessionKey, comp, hist]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!threadMode && !chatId && !prefsMode && job) {
      const j = jobs.find((x) => x.id === job);
      if (j)
        setCtx((c) =>
          c.kind === "job" && c.id === j.id && c.name === j.cluster_id
            ? c
            : { kind: "job", id: j.id, name: j.cluster_id },
        );
    }
  }, [threadMode, chatId, prefsMode, job, jobs]);
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
  useEffect(
    () => () => {
      abort.current?.abort();
      if (liveRafRef.current) window.cancelAnimationFrame(liveRafRef.current);
      if (autoScrollRafRef.current)
        window.cancelAnimationFrame(autoScrollRafRef.current);
      if (scrollCheckRafRef.current)
        window.cancelAnimationFrame(scrollCheckRafRef.current);
    },
    [],
  );
  useEffect(() => {
    if (!side) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSide(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [side]);
  useEffect(() => {
    if (!drop) return;
    const clearDrop = () => setDrop(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrop(false);
    };
    window.addEventListener("dragend", clearDrop);
    window.addEventListener("drop", clearDrop);
    window.addEventListener("blur", clearDrop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragend", clearDrop);
      window.removeEventListener("drop", clearDrop);
      window.removeEventListener("blur", clearDrop);
      window.removeEventListener("keydown", onKey);
    };
  }, [drop]);
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
    if (!el || el.scrollTop > 0 || (!chatId && !threadMode)) return;
    el.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({
      block: "nearest",
    });
  }, [rows, linked, compSessions, chatId, threadMode]);
  useEffect(() => {
    if (!loading && !window.matchMedia("(max-width: 900px)").matches)
      box.current?.focus({ preventScroll: true });
  }, [chatId, job, sessionKey, comp, hist, loading]);

  const messages = linkedMode
    ? js?.messages || []
    : compMode
      ? compThread?.messages || []
      : chat?.messages || [];
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottomRef.current && !userScrollLockRef.current) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    }
  }, [activeThreadId, messages.length]);
  useEffect(() => {
    if (!live || !atBottomRef.current || userScrollLockRef.current) return;
    if (autoScrollRafRef.current) return;
    autoScrollRafRef.current = window.requestAnimationFrame(() => {
      autoScrollRafRef.current = 0;
      const el = list.current;
      if (el && atBottomRef.current && !userScrollLockRef.current) {
        el.scrollTop = el.scrollHeight;
        lastScrollTopRef.current = el.scrollTop;
      }
    });
  }, [live]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!input) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [input]);

  const attach = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    if (atts.length + list.length > 8)
      return Message.warning(
        bi("一条消息最多附带 8 个文件", "At most 8 files per message"),
      );
    if (
      list.some((f) => f.type.startsWith("image/")) &&
      model.current?.vision === "no"
    )
      Message.warning(
        bi(
          "当前模型看不了图片：图片会存进「我的资料」，但 AI 读不到画面内容",
          "Current model doesn't support images: files will be saved to My Files, but AI cannot inspect image contents",
        ),
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
    if (!threadMode) return attach(files);
    if (compArchMode) return;
    const pics = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!pics.length) return;
    if (model.current?.vision === "no")
      return Message.warning(
        bi(
          "当前模型看不了图片，请把报错文字贴进来，或换一个能看图的模型",
          "Current model doesn't support vision—paste error text instead or switch to a vision-capable model",
        ),
      );
    if (imgs.length + pics.length > 3)
      return Message.warning(bi("一次最多 3 张图片", "At most 3 images at once"));
    try {
      const data = await Promise.all(pics.map(readFile));
      setImgs((x) => [...x, ...data]);
    } catch (e) {
      err(e);
    }
  };

  const flip = useRef<{ box: DOMRect; text: DOMRect } | null>(null);
  const stopRun = (pauseQueue = true) => {
    if (pauseQueue && queue.items.length > 0) queue.setPaused(true);
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
    if (!threadMode && !chatId && !prefsMode) {
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
  const canReplyComp = compLiveMode && Boolean(compThread?.hasDraft);
  const enqueueCurrent = () => {
    const text = input.trim();
    if ((!text && !imgs.length && !atts.length) || !on || net !== "online" || uploading > 0)
      return false;
    if (compMode && !canReplyComp) return false;
    const ok = queue.enqueue({ text, images: imgs, files: atts });
    if (ok) {
      setInput("");
      setImgs([]);
      setAtts([]);
      requestAnimationFrame(() => box.current?.focus({ preventScroll: true }));
    }
    return ok;
  };
  const send = async (
    override?: string,
    isRetry?: boolean,
    optsOverride?: Partial<AIOpts>,
    queued?: QueuedMsg<FileNode>,
  ) => {
    const text = (queued ? queued.text : (override ?? input)).trim();
    const sent = queued ? queued.images || [] : override !== undefined ? [] : imgs;
    const sentFiles = queued
      ? queued.files || []
      : override !== undefined
        ? []
        : atts;
    if (
      (!text && !sent.length && !sentFiles.length) ||
      busy ||
      sendingRef.current ||
      !on ||
      (!queued && uploading > 0)
    )
      return;
    if (compMode && !canReplyComp) return;
    sendingRef.current = true;
    const myThread = threadRef.current;
    const here = () => threadRef.current === myThread;
    setError(null);
    const trimmed = [...messages];
    while (
      trimmed.length > 0 &&
      trimmed[trimmed.length - 1].role === "assistant" &&
      trimmed[trimmed.length - 1].error &&
      !trimmed[trimmed.length - 1].text?.trim()
    ) {
      trimmed.pop();
    }
    const again = Boolean(
      !queued &&
        (isRetry || override !== undefined) &&
        trimmed.length > 0 &&
        trimmed[trimmed.length - 1].role === "user" &&
        trimmed[trimmed.length - 1].text === text,
    );
    if (!threadMode && messages.length === 0 && !live) {
      // remember where the start-page box and its text are, so the first message can travel from there into the thread
      const f = document.querySelector<HTMLElement>(".ap-hero .ap-compose");
      const t = f?.querySelector("textarea");
      if (f && t)
        flip.current = {
          box: f.getBoundingClientRect(),
          text: t.getBoundingClientRect(),
        };
    }
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
    if (again) {
      if (linkedMode)
        setJs((s) => (s ? { ...s, messages: trimmed } : s));
      else if (compMode)
        setCompThread((s) => (s ? { ...s, messages: trimmed } : s));
      else
        setChat((c) => (c ? { ...c, messages: trimmed } : c));
    } else if (linkedMode) {
      setJs((s) => (s ? { ...s, messages: [...s.messages, userMsg] } : s));
    } else if (compMode) {
      setCompThread((s) =>
        s ? { ...s, messages: [...s.messages, userMsg] } : s,
      );
    } else {
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
    }
    if (!queued && override === undefined) {
      setInput("");
      setImgs([]);
      setAtts([]);
    }
    userScrollLockRef.current = false;
    atBottomRef.current = true;
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
      rehearsals: cur.rehearsals,
      knowledges: cur.knowledges,
      components: cur.components,
      ask: cur.ask,
      files: cur.files,
      at: new Date().toISOString(),
    });
    const push = (m: Msg) =>
      linkedMode
        ? setJs((s) => (s ? { ...s, messages: [...s.messages, m] } : s))
        : compMode
          ? setCompThread((s) =>
              s ? { ...s, messages: [...s.messages, m] } : s,
            )
          : setChat((c) => (c ? { ...c, messages: [...c.messages, m] } : c));
    try {
      const url = linkedMode
        ? `${jobBase}/chat`
        : compMode
          ? `${compBase}/chat`
          : `/api/ai/chats/${id}/chat`;
      const reqOpts = optsOverride
        ? { ...tools.opts, ...optsOverride }
        : tools.opts;
      const body = linkedMode
        ? {
            key: sessionKey,
            message: text,
            images: sent,
            step: js?.step,
            model: model.ref,
            options: reqOpts,
            retry: again,
          }
        : compMode
          ? {
              message: text,
              images: sent,
              model: model.ref,
              options: reqOpts,
              retry: again,
            }
          : {
              message: text,
              attachments: sentFiles.map((f) => f.id),
              ctx: ctx.kind ? { kind: ctx.kind, id: ctx.id } : undefined,
              model: model.ref,
              options: reqOpts,
              retry: again,
            };
      const scheduleLive = () => {
        if (!here() || liveRafRef.current) return;
        liveRafRef.current = window.requestAnimationFrame(() => {
          liveRafRef.current = 0;
          if (!here()) return;
          setLive({
            ...cur,
            tools: [...cur.tools],
            steps: cur.steps.map((x) => ({ ...x })),
            made: [...cur.made],
            rehearsals: cur.rehearsals ? [...cur.rehearsals] : undefined,
            knowledges: cur.knowledges ? [...cur.knowledges] : undefined,
            components: cur.components ? [...cur.components] : undefined,
            sandboxConfirms: cur.sandboxConfirms
              ? [...cur.sandboxConfirms]
              : undefined,
          });
        });
      };
      await streamChat(
        url,
        body,
        ac.signal,
        cur,
        scheduleLive,
        () =>
          here()
            ? compMode
              ? loadCompProps()
              : loadProps()
            : Promise.resolve(),
      );
      if (!here()) {
        loadList();
        return;
      }
      push(finished());
      if (!threadMode && !chatId) {
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
      const streamErr = e as ChatStreamError;
      const diag =
        streamErr.diag ??
        (e as { body?: { diag?: AICallDiag } }).body?.diag;
      if (cur.text || cur.steps.length) {
        push({
          ...finished(),
          text: cur.text + (stopped ? bi("\n\n（已停止）", "\n\n(Stopped)") : ""),
          ...(stopped
            ? {}
            : { error: streamErr.message, error_diag: diag }),
        });
        if (!threadMode && !chatId) {
          promotedId.current = id;
          go({ name: "ai", id }, { replace: true, instant: true });
        }
        loadList();
      } else if (!stopped && streamErr.saved) {
        push({
          role: "assistant",
          text: "",
          error: streamErr.message,
          error_diag: diag,
          at: new Date().toISOString(),
        });
        if (!threadMode && !chatId) {
          promotedId.current = id;
          go({ name: "ai", id }, { replace: true, instant: true });
        }
        loadList();
      } else if (!stopped) {
        setError({
          text: streamErr.message,
          retry: text,
          diag,
          kind: streamErr.kind,
          rawError: streamErr.rawError,
        });
      }
      if (!stopped && queue.items.length > 0) queue.setPaused(true);
    } finally {
      sendingRef.current = false;
      if (liveRafRef.current) {
        window.cancelAnimationFrame(liveRafRef.current);
        liveRafRef.current = 0;
      }
      if (here()) {
        setLive(null);
        abort.current = null;
      }
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  const onRetryText = useCallback((t: string) => {
    void sendRef.current(t, true);
  }, []);
  const onAnswerText = useCallback((t: string) => {
    void sendRef.current(t);
  }, []);

  const submitComposer = () => {
    if (busy) {
      enqueueCurrent();
      return;
    }
    void send();
  };

  const sendQueuedNow = (item: QueuedMsg<FileNode>) => {
    const taken = queue.take(item.id);
    if (!taken) return;
    queue.setPaused(false);
    if (busy) {
      pendingJumpRef.current = { thread: activeThreadId, item: taken };
      stopRun(false);
    } else {
      void send(undefined, false, undefined, taken);
    }
  };

  // Auto-dispatch the next queued message once the active AI turn finishes cleanly.
  useEffect(() => {
    if (busy || !on || net !== "online" || loading || uploading > 0) return;
    if (compMode && !canReplyComp) return;
    if (
      pendingJumpRef.current &&
      pendingJumpRef.current.thread === activeThreadId
    ) {
      const next = pendingJumpRef.current.item;
      pendingJumpRef.current = null;
      void send(undefined, false, undefined, next);
      return;
    }
    if (!queue.paused && queue.items.length > 0) {
      const next = queue.take();
      if (next) void send(undefined, false, undefined, next);
    }
  }, [
    busy,
    on,
    net,
    loading,
    uploading,
    compMode,
    canReplyComp,
    activeThreadId,
    queue.paused,
    queue.items.length,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // a question another page prepared (for example "work out a plan for this CVE"): sent as soon as the page is ready
  useEffect(() => {
    if (
      seeded.current ||
      threadMode ||
      chatId ||
      prefsMode ||
      !on ||
      busy ||
      loading
    )
      return;
    let seed = "";
    let seedWeb = false;
    try {
      const raw = sessionStorage.getItem("mw-ai-seed");
      if (raw) {
        const v = JSON.parse(raw) as {
          text?: string;
          web?: boolean;
          at?: number;
        };
        if (v.text && Date.now() - (v.at || 0) < 120000) {
          seed = v.text;
          seedWeb = Boolean(v.web);
        }
        sessionStorage.removeItem("mw-ai-seed");
      }
    } catch {
      /* no seed */
    }
    if (!seed) return;
    seeded.current = true;
    const enableWeb = seedWeb && (tools.options ? Boolean(tools.options.web) : true);
    const t = window.setTimeout(
      () => void sendRef.current(seed, false, enableWeb ? { web: true } : undefined),
      150,
    );
    return () => window.clearTimeout(t);
  }, [threadMode, chatId, prefsMode, on, busy, loading, tools.options]);

  const decide = async (
    pid: string,
    verb: "accept" | "reject",
    body?: Record<string, unknown>,
  ) => {
    if (compArchMode || decidingRef.current) return;
    decidingRef.current = true;
    setDeciding(pid);
    try {
      if (compLiveMode) {
        await api(`${compBase}/proposals/${pid}/${verb}`, {
          method: "POST",
          body: body ? JSON.stringify(body) : undefined,
        });
        if (verb === "accept")
          Message.success(
            bi(
              "已写入组件草稿（发布后生效）",
              "Applied to component draft (effective after publish)",
            ),
          );
        await loadCompProps();
        loadList();
      } else {
        const curProp = props[pid] as StepProposal | undefined;
        const saved = await api<StepProposal>(
          `${jobBase}/proposals/${pid}/${verb}`,
          {
            method: "POST",
            body: body ? JSON.stringify(body) : undefined,
          },
        );
        if (verb === "accept") {
          if (curProp?.kind === "knowledge") {
            const kb = saved?.knowledge;
            Message.success(
              kb?.team_doc_id
                ? bi("已直接发布到团队知识库", "Published to team Knowledge Base")
                : kb?.submission_id
                  ? bi(
                      "已提交团队知识库等待审核",
                      "Submitted to team Knowledge Base for review",
                    )
                  : bi("已存入「我的知识库」", "Saved to your personal Knowledge Base"),
            );
          } else if (curProp?.kind === "rehearsal") {
            Message.success(
              bi(
                "已确认，正在前往集群变更演练",
                "Confirmed; opening cluster rehearsal",
              ),
            );
          } else if (curProp?.kind !== "component") {
            Message.success(
              bi(
                "已写入执行手册和交付文档",
                "Applied to runbook and delivery docs",
              ),
            );
          }
        }
        await loadProps();
      }
    } catch (e) {
      err(e);
    } finally {
      decidingRef.current = false;
      setDeciding("");
    }
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;
  const stableDecide = useCallback(
    (pid: string, verb: "accept" | "reject", body?: Record<string, unknown>) => {
      void decideRef.current(pid, verb, body);
    },
    [],
  );
  const resolve = async () => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setResolving(true);
    try {
      const rep = await api<AIReport>(`${jobBase}/resolve`, {
        method: "POST",
        body: JSON.stringify({ key: sessionKey, to_kb: true }),
      });
      const where = bi(
        `交付 ${jobRow?.cluster_id || job} · ${title}`,
        `Delivery ${jobRow?.cluster_id || job} · ${title}`,
      );
      (can("kb.submit") ? Modal.confirm : Modal.success)({
        title: bi(
          "已写入这份交付的执行记录",
          "Saved to this delivery's execution record",
        ),
        content: (
          <Markdown
            text={bi(
              `**现象**　${rep.symptom}\n\n**原因**　${rep.cause}\n\n**处理**\n\n${rep.fix}`,
              `**Symptom:** ${rep.symptom}\n\n**Root cause:** ${rep.cause}\n\n**Resolution:**\n\n${rep.fix}`,
            )}
          />
        ),
        okText: can("kb.submit")
          ? bi("发布到团队（需审核）", "Publish to team (needs review)")
          : bi("好", "OK"),
        cancelText: bi("只留在我的知识库", "Keep in my KB only"),
        onOk: () => {
          if (can("kb.submit")) openSubmit(reportDoc(rep, where));
        },
      });
    } catch (e) {
      err(e);
    } finally {
      resolvingRef.current = false;
      setResolving(false);
    }
  };

  const remove = (c: ChatRow) =>
    Modal.confirm({
      title: bi(`删除「${c.title}」？`, `Delete "${c.title}"?`),
      content: bi(
        "对话内容会删除，不能恢复。",
        "This conversation will be deleted and cannot be recovered.",
      ),
      okText: bi("删除", "Delete"),
      cancelText: bi("取消", "Cancel"),
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
      title: bi("重命名对话", "Rename conversation"),
      content: (
        <Input
          defaultValue={c.title}
          maxLength={60}
          onChange={(v) => (title = v)}
          aria-label={bi("对话标题", "Conversation title")}
          autoFocus
        />
      ),
      okText: bi("保存", "Save"),
      cancelText: bi("取消", "Cancel"),
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
    if (archivingRef.current.has(c.id)) return;
    archivingRef.current.add(c.id);
    try {
      await api(`/api/ai/chats/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: on }),
      });
      Message.success(
        on
          ? bi(
              "已归档，可以在列表底部的「已归档」里找到",
              "Archived; find it under Archived at the bottom of the list",
            )
          : bi("已取消归档", "Unarchived"),
      );
      if (on && c.id === chatId) go({ name: "ai" });
      loadList();
    } catch (e) {
      err(e);
    } finally {
      archivingRef.current.delete(c.id);
    }
  };
  const needle = q.trim().toLowerCase();
  const match = (c: ChatRow) =>
    !needle ||
    (c.title + " " + (c.ctx?.name || "")).toLowerCase().includes(needle);
  const rankOfChat = (c: ChatRow) => chatSlots.current.get(c.id)?.rank ?? 0;
  const groupOfChat = (c: ChatRow): DayBucket =>
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
  const regularChats = useMemo(
    () => mine.filter((c) => c.ctx?.kind !== "form"),
    [mine],
  );
  const formChats = useMemo(
    () => mine.filter((c) => c.ctx?.kind === "form"),
    [mine],
  );
  const groups = useMemo(() => {
    const m = new Map<DayBucket, ChatRow[]>();
    regularChats.forEach((c) => {
      const g = groupOfChat(c);
      m.set(g, [...(m.get(g) || []), c]);
    });
    return (["today", "yesterday", "week", "older"] as DayBucket[])
      .filter((k) => m.has(k))
      .map((k) => [k, m.get(k)!] as const);
  }, [regularChats]); // eslint-disable-line react-hooks/exhaustive-deps
  const byComp = useMemo(() => {
    const m = new Map<string, CompSession[]>();
    compSessions
      .filter(
        (s) =>
          !needle ||
          (
            s.comp +
            " " +
            s.comp_title +
            " " +
            s.title +
            " " +
            (s.label || "")
          )
            .toLowerCase()
            .includes(needle),
      )
      .forEach((s) => m.set(s.comp, [...(m.get(s.comp) || []), s]));
    return [...m.entries()]
      .sort(
        ([ca], [cb]) =>
          (compGroupRanks.current.get(ca) ?? 0) -
          (compGroupRanks.current.get(cb) ?? 0),
      )
      .map(
        ([k, items]) =>
          [
            k,
            [...items].sort(
              (a, b) =>
                (a.active === b.active ? 0 : a.active ? -1 : 1) ||
                (compSessRanks.current.get(compSessionKey(a)) ?? 0) -
                  (compSessRanks.current.get(compSessionKey(b)) ?? 0),
            ),
          ] as [string, CompSession[]],
      );
  }, [compSessions, needle]);
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

  const chatTotal = regularChats.length + formChats.length;
  const deliveryTotal = byDelivery.reduce((n, [, items]) => n + items.length, 0);
  const compTotal = byComp.reduce((n, [, items]) => n + items.length, 0);
  const showChatSec = sideTab === "all" || sideTab === "chat";
  const showCompSec = sideTab === "all" || sideTab === "comp";
  const showDeliverySec = sideTab === "all" || sideTab === "delivery";
  const visibleAny =
    (showChatSec &&
      (regularChats.length > 0 ||
        formChats.length > 0 ||
        archived.length > 0)) ||
    (showCompSec && byComp.length > 0) ||
    (showDeliverySec && byDelivery.length > 0);
  const chatOpen = secOpen.chat || !!needle || sideTab === "chat";
  const compOpen = secOpen.comp || !!needle || sideTab === "comp";
  const deliveryOpen = secOpen.delivery || !!needle || sideTab === "delivery";
  const formOpen = secOpen.form || !!needle || ctx.kind === "form";
  const archOpen = secOpen.arch || !!needle || Boolean(chat?.archived);

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
  const doneJobs = useMemo(() => {
    const ok = jobs
      .filter((j) => j.state === "succeeded" && j.outcome !== "void")
      .sort((a, b) => b.created.localeCompare(a.created));
    const settledByCluster = new Map<string, Job>();
    for (const j of ok) {
      if (
        !settledByCluster.has(j.cluster_id) &&
        (j.outcome === "done" || j.outcome === "deviated")
      ) {
        settledByCluster.set(j.cluster_id, j);
      }
    }
    const seen = new Set<string>();
    const out: Job[] = [];
    for (const j of ok) {
      if (seen.has(j.cluster_id)) continue;
      out.push(settledByCluster.get(j.cluster_id) || j);
      seen.add(j.cluster_id);
    }
    return out;
  }, [jobs]);
  const activeCompTitle =
    compMetaRow?.comp_title ||
    compThread?.compTitle ||
    (comp ? compTitleOf(comp) : "");
  const title = linkedMode
    ? js?.title ||
      (isGeneral(sessionKey)
        ? bi("对话", "Chat")
        : bi("现场排障", "Troubleshooting"))
    : compMode
      ? compThread?.title ||
        compMetaRow?.title ||
        bi("组件工作台对话", "Component workbench chat")
      : chat?.title || bi("新对话", "New chat");
  const answered = messages.some((m) => m.role === "assistant" && !m.error);
  const ctxChip = linkedMode
    ? { kind: "job", id: job!, name: jobRow?.cluster_id || job!.slice(0, 8) }
    : compMode
      ? { kind: "comp", id: comp!, name: activeCompTitle || comp! }
      : ctx;
  const openCompTarget = (compId: string) =>
    go(
      can("component.edit")
        ? { name: "components", id: compId, edit: "files" }
        : { name: "components", id: compId },
    );
  const canReplyThread =
    ctx.kind !== "form" && (!compMode || canReplyComp);

  // a conversation held while filling in a new delivery goes on next to that form: only there can it write into it
  const formBack = ctx.kind === "form" && (
    <div className="ap-formback">
      <span>
        {bi(
          `这段对话是在新建 ${ctx.name} 时边聊边填表的，要接着填请回到表单页面。`,
          `This conversation was started while creating ${ctx.name}; return to the form to continue filling it.`,
        )}
      </span>
      <Button
        type="primary"
        onClick={() => go({ name: "new", app: ctx.id, chat: chatId })}
      >
        {bi("回到表单继续", "Back to form")}
      </Button>
    </div>
  );
  const compBack = compMode && (compArchMode || (compThread && !compThread.hasDraft)) && (
    <div className={`ap-compback ${compArchMode ? "arch" : ""}`}>
      <span>
        {compArchMode
          ? bi(
              `这段组件工作台对话已归档${compThread?.label ? `（${compThread.label}）` : ""}，完整过程与改动提案已保留在此供随时查阅。`,
              `This component workbench thread is archived${compThread?.label ? ` (${compThread.label})` : ""}; all messages and proposals remain preserved here for reference.`,
            )
          : bi(
              `这段组件工作台对话已保留。当前「${activeCompTitle}」没有编辑中的草稿，前往组件工作台开启草稿后可继续由 AI 协助修改。`,
              `This component workbench thread is preserved. "${activeCompTitle}" has no active draft right now; open the workbench to start a draft and continue editing with AI.`,
            )}
      </span>
      <Button
        type="primary"
        size="small"
        onClick={() => openCompTarget(comp!)}
      >
        {bi("前往组件工作台", "Open Workbench")}
      </Button>
    </div>
  );
  const isHero = !threadMode && !started;
  const hasDraft = Boolean(input.trim() || imgs.length || atts.length);
  const composer = formBack || compBack || (
    <form
      ref={composeRef}
      className={`ap-compose ${isHero && spacious.expanded ? "is-writing" : ""} ${!on || offline ? "off" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        submitComposer();
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
              <img
                src={im}
                alt={bi(`待发送的截图 ${i + 1}`, `Pending screenshot ${i + 1}`)}
              />
              <button
                type="button"
                aria-label={bi("移除这张图片", "Remove image")}
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
                aria-label={bi(`移除 ${a.name}`, `Remove ${a.name}`)}
                onClick={() => setAtts(atts.filter((x) => x.id !== a.id))}
              >
                <IconClose />
              </button>
            </span>
          ))}
          {uploading > 0 && (
            <span className="ap-att wait">
              {bi(
                `正在上传 ${uploading} 个文件…`,
                `Uploading ${uploading} file${uploading === 1 ? "" : "s"}…`,
              )}
            </span>
          )}
        </div>
      )}
      <textarea
        ref={box}
        value={input}
        rows={1}
        onPointerDown={isHero ? spacious.onFieldPointerDown : undefined}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submitComposer();
          }
        }}
        placeholder={
          !on
            ? can("ai.settings")
              ? bi(
                  "AI 未开启，可在「设置 → AI」中开启",
                  "AI is off—enable it in Settings → AI",
                )
              : bi(
                  "AI 未开启，请联系管理员启用",
                  "AI is off—contact an administrator",
                )
            : offline
              ? bi(
                  "暂未连上 Kyndryl Delivery Studio 后端服务",
                  "Kyndryl Delivery Studio backend unavailable",
                )
              : busy
                ? bi(
                    "AI 正在回复，输入下一条问题按 Enter 加入待发送队列…",
                    "AI is replying—type a follow-up and press Enter to queue…",
                  )
                : compLiveMode
                ? bi(
                    `继续讨论「${activeCompTitle}」草稿修改，可贴报错或截图…`,
                    `Continue editing "${activeCompTitle}" draft, paste errors or screenshots…`,
                  )
                : linkedMode
                  ? bi(
                      "继续这段对话，可以贴报错或截图…",
                      "Continue this thread, paste logs or screenshots…",
                    )
                  : ctx.kind
                    ? bi(
                        `问问关于 ${ctx.name} 的事…`,
                        `Ask anything about ${ctx.name}…`,
                      )
                    : bi("有什么想问的？", "What would you like to ask?")
        }
        disabled={!on || offline}
        aria-label={bi("消息", "Message")}
      />
      <div className="ap-bar">
        <ToolMenu
          t={tools}
          levels={model.current?.effort}
          compact={compactTools}
          hideThink
          thinkInMenu={hideThinkOnBar}
          attach={
            threadMode
              ? undefined
              : {
                  upload: () => fileIn.current?.click(),
                  pick: () => setPicker(true),
                }
          }
        />
        {!threadMode && !started && (
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
                <Menu.Item key="none">{bi("不关联", "Unlink")}</Menu.Item>
                <Menu.ItemGroup title={bi("关联一份交付", "Link a delivery")}>
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
              aria-label={bi("关联交付", "Link delivery")}
            >
              <IconPlus />{" "}
              {ctx.kind
                ? `${ctxWord(ctx.kind)} ${ctx.name}`
                : bi("关联交付", "Link delivery")}
            </button>
          </Dropdown>
        )}
        {(linkedMode || compLiveMode) && (
          <Tooltip
            content={bi(
              "添加截图（也可以粘贴）",
              "Attach screenshot (or paste)",
            )}
            mini
          >
            <label
              className="ap-icon"
              aria-label={bi("添加截图", "Attach screenshot")}
            >
              <IconImage />
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </Tooltip>
        )}
        <div className="ap-bar-right">
          {!hideThinkOnBar && (
            <ThinkLevel
              levels={model.current?.effort}
              value={tools.pref.think}
              onChange={(v) => tools.update({ think: v })}
              compact={compactThink}
            />
          )}
          <ModelPicker pick={model} compact={compactTools} />
          {busy ? (
            <>
              {hasDraft && uploading === 0 && (
                <Tooltip
                  content={bi(
                    "加入待发送队列（当前回复完成后自动发送 · Enter）",
                    "Add to queue (sends automatically after current reply · Enter)",
                  )}
                  mini
                >
                  <button
                    type="submit"
                    className="aq-enqueue-btn"
                    aria-label={bi("加入队列", "Queue message")}
                  >
                    <IconSend />
                    <span>{bi("入队", "Queue")}</span>
                  </button>
                </Tooltip>
              )}
              <button
                type="button"
                className="ap-send stop"
                onClick={() => stopRun(true)}
                aria-label={bi("停止生成", "Stop")}
                title={bi("停止生成", "Stop")}
              >
                <IconRecordStop />
              </button>
            </>
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
    </form>
  );

  const renderChatItem = (c: ChatRow, showFormTag = false) => (
    <div key={c.id} className={`ap-row ${c.id === chatId ? "on" : ""}`}>
      <button
        type="button"
        onClick={() =>
          c.id === chatId
            ? setSide(false)
            : keepSideScroll(() => go({ name: "ai", id: c.id }))
        }
        aria-current={c.id === chatId ? "page" : undefined}
      >
        <b>
          {showFormTag && (
            <span className="ap-kind k-form">{bi("填表", "Form")}</span>
          )}
          <span className="ap-row-txt">
            {normPlanLabel(c.title) || bi("新对话", "New chat")}
          </span>
        </b>
        {c.ctx?.name ? (
          <small className="ap-row-meta">
            <span className="ap-ctx-pill">
              {ctxWord(c.ctx.kind)} · {normPlanLabel(c.ctx.name)}
            </span>
          </small>
        ) : (
          <small className="ap-row-meta">{ago(c.updated)}</small>
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
              <IconEdit /> {bi("重命名", "Rename")}
            </Menu.Item>
            <Menu.Item key="arch">
              <IconStorage /> {bi("归档", "Archive")}
            </Menu.Item>
            <Menu.Item key="del" className="danger-item">
              <IconDelete /> {bi("删除", "Delete")}
            </Menu.Item>
          </Menu>
        }
      >
        <button
          type="button"
          className="ap-more"
          aria-label={bi(
            `${c.title} 的更多操作`,
            `More actions for ${c.title}`,
          )}
        >
          <IconMore />
        </button>
      </Dropdown>
    </div>
  );

  const suggest = useMemo(() => getSuggest(), [lang]);
  const handleListScroll = useCallback(() => {
    if (scrollCheckRafRef.current) return;
    scrollCheckRafRef.current = window.requestAnimationFrame(() => {
      scrollCheckRafRef.current = 0;
      const el = list.current;
      if (!el) return;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = dist < 36;
      if (el.scrollTop < lastScrollTopRef.current - 2 && !nearBottom) {
        userScrollLockRef.current = true;
      } else if (dist < 18) {
        userScrollLockRef.current = false;
      }
      lastScrollTopRef.current = el.scrollTop;
      const nextAtBottom = !userScrollLockRef.current && nearBottom;
      if (atBottomRef.current !== nextAtBottom) {
        atBottomRef.current = nextAtBottom;
        setAtBottom(nextAtBottom);
      }
    });
  }, []);
  const handleListWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < -2) {
      userScrollLockRef.current = true;
      const el = list.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight >= 18) {
        if (atBottomRef.current) {
          atBottomRef.current = false;
          setAtBottom(false);
        }
      }
    }
  }, []);
  return (
    <div className={`ap ${side ? "side-open" : ""}`}>
      <aside className="ap-side" aria-label={bi("对话", "Conversations")}>
        <div className="ap-side-top">
          <div className="ap-brand">
            <span className="ap-brand-spark" aria-hidden>
              <Spark size={15} />
            </span>
            <b>{bi("AI 助手", "AI Assistant")}</b>
            <Tooltip content={bi("新对话", "New chat")} mini>
              <button
                type="button"
                className="ap-new"
                onClick={() => keepSideScroll(startNewChat)}
                aria-label={bi("新对话", "New chat")}
              >
                <IconEdit />
              </button>
            </Tooltip>
          </div>
          <Input
            allowClear
            prefix={<IconSearch />}
            placeholder={bi("搜索对话、集群或组件…", "Search chats, clusters, components…")}
            value={q}
            onChange={setQ}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQ("");
                (e.target as HTMLElement).blur();
              }
            }}
            aria-label={bi("搜索对话", "Search chats")}
          />
          <div
            className="ap-tabs"
            role="tablist"
            aria-label={bi("对话分类筛选", "Filter conversations by category")}
          >
            {(
              [
                { id: "all", label: bi("全部", "All"), count: 0 },
                { id: "chat", label: bi("日常", "Chat"), count: chatTotal },
                { id: "delivery", label: bi("交付", "Jobs"), count: deliveryTotal },
                { id: "comp", label: bi("组件", "Comp"), count: compTotal },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={sideTab === t.id}
                className={`ap-tab ${sideTab === t.id ? "on" : ""}`}
                onClick={() => setSideTab(t.id)}
              >
                <span>{t.label}</span>
                {t.count > 0 && <em>{t.count}</em>}
              </button>
            ))}
          </div>
        </div>
        <div className="ap-rows" ref={sideRows}>
          {rows === null && (
            <div className="ap-skel" aria-label={bi("载入中", "Loading")} />
          )}
          {rows && !visibleAny && (
            <p className="ap-none">
              {needle
                ? bi("没有匹配的对话", "No matching conversations")
                : sideTab === "comp"
                  ? bi(
                      "还没有组件工作台对话，在组件编辑器使用 AI 后会自动汇总到这里。",
                      "No component workbench threads yet—they appear here automatically.",
                    )
                  : sideTab === "delivery"
                    ? bi(
                        "还没有交付内的排障或评审对话。",
                        "No delivery review or troubleshooting threads yet.",
                      )
                    : bi(
                        "还没有对话，从右边开始吧。",
                        "No conversations yet—start on the right.",
                      )}
            </p>
          )}

          {/* 1. Regular Assistant Conversations */}
          {showChatSec && regularChats.length > 0 && (
            <section className="ap-sec">
              <button
                type="button"
                className="ap-sec-h"
                aria-expanded={chatOpen}
                onClick={() => toggleSec("chat")}
              >
                <IconRight
                  className={`ap-sec-chev ${chatOpen ? "open" : ""}`}
                />
                <span className="ap-sec-ic">
                  <IconMessage />
                </span>
                <span>{bi("日常对话", "General Chats")}</span>
                <span className="ap-sec-cnt">{regularChats.length}</span>
              </button>
              {chatOpen &&
                groups.map(([g, items]) => (
                  <div key={g}>
                    {groups.length > 1 && (
                      <div className="ap-subh">{DAY_LABEL[g]}</div>
                    )}
                    {items.map((c) => renderChatItem(c))}
                  </div>
                ))}
            </section>
          )}

          {/* 2. Component Workbench Conversations (Active & Archived History) */}
          {showCompSec && byComp.length > 0 && (
            <section className="ap-sec">
              <button
                type="button"
                className="ap-sec-h"
                aria-expanded={compOpen}
                onClick={() => toggleSec("comp")}
              >
                <IconRight
                  className={`ap-sec-chev ${compOpen ? "open" : ""}`}
                />
                <span className="ap-sec-ic">
                  <IconCode />
                </span>
                <span>{bi("组件工作台", "Component Workbench")}</span>
                <span className="ap-sec-cnt">{compTotal}</span>
              </button>
              {compOpen &&
                byComp.map(([compName, items]) => (
                  <div key={compName} className="ap-dgroup ap-cgroup">
                    <div className="ap-dhead">
                      <span className="ap-ddot comp" aria-hidden />
                      <span className="ap-row-txt">
                        {items[0].comp_title || compName}
                      </span>
                      <span className="ap-dhead-cnt">{items.length}</span>
                    </div>
                    {items.map((s) => {
                      const cur =
                        compMode &&
                        comp === s.comp &&
                        (s.active
                          ? !compArchMode
                          : hist === s.history_id);
                      const tagCls = s.active
                        ? s.has_draft
                          ? "k-draft"
                          : "k-comp"
                        : s.rev
                          ? "k-rev"
                          : "k-hist";
                      const tagText = s.active
                        ? s.has_draft
                          ? bi("草稿", "Draft")
                          : bi("当前", "Live")
                        : s.rev
                          ? `v${s.rev}`
                          : bi("归档", "Saved");
                      const subParts = [
                        s.updated ? ago(s.updated) : "",
                        bi(`${s.messages} 条`, `${s.messages} msgs`),
                        s.accepted
                          ? bi(`采纳 ${s.accepted}`, `${s.accepted} applied`)
                          : "",
                        !s.active && s.label ? s.label : "",
                      ].filter(Boolean);
                      return (
                        <div
                          key={compSessionKey(s)}
                          className={`ap-row sub ${cur ? "on" : ""}`}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              cur
                                ? setSide(false)
                                : keepSideScroll(() =>
                                    go(
                                      s.active
                                        ? {
                                            name: "ai",
                                            comp: s.comp,
                                            key: "workbench",
                                          }
                                        : {
                                            name: "ai",
                                            comp: s.comp,
                                            hist: s.history_id,
                                          },
                                    ),
                                  )
                            }
                            aria-current={cur ? "page" : undefined}
                          >
                            <b>
                              <span className={`ap-kind ${tagCls}`}>
                                {tagText}
                              </span>
                              <span className="ap-row-txt">{s.title}</span>
                            </b>
                            <small>{subParts.join(" · ")}</small>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
            </section>
          )}

          {/* 3. Delivery Troubleshooting & Review Threads */}
          {showDeliverySec && byDelivery.length > 0 && (
            <section className="ap-sec">
              <button
                type="button"
                className="ap-sec-h"
                aria-expanded={deliveryOpen}
                onClick={() => toggleSec("delivery")}
              >
                <IconRight
                  className={`ap-sec-chev ${deliveryOpen ? "open" : ""}`}
                />
                <span className="ap-sec-ic">
                  <IconBug />
                </span>
                <span>{bi("交付排障与评审", "Delivery Threads")}</span>
                <span className="ap-sec-cnt">{deliveryTotal}</span>
              </button>
              {deliveryOpen &&
                byDelivery.map(([jid, items]) => (
                  <div key={jid} className="ap-dgroup">
                    <div className="ap-dhead">
                      <span className="ap-ddot" aria-hidden />
                      <span className="ap-row-txt">{items[0].cluster}</span>
                      <span className="ap-dhead-cnt">{items.length}</span>
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
                                      go({
                                        name: "ai",
                                        job: l.job,
                                        key: l.key,
                                      }),
                                    )
                              }
                              aria-current={cur ? "page" : undefined}
                            >
                              <b>
                                <span className={`ap-kind k-${l.kind}`}>
                                  {l.kind === "review"
                                    ? bi("评审", "Review")
                                    : bi("排障", "Fix")}
                                </span>
                                <span className="ap-row-txt">
                                  {normPlanLabel(l.title)}
                                </span>
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

          {/* 4. New Delivery Form-Wizard Helper Chats (folded cleanly by default) */}
          {showChatSec && formChats.length > 0 && (
            <section className="ap-sec">
              <button
                type="button"
                className="ap-sec-h"
                aria-expanded={formOpen}
                onClick={() => toggleSec("form")}
              >
                <IconRight
                  className={`ap-sec-chev ${formOpen ? "open" : ""}`}
                />
                <span className="ap-sec-ic">
                  <IconEdit />
                </span>
                <span>{bi("新建交付向导", "New Delivery Wizards")}</span>
                <span className="ap-sec-cnt">{formChats.length}</span>
              </button>
              {formOpen && formChats.map((c) => renderChatItem(c, true))}
            </section>
          )}

          {/* 5. Archived General Chats (folded by default) */}
          {showChatSec && archived.length > 0 && (
            <section className="ap-sec">
              <button
                type="button"
                className="ap-sec-h"
                aria-expanded={archOpen}
                onClick={() => toggleSec("arch")}
              >
                <IconRight
                  className={`ap-sec-chev ${archOpen ? "open" : ""}`}
                />
                <span className="ap-sec-ic">
                  <IconHistory />
                </span>
                <span>{bi("已归档", "Archived")}</span>
                <span className="ap-sec-cnt">{archived.length}</span>
              </button>
              {archOpen &&
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
                      <b>
                        <span className="ap-row-txt">
                          {normPlanLabel(c.title) || bi("新对话", "New chat")}
                        </span>
                      </b>
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
                            <IconStorage /> {bi("取消归档", "Unarchive")}
                          </Menu.Item>
                          <Menu.Item key="del" className="danger-item">
                            <IconDelete /> {bi("删除", "Delete")}
                          </Menu.Item>
                        </Menu>
                      }
                    >
                      <button
                        type="button"
                        className="ap-more"
                        aria-label={bi(
                          `${c.title} 的更多操作`,
                          `More actions for ${c.title}`,
                        )}
                      >
                        <IconMore />
                      </button>
                    </Dropdown>
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
            <IconSettings /> {bi("个性化", "Personalization")}
          </button>
        </div>
      </aside>

      <main
        className="ap-main"
        onDragOver={(e) => {
          if (
            !threadMode &&
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
          if (threadMode || prefsMode || !e.dataTransfer.files.length) return;
          e.preventDefault();
          setDrop(false);
          attach(e.dataTransfer.files);
        }}
      >
        {drop && (
          <div className="ap-dropzone">
            {bi("松开，把文件添加到这条消息", "Drop to attach files to this message")}
          </div>
        )}
        {prefsMode ? (
          <AIPrefs onBack={() => go({ name: "ai" })} />
        ) : (
          <>
            <header className="ap-head">
              <button
                type="button"
                className="ap-menu"
                onClick={() => setSide(!side)}
                aria-label={bi("对话列表", "Conversation list")}
              >
                <IconMenuFold />
              </button>
              <div className="ap-title">
                <b>{started || threadMode ? title : bi("新对话", "New chat")}</b>
                {ctxChip.kind && (started || threadMode) && (
                  <button
                    type="button"
                    className="ap-ctx"
                    onClick={() =>
                      ctxChip.kind === "job"
                        ? go({ name: "deliveries", id: ctxChip.id })
                        : ctxChip.kind === "form"
                          ? go({ name: "new", app: ctxChip.id, chat: chatId })
                          : compMode
                            ? openCompTarget(ctxChip.id)
                            : go({ name: "components", id: ctxChip.id })
                    }
                  >
                    <span>
                      {compMode
                        ? bi("组件工作台", "Workbench")
                        : ctxWord(ctxChip.kind)}{" "}
                      {ctxChip.name}
                    </span>
                    <IconLaunch />
                  </button>
                )}
                {linkedMode && (
                  <span className="ap-badge">
                    {isGeneral(sessionKey)
                      ? bi("对话", "Chat")
                      : bi("现场排障", "Troubleshooting")}
                  </span>
                )}
                {compMode && (
                  <span
                    className={`ap-badge ${compArchMode ? "arch" : compThread?.hasDraft ? "live" : ""}`}
                  >
                    {compArchMode
                      ? compThread?.label
                        ? bi(
                            `已归档 · ${compThread.label}`,
                            `Archived · ${compThread.label}`,
                          )
                        : bi("历史归档", "Archived")
                      : compThread?.hasDraft
                        ? bi("草稿对话中", "Active Draft")
                        : bi("工作台记录", "Workbench Log")}
                  </span>
                )}
              </div>
              {!threadMode && chat && chatId && (
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
                        <IconEdit /> {bi("重命名", "Rename")}
                      </Menu.Item>
                      <Menu.Item key="arch">
                        <IconStorage />{" "}
                        {chat.archived
                          ? bi("取消归档", "Unarchive")
                          : bi("归档", "Archive")}
                      </Menu.Item>
                      <Menu.Item key="del" className="danger-item">
                        <IconDelete /> {bi("删除", "Delete")}
                      </Menu.Item>
                    </Menu>
                  }
                >
                  <button
                    type="button"
                    className="ap-more on"
                    aria-label={bi("更多操作", "More actions")}
                  >
                    <IconMore />
                  </button>
                </Dropdown>
              )}
            </header>

            {js?.step && (
              <div className="ap-step">
                <span>{bi("正在处理", "Step")}</span>
                <b>{String(js.step.title || "")}</b>
                {js.step.phase ? <em>{String(js.step.phase)}</em> : null}
                {Array.isArray(js.step.hosts) && (
                  <code>{(js.step.hosts as string[]).join(" → ")}</code>
                )}
              </div>
            )}

            {!started && !loading && !threadMode ? (
              <div className="ap-hero">
                <div className="ap-hero-in">
                  <span className="ap-orb" aria-hidden>
                    <AIEmblem size={56} />
                  </span>
                  <h1>
                    {bi(
                      `${greeting()}，${me.username}`,
                      `${greeting()}, ${me.username}`,
                    )}
                  </h1>
                  <p>
                    {ctx.kind
                      ? bi(
                          `关于 ${ctx.name}，想了解什么？`,
                          `What would you like to know about ${ctx.name}?`,
                        )
                      : bi(
                          "我可以读你的交付、执行手册和项目文件，也会用平台里的运维技能来回答。",
                          "I can inspect your deliveries, runbooks, and project files, and apply platform ops skills to answer.",
                        )}
                  </p>
                  {!formBack && !compBack && (
                    <MessageQueueTray
                      items={queue.items}
                      busy={busy}
                      paused={queue.paused}
                      onResume={() => queue.setPaused(false)}
                      onSendNow={sendQueuedNow}
                      onEdit={queue.update}
                      onDelete={queue.remove}
                      onMove={queue.move}
                      onMoveUp={queue.moveUp}
                      onMoveDown={queue.moveDown}
                      onClear={queue.clear}
                    />
                  )}
                  {composer}
                  {error && (
                    <ChatErrorCard
                      variant="hero"
                      text={error.text}
                      diag={error.diag}
                      kind={error.kind}
                      rawError={error.rawError}
                      busy={busy}
                      onRetry={
                        error.retry !== undefined
                          ? () => send(error.retry, true)
                          : undefined
                      }
                    />
                  )}
                  <div className="ap-suggest">
                    {suggest.map((s) => (
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
                      <span>{bi("就某份交付提问", "Ask about a delivery")}</span>
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
                        ? bi(
                            "AI 助手尚未开启，可在「设置 → AI」中开启并配置模型。",
                            "AI Assistant is disabled; enable it and configure models in Settings → AI.",
                          )
                        : bi(
                            "AI 助手尚未开启，请联系管理员启用。",
                            "AI Assistant is disabled; contact an administrator to enable it.",
                          )}
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
                  onWheel={handleListWheel}
                  onScroll={handleListScroll}
                  aria-live="polite"
                  aria-busy={busy}
                >
                  <div className="ap-col">
                    {loading && (
                      <div
                        className="ad-loading"
                        aria-label={bi("载入中", "Loading")}
                      >
                        <i />
                        <i />
                        <i />
                      </div>
                    )}
                    {!loading && threadMode && messages.length === 0 && (
                      <p className="ap-none">
                        {bi(
                          "这段对话还没有内容。",
                          "No messages in this conversation yet.",
                        )}
                      </p>
                    )}
                    {messages.map((m, i) => {
                      const isLast = i === messages.length - 1;
                      const prevUser =
                        isLast && m.role === "assistant" && m.error
                          ? [...messages.slice(0, i)]
                              .reverse()
                              .find((x) => x.role === "user" && x.text?.trim())
                          : undefined;
                      return (
                        <MemoMessageItem
                          key={`${activeThreadId}-${i}`}
                          m={m}
                          jobBase={imgBase}
                          props={compMode ? compProps : props}
                          deciding={deciding}
                          decide={compArchMode ? NOOP_DECIDE : stableDecide}
                          comp={compMode}
                          busy={busy}
                          canRetry={Boolean(
                            isLast &&
                              !busy &&
                              on &&
                              canReplyThread &&
                              m.error &&
                              prevUser?.text,
                          )}
                          retryText={prevUser?.text}
                          canAnswer={Boolean(
                            isLast && !busy && on && !threadMode,
                          )}
                          onRetryText={onRetryText}
                          onAnswerText={onAnswerText}
                        />
                      );
                    })}
                    {!loading &&
                      !busy &&
                      !live &&
                      !error &&
                      messages.length > 0 &&
                      messages[messages.length - 1].role === "user" &&
                      messages[messages.length - 1].text?.trim() && (
                        <UnansweredTurnCard
                          busy={busy}
                          onRetry={
                            on && canReplyThread
                              ? () =>
                                  send(messages[messages.length - 1].text, true)
                              : undefined
                          }
                        />
                      )}
                    {live && (
                      <LiveBubble
                        live={live}
                        props={compMode ? compProps : props}
                        deciding={deciding}
                        decide={stableDecide}
                        comp={compMode}
                      />
                    )}
                    {error && (
                      <ChatErrorCard
                        text={error.text}
                        diag={error.diag}
                        kind={error.kind}
                        rawError={error.rawError}
                        busy={busy}
                        onRetry={
                          error.retry !== undefined && canReplyThread
                            ? () => send(error.retry, true)
                            : undefined
                        }
                      />
                    )}
                  </div>
                  {!atBottom && (
                    <button
                      type="button"
                      className="ap-down"
                      onClick={() => {
                        userScrollLockRef.current = false;
                        atBottomRef.current = true;
                        setAtBottom(true);
                        const reduced = window.matchMedia(
                          "(prefers-reduced-motion: reduce)",
                        ).matches;
                        list.current?.scrollTo({
                          top: list.current.scrollHeight,
                          behavior: reduced ? "auto" : "smooth",
                        });
                      }}
                      aria-label={bi("回到最新", "Jump to latest")}
                    >
                      <IconArrowDown />
                    </button>
                  )}
                </div>
                <div className="ap-foot">
                  {linkedMode &&
                    (!isGeneral(sessionKey) || messages.length >= 4) &&
                    answered &&
                    !busy && (
                      <div className="ap-solved">
                        <IconCheckCircle />
                        <span>
                          {bi(
                            "问题解决了或方案已敲定？一键整理成记录并存入知识库。",
                            "Resolved or finalized? Summarize into the execution record and save to KB.",
                          )}
                        </span>
                        <Button
                          size="small"
                          type="outline"
                          loading={resolving}
                          onClick={resolve}
                        >
                          {bi("整理记录并存入知识库", "Save record & KB")}
                        </Button>
                      </div>
                    )}
                  {!formBack && !compBack && (
                    <MessageQueueTray
                      items={queue.items}
                      busy={busy}
                      paused={queue.paused}
                      onResume={() => queue.setPaused(false)}
                      onSendNow={sendQueuedNow}
                      onEdit={queue.update}
                      onDelete={queue.remove}
                      onMove={queue.move}
                      onMoveUp={queue.moveUp}
                      onMoveDown={queue.moveDown}
                      onClear={queue.clear}
                    />
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

import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  ConfigProvider,
  Dropdown,
  Menu,
  Message,
  Modal,
  Spin,
  Tooltip,
} from "@arco-design/web-react";
import zhCN from "@arco-design/web-react/es/locale/zh-CN";
import {
  IconCheck,
  IconDesktop,
  IconMoon,
  IconNotification,
  IconLock,
  IconPoweroff,
  IconUser,
  IconSearch,
  IconSun,
  IconExclamationCircle,
} from "@arco-design/web-react/icon";
import "@arco-design/web-react/dist/css/arco.css";
import "./theme.css";
import "./app.css";
import "./wizard.css";
import "./runbook.css";
import "./store.css";
import "./platform.css";
import "./airainbow.css";
import { installAIRainbowPointer } from "./airainbow";
import "./polish.css";

installAIRainbowPointer();
import { NewDelivery } from "./Wizard";
import { NewDeliveryPicker } from "./newpicker";
import { SettingsPage } from "./settings";
import { AIPage } from "./aipage";
import { MePage } from "./me";
import { KnowledgePage } from "./kb";
import { SkillsPage } from "./skills";
import { MCPPage } from "./mcp";
import { DeliveriesPage } from "./deliveries";
import type { LoadState } from "./deliveries";
import { AppsPage } from "./apps";
import { AccountsPage } from "./accounts";
import { ComponentsPage } from "./components";
import { registerStyles } from "./glyphs";
/* After the platform is upgraded, a page opened before the upgrade asks for code files that no longer exist. That is
   not an error the person should see: load the new version once, quietly, and carry on where they were. */
const STALE =
  /dynamically imported module|Importing a module script failed|error loading dynamically|Loading chunk/i;
function reloadForNewVersion(): boolean {
  const key = "mh-reloaded-for";
  if (sessionStorage.getItem(key) === location.href) return false;
  sessionStorage.setItem(key, location.href);
  location.reload();
  return true;
}
window.addEventListener("vite:preloadError", (e) => {
  if (reloadForNewVersion()) e.preventDefault();
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lazyPage = <M extends { default: React.ComponentType<any> }>(
  load: () => Promise<M>,
) =>
  lazy(
    () =>
      load().catch((e: Error) => {
        if (STALE.test(e?.message || "") && reloadForNewVersion())
          return new Promise<M>(() => {});
        throw e;
      }) as Promise<M>,
  );
const WorkbenchPage = lazyPage(() =>
  import("./workbench").then((m) => ({ default: m.WorkbenchPage })),
);
const GuidePage = lazyPage(() =>
  import("./wbguide").then((m) => ({ default: m.GuidePage })),
);
import { LibraryPage } from "./library";
import { Login } from "./login";
import { Palette } from "./palette";
import {
  go,
  href,
  setTransitions,
  supportsTransitions,
  transitionsOn,
  useRoute,
} from "./router";
import type { Route } from "./router";
import {
  api,
  can,
  clearAuth,
  err,
  refreshAIStatus,
  resetAIStatus,
  running,
  setCsrf,
  setPerms,
  setUnauthorizedHandler,
  typing,
  useAIStatus,
  useConnectivity,
  useMedia,
} from "./shared";
import type { AIStatus, AppInfo, Job, Session } from "./shared";
import { BrandMark } from "./ui";
import { Spark } from "./aichat";

type ThemePref = "light" | "dark" | "system";
/** One broken page should not blank the whole app. */
class PageBoundary extends React.Component<
  { children: React.ReactNode; resetKey: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (STALE.test(this.state.error.message))
      return (
        <div className="detail-none enter" role="status">
          <h2>平台刚刚更新了</h2>
          <p>这个页面需要载入新版本，刷新一下就好，你正在做的内容不会丢。</p>
          <div className="row-gap">
            <Button type="primary" onClick={() => location.reload()}>
              载入新版本
            </Button>
          </div>
        </div>
      );
    return (
      <div className="detail-none enter" role="alert">
        <IconExclamationCircle style={{ fontSize: 28, color: "var(--bad)" }} />
        <h2>这个页面出错了</h2>
        <p>{this.state.error.message}</p>
        <div className="row-gap">
          <Button onClick={() => go({ name: "deliveries" })}>回到交付</Button>
          <Button type="primary" onClick={() => location.reload()}>
            重新加载
          </Button>
        </div>
      </div>
    );
  }
}
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function useTheme() {
  const [pref, setPref] = useState<ThemePref>(
    () => (localStorage.getItem("mh-theme") as ThemePref) || "system",
  );
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const dark = pref === "dark" || (pref === "system" && systemDark);
  useLayoutEffect(() => {
    for (const el of [document.documentElement, document.body]) {
      if (dark) el.setAttribute("arco-theme", "dark");
      else el.removeAttribute("arco-theme");
    }
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#111215" : "#ffffff");
  }, [dark]);
  const choose = (p: ThemePref) => {
    localStorage.setItem("mh-theme", p);
    setPref(p);
  };
  return { pref, dark, choose };
}

let navigatedInApp = false;
window.addEventListener("hashchange", () => (navigatedInApp = true));

/** One delivery per cluster, the newest: what the apps pages count and open. */
const latestPerCluster = (jobs: Job[]) =>
  jobs.filter(
    (j, i, all) =>
      all.findIndex(
        (x) => x.cluster_id === j.cluster_id && x.created > j.created,
      ) < 0 &&
      all.findIndex(
        (x) => x.cluster_id === j.cluster_id && x.created === j.created,
      ) === i,
  );

/** The top menu falls into daily work, the assistant and its resources, and administration. */
const NAV_GROUP: Partial<Record<Route["name"], number>> = {
  deliveries: 0,
  apps: 0,
  components: 0,
  library: 0,
  ai: 1,
  kb: 1,
  skills: 1,
  mcp: 1,
  accounts: 2,
  settings: 2,
};

function NavTabs({
  items,
  active,
}: {
  items: { key: Route["name"]; label: string; to: Route }[];
  active: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);
  const itemKeys = items.map((it) => it.key).join("|");
  useLayoutEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const links = [...nav.querySelectorAll<HTMLAnchorElement>("a[data-k]")];
    const measure = () => {
      const el = nav.querySelector<HTMLAnchorElement>(`a[data-k="${active}"]`);
      const next = el ? { x: el.offsetLeft, w: el.offsetWidth } : null;
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
    ro?.observe(nav);
    links.forEach((a) => ro?.observe(a));
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
  }, [active, itemKeys]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const nav = ref.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const el = nav.querySelector<HTMLAnchorElement>(`a[data-k="${active}"]`);
    if (!el) return;
    const pad = 12;
    if (el.offsetLeft - pad < nav.scrollLeft) {
      nav.scrollTo({
        left: Math.max(0, el.offsetLeft - pad),
        behavior: ready ? "smooth" : "auto",
      });
    } else if (
      el.offsetLeft + el.offsetWidth + pad >
      nav.scrollLeft + nav.clientWidth
    ) {
      nav.scrollTo({
        left: el.offsetLeft + el.offsetWidth - nav.clientWidth + pad,
        behavior: ready ? "smooth" : "auto",
      });
    }
  }, [active, ready]);

  return (
    <nav className="tabs" ref={ref} aria-label="主导航">
      {bar && (
        <span
          className={`tabs-bar${ready ? " ready" : ""}`}
          style={{
            transform: `translate3d(${bar.x}px, 0, 0)`,
            width: bar.w,
          }}
          aria-hidden
        />
      )}
      {items.map((it, i) => (
        <React.Fragment key={it.key}>
          {i > 0 && NAV_GROUP[it.key] !== NAV_GROUP[items[i - 1].key] && (
            <span className="tabs-sep" aria-hidden />
          )}
          <a
            data-k={it.key}
            href={href(it.to)}
            className={active === it.key ? "on" : ""}
            aria-current={active === it.key ? "page" : undefined}
          >
            {it.key === "ai" ? (
              <span className="ai-word">{it.label}</span>
            ) : (
              it.label
            )}
          </a>
        </React.Fragment>
      ))}
    </nav>
  );
}

export type ReleaseNote = {
  version: string;
  date: string;
  title: string;
  highlights: string[];
};

export type VersionPayload = {
  version: string;
  released_at?: string;
  notes?: ReleaseNote[];
};

const SEEN_RELEASE_KEY = "mh-seen-release";

function readSeenRelease(): string {
  try {
    return localStorage.getItem(SEEN_RELEASE_KEY) || "";
  } catch {
    return "";
  }
}

function writeSeenRelease(v: string) {
  try {
    localStorage.setItem(SEEN_RELEASE_KEY, v);
  } catch {
    /* ignore */
  }
}

/** The platform was updated while this page was open: nothing breaks, the page says so and lets the person choose when
 *  to load the new version. The service being briefly away during the update is not shown as an outage. */
function useVersionWatch() {
  const first = useRef("");
  const [current, setCurrent] = useState<VersionPayload | null>(null);
  const [freshInfo, setFreshInfo] = useState<VersionPayload | null>(null);
  const [later, setLater] = useState("");
  const [seenVersion, setSeenVersion] = useState(readSeenRelease);

  useEffect(() => {
    let live = true;
    const look = () => {
      if (document.visibilityState === "hidden") return;
      fetch("/api/version", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: VersionPayload | null) => {
          if (!live || !d?.version) return;
          if (!first.current) {
            first.current = d.version;
            setCurrent(d);
          } else if (d.version !== first.current) {
            setFreshInfo(d);
          }
        })
        .catch(() => undefined);
    };
    look();
    const t = window.setInterval(look, 20000);
    document.addEventListener("visibilitychange", look);
    window.addEventListener("online", look);
    return () => {
      live = false;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", look);
      window.removeEventListener("online", look);
    };
  }, []);

  const fresh = freshInfo?.version || "";
  const unread = Boolean(
    (fresh && seenVersion !== fresh) ||
      (current?.version && seenVersion !== current.version),
  );
  const markSeen = (v?: string) => {
    const target = v || fresh || current?.version;
    if (!target) return;
    writeSeenRelease(target);
    setSeenVersion(target);
  };
  return {
    current,
    fresh,
    freshInfo,
    hidden: later === fresh,
    hide: () => setLater(fresh),
    unread,
    markSeen,
  };
}

function UpdatePill({
  fresh,
  hidden,
  hide,
  onViewNotes,
}: {
  fresh: string;
  hidden: boolean;
  hide: () => void;
  onViewNotes: () => void;
}) {
  if (!fresh || hidden) return null;
  return (
    <div className="net-pill upd" role="status">
      <span className="sdot" />
      平台已更新到 v{fresh}。想体验新功能，刷新一下就行；你正在做的内容不受影响
      <button type="button" className="net-pill-link" onClick={onViewNotes}>
        更新公告
      </button>
      <Button size="mini" type="primary" onClick={() => location.reload()}>
        刷新
      </Button>
      <button
        type="button"
        className="net-pill-x"
        onClick={hide}
        aria-label="稍后再说"
      >
        稍后
      </button>
    </div>
  );
}

function ReleaseNotesModal({
  open,
  onClose,
  info,
  freshInfo,
}: {
  open: boolean;
  onClose: () => void;
  info: VersionPayload | null;
  freshInfo: VersionPayload | null;
}) {
  const display = freshInfo || info;
  const notes = display?.notes || [];
  const runningVer = info?.version || "";
  const freshVer = freshInfo?.version || "";
  const hasFresh = Boolean(freshVer && freshVer !== runningVer);

  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    const next: Record<string, boolean> = {};
    const expandAll = notes.length <= 2;
    notes.forEach((n, idx) => {
      next[n.version] =
        expandAll ||
        idx === 0 ||
        n.version === runningVer ||
        (Boolean(freshVer) && n.version === freshVer);
    });
    setOpenMap(next);
    setQ("");
  }, [open, display?.version, notes.length, runningVer, freshVer]);

  const query = q.trim().toLowerCase();
  const visibleNotes = useMemo(() => {
    if (!query) return notes;
    return notes.filter(
      (n) =>
        n.version.toLowerCase().includes(query) ||
        n.date.toLowerCase().includes(query) ||
        n.title.toLowerCase().includes(query) ||
        n.highlights?.some((h) => h.toLowerCase().includes(query)),
    );
  }, [notes, query]);

  const allExpanded =
    visibleNotes.length > 0 &&
    visibleNotes.every((n) => Boolean(openMap[n.version]));

  const toggleAll = () => {
    const next: Record<string, boolean> = {};
    if (allExpanded) {
      notes.forEach((n, idx) => {
        next[n.version] =
          idx === 0 ||
          n.version === runningVer ||
          (Boolean(freshVer) && n.version === freshVer);
      });
    } else {
      notes.forEach((n) => {
        next[n.version] = true;
      });
    }
    setOpenMap(next);
  };

  const toggleItem = (ver: string) =>
    setOpenMap((prev) => ({ ...prev, [ver]: !prev[ver] }));

  return (
    <Modal
      visible={open}
      onCancel={onClose}
      footer={null}
      className="rn-modal"
      style={{ width: "min(700px, calc(100vw - 32px))" }}
      unmountOnExit
    >
      <div className="rn-head">
        <div className="rn-head-title">
          <BrandMark size={28} />
          <div>
            <h2>版本与更新公告</h2>
            <div className="rn-head-sub">
              {runningVer ? (
                <>
                  当前运行 <code className="mono">v{runningVer}</code>
                  {info?.released_at ? ` · 发布于 ${info.released_at}` : ""}
                </>
              ) : (
                "平台版本信息"
              )}
            </div>
          </div>
        </div>
        {hasFresh && (
          <Button size="small" type="primary" onClick={() => location.reload()}>
            刷新升级到 v{freshVer}
          </Button>
        )}
      </div>

      {notes.length > 0 ? (
        <>
          <div className="rn-bar">
            <span className="rn-bar-count">
              发布时间轴 · 共 {notes.length} 个版本
              {query ? `（匹配 ${visibleNotes.length} 项）` : ""}
            </span>
            <div className="rn-bar-acts">
              {notes.length >= 6 && (
                <label className="rn-search">
                  <IconSearch aria-hidden />
                  <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="筛选版本或更新内容"
                    aria-label="筛选版本或更新内容"
                  />
                </label>
              )}
              {notes.length > 1 && (
                <button
                  type="button"
                  className="rn-toggle-all"
                  onClick={toggleAll}
                  aria-pressed={allExpanded}
                >
                  {allExpanded ? "仅看近期" : "全部展开"}
                </button>
              )}
            </div>
          </div>

          {visibleNotes.length > 0 ? (
            <div className="rn-tl" role="list" aria-label="版本发布时间轴">
              {visibleNotes.map((n) => {
                const isFreshNode = Boolean(freshVer && n.version === freshVer);
                const isRunningNode = n.version === runningVer;
                const isLatestNode = n.version === notes[0]?.version;
                const isHighlight = isFreshNode || isRunningNode || isLatestNode;
                const isOpen = query ? true : !!openMap[n.version];
                const count = n.highlights?.length || 0;
                return (
                  <div
                    key={n.version}
                    role="listitem"
                    className={`rn-tl-item${isHighlight ? " is-cur" : ""}${isFreshNode ? " is-fresh" : ""}${isOpen ? " is-open" : ""}`}
                  >
                    <time className="rn-tl-date mono" dateTime={n.date || undefined}>
                      {n.date || "—"}
                    </time>
                    <div className="rn-tl-rail" aria-hidden>
                      <span className="rn-tl-dot" />
                    </div>
                    <section className="rn-tl-card">
                      <button
                        type="button"
                        className="rn-tl-trig"
                        onClick={() => toggleItem(n.version)}
                        aria-expanded={isOpen}
                      >
                        <div className="rn-card-top">
                          <span className="rn-ver mono">v{n.version}</span>
                          {isFreshNode ? (
                            <span className="rn-tag is-fresh">新版本待刷新</span>
                          ) : isRunningNode ? (
                            <span className="rn-tag">当前版本</span>
                          ) : isLatestNode ? (
                            <span className="rn-tag">最新</span>
                          ) : null}
                          {n.date && (
                            <time className="rn-tl-mdate mono" dateTime={n.date}>
                              {n.date}
                            </time>
                          )}
                          <span className="rn-tl-meta">
                            {count > 0 && (
                              <span className="rn-tl-cnt">{count} 项更新</span>
                            )}
                            {count > 0 && (
                              <svg
                                className="rn-tl-chev"
                                viewBox="0 0 16 16"
                                fill="none"
                                aria-hidden
                              >
                                <path
                                  d="M4.25 6.25 8 10l3.75-3.75"
                                  stroke="currentColor"
                                  strokeWidth="1.6"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </span>
                        </div>
                        {n.title && <div className="rn-title">{n.title}</div>}
                      </button>
                      {isOpen && count > 0 && (
                        <div className="rn-tl-body">
                          <ul className="rn-items">
                            {n.highlights.map((h, hi) => (
                              <li key={hi}>{h}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </section>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted rn-empty">未找到匹配 “{q.trim()}” 的版本记录。</p>
          )}
        </>
      ) : (
        <p className="muted">
          当前运行版本 v{runningVer || "未知"}，暂无额外更新说明。
        </p>
      )}

      <div className="rn-foot">
        <span className="faint small">
          版本说明随平台服务端一起发布，平滑更新时原有任务与草稿保留。
        </span>
        <Button type="primary" onClick={onClose}>
          知道了
        </Button>
      </div>
    </Modal>
  );
}

function ConnectivityPill({ onBack }: { onBack: () => void }) {
  const status = useConnectivity();
  // an update restarts the service for a few seconds; only a longer silence is worth telling anyone about
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (status !== "unreachable") return setLong(false);
    const t = setTimeout(() => setLong(true), 8000);
    return () => clearTimeout(t);
  }, [status]);
  const prev = useRef(status);
  const [back, setBack] = useState(false);
  useEffect(() => {
    const was = prev.current;
    prev.current = status;
    if (was !== "online" && status === "online") {
      setBack(true);
      onBack();
      const t = setTimeout(() => setBack(false), 2200);
      return () => clearTimeout(t);
    }
    if (status === "unreachable") {
      // Probe soon after the network returns, then keep trying while the service stays silent.
      const ping = () => api("/api/session").catch(() => {});
      const first = setTimeout(ping, 400);
      const t = setInterval(ping, 5000);
      return () => (clearTimeout(first), clearInterval(t));
    }
  }, [status]);
  if (status === "online" && !back) return null;
  if (status === "unreachable" && !long) return null;
  return (
    <div
      className={`net-pill ${status === "online" ? "ok" : "off"}`}
      role="status"
    >
      <span className="sdot" />
      {status === "offline"
        ? "网络已断开，恢复后自动刷新"
        : status === "unreachable"
          ? "暂时连不上服务，正在重试"
          : "已恢复连接"}
    </div>
  );
}

function AIStatusBadge({
  status,
  canManage,
}: {
  status: AIStatus;
  canManage: boolean;
}) {
  const on = status.enabled;
  const pendingCfg = !!status.master_enabled && !status.configured;
  const stateCls = on ? "is-on" : pendingCfg ? "is-warn" : "is-off";
  const statusWord = on ? "已启用" : pendingCfg ? "待配置" : "未启用";
  const shortSub = on ? "" : pendingCfg ? " · 待配" : " · 未启";
  const readonlyTip = on
    ? "平台 AI 套件已启用（当前账户只读，由管理员在平台设置中维护）"
    : pendingCfg
      ? "平台 AI 套件待管理员完成模型配置（只读）"
      : "平台 AI 套件未启用（当前账户只读，需管理员在平台设置中开启）";
  const content = (
    <>
      <span className="ai-quick-ic" aria-hidden>
        <Spark size={13} rainbow={on} />
      </span>
      <span className="ai-quick-label">
        AI
        {shortSub && <span className="ai-quick-label-sub">{shortSub}</span>}
      </span>
      <span className="ai-quick-dot" aria-hidden />
    </>
  );
  if (!canManage) {
    return (
      <Tooltip mini position="bottom" content={readonlyTip}>
        <span
          className={`ai-quick-toggle is-readonly ${stateCls}`}
          role="status"
          aria-label={`AI 套件${statusWord}（只读）`}
        >
          {content}
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip
      mini
      position="bottom"
      content={`平台 AI 套件${statusWord} · 点击前往设置`}
    >
      <button
        type="button"
        className={`ai-quick-toggle is-interactive ${stateCls}`}
        onClick={() => go({ name: "settings", id: "ai" })}
        aria-label={`AI 套件${statusWord}，前往平台设置管理`}
      >
        {content}
      </button>
    </Tooltip>
  );
}

function App() {
  const aiStatus = useAIStatus();
  const aiOn = aiStatus.enabled;
  const [user, setUserRaw] = useState<Session | null>(null);
  const setUser = useCallback(
    (u: Session | null | ((x: Session | null) => Session | null)) => {
      setUserRaw((cur) => {
        const next = typeof u === "function" ? u(cur) : u;
        setPerms(
          next?.perms,
          next?.username,
          (next?.teams || []).map((id, i) => ({
            id,
            name: next?.team_names?.[i] || id,
          })),
        );
        return next;
      });
    },
    [],
  );
  // permissions can change while someone works; look again when they come back to the tab
  useEffect(() => {
    const look = () => {
      if (document.visibilityState !== "visible") return;
      api<Session>("/api/session")
        .then((s) =>
          setUser((u) =>
            u && JSON.stringify(u.perms) !== JSON.stringify(s.perms) ? s : u,
          ),
        )
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", look);
    return () => document.removeEventListener("visibilitychange", look);
  }, [setUser]);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState("");
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [appsLoad, setAppsLoad] = useState<LoadState>("loading");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoad, setJobsLoad] = useState<LoadState>("loading");
  const [palette, setPalette] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [vtOn, setVtOn] = useState(transitionsOn);
  const verWatch = useVersionWatch();
  const route = useRoute();
  const theme = useTheme();
  const openChangelog = () => {
    verWatch.markSeen();
    setChangelogOpen(true);
  };
  useEffect(() => {
    if (user) {
      void refreshAIStatus();
    } else {
      resetAIStatus();
    }
  }, [user]);

  const boot = () => {
    setBooting(true);
    setBootError("");
    api<Session>("/api/session")
      .then((s) => {
        setCsrf(s.csrf);
        setUser(s);
      })
      .catch((e) => {
        if (e.status !== 401) setBootError(e.message);
      })
      .finally(() => setBooting(false));
  };
  useEffect(boot, []);
  useEffect(() => {
    if (!user) return;
    let busy = false;
    const ping = () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      api("/api/session/heartbeat", {
        method: "POST",
        body: JSON.stringify({ active: true }),
      })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    const timer = window.setInterval(ping, 60_000);
    const onVis = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [user?.session_id, user?.username]);
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser((u) => {
        if (u) Message.info("登录已过期，请重新登录");
        return null;
      });
    });
  }, []);

  const loadApps = useCallback(async () => {
    try {
      const list = await api<AppInfo[]>("/api/catalog");
      registerStyles(list);
      setApps(list);
      setAppsLoad("ready");
    } catch {
      setAppsLoad((s) => (s === "ready" ? s : "error"));
    }
  }, []);
  const loadJobs = useCallback(async () => {
    try {
      setJobs(await api<Job[]>("/api/jobs"));
      setJobsLoad("ready");
    } catch {
      setJobsLoad((s) => (s === "ready" ? s : "error"));
    }
  }, []);
  useEffect(() => {
    if (!user) return;
    setJobsLoad("loading");
    setAppsLoad("loading");
    loadApps();
    loadJobs();
  }, [user]);
  // something that changes the components (a version's status) asks for the list again
  useEffect(() => {
    const on = () => loadApps();
    window.addEventListener("mh-apps-changed", on);
    return () => window.removeEventListener("mh-apps-changed", on);
  }, [loadApps]);

  // Keep the list fresh while something is generating, and when the tab regains focus.
  const anyRunning = jobs.some((j) => running(j.state));
  useEffect(() => {
    if (!user || !anyRunning) return;
    const t = setInterval(loadJobs, 2500);
    return () => clearInterval(t);
  }, [user, anyRunning]);
  // Deliveries can be created from another tab or machine: refresh on entering the page and every 30 s while visible.
  useEffect(() => {
    if (
      user &&
      (route.name === "deliveries" ||
        route.name === "apps")
    )
      loadJobs();
  }, [user, route.name]);
  useEffect(() => {
    if (!user) return;
    const t = setInterval(
      () => document.visibilityState === "visible" && loadJobs(),
      30000,
    );
    return () => clearInterval(t);
  }, [user]);
  useEffect(() => {
    if (!user) return;
    const f = () => document.visibilityState === "visible" && loadJobs();
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, [user]);

  const canCreateDelivery = can("delivery.create");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey || palette) return;
      if (
        e.key === "n" &&
        route.name !== "new" &&
        canCreateDelivery &&
        !document.querySelector(".arco-modal-wrapper,.arco-drawer-wrapper")
      ) {
        e.preventDefault();
        go({ name: "new" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route.name, canCreateDelivery, palette]);

  useEffect(() => {
    const titles: Record<Route["name"], string> = {
      deliveries: "交付",
      settings: "平台设置",
      ai: "AI 助手",
      new: "新建集群",
      apps: "应用",
      components: "组件",
      library: "软件库",
      accounts: "IAM",
      me: "我的账户",
      kb: "知识库",
      skills: "技能",
      mcp: "MCP 服务",
    };
    document.title = `${titles[route.name]} · Middleware Hub`;
  }, [route.name]);

  const logout = async () => {
    try {
      await api("/api/logout", { method: "POST" });
    } catch {
      /* the session is dropped locally either way */
    }
    clearAuth();
    resetAIStatus();
    setUser(null);
    setJobs([]);
  };

  if (booting)
    return (
      <div className="center-fill full">
        <Spin size={28} />
      </div>
    );
  if (bootError)
    return (
      <div className="center-fill full boot-error">
        <IconExclamationCircle />
        <h2>无法连接到服务</h2>
        <p>{bootError}</p>
        <Button type="primary" onClick={boot}>
          重试
        </Button>
        <ConnectivityPill onBack={boot} />
      </div>
    );
  if (!user)
    return (
      <Login
        done={setUser}
        versionInfo={verWatch.current}
        theme={{ dark: theme.dark, pref: theme.pref, choose: theme.choose }}
      />
    );

  const tabs: { key: Route["name"]; label: string; to: Route }[] = [
    ...(can("delivery.view|delivery.create")
      ? [
          {
            key: "deliveries" as const,
            label: "交付",
            to: { name: "deliveries" } as Route,
          },
        ]
      : []),
    { key: "apps", label: "应用", to: { name: "apps" } },
    { key: "components", label: "组件", to: { name: "components" } },
    { key: "library", label: "软件库", to: { name: "library" } },
    ...(aiOn && !!aiStatus.features?.assistant && can("ai.use")
      ? [{ key: "ai" as const, label: "AI", to: { name: "ai" } as Route }]
      : []),
    ...(aiOn && can("ai.use")
      ? [{ key: "kb" as const, label: "知识库", to: { name: "kb" } as Route }]
      : []),
    ...(aiOn && can("ai.use")
      ? [
          {
            key: "skills" as const,
            label: "技能",
            to: { name: "skills" } as Route,
          },
        ]
      : []),
    ...(aiOn && can("ai.use")
      ? [{ key: "mcp" as const, label: "MCP", to: { name: "mcp" } as Route }]
      : []),
    ...(can("iam.user|iam.role|iam.team|audit.view")
      ? [
          {
            key: "accounts" as const,
            label: "IAM",
            to: { name: "accounts" } as Route,
          },
        ]
      : []),
    ...(can(
      "settings.notify|ai.settings|ai.usage|settings.report|settings.storage|settings.sandbox|execution.manage",
    )
      ? [
          {
            key: "settings" as const,
            label: "设置",
            to: { name: "settings" } as Route,
          },
        ]
      : []),
  ];
  const activeTab = route.name === "new" ? "deliveries" : route.name;

  const aiRouteBlocked =
    !aiOn &&
    (route.name === "ai" ||
      route.name === "kb" ||
      route.name === "skills" ||
      route.name === "mcp");

  let page: React.ReactNode;
  if (route.name === "deliveries" || aiRouteBlocked)
    page = (
      <DeliveriesPage
        jobs={jobs}
        load={jobsLoad}
        reload={loadJobs}
        selected={route.name === "deliveries" ? route.id : undefined}
        tab={route.name === "deliveries" ? route.tab : undefined}
        plan={route.name === "deliveries" ? route.plan : undefined}
        rehearsal={route.name === "deliveries" ? route.rehearsal : undefined}
        doc={route.name === "deliveries" ? route.doc : undefined}
        source={route.name === "deliveries" ? route.source : undefined}
        section={route.name === "deliveries" ? route.section : undefined}
        apps={apps}
      />
    );
  else if (route.name === "apps")
    page = (
      <AppsPage
        apps={apps}
        load={appsLoad}
        reload={loadApps}
        selected={route.id}
        jobs={latestPerCluster(jobs)}
      />
    );
  else if (route.name === "components" && route.id === "guide")
    page = (
      <Suspense fallback={null}>
        <GuidePage me={user} />
      </Suspense>
    );
  else if (route.name === "components" && route.id && route.edit !== undefined)
    page = (
      <Suspense fallback={null}>
        <WorkbenchPage
          key={route.id}
          me={user}
          name={route.id}
          tab={route.edit}
        />
      </Suspense>
    );
  else if (route.name === "components")
    page = <ComponentsPage me={user} selected={route.id} />;
  else if (route.name === "library")
    page = <LibraryPage me={user} selected={route.id} />;
  else if (route.name === "accounts")
    page = <AccountsPage me={user} selected={route.id} />;
  else if (route.name === "me") page = <MePage me={user} section={route.id} />;
  else if (route.name === "kb") page = <KnowledgePage selected={route.id} />;
  else if (route.name === "skills") page = <SkillsPage selected={route.id} />;
  else if (route.name === "mcp") page = <MCPPage selected={route.id} />;
  else if (route.name === "settings")
    page = <SettingsPage me={user} selected={route.id} />;
  else if (route.name === "ai")
    page = (
      <AIPage
        me={user}
        chatId={route.id}
        job={route.job}
        sessionKey={route.key}
        comp={route.comp}
        jobs={jobs}
      />
    );
  else {
    const app = route.app ? apps.find((a) => a.id === route.app) : undefined;
    const leave = () => {
      if (route.revise) {
        const revJob = jobs.find((j) => j.id === route.revise);
        if (revJob) go({ name: "deliveries", id: revJob.cluster_id, tab: "plans", plan: revJob.id });
        else go({ name: "deliveries" });
      } else if (route.from) go({ name: "deliveries", id: route.from });
      else if (navigatedInApp) history.back();
      else go({ name: "deliveries" });
    };
    page = !can("delivery.create") ? (
      <div className="detail-none enter">
        <h2>你没有新建集群的权限</h2>
        <p>需要的话，请联系能管理用户的人给你相应的角色。</p>
        <Button onClick={() => go({ name: "apps" })}>查看应用</Button>
      </div>
    ) : !route.app ? (
      <NewDeliveryPicker
        apps={apps}
        loading={appsLoad === "loading"}
        jobs={jobs}
        back={leave}
      />
    ) : appsLoad === "loading" && !app ? (
      <div className="center-fill">
        <Spin />
      </div>
    ) : !app || !app.available ? (
      <div className="detail-none enter">
        <h2>{app ? `${app.name} 暂时不能生成交付` : "找不到这个应用"}</h2>
        <p>{app?.reason || "应用目录中没有这一项。"}</p>
        <div className="row-gap">
          <Button type="primary" onClick={() => go({ name: "new" })}>
            选择其他组件
          </Button>
          <Button onClick={() => go({ name: "apps" })}>查看应用</Button>
        </div>
      </div>
    ) : (
        <NewDelivery
          key={`${app.id}-${route.from || ""}-${route.revise || ""}-${route.plan || ""}-${route.chat || ""}`}
          app={app}
          from={route.from}
          revise={route.revise}
          preset={route.plan}
          chat={route.chat}
          jobs={jobs}
          jobsLoading={jobsLoad === "loading"}
          back={leave}
          created={(j) => {
            loadJobs();
            go(
              {
                name: "deliveries",
                id: j.cluster_id,
                tab: "plans",
                plan: j.id,
              },
              { replace: true },
            );
          }}
        />
      );
  }

  const ThemeIcon =
    theme.pref === "system" ? IconDesktop : theme.dark ? IconMoon : IconSun;
  return (
    <div className={`shell route-${route.name}`}>
      <a className="skip" href="#main">
        跳到主要内容
      </a>
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Middleware Hub 首页">
          <BrandMark />
          <span>Middleware Hub</span>
        </a>
        <NavTabs items={tabs} active={activeTab} />
        <div className="top-right">
          <AIStatusBadge status={aiStatus} canManage={can("ai.settings")} />
          <button
            type="button"
            className="search-trigger"
            onClick={() => setPalette(true)}
            aria-label="搜索与跳转"
            aria-haspopup="dialog"
            aria-expanded={palette}
            aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
          >
            <IconSearch className="search-trigger-ic" />
            <span className="search-trigger-txt">搜索或跳转</span>
            <span className="search-trigger-keys" aria-hidden>
              <kbd>{isMac ? "⌘" : "Ctrl"}</kbd>
              <kbd>K</kbd>
            </span>
          </button>
          {verWatch.current?.version && (
            <Tooltip
              position="bottom"
              content={
                verWatch.unread
                  ? `当前版本 v${verWatch.current.version} · 有新版本更新公告`
                  : `查看版本 v${verWatch.current.version} 与更新公告`
              }
              mini
            >
              <button
                type="button"
                className={`ver-pill${verWatch.unread ? " is-new" : ""}`}
                onClick={openChangelog}
                aria-label={`平台版本 v${verWatch.current.version}，点击查看更新公告`}
              >
                <span className="mono">v{verWatch.current.version}</span>
                {verWatch.unread && (
                  <span className="ver-pill-dot" aria-hidden />
                )}
              </button>
            </Tooltip>
          )}
          <Dropdown
            trigger="click"
            position="br"
            droplist={
              <Menu
                onClickMenuItem={(k) => {
                  if (k === "vt") (setTransitions(!vtOn), setVtOn(!vtOn));
                  else theme.choose(k as ThemePref);
                }}
                selectedKeys={[theme.pref]}
              >
                {(
                  [
                    ["light", "浅色外观", IconSun],
                    ["dark", "深色外观", IconMoon],
                    ["system", "跟随系统", IconDesktop],
                  ] as const
                ).map(([k, l, I]) => (
                  <Menu.Item key={k}>
                    <span className="menu-row">
                      <I />
                      <span>{l}</span>
                      {theme.pref === k && <IconCheck className="menu-check" />}
                    </span>
                  </Menu.Item>
                ))}
                {supportsTransitions() && (
                  <>
                    <div className="menu-sep" role="separator" />
                    <Menu.Item key="vt">
                      <span className="menu-row">
                        <span>页面转场动画</span>
                        {vtOn && <IconCheck className="menu-check" />}
                      </span>
                    </Menu.Item>
                  </>
                )}
              </Menu>
            }
          >
            <button
              type="button"
              className="icon-btn"
              aria-label="切换外观"
              title="外观设置"
            >
              <ThemeIcon />
            </button>
          </Dropdown>
          <Dropdown
            trigger="click"
            position="br"
            droplist={
              <Menu
                onClickMenuItem={(k) =>
                  k === "out"
                    ? logout()
                    : k === "me"
                      ? go({ name: "me" })
                      : k === "pw"
                        ? go({ name: "me", id: "security" })
                        : k === "changelog"
                          ? openChangelog()
                          : undefined
                }
              >
                <div className="menu-me">
                  <b>{user.username}</b>
                  <span>
                    {user.role_names?.join("、") ||
                      (user.role === "admin" ? "管理员" : "交付使用者")}
                  </span>
                </div>
                <Menu.Item key="me">
                  <span className="menu-row">
                    <IconUser />
                    <span>我的账户</span>
                  </span>
                </Menu.Item>
                <Menu.Item key="pw">
                  <span className="menu-row">
                    <IconLock />
                    <span>修改密码</span>
                  </span>
                </Menu.Item>
                <Menu.Item key="changelog">
                  <span className="menu-row">
                    <IconNotification />
                    <span>版本与更新公告</span>
                    {verWatch.current?.version && (
                      <span className="menu-ver mono">
                        v{verWatch.current.version}
                      </span>
                    )}
                    {verWatch.unread && (
                      <span className="menu-unread-dot" aria-hidden />
                    )}
                  </span>
                </Menu.Item>
                <div className="menu-sep" role="separator" />
                <Menu.Item key="out" className="danger-item">
                  <span className="menu-row">
                    <IconPoweroff />
                    <span>退出登录</span>
                  </span>
                </Menu.Item>
              </Menu>
            }
          >
            <button
              type="button"
              className={`me${route.name === "me" ? " on" : ""}`}
              aria-label={`账户 ${user.username}`}
            >
              <span className={`avatar ${user.role}`}>
                {user.username.slice(0, 1).toUpperCase()}
              </span>
            </button>
          </Dropdown>
        </div>
      </header>
      <main id="main" className="main" key={route.name}>
        <PageBoundary resetKey={href(route)}>{page}</PageBoundary>
      </main>
      <ConnectivityPill
        onBack={() => {
          loadJobs();
          loadApps();
        }}
      />
      <UpdatePill
        fresh={verWatch.fresh}
        hidden={verWatch.hidden}
        hide={verWatch.hide}
        onViewNotes={openChangelog}
      />
      <ReleaseNotesModal
        open={changelogOpen}
        onClose={() => setChangelogOpen(false)}
        info={verWatch.current}
        freshInfo={verWatch.freshInfo}
      />
      <Palette
        open={palette}
        close={() => setPalette(false)}
        jobs={jobs}
        apps={apps}
        loading={jobsLoad === "loading" || appsLoad === "loading"}
        admin={can("settings.notify|ai.settings")}
        dark={theme.dark}
        actions={{
          nav: (to) => go({ name: to } as Route),
          create: (app) => go({ name: "new", app }),
          open: (id) => go({ name: "deliveries", id }),
          openApp: (id) => go({ name: "apps", id }),
          theme: () => theme.choose(theme.dark ? "light" : "dark"),
          logout,
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ConfigProvider
    locale={zhCN}
    componentConfig={{ Button: { size: "default" } }}
  >
    <App />
  </ConfigProvider>,
);

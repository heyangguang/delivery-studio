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
import enUS from "@arco-design/web-react/es/locale/en-US";
import { I18nProvider, bi, getLang, useI18n, useLang } from "./i18n";
import {
  IconCheck,
  IconClose,
  IconDesktop,
  IconDown,
  IconMoon,
  IconLock,
  IconPoweroff,
  IconRefresh,
  IconUser,
  IconSearch,
  IconSun,
  IconExclamationCircle,
} from "@arco-design/web-react/icon";
import "@arco-design/web-react/dist/css/arco.css";
import "katex/dist/katex.min.css";
import "../design/theme.css";
import "../design/app.css";
import "../modules/catalog/wizard.css";
import "../modules/projects/runbook.css";
import "../modules/catalog/store.css";
import "../design/platform.css";
import "../design/airainbow.css";
import { installAIRainbowPointer } from "../design/airainbow";
import "../design/polish.css";
/* Keep all component/route stylesheets in a single deterministic bundle so lazy-loaded JS chunks
   never suffer FOUC, cascade inversion, or missing cross-view styles (e.g. .cl-imp-* in clusters). */
import "../modules/projects/platformparams.css";
import "../modules/ai/aichat.css";
import "../modules/ai/aipage.css";
import "../modules/catalog/formchat.css";
import "../modules/catalog/formwork.css";
import "../modules/catalog/newpicker.css";
import "../modules/projects/importcluster.css";
import "../modules/settings/settings.css";
import "../modules/settings/setnotify.css";
import "../modules/ai/aiwork.css";
import "../modules/ai/aitools.css";
import "../modules/ai/aisettings.css";
import "../design/charts.css";
import "../modules/ai/aiusage.css";
import "../modules/ai/aiext.css";
import "../modules/ai/aiprefs.css";
import "../modules/ai/aiprices.css";
import "../modules/settings/storageview.css";
import "../modules/settings/sandboxview.css";
import "../modules/automation/executions.css";
import "../modules/automation/rehearsal-automation.css";
import "../modules/security/secreport.css";
import "../modules/ai/aiqueue.css";
import "../modules/iam/me.css";
import "../modules/library/respage.css";
import "../modules/ai/kb.css";
import "../modules/ai/myfiles.css";
import "../modules/ai/studio.css";
import "../modules/projects/lineage.css";
import "../modules/projects/stephotfix.css";
import "../modules/projects/docs.css";
import "../modules/projects/clusterconfig.css";
import "../modules/security/security.css";
import "../modules/security/vextriage.css";
import "../modules/security/clustersecurity.css";
import "../modules/rehearsal/rehearsal_rollout.css";
import "../modules/rehearsal/rehearsal.css";
import "../modules/projects/clusters.css";
import "../modules/automation/monitor.css";
import "../modules/iam/iam.css";
import "../modules/catalog/workbench.css";
import "../modules/library/libruntime.css";
import "../shared/login.css";

installAIRainbowPointer();
import { DeliveriesPage } from "../modules/projects/deliveries";
import type { LoadState } from "../modules/projects/deliveries";
import type { MonitorListPayload } from "../modules/automation/monitor";
import type { StudioTab } from "../modules/ai/studio";
import { AppsPage } from "../modules/catalog/apps";
import { registerStyles } from "../design/glyphs";
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
function lazyPage<C extends React.ComponentType<any>>(
  load: () => Promise<{ default: C }>,
) {
  let pending: Promise<{ default: C }> | null = null;
  const loadOnce = (): Promise<{ default: C }> => {
    if (!pending) {
      pending = load().catch((e: Error) => {
        pending = null;
        if (STALE.test(e?.message || "") && reloadForNewVersion())
          return new Promise<{ default: C }>(() => {});
        throw e;
      });
    }
    return pending;
  };
  return Object.assign(lazy(loadOnce), {
    preload: () => {
      void loadOnce().catch(() => undefined);
    },
  });
}
const NewDelivery = lazyPage(() =>
  import("../modules/catalog/Wizard").then((m) => ({ default: m.NewDelivery })),
);
const NewDeliveryPicker = lazyPage(() =>
  import("../modules/catalog/newpicker").then((m) => ({ default: m.NewDeliveryPicker })),
);
const ImportClusterPage = lazyPage(() =>
  import("../modules/projects/importcluster").then((m) => ({ default: m.ImportClusterPage })),
);
const SettingsPage = lazyPage(() =>
  import("../modules/settings/settings").then((m) => ({ default: m.SettingsPage })),
);
const AIPage = lazyPage(() =>
  import("../modules/ai/aipage").then((m) => ({ default: m.AIPage })),
);
const MePage = lazyPage(() =>
  import("../modules/iam/me").then((m) => ({ default: m.MePage })),
);
const StudioPage = lazyPage(() =>
  import("../modules/ai/studio").then((m) => ({ default: m.StudioPage })),
);
const ExecutionMonitorPage = lazyPage(() =>
  import("../modules/automation/monitor").then((m) => ({ default: m.ExecutionMonitorPage })),
);
const AccountsPage = lazyPage(() =>
  import("../modules/iam/accounts").then((m) => ({ default: m.AccountsPage })),
);
const ComponentsPage = lazyPage(() =>
  import("../modules/catalog/components").then((m) => ({ default: m.ComponentsPage })),
);
const LibraryPage = lazyPage(() =>
  import("../modules/library/library").then((m) => ({ default: m.LibraryPage })),
);
const SecurityPage = lazyPage(() =>
  import("../modules/security/security").then((m) => ({ default: m.SecurityPage })),
);
const WorkbenchPage = lazyPage(() =>
  import("../modules/catalog/workbench").then((m) => ({ default: m.WorkbenchPage })),
);
const GuidePage = lazyPage(() =>
  import("../modules/catalog/wbguide").then((m) => ({ default: m.GuidePage })),
);

const STUDIO_TAB_KEY = "mh-studio-tab";
function isStudioRoute(name: string): name is StudioTab {
  return name === "kb" || name === "skills" || name === "mcp";
}
function enabledStudioTabs(features?: AIStatus["features"]): StudioTab[] {
  const out: StudioTab[] = [];
  if (features?.kb) out.push("kb");
  if (features?.skills) out.push("skills");
  if (features?.mcp) out.push("mcp");
  return out;
}
function preferredStudioTab(features?: AIStatus["features"]): StudioTab {
  const list = enabledStudioTabs(features);
  try {
    const saved = sessionStorage.getItem(STUDIO_TAB_KEY) as StudioTab | null;
    if (saved && list.includes(saved)) return saved;
  } catch {
    /* ignore */
  }
  return list[0] || "kb";
}
function preloadRouteChunk(key: string) {
  switch (key) {
    case "executions":
      ExecutionMonitorPage.preload();
      break;
    case "components":
      ComponentsPage.preload();
      break;
    case "library":
      LibraryPage.preload();
      break;
    case "security":
      SecurityPage.preload();
      break;
    case "ai":
      AIPage.preload();
      break;
    case "studio":
    case "kb":
    case "skills":
    case "mcp":
      StudioPage.preload();
      break;
    case "accounts":
      AccountsPage.preload();
      break;
    case "settings":
      SettingsPage.preload();
      break;
    case "me":
      MePage.preload();
      break;
    case "new":
      NewDeliveryPicker.preload();
      NewDelivery.preload();
      break;
    case "import":
      ImportClusterPage.preload();
      break;
  }
}
import { Login } from "../shared/login";
import { Palette } from "../shared/palette";
import {
  go,
  href,
  useRoute,
} from "./router";
import type { Route } from "./router";
import {
  api,
  cached,
  can,
  clearAuth,
  copy,
  err,
  fetchCached,
  hasReleasedVersion,
  refreshAIStatus,
  resetAIStatus,
  running,
  setCsrf,
  setPerms,
  setUnauthorizedHandler,
  typing,
  useAIStatus,
  useConnectivity,
  useDelayed,
  useMedia,
} from "../shared/shared";
import type { AIStatus, AppInfo, Job, Session } from "../shared/shared";
import { BrandMark } from "../design/ui";
import { AIDock, Spark } from "../modules/ai/aichat";
import type { AITarget } from "../modules/ai/aichat";

type ThemePref = "light" | "dark" | "system";
/** One broken page should not blank the whole app. */
class PageBoundary extends React.Component<
  { children: React.ReactNode; resetKey: string },
  { error: Error | null; componentStack: string }
> {
  state = { error: null as Error | null, componentStack: "" };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const cs = (info?.componentStack || "").trim();
    if (cs) this.setState({ componentStack: cs });
    console.error("[PageBoundary]", error, cs);
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: null, componentStack: "" });
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (STALE.test(this.state.error.message))
      return (
        <div className="detail-none enter" role="status">
          <h2>{bi("平台刚刚更新了", "Platform Just Updated")}</h2>
          <p>
            {bi(
              "这个页面需要载入新版本，刷新一下就好，你正在做的内容不会丢。",
              "This page needs to load the updated build. Refresh to continue without losing your work.",
            )}
          </p>
          <div className="row-gap">
            <Button type="primary" onClick={() => location.reload()}>
              {bi("载入新版本", "Load New Version")}
            </Button>
          </div>
        </div>
      );
    const diagText = [
      `URL: ${location.href}`,
      `Error: ${this.state.error.message}`,
      this.state.error.stack ? `\nStack:\n${this.state.error.stack}` : "",
      this.state.componentStack
        ? `\nComponent Stack:\n${this.state.componentStack}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return (
      <div className="detail-none enter" role="alert">
        <IconExclamationCircle style={{ fontSize: 28, color: "var(--bad)" }} />
        <h2>{bi("这个页面出错了", "Something Went Wrong")}</h2>
        <p>{this.state.error.message}</p>
        <div className="row-gap">
          <Button onClick={() => go({ name: "deliveries" })}>
            {bi("回到集群", "Back to Clusters")}
          </Button>
          <Button
            onClick={() => {
              copy(diagText);
              Message.success(bi("已复制错误诊断信息", "Copied diagnostic info"));
            }}
          >
            {bi("复制诊断信息", "Copy Diagnostics")}
          </Button>
          <Button type="primary" onClick={() => location.reload()}>
            {bi("重新加载", "Reload")}
          </Button>
        </div>
        {(this.state.error.stack || this.state.componentStack) && (
          <details
            style={{
              marginTop: 14,
              maxWidth: 680,
              width: "100%",
              textAlign: "left",
              fontSize: 12,
              color: "var(--mute)",
            }}
          >
            <summary style={{ cursor: "pointer", userSelect: "none" }}>
              {bi("查看错误堆栈详情", "Show technical stack trace")}
            </summary>
            <pre
              style={{
                marginTop: 8,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--line)",
                background: "var(--surface-2)",
                color: "var(--ink-2)",
                fontFamily: "var(--mono)",
                fontSize: 11,
                lineHeight: 1.5,
                maxHeight: 220,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {diagText}
            </pre>
          </details>
        )}
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
      if (dark) {
        el.setAttribute("arco-theme", "dark");
        el.setAttribute("data-theme", "dark");
      } else {
        el.removeAttribute("arco-theme");
        el.removeAttribute("data-theme");
      }
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

/** The top menu falls into daily work, the assistant and its studio, and administration. */
type NavTabKey = Route["name"] | "studio";
const NAV_GROUP: Partial<Record<NavTabKey, number>> = {
  deliveries: 0,
  executions: 0,
  apps: 0,
  components: 0,
  library: 0,
  security: 0,
  ai: 1,
  studio: 1,
  accounts: 2,
  settings: 2,
};

function NavTabs({
  items,
  active,
}: {
  items: { key: NavTabKey; label: string; to: Route; badge?: number }[];
  active: NavTabKey;
}) {
  const lang = useLang();
  const ref = useRef<HTMLElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);
  const [moreOpen, setMoreOpen] = useState(false);
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);
  const itemSig = items
    .map((it) => `${it.key}:${it.label}:${it.badge || 0}`)
    .join("|");

  // Priority+ responsive calculation: pack only complete tabs that fit inside the bar; fold overflow cleanly into "More ▾".
  useLayoutEffect(() => {
    const nav = ref.current;
    const mirror = mirrorRef.current;
    if (!nav || !mirror) return;
    const compute = () => {
      const avail = nav.clientWidth;
      if (avail <= 0) return;
      const itemNodes = [...mirror.querySelectorAll<HTMLElement>("[data-mk]")];
      if (itemNodes.length !== items.length) {
        setVisibleCount(items.length);
        return;
      }
      const sepNode = mirror.querySelector<HTMLElement>(".tabs-sep");
      const sepW = sepNode ? sepNode.offsetWidth + 12 : 13; // 1px + 6px*2 margin
      const gap = 2;
      const widths = itemNodes.map((n) => Math.ceil(n.getBoundingClientRect().width));
      const moreBaseNode = mirror.querySelector<HTMLElement>("[data-more-base]");
      const moreBaseW = moreBaseNode
        ? Math.ceil(moreBaseNode.getBoundingClientRect().width)
        : 64;
      const moreActiveNode = mirror.querySelector<HTMLElement>("[data-more-active]");
      const moreActiveW = moreActiveNode
        ? Math.ceil(moreActiveNode.getBoundingClientRect().width)
        : moreBaseW;

      const widthOfPrefix = (k: number) => {
        let total = 0;
        for (let i = 0; i < k; i++) {
          if (i > 0) {
            total += gap;
            if (NAV_GROUP[items[i].key] !== NAV_GROUP[items[i - 1].key]) {
              total += sepW + gap;
            }
          }
          total += widths[i];
        }
        return total;
      };

      const totalAll = widthOfPrefix(items.length);
      if (totalAll <= avail - 2) {
        setVisibleCount((prev) => (prev === items.length ? prev : items.length));
        return;
      }

      const fitCount = (reserve: number) => {
        const budget = Math.max(0, avail - reserve - 2);
        let k = 0;
        let used = 0;
        for (let i = 0; i < items.length; i++) {
          let add = widths[i];
          if (i > 0) {
            add += gap;
            if (NAV_GROUP[items[i].key] !== NAV_GROUP[items[i - 1].key]) {
              add += sepW + gap;
            }
          }
          if (used + add <= budget) {
            used += add;
            k = i + 1;
          } else {
            break;
          }
        }
        return k;
      };

      const activeIdx = items.findIndex((x) => x.key === active);
      let k = fitCount(moreBaseW + gap);
      if (activeIdx >= k) {
        k = fitCount(Math.max(moreBaseW, moreActiveW) + gap);
      }
      // Always keep at least 1 tab visible unless container is extremely tiny
      if (k === 0 && items.length > 0 && widths[0] + moreBaseW + 8 <= avail) {
        k = 1;
      }
      setVisibleCount((prev) => (prev === k ? prev : k));
    };

    compute();
    const raf = requestAnimationFrame(compute);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(compute)
        : null;
    ro?.observe(nav);
    window.addEventListener("resize", compute);
    let cancelled = false;
    document.fonts?.ready
      ?.then(() => {
        if (!cancelled) compute();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", compute);
    };
  }, [active, itemSig, lang, items]);

  const clampedCount = Math.min(visibleCount, items.length);
  const visibleItems = items.slice(0, clampedCount);
  const overflowItems = items.slice(clampedCount);
  const activeInOverflow = overflowItems.find((x) => x.key === active) || null;
  const overflowLiveCount = overflowItems.reduce((s, x) => s + (x.badge || 0), 0);

  useLayoutEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const getActiveEl = () =>
      activeInOverflow
        ? nav.querySelector<HTMLElement>('[data-k="__more__"]')
        : nav.querySelector<HTMLElement>(`a[data-k="${active}"]`);
    const measureBar = () => {
      const el = getActiveEl();
      const next = el ? { x: el.offsetLeft, w: el.offsetWidth } : null;
      setBar((prev) => {
        if (!next) return prev === null ? prev : null;
        if (prev && prev.x === next.x && prev.w === next.w) return prev;
        return next;
      });
    };
    measureBar();
    const raf = requestAnimationFrame(measureBar);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measureBar)
        : null;
    ro?.observe(nav);
    const activeEl = getActiveEl();
    if (activeEl) ro?.observe(activeEl);
    window.addEventListener("resize", measureBar);
    let cancelled = false;
    document.fonts?.ready
      ?.then(() => {
        if (!cancelled) measureBar();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", measureBar);
    };
  }, [active, activeInOverflow, clampedCount, itemSig, lang]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const activeItem = items.find((x) => x.key === active);
  const moreLabel = activeInOverflow
    ? activeInOverflow.label
    : bi("更多", "More");

  return (
    <nav className="tabs" ref={ref} aria-label={bi("主导航", "Main navigation")}>
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
      {visibleItems.map((it, i) => (
        <React.Fragment key={it.key}>
          {i > 0 && NAV_GROUP[it.key] !== NAV_GROUP[visibleItems[i - 1].key] && (
            <span className="tabs-sep" aria-hidden />
          )}
          <a
            data-k={it.key}
            href={href(it.to)}
            className={active === it.key ? "on" : ""}
            aria-current={active === it.key ? "page" : undefined}
            onPointerEnter={() => preloadRouteChunk(it.key)}
            onFocus={() => preloadRouteChunk(it.key)}
          >
            {it.key === "ai" ? (
              <span className="ai-word">{it.label}</span>
            ) : (
              it.label
            )}
            {it.badge && it.badge > 0 ? (
              <span
                className="tabs-live-badge"
                aria-label={bi(`${it.badge} 个任务正在自动执行`, `${it.badge} live executions`)}
              >
                <i aria-hidden />
                {it.badge}
              </span>
            ) : null}
          </a>
        </React.Fragment>
      ))}
      {overflowItems.length > 0 && (
        <Dropdown
          trigger="click"
          position="bl"
          popupVisible={moreOpen}
          onVisibleChange={(open) => {
            setMoreOpen(open);
            if (open) overflowItems.forEach((it) => preloadRouteChunk(it.key));
          }}
          droplist={
            <Menu
              className="tabs-more-menu"
              selectedKeys={activeInOverflow ? [activeInOverflow.key] : []}
              onClickMenuItem={(k) => {
                const hit = overflowItems.find((x) => x.key === k);
                setMoreOpen(false);
                if (hit) go(hit.to);
              }}
            >
              {overflowItems.map((it, i) => (
                <React.Fragment key={it.key}>
                  {i > 0 &&
                    NAV_GROUP[it.key] !== NAV_GROUP[overflowItems[i - 1].key] && (
                      <div className="menu-sep" role="separator" />
                    )}
                  <Menu.Item
                    key={it.key}
                    onMouseEnter={() => preloadRouteChunk(it.key)}
                  >
                    <span className="menu-row">
                      <span className={it.key === "ai" ? "ai-word" : ""}>
                        {it.label}
                      </span>
                      {it.badge && it.badge > 0 ? (
                        <span className="tabs-live-badge">
                          <i aria-hidden />
                          {it.badge}
                        </span>
                      ) : null}
                      {active === it.key && <IconCheck className="menu-check" />}
                    </span>
                  </Menu.Item>
                </React.Fragment>
              ))}
            </Menu>
          }
        >
          <button
            type="button"
            data-k="__more__"
            className={`tabs-more${activeInOverflow ? " on" : ""}${moreOpen ? " open" : ""}`}
            aria-expanded={moreOpen}
            aria-label={bi("更多导航页面", "More navigation pages")}
          >
            <span className={activeInOverflow?.key === "ai" ? "ai-word" : ""}>
              {moreLabel}
            </span>
            {overflowLiveCount > 0 && (
              <span className="tabs-more-dot" aria-hidden />
            )}
            <IconDown className="tabs-more-caret" />
          </button>
        </Dropdown>
      )}
      <div className="tabs-mirror" ref={mirrorRef} aria-hidden="true">
        <span className="tabs-sep" />
        {items.map((it) => (
          <span key={it.key} data-mk={it.key} className="tabs-m-item">
            {it.key === "ai" ? (
              <span className="ai-word">{it.label}</span>
            ) : (
              it.label
            )}
            {it.badge && it.badge > 0 ? (
              <span className="tabs-live-badge">
                <i />
                {it.badge}
              </span>
            ) : null}
          </span>
        ))}
        <span data-more-base="" className="tabs-more">
          <span>{bi("更多", "More")}</span>
          <IconDown className="tabs-more-caret" />
        </span>
        {activeItem && (
          <span data-more-active="" className="tabs-more on">
            <span className={activeItem.key === "ai" ? "ai-word" : ""}>
              {activeItem.label}
            </span>
            <IconDown className="tabs-more-caret" />
          </span>
        )}
      </div>
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
  build_id?: string;
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
  const lang = useLang();
  const first = useRef("");
  const [current, setCurrent] = useState<VersionPayload | null>(null);
  const [freshInfo, setFreshInfo] = useState<VersionPayload | null>(null);
  const [later, setLater] = useState("");
  const [seenVersion, setSeenVersion] = useState(readSeenRelease);

  useEffect(() => {
    let live = true;
    const look = () => {
      if (document.visibilityState === "hidden") return;
      fetch("/api/version", {
        cache: "no-store",
        headers: { "X-Lang": getLang() },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: VersionPayload | null) => {
          if (!live || !d?.version) return;
          const sig = `${d.version}@${d.build_id || ""}`;
          if (!first.current) {
            first.current = sig;
            setCurrent(d);
          } else if (sig !== first.current) {
            setFreshInfo(d);
          } else {
            setCurrent(d);
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
  }, [lang]);

  const fresh = freshInfo?.version || "";
  const freshBuild = freshInfo?.build_id || "";
  const freshSig = freshInfo ? `${fresh}@${freshBuild}` : "";
  const hotfixOnly = Boolean(
    fresh && current?.version && fresh === current.version,
  );
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
    freshBuild,
    hotfixOnly,
    freshInfo,
    hidden: Boolean(freshSig) && later === freshSig,
    hide: () => setLater(freshSig),
    unread,
    markSeen,
  };
}

function UpdatePill({
  fresh,
  freshBuild,
  hotfixOnly,
  hidden,
  hide,
  onViewNotes,
}: {
  fresh: string;
  freshBuild?: string;
  hotfixOnly?: boolean;
  hidden: boolean;
  hide: () => void;
  onViewNotes: () => void;
}) {
  const { bi } = useI18n();
  if (!fresh || hidden) return null;
  const shortBuild = freshBuild
    ? freshBuild.split("-")[0].slice(0, 7)
    : "";
  return (
    <div className="upd-toast" role="status" aria-live="polite">
      <div className="upd-toast-body">
        <span className="upd-toast-beacon" aria-hidden />
        <div className="upd-toast-copy">
          <div className="upd-toast-head">
            <span className="upd-toast-title">
              {hotfixOnly
                ? bi("平台已热更新", "Platform hot-reloaded")
                : bi("发现新版本", "New version ready")}
            </span>
            <code className="upd-toast-ver">
              v{fresh}
              {hotfixOnly && shortBuild ? ` · #${shortBuild}` : ""}
            </code>
          </div>
          <div className="upd-toast-sub">
            {bi(
              "刷新即可加载最新界面，当前内容不受影响",
              "Refresh to load the latest UI — your work stays intact",
            )}
          </div>
        </div>
      </div>
      <div className="upd-toast-sep" aria-hidden />
      <div className="upd-toast-actions">
        <button type="button" className="upd-toast-notes" onClick={onViewNotes}>
          {bi("更新公告", "Release Notes")}
        </button>
        <button
          type="button"
          className="upd-toast-refresh"
          onClick={() => location.reload()}
        >
          <IconRefresh />
          <span>{bi("刷新", "Refresh")}</span>
        </button>
        <button
          type="button"
          className="upd-toast-close"
          onClick={hide}
          title={bi("稍后再说", "Remind me later")}
          aria-label={bi("稍后再说", "Later")}
        >
          <IconClose />
        </button>
      </div>
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
  const { bi } = useI18n();
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
            <h2>{bi("版本与更新公告", "Versions & Release Notes")}</h2>
            <div className="rn-head-sub">
              {runningVer ? (
                <>
                  {bi("当前运行", "Running")} <code className="mono">v{runningVer}</code>
                  {info?.released_at ? bi(` · 发布于 ${info.released_at}`, ` · Released ${info.released_at}`) : ""}
                </>
              ) : (
                bi("平台版本信息", "Platform Version")
              )}
            </div>
          </div>
        </div>
        {hasFresh && (
          <Button size="small" type="primary" onClick={() => location.reload()}>
            {bi(`刷新升级到 v${freshVer}`, `Reload for v${freshVer}`)}
          </Button>
        )}
      </div>

      {notes.length > 0 ? (
        <>
          <div className="rn-bar">
            <span className="rn-bar-count">
              {bi(`发布时间轴 · 共 ${notes.length} 个版本`, `Release timeline · ${notes.length} versions`)}
              {query ? bi(`（匹配 ${visibleNotes.length} 项）`, ` (${visibleNotes.length} matched)`) : ""}
            </span>
            <div className="rn-bar-acts">
              {notes.length >= 6 && (
                <label className="rn-search">
                  <IconSearch aria-hidden />
                  <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={bi("筛选版本或更新内容", "Filter versions or release notes")}
                    aria-label={bi("筛选版本或更新内容", "Filter versions or release notes")}
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
                  {allExpanded ? bi("仅看近期", "Collapse old") : bi("全部展开", "Expand all")}
                </button>
              )}
            </div>
          </div>

          {visibleNotes.length > 0 ? (
            <div className="rn-tl" role="list" aria-label={bi("版本发布时间轴", "Release timeline")}>
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
                            <span className="rn-tag is-fresh">{bi("新版本待刷新", "Reload available")}</span>
                          ) : isRunningNode ? (
                            <span className="rn-tag">{bi("当前版本", "Current")}</span>
                          ) : isLatestNode ? (
                            <span className="rn-tag">{bi("最新", "Latest")}</span>
                          ) : null}
                          {n.date && (
                            <time className="rn-tl-mdate mono" dateTime={n.date}>
                              {n.date}
                            </time>
                          )}
                          <span className="rn-tl-meta">
                            {count > 0 && (
                              <span className="rn-tl-cnt">
                                {bi(`${count} 项更新`, `${count} ${count === 1 ? "change" : "changes"}`)}
                              </span>
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
            <p className="muted rn-empty">
              {bi(`未找到匹配 “${q.trim()}” 的版本记录。`, `No release notes match "${q.trim()}".`)}
            </p>
          )}
        </>
      ) : (
        <p className="muted">
          {bi(
            `当前运行版本 v${runningVer || "未知"}，暂无额外更新说明。`,
            `Running v${runningVer || "unknown"}; no additional release notes available.`,
          )}
        </p>
      )}

      <div className="rn-foot">
        <span className="faint small">
          {bi(
            "版本说明随平台服务端一起发布，平滑更新时原有任务与草稿保留。",
            "Release notes are served with the backend binary; seamless upgrades preserve active jobs & drafts.",
          )}
        </span>
        <Button type="primary" onClick={onClose}>
          {bi("知道了", "Close")}
        </Button>
      </div>
    </Modal>
  );
}

function ConnectivityPill({ onBack }: { onBack: () => void }) {
  const { bi } = useI18n();
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
  const [checking, setChecking] = useState(false);
  const retryNow = () => {
    if (checking) return;
    setChecking(true);
    api("/api/session")
      .catch(() => {})
      .finally(() => setChecking(false));
  };
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
  const host = typeof window !== "undefined" ? window.location.host : "";
  return (
    <div
      className={`net-pill ${status === "online" ? "ok" : "off"}`}
      role="status"
      title={
        status === "unreachable"
          ? bi(
              `无法连接 Kyndryl Delivery Studio 后端服务（${host}），可能正在重启或当前网络中断`,
              `Cannot reach Kyndryl Delivery Studio backend (${host}); server may be restarting or network interrupted`,
            )
          : undefined
      }
    >
      <span className="sdot" />
      <span className="net-pill-msg">
        {status === "offline"
          ? bi(
              "本机网络已断开，恢复后将自动重连 Kyndryl Delivery Studio",
              "Device network offline; will auto-reconnect to Kyndryl Delivery Studio",
            )
          : status === "unreachable"
            ? bi(
                "暂时连不上 Kyndryl Delivery Studio 后端服务（可能正在重启），正在自动重连…",
                "Cannot reach Kyndryl Delivery Studio backend (may be restarting); reconnecting…",
              )
            : bi(
                "已重新连上 Kyndryl Delivery Studio 服务",
                "Reconnected to Kyndryl Delivery Studio",
              )}
      </span>
      {status === "unreachable" && (
        <button
          type="button"
          className="net-pill-link"
          disabled={checking}
          onClick={retryNow}
        >
          {checking ? bi("重连中…", "Retrying…") : bi("立即重连", "Retry now")}
        </button>
      )}
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
  const { bi } = useI18n();
  const on = status.enabled;
  const pendingCfg = !!status.master_enabled && !status.configured;
  const stateCls = on ? "is-on" : pendingCfg ? "is-warn" : "is-off";
  const statusWord = on ? bi("已启用", "Enabled") : pendingCfg ? bi("待配置", "Setup needed") : bi("未启用", "Disabled");
  const shortSub = on ? "" : pendingCfg ? bi(" · 待配", " · Setup") : bi(" · Off", " · Off");
  const readonlyTip = on
    ? bi("平台 AI 套件已启用（当前账户只读，由管理员在平台设置中维护）", "Platform AI suite is enabled (read-only; managed in Platform Settings)")
    : pendingCfg
      ? bi("平台 AI 套件待管理员完成模型配置（只读）", "Platform AI suite awaits model setup by an administrator")
      : bi("平台 AI 套件未启用（当前账户只读，需管理员在平台设置中开启）", "Platform AI suite is disabled (read-only; ask an admin to enable it)");
  const warmAISettings = () => {
    if (!cached("/api/settings/ai"))
      void fetchCached("/api/settings/ai").catch(() => undefined);
  };
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
          aria-label={bi(`AI 套件${statusWord}（只读）`, `AI Suite ${statusWord} (read-only)`)}
        >
          {content}
        </span>
      </Tooltip>
    );
  }
  return (
    <button
      type="button"
      className={`ai-quick-toggle is-interactive ${stateCls}`}
      title={bi(`平台 AI 套件${statusWord} · 点击前往设置`, `AI Suite ${statusWord} · Click to configure`)}
      onPointerEnter={warmAISettings}
      onClick={(e) => {
        e.currentTarget.blur();
        go({ name: "settings", id: "ai" });
      }}
      aria-label={bi(`AI 套件${statusWord}，前往平台设置管理`, `AI Suite ${statusWord}, open settings`)}
    >
      {content}
    </button>
  );
}

function RouteFallback() {
  const show = useDelayed(true, 160);
  return (
    <div
      className="route-fallback"
      style={{
        minHeight: "calc(100vh - 96px)",
        display: "grid",
        placeItems: "center",
      }}
      aria-busy="true"
    >
      {show ? <Spin size={22} /> : null}
    </div>
  );
}

function GlobeIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M2.3 8h11.4M8 2c1.8 1.9 1.8 10.1 0 12M8 2c-1.8 1.9-1.8 10.1 0 12" />
    </svg>
  );
}

function App() {
  const { lang, setLang, bi } = useI18n();
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
        if (u) Message.info(bi("登录已过期，请重新登录", "Session expired; please sign in again"));
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
  }, [user, lang, loadApps, loadJobs]);
  // Warm AI settings & assistant threads right after initial paint so first clicks open instantly without mid-transition skeleton reflow.
  useEffect(() => {
    if (!user) return;
    const t = window.setTimeout(() => {
      if (can("ai.settings"))
        void fetchCached("/api/settings/ai").catch(() => undefined);
      if (aiOn && can("ai.use"))
        void fetchCached("/api/ai/chats").catch(() => undefined);
    }, 150);
    return () => window.clearTimeout(t);
  }, [user, aiOn]);
  // Warm-prefetch primary lazy route chunks during browser idle time after sign-in so tab switches feel instant.
  useEffect(() => {
    if (!user) return;
    const conn = (navigator as { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return;
    const queue: string[] = [
      "executions",
      "components",
      "library",
      ...(can("security.view") ? ["security"] : []),
      ...(aiOn && can("ai.use") ? ["ai", "studio"] : []),
      ...(can("iam.user|iam.role|iam.team|audit.view") ? ["accounts"] : []),
      "settings",
      "me",
      ...(can("delivery.create") ? ["new"] : []),
    ];
    let cancelled = false;
    let idleId: number | null = null;
    let timerId: number | null = null;
    const ric = (
      window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
        cancelIdleCallback?: (id: number) => void;
      }
    ).requestIdleCallback;
    const cic = (
      window as Window & { cancelIdleCallback?: (id: number) => void }
    ).cancelIdleCallback;
    const step = (idx: number) => {
      if (cancelled || idx >= queue.length) return;
      preloadRouteChunk(queue[idx]);
      if (ric) {
        idleId = ric(() => step(idx + 1), { timeout: 2500 });
      } else {
        timerId = window.setTimeout(() => step(idx + 1), 220);
      }
    };
    timerId = window.setTimeout(() => {
      if (ric) idleId = ric(() => step(0), { timeout: 2000 });
      else step(0);
    }, 600);
    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      if (idleId !== null && cic) cic(idleId);
    };
  }, [user, aiOn]);
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

  const [activeExecCount, setActiveExecCount] = useState(0);
  const canViewExec = !!user && can("delivery.view|delivery.execute");
  useEffect(() => {
    if (!canViewExec) {
      setActiveExecCount(0);
      return;
    }
    let dead = false;
    const check = () => {
      if (dead || document.visibilityState !== "visible") return;
      api<MonitorListPayload>("/api/executions/runs")
        .then((res) => {
          if (!dead) setActiveExecCount(res.active_count || 0);
        })
        .catch(() => undefined);
    };
    check();
    const id = window.setInterval(check, activeExecCount > 0 ? 4000 : 12000);
    const onVis = () => check();
    const onUpdated = () => check();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("execution-updated", onUpdated);
    return () => {
      dead = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("execution-updated", onUpdated);
    };
  }, [canViewExec, activeExecCount > 0]);

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
    if (!user) {
      document.title = bi("登录 · Kyndryl Delivery Studio", "Sign in · Kyndryl Delivery Studio");
      return;
    }
    const titles: Record<Route["name"], string> = {
      deliveries: bi("集群", "Clusters"),
      executions: bi("执行监控", "Execution Monitor"),
      settings: bi("平台设置", "Settings"),
      ai: bi("AI 助手", "AI Assistant"),
      new: bi("新建集群", "New Cluster"),
      import: bi("导入存量集群", "Import Cluster"),
      apps: bi("应用", "Apps"),
      components: bi("组件", "Components"),
      library: bi("软件库", "Library"),
      security: bi("安全中心", "Security Center"),
      accounts: "IAM",
      me: bi("我的账户", "My Account"),
      kb: bi("知识库", "Knowledge Base"),
      skills: bi("技能", "Skills"),
      mcp: bi("MCP 服务", "MCP"),
    };
    document.title = `${titles[route.name]} · Kyndryl Delivery Studio`;
  }, [route.name, lang, user]);

  const routeId = "id" in route ? route.id : "";
  const portalStart = useMemo<AITarget>(() => {
    const pageMap: Record<
      string,
      { key: string; title: string; context: string; suggestions?: string[] }
    > = {
      settings:
        routeId === "execution-nodes"
          ? {
              key: "portal:execution-nodes",
              title: bi("执行节点接入助手", "Execution Node Helper"),
              context: bi("设置 · 执行节点", "Settings · Execution Nodes"),
              suggestions: [
                bi(
                  "执行器和目标 Agent 有什么区别？分别装在哪？",
                  "What is the difference between Runner and Target Agent?",
                ),
                bi(
                  "检查当前平台的访问地址、CA 证书和节点在线状态",
                  "Check Hub URLs, CA cert status, and connected nodes",
                ),
                bi(
                  "只有堡垒机拿不到密码，怎么实现自动部署？",
                  "How do I automate via bastion without target passwords?",
                ),
              ],
            }
          : {
              key: "portal:settings",
              title: bi("平台设置助手", "Settings Assistant"),
              context: bi("平台设置", "Platform Settings"),
            },
      apps: {
        key: "portal:apps",
        title: bi("应用与架构助手", "Apps & Architecture"),
        context: bi("应用目录", "App Catalog"),
      },
      library: {
        key: "portal:library",
        title: bi("软件库助手", "Package Library Helper"),
        context: bi("离线软件库", "Offline Library"),
      },
      executions: {
        key: "portal:monitor",
        title: bi("执行监控助手", "Execution Monitor Helper"),
        context: bi("执行监控", "Execution Monitor"),
      },
      components: {
        key: "portal:components",
        title: bi("组件助手", "Component Helper"),
        context: bi("组件管理", "Components"),
      },
      accounts: {
        key: "portal:iam",
        title: bi("权限与账户助手", "IAM & Accounts Helper"),
        context: bi("权限与账户", "IAM & Accounts"),
      },
      kb: {
        key: "portal:kb",
        title: bi("知识库助手", "Knowledge Base Helper"),
        context: bi("能力库 · 知识库", "Studio · Knowledge Base"),
      },
      skills: {
        key: "portal:skills",
        title: bi("技能编写助手", "Skills Helper"),
        context: bi("能力库 · 技能", "Studio · Skills"),
      },
      mcp: {
        key: "portal:mcp",
        title: bi("MCP 接入助手", "MCP Integration Helper"),
        context: bi("能力库 · MCP 服务", "Studio · MCP Servers"),
      },
    };
    const p = pageMap[route.name] || {
      key: "portal:general",
      title: bi("平台智能助手", "Portal Assistant"),
      context: bi("Kyndryl Delivery Studio", "Kyndryl Delivery Studio"),
    };
    return {
      key: p.key,
      title: p.title,
      context: p.context,
      suggestions: p.suggestions,
      step: { page: p.context, title: p.title },
    };
  }, [route.name, routeId, lang]);
  const portalScope = useMemo(() => ({ kind: "portal" as const }), []);
  const hidePortalDock = route.name === "ai" || route.name === "new";

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
        <h2>
          {bi(
            "无法连接到 Kyndryl Delivery Studio 后端服务",
            "Unable to Reach Kyndryl Delivery Studio Backend",
          )}
        </h2>
        <p>{bootError}</p>
        <Button type="primary" onClick={boot}>
          {bi("重试", "Retry")}
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

  const studioTabs =
    aiOn && can("ai.use") ? enabledStudioTabs(aiStatus.features) : [];
  const tabs: { key: NavTabKey; label: string; to: Route; badge?: number }[] = [
    ...(can("delivery.view|delivery.create")
      ? [
          {
            key: "deliveries" as const,
            label: bi("集群", "Clusters"),
            to: { name: "deliveries" } as Route,
          },
        ]
      : []),
    ...(can("delivery.view|delivery.execute")
      ? [
          {
            key: "executions" as const,
            label: bi("执行监控", "Executions"),
            to: { name: "executions" } as Route,
            badge: activeExecCount > 0 ? activeExecCount : undefined,
          },
        ]
      : []),
    { key: "apps", label: bi("应用", "Apps"), to: { name: "apps" } },
    { key: "components", label: bi("组件", "Components"), to: { name: "components" } },
    { key: "library", label: bi("软件库", "Library"), to: { name: "library" } },
    ...(can("security.view")
      ? [
          {
            key: "security" as const,
            label: bi("安全", "Security"),
            to: { name: "security" } as Route,
          },
        ]
      : []),
    ...(aiOn && !!aiStatus.features?.assistant && can("ai.use")
      ? [{ key: "ai" as const, label: "AI", to: { name: "ai" } as Route }]
      : []),
    ...(studioTabs.length > 0
      ? [
          {
            key: "studio" as const,
            label: bi("能力库", "Studio"),
            to: { name: preferredStudioTab(aiStatus.features) } as Route,
          },
        ]
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
            label: bi("设置", "Settings"),
            to: { name: "settings" } as Route,
          },
        ]
      : []),
  ];
  const activeTab: NavTabKey =
    route.name === "new" || route.name === "import"
      ? "deliveries"
      : isStudioRoute(route.name)
        ? "studio"
        : route.name;

  const aiRouteBlocked =
    (route.name === "ai" && !(aiOn && !!aiStatus.features?.assistant)) ||
    (route.name === "kb" && !(aiOn && !!aiStatus.features?.kb)) ||
    (route.name === "skills" && !(aiOn && !!aiStatus.features?.skills)) ||
    (route.name === "mcp" && !(aiOn && !!aiStatus.features?.mcp));

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
  else if (route.name === "executions")
    page = (
      <ExecutionMonitorPage
        selectedJob={route.id}
        initialRun={route.run}
        initialStep={route.step}
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
    page = <GuidePage me={user} />;
  else if (route.name === "components" && route.id && route.edit !== undefined)
    page = (
      <WorkbenchPage
        key={route.id}
        me={user}
        name={route.id}
        tab={route.edit}
      />
    );
  else if (route.name === "components")
    page = <ComponentsPage me={user} selected={route.id} />;
  else if (route.name === "library")
    page = <LibraryPage me={user} selected={route.id} />;
  else if (route.name === "security")
    page = can("security.view") ? (
      <SecurityPage tab={route.tab} query={route.q} />
    ) : (
      <DeliveriesPage
        jobs={jobs}
        load={jobsLoad}
        reload={loadJobs}
        apps={apps}
      />
    );
  else if (route.name === "accounts")
    page = <AccountsPage me={user} selected={route.id} />;
  else if (route.name === "me") page = <MePage me={user} section={route.id} />;
  else if (route.name === "kb" || route.name === "skills" || route.name === "mcp")
    page = (
      <StudioPage
        active={route.name}
        selected={route.id}
        features={aiStatus.features}
      />
    );
  else if (route.name === "settings")
    page = <SettingsPage me={user} selected={route.id} />;
  else if (route.name === "import")
    page = !can("delivery.create") ? (
      <div className="detail-none enter">
        <h2>{bi("你没有导入集群的权限", "No permission to import clusters")}</h2>
        <p>{bi("需要「创建交付」权限才能纳管存量集群。", "Requires cluster creation permission to onboard brownfield clusters.")}</p>
        <Button onClick={() => go({ name: "deliveries" })}>{bi("返回集群", "Back to Clusters")}</Button>
      </div>
    ) : (
      <ImportClusterPage
        component={route.component}
        onImported={async () => {
          await loadJobs();
        }}
      />
    );
  else if (route.name === "ai")
    page = (
      <AIPage
        me={user}
        chatId={route.id}
        job={route.job}
        sessionKey={route.key}
        comp={route.comp}
        hist={route.hist}
        jobs={jobs}
      />
    );
  else {
    const app = route.app ? apps.find((a) => a.id === route.app) : undefined;
    const isVerifyRoute = route.verify === "1";
    const canVerify = can("component.edit|component.publish");
    const hasFormalRelease = app ? hasReleasedVersion(app) : false;
    const leave = () => {
      if (route.revise) {
        const revJob = jobs.find((j) => j.id === route.revise);
        if (revJob) go({ name: "deliveries", id: revJob.cluster_id, tab: "plans", plan: revJob.id });
        else go({ name: "deliveries" });
      } else if (route.from) go({ name: "deliveries", id: route.from });
      else if (isVerifyRoute && app) go({ name: "components", id: app.id });
      else if (navigatedInApp) history.back();
      else go({ name: "deliveries" });
    };
    page = !can("delivery.create") ? (
      <div className="detail-none enter">
        <h2>{bi("你没有新建集群的权限", "No permission to create clusters")}</h2>
        <p>{bi("需要的话，请联系能管理用户的人给你相应的角色。", "Contact an administrator to assign the required role.")}</p>
        <Button onClick={() => go({ name: "apps" })}>{bi("查看应用", "Browse Apps")}</Button>
      </div>
    ) : isVerifyRoute && !canVerify ? (
      <div className="detail-none enter">
        <h2>{bi("仅组件维护者可使用组件验证测试通道", "Component verification channel is restricted to maintainers")}</h2>
        <p>{bi("正式交付仅允许选择已完成真机验证并发布的组件版本与操作系统。", "Formal deliveries only allow field-verified and published component versions and OS platforms.")}</p>
        <Button onClick={() => go({ name: "deliveries" })}>{bi("返回交付", "Back to Deliveries")}</Button>
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
    ) : !app || (!isVerifyRoute && !app.available) ? (
      <div className="detail-none enter">
        <h2>
          {app
            ? bi(`${app.name} 暂时不能生成交付`, `${app.name} is currently unavailable`)
            : bi("找不到这个应用", "Application not found")}
        </h2>
        <p>{app?.reason || bi("应用目录中没有这一项。", "This application was not found in the catalog.")}</p>
        <div className="row-gap">
          <Button type="primary" onClick={() => go({ name: "new" })}>
            {bi("选择其他组件", "Choose another component")}
          </Button>
          <Button onClick={() => go({ name: "apps" })}>{bi("查看应用", "Browse Apps")}</Button>
        </div>
      </div>
    ) : !isVerifyRoute && !route.revise && !hasFormalRelease ? (
      <div className="detail-none enter">
        <h2>
          {bi(
            `${app.name} 暂无已发布版本，正式交付已拦截`,
            `${app.name} has no published versions for formal delivery`,
          )}
        </h2>
        <p>
          {bi(
            "未通过实测验证并发布的版本不可用于正式生产交付。请先由组件维护者在组件页发起验证测试并提交发布证据。",
            "Versions not yet verified and published cannot be used for formal delivery. A maintainer must complete a verification delivery and submit evidence first.",
          )}
        </p>
        <div className="row-gap">
          {canVerify && (
            <Button
              type="primary"
              onClick={() => go({ name: "components", id: app.id })}
            >
              {bi("前往组件页验证与发布", "Open Component Verification")}
            </Button>
          )}
          <Button onClick={() => go({ name: "new" })}>
            {bi("选择其他组件", "Choose another component")}
          </Button>
        </div>
      </div>
    ) : (
        <NewDelivery
          key={`${app.id}-${route.from || ""}-${route.revise || ""}-${route.plan || ""}-${route.chat || ""}-${route.verify || ""}-${route.ver || ""}-${route.platform || ""}`}
          app={app}
          from={route.from}
          revise={route.revise}
          preset={route.plan}
          chat={route.chat}
          verify={isVerifyRoute}
          initialVer={route.ver}
          initialPlatform={route.platform}
          jobs={jobs}
          jobsLoading={jobsLoad === "loading"}
          back={leave}
          created={(j: Job) => {
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
    <AIDock scope={portalScope} start={portalStart} hidden={hidePortalDock}>
      <div className={`shell route-${route.name}`}>
      <a className="skip" href="#main">
        {bi("跳到主要内容", "Skip to main content")}
      </a>
      <header className="topbar">
        <a className="brand" href="#/" aria-label={bi("Kyndryl Delivery Studio 首页", "Kyndryl Delivery Studio Home")}>
          <BrandMark size={22} />
          <span className="brand-word">
            <span className="brand-k">kyndryl</span>
            <span className="brand-sep" aria-hidden />
            <span className="brand-prod">Delivery Studio</span>
          </span>
        </a>
        <NavTabs items={tabs} active={activeTab} />
        <div className="top-right">
          <AIStatusBadge status={aiStatus} canManage={can("ai.settings")} />
          <button
            type="button"
            className="search-trigger"
            onClick={() => setPalette(true)}
            aria-label={bi("搜索与跳转", "Search and jump")}
            aria-haspopup="dialog"
            aria-expanded={palette}
            aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
          >
            <IconSearch className="search-trigger-ic" />
            <span className="search-trigger-txt">{bi("搜索或跳转", "Search or jump")}</span>
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
                  ? bi(
                      `当前版本 v${verWatch.current.version} · 有新版本更新公告`,
                      `Running v${verWatch.current.version} · New release notes available`,
                    )
                  : bi(
                      `查看版本 v${verWatch.current.version} 与更新公告`,
                      `View v${verWatch.current.version} & release notes`,
                    )
              }
              mini
            >
              <button
                type="button"
                className={`ver-pill${verWatch.unread ? " is-new" : ""}`}
                onClick={openChangelog}
                aria-label={bi(
                  `平台版本 v${verWatch.current.version}，点击查看更新公告`,
                  `Platform v${verWatch.current.version}, view release notes`,
                )}
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
                onClickMenuItem={(k) => setLang(k as "zh-CN" | "en-US")}
                selectedKeys={[lang]}
              >
                <Menu.Item key="zh-CN">
                  <span className="menu-row">
                    <span>简体中文</span>
                    {lang === "zh-CN" && <IconCheck className="menu-check" />}
                  </span>
                </Menu.Item>
                <Menu.Item key="en-US">
                  <span className="menu-row">
                    <span>English</span>
                    {lang === "en-US" && <IconCheck className="menu-check" />}
                  </span>
                </Menu.Item>
              </Menu>
            }
          >
            <button
              type="button"
              className="lang-pill"
              aria-label={bi("切换界面语言", "Switch language")}
              title={bi("切换界面语言（中文 / English）", "Switch language (中文 / English)")}
            >
              <GlobeIcon />
              <span>{lang === "en-US" ? "EN" : "中文"}</span>
            </button>
          </Dropdown>
          <Dropdown
            trigger="click"
            position="br"
            droplist={
              <Menu
                onClickMenuItem={(k) => theme.choose(k as ThemePref)}
                selectedKeys={[theme.pref]}
              >
                {(
                  [
                    ["light", bi("浅色外观", "Light"), IconSun],
                    ["dark", bi("深色外观", "Dark"), IconMoon],
                    ["system", bi("跟随系统", "System"), IconDesktop],
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
              </Menu>
            }
          >
            <button
              type="button"
              className="icon-btn"
              aria-label={bi("切换外观", "Switch appearance")}
              title={bi("外观设置", "Appearance")}
            >
              <ThemeIcon />
            </button>
          </Dropdown>
          <Dropdown
            trigger="click"
            position="br"
            droplist={
              <Menu
                className="user-drop-menu"
                onClickMenuItem={(k) =>
                  k === "out"
                    ? logout()
                    : k === "me"
                      ? go({ name: "me" })
                      : k === "pw"
                        ? go({ name: "me", id: "security" })
                        : undefined
                }
              >
                <div className="menu-me">
                  <span className={`avatar ${user.role}`}>
                    {user.username.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="menu-me-t">
                    <b>{user.username}</b>
                    <span>
                      {user.role_names?.join(bi("、", ", ")) ||
                        (user.role === "admin"
                          ? bi("管理员", "Administrator")
                          : bi("交付使用者", "Operator"))}
                    </span>
                  </div>
                </div>
                <div className="menu-sep" role="separator" />
                <Menu.Item key="me">
                  <span className="menu-row">
                    <IconUser />
                    <span>{bi("我的账户", "My Account")}</span>
                  </span>
                </Menu.Item>
                <Menu.Item key="pw">
                  <span className="menu-row">
                    <IconLock />
                    <span>{bi("修改密码", "Change Password")}</span>
                  </span>
                </Menu.Item>
                <div className="menu-sep" role="separator" />
                <Menu.Item key="out" className="danger-item">
                  <span className="menu-row">
                    <IconPoweroff />
                    <span>{bi("退出登录", "Sign out")}</span>
                  </span>
                </Menu.Item>
              </Menu>
            }
          >
            <button
              type="button"
              className={`me${route.name === "me" ? " on" : ""}`}
              aria-label={bi(`账户 ${user.username}`, `Account ${user.username}`)}
            >
              <span className={`avatar ${user.role}`}>
                {user.username.slice(0, 1).toUpperCase()}
              </span>
            </button>
          </Dropdown>
        </div>
      </header>
      <main
        id="main"
        className="main"
        key={isStudioRoute(route.name) ? "studio" : route.name}
      >
        <PageBoundary resetKey={href(route)}>
          <Suspense fallback={<RouteFallback />}>{page}</Suspense>
        </PageBoundary>
      </main>
      <ConnectivityPill
        onBack={() => {
          loadJobs();
          loadApps();
        }}
      />
      <UpdatePill
        fresh={verWatch.fresh}
        freshBuild={verWatch.freshBuild}
        hotfixOnly={verWatch.hotfixOnly}
        hidden={verWatch.hidden || changelogOpen}
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
    </AIDock>
  );
}

function Root() {
  const lang = useLang();
  return (
    <ConfigProvider
      locale={lang === "en-US" ? enUS : zhCN}
      componentConfig={{
        Button: { size: "default" },
        Trigger: { updateOnScroll: true },
      }}
    >
      <App />
    </ConfigProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <Root />
  </I18nProvider>,
);

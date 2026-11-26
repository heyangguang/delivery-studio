import React, { useEffect, useLayoutEffect, useRef } from "react";
import { go } from "../../app/router";
import type { Session } from "../../shared/shared";
import { can, useAIStatus, useMedia } from "../../shared/shared";
import { UnderlineTabs } from "../../design/ui";
import { bi, useLang } from "../../app/i18n";
import { AISettingsView } from "../ai/aisettings";
import { CostView, UsageView } from "../ai/aiusage";
import { PricesView } from "../ai/aiprices";
import { WebView } from "../ai/aiext";
import { StorageView } from "./storageview";
import { ReportView } from "../projects/reportview";
import { SandboxView } from "./sandboxview";
import { ChannelsView, TemplatesView } from "./setnotify";
import "./settings.css";

/* Platform settings: notifications, AI governance, platform resources, and execution nodes. */

const icoProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  style: { display: "block", flex: "none" } as React.CSSProperties,
  "aria-hidden": true,
};

const SetIcons = {
  channels: (
    <svg {...icoProps}>
      <path d="M8 2.3A4.2 4.2 0 0 1 12.2 6.5V9.6L13.5 11.4H2.5L3.8 9.6V6.5A4.2 4.2 0 0 1 8 2.3Z" />
      <path d="M6.5 11.4A1.5 1.5 0 0 0 9.5 11.4" />
    </svg>
  ),
  templates: (
    <svg {...icoProps}>
      <rect x="3" y="2.2" width="10" height="11.6" rx="1.8" />
      <path d="M5.5 5.6H10.5M5.5 8.2H10.5M5.5 10.8H8.5" />
    </svg>
  ),
  ai: (
    <svg {...icoProps}>
      <path d="M8 7.6L4.6 5.2M8 7.6L11.4 5.2M8 7.6V10.6" />
      <circle cx="8" cy="7.6" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="3.6" cy="4.4" r="1.35" />
      <circle cx="12.4" cy="4.4" r="1.35" />
      <circle cx="8" cy="11.9" r="1.35" />
    </svg>
  ),
  usage: (
    <svg {...icoProps}>
      <path d="M2.4 8H5L6.7 4.2L9.3 11.8L11 8H13.6" />
    </svg>
  ),
  cost: (
    <svg {...icoProps}>
      <path d="M2.5 13.2H13.5" />
      <path d="M4.5 13.2V8.8M8 13.2V5.4M11.5 13.2V2.8" />
    </svg>
  ),
  web: (
    <svg {...icoProps}>
      <circle cx="8" cy="8" r="5.7" />
      <path d="M2.3 8H13.7" />
      <path d="M8 2.3C9.7 4.1 9.7 11.9 8 13.7C6.3 11.9 6.3 4.1 8 2.3Z" />
    </svg>
  ),
  prices: (
    <svg {...icoProps}>
      <path d="M8 2.3L13.3 5.2V10.8L8 13.7L2.7 10.8V5.2L8 2.3Z" />
      <path d="M6.2 6.8H9.8M6.2 9.4H9.8M8 5.4V10.8" />
    </svg>
  ),
  report: (
    <svg {...icoProps}>
      <path d="M4 2.2H9.8L12.5 4.9V12.2A1.6 1.6 0 0 1 10.9 13.8H4A1.6 1.6 0 0 1 2.4 12.2V3.8A1.6 1.6 0 0 1 4 2.2Z" />
      <path d="M9.6 2.2V5.1H12.5M5.2 8.2H9.8M5.2 10.8H8.2" />
    </svg>
  ),
  storage: (
    <svg {...icoProps}>
      <ellipse cx="8" cy="4.3" rx="5.2" ry="2" />
      <path d="M2.8 4.3V8C2.8 9.1 5.1 10 8 10C10.9 10 13.2 9.1 13.2 8V4.3" />
      <path d="M2.8 8V11.7C2.8 12.8 5.1 13.7 8 13.7C10.9 13.7 13.2 12.8 13.2 11.7V8" />
    </svg>
  ),
  sandbox: (
    <svg {...icoProps}>
      <rect x="2.3" y="3" width="11.4" height="10" rx="2" />
      <path d="M5.2 6.4L7.2 8L5.2 9.6M8.6 9.6H10.8" />
    </svg>
  ),
  nodes: (
    <svg {...icoProps}>
      <rect x="2.5" y="2.8" width="11" height="4.2" rx="1.3" />
      <rect x="2.5" y="9" width="11" height="4.2" rx="1.3" />
      <circle cx="5" cy="4.9" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="5" cy="11.1" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  ),
};

const SECTIONS: {
  id: string;
  readonly group: string;
  items: {
    id: string;
    readonly title: string;
    readonly hint: string;
    icon: React.ReactNode;
    perm?: string;
  }[];
}[] = [
  {
    id: "notify",
    get group() {
      return bi("通知", "Notifications");
    },
    items: [
      {
        id: "channels",
        get title() {
          return bi("通知渠道", "Channels");
        },
        get hint() {
          return bi("消息发到哪里", "Where alerts are sent");
        },
        icon: SetIcons.channels,
        perm: "settings.notify",
      },
      {
        id: "templates",
        get title() {
          return bi("通知模板", "Templates");
        },
        get hint() {
          return bi("消息怎么写", "Message content & format");
        },
        icon: SetIcons.templates,
        perm: "settings.notify",
      },
    ],
  },
  {
    id: "ai",
    group: "AI",
    items: [
      {
        id: "ai",
        get title() {
          return bi("AI 套件与模型", "AI Suite & Models");
        },
        get hint() {
          return bi(
            "套件启用开关、供应商、数据边界",
            "Master switch, providers & data boundaries",
          );
        },
        icon: SetIcons.ai,
        perm: "ai.settings|ai.usage",
      },
      {
        id: "ai-usage",
        get title() {
          return bi("用量明细", "Usage Logs");
        },
        get hint() {
          return bi("每一次模型调用", "Every model invocation");
        },
        icon: SetIcons.usage,
        perm: "ai.usage",
      },
      {
        id: "ai-cost",
        get title() {
          return bi("用量与成本", "Usage & Cost");
        },
        get hint() {
          return bi("趋势、排行、估算费用", "Trends, rankings & estimated cost");
        },
        icon: SetIcons.cost,
        perm: "ai.usage",
      },
      {
        id: "ai-web",
        get title() {
          return bi("联网搜索", "Web Search");
        },
        get hint() {
          return bi("搜索服务与访问范围", "Search engine & access scope");
        },
        icon: SetIcons.web,
        perm: "ai.settings",
      },
      {
        id: "ai-prices",
        get title() {
          return bi("模型价格", "Model Pricing");
        },
        get hint() {
          return bi("官方默认价与自定义", "Built-in rates & overrides");
        },
        icon: SetIcons.prices,
        perm: "ai.settings",
      },
    ],
  },
  {
    id: "platform",
    get group() {
      return bi("平台", "Platform");
    },
    items: [
      {
        id: "report",
        get title() {
          return bi("报告模板", "Report Template");
        },
        get hint() {
          return bi(
            "导出 Word 的封面、页眉页脚",
            "Word cover, headers & footers",
          );
        },
        icon: SetIcons.report,
        perm: "settings.report",
      },
      {
        id: "storage",
        get title() {
          return bi("存储空间", "Storage");
        },
        get hint() {
          return bi("每个人的额度与用量", "Per-user quotas & usage");
        },
        icon: SetIcons.storage,
        perm: "settings.storage",
      },
      {
        id: "sandbox",
        get title() {
          return bi("代码沙箱", "Code Sandbox");
        },
        get hint() {
          return bi(
            "让 AI 在隔离环境里运行代码",
            "Run AI code in isolation",
          );
        },
        icon: SetIcons.sandbox,
        perm: "settings.sandbox",
      },
    ],
  },
];

const AI_ONLY_SETTINGS = new Set([
  "ai-usage",
  "ai-cost",
  "ai-web",
  "ai-prices",
  "sandbox",
]);

export function SettingsPage({
  me: _me,
  selected,
}: {
  me: Session;
  selected?: string;
}) {
  useLang();
  const aiStatus = useAIStatus();
  const narrow = useMedia("(max-width: 900px)");
  // only the sections this person may open are shown at all; AI-only subpages hide when global AI is off
  const groups = SECTIONS.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) =>
        (!i.perm || can(i.perm)) &&
        (aiStatus.enabled || !AI_ONLY_SETTINGS.has(i.id)),
    ),
  })).filter((g) => g.items.length);
  const items = groups.flatMap((g) => g.items);
  const first = items[0]?.id || "channels";
  const fallback =
    selected && AI_ONLY_SETTINGS.has(selected) && items.some((i) => i.id === "ai")
      ? "ai"
      : first;
  const view = items.some((i) => i.id === selected) ? selected! : fallback;
  const activeGroup = groups.find((g) => g.items.some((i) => i.id === view));
  const curIdx = Math.max(
    0,
    items.findIndex((i) => i.id === view),
  );
  const prevIdxRef = useRef<number | null>(null);
  const paneDir =
    prevIdxRef.current === null
      ? ""
      : curIdx >= prevIdxRef.current
        ? "fwd"
        : "back";
  useEffect(() => {
    prevIdxRef.current = curIdx;
  }, [curIdx]);
  useLayoutEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);
  const nav = useRef<HTMLElement>(null);
  const switchView = (id: string) =>
    go(
      { name: "settings", id: id === first ? undefined : id },
      { replace: true },
    );
  useLayoutEffect(() => {
    let rafId: number | null = null;
    const reveal = () => {
      rafId = null;
      const rail = nav.current;
      const active = rail?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!rail || !active) return;
      const box = rail.getBoundingClientRect(),
        item = active.getBoundingClientRect();
      if (rail.scrollWidth > rail.clientWidth) {
        if (item.right > box.right)
          rail.scrollLeft += item.right - box.right + 12;
        else if (item.left < box.left)
          rail.scrollLeft -= box.left - item.left + 12;
      } else {
        if (item.bottom > box.bottom)
          rail.scrollTop += item.bottom - box.bottom + 12;
        else if (item.top < box.top) rail.scrollTop -= box.top - item.top + 12;
      }
    };
    const onResize = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(reveal);
    };
    reveal();
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [view]);
  if (!items.length)
    return (
      <div className="detail-none enter">
        <h2>{bi("你没有可以查看的平台设置", "No settings accessible")}</h2>
        <p>
          {bi(
            "需要查看或调整通知、AI 与平台资源配置时，请联系管理员分配相应角色。",
            "Contact an administrator to assign a role if you need access to notification, AI, or platform settings.",
          )}
        </p>
      </div>
    );
  const body =
    view === "templates" ? (
      <TemplatesView />
    ) : view === "ai" ? (
      <AISettingsView />
    ) : view === "ai-usage" ? (
      <UsageView />
    ) : view === "ai-cost" ? (
      <CostView />
    ) : view === "ai-prices" ? (
      <PricesView />
    ) : view === "ai-web" ? (
      <WebView />
    ) : view === "report" ? (
      <ReportView />
    ) : view === "storage" ? (
      <StorageView />
    ) : view === "sandbox" ? (
      <SandboxView />
    ) : (
      <ChannelsView />
    );
  return (
    <div className="st-page">
      {narrow ? (
        <div className="st-mobile-bar">
          <UnderlineTabs
            className="st-subtabs"
            label={bi("平台设置分区", "Platform settings sections")}
            value={view}
            onChange={switchView}
            items={items.map((i) => ({
              value: i.id,
              label: i.title,
              icon: i.icon,
            }))}
          />
        </div>
      ) : (
        <aside className="st-nav" aria-label={bi("平台设置", "Settings")} ref={nav}>
          <h1>{bi("平台设置", "Settings")}</h1>
          {groups.map((g) => (
            <div key={g.id} className="st-nav-grp">
              <div className="st-nav-g">{g.group}</div>
              {g.items.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className={`sx-nav-i ${view === i.id ? "on" : ""}`}
                  aria-current={view === i.id ? "page" : undefined}
                  onClick={() => switchView(i.id)}
                >
                  <span className="sx-nav-ic">{i.icon}</span>
                  <span className="sx-nav-t">
                    <b>{i.title}</b>
                    <small>{i.hint}</small>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </aside>
      )}
      <div className="st-body">
        {!narrow && activeGroup && activeGroup.items.length > 1 && (
          <div className="st-group-bar" key={`grp-${activeGroup.id}`}>
            <UnderlineTabs
              className="st-subtabs"
              label={bi(
                `${activeGroup.group}设置`,
                `${activeGroup.group} Settings`,
              )}
              value={view}
              onChange={switchView}
              items={activeGroup.items.map((i) => ({
                value: i.id,
                label: i.title,
                icon: i.icon,
              }))}
            />
          </div>
        )}
        <div
          className={`st-pane${paneDir ? ` st-pane-${paneDir}` : ""}`}
          key={`pane-${view}`}
        >
          {body}
        </div>
      </div>
    </div>
  );
}

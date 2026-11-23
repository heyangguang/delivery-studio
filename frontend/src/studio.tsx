import React, { useEffect } from "react";
import { Tooltip } from "@arco-design/web-react";
import { IconBook, IconCode, IconLink } from "@arco-design/web-react/icon";
import { KnowledgePage } from "./kb";
import { SkillsPage } from "./skills";
import { MCPPage } from "./mcp";
import { href } from "./router";
import type { AIStatus } from "./shared";
import { bi, useLang } from "./i18n";
import "./studio.css";

export type StudioTab = "kb" | "skills" | "mcp";

const STUDIO_TAB_KEY = "mh-studio-tab";

export function isStudioRoute(name: string): name is StudioTab {
  return name === "kb" || name === "skills" || name === "mcp";
}

export function rememberStudioTab(tab: StudioTab) {
  try {
    sessionStorage.setItem(STUDIO_TAB_KEY, tab);
  } catch {
    /* ignore */
  }
}

export function enabledStudioTabs(features?: AIStatus["features"]): StudioTab[] {
  const out: StudioTab[] = [];
  if (features?.kb) out.push("kb");
  if (features?.skills) out.push("skills");
  if (features?.mcp) out.push("mcp");
  return out;
}

export function preferredStudioTab(features?: AIStatus["features"]): StudioTab {
  const list = enabledStudioTabs(features);
  try {
    const saved = sessionStorage.getItem(STUDIO_TAB_KEY) as StudioTab | null;
    if (saved && list.includes(saved)) return saved;
  } catch {
    /* ignore */
  }
  return list[0] || "kb";
}

type StudioModule = {
  key: StudioTab;
  label: string;
  tip: string;
  tone: "kb" | "skills" | "mcp";
  icon: React.ReactNode;
};

export function StudioPage({
  active,
  selected,
  features,
}: {
  active: StudioTab;
  selected?: string;
  features?: AIStatus["features"];
}) {
  useLang();

  useEffect(() => {
    rememberStudioTab(active);
  }, [active]);

  const enabled = enabledStudioTabs(features);
  const modules: StudioModule[] = [
    ...(enabled.includes("kb")
      ? [
          {
            key: "kb" as const,
            label: bi("知识库", "Docs"),
            tip: bi(
              "知识库 · 沉淀团队与个人运维资料，供 AI 实时检索引用",
              "Knowledge Base · Team & personal runbooks indexed for AI",
            ),
            tone: "kb" as const,
            icon: <IconBook />,
          },
        ]
      : []),
    ...(enabled.includes("skills")
      ? [
          {
            key: "skills" as const,
            label: bi("技能", "Skills"),
            tip: bi(
              "技能 · 结构化操作规范与安全沙箱脚本",
              "Skills · Structured operational manuals & sandbox scripts",
            ),
            tone: "skills" as const,
            icon: <IconCode />,
          },
        ]
      : []),
    ...(enabled.includes("mcp")
      ? [
          {
            key: "mcp" as const,
            label: "MCP",
            tip: bi(
              "MCP 服务 · 接入外部工具与只读数据源扩展 AI 能力",
              "MCP Servers · Connect external tools & data sources",
            ),
            tone: "mcp" as const,
            icon: <IconLink />,
          },
        ]
      : []),
  ];

  const showRail = modules.length > 1;

  return (
    <div className={`studio-shell${showRail ? "" : " is-single"}`}>
      {showRail && (
        <nav
          className="studio-rail"
          aria-label={bi("能力库导航", "Studio navigation")}
        >
          {modules.map((m) => {
            const on = active === m.key;
            return (
              <Tooltip
                key={m.key}
                position="right"
                content={m.tip}
                mini
                triggerProps={{ mouseEnterDelay: 350 }}
              >
                <a
                  href={href({ name: m.key })}
                  className={`studio-nav-item tone-${m.tone}${on ? " on" : ""}`}
                  aria-current={on ? "page" : undefined}
                >
                  <span className="studio-nav-ic" aria-hidden>
                    {m.icon}
                  </span>
                  <span className="studio-nav-lbl">{m.label}</span>
                </a>
              </Tooltip>
            );
          })}
        </nav>
      )}
      <div className="studio-body">
        {active === "kb" ? (
          <KnowledgePage selected={selected} />
        ) : active === "skills" ? (
          <SkillsPage selected={selected} />
        ) : (
          <MCPPage selected={selected} />
        )}
      </div>
    </div>
  );
}

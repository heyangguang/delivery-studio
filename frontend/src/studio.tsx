import React, { useEffect, useMemo } from "react";
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
  const lang = useLang();

  useEffect(() => {
    rememberStudioTab(active);
  }, [active]);

  const modules = useMemo<StudioModule[]>(() => {
    const enabled = enabledStudioTabs(features);
    return [
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
  }, [features?.kb, features?.skills, features?.mcp, lang]);

  const showTabs = modules.length > 1;
  const studioNav = showTabs ? (
    <nav
      className="studio-tabs"
      aria-label={bi("能力库分类", "Capabilities modules")}
    >
      {modules.map((m) => {
        const on = active === m.key;
        return (
          <Tooltip
            key={m.key}
            position="bottom"
            content={m.tip}
            mini
            triggerProps={{ mouseEnterDelay: 400 }}
          >
            <a
              href={href({ name: m.key })}
              className={`studio-tab tone-${m.tone}${on ? " on" : ""}`}
              aria-current={on ? "page" : undefined}
            >
              <span className="studio-tab-ic" aria-hidden>
                {m.icon}
              </span>
              <span className="studio-tab-lbl">{m.label}</span>
            </a>
          </Tooltip>
        );
      })}
    </nav>
  ) : null;

  return active === "kb" ? (
    <KnowledgePage selected={selected} studioNav={studioNav} />
  ) : active === "skills" ? (
    <SkillsPage selected={selected} studioNav={studioNav} />
  ) : (
    <MCPPage selected={selected} studioNav={studioNav} />
  );
}

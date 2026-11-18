import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Spin } from "@arco-design/web-react";
import {
  IconApps,
  IconBook,
  IconClose,
  IconFile,
  IconList,
  IconLock,
  IconMoon,
  IconPlus,
  IconPoweroff,
  IconSearch,
  IconSettings,
  IconSun,
  IconUser,
  IconUserGroup,
  IconWifi,
} from "@arco-design/web-react/icon";
import {
  can,
  clock,
  dayLabel,
  phaseOf,
  states,
  useAIStatus,
  useConnectivity,
} from "./shared";
import type { AppInfo, Job } from "./shared";
import { go } from "./router";
import type { Route } from "./router";
import { AppGlyph, StatusDot, TabIcon } from "./ui";
import { Spark } from "./aichat";

type Item = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
  keywords?: string;
  mono?: boolean;
};

export type PaletteProps = {
  open: boolean;
  close: () => void;
  jobs: Job[];
  apps: AppInfo[];
  loading?: boolean;
  admin: boolean;
  dark: boolean;
  actions: {
    nav: (to: Route["name"]) => void;
    create: (app: string) => void;
    open: (id: string) => void;
    openApp: (id: string) => void;
    theme: () => void;
    logout: () => void;
  };
};

/** Multi-token match + relevance score so space-separated queries ("pg 配置", "新建 redis") work naturally. */
function scoreMatch(it: Item, tokens: string[], full: string): number {
  if (!tokens.length) return 1;
  const label = it.label.toLowerCase();
  const hint = (it.hint || "").toLowerCase();
  const hay = `${label} ${hint} ${it.group.toLowerCase()} ${(it.keywords || "").toLowerCase()}`;
  for (const t of tokens) {
    if (!hay.includes(t)) return 0;
  }
  if (label === full) return 120;
  if (label.startsWith(full)) return 95;
  let score = 40;
  for (const t of tokens) {
    if (label.startsWith(t)) score += 24;
    else if (label.includes(t)) score += 14;
    else if (hint.includes(t)) score += 6;
  }
  return score;
}

/** The body mounts on open and unmounts on close, so every opening starts clean and hands focus back. */
export function Palette(props: PaletteProps) {
  return props.open ? <PaletteBody {...props} /> : null;
}

function PaletteBody({
  close,
  jobs,
  apps,
  loading,
  admin,
  dark,
  actions,
}: PaletteProps) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastMouse = useRef({ x: -1, y: -1 });
  const restore = useRef<HTMLElement | null>(
    document.activeElement as HTMLElement | null,
  );
  useEffect(() => () => restore.current?.focus?.(), []);

  const net = useConnectivity();
  const aiStatus = useAIStatus();
  const aiOn = aiStatus.enabled;

  const items = useMemo(() => {
    const s = q.trim().toLowerCase();
    const tokens = s ? s.split(/\s+/).filter(Boolean) : [];

    const base: Item[] = [
      ...apps
        .filter((a) => a.available && can("delivery.create"))
        .map<Item>((a) => ({
          id: `new-${a.id}`,
          group: "新建部署",
          label: `新建 ${a.name} 集群`,
          hint: a.category || "向导",
          icon: <IconPlus />,
          run: () => actions.create(a.id),
          keywords: `new create deploy 新建 创建 部署 ${a.id} ${(a.tags || []).join(" ")}`,
        })),
      ...(can("delivery.view|delivery.create")
        ? [
            {
              id: "go-d",
              group: "前往页面",
              label: "交付",
              hint: "集群与部署工作台",
              icon: <IconList />,
              run: () => actions.nav("deliveries"),
              keywords: "deliveries jobs clusters 集群 交付 部署 列表",
            },
          ]
        : []),
      {
        id: "go-a",
        group: "前往页面",
        label: "应用",
        hint: "中间件目录",
        icon: <IconApps />,
        run: () => actions.nav("apps"),
        keywords: "apps catalog store 应用 目录 中间件",
      },
      {
        id: "go-c",
        group: "前往页面",
        label: "组件",
        hint: "组件包与编排规范",
        icon: <TabIcon name="layers" size={15} />,
        run: () => actions.nav("components"),
        keywords: "components workbench import 组件 工坊 导入 组件包 yaml",
      },
      {
        id: "go-l",
        group: "前往页面",
        label: "软件库",
        hint: "离线安装包与系统源",
        icon: <TabIcon name="packages" size={15} />,
        run: () => actions.nav("library"),
        keywords: "library packages 软件包 离线包 软件源 mirror 镜像 rpm deb",
      },
      ...(aiOn && !!aiStatus.features?.assistant && can("ai.use")
        ? [
            {
              id: "go-ai",
              group: "前往页面",
              label: "AI 助手",
              hint: "智能排障与对话",
              icon: <Spark size={15} rainbow />,
              run: () => actions.nav("ai"),
              keywords: "ai assistant chat 助手 问答 对话",
            },
          ]
        : []),
      ...(aiOn && can("ai.use")
        ? [
            {
              id: "go-kb",
              group: "前往页面",
              label: "知识库",
              hint: "运维经验沉淀",
              icon: <IconBook />,
              run: () => actions.nav("kb"),
              keywords: "kb knowledge 知识库 经验 文档",
            },
            {
              id: "go-skills",
              group: "前往页面",
              label: "技能",
              hint: "自动化诊断与操作技能",
              icon: <Spark size={15} />,
              run: () => actions.nav("skills"),
              keywords: "skills 技能",
            },
            {
              id: "go-mcp",
              group: "前往页面",
              label: "MCP 服务",
              hint: "外部工具连接",
              icon: <TabIcon name="terminal" size={15} />,
              run: () => actions.nav("mcp"),
              keywords: "mcp 工具 服务 连接",
            },
          ]
        : []),
      ...(can("iam.user|iam.role|iam.team|audit.view")
        ? [
            {
              id: "go-u",
              group: "前往页面",
              label: "IAM",
              hint: "用户、角色、团队与审计",
              icon: <IconUserGroup />,
              run: () => actions.nav("accounts"),
              keywords: "iam accounts users roles teams audit 用户 角色 团队 权限 审计",
            },
          ]
        : []),
      ...(can(
        "settings.notify|ai.settings|ai.usage|audit.view|settings.report|settings.storage|settings.sandbox|execution.manage",
      )
        ? [
            {
              id: "go-set",
              group: "前往页面",
              label: "平台设置",
              hint: "通知、存储、执行节点与报告模板",
              icon: <IconSettings />,
              run: () => actions.nav("settings"),
              keywords:
                "settings notify webhook 通知 推送 企业微信 钉钉 飞书 设置 存储 沙箱 执行",
            },
          ]
        : []),
      ...(can("ai.settings")
        ? [
            {
              id: "go-ai-settings",
              group: "前往页面",
              label: "AI 套件与模型设置",
              hint: "平台设置",
              icon: <Spark size={15} rainbow={aiOn} />,
              run: () => go({ name: "settings", id: "ai" }),
              keywords: "ai toggle switch 开启 启用 关闭 套件 模型 供应商 设置 演练",
            },
          ]
        : []),
      {
        id: "go-me",
        group: "账户与偏好",
        label: "我的账户",
        hint: "个人信息与权限概览",
        icon: <IconUser />,
        run: () => go({ name: "me" }),
        keywords: "me profile account 我的 账户 个人",
      },
      {
        id: "go-pw",
        group: "账户与偏好",
        label: "修改密码",
        hint: "账户安全",
        icon: <IconLock />,
        run: () => go({ name: "me", id: "security" }),
        keywords: "password security 密码 安全 修改密码",
      },
      {
        id: "theme",
        group: "账户与偏好",
        label: dark ? "切换到浅色外观" : "切换到深色外观",
        hint: dark ? "当前深色" : "当前浅色",
        icon: dark ? <IconSun /> : <IconMoon />,
        run: actions.theme,
        keywords: "theme dark light appearance 主题 外观 深色 浅色 暗黑 明亮",
      },
      {
        id: "out",
        group: "账户与偏好",
        label: "退出登录",
        icon: <IconPoweroff />,
        run: actions.logout,
        keywords: "logout signout 退出 注销",
      },
    ];

    // One representative job per cluster (the newest determines current status)
    const byCluster = new Map<string, Job>();
    for (const j of jobs) {
      const cur = byCluster.get(j.cluster_id);
      if (!cur || j.created > cur.created) byCluster.set(j.cluster_id, j);
    }
    const latestClusters = [...byCluster.values()].sort((a, b) =>
      b.created.localeCompare(a.created),
    );

    const clusterItems: Item[] = latestClusters.map((j) => {
      const ph = phaseOf(j);
      const stText = states[ph] || ph;
      return {
        id: `cl-${j.cluster_id}`,
        group: s ? "集群" : "最近的集群",
        label: j.cluster_id,
        hint: `${j.app_name} · ${stText} · ${dayLabel(j.created)}`,
        icon: <StatusDot state={ph} />,
        run: () => actions.open(j.cluster_id),
        keywords: `cluster 集群 概览 ${j.app_name} ${j.app_id} ${j.version || ""} ${stText}`,
        mono: true,
      };
    });

    if (!s) {
      return [
        ...base.filter((b) => b.group === "新建部署").slice(0, 4),
        ...clusterItems.slice(0, 5),
        ...base.filter((b) => b.group !== "新建部署"),
      ];
    }

    // Deep links to cluster tabs when searching
    const configItems: Item[] =
      /配置|参数|端口|conf|config|yaml|ini/.test(s)
        ? latestClusters.map((j) => ({
            id: `cfg-${j.cluster_id}`,
            group: "集群配置",
            label: `${j.cluster_id} · 配置`,
            hint: `${j.app_name} ${j.version || ""}`.trim(),
            icon: <TabIcon name="config" size={14} />,
            run: () =>
              go({ name: "deliveries", id: j.cluster_id, tab: "config" }),
            keywords: `配置 参数 端口 config yaml ${j.cluster_id} ${j.app_name}`,
          }))
        : [];

    const deployItems: Item[] = jobs
      .slice()
      .sort((a, b) => b.created.localeCompare(a.created))
      .map((j) => {
        const modeLabel =
          j.delivery_mode === "configuration" ? "配置交付" : "部署";
        return {
          id: `job-${j.id}`,
          group: "部署记录",
          label: `${j.cluster_id} · ${modeLabel}`,
          hint: `${dayLabel(j.created)} ${clock(j.created)}`,
          icon: <StatusDot state={phaseOf(j)} />,
          run: () =>
            go({
              name: "deliveries",
              id: j.cluster_id,
              tab: "plans",
              plan: j.id,
            }),
          keywords: `部署 交付 手册 执行 deploy runbook plan ${j.id.slice(0, 8)} ${j.app_name}`,
          mono: true,
        };
      });

    const docItems: Item[] =
      /报告|交接|文档|运维|kt|rca|report|doc|word/.test(s)
        ? latestClusters
            .filter((j) => j.state === "succeeded" || phaseOf(j) === "done")
            .flatMap<Item>((j) => {
              const report: Item = {
                id: `doc-d-${j.cluster_id}`,
                group: "集群文档",
                label: `${j.cluster_id} · 交付报告`,
                hint: j.app_name,
                icon: <IconFile />,
                run: () =>
                  go({
                    name: "deliveries",
                    id: j.cluster_id,
                    tab: "docs",
                    doc: "delivery",
                  }),
                keywords: `交付报告 文档 report word ${j.cluster_id} ${j.app_name}`,
              };
              const kt: Item = {
                id: `doc-k-${j.cluster_id}`,
                group: "集群文档",
                label: `${j.cluster_id} · 运维交接文档`,
                hint: j.app_name,
                icon: <IconFile />,
                run: () =>
                  go({
                    name: "deliveries",
                    id: j.cluster_id,
                    tab: "docs",
                    doc: "kt",
                  }),
                keywords: `运维 交接 文档 kt doc ${j.cluster_id} ${j.app_name}`,
              };
              return /交接|运维|kt/.test(s) ? [kt, report] : [report, kt];
            })
        : [];

    const rehearsalItems: Item[] =
      aiOn &&
      !!aiStatus.features?.change_rehearsal &&
      can("ai.use") &&
      /演练|变更|升级|扩容|缩容|调参|切换|高可用|sop|rehearsal/.test(s)
        ? latestClusters
            .filter(
              (j) =>
                j.delivery_mode !== "configuration" && phaseOf(j) === "done",
            )
            .map((j) => ({
              id: `rh-${j.cluster_id}`,
              group: "变更演练",
              label: `${j.cluster_id} · 变更演练`,
              hint: `${j.app_name} ${j.version || ""}`.trim(),
              icon: <Spark size={14} rainbow />,
              run: () =>
                go({
                  name: "deliveries",
                  id: j.cluster_id,
                  tab: "rehearsal",
                }),
              keywords: `变更演练 演练 升级 扩容 缩容 调参 切换 sop rehearsal ${j.cluster_id} ${j.app_name}`,
            }))
        : [];

    const appItems: Item[] = apps.map((a) => ({
      id: `app-${a.id}`,
      group: "应用目录",
      label: a.available ? a.name : `${a.name}（暂未开放）`,
      hint: [a.category, a.version].filter(Boolean).join(" · "),
      icon: (
        <AppGlyph
          id={a.id}
          category={a.category}
          icon={a.icon}
          color={a.color}
          size={18}
        />
      ),
      run: () => actions.openApp(a.id),
      keywords: `app 应用 ${a.id} ${a.name} ${a.category || ""} ${(a.tags || []).join(" ")}`,
    }));

    const pick = (pool: Item[], limit: number) =>
      pool
        .map((it) => ({ it, sc: scoreMatch(it, tokens, s) }))
        .filter((x) => x.sc > 0)
        .sort((a, b) => b.sc - a.sc)
        .slice(0, limit)
        .map((x) => x.it);

    return [
      ...pick(rehearsalItems, 5),
      ...pick(configItems, 5),
      ...pick(clusterItems, 6),
      ...pick(deployItems, 5),
      ...pick(docItems, 6),
      ...pick(appItems, 5),
      ...pick(base, 10),
    ];
  }, [
    q,
    jobs,
    apps,
    admin,
    dark,
    aiOn,
    aiStatus.features?.assistant,
    aiStatus.features?.change_rehearsal,
  ]);

  const activeIdx = items.length === 0 ? -1 : Math.min(i, items.length - 1);

  useEffect(() => setI(0), [q]);
  useEffect(() => {
    if (activeIdx < 0) return;
    listRef.current
      ?.querySelector(`[data-i="${activeIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const run = (it?: Item) => {
    if (!it) return;
    close();
    it.run();
  };

  let lastGroup = "";
  return createPortal(
    <div
      className="pal-mask"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className="pal"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索与快速跳转"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        <div className="pal-input">
          <IconSearch className="pal-search-ic" />
          <input
            ref={input}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索集群、应用、配置与部署，或跳转页面…"
            aria-label="搜索集群、应用或页面"
            aria-activedescendant={
              activeIdx >= 0 && items[activeIdx]
                ? `pal-${items[activeIdx].id}`
                : undefined
            }
            aria-controls="pal-list"
            role="combobox"
            aria-expanded
            onKeyDown={(e) => {
              if (
                e.key === "ArrowDown" ||
                (e.ctrlKey && e.key.toLowerCase() === "n")
              ) {
                e.preventDefault();
                if (items.length > 0)
                  setI((x) => (Math.min(x, items.length - 1) + 1) % items.length);
              } else if (
                e.key === "ArrowUp" ||
                (e.ctrlKey && e.key.toLowerCase() === "p")
              ) {
                e.preventDefault();
                if (items.length > 0)
                  setI(
                    (x) =>
                      (Math.min(x, items.length - 1) - 1 + items.length) %
                      items.length,
                  );
              } else if (e.key === "Home") {
                e.preventDefault();
                if (items.length > 0) setI(0);
              } else if (e.key === "End") {
                e.preventDefault();
                if (items.length > 0) setI(items.length - 1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (activeIdx >= 0) run(items[activeIdx]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              } else if (e.key === "Tab") {
                e.preventDefault();
              }
            }}
          />
          {loading && (
            <span className="pal-spin" aria-label="正在同步数据">
              <Spin size={14} />
            </span>
          )}
          {q && (
            <button
              type="button"
              className="pal-clear"
              onClick={() => {
                setQ("");
                input.current?.focus();
              }}
              aria-label="清空搜索词"
            >
              <IconClose />
            </button>
          )}
          <kbd>Esc</kbd>
        </div>

        {net !== "online" && (
          <div className="pal-status warn" role="status">
            <IconWifi />
            <span>
              {net === "offline"
                ? "网络已断开，当前仅在已缓存的集群与目录中检索"
                : "暂时无法连接服务，当前显示最近缓存的数据"}
            </span>
          </div>
        )}

        <div className="pal-list" id="pal-list" role="listbox" ref={listRef}>
          {items.length === 0 && loading ? (
            <div className="pal-empty" role="status">
              <Spin size={20} />
              <b>正在载入集群与应用目录…</b>
              <span>请稍候，载入完成后将自动匹配结果</span>
            </div>
          ) : items.length === 0 ? (
            <div className="pal-empty" role="status">
              <span className="pal-empty-ic" aria-hidden>
                <IconSearch />
              </span>
              <b>未找到与「{q.trim()}」匹配的结果</b>
              <span>
                试试搜索集群名称、中间件类型、配置、部署、变更演练或系统设置
              </span>
              {q && (
                <button
                  type="button"
                  className="pal-reset-btn"
                  onClick={() => {
                    setQ("");
                    input.current?.focus();
                  }}
                >
                  清空搜索词
                </button>
              )}
            </div>
          ) : (
            items.map((it, k) => {
              const showGroup = it.group !== lastGroup;
              lastGroup = it.group;
              const selected = k === activeIdx;
              return (
                <React.Fragment key={it.id}>
                  {showGroup && (
                    <div className="pal-group" role="presentation">
                      {it.group}
                    </div>
                  )}
                  <div
                    id={`pal-${it.id}`}
                    data-i={k}
                    role="option"
                    aria-selected={selected}
                    className={`pal-item${selected ? " on" : ""}`}
                    onMouseMove={(e) => {
                      if (
                        e.clientX === lastMouse.current.x &&
                        e.clientY === lastMouse.current.y
                      )
                        return;
                      lastMouse.current = { x: e.clientX, y: e.clientY };
                      if (k !== activeIdx) setI(k);
                    }}
                    onClick={() => run(it)}
                  >
                    <span className="pal-ico" aria-hidden>
                      {it.icon}
                    </span>
                    <span className={`pal-label${it.mono ? " mono" : ""}`}>
                      {it.label}
                    </span>
                    {it.hint && <span className="pal-hint num">{it.hint}</span>}
                  </div>
                </React.Fragment>
              );
            })
          )}
        </div>

        <div className="pal-foot">
          <div className="pal-foot-keys">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> 选择
            </span>
            <span>
              <kbd>↵</kbd> 打开
            </span>
            <span>
              <kbd>Esc</kbd> 关闭
            </span>
          </div>
          {q.trim() && items.length > 0 && (
            <span className="pal-foot-count num">{items.length} 项匹配</span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import { TopoArt } from "./topoart";
import { styleOf } from "./glyphs";
import {
  Menu,
  Button,
  Checkbox,
  Input,
  Skeleton,
  Tag,
  Timeline,
} from "@arco-design/web-react";
import {
  IconApps,
  IconLayout,
  IconArchive,
  IconArrowLeft,
  IconBook,
  IconCode,
  IconExclamationCircle,
  IconFile,
  IconList,
  IconMinusCircle,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSafe,
  IconSearch,
  IconStorage,
} from "@arco-design/web-react/icon";
import {
  ago,
  phaseOf,
  clock,
  dayLabel,
  size,
  states,
  typing,
  useMedia,
  useStored,
  can,
} from "./shared";
import type { AppInfo, AppPlan, Job } from "./shared";
import { go } from "./router";
import {
  AppGlyph,
  FilterChip,
  Kbd,
  Segmented,
  StatusBadge,
  StatusDot,
  UnderlineTabs,
  tintOf,
} from "./ui";

import type { LoadState } from "./deliveries";

const shortVersion = (v: string) => v.split("·")[0].trim();
const platformParts = (p: string) => p.split("/").map((x) => x.trim());
const tagline = (a: AppInfo) => a.detail?.tagline || a.description;

/** Banner colours per category: a lit corner fading into a dark base. */
const heroStyle = (a: AppInfo) => {
  const [c0, c1] = styleOf(a.id, a.category, a.icon, a.color).color.hero;
  return { "--h0": c0, "--h1": c1 } as React.CSSProperties;
};

/** Plans to show for an app: the ready-made starting points its component declares. */
const plansOf = (a: AppInfo): AppPlan[] => a.plans || [];

/* ---------- art ---------- */

/** Tiny topology glyph for a plan card. */
function PlanGlyph({ topology }: { topology: AppPlan["topology"] }) {
  const c = (role: string) => topology.find((t) => t.role === role)?.count ?? 0;
  const n = Math.max(c("primary"), 1) + c("replica");
  const s = c("sentinel");
  const w = 18,
    gap = 6;
  const W = Math.max(n * w + (n - 1) * gap, 44);
  const x0 = (W - (n * w + (n - 1) * gap)) / 2;
  return (
    <svg className="plan-glyph" viewBox={`-2 0 ${W + 4} 44`} aria-hidden>
      {Array.from({ length: s }, (_, i) => {
        const cx = (W / (s + 1)) * (i + 1);
        return (
          <g key={i}>
            <path d={`M${cx} 10 L${x0 + w / 2} 26`} className="pg-idle" />
            <rect
              x={cx - 4}
              y={4}
              width={8}
              height={8}
              rx={2}
              transform={`rotate(45 ${cx} 8)`}
              className="pg-sen"
            />
          </g>
        );
      })}
      {s === 0 && <circle cx={W / 2} cy={6} r={4} className="pg-elb" />}
      {Array.from({ length: n }, (_, i) => {
        const x = x0 + i * (w + gap);
        return (
          <g key={i}>
            {s === 0 && (
              <path
                d={`M${W / 2} 10 L${x + w / 2} 26`}
                className={i === 0 ? "pg-live" : "pg-idle"}
              />
            )}
            <rect
              x={x}
              y={26}
              width={w}
              height={14}
              rx={4}
              className={i === 0 ? "pg-p" : "pg-r"}
            />
          </g>
        );
      })}
    </svg>
  );
}

function Plans({ app, plans }: { app: AppInfo; plans: AppPlan[] }) {
  const off = !app.available || !can("delivery.create");
  return (
    <div className="plan-cards">
      {plans.map((p) => (
        <button
          key={p.id}
          className="plan-card"
          disabled={off}
          onClick={() => go({ name: "new", app: app.id, plan: p.id })}
        >
          <PlanGlyph topology={p.topology} />
          {p.tag && <span className="plan-card-tag">{p.tag}</span>}
          <strong>{p.name}</strong>
          <span className="plan-card-spec">{p.spec}</span>
          <span className="plan-card-go">
            {off ? (
              !app.available ? (
                "暂未开放"
              ) : (
                ""
              )
            ) : (
              <>
                用此方案新建 <IconRight />
              </>
            )}
          </span>
        </button>
      ))}
      <button
        className="plan-card custom"
        disabled={off}
        onClick={() => go({ name: "new", app: app.id })}
      >
        <span className="plan-glyph-custom" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="plan-card-tag">自由组合</span>
        <strong>自定义</strong>
        <span className="plan-card-spec">节点、复制、加密与参数逐项决定</span>
        <span className="plan-card-go">
          {off ? (
            !app.available ? (
              "暂未开放"
            ) : (
              ""
            )
          ) : (
            <>
              从空白开始 <IconRight />
            </>
          )}
        </span>
      </button>
    </div>
  );
}

/* ---------- catalog filtering ---------- */

type Filters = {
  q: string;
  cat: string;
  tags: string[];
  only: boolean;
  mine: boolean;
  sort: "rec" | "name" | "recent";
  view: "wide" | "grid" | "list";
};
const DEFAULTS: Filters = {
  q: "",
  cat: "全部",
  tags: [],
  only: false,
  mine: false,
  sort: "rec",
  view: "wide",
};
const isDefault = (f: Filters) =>
  !f.q && f.cat === "全部" && !f.tags.length && !f.only && !f.mine;
const SORTS: { value: Filters["sort"]; label: string }[] = [
  { value: "rec", label: "推荐" },
  { value: "recent", label: "最近使用" },
  { value: "name", label: "名称" },
];

const VIEWS: { value: Filters["view"]; label: React.ReactNode }[] = [
  {
    value: "wide",
    label: (
      <>
        <IconLayout />
        <span className="seg-text">详细</span>
      </>
    ),
  },
  {
    value: "grid",
    label: (
      <>
        <IconApps />
        <span className="seg-text">网格</span>
      </>
    ),
  },
  {
    value: "list",
    label: (
      <>
        <IconList />
        <span className="seg-text">列表</span>
      </>
    ),
  },
];

type Usage = Map<string, { count: number; last: string }>;
const usageOf = (jobs: Job[]): Usage => {
  const m: Usage = new Map();
  for (const j of jobs) {
    const u = m.get(j.app_id) || { count: 0, last: "" };
    u.count++;
    if (j.created > u.last) u.last = j.created;
    m.set(j.app_id, u);
  }
  return m;
};

/** `skip` leaves one facet out, so its own counts show what selecting each option would give. */
function matchApp(a: AppInfo, f: Filters, usage: Usage, skip?: "cat" | "tags") {
  const q = f.q.trim().toLowerCase();
  if (
    q &&
    !`${a.name} ${a.version} ${a.category || ""} ${a.description} ${a.detail?.tagline || ""} ${(a.tags || []).join(" ")}`
      .toLowerCase()
      .includes(q)
  )
    return false;
  if (skip !== "cat" && f.cat !== "全部" && (a.category || "其他") !== f.cat)
    return false;
  if (skip !== "tags" && f.tags.some((t) => !(a.tags || []).includes(t)))
    return false;
  if (f.only && !a.available) return false;
  if (f.mine && !usage.has(a.id)) return false;
  return true;
}

/** Opens the deliveries page narrowed to one app. */
function showDeliveriesOf(app: string) {
  try {
    const cur = JSON.parse(sessionStorage.getItem("mh-del-filters") || "{}");
    sessionStorage.setItem(
      "mh-del-filters",
      JSON.stringify({
        ...cur,
        q: "",
        status: "all",
        range: "all",
        apps: [app],
      }),
    );
  } catch {
    /* storage may be unavailable; the page still opens */
  }
  go({ name: "deliveries" });
}

const badge = (a: AppInfo) => (
  <StatusBadge
    state={a.available ? "succeeded" : "queued"}
    label={a.available ? "可生成" : "暂未开放"}
  />
);

function AppTile({ a, usage }: { a: AppInfo; usage: Usage }) {
  const used = usage.get(a.id);
  const plans = plansOf(a);
  const caps = (a.detail?.capabilities || []).map((c) => c.name);
  return (
    <article className={`tile2 ${a.available ? "" : "off"}`}>
      <div className="tile2-head">
        <AppGlyph
          id={a.id}
          category={a.category}
          size={48}
          muted={!a.available}
        />
        <div className="tile2-title">
          <a className="tile2-link" href={`#/apps/${a.id}`}>
            {a.name}
          </a>
          <span>
            <i
              className="cat-dot"
              style={{
                background: `linear-gradient(${tintOf(a.category).join(",")})`,
              }}
              aria-hidden
            />
            {a.category || "中间件"} · {shortVersion(a.version)}
          </span>
        </div>
      </div>
      <p>{tagline(a)}</p>
      <dl className="tile2-facts">
        <div>
          <dt>方案</dt>
          <dd title={plans.map((p) => p.name).join(" · ")}>
            {plans.length ? plans.map((p) => p.name).join(" · ") : "按需组合"}
          </dd>
        </div>
        <div>
          <dt>能力</dt>
          <dd title={caps.join(" · ")}>
            {caps.length ? caps.join(" · ") : (a.tags || []).join(" · ") || "—"}
          </dd>
        </div>
      </dl>
      <div className="tile2-foot">
        <span className="tile2-meta num">
          <span>{a.detail?.scale || a.platform}</span>
          {used ? <span>我的交付 {used.count}</span> : null}
        </span>
        {a.available && can("delivery.create") ? (
          <Button
            className="tile2-new"
            size="small"
            icon={<IconPlus />}
            onClick={() => go({ name: "new", app: a.id })}
            aria-label={`新建 ${a.name} 集群`}
          >
            新建集群
          </Button>
        ) : a.available ? null : (
          badge(a)
        )}
      </div>
    </article>
  );
}

function AppRow({ a, usage }: { a: AppInfo; usage: Usage }) {
  const used = usage.get(a.id);
  const plans = plansOf(a);
  const caps = (a.detail?.capabilities || []).map((c) => c.name);
  return (
    <div className={`cat-row ${a.available ? "" : "off"}`}>
      <AppGlyph
        id={a.id}
        category={a.category}
        size={44}
        muted={!a.available}
      />
      <div className="cat-main">
        <div className="cat-top">
          <a className="tile2-link" href={`#/apps/${a.id}`}>
            {a.name}
          </a>
          <span className="muted small">{a.version}</span>
        </div>
        <p>{tagline(a)}</p>
      </div>
      <div className="cat-mid">
        {caps.length > 0 && (
          <span
            className="cat-caps small"
            title={(a.detail?.capabilities || [])
              .map((c) => `${c.name}：${c.text}`)
              .join("\n")}
          >
            {caps.slice(0, 4).join(" · ")}
          </span>
        )}
        <div className="cat-tags">
          {plans.length > 0 && (
            <span className="cat-plans">{plans.length} 个方案</span>
          )}
          {(a.tags || []).slice(0, 3).map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>
      <div className="cat-side">
        <span className="muted small">{a.category || "中间件"}</span>
        <span className="muted small">{a.detail?.scale || a.platform}</span>
        {used && <span className="muted small num">我的交付 {used.count}</span>}
      </div>
      {badge(a)}
      {a.available && can("delivery.create") ? (
        <Button
          size="small"
          icon={<IconPlus />}
          onClick={() => go({ name: "new", app: a.id })}
          aria-label={`新建 ${a.name} 集群`}
        >
          新建
        </Button>
      ) : (
        <span className="cat-gap" />
      )}
    </div>
  );
}

/** A catalog entry with everything needed to act on it: its plans start a delivery, its recent deliveries open. */
function AppWide({ a, mine }: { a: AppInfo; mine: Job[] }) {
  const plans = plansOf(a);
  const canCreate = can("delivery.create");
  const [accent] = styleOf(a.id, a.category, a.icon, a.color).color.hero;
  const recent = [...mine]
    .sort((x, y) => y.created.localeCompare(x.created))
    .slice(0, 3);
  return (
    <article
      className={`appwide ${a.available ? "" : "off"}`}
      style={{ "--app-accent": accent } as React.CSSProperties}
    >
      <div className="wide-head">
        <div className="wide-id">
          <AppGlyph
            id={a.id}
            category={a.category}
            icon={a.icon}
            color={a.color}
            size={52}
            muted={!a.available}
          />
          <div>
            <div className="wide-name">
              <a className="tile2-link" href={`#/apps/${a.id}`}>
                {a.name}
              </a>
              {badge(a)}
            </div>
            <div className="wide-subline">
              <span className="wide-ver">{shortVersion(a.version)}</span>
              <span className="wide-dot">·</span>
              <span>{a.category || "中间件"}</span>
              <span className="wide-dot">·</span>
              <span>{a.detail?.scale || a.platform}</span>
            </div>
            <p>{a.available ? tagline(a) : a.reason || "暂未开放，敬请期待"}</p>
            {(a.tags?.length || 0) > 0 && (
              <div className="tile2-tags">
                {(a.tags || []).slice(0, 5).map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            )}
          </div>
        </div>
        {(a.detail?.capabilities?.length || 0) > 0 && (
          <dl className="wide-caps" aria-label="能力要点">
            {a.detail!.capabilities!.slice(0, 3).map((c) => (
              <div key={c.name}>
                <dt>{c.name}</dt>
                <dd title={c.text}>{c.text}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="wide-actions">
          {a.available && canCreate && (
            <Button
              type="primary"
              icon={<IconPlus />}
              onClick={() => go({ name: "new", app: a.id })}
              aria-label={`新建 ${a.name} 集群`}
            >
              新建
            </Button>
          )}
          <Button
            className="wide-more-btn"
            type="text"
            onClick={() => go({ name: "apps", id: a.id })}
          >
            详情 <IconRight />
          </Button>
        </div>
      </div>
      {(plans.length > 0 || recent.length > 0) && (
        <div
          className={`wide-body ${plans.length && recent.length ? "" : "solo"}`}
        >
          {plans.length > 0 && (
            <div className="wide-col">
              <h3>
                <span>从架构方案起步</span>
                {!recent.length && a.available && (
                  <em>尚未创建该应用交付</em>
                )}
              </h3>
              <ul className="wide-plans">
                {plans.slice(0, 4).map((p) => (
                  <li key={p.id}>
                    <button
                      disabled={!a.available || !canCreate}
                      onClick={() => go({ name: "new", app: a.id, plan: p.id })}
                      aria-label={`用${p.name}方案新建 ${a.name} 集群`}
                    >
                      <span className="wide-plan-well">
                        <PlanGlyph topology={p.topology} />
                      </span>
                      <span className="wide-plan-copy">
                        <b>
                          {p.name}
                          {p.tag && <i className="wide-plan-tag">{p.tag}</i>}
                        </b>
                        <small>{p.spec}</small>
                      </span>
                      {a.available && canCreate && <IconRight />}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {recent.length > 0 && (
            <div className="wide-col jobs">
              <h3>
                我的交付 <em className="num">{mine.length}</em>
              </h3>
              <ul className="wide-jobs">
                {recent.map((j) => (
                  <li key={j.id}>
                    <a href={`#/d/${encodeURIComponent(j.cluster_id)}`}>
                      <StatusDot state={phaseOf(j)} />
                      <span className="mono">{j.cluster_id}</span>
                      <small className="num">{ago(j.created)}</small>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** A delivery as a timeline entry: status on the rail, name and app in the body, time as the label. */
function JobTimeline({
  jobs,
  apps,
  empty,
}: {
  jobs: Job[];
  apps?: Map<string, AppInfo>;
  empty: React.ReactNode;
}) {
  if (!jobs.length) return <div className="side-empty">{empty}</div>;
  return (
    <Timeline className="job-tl">
      {jobs.map((j) => {
        const a = apps?.get(j.app_id);
        return (
          <Timeline.Item key={j.id} dot={<StatusDot state={phaseOf(j)} />}>
            <a
              className="job-tl-item"
              href={`#/d/${encodeURIComponent(j.cluster_id)}`}
            >
              <span className="mono">{j.cluster_id}</span>
              <span
                className="muted small num"
                title={`${dayLabel(j.created)} ${clock(j.created)}`}
              >
                {a ? `${a.name} · ` : ""}
                {states[phaseOf(j)]} · {ago(j.created)}
              </span>
            </a>
          </Timeline.Item>
        );
      })}
    </Timeline>
  );
}

export function AppsPage({
  apps,
  load,
  reload,
  selected,
  jobs,
}: {
  apps: AppInfo[];
  load: LoadState;
  reload: () => void;
  selected?: string;
  jobs: Job[];
}) {
  const [f, setF] = useStored<Filters>("mh-apps-filters", DEFAULTS);
  const set = (p: Partial<Filters>) => setF((c) => ({ ...c, ...p }));
  const usage = useMemo(() => usageOf(jobs), [jobs]);
  const search = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        document.querySelector(".pal-mask")
      )
        return;
      if (e.key === "/" && !typing(e)) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const cats = useMemo(() => {
    const m = new Map<string, number>();
    apps
      .filter((a) => matchApp(a, f, usage, "cat"))
      .forEach((a) =>
        m.set(a.category || "其他", (m.get(a.category || "其他") || 0) + 1),
      );
    const all = new Map<string, number>();
    apps.forEach((a) =>
      all.set(a.category || "其他", (all.get(a.category || "其他") || 0) + 1),
    );
    return [...all.keys()]
      .sort((a, b) => all.get(b)! - all.get(a)! || a.localeCompare(b))
      .map((c) => [c, m.get(c) || 0] as [string, number]);
  }, [apps, f.q, f.tags, f.only, f.mine, usage]);
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    apps
      .filter((a) => matchApp(a, f, usage, "tags"))
      .forEach((a) =>
        (a.tags || []).forEach((t) => m.set(t, (m.get(t) || 0) + 1)),
      );
    f.tags.forEach((t) => m.has(t) || m.set(t, 0));
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 16);
  }, [apps, f.q, f.cat, f.only, f.mine, f.tags, usage]);
  const list = useMemo(() => {
    const l = apps.filter((a) => matchApp(a, f, usage));
    const byName = (a: AppInfo, b: AppInfo) => a.name.localeCompare(b.name);
    return l.sort(
      f.sort === "name"
        ? byName
        : f.sort === "recent"
          ? (a, b) =>
              (usage.get(b.id)?.last || "").localeCompare(
                usage.get(a.id)?.last || "",
              ) || byName(a, b)
          : (a, b) =>
              Number(b.available) - Number(a.available) ||
              (usage.get(b.id)?.count || 0) - (usage.get(a.id)?.count || 0) ||
              byName(a, b),
    );
  }, [apps, f, usage]);

  const app = apps.find((a) => a.id === selected);
  if (selected) {
    if (app)
      return (
        <Product
          key={app.id}
          app={app}
          jobs={jobs.filter((j) => j.app_id === app.id)}
        />
      );
    if (load === "loading")
      return (
        <div className="product-wrap enter">
          <Skeleton
            animation
            text={{ rows: 6, width: ["35%", "80%", "60%", "95%", "70%", "50%"] }}
          />
        </div>
      );
    return (
      <div className="detail-none enter">
        <h2>找不到这个应用</h2>
        <p>应用目录中没有这一项。</p>
        <Button onClick={() => go({ name: "apps" }, { replace: true })}>
          返回应用
        </Button>
      </div>
    );
  }

  const plain = isDefault(f);
  const grouped = plain;
  const byCat = (() => {
    const m = new Map<string, AppInfo[]>();
    list.forEach((a) =>
      m.set(a.category || "其他", [...(m.get(a.category || "其他") || []), a]),
    );
    const entries = [...m.entries()];
    if (f.sort !== "rec") return entries;
    return entries.sort(
      (x, y) =>
        y[1].filter((a) => a.available).length -
          x[1].filter((a) => a.available).length ||
        y[1].length - x[1].length ||
        x[0].localeCompare(y[0]),
    );
  })();
  const totalApps = cats.length ? apps.length : 0;
  const clear = () => set({ ...DEFAULTS, view: f.view, sort: f.sort });

  const jobsOf = (id: string) => jobs.filter((j) => j.app_id === id);
  const grid = (items: AppInfo[]) =>
    f.view === "wide" ? (
      <div className="wides">
        {items.map((a) => (
          <AppWide key={a.id} a={a} mine={jobsOf(a.id)} />
        ))}
      </div>
    ) : f.view === "grid" ? (
      <div className="tiles2">
        {items.map((a) => (
          <AppTile key={a.id} a={a} usage={usage} />
        ))}
      </div>
    ) : (
      <div className="catalog">
        {items.map((a) => (
          <AppRow key={a.id} a={a} usage={usage} />
        ))}
      </div>
    );

  const rail = (
    <aside className="store-rail" aria-label="筛选应用">
      <Input
        ref={(r) => {
          search.current =
            (r as unknown as { dom?: HTMLInputElement })?.dom ?? null;
        }}
        prefix={<IconSearch />}
        suffix={!f.q ? <Kbd>/</Kbd> : undefined}
        allowClear
        placeholder="搜索名称、标签、说明"
        value={f.q}
        onChange={(v) => set({ q: v })}
        onKeyDown={(e) => {
          if (e.key === "Escape")
            (set({ q: "" }), (e.target as HTMLInputElement).blur());
        }}
        aria-label="搜索应用"
      />
      <nav className="rail-group" aria-label="分类">
        <h3>分类</h3>
        <button
          className={f.cat === "全部" ? "on" : ""}
          onClick={() => set({ cat: "全部" })}
        >
          <span>全部</span>
          <em className="num">
            {apps.filter((a) => matchApp(a, f, usage, "cat")).length}
          </em>
        </button>
        {cats.map(([c, n]) => (
          <button
            key={c}
            className={f.cat === c ? "on" : ""}
            onClick={() => set({ cat: c })}
            disabled={!n && f.cat !== c}
          >
            <span className="rail-cat">
              <i
                style={{
                  background: `linear-gradient(${tintOf(c).join(",")})`,
                }}
                aria-hidden
              />
              {c}
            </span>
            <em className="num">{n}</em>
          </button>
        ))}
      </nav>
      {tags.length > 0 && (
        <div className="rail-group" role="group" aria-label="标签">
          <h3>标签</h3>
          <div className="rail-tags">
            {tags.map(([t, n]) => {
              const on = f.tags.includes(t);
              return (
                <Tag
                  key={t}
                  checkable
                  checked={on}
                  className={!n && !on ? "dim" : ""}
                  onCheck={() =>
                    (n || on) &&
                    set({
                      tags: on ? f.tags.filter((x) => x !== t) : [...f.tags, t],
                    })
                  }
                  role="button"
                  aria-pressed={on}
                  tabIndex={0}
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if ((e.key === "Enter" || e.key === " ") && (n || on))
                      (e.preventDefault(),
                        set({
                          tags: on
                            ? f.tags.filter((x) => x !== t)
                            : [...f.tags, t],
                        }));
                  }}
                >
                  {t}
                  <em className="num">{n}</em>
                </Tag>
              );
            })}
          </div>
        </div>
      )}
      <div className="rail-group" role="group" aria-label="范围">
        <h3>范围</h3>
        <Checkbox
          className="rail-check"
          checked={f.only}
          onChange={(c) => set({ only: c })}
        >
          只看可生成
        </Checkbox>
        <Checkbox
          className="rail-check"
          checked={f.mine}
          onChange={(c) => set({ mine: c })}
        >
          我用过的
        </Checkbox>
      </div>
    </aside>
  );

  return (
    <div className="store2">
      {rail}
      <main className="store-main">
        <header className="store-bar">
          <div>
            <h1>应用</h1>
            <p className="muted small num" aria-live="polite">
              {load === "ready"
                ? plain
                  ? `共 ${totalApps} 个应用，${apps.filter((a) => a.available).length} 个可生成`
                  : `${list.length} / ${apps.length} 个应用`
                : "正在加载…"}
            </p>
          </div>
          <div className="store-bar-tools">
            <Segmented
              label="排序"
              value={f.sort}
              onChange={(v) => set({ sort: v })}
              options={SORTS}
            />
            <Segmented
              label="显示方式"
              value={f.view}
              onChange={(v) => set({ view: v })}
              options={VIEWS}
            />
          </div>
        </header>

        {!plain && (
          <div className="active-filters" aria-label="已选筛选">
            {f.q && (
              <FilterChip label={f.q} onClose={() => set({ q: "" })}>
                “{f.q}”
              </FilterChip>
            )}
            {f.cat !== "全部" && (
              <FilterChip label={f.cat} onClose={() => set({ cat: "全部" })} />
            )}
            {f.tags.map((t) => (
              <FilterChip
                key={t}
                label={t}
                onClose={() => set({ tags: f.tags.filter((x) => x !== t) })}
              />
            ))}
            {f.only && (
              <FilterChip
                label="只看可生成"
                onClose={() => set({ only: false })}
              />
            )}
            {f.mine && (
              <FilterChip
                label="我用过的"
                onClose={() => set({ mine: false })}
              />
            )}
            <button className="link" onClick={clear}>
              清除全部
            </button>
          </div>
        )}

        {load === "loading" && !apps.length ? (
          <div className="feature skeleton">
            <Skeleton
              animation
              text={{ rows: 3, width: ["30%", "60%", "40%"] }}
            />
          </div>
        ) : load === "error" && !apps.length ? (
          <div className="list-state">
            <IconExclamationCircle className="bad" />
            <p>应用目录加载失败</p>
            <Button size="small" icon={<IconRefresh />} onClick={reload}>
              重试
            </Button>
          </div>
        ) : !apps.length ? (
          <div className="list-state">
            <p>应用目录为空，需要管理员在服务端添加应用</p>
          </div>
        ) : (
          <>
            {!list.length ? (
              <div className="list-state big">
                <IconSearch />
                <p>没有符合条件的应用</p>
                <span className="muted small">
                  {f.q
                    ? "试试更短的关键词，或去掉标签和范围限制"
                    : "放宽筛选条件看看"}
                </span>
                <Button onClick={clear}>清除全部筛选</Button>
              </div>
            ) : f.view === "grid" ? (
              // One aligned grid; every tile says its category, so no lane is left half empty.
              <section className="store-sec">
                {grid(grouped ? byCat.flatMap(([, items]) => items) : list)}
              </section>
            ) : grouped ? (
              <>
                {byCat.map(([c, items]) => (
                  <section className="store-sec" key={c} aria-label={c}>
                    <h2 className="dsec-title">
                      <i
                        className="cat-dot"
                        style={{
                          background: `linear-gradient(${tintOf(c).join(",")})`,
                        }}
                        aria-hidden
                      />
                      {c} <span className="dsec-count num">{items.length}</span>
                      {items.some((a) => !a.available) && (
                        <span className="dsec-note">
                          {items.filter((a) => a.available).length} 个可生成
                        </span>
                      )}
                    </h2>
                    {grid(items)}
                  </section>
                ))}
              </>
            ) : (
              <section className="store-sec">{grid(list)}</section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/* ---------- product page ---------- */

type PaneId = "plans" | "contents" | "caps" | "materials" | "jobs";
const ProdIcons: Record<PaneId, React.ReactNode> = {
  plans: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </svg>
  ),
  contents: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <path d="M8 2.2L13.5 5v6L8 13.8 2.5 11V5L8 2.2Z" />
      <path d="M2.5 5L8 7.8 13.5 5M8 7.8v6" />
    </svg>
  ),
  caps: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <path d="M8 2.2L13 4.1v3.7c0 3.1-2.1 5.2-5 6-2.9-.8-5-2.9-5-6V4.1L8 2.2Z" />
      <path d="M5.8 8.1l1.5 1.5 2.9-3" />
    </svg>
  ),
  materials: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <ellipse cx="8" cy="4.3" rx="5.2" ry="2.1" />
      <path d="M2.8 4.3V8c0 1.2 2.3 2.1 5.2 2.1S13.2 9.2 13.2 8V4.3" />
      <path d="M2.8 8v3.7c0 1.2 2.3 2.1 5.2 2.1s5.2-.9 5.2-2.1V8" />
    </svg>
  ),
  jobs: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2.2 1.4" />
    </svg>
  ),
};
const PANES: [PaneId, string, React.ReactNode][] = [
  ["plans", "方案", ProdIcons.plans],
  ["contents", "交付内容", ProdIcons.contents],
  ["caps", "能力与边界", ProdIcons.caps],
  ["materials", "版本与材料", ProdIcons.materials],
  ["jobs", "我的交付", ProdIcons.jobs],
];

/** An icon for a delivery item, picked from what it is. */
const contentIcon = (name: string) =>
  /仓库/.test(name) ? (
    <IconStorage />
  ) : /手册/.test(name) ? (
    <IconBook />
  ) : /校验|证书/.test(name) ? (
    <IconSafe />
  ) : /Ansible|自动化/.test(name) ? (
    <IconCode />
  ) : /包/.test(name) ? (
    <IconArchive />
  ) : (
    <IconFile />
  );

function Product({ app, jobs }: { app: AppInfo; jobs: Job[] }) {
  const d = app.detail;
  const plans = plansOf(app);
  const [os] = platformParts(app.platform);
  const offline = app.materials?.find((m) => m.kind === "offline");
  const wide = useMedia("(min-width: 1101px)");
  const [tab, setTab] = useState<PaneId>("plans");
  const shown = PANES.filter(([id]) =>
    id === "plans"
      ? plans.length || !app.available
      : id === "contents"
        ? d?.includes?.length
        : id === "caps"
          ? d?.capabilities?.length || d?.limits?.length
          : true,
  );
  const pane = shown.some(([id]) => id === tab) ? tab : shown[0][0];
  const latest = useMemo(
    () => [...jobs].sort((a, b) => b.created.localeCompare(a.created)),
    [jobs],
  );
  // what the library can deliver now: the systems whose packages are all in place
  const ready = [
    ...new Set(
      app.versions.flatMap((v) =>
        Object.entries(v.coverage || {})
          .filter(([, c]) => c.ready && c.deployable)
          .map(([pl]) => pl),
      ),
    ),
  ];
  const info: [string, React.ReactNode][] = [
    ["规模", d?.scale || "—"],
    ["版本", app.versions.map((v) => v.id).join(" · ") || "—"],
    ["系统", os || "—"],
    [
      "软件库",
      ready.length
        ? `${ready.length} 个系统可生成`
        : offline
          ? size(offline.bytes)
          : "还没备齐",
    ],
    ["我的交付", String(jobs.length)],
  ];

  return (
    <div className="product">
      <div className="product-wrap">
        <Button
          type="text"
          className="back"
          icon={<IconArrowLeft />}
          onClick={() => go({ name: "apps" })}
        >
          应用{app.category ? ` · ${app.category}` : ""}
        </Button>
        <header
          className={`product-banner ${app.available ? "" : "off"}`}
          style={heroStyle(app)}
        >
          <div className="product-banner-copy">
            <div className="product-ident">
              <AppGlyph
                id={app.id}
                category={app.category}
                size={72}
                muted={!app.available}
              />
              <div>
                <span className="feature-cat">{app.category || "中间件"}</span>
                <h1>{app.name}</h1>
                <span className="product-ver">{app.version}</span>
              </div>
            </div>
            <p className="product-tagline">{d?.tagline || app.description}</p>
            {app.tags && (
              <div className="product-tags">
                {app.tags.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            )}
            <div className="row-gap">
              {can("delivery.create") && (
                <Button
                  size="large"
                  className="feature-cta"
                  icon={<IconPlus />}
                  disabled={!app.available}
                  onClick={() => go({ name: "new", app: app.id })}
                >
                  新建集群
                </Button>
              )}
              {!app.available && (
                <span className="product-off">{app.reason || "暂不可用"}</span>
              )}
            </div>
          </div>
          <TopoArt app={app} plan={plans[1] || plans[0]} />
        </header>

        <dl className="info-strip">
          {info.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="num">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="product-body">
          <div className="product-main">
            <UnderlineTabs
              className="product-utabs"
              label="应用详情分区"
              value={pane}
              onChange={(v) => setTab(v as PaneId)}
              items={shown.map(([id, label, icon]) => ({
                value: id,
                label,
                count:
                  id === "plans"
                    ? plans.length || undefined
                    : id === "contents"
                      ? d?.includes?.length || undefined
                      : id === "jobs"
                        ? jobs.length || undefined
                        : undefined,
                icon,
              }))}
            />
            <div className="product-pane-body enter" key={pane}>
            {pane === "plans" && !app.available && (
              <div className="callout c-run">
                <IconExclamationCircle />
                <div>
                  <b>这个应用还不能生成交付</b>
                  <span>
                    这个应用暂未开放新建。下面是计划支持的范围，验证通过后开放。
                  </span>
                </div>
              </div>
            )}
            {pane === "plans" &&
              d?.tagline &&
              app.description !== d.tagline && (
                <p className="lead">{app.description}</p>
              )}

            {pane === "plans" && plans.length > 0 && (
              <section className="store-sec" id="p-plans">
                <h2 className="dsec-title">
                  方案{" "}
                  <span className="dsec-note">
                    {app.available
                      ? "选一个起点，之后每一项都能改"
                      : "计划提供的起点"}
                  </span>
                </h2>
                <Plans app={app} plans={plans} />
              </section>
            )}

            {pane === "contents" && !!d?.includes?.length && (
              <section className="store-sec" id="p-contents">
                <h2 className="dsec-title">每次交付包含</h2>
                <ul className="contents">
                  {d.includes.map((c) => (
                    <li key={c.name}>
                      <span className="ct-ico" aria-hidden>
                        {contentIcon(c.name)}
                      </span>
                      <div>
                        <b>{c.name}</b>
                        <span>{c.text}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {pane === "caps" &&
              (!!d?.capabilities?.length || !!d?.limits?.length) && (
                <section className="store-sec" id="p-caps">
                  <h2 className="dsec-title">
                    {app.available ? "能力与边界" : "计划能力与边界"}
                  </h2>
                  {!!d?.capabilities?.length && (
                    <dl className="caps2">
                      {d.capabilities.map((c) => (
                        <div key={c.name}>
                          <dt>{c.name}</dt>
                          <dd>{c.text}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {!!d?.limits?.length && (
                    <div className="limits2">
                      <b>不在范围内</b>
                      <ul>
                        {d.limits.map((l) => (
                          <li key={l}>
                            <IconMinusCircle />
                            {l}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )}

            {pane === "materials" && (
              <section className="store-sec" id="p-materials">
                <h2 className="dsec-title">版本与材料</h2>
                <div className="spec-rows">
                  {app.versions.map((v) => (
                    <div key={v.id}>
                      <span>版本</span>
                      <b>{v.id}</b>
                      <span
                        className={v.status === "published" ? "faint" : "warn"}
                      >
                        {v.status === "published"
                          ? "已发布"
                          : v.status === "verifying"
                            ? "待验证"
                            : "草稿"}
                        {Object.entries(v.coverage || {}).map(([pl, cv]) => (
                          <a
                            key={pl}
                            href={`#/library/${pl}`}
                            className={`flag ${cv.ready && cv.deployable ? "" : "warn"}`}
                            title={
                              cv.ready
                                ? cv.deployable
                                  ? "软件库已备齐"
                                  : "软件包已备齐，但这个系统还没有 Ansible 运行环境"
                                : `软件库缺 ${cv.missing?.length ?? 0} 个软件包`
                            }
                            style={{ marginLeft: 6 }}
                          >
                            {pl}：
                            {cv.ready
                              ? cv.deployable
                                ? "可生成"
                                : "无运行环境"
                              : `缺 ${cv.missing?.length ?? 0} 个包`}
                          </a>
                        ))}
                      </span>
                    </div>
                  ))}
                  <div>
                    <span>平台</span>
                    <b>{app.platform}</b>
                    <span />
                  </div>
                  {plans.map((p) => (
                    <div key={p.id}>
                      <span>常用方案</span>
                      <b>{p.name}</b>
                      <span className="faint">{p.spec}</span>
                    </div>
                  ))}
                  {(app.materials || []).map((m) => (
                    <div key={m.kind}>
                      <span>离线材料</span>
                      <b className="mono material-name">{m.name}</b>
                      <span className="num faint">
                        {size(m.bytes)} · 更新于 {dayLabel(m.updated)}
                      </span>
                    </div>
                  ))}
                  {!app.materials?.length && (
                    <div>
                      <span>材料</span>
                      <b className="faint">
                        {app.available ? "—" : "开放后提供"}
                      </b>
                      <span />
                    </div>
                  )}
                </div>
              </section>
            )}

            {pane === "jobs" && (
              <section className="store-sec" id="p-jobs">
                <h2 className="dsec-title">
                  我的交付 <span className="dsec-count num">{jobs.length}</span>
                  {jobs.length > 0 && (
                    <button
                      className="link small side-more"
                      onClick={() => showDeliveriesOf(app.id)}
                    >
                      在交付中查看 <IconRight />
                    </button>
                  )}
                </h2>
                <JobTimeline
                  jobs={latest}
                  empty={
                    <span className="muted small">
                      {app.available
                        ? "还没有用这个应用生成过交付。"
                        : "开放后，这里会列出你的交付。"}
                    </span>
                  }
                />
              </section>
            )}
            </div>
          </div>

          <aside className="product-side">
            {app.available && can("delivery.create") && (
              <Button
                type="primary"
                long
                icon={<IconPlus />}
                onClick={() => go({ name: "new", app: app.id })}
              >
                新建 {app.name} 集群
              </Button>
            )}
            <Menu
              className="side-menu"
              mode={wide ? "vertical" : "horizontal"}
              selectedKeys={[pane]}
              onClickMenuItem={(k) => setTab(k as PaneId)}
              aria-label="应用信息"
            >
              {shown.map(([id, label, icon]) => (
                <Menu.Item key={id}>
                  <span className="menu-row">
                    {icon}
                    <span>{label}</span>
                    {id === "jobs" && jobs.length > 0 && (
                      <em className="num side-count">{jobs.length}</em>
                    )}
                  </span>
                </Menu.Item>
              ))}
            </Menu>
          </aside>
        </div>
      </div>
    </div>
  );
}

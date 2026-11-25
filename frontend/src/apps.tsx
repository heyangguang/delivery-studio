import React, { useEffect, useMemo, useRef, useState } from "react";
import { TopoArt } from "./topoart";
import { PlanGlyph, PlanGlyphCustom, planBadgeOf } from "./planglyph";
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
  hasReleasedVersion,
  isVersionPlatformReleased,
  platformShort,
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
import { bi, canonicalCat, catLabel, getLang, useLang } from "./i18n";

import type { LoadState } from "./deliveries";

const isAllCat = (c?: string) => !c || c === "全部" || c === "All";
const catKey = (c?: string) => canonicalCat(c) || "其他";
const displayCat = (c?: string, fallback?: string) => {
  if (!c) return fallback ?? bi("中间件", "Middleware");
  if (c === "其他" || c.toLowerCase() === "other") return bi("其他", "Other");
  return catLabel(c);
};

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

/* ---------- plans ---------- */

const formalReady = (a: AppInfo) => a.available && hasReleasedVersion(a);

function Plans({ app, plans }: { app: AppInfo; plans: AppPlan[] }) {
  useLang();
  const ready = formalReady(app);
  const off = !ready || !can("delivery.create");
  return (
    <div className="plan-cards">
      {plans.map((p) => {
        const b = planBadgeOf(p);
        return (
          <button
            type="button"
            key={p.id}
            className={`plan-card ${b?.recommended ? "is-rec" : ""}`}
            disabled={off}
            onClick={() => go({ name: "new", app: app.id, plan: p.id })}
          >
            <div className="plan-card-stage">
              <PlanGlyph plan={p} className="plan-glyph-lg" />
              {b && (
                <span className={`plan-pill tone-${b.tone}`}>{b.label}</span>
              )}
            </div>
            <div className="plan-card-body">
              <strong>{p.name}</strong>
              <span className="plan-card-spec">{p.spec}</span>
              {p.contract?.mechanism && (
                <span className="plan-card-mech">{p.contract.mechanism}</span>
              )}
            </div>
            <span className="plan-card-go">
              {off ? (
                !app.available ? (
                  bi("暂未开放", "Unavailable")
                ) : !ready ? (
                  bi("待验证发布", "Pending release")
                ) : (
                  ""
                )
              ) : (
                <>
                  {bi("用此方案新建", "Use this plan")} <IconRight />
                </>
              )}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        className="plan-card custom"
        disabled={off}
        onClick={() => go({ name: "new", app: app.id })}
      >
        <div className="plan-card-stage is-custom">
          <PlanGlyphCustom className="plan-glyph-lg" />
          <span className="plan-pill tone-basic">
            {bi("自由组合", "Custom")}
          </span>
        </div>
        <div className="plan-card-body">
          <strong>{bi("自定义", "Custom")}</strong>
          <span className="plan-card-spec">
            {bi(
              "节点、复制、加密与参数逐项决定",
              "Configure nodes, replication, TLS & parameters manually",
            )}
          </span>
        </div>
        <span className="plan-card-go">
          {off ? (
            !app.available ? (
              bi("暂未开放", "Unavailable")
            ) : !ready ? (
              bi("待验证发布", "Pending release")
            ) : (
              ""
            )
          ) : (
            <>
              {bi("从空白开始", "Start from scratch")} <IconRight />
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
  !f.q && isAllCat(f.cat) && !f.tags.length && !f.only && !f.mine;

const getSorts = (
  lang: string,
): { value: Filters["sort"]; label: string; sig: string }[] => [
  { value: "rec", label: bi("推荐", "Recommended"), sig: lang },
  { value: "recent", label: bi("最近使用", "Recently used"), sig: lang },
  { value: "name", label: bi("名称", "Name"), sig: lang },
];

const getViews = (
  lang: string,
): { value: Filters["view"]; label: React.ReactNode; sig: string }[] => [
  {
    value: "wide",
    label: (
      <>
        <IconLayout />
        <span className="seg-text">{bi("详细", "Detailed")}</span>
      </>
    ),
    sig: lang,
  },
  {
    value: "grid",
    label: (
      <>
        <IconApps />
        <span className="seg-text">{bi("网格", "Grid")}</span>
      </>
    ),
    sig: lang,
  },
  {
    value: "list",
    label: (
      <>
        <IconList />
        <span className="seg-text">{bi("列表", "List")}</span>
      </>
    ),
    sig: lang,
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
    !`${a.name} ${a.version} ${a.category || ""} ${catLabel(a.category)} ${a.description} ${a.detail?.tagline || ""} ${(a.tags || []).join(" ")}`
      .toLowerCase()
      .includes(q)
  )
    return false;
  if (skip !== "cat" && !isAllCat(f.cat) && catKey(a.category) !== catKey(f.cat))
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
    state={formalReady(a) ? "succeeded" : "queued"}
    label={
      formalReady(a)
        ? bi("可生成", "Ready")
        : a.available
          ? bi("待验证发布", "Pending release")
          : bi("暂未开放", "Unavailable")
    }
  />
);

function AppTile({ a, usage }: { a: AppInfo; usage: Usage }) {
  useLang();
  const ready = formalReady(a);
  const used = usage.get(a.id);
  const plans = plansOf(a);
  const caps = (a.detail?.capabilities || []).map((c) => c.name);
  return (
    <article className={`tile2 ${ready ? "" : "off"}`}>
      <div className="tile2-head">
        <AppGlyph
          id={a.id}
          category={a.category}
          size={48}
          muted={!ready}
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
            {displayCat(a.category)} · {shortVersion(a.version)}
          </span>
        </div>
      </div>
      <p>{tagline(a)}</p>
      <dl className="tile2-facts">
        <div>
          <dt>{bi("方案", "Plans")}</dt>
          <dd title={plans.map((p) => p.name).join(" · ")}>
            {plans.length
              ? plans.map((p) => p.name).join(" · ")
              : bi("按需组合", "Customizable")}
          </dd>
        </div>
        <div>
          <dt>{bi("能力", "Features")}</dt>
          <dd title={caps.join(" · ")}>
            {caps.length ? caps.join(" · ") : (a.tags || []).join(" · ") || "—"}
          </dd>
        </div>
      </dl>
      <div className="tile2-foot">
        <span className="tile2-meta num">
          <span>{a.detail?.scale || a.platform}</span>
          {used ? (
            <span>
              {bi(
                `我的交付 ${used.count}`,
                `${used.count} ${used.count === 1 ? "delivery" : "deliveries"}`,
              )}
            </span>
          ) : null}
        </span>
        {ready && can("delivery.create") ? (
          <Button
            className="tile2-new"
            size="small"
            icon={<IconPlus />}
            onClick={() => go({ name: "new", app: a.id })}
            aria-label={bi(`新建 ${a.name} 集群`, `New ${a.name} cluster`)}
          >
            {bi("新建集群", "New cluster")}
          </Button>
        ) : ready ? null : (
          badge(a)
        )}
      </div>
    </article>
  );
}

function AppRow({ a, usage }: { a: AppInfo; usage: Usage }) {
  useLang();
  const ready = formalReady(a);
  const used = usage.get(a.id);
  const plans = plansOf(a);
  const caps = (a.detail?.capabilities || []).map((c) => c.name);
  return (
    <div className={`cat-row ${ready ? "" : "off"}`}>
      <AppGlyph
        id={a.id}
        category={a.category}
        size={44}
        muted={!ready}
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
              .map((c) => `${c.name}${bi("：", ": ")}${c.text}`)
              .join("\n")}
          >
            {caps.slice(0, 4).join(" · ")}
          </span>
        )}
        <div className="cat-tags">
          {plans.length > 0 && (
            <span className="cat-plans">
              {bi(
                `${plans.length} 个方案`,
                `${plans.length} ${plans.length === 1 ? "plan" : "plans"}`,
              )}
            </span>
          )}
          {(a.tags || []).slice(0, 3).map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>
      <div className="cat-side">
        <span className="muted small">{displayCat(a.category)}</span>
        <span className="muted small">{a.detail?.scale || a.platform}</span>
        {used && (
          <span className="muted small num">
            {bi(
              `我的交付 ${used.count}`,
              `${used.count} ${used.count === 1 ? "delivery" : "deliveries"}`,
            )}
          </span>
        )}
      </div>
      {badge(a)}
      {ready && can("delivery.create") ? (
        <Button
          size="small"
          icon={<IconPlus />}
          onClick={() => go({ name: "new", app: a.id })}
          aria-label={bi(`新建 ${a.name} 集群`, `New ${a.name} cluster`)}
        >
          {bi("新建", "New")}
        </Button>
      ) : (
        <span className="cat-gap" />
      )}
    </div>
  );
}

/** Build a concise non-redundant spec + mechanism line for compact catalog blueprint tiles. */
function widePlanSummary(p: AppPlan): string {
  const spec = (p.spec || "").trim();
  const mech = (p.contract?.mechanism || "").trim();
  if (!mech) return spec;
  if (!spec) return mech;
  const hay = `${p.name} ${spec}`.toLowerCase();
  const mLow = mech.toLowerCase();
  if (hay.includes(mLow)) return spec;
  const mWords = mLow.split(/[\s+/·-]+/).filter((w) => w.length >= 2);
  if (mWords.length > 0 && mWords.every((w) => hay.includes(w))) {
    return spec;
  }
  if (
    spec.length >= 16 &&
    /(单机|单节点|standalone)/i.test(mech) &&
    /(单机|单节点|standalone)/i.test(spec)
  ) {
    return spec;
  }
  return `${spec} · ${mech}`;
}

/** A catalog entry with everything needed to act on it: its plans start a delivery, its recent deliveries open. */
function AppWide({ a, mine }: { a: AppInfo; mine: Job[] }) {
  useLang();
  const ready = formalReady(a);
  const plans = plansOf(a);
  const canCreate = can("delivery.create");
  const [accent] = styleOf(a.id, a.category, a.icon, a.color).color.hero;
  const recent = [...mine]
    .sort((x, y) => y.created.localeCompare(x.created))
    .slice(0, 3);
  const shownPlans = plans.slice(0, 4);
  const showCustomTile =
    !recent.length &&
    shownPlans.length > 0 &&
    shownPlans.length <= 2 &&
    ready &&
    canCreate;
  const tileCount = shownPlans.length + (showCustomTile ? 1 : 0);
  return (
    <article
      className={`appwide ${ready ? "" : "off"}`}
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
            muted={!ready}
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
              <span>{displayCat(a.category)}</span>
              <span className="wide-dot">·</span>
              <span>{a.detail?.scale || a.platform}</span>
            </div>
            <p>
              {ready
                ? tagline(a)
                : a.available
                  ? bi(
                      "暂无已验证发布的版本，请由组件维护者在组件页完成实测发布后使用",
                      "No verified published version yet; maintainers must verify and publish it first",
                    )
                  : a.reason || bi("暂未开放，敬请期待", "Not yet available")}
            </p>
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
          <dl className="wide-caps" aria-label={bi("能力要点", "Key capabilities")}>
            {a.detail!.capabilities!.slice(0, 3).map((c) => (
              <div key={c.name}>
                <dt title={c.name}>{c.name}</dt>
                <dd title={c.text}>{c.text}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="wide-actions">
          {ready && canCreate && (
            <Button
              type="primary"
              icon={<IconPlus />}
              onClick={() => go({ name: "new", app: a.id })}
              aria-label={bi(`新建 ${a.name} 集群`, `New ${a.name} cluster`)}
            >
              {bi("新建", "New")}
            </Button>
          )}
          <Button
            className="wide-more-btn"
            type="text"
            onClick={() => go({ name: "apps", id: a.id })}
          >
            {bi("详情", "Details")} <IconRight />
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
                <span>{bi("从架构方案起步", "Start from a blueprint")}</span>
                {!recent.length && ready && (
                  <em>{bi("尚未创建该应用交付", "No deliveries yet")}</em>
                )}
              </h3>
              <ul className="wide-plans" data-n={tileCount}>
                {shownPlans.map((p) => {
                  const b = planBadgeOf(p);
                  const summary = widePlanSummary(p);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        className={`wide-plan-tile ${b?.recommended ? "is-rec" : ""}`}
                        disabled={!ready || !canCreate}
                        onClick={() => go({ name: "new", app: a.id, plan: p.id })}
                        aria-label={bi(
                          `用${p.name}方案新建 ${a.name} 集群`,
                          `New ${a.name} cluster with ${p.name}`,
                        )}
                      >
                        <span className="wide-plan-well">
                          <PlanGlyph plan={p} />
                        </span>
                        <div className="wide-plan-copy">
                          <div className="wide-plan-name-row">
                            <b>{p.name}</b>
                            {b && (
                              <span className={`plan-pill tone-${b.tone}`}>
                                {b.label}
                              </span>
                            )}
                          </div>
                          {summary && <small title={summary}>{summary}</small>}
                        </div>
                        {ready && canCreate && (
                          <span className="wide-plan-go" aria-hidden="true">
                            <IconRight className="wide-plan-arrow" />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
                {showCustomTile && (
                  <li key="__custom__">
                    <button
                      type="button"
                      className="wide-plan-tile is-custom"
                      onClick={() => go({ name: "new", app: a.id })}
                      aria-label={bi(
                        `自定义方案新建 ${a.name} 集群`,
                        `New custom ${a.name} cluster`,
                      )}
                    >
                      <span className="wide-plan-well is-custom">
                        <PlanGlyphCustom />
                      </span>
                      <div className="wide-plan-copy">
                        <div className="wide-plan-name-row">
                          <b>{bi("自定义方案", "Custom plan")}</b>
                          <span className="plan-pill tone-basic">
                            {bi("自由组合", "Custom")}
                          </span>
                        </div>
                        <small>
                          {bi(
                            "按需编排节点、端口与核心参数",
                            "Customize nodes, ports & parameters",
                          )}
                        </small>
                      </div>
                      <span className="wide-plan-go" aria-hidden="true">
                        <IconRight className="wide-plan-arrow" />
                      </span>
                    </button>
                  </li>
                )}
              </ul>
            </div>
          )}
          {recent.length > 0 && (
            <div className="wide-col jobs">
              <h3>
                {bi("我的交付", "My deliveries")}{" "}
                <em className="num">{mine.length}</em>
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
  useLang();
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
  const lang = useLang();
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
        m.set(catKey(a.category), (m.get(catKey(a.category)) || 0) + 1),
      );
    const all = new Map<string, number>();
    apps.forEach((a) =>
      all.set(catKey(a.category), (all.get(catKey(a.category)) || 0) + 1),
    );
    return [...all.keys()]
      .sort(
        (a, b) =>
          all.get(b)! - all.get(a)! ||
          displayCat(a).localeCompare(displayCat(b), getLang()),
      )
      .map((c) => [c, m.get(c) || 0] as [string, number]);
  }, [apps, f.q, f.tags, f.only, f.mine, usage, lang]);
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    apps
      .filter((a) => matchApp(a, f, usage, "tags"))
      .forEach((a) =>
        (a.tags || []).forEach((t) => m.set(t, (m.get(t) || 0) + 1)),
      );
    f.tags.forEach((t) => m.has(t) || m.set(t, 0));
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], getLang()))
      .slice(0, 16);
  }, [apps, f.q, f.cat, f.only, f.mine, f.tags, usage, lang]);
  const list = useMemo(() => {
    const l = apps.filter((a) => matchApp(a, f, usage));
    const byName = (a: AppInfo, b: AppInfo) =>
      a.name.localeCompare(b.name, getLang());
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
  }, [apps, f, usage, lang]);

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
        <h2>{bi("找不到这个应用", "App not found")}</h2>
        <p>{bi("应用目录中没有这一项。", "This application is not in the catalog.")}</p>
        <Button onClick={() => go({ name: "apps" }, { replace: true })}>
          {bi("返回应用", "Back to Apps")}
        </Button>
      </div>
    );
  }

  const plain = isDefault(f);
  const grouped = plain;
  const byCat = useMemo(() => {
    const m = new Map<string, AppInfo[]>();
    list.forEach((a) =>
      m.set(catKey(a.category), [...(m.get(catKey(a.category)) || []), a]),
    );
    const entries = [...m.entries()];
    if (f.sort !== "rec") return entries;
    return entries.sort(
      (x, y) =>
        y[1].filter((a) => a.available).length -
          x[1].filter((a) => a.available).length ||
        y[1].length - x[1].length ||
        displayCat(x[0]).localeCompare(displayCat(y[0]), getLang()),
    );
  }, [list, f.sort, lang]);
  const totalApps = cats.length ? apps.length : 0;
  const clear = () => set({ ...DEFAULTS, view: f.view, sort: f.sort });

  const jobsByApp = useMemo(() => {
    const m = new Map<string, Job[]>();
    for (const j of jobs) {
      const arr = m.get(j.app_id);
      if (arr) arr.push(j);
      else m.set(j.app_id, [j]);
    }
    return m;
  }, [jobs]);
  const jobsOf = (id: string) => jobsByApp.get(id) || [];
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
    <aside className="store-rail" aria-label={bi("筛选应用", "Filter apps")}>
      <div className="list-head">
        <div className="list-title">
          <h1>{bi("应用", "Apps")}</h1>
        </div>
        <Input
          ref={(r) => {
            search.current =
              (r as unknown as { dom?: HTMLInputElement })?.dom ?? null;
          }}
          prefix={<IconSearch />}
          suffix={!f.q ? <Kbd>/</Kbd> : undefined}
          allowClear
          placeholder={bi("搜索名称、标签、说明", "Search name, tags, description")}
          value={f.q}
          onChange={(v) => set({ q: v })}
          onKeyDown={(e) => {
            if (e.key === "Escape")
              (set({ q: "" }), (e.target as HTMLInputElement).blur());
          }}
          aria-label={bi("搜索应用", "Search apps")}
        />
      </div>
      <div className="store-rail-body">
        <nav className="rail-group rail-cats" aria-label={bi("分类", "Categories")}>
        <h3>{bi("分类", "Categories")}</h3>
        <button
          type="button"
          className={isAllCat(f.cat) ? "on" : ""}
          onClick={() => set({ cat: "全部" })}
        >
          <span>{bi("全部", "All")}</span>
          <em className="num">
            {apps.filter((a) => matchApp(a, f, usage, "cat")).length}
          </em>
        </button>
        {cats.map(([c, n]) => (
          <button
            type="button"
            key={c}
            className={!isAllCat(f.cat) && catKey(f.cat) === c ? "on" : ""}
            onClick={() => set({ cat: c })}
            disabled={!n && catKey(f.cat) !== c}
          >
            <span className="rail-cat">
              <i
                style={{
                  background: `linear-gradient(${tintOf(c).join(",")})`,
                }}
                aria-hidden
              />
              {displayCat(c, bi("其他", "Other"))}
            </span>
            <em className="num">{n}</em>
          </button>
        ))}
      </nav>
      {tags.length > 0 && (
        <div
          className="rail-group rail-tags"
          role="group"
          aria-label={bi("标签", "Tags")}
        >
          <h3>{bi("标签", "Tags")}</h3>
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
      <div
        className="rail-group rail-scope"
        role="group"
        aria-label={bi("范围", "Scope")}
      >
        <h3>{bi("范围", "Scope")}</h3>
        <Checkbox
          className="rail-check"
          checked={f.only}
          onChange={(c) => set({ only: c })}
        >
          {bi("只看可生成", "Ready only")}
        </Checkbox>
        <Checkbox
          className="rail-check"
          checked={f.mine}
          onChange={(c) => set({ mine: c })}
        >
          {bi("我用过的", "Used by me")}
        </Checkbox>
      </div>
      </div>
    </aside>
  );

  return (
    <div className="store2">
      {rail}
      <main className="store-main">
        <header className="store-bar">
          <div>
            <h2>
              {isAllCat(f.cat)
                ? bi("全部应用", "All Apps")
                : displayCat(f.cat, bi("其他", "Other"))}
            </h2>
            <p className="muted small num" aria-live="polite">
              {load === "ready"
                ? plain
                  ? bi(
                      `共 ${totalApps} 个应用，${apps.filter((a) => a.available).length} 个可生成`,
                      `${totalApps} ${totalApps === 1 ? "app" : "apps"}, ${apps.filter((a) => a.available).length} ready`,
                    )
                  : bi(
                      `${list.length} / ${apps.length} 个应用`,
                      `${list.length} of ${apps.length} apps`,
                    )
                : bi("正在加载…", "Loading…")}
            </p>
          </div>
          <div className="store-bar-tools">
            <Segmented
              label={bi("排序", "Sort")}
              value={f.sort}
              onChange={(v) => set({ sort: v })}
              options={getSorts(lang)}
            />
            <Segmented
              label={bi("显示方式", "View")}
              value={f.view}
              onChange={(v) => set({ view: v })}
              options={getViews(lang)}
            />
          </div>
        </header>

        {!plain && (
          <div
            className="active-filters"
            aria-label={bi("已选筛选", "Active filters")}
          >
            {f.q && (
              <FilterChip label={f.q} onClose={() => set({ q: "" })}>
                {bi(`“${f.q}”`, `"${f.q}"`)}
              </FilterChip>
            )}
            {!isAllCat(f.cat) && (
              <FilterChip
                label={displayCat(f.cat, bi("其他", "Other"))}
                onClose={() => set({ cat: "全部" })}
              />
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
                label={bi("只看可生成", "Ready only")}
                onClose={() => set({ only: false })}
              />
            )}
            {f.mine && (
              <FilterChip
                label={bi("我用过的", "Used by me")}
                onClose={() => set({ mine: false })}
              />
            )}
            <button type="button" className="link" onClick={clear}>
              {bi("清除全部", "Clear all")}
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
            <p>{bi("应用目录加载失败", "Failed to load app catalog")}</p>
            <Button size="small" icon={<IconRefresh />} onClick={reload}>
              {bi("重试", "Retry")}
            </Button>
          </div>
        ) : !apps.length ? (
          <div className="list-state">
            <p>
              {bi(
                "应用目录为空，需要管理员在服务端添加应用",
                "App catalog is empty; an administrator must add components on the server.",
              )}
            </p>
          </div>
        ) : (
          <>
            {!list.length ? (
              <div className="list-state big">
                <IconSearch />
                <p>{bi("没有符合条件的应用", "No matching apps")}</p>
                <span className="muted small">
                  {f.q
                    ? bi(
                        "试试更短的关键词，或去掉标签和范围限制",
                        "Try a shorter keyword or clear tag and scope filters",
                      )
                    : bi("放宽筛选条件看看", "Try broadening your filters")}
                </span>
                <Button onClick={clear}>
                  {bi("清除全部筛选", "Clear all filters")}
                </Button>
              </div>
            ) : f.view === "grid" ? (
              // One aligned grid; every tile says its category, so no lane is left half empty.
              <section className="store-sec">
                {grid(grouped ? byCat.flatMap(([, items]) => items) : list)}
              </section>
            ) : grouped ? (
              <>
                {byCat.map(([c, items]) => (
                  <section
                    className="store-sec"
                    key={c}
                    aria-label={displayCat(c, bi("其他", "Other"))}
                  >
                    <h2 className="dsec-title">
                      <i
                        className="cat-dot"
                        style={{
                          background: `linear-gradient(${tintOf(c).join(",")})`,
                        }}
                        aria-hidden
                      />
                      {displayCat(c, bi("其他", "Other"))}{" "}
                      <span className="dsec-count num">{items.length}</span>
                      {items.some((a) => !a.available) && (
                        <span className="dsec-note">
                          {bi(
                            `${items.filter((a) => a.available).length} 个可生成`,
                            `${items.filter((a) => a.available).length} ready`,
                          )}
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
const getPanes = (): [PaneId, string, React.ReactNode][] => [
  ["plans", bi("方案", "Plans"), ProdIcons.plans],
  ["contents", bi("交付内容", "Contents"), ProdIcons.contents],
  ["caps", bi("能力与边界", "Capabilities"), ProdIcons.caps],
  ["materials", bi("版本与材料", "Versions & Materials"), ProdIcons.materials],
  ["jobs", bi("我的交付", "My Deliveries"), ProdIcons.jobs],
];

/** An icon for a delivery item, picked from what it is. */
const contentIcon = (name: string) =>
  /仓库|repo/i.test(name) ? (
    <IconStorage />
  ) : /手册|runbook|guide|manual/i.test(name) ? (
    <IconBook />
  ) : /校验|证书|checksum|verify|cert|sha256/i.test(name) ? (
    <IconSafe />
  ) : /Ansible|自动化|playbook|automation/i.test(name) ? (
    <IconCode />
  ) : /包|archive|package|bundle/i.test(name) ? (
    <IconArchive />
  ) : (
    <IconFile />
  );

function Product({ app, jobs }: { app: AppInfo; jobs: Job[] }) {
  useLang();
  const d = app.detail;
  const plans = plansOf(app);
  const [os] = platformParts(app.platform);
  const offline = app.materials?.find((m) => m.kind === "offline");
  const wide = useMedia("(min-width: 1101px)");
  const [tab, setTab] = useState<PaneId>("plans");
  const shown = getPanes().filter(([id]) =>
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
    [bi("规模", "Scale"), d?.scale || "—"],
    [
      bi("版本", "Versions"),
      app.versions.length ? (
        <span className="info-strip-chips">
          {app.versions.map((v) => (
            <span key={v.id} className="info-strip-chip mono">
              {v.id}
            </span>
          ))}
        </span>
      ) : (
        "—"
      ),
    ],
    [bi("系统", "OS"), os || "—"],
    [
      bi("软件库", "Library"),
      ready.length
        ? bi(`${ready.length} 个系统可生成`, `Ready on ${ready.length} OS`)
        : offline
          ? size(offline.bytes)
          : bi("还没备齐", "Incomplete"),
    ],
    [bi("我的交付", "Deliveries"), String(jobs.length)],
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
          {bi("应用", "Apps")}
          {app.category ? ` · ${displayCat(app.category)}` : ""}
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
                <span className="feature-cat">{displayCat(app.category)}</span>
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
                  {bi("新建集群", "New Cluster")}
                </Button>
              )}
              {!app.available && (
                <span className="product-off">
                  {app.reason || bi("暂不可用", "Unavailable")}
                </span>
              )}
            </div>
          </div>
          <TopoArt
            app={app}
            plan={
              plans.find((p) => /推荐|recommended/i.test(p.tag || "")) ||
              plans.find((p) => p.contract?.failover === "automatic") ||
              plans[1] ||
              plans[0]
            }
          />
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
              label={bi("应用详情分区", "App details sections")}
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
                  <b>
                    {bi(
                      "这个应用还不能生成交付",
                      "This app is not ready for delivery yet",
                    )}
                  </b>
                  <span>
                    {bi(
                      "这个应用暂未开放新建。下面是计划支持的范围，验证通过后开放。",
                      "Creation is not open yet. Planned scope is shown below and will open once verified.",
                    )}
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
                  {bi("方案", "Plans")}{" "}
                  <span className="dsec-note">
                    {app.available
                      ? bi(
                          "选一个起点，之后每一项都能改",
                          "Pick a starting point; everything can be customized later",
                        )
                      : bi("计划提供的起点", "Planned starting points")}
                  </span>
                </h2>
                <Plans app={app} plans={plans} />
              </section>
            )}

            {pane === "contents" && !!d?.includes?.length && (
              <section className="store-sec" id="p-contents">
                <h2 className="dsec-title">
                  {bi("每次交付包含", "Included in each delivery")}
                </h2>
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
                    {app.available
                      ? bi("能力与边界", "Capabilities & Scope")
                      : bi("计划能力与边界", "Planned Capabilities & Scope")}
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
                      <b>{bi("不在范围内", "Out of scope")}</b>
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
                <h2 className="dsec-title">
                  {bi("版本与材料", "Versions & Materials")}
                </h2>
                <div className="spec-rows">
                  {app.versions.map((v) => (
                    <div key={v.id}>
                      <span>{bi("版本", "Version")}</span>
                      <b>{v.id}</b>
                      <span
                        className={v.status === "published" ? "faint" : "warn"}
                      >
                        <span className="spec-ver-st">
                          {v.status === "published"
                            ? bi("已发布", "Published")
                            : bi("未发布", "Unpublished")}
                        </span>
                        {(v.platforms || Object.keys(v.coverage || {})).map((pl) => {
                          const cv = v.coverage?.[pl];
                          const released = isVersionPlatformReleased(v, pl);
                          return (
                            <a
                              key={pl}
                              href={`#/library/${pl}`}
                              className={`flag ${released && cv?.ready && cv?.deployable ? "ok" : "warn"}`}
                              title={
                                !released
                                  ? bi(
                                      `${platformShort(pl)} 尚未发布，正式交付已拦截`,
                                      `${platformShort(pl)} is not yet published for formal delivery`,
                                    )
                                  : cv?.ready
                                    ? cv.deployable
                                      ? bi("已发布且软件库就绪", "Published & library ready")
                                      : bi(
                                          "软件包已备齐，但这个系统还没有 Ansible 运行环境",
                                          "Packages ready, but no Ansible runtime selected for this OS",
                                        )
                                    : bi(
                                        `软件库缺 ${cv?.missing?.length ?? 0} 个软件包`,
                                        `Missing ${cv?.missing?.length ?? 0} packages in library`,
                                      )
                              }
                            >
                              {platformShort(pl)}
                              {bi("：", ": ")}
                              {!released
                                ? bi("未发布", "Unpublished")
                                : cv?.ready
                                  ? cv.deployable
                                    ? bi("已发布", "Published")
                                    : bi("无运行环境", "No runtime")
                                  : bi(
                                      `缺 ${cv?.missing?.length ?? 0} 个包`,
                                      `Missing ${cv?.missing?.length ?? 0}`,
                                    )}
                            </a>
                          );
                        })}
                      </span>
                    </div>
                  ))}
                  <div>
                    <span>{bi("平台", "Platforms")}</span>
                    <b>{app.platform}</b>
                    <span />
                  </div>
                  {plans.map((p) => (
                    <div key={p.id}>
                      <span>{bi("常用方案", "Preset plans")}</span>
                      <b>{p.name}</b>
                      <span className="faint">{p.spec}</span>
                    </div>
                  ))}
                  {(app.materials || []).map((m) => (
                    <div key={m.kind}>
                      <span>{bi("离线材料", "Offline bundle")}</span>
                      <b className="mono material-name">{m.name}</b>
                      <span className="num faint">
                        {size(m.bytes)} ·{" "}
                        {bi(
                          `更新于 ${dayLabel(m.updated)}`,
                          `updated ${dayLabel(m.updated)}`,
                        )}
                      </span>
                    </div>
                  ))}
                  {!app.materials?.length && (
                    <div>
                      <span>{bi("材料", "Materials")}</span>
                      <b className="faint">
                        {app.available
                          ? "—"
                          : bi("开放后提供", "Available upon release")}
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
                  {bi("我的交付", "My Deliveries")}{" "}
                  <span className="dsec-count num">{jobs.length}</span>
                  {jobs.length > 0 && (
                    <button
                      type="button"
                      className="link small side-more"
                      onClick={() => showDeliveriesOf(app.id)}
                    >
                      {bi("在交付中查看", "View in Deliveries")} <IconRight />
                    </button>
                  )}
                </h2>
                <JobTimeline
                  jobs={latest}
                  empty={
                    <span className="muted small">
                      {app.available
                        ? bi(
                            "还没有用这个应用生成过交付。",
                            "No deliveries created with this app yet.",
                          )
                        : bi(
                            "开放后，这里会列出你的交付。",
                            "Your deliveries will appear here once released.",
                          )}
                    </span>
                  }
                />
              </section>
            )}
            </div>
          </div>

          <aside className="product-side">
            {formalReady(app) && can("delivery.create") && (
              <Button
                type="primary"
                long
                icon={<IconPlus />}
                onClick={() => go({ name: "new", app: app.id })}
              >
                {bi(`新建 ${app.name} 集群`, `New ${app.name} Cluster`)}
              </Button>
            )}
            {app.available && !hasReleasedVersion(app) && can("component.edit|component.publish") && (
              <Button
                long
                onClick={() => go({ name: "components", id: app.id })}
              >
                {bi("前往组件页验证发布", "Verify & Publish Component")}
              </Button>
            )}
            <Menu
              className="side-menu"
              mode={wide ? "vertical" : "horizontal"}
              selectedKeys={[pane]}
              onClickMenuItem={(k) => setTab(k as PaneId)}
              aria-label={bi("应用信息", "App navigation")}
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

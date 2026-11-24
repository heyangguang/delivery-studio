import React, { useMemo, useState } from "react";
import { Button, Input, Skeleton } from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconFile,
  IconRight,
  IconSearch,
} from "@arco-design/web-react/icon";
import { ago, can, hasReleasedVersion } from "./shared";
import type { AppInfo, Job } from "./shared";
import { readFormDraft } from "./formdraft";
import { go } from "./router";
import { Spark } from "./aichat";
import { AppGlyph, Segmented, tintOf } from "./ui";
import { bi, canonicalCat, catLabel, getLang, useLang } from "./i18n";
import "./newpicker.css";

const shortVer = (v: string) => (v || "").split("·")[0].trim();

const CATEGORY_PRIORITY: Record<string, number> = {
  数据库: 1,
  缓存: 2,
  消息队列: 3,
  队列: 3,
  负载均衡: 4,
  网关与代理: 4,
  对象存储: 5,
  存储: 5,
  协调与配置: 6,
  协调服务: 6,
  键值与协调: 6,
  键值存储: 6,
  网络: 7,
};

function categoryRank(cat?: string): number {
  if (!cat) return 50;
  const c = canonicalCat(cat);
  if (CATEGORY_PRIORITY[c] !== undefined) return CATEGORY_PRIORITY[c];
  const low = c.toLowerCase();
  if (c.includes("数据库") || low.includes("database")) return 1;
  if (c.includes("缓存") || low.includes("cache")) return 2;
  if (
    c.includes("队列") ||
    c.includes("消息") ||
    low.includes("queue") ||
    low.includes("messag")
  )
    return 3;
  if (
    c.includes("负载") ||
    c.includes("代理") ||
    low.includes("load") ||
    low.includes("proxy") ||
    low.includes("balanc")
  )
    return 4;
  if (c.includes("存储") || low.includes("storage")) return 5;
  if (
    c.includes("协调") ||
    c.includes("键值") ||
    low.includes("coord") ||
    low.includes("key")
  )
    return 6;
  return 20;
}

const catKey = (c?: string) => canonicalCat(c) || "中间件";
const displayCat = (c?: string) =>
  !c || c === "中间件"
    ? bi("中间件", "Middleware")
    : catLabel(c);

export function NewDeliveryPicker({
  apps,
  loading,
  jobs,
  back,
}: {
  apps: AppInfo[];
  loading?: boolean;
  jobs: Job[];
  back: () => void;
}) {
  const lang = useLang();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");

  // Count distinct active clusters per app so frequently deployed apps feel natural
  const clusterCounts = useMemo(() => {
    const byApp = new Map<string, Set<string>>();
    for (const j of jobs) {
      if (!j.app_id || !j.cluster_id) continue;
      let s = byApp.get(j.app_id);
      if (!s) {
        s = new Set<string>();
        byApp.set(j.app_id, s);
      }
      s.add(j.cluster_id);
    }
    const out = new Map<string, number>();
    byApp.forEach((s, k) => out.set(k, s.size));
    return out;
  }, [jobs]);

  const submittedIds = useMemo(
    () => new Set(jobs.map((j) => j.cluster_id).filter(Boolean)),
    [jobs],
  );

  const formalReady = (a: AppInfo) => a.available && hasReleasedVersion(a);

  // Detect any unfinished local drafts across available apps
  const drafts = useMemo(() => {
    const list: {
      app: AppInfo;
      clusterId: string;
      hostCount: number;
      updated?: string;
    }[] = [];
    for (const a of apps) {
      if (!formalReady(a)) continue;
      const d = readFormDraft(a.id);
      if (!d) continue;
      if (d.dep.id && submittedIds.has(d.dep.id)) continue;
      const hasMeaningfulInput =
        Boolean(d.dep.id) || d.dep.hosts.some((h) => Boolean(h.ip));
      if (!hasMeaningfulInput) continue;
      list.push({
        app: a,
        clusterId: d.dep.id || bi("未命名集群", "Unnamed cluster"),
        hostCount: d.dep.hosts.length,
        updated: d.updated,
      });
    }
    return list;
  }, [apps, submittedIds, lang]);

  const categories = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of apps) {
      const c = catKey(a.category);
      seen.set(c, (seen.get(c) || 0) + 1);
    }
    return Array.from(seen.entries()).sort(
      (a, b) => categoryRank(a[0]) - categoryRank(b[0]),
    );
  }, [apps]);

  const sorted = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return [...apps]
      .filter((a) => {
        if (cat !== "all" && catKey(a.category) !== cat) return false;
        if (!kw) return true;
        const hay = [
          a.name,
          a.id,
          a.category,
          catLabel(a.category),
          a.description,
          a.detail?.tagline,
          ...(a.tags || []),
          ...(a.plans || []).map((p) => p.name),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(kw);
      })
      .sort((a, b) => {
        const ra0 = formalReady(a);
        const rb0 = formalReady(b);
        if (ra0 !== rb0) return ra0 ? -1 : 1;
        const ca = clusterCounts.get(a.id) || 0;
        const cb = clusterCounts.get(b.id) || 0;
        if ((ca > 0) !== (cb > 0)) return cb > 0 ? 1 : -1;
        const ra = categoryRank(a.category);
        const rb = categoryRank(b.category);
        if (ra !== rb) return ra - rb;
        if (cb !== ca) return cb - ca;
        return a.name.localeCompare(b.name, getLang());
      });
  }, [apps, cat, q, clusterCounts, lang]);

  const readyApps = sorted.filter((a) => formalReady(a));
  const unreadyApps = sorted.filter((a) => !formalReady(a));

  return (
    <div className="np-page enter">
      <div className="np-top">
        <Button
          type="text"
          className="np-back"
          icon={<IconArrowLeft />}
          onClick={back}
        >
          {bi("返回交付列表", "Back to deliveries")}
        </Button>
        <header className="np-hero">
          <div className="np-hero-text">
            <h1>{bi("新建集群交付", "New Cluster Delivery")}</h1>
            <p>
              {bi(
                "选择要部署的中间件或基础设施组件；可直接点选推荐高可用架构方案起步，或进入向导让 AI 对话辅助填表。",
                "Choose a middleware or infrastructure component to deploy. Start from a recommended HA blueprint, or launch the wizard with AI-assisted configuration.",
              )}
            </p>
          </div>
          <div className="np-controls">
            <Input
              className="np-search"
              prefix={<IconSearch />}
              allowClear
              value={q}
              onChange={setQ}
              placeholder={bi(
                "搜索组件名称、分类或架构…",
                "Search components, category, or HA…",
              )}
              aria-label={bi("搜索组件", "Search components")}
            />
            <Button onClick={() => go({ name: "apps" })}>
              {bi("查看应用详情", "View App Catalog")}
            </Button>
          </div>
        </header>
        {categories.length > 1 && (
          <div className="np-cats">
            <Segmented<string>
              size="sm"
              label={bi("按分类筛选", "Filter by category")}
              value={cat}
              onChange={setCat}
              options={[
                { value: "all", label: bi("全部", "All"), count: apps.length, sig: lang },
                ...categories.map(([c, n]) => ({
                  value: c,
                  label: displayCat(c),
                  count: n,
                  sig: lang,
                })),
              ]}
            />
          </div>
        )}
      </div>

      {loading && apps.length === 0 ? (
        <Skeleton animation text={{ rows: 8 }} />
      ) : (
        <>
          {drafts.length > 0 && !q.trim() && cat === "all" && (
            <section className="np-drafts" aria-label={bi("未完成的草稿", "Unfinished drafts")}>
              <div className="np-drafts-h">
                <IconFile />
                <span>{bi("继续上次未完成的交付配置", "Resume unfinished drafts")}</span>
              </div>
              <div className="np-drafts-list">
                {drafts.map((d) => (
                  <button
                    key={d.app.id}
                    type="button"
                    className="np-draft-item"
                    onClick={() => go({ name: "new", app: d.app.id })}
                  >
                    <AppGlyph
                      id={d.app.id}
                      category={d.app.category}
                      icon={d.app.icon}
                      color={d.app.color}
                      size={34}
                    />
                    <span className="np-draft-meta">
                      <b>
                        {d.app.name} · {d.clusterId}
                      </b>
                      <small>
                        {bi(
                          `${d.hostCount} 台机器`,
                          `${d.hostCount} ${d.hostCount === 1 ? "host" : "hosts"}`,
                        )}
                        {d.updated
                          ? bi(` · ${ago(d.updated)}保存`, ` · saved ${ago(d.updated)}`)
                          : ""}
                      </small>
                    </span>
                    <span className="np-draft-go">
                      {bi("继续", "Resume")} <IconRight />
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {readyApps.length > 0 && (
            <>
              <div className="np-sec-label">
                <span>
                  {bi(
                    `可立即新建交付（${readyApps.length}）`,
                    `Ready to deploy (${readyApps.length})`,
                  )}
                </span>
              </div>
              <div className="np-grid" role="list">
                {readyApps.map((a) => {
                  const usedCount = clusterCounts.get(a.id) || 0;
                  const plans = a.plans || [];
                  return (
                    <article
                      key={a.id}
                      role="listitem"
                      tabIndex={0}
                      className="np-card ready"
                      onClick={() => go({ name: "new", app: a.id })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          go({ name: "new", app: a.id });
                        }
                      }}
                    >
                      <div className="np-card-head">
                        <AppGlyph
                          id={a.id}
                          category={a.category}
                          icon={a.icon}
                          color={a.color}
                          size={44}
                        />
                        <div className="np-card-title">
                          <div className="np-card-title-row">
                            <h2>{a.name}</h2>
                            {usedCount > 0 && (
                              <span className="np-used-pill">
                                {bi(`已部署 ${usedCount}`, `Deployed ${usedCount}`)}
                              </span>
                            )}
                          </div>
                          <div className="np-card-sub">
                            <i
                              className="np-cat-dot"
                              style={{
                                background: `linear-gradient(${tintOf(a.category).join(",")})`,
                              }}
                              aria-hidden
                            />
                            <span>{displayCat(a.category)}</span>
                            {a.version && (
                              <>
                                <span>·</span>
                                <span>{shortVer(a.version)}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      <p className="np-desc">
                        {a.detail?.tagline || a.description}
                      </p>

                      {plans.length > 0 && (
                        <div
                          className="np-plans"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="np-plans-label">
                            {bi("一键套用推荐架构：", "Quick-start blueprints:")}
                          </span>
                          <div className="np-plan-pills">
                            {plans.slice(0, 3).map((p) => {
                              const nodes = (p.topology || []).reduce(
                                (s, t) => s + t.count,
                                0,
                              );
                              return (
                                <button
                                  key={p.id}
                                  type="button"
                                  className="np-plan-pill"
                                  title={p.spec || p.name}
                                  onClick={() =>
                                    go({ name: "new", app: a.id, plan: p.id })
                                  }
                                >
                                  <span>{p.name}</span>
                                  {nodes > 0 && (
                                    <span className="np-plan-nodes">
                                      {bi(
                                        `${nodes} 节点`,
                                        `${nodes} ${nodes === 1 ? "node" : "nodes"}`,
                                      )}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <div className="np-card-foot">
                        <span className="np-os" title={a.platform}>
                          {a.detail?.scale || a.platform}
                        </span>
                        <span className="np-start-cta">
                          <Spark size={13} rainbow />
                          {bi("选择并配置", "Select & Configure")} <IconRight />
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}

          {unreadyApps.length > 0 && (
            <>
              <div className="np-sec-label unavailable">
                <span>
                  {bi(
                    `暂不可用于正式交付（${unreadyApps.length}）`,
                    `Not yet available for formal delivery (${unreadyApps.length})`,
                  )}
                </span>
              </div>
              <div className="np-grid" role="list">
                {unreadyApps.map((a) => {
                  const needsVerify = a.available && !hasReleasedVersion(a);
                  return (
                    <article key={a.id} role="listitem" className="np-card off">
                      <div className="np-card-head">
                        <AppGlyph
                          id={a.id}
                          category={a.category}
                          icon={a.icon}
                          color={a.color}
                          size={44}
                          muted
                        />
                        <div className="np-card-title">
                          <div className="np-card-title-row">
                            <h2>{a.name}</h2>
                          </div>
                          <div className="np-card-sub">
                            <span>{displayCat(a.category)}</span>
                            {a.version && (
                              <>
                                <span>·</span>
                                <span>{shortVer(a.version)}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <p className="np-desc">
                        {a.detail?.tagline || a.description}
                      </p>
                      <div className="np-unavail-note">
                        {needsVerify
                          ? bi(
                              "暂无已验证发布的版本，正式交付已拦截；需由组件维护者在组件页完成实测验收并发布",
                              "No field-verified published version yet; maintainers must verify and publish it on the Components page first",
                            )
                          : a.reason ||
                            bi(
                              "当前软件库尚未导入该组件所需的离线安装包",
                              "Required offline packages have not been imported into the library yet",
                            )}
                      </div>
                      <div className="np-card-foot">
                        <span className="np-os">{a.platform}</span>
                        {needsVerify ? (
                          can("component.edit|component.publish") ? (
                            <Button
                              size="mini"
                              onClick={() =>
                                go({ name: "components", id: a.id })
                              }
                            >
                              {bi("前往组件验证", "Verify Component")}
                            </Button>
                          ) : null
                        ) : (
                          <Button
                            size="mini"
                            onClick={() => go({ name: "library" })}
                          >
                            {bi("前往软件库", "Go to Library")}
                          </Button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}

          {sorted.length === 0 && (
            <div className="np-empty">
              <p>
                {bi(
                  "没有找到匹配的中间件组件",
                  "No matching middleware components found",
                )}
              </p>
              {q && (
                <Button size="small" onClick={() => setQ("")}>
                  {bi("清空搜索", "Clear search")}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

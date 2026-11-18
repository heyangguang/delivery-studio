import React, { useMemo, useState } from "react";
import { Button, Input, Skeleton } from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconFile,
  IconRight,
  IconSearch,
} from "@arco-design/web-react/icon";
import { ago } from "./shared";
import type { AppInfo, Job } from "./shared";
import { readFormDraft } from "./formdraft";
import { go } from "./router";
import { Spark } from "./aichat";
import { AppGlyph, Segmented, tintOf } from "./ui";
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
  键值与协调: 6,
  键值存储: 6,
};

function categoryRank(cat?: string): number {
  if (!cat) return 50;
  if (CATEGORY_PRIORITY[cat] !== undefined) return CATEGORY_PRIORITY[cat];
  if (cat.includes("数据库")) return 1;
  if (cat.includes("缓存")) return 2;
  if (cat.includes("队列") || cat.includes("消息")) return 3;
  if (cat.includes("负载") || cat.includes("代理")) return 4;
  if (cat.includes("协调") || cat.includes("键值")) return 6;
  return 20;
}

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

  // Detect any unfinished local drafts across available apps
  const drafts = useMemo(() => {
    const list: {
      app: AppInfo;
      clusterId: string;
      hostCount: number;
      updated?: string;
    }[] = [];
    for (const a of apps) {
      if (!a.available) continue;
      const d = readFormDraft(a.id);
      if (!d) continue;
      if (d.dep.id && submittedIds.has(d.dep.id)) continue;
      const hasMeaningfulInput =
        Boolean(d.dep.id) || d.dep.hosts.some((h) => Boolean(h.ip));
      if (!hasMeaningfulInput) continue;
      list.push({
        app: a,
        clusterId: d.dep.id || "未命名集群",
        hostCount: d.dep.hosts.length,
        updated: d.updated,
      });
    }
    return list;
  }, [apps, submittedIds]);

  const categories = useMemo(() => {
    const seen = new Map<string, number>();
    for (const a of apps) {
      const c = a.category || "中间件";
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
        if (cat !== "all" && (a.category || "中间件") !== cat) return false;
        if (!kw) return true;
        const hay = [
          a.name,
          a.id,
          a.category,
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
        if (a.available !== b.available) return a.available ? -1 : 1;
        const ca = clusterCounts.get(a.id) || 0;
        const cb = clusterCounts.get(b.id) || 0;
        if ((ca > 0) !== (cb > 0)) return cb > 0 ? 1 : -1;
        const ra = categoryRank(a.category);
        const rb = categoryRank(b.category);
        if (ra !== rb) return ra - rb;
        if (cb !== ca) return cb - ca;
        return a.name.localeCompare(b.name, "zh-CN");
      });
  }, [apps, cat, q, clusterCounts]);

  const readyApps = sorted.filter((a) => a.available);
  const unreadyApps = sorted.filter((a) => !a.available);

  return (
    <div className="np-page enter">
      <div className="np-top">
        <Button
          type="text"
          className="np-back"
          icon={<IconArrowLeft />}
          onClick={back}
        >
          返回交付列表
        </Button>
        <header className="np-hero">
          <div className="np-hero-text">
            <h1>新建集群交付</h1>
            <p>
              选择要部署的中间件或基础设施组件；可直接点选推荐高可用架构方案起步，或进入向导让
              AI 对话辅助填表。
            </p>
          </div>
          <div className="np-controls">
            <Input
              className="np-search"
              prefix={<IconSearch />}
              allowClear
              value={q}
              onChange={setQ}
              placeholder="搜索 PostgreSQL、Redis、etcd、高可用…"
              aria-label="搜索组件"
            />
            <Button onClick={() => go({ name: "apps" })}>查看应用详情</Button>
          </div>
        </header>
        {categories.length > 1 && (
          <div className="np-cats">
            <Segmented<string>
              size="sm"
              label="按分类筛选"
              value={cat}
              onChange={setCat}
              options={[
                { value: "all", label: "全部", count: apps.length },
                ...categories.map(([c, n]) => ({
                  value: c,
                  label: c,
                  count: n,
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
            <section className="np-drafts" aria-label="未完成的草稿">
              <div className="np-drafts-h">
                <IconFile />
                <span>继续上次未完成的交付配置</span>
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
                        {d.hostCount} 台机器
                        {d.updated ? ` · ${ago(d.updated)}保存` : ""}
                      </small>
                    </span>
                    <span className="np-draft-go">
                      继续 <IconRight />
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {readyApps.length > 0 && (
            <>
              <div className="np-sec-label">
                <span>可立即新建交付（{readyApps.length}）</span>
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
                                已部署 {usedCount}
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
                            <span>{a.category || "中间件"}</span>
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
                            一键套用推荐架构：
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
                                      {nodes} 节点
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
                          选择并配置 <IconRight />
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
                <span>待补齐离线软件包后可用（{unreadyApps.length}）</span>
              </div>
              <div className="np-grid" role="list">
                {unreadyApps.map((a) => (
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
                          <span>{a.category || "中间件"}</span>
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
                      {a.reason || "当前软件库尚未导入该组件所需的离线安装包"}
                    </div>
                    <div className="np-card-foot">
                      <span className="np-os">{a.platform}</span>
                      <Button
                        size="mini"
                        onClick={() => go({ name: "library" })}
                      >
                        前往软件库
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}

          {sorted.length === 0 && (
            <div className="np-empty">
              <p>没有找到匹配的中间件组件</p>
              {q && (
                <Button size="small" onClick={() => setQ("")}>
                  清空搜索
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

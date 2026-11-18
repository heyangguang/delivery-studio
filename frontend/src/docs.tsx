import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Message,
  Modal,
  Skeleton,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconBook,
  IconCheck,
  IconCopy,
  IconDelete,
  IconPlus,
  IconDownload,
  IconEdit,
  IconExclamationCircle,
  IconFile,
  IconRight,
  IconSearch,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  cached,
  can,
  copy,
  err,
  fetchCached,
  fullTime,
  myTeams,
  planPhase,
  PLAN_PHASE,
  putCached,
  reducedMotion,
} from "./shared";
import type { ClusterDoc, ClusterView, DocBlock } from "./shared";
import { go } from "./router";
import { Segmented } from "./ui";
import { Spark, useAIStatus } from "./aichat";
import { bi, useLang, withLang } from "./i18n";
import "./docs.css";

/* The documents of a cluster (store_docs.go): the delivery report, the operations handover, a change report per plan
   and a root-cause analysis per failed plan. Facts come from the platform; the sections people write — or let the
   assistant draft and then confirm — are edited in place on the page. Everything exports to Word, one file each or
   merged into one. */

const KIND: Record<ClusterDoc["kind"], { icon: string; groupKey: string; group: string }> = {
  delivery: { get icon() { return bi("报", "R"); }, groupKey: "cluster", get group() { return bi("集群文档", "Cluster Docs"); } },
  kt: { get icon() { return bi("交", "H"); }, groupKey: "cluster", get group() { return bi("集群文档", "Cluster Docs"); } },
  change: { get icon() { return bi("变", "C"); }, groupKey: "change", get group() { return bi("变更实施方案", "Change Plans"); } },
  rca: { get icon() { return bi("因", "A"); }, groupKey: "rca", get group() { return bi("根因分析", "Root-Cause Analysis"); } },
  assess: { get icon() { return bi("评", "E"); }, groupKey: "assess", get group() { return bi("评估", "Assessments"); } },
};

function docState(d: ClusterDoc, aiOn = false): { label: string; tone: string } {
  if (d.drafts)
    return {
      label: aiOn
        ? bi(`${d.drafts} 段 AI 草稿待确认`, `${d.drafts} AI ${d.drafts === 1 ? "draft" : "drafts"} pending`)
        : bi(`${d.drafts} 段草稿待确认`, `${d.drafts} ${d.drafts === 1 ? "draft" : "drafts"} pending`),
      tone: aiOn ? "ai" : "todo",
    };
  if (d.stale)
    return {
      label: bi(`${d.stale} 节可能过时`, `${d.stale} ${d.stale === 1 ? "section" : "sections"} possibly stale`),
      tone: "warn",
    };
  if (d.empty)
    return {
      label: bi(`${d.empty} 节待填写`, `${d.empty} ${d.empty === 1 ? "section" : "sections"} to fill`),
      tone: "todo",
    };
  return { label: d.sections ? bi("已完成", "Complete") : bi("无需填写", "Ready"), tone: "ok" };
}

/** What an execution report shows and exports: the steps written as commands, as the playbooks, or both, and the results. */
export type ReportView = { detail?: boolean; steps: "cmd" | "auto" | "both"; results: boolean };
const DEFAULT_VIEW: ReportView = { detail: false, steps: "auto", results: true };
const keeps = (v: DocBlock["variant"], view: ReportView) =>
  v === "cmd"
    ? view.steps !== "auto"
    : v === "auto"
      ? view.steps !== "cmd"
      : v === "result"
        ? view.results
        : true;
const hasVariants = (d: ClusterDoc) => (d.blocks || []).some((b) => b.variant);
const exportQuery = (view: ReportView) =>
  `&steps=${view.steps === "both" ? "cmd,auto" : view.steps}&results=${view.results ? 1 : 0}&detail=${view.detail ? 1 : 0}`;

function ReportOptions({
  view,
  setView,
  compact,
}: {
  view: ReportView;
  setView: (v: ReportView) => void;
  compact?: boolean;
}) {
  useLang();
  return (
    <div className={`dc-ropts ${compact ? "compact" : ""}`}>
      <div className="dc-ropt">
        <span className="dc-ropt-l">{bi("报告内容", "Report detail")}</span>
        <Segmented
          value={view.detail ? "detail" : "summary"}
          onChange={(v) => setView({ ...view, detail: v === "detail" })}
          label={bi("报告内容", "Report detail")}
          options={[
            { value: "summary", label: bi("结果摘要", "Summary") },
            { value: "detail", label: bi("摘要与详细证据", "Summary & Evidence") },
          ]}
        />
      </div>
      {view.detail && <div className="dc-ropt">
        <span className="dc-ropt-l">{bi("步骤内容", "Steps")}</span>
        <Segmented<ReportView["steps"]>
          value={view.steps}
          onChange={(steps) => setView({ ...view, steps })}
          label={bi("步骤写法", "Step format")}
          options={[
            { value: "cmd", label: bi("命令版", "Commands") },
            { value: "auto", label: bi("Playbook 步骤", "Playbooks") },
            { value: "both", label: bi("两种都要", "Both") },
          ]}
        />
        <span className="faint small">
          {view.steps === "cmd"
            ? bi("计划中的命令与执行位置，实际结果以证据为准", "Planned commands and targets; actual outcomes come from evidence")
            : view.steps === "auto"
              ? bi("计划中的 Playbook 和任务，实际结果以证据为准", "Planned playbooks and tasks; actual outcomes come from evidence")
              : bi("每一步先写自动化执行，再写分机器的命令", "Lists automation execution first, followed by per-host commands")}
        </span>
      </div>}{view.detail && <div className="dc-ropt">
        <span className="dc-ropt-l">{bi("执行结果", "Execution results")}</span>
        <Segmented<"yes" | "no">
          value={view.results ? "yes" : "no"}
          onChange={(v) => setView({ ...view, results: v === "yes" })}
          label={bi("执行结果", "Execution results")}
          options={[
            { value: "yes", label: bi("带上现场结果", "Include on-site results") },
            { value: "no", label: bi("只要执行步骤", "Steps only") },
          ]}
        />
        <span className="faint small">
          {view.results
            ? bi("包含执行节点回传的证据，以及现场人员补充的记录", "Includes execution node evidence and notes added on-site")
            : bi("不含现场记录，可当作操作手册交给下一个现场", "Excludes on-site records; suitable as a reusable runbook")}
        </span>
      </div>}
    </div>
  );
}

const openDoc = (c: ClusterView, id?: string, replace = false) =>
  go({ name: "deliveries", id: c.id, tab: "docs", doc: id }, { replace });

const docsListPath = (clusterId: string) =>
  `/api/clusters/${encodeURIComponent(clusterId)}/docs`;
const docItemPath = (clusterId: string, docId: string) =>
  `/api/clusters/${encodeURIComponent(clusterId)}/docs/${encodeURIComponent(docId)}`;

/** Warms the cluster docs list and primary documents so switching to the Docs tab renders instantaneously. */
export function prefetchClusterDocs(clusterId: string) {
  const listUrl = docsListPath(clusterId);
  void fetchCached<ClusterDoc[]>(listUrl)
    .then((docs) => {
      for (const d of docs.slice(0, 2)) {
        void fetchCached<ClusterDoc>(docItemPath(clusterId, d.id)).catch(
          () => {},
        );
      }
    })
    .catch(() => {});
}

export function DocsTab({ c, doc }: { c: ClusterView; doc?: string }) {
  const lang = useLang();
  const listUrl = docsListPath(c.id);
  const [list, setList] = useState<ClusterDoc[] | null>(
    () => cached<ClusterDoc[]>(listUrl) ?? null,
  );
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState<string[] | null>(null);
  const [view, setView] = useState<ReportView>(DEFAULT_VIEW);
  const [docQuery, setDocQuery] = useState("");
  const [onlyTodo, setOnlyTodo] = useState(false);
  const ai = useAIStatus();
  const aiOn = ai.enabled;
  const canAI = aiOn && !!ai.features?.docs && can("ai.use") && can("report.edit");
  const load = () =>
    api<ClusterDoc[]>(listUrl)
      .then((r) => {
        putCached(listUrl, r);
        setList(r);
        setError("");
        for (const item of r.slice(0, 2)) {
          const itemUrl = docItemPath(c.id, item.id);
          if (!cached(itemUrl)) {
            void fetchCached<ClusterDoc>(itemUrl).catch(() => {});
          }
        }
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    const hit = cached<ClusterDoc[]>(listUrl);
    if (hit !== undefined) setList(hit);
    else setList(null);
    setError("");
    void load();
  }, [c.id, c.updated, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  if (doc)
    return (
      <>
        <DocView
          c={c}
          id={doc}
          list={list}
          view={view}
          setView={setView}
          onChanged={load}
          onExport={(ids) => setExporting(ids)}
        />
        <ExportDialog
          c={c}
          list={list || []}
          pick={exporting}
          view={view}
          setView={setView}
          aiOn={aiOn}
          close={() => setExporting(null)}
        />
      </>
    );
  if (!list)
    return (
      <section className="dsec dc-home">
        {error ? (
          <div className="list-state">
            <p>{bi("文档加载失败：", "Failed to load docs: ")}{error}</p>
            <Button size="small" onClick={() => (setError(""), load())}>
              {bi("重试", "Retry")}
            </Button>
          </div>
        ) : (
          <Skeleton animation text={{ rows: 4 }} />
        )}
      </section>
    );
  const todo = list.reduce((n, d) => n + d.drafts + d.empty, 0);
  const todoDocs = list.filter((d) => d.drafts + d.empty + d.stale > 0);
  const qNorm = docQuery.trim().toLowerCase();
  const subtitleOf = (d: ClusterDoc) =>
    d.kind === "change" || d.kind === "rca" || d.kind === "assess"
      ? d.subtitle || ""
      : d.kind === "kt"
        ? bi("交给日常运维：巡检、常见操作、排查手段", "For daily ops: health checks, routine tasks, troubleshooting")
        : bi("架构留存：拓扑、版本与集群部署记录", "Architecture archive: topology, versions, and deployment records");
  const filteredList = list.filter((d) => {
    if (onlyTodo && todoDocs.length > 0 && d.drafts + d.empty + d.stale === 0)
      return false;
    if (
      qNorm &&
      !`${d.title} ${subtitleOf(d)} ${KIND[d.kind].group}`
        .toLowerCase()
        .includes(qNorm)
    )
      return false;
    return true;
  });
  const groupDefs = [
    { key: "cluster", label: bi("集群文档", "Cluster Docs") },
    { key: "change", label: bi("变更实施方案", "Change Plans") },
    { key: "rca", label: bi("根因分析", "Root-Cause Analysis") },
    { key: "assess", label: bi("评估", "Assessments") },
  ];
  const groups = groupDefs
    .map((gd) => ({
      g: gd.label,
      items: filteredList.filter((d) => KIND[d.kind].groupKey === gd.key),
    }))
    .filter((x) => x.items.length);
  return (
    <section className="dsec dc-home">
      <div className="dc-home-h">
        <p className="muted small">
          {bi("事实（拓扑、版本、执行记录）由平台整理，始终和集群一致；", "Facts (topology, versions, execution records) are kept in sync with the cluster automatically; ")}
          {canAI
            ? bi("概述、风险、结论这类文字由你填写，或让 AI 起草后确认。", "narrative sections like overview, risks, and conclusions can be written by you or drafted by AI.")
            : bi("概述、风险、结论这类文字按实际情况逐节填写并确认。", "fill in narrative sections such as overview, risks, and conclusions as needed.")}
          {todo > 0 ? bi(`还有 ${todo} 处待处理。`, ` ${todo} pending.`) : ""}
        </p>
        <span className="dc-home-acts">
          {can("report.edit") && <StartAssess c={c} aiOn={canAI} />}
          {can("report.edit") && <StartRCA c={c} />}
          {can("report.export") && (
            <Button
              type="primary"
              icon={<IconDownload />}
              onClick={() => setExporting(list.map((d) => d.id))}
            >
              {bi("导出 Word…", "Export Word…")}
            </Button>
          )}
        </span>
      </div>
      {(todoDocs.length > 0 && todoDocs.length < list.length) ||
      list.length >= 4 ? (
        <div className="dc-filter-bar">
          {todoDocs.length > 0 && todoDocs.length < list.length ? (
            <div className="dc-filter-pills" role="group" aria-label={bi("文档筛选", "Filter documents")}>
              <button
                type="button"
                className={`dc-filter-pill ${!onlyTodo ? "on" : ""}`}
                onClick={() => setOnlyTodo(false)}
              >
                {bi("全部", "All")} <em>{list.length}</em>
              </button>
              <button
                type="button"
                className={`dc-filter-pill ${onlyTodo ? "on" : ""}`}
                onClick={() => setOnlyTodo(true)}
              >
                {bi("待完善", "Needs work")} <em>{todoDocs.length}</em>
              </button>
            </div>
          ) : (
            <span />
          )}
          {list.length >= 4 && (
            <Input
              size="small"
              allowClear
              className="dc-filter-search"
              prefix={<IconSearch />}
              value={docQuery}
              onChange={setDocQuery}
              placeholder={bi("搜索文档标题或说明…", "Search doc titles or descriptions…")}
              aria-label={bi("搜索运维文档", "Search docs")}
            />
          )}
        </div>
      ) : null}
      {groups.length > 0 ? (
        groups.map(({ g, items }) => (
          <div key={g} className="dc-grp">
            <div className="dc-grp-h">{g}</div>
            <div className="dc-grp-list">
              {items.map((d) => {
                const st = docState(d, aiOn);
                return (
                  <a
                    key={d.id}
                    className="dc-row"
                    href={`#/d/${encodeURIComponent(c.id)}/docs/${d.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      openDoc(c, d.id);
                    }}
                  >
                    <span className={`dc-ic dc-k-${d.kind}`} aria-hidden>
                      {KIND[d.kind].icon}
                    </span>
                    <span className="dc-row-main">
                      <b>{d.title}</b>
                      <span className="muted small">{subtitleOf(d)}</span>
                    </span>
                    <span className={`dc-st dc-st-${st.tone}`}>{st.label}</span>
                    <span className="dc-row-time faint small num">
                      {d.updated ? bi(`${ago(d.updated)}编辑`, `Edited ${ago(d.updated)}`) : ""}
                    </span>
                    <IconRight className="faint" />
                  </a>
                );
              })}
            </div>
          </div>
        ))
      ) : (
        <div className="list-state">
          <p>{bi("没有匹配的文档", "No matching documents")}</p>
          <Button
            size="small"
            onClick={() => {
              setDocQuery("");
              setOnlyTodo(false);
            }}
          >
            {bi("显示全部文档", "Show All Docs")}
          </Button>
        </div>
      )}
      <ExportDialog
        c={c}
        list={list}
        pick={exporting}
        view={view}
        setView={setView}
        aiOn={aiOn}
        close={() => setExporting(null)}
      />
    </section>
  );
}

type Finding = {
  section: string;
  level: string;
  problem: string;
  suggest: string;
};

function DocView({
  c,
  id,
  list,
  view,
  setView,
  onChanged,
  onExport,
}: {
  c: ClusterView;
  id: string;
  list: ClusterDoc[] | null;
  view: ReportView;
  setView: (v: ReportView) => void;
  onChanged: () => void;
  onExport: (ids: string[]) => void;
}) {
  const lang = useLang();
  const itemUrl = docItemPath(c.id, id);
  const [d, setD] = useState<ClusterDoc | null>(
    () => cached<ClusterDoc>(itemUrl) ?? null,
  );
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const ai = useAIStatus();
  const aiOn = ai.enabled;
  const canAI = aiOn && !!ai.features?.docs && can("ai.use") && can("report.edit");
  useEffect(() => {
    let alive = true;
    const hit = cached<ClusterDoc>(itemUrl);
    setD(hit ?? null);
    setError("");
    setFindings(null);
    api<ClusterDoc>(itemUrl)
      .then((r) => {
        putCached(itemUrl, r);
        if (alive) setD(r);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [c.id, id, itemUrl, lang]);
  const update = (nd: ClusterDoc) => {
    putCached(itemUrl, nd);
    setD(nd);
    onChanged();
  };
  const check = async () => {
    setChecking(true);
    try {
      const r = await api<{ findings: Finding[] }>(
        `/api/clusters/${c.id}/docs/${id}/check`,
        { method: "POST" },
      );
      setFindings(r.findings);
      if (!r.findings.length) Message.success(bi("没有发现问题", "No issues found"));
    } catch (e) {
      err(e);
    } finally {
      setChecking(false);
    }
  };
  const i = (list || []).findIndex((x) => x.id === id);
  const prev = list?.[i - 1];
  const next = list?.[i + 1];
  useEffect(() => {
    for (const adj of [prev, next]) {
      if (!adj) continue;
      const adjUrl = docItemPath(c.id, adj.id);
      if (!cached(adjUrl)) {
        void fetchCached<ClusterDoc>(adjUrl).catch(() => {});
      }
    }
  }, [c.id, prev?.id, next?.id]);
  return (
    <div className="dc-view">
      <nav className="cl-crumb" aria-label={bi("位置", "Breadcrumb")}>
        <button
          type="button"
          className="link quiet"
          onClick={() => openDoc(c, undefined, true)}
        >
          <IconArrowLeft /> {bi("全部文档", "All Docs")}
        </button>
        <span className="cl-switch">
          <Button
            size="mini"
            disabled={!prev}
            onClick={() => prev && openDoc(c, prev.id, true)}
          >
            {bi("上一份", "Previous")}
          </Button>
          <Button
            size="mini"
            disabled={!next}
            onClick={() => next && openDoc(c, next.id, true)}
          >
            {bi("下一份", "Next")}
          </Button>
        </span>
      </nav>
      {!d ? (
        error ? (
          <div className="detail-none">
            <h2>{bi("打不开这份文档", "Unable to open document")}</h2>
            <p>{error}</p>
          </div>
        ) : (
          <Skeleton animation text={{ rows: 8 }} />
        )
      ) : (
        <>
          <header className="dc-bar">
            <div>
              <h2>
                {d.title}
                {d.subtitle && d.kind !== "delivery" && d.kind !== "kt" && (
                  <span className="faint"> · {d.subtitle}</span>
                )}
              </h2>
              <span className={`dc-st dc-st-${docState(d, aiOn).tone}`}>
                {docState(d, aiOn).label}
              </span>
            </div>
            <div className="dc-bar-acts">
              {canAI && (
                <Tooltip
                  content={bi(
                    "让 AI 对照执行记录，检查文字有没有和事实矛盾、回避问题或遗漏",
                    "Have AI cross-check prose against execution records for contradictions or omissions",
                  )}
                  mini
                >
                  <Button
                    shape="round"
                    className="ai-pill"
                    icon={<Spark size={14} rainbow />}
                    loading={checking}
                    onClick={check}
                  >
                    {bi("AI 检查", "AI Review")}
                  </Button>
                </Tooltip>
              )}
              {aiOn && (d.kind === "rca" || d.kind === "change") && can("kb.submit") && (
                <ToKB c={c} d={d} />
              )}
              {d.manual && can("report.edit") && (
                <Tooltip content={bi(`删除这份${d.title}和其中写好的内容`, `Delete this ${d.title} and all its content`)} mini>
                  <Button
                    icon={<IconDelete />}
                    aria-label={bi(`删除这份${d.title}`, `Delete ${d.title}`)}
                    onClick={() =>
                      Modal.confirm({
                        title: bi(`删除这份${d.title}？`, `Delete this ${d.title}?`),
                        content: bi("写好的内容会一起删除，不能恢复。", "Written content will be permanently deleted."),
                        okText: bi("删除", "Delete"),
                        okButtonProps: { status: "danger" },
                        onOk: async () => {
                          try {
                            await api(`/api/clusters/${c.id}/docs/${d.id}`, {
                              method: "DELETE",
                            });
                            onChanged();
                            openDoc(c, undefined, true);
                          } catch (e) {
                            err(e);
                          }
                        },
                      })
                    }
                  />
                </Tooltip>
              )}
              {can("report.export") && (
                <Button
                  type="primary"
                  icon={<IconDownload />}
                  onClick={() => onExport([d.id])}
                >
                  {bi("导出 Word", "Export Word")}
                </Button>
              )}
            </div>
          </header>
          {findings && findings.length > 0 && (
            <div className="dc-findings" role="region" aria-label={bi("AI 检查结果", "AI review findings")}>
              <div className="dc-findings-h">
                <b>
                  {bi(
                    `AI 检查发现 ${findings.length} 处可以改进`,
                    `AI review found ${findings.length} ${findings.length === 1 ? "suggestion" : "suggestions"}`,
                  )}
                </b>
                <button
                  type="button"
                  className="link quiet"
                  onClick={() => setFindings(null)}
                >
                  {bi("收起", "Dismiss")}
                </button>
              </div>
              {findings.map((f, k) => (
                <div
                  key={k}
                  className={`dc-finding ${f.level === "error" ? "bad" : ""}`}
                >
                  <IconExclamationCircle />
                  <div>
                    <b>{f.section}</b>
                    <span>{f.problem}</span>
                    {f.suggest && <small>{bi("建议：", "Suggestion: ")}{f.suggest}</small>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {hasVariants(d) && <ReportOptions view={view} setView={setView} />}
          <Paper c={c} d={d} view={view} aiOn={aiOn} canAI={canAI} onSaved={update} />
        </>
      )}
    </div>
  );
}

/** The document as a page: an optional section jump strip, a cover strip, then the blocks. */
function Paper({
  c,
  d,
  view,
  aiOn,
  canAI,
  onSaved,
}: {
  c: ClusterView;
  d: ClusterDoc;
  view: ReportView;
  aiOn: boolean;
  canAI: boolean;
  onSaved: (d: ClusterDoc) => void;
}) {
  useLang();
  const visibleBlocks = (d.blocks || []).filter(
    (b) => (!b.detail || view.detail) && keeps(b.variant, view),
  );
  const outline = visibleBlocks
    .map((b, idx) => {
      if (b.kind === "section" && b.key && b.title) {
        const has = !!(b.text || "").trim();
        const isDraft = has && b.source === "ai" && !b.confirmed;
        return {
          id: `sec-${b.key}`,
          label: b.title,
          tone: isDraft ? "draft" : has ? "done" : "empty",
        };
      }
      if (b.kind === "h" && (b.level || 1) === 1 && b.text) {
        return {
          id: `doc-h-${idx}`,
          label: b.text,
          tone: "",
        };
      }
      return null;
    })
    .filter((x): x is { id: string; label: string; tone: string } => Boolean(x));

  return (
    <>
      {outline.length >= 2 && (
        <nav className="dc-outline" aria-label={bi("文档章节导航", "Document sections")}>
          <span className="dc-outline-label">{bi("章节", "Sections")}</span>
          {outline.map((item) => (
            <button
              key={item.id}
              type="button"
              className="dc-outline-btn"
              onClick={() => {
                document.getElementById(item.id)?.scrollIntoView({
                  behavior: reducedMotion() ? "auto" : "smooth",
                  block: "start",
                });
              }}
            >
              {item.tone && (
                <i className={`dc-outline-dot ${item.tone}`} aria-hidden />
              )}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      )}
      <article className="dc-paper" aria-label={d.title}>
        <div className="dc-cover">
          <div className="dc-cover-t">{d.title}</div>
          <dl>
            {(d.cover || []).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        {visibleBlocks.map((b, i) => (
          <Block
            key={b.key || i}
            headingId={
              b.kind === "h" && (b.level || 1) === 1 ? `doc-h-${i}` : undefined
            }
            b={b}
            c={c}
            d={d}
            aiOn={aiOn}
            canAI={canAI}
            onSaved={onSaved}
          />
        ))}
      </article>
    </>
  );
}

function DocCodeBlock({ text }: { text: string }) {
  useLang();
  const [copied, setCopied] = useState(false);
  return (
    <div className="dc-code-wrap">
      <pre className="dc-code">{text}</pre>
      {text.trim() && (
        <Tooltip content={copied ? bi("已复制", "Copied") : bi("复制代码", "Copy code")} mini>
          <button
            type="button"
            className={`dc-code-copy ${copied ? "copied" : ""}`}
            aria-label={copied ? bi("已复制代码", "Code copied") : bi("复制代码", "Copy code")}
            onClick={() => {
              copy(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? <IconCheck /> : <IconCopy />}
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** Text with **bold** and "- " lists, as the Word file renders it. */
function Rich({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let items: string[] = [];
  const bold = (s: string) =>
    s.split("**").map((x, i) => (i % 2 ? <b key={i}>{x}</b> : x));
  const flush = () => {
    if (items.length)
      out.push(
        <ul key={out.length}>
          {items.map((x, i) => (
            <li key={i}>{bold(x)}</li>
          ))}
        </ul>,
      );
    items = [];
  };
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (/^[-•*] /.test(t)) {
      items.push(t.slice(2));
      continue;
    }
    flush();
    if (t) out.push(<p key={out.length}>{bold(t.replace(/^#+\s*/, ""))}</p>);
  }
  flush();
  return <>{out}</>;
}

function Block({
  b,
  headingId,
  c,
  d,
  aiOn,
  canAI,
  onSaved,
}: {
  b: DocBlock;
  headingId?: string;
  c: ClusterView;
  d: ClusterDoc;
  aiOn: boolean;
  canAI: boolean;
  onSaved: (d: ClusterDoc) => void;
}) {
  switch (b.kind) {
    case "h": {
      const H = `h${Math.min((b.level || 1) + 2, 6)}` as unknown as "h3";
      return (
        <H id={headingId} className={`dc-h dc-h${b.level}`}>
          {b.text}
        </H>
      );
    }
    case "p":
      return (
        <div className="dc-p">
          <Rich text={b.text || ""} />
        </div>
      );
    case "note":
      return <p className="dc-note">{b.text}</p>;
    case "code":
      return <DocCodeBlock text={b.text || ""} />;
    case "old":
      return (
        <div className="dc-old">
          <p className="dc-note">{b.title}</p>
          {b.text && <pre className="dc-code">{b.text}</pre>}
          {(b.items || []).map((x, i) => (
            <p key={i}>{x}</p>
          ))}
        </div>
      );
    case "image":
      return (
        <div className="dc-shots">
          {(b.items || []).map((n, i) => (
            <a
              key={n}
              href={`/api/jobs/${b.job}/progress/img/${n}`}
              target="_blank"
              rel="noreferrer"
              title={bi("在新标签页打开原图", "Open full image in new tab")}
            >
              <img
                src={`/api/jobs/${b.job}/progress/img/${n}`}
                alt={bi(`现场截图 ${i + 1}`, `Screenshot ${i + 1}`)}
                loading="lazy"
              />
            </a>
          ))}
        </div>
      );
    case "list":
      return (
        <ul className="dc-list">
          {(b.items || []).map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="dc-table-wrap">
          <table className="dc-table">
            {b.head && (
              <thead>
                <tr>
                  {b.head.map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {(b.rows || []).map((r, i) => (
                <tr key={i}>
                  {r.map((x, k) => (
                    <td key={k}>{x}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "section":
      return <Section b={b} c={c} d={d} aiOn={aiOn} canAI={canAI} onSaved={onSaved} />;
  }
  return null;
}

/** A section people write: empty, an assistant draft waiting for confirmation, or confirmed text. */
function Section({
  b,
  c,
  d,
  aiOn,
  canAI,
  onSaved,
}: {
  b: DocBlock;
  c: ClusterView;
  d: ClusterDoc;
  aiOn: boolean;
  canAI: boolean;
  onSaved: (d: ClusterDoc) => void;
}) {
  useLang();
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(b.text || "");
  const [asking, setAsking] = useState(false);
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "draft">("");
  const [questions, setQuestions] = useState<
    { question: string; options?: string[] }[]
  >([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const box = useRef<HTMLDivElement>(null);
  const may = can("report.edit");
  const has = !!(b.text || "").trim();
  const draft = has && b.source === "ai" && !b.confirmed;
  const url = `/api/clusters/${c.id}/docs/${d.id}/sections/${b.key}`;

  const save = async (t: string, confirmed: boolean) => {
    setBusy("save");
    try {
      const nd = await api<ClusterDoc>(url, {
        method: "PUT",
        body: JSON.stringify({ text: t, confirmed }),
      });
      onSaved(nd);
      setEdit(false);
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };
  const runDraft = async (replies?: { question: string; answer: string }[]) => {
    setBusy("draft");
    setAsking(false);
    try {
      const r = await api<
        ClusterDoc & { questions?: { question: string; options?: string[] }[] }
      >(`${url}/draft`, {
        method: "POST",
        body: JSON.stringify({ ask, answers: replies || [] }),
      });
      if (r.questions?.length) {
        // the assistant needs something only the people on site know before it writes this
        setQuestions(r.questions);
        setAnswers({});
        return;
      }
      setQuestions([]);
      onSaved(r);
      setAsk("");
      Message.info(bi("AI 起草好了，请核对后确认", "AI draft ready; review and confirm"));
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };
  const answered = questions.every((_, i) => (answers[i] || "").trim());
  const startEdit = () => {
    setText(b.text || "");
    setEdit(true);
    setTimeout(() => box.current?.querySelector("textarea")?.focus(), 30);
  };

  return (
    <section
      className={`dc-sec ${draft ? "draft" : has ? "done" : "empty"} ${edit ? "editing" : ""}`}
      id={`sec-${b.key}`}
      ref={box}
    >
      <div className="dc-sec-h">
        {React.createElement(
          `h${Math.min((b.level || 1) + 2, 6)}`,
          { className: `dc-h dc-h${b.level}` },
          b.title,
        )}
        {has && !edit && (
          <span
            className={`dc-badge ${draft && aiOn ? "ai" : "ok"}`}
            title={b.at ? `${b.by || ""} ${fullTime(b.at)}` : undefined}
          >
            {draft ? (
              aiOn ? (
                <>
                  <Spark /> {bi("AI 草稿 · 待确认", "AI Draft · Unconfirmed")}
                </>
              ) : (
                <>{bi("草稿 · 待确认", "Draft · Unconfirmed")}</>
              )
            ) : (
              <>
                <IconCheck />{" "}
                {b.source === "ai" && aiOn
                  ? bi("AI 起草，已确认", "AI-drafted, confirmed")
                  : bi("已填写", "Completed")}
              </>
            )}
          </span>
        )}
        {may && has && !edit && busy !== "draft" && (
          <span className="dc-sec-acts">
            {draft && (
              <Button
                size="mini"
                type="primary"
                icon={<IconCheck />}
                loading={busy === "save"}
                onClick={() => save(b.text || "", true)}
              >
                {bi("确认", "Confirm")}
              </Button>
            )}
            {has && (
              <Button size="mini" icon={<IconEdit />} onClick={startEdit}>
                {bi("编辑", "Edit")}
              </Button>
            )}
            {b.ai && canAI && (
              <Button
                size="mini"
                shape="round"
                className="ai-pill"
                icon={<Spark size={12} rainbow />}
                onClick={() => setAsking((x) => !x)}
              >
                {has ? bi("重新起草", "Redraft") : bi("AI 起草", "AI Draft")}
              </Button>
            )}
          </span>
        )}
      </div>
      {asking && (
        <div className="dc-ask">
          <Input
            size="small"
            value={ask}
            onChange={setAsk}
            placeholder={bi(
              "补充要求（可选），例如：写得简短些；强调备份还没有定时任务",
              "Additional instructions (optional), e.g., keep it brief; note backups have no cron yet",
            )}
            onPressEnter={() => runDraft()}
            autoFocus
            aria-label={bi("给 AI 的补充要求", "Instructions for AI")}
          />
          <Button size="small" type="primary" onClick={() => runDraft()}>
            {bi("开始起草", "Generate Draft")}
          </Button>
          <Button size="small" onClick={() => setAsking(false)}>
            {bi("取消", "Cancel")}
          </Button>
        </div>
      )}
      {has && b.stale && !edit && busy !== "draft" && (
        <div className="dc-stale">
          <span>
            {bi(
              `集群在这之后完成了${b.stale}，这一节可能已经不符合现在的样子。`,
              `Cluster completed ${b.stale} afterwards; this section may be out of date.`,
            )}
          </span>
          {may && (
            <span className="dc-stale-acts">
              <button
                type="button"
                className="link"
                disabled={busy === "save"}
                onClick={() => save(b.text || "", true)}
              >
                {bi("仍然适用", "Still accurate")}
              </button>
              {b.ai && canAI && (
                <button
                  type="button"
                  className="link"
                  onClick={() => runDraft()}
                >
                  {bi("按现在的集群重新起草", "Redraft for current state")}
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {questions.length > 0 && busy !== "draft" && (
        <div className="dc-qs" role="group" aria-label={bi("AI 的提问", "AI questions")}>
          <span className="dc-qs-h">
            <Spark /> {bi("写这一节之前，AI 需要你补充：", "Before drafting, AI needs a few details:")}
          </span>
          {questions.map((q, i) => (
            <div key={q.question} className="dc-q">
              <b>{q.question}</b>
              <div className="dc-q-opts">
                {(q.options || []).map((o) => (
                  <button
                    key={o}
                    type="button"
                    className={`dc-q-opt ${answers[i] === o ? "on" : ""}`}
                    onClick={() => setAnswers((a) => ({ ...a, [i]: o }))}
                  >
                    {o}
                  </button>
                ))}
              </div>
              <Input
                size="small"
                value={
                  (q.options || []).includes(answers[i]) ? "" : answers[i] || ""
                }
                onChange={(v) => setAnswers((a) => ({ ...a, [i]: v }))}
                placeholder={bi("或者自己写", "Or write your own")}
                aria-label={bi(`回答：${q.question}`, `Answer: ${q.question}`)}
              />
            </div>
          ))}
          <div className="dc-qs-foot">
            <Button size="small" onClick={() => setQuestions([])}>
              {bi("先不写", "Skip")}
            </Button>
            <Button
              size="small"
              type="primary"
              disabled={!answered}
              onClick={() =>
                runDraft(
                  questions.map((q, i) => ({
                    question: q.question,
                    answer: answers[i],
                  })),
                )
              }
            >
              {bi("回答并起草", "Answer & Draft")}
            </Button>
          </div>
        </div>
      )}
      {busy === "draft" ? (
        <div className="dc-drafting" aria-live="polite">
          <span>
            <Spark /> {bi("AI 正在阅读平台整理的事实并起草…", "AI is reading cluster facts and drafting…")}
          </span>
          <Skeleton
            animation
            text={{ rows: 3, width: ["92%", "86%", "60%"] }}
          />
        </div>
      ) : edit ? (
        <div className="dc-edit">
          <Input.TextArea
            value={text}
            onChange={setText}
            autoSize={{ minRows: 5, maxRows: 24 }}
            placeholder={b.hint}
            aria-label={b.title}
            maxLength={20000}
          />
          <div className="dc-edit-foot">
            <span className="faint small">
              {bi(
                '空行分段，"- " 开头为列表，**文字** 加粗；导出 Word 时保持一致。',
                'Blank lines for paragraphs, "- " for bullets, **bold** for emphasis; preserved in Word export.',
              )}
            </span>
            <Button size="small" onClick={() => setEdit(false)}>
              {bi("取消", "Cancel")}
            </Button>
            <Button
              size="small"
              type="primary"
              loading={busy === "save"}
              onClick={() => save(text, true)}
            >
              {bi("保存", "Save")}
            </Button>
          </div>
        </div>
      ) : has ? (
        <div className="dc-p">
          <Rich text={b.text || ""} />
        </div>
      ) : (
        <div className="dc-empty">
          <span>{b.hint}</span>
          {may && (
            <span className="dc-empty-acts">
              <button type="button" className="link" onClick={startEdit}>
                {bi("自己填写", "Write manually")}
              </button>
              {b.ai && canAI && (
                <button
                  type="button"
                  className="link"
                  onClick={() => setAsking(true)}
                >
                  {bi("让 AI 起草", "Draft with AI")}
                </button>
              )}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** Pick documents and export them, one Word each (in a zip) or merged into one. */
type ReportSummary = {
  use_template: boolean;
  template?: string;
  theme: string;
  theme_name: string;
  org: string;
  doc_version: string;
  has_banner: boolean;
};

function ExportDialog({
  c,
  list,
  pick,
  view,
  setView,
  aiOn,
  close,
}: {
  c: ClusterView;
  list: ClusterDoc[];
  pick: string[] | null;
  view: ReportView;
  setView: (v: ReportView) => void;
  aiOn: boolean;
  close: () => void;
}) {
  const lang = useLang();
  const [sel, setSel] = useState<string[]>([]);
  const [merge, setMerge] = useState<"one" | "each">("one");
  const [front, setFront] = useState(true);
  const [tplSummary, setTplSummary] = useState<ReportSummary | null>(() =>
    cached<ReportSummary>("/api/settings/report/summary") ?? null,
  );
  useEffect(() => {
    if (pick) {
      setSel(pick);
      setMerge(pick.length > 1 ? "one" : "each");
      api<ReportSummary>("/api/settings/report/summary")
        .then(setTplSummary)
        .catch(() => {});
    }
  }, [pick, lang]);
  const chosen = list.filter((d) => sel.includes(d.id));
  const drafts = chosen.reduce((n, d) => n + d.drafts, 0);
  const empty = chosen.reduce((n, d) => n + d.empty, 0);
  const reports = chosen.some(
    (d) => d.kind === "delivery" || d.kind === "change",
  );
  const url = `/api/clusters/${c.id}/export?docs=${sel.join(",")}${merge === "one" ? "&merge=1" : ""}${front ? "" : "&front=0"}${reports ? exportQuery(view) : ""}`;
  return (
    <Modal
      visible={!!pick}
      title={bi("导出 Word", "Export Word")}
      onCancel={close}
      className="dc-export"
      footer={
        <>
          {can("settings.report") && (
            <button
              type="button"
              className="link quiet dc-tpl"
              onClick={() => (close(), go({ name: "settings", id: "report" }))}
            >
              {bi("模板与公文规范", "Templates & Formatting")}
            </button>
          )}
          <Button onClick={close}>{bi("取消", "Cancel")}</Button>
          <Button
            type="primary"
            icon={<IconDownload />}
            disabled={!sel.length}
            onClick={() => {
              window.location.href = withLang(url);
              close();
            }}
          >
            {sel.length > 1 && merge === "each"
              ? bi(`下载 ${sel.length} 个文件（zip）`, `Download ${sel.length} files (.zip)`)
              : bi("下载", "Download")}
          </Button>
        </>
      }
    >
      {tplSummary && (
        <div className="dc-ex-tpl">
          <span>
            {bi("当前版式：", "Layout: ")}
            <b>
              {tplSummary.use_template && tplSummary.template
                ? bi(`自定义模板（${tplSummary.template}）`, `Custom template (${tplSummary.template})`)
                : bi(
                    `${tplSummary.theme_name || "深青标准"} · 企业公文规范 ${tplSummary.doc_version || "V1.0"}`,
                    `${tplSummary.theme_name || "Teal Standard"} · Doc Standard ${tplSummary.doc_version || "V1.0"}`,
                  )}
            </b>
            {tplSummary.org ? ` · ${tplSummary.org}` : ""}
          </span>
          {can("settings.report") && (
            <button
              type="button"
              className="link small"
              onClick={() => (close(), go({ name: "settings", id: "report" }))}
            >
              {bi("调整版式", "Customize")}
            </button>
          )}
        </div>
      )}
      <div className="dc-ex-list" role="group" aria-label={bi("要导出的文档", "Documents to export")}>
        {list.map((d) => (
          <Checkbox
            key={d.id}
            checked={sel.includes(d.id)}
            onChange={(on) =>
              setSel((s) =>
                on
                  ? list
                      .filter((x) => s.includes(x.id) || x.id === d.id)
                      .map((x) => x.id)
                  : s.filter((x) => x !== d.id),
              )
            }
          >
            <span className="dc-ex-row">
              <span className={`dc-ic sm dc-k-${d.kind}`} aria-hidden>
                {KIND[d.kind].icon}
              </span>
              <b>{d.title}</b>
              {(d.kind === "change" ||
                d.kind === "rca" ||
                d.kind === "assess") && (
                <span className="muted">{d.subtitle}</span>
              )}
              <span className={`dc-st dc-st-${docState(d, aiOn).tone}`}>
                {docState(d, aiOn).label}
              </span>
            </span>
          </Checkbox>
        ))}
      </div>
      {sel.length > 1 && (
        <div className="dc-ex-mode">
          <Segmented<"one" | "each">
            value={merge}
            onChange={setMerge}
            label={bi("导出方式", "Export mode")}
            options={[
              { value: "one", label: bi("合并成一个 Word", "Merge into one .docx") },
              { value: "each", label: bi("每份一个文件", "One file per doc") },
            ]}
          />
          <span className="faint small">
            {merge === "one"
              ? bi("统一封面和目录，按所选顺序排列", "Unified cover and TOC in selected order")
              : bi("每份文档独立成一个 Word，打包下载", "Separate .docx files bundled in a .zip")}
          </span>
        </div>
      )}
      {reports && <ReportOptions view={view} setView={setView} compact />}
      <div className="dc-ex-front">
        <Checkbox checked={front} onChange={setFront}>
          {bi(
            "使用标准公文版式（含封面、罗马页码目录与版本控制页）",
            "Use standard document layout (cover page, Roman-numeral TOC, revision history)",
          )}
        </Checkbox>
      </div>
      {(drafts > 0 || empty > 0) && (
        <p className="dc-ex-warn">
          <IconFile />{" "}
          {bi("所选文档还有", "Selected documents still have ")}
          {[
            drafts
              ? aiOn
                ? bi(` ${drafts} 段 AI 草稿没确认`, `${drafts} unconfirmed AI ${drafts === 1 ? "draft" : "drafts"}`)
                : bi(` ${drafts} 段草稿没确认`, `${drafts} unconfirmed ${drafts === 1 ? "draft" : "drafts"}`)
              : "",
            empty
              ? bi(` ${empty} 节没填写`, `${empty} empty ${empty === 1 ? "section" : "sections"}`)
              : "",
          ]
            .filter(Boolean)
            .join(bi("、", " and "))}
          {bi("。可以照常导出：", ". You can still export: ")}
          {[
            drafts ? bi("草稿按现在的内容写入", "drafts are included as written") : "",
            empty ? bi("没填写的会标为“未填写”", "empty sections are marked as unfilled") : "",
          ]
            .filter(Boolean)
            .join(bi("，", "; "))}
          {bi("。", ".")}
        </p>
      )}
    </Modal>
  );
}

/** Sends a root-cause analysis or verified change SOP to the team knowledge base, where it is reviewed before the assistant can use it. */
function ToKB({ c, d }: { c: ClusterView; d: ClusterDoc }) {
  useLang();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [team, setTeam] = useState("");
  const [busy, setBusy] = useState(false);
  const teams = myTeams();
  const sec = (k: string) =>
    (d.blocks || [])
      .find((b) => b.kind === "section" && b.key === k)
      ?.text?.trim() || "";
  const isChange = d.kind === "change";
  const ready = isChange ? true : !!sec("cause");
  const start = () => {
    if (isChange) {
      setTitle(`${c.app_name} ${d.title}`);
      const sopBody = (d.blocks || [])
        .map((b) => {
          if (b.kind === "h") return `## ${b.text || ""}`;
          if (b.kind === "section" && b.text?.trim())
            return `## ${b.title || ""}\n${b.text.trim()}`;
          if (b.kind === "p" && b.text?.trim()) return b.text.trim();
          if (b.kind === "code" && b.text?.trim())
            return `\`\`\`bash\n${b.text.trim()}\n\`\`\``;
          return "";
        })
        .filter(Boolean)
        .join("\n\n");
      setText(
        [
          bi(
            `适用：${c.app_name}（集群 ${c.id}，${d.subtitle || "变更实施方案"}）`,
            `Applies to: ${c.app_name} (Cluster ${c.id}, ${d.subtitle || "Change Plan"})`,
          ),
          sopBody,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      setTeam(teams[0]?.id || "");
      setOpen(true);
      return;
    }
    const failed = (d.blocks || []).find(
      (b, i, all) =>
        b.kind === "h" &&
        b.level === 2 &&
        all
          .slice(0, i)
          .some((x) => x.kind === "h" && (x.text?.includes("失败的步骤") || /failed steps?/i.test(x.text || ""))),
    );
    const step = (failed?.text || "")
      .replace(/^(?:阶段：|Phase:\s*)/i, "")
      .replace(/^\[[^\]]+\]\s*/, "");
    setTitle(
      bi(
        `${c.app_name} ${d.subtitle || "交付"}${step ? `在「${step}」` : ""}失败的原因与处理`,
        `${c.app_name} ${d.subtitle || "delivery"} failure${step ? ` at "${step}"` : ""}: cause & resolution`,
      ),
    );
    setText(
      [
        bi(
          `适用：${c.app_name}（集群 ${c.id}，${d.subtitle}）`,
          `Applies to: ${c.app_name} (Cluster ${c.id}, ${d.subtitle})`,
        ),
        sec("symptom") && `## ${bi("现象", "Symptom")}\n${sec("symptom")}`,
        sec("cause") && `## ${bi("根因", "Root Cause")}\n${sec("cause")}`,
        sec("handling") && `## ${bi("处理", "Resolution")}\n${sec("handling")}`,
        sec("improve") && `## ${bi("以后怎么避免", "Prevention")}\n${sec("improve")}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    setTeam(teams[0]?.id || "");
    setOpen(true);
  };
  const send = async () => {
    setBusy(true);
    try {
      await api("/api/kb/submissions", {
        method: "POST",
        body: JSON.stringify({
          title,
          text,
          team,
          source: `${isChange ? bi("变更实施方案", "Change Plan") : bi("根因分析报告", "RCA Report")} · ${c.id} · ${d.subtitle || d.title}`,
        }),
      });
      Message.success(bi("已提交到团队知识库，审核通过后 AI 回答时就能查到", "Submitted to team KB; available to AI once approved"));
      setOpen(false);
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Tooltip
        content={
          isChange
            ? bi("把经测试环境演练通过的变更实施方案沉淀为团队知识库经验", "Save this verified change plan to the team knowledge base")
            : ready
              ? bi("把现象、根因和处理办法整理成一条经验，审核后进入团队知识库", "Package symptom, root cause, and resolution into a KB entry for review")
              : bi("先写好「根因分析」一节", "Complete the Root Cause section first")
        }
        mini
      >
        <span>
          <Button icon={<IconBook />} disabled={!ready} onClick={start}>
            {bi("存入知识库", "Save to KB")}
          </Button>
        </span>
      </Tooltip>
      <Modal
        visible={open}
        title={bi("存入团队知识库", "Save to Team Knowledge Base")}
        onCancel={() => setOpen(false)}
        onOk={send}
        okText={bi("提交审核", "Submit for Review")}
        okButtonProps={{
          loading: busy,
          disabled: !title.trim() || !text.trim(),
        }}
        className="dc-kb"
      >
        <div className="dc-kb-form">
          <label>
            <span>{bi("标题", "Title")}</span>
            <Input
              value={title}
              onChange={setTitle}
              maxLength={120}
              aria-label={bi("标题", "Title")}
            />
          </label>
          {teams.length > 0 && (
            <label>
              <span>{bi("提交到", "Submit to")}</span>
              <Segmented<string>
                value={team}
                onChange={setTeam}
                label={bi("提交到", "Submit to")}
                options={[
                  ...teams.map((t) => ({ value: t.id, label: t.name })),
                  { value: "", label: bi("全平台", "Platform-wide") },
                ]}
              />
            </label>
          )}
          <label>
            <span>{bi("内容", "Content")}</span>
            <Input.TextArea
              value={text}
              onChange={setText}
              autoSize={{ minRows: 8, maxRows: 18 }}
              aria-label={bi("内容", "Content")}
            />
          </label>
          <p className="faint small">
            {bi(
              "提交后由知识库管理员审核；通过后，大家用 AI 排障时遇到相同问题就能查到这条经验。",
              "Reviewed by KB admins; once approved, AI troubleshooting can reference it for similar issues.",
            )}
          </p>
        </div>
      </Modal>
    </>
  );
}

/** Starts a root-cause analysis by hand: for one of the cluster's plans, or for an incident outside any plan. */
function StartRCA({ c }: { c: ClusterView }) {
  useLang();
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState<string>("incident");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const plans = c.plans.filter(
    (p) => p.state === "succeeded" && p.outcome !== "void",
  );
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ id: string }>(`/api/clusters/${c.id}/docs`, {
        method: "POST",
        body: JSON.stringify(what === "incident" ? { title } : { job: what }),
      });
      setOpen(false);
      openDoc(c, r.id);
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        icon={<IconPlus />}
        onClick={() => (setWhat("incident"), setTitle(""), setOpen(true))}
      >
        {bi("根因分析", "Root-Cause Analysis")}
      </Button>
      <Modal
        visible={open}
        title={bi("发起根因分析", "New Root-Cause Analysis")}
        onCancel={() => setOpen(false)}
        onOk={start}
        okText={bi("开始写", "Create")}
        okButtonProps={{
          loading: busy,
          disabled: what === "incident" && !title.trim(),
        }}
        className="dc-rca-new"
      >
        <p className="muted small">
          {bi(
            "分析什么？部署执行失败时平台已经自动建好了；这里用于交付完成后运行中才暴露的问题，或者和部署过程无关的集群故障。",
            "Failed deployments already generate an RCA automatically; use this for post-delivery runtime issues or unrelated cluster incidents.",
          )}
        </p>
        <div className="dc-rca-opts" role="radiogroup" aria-label={bi("分析对象", "Target")}>
          <button
            type="button"
            role="radio"
            aria-checked={what === "incident"}
            className={`dc-rca-opt ${what === "incident" ? "on" : ""}`}
            onClick={() => setWhat("incident")}
          >
            <b>{bi("集群故障", "Cluster Incident")}</b>
            <span>{bi("和部署交付无关，例如运行中主库切换、节点掉线", "Unrelated to deployment, e.g., unexpected failover or node offline")}</span>
          </button>
          {plans.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={what === p.id}
              className={`dc-rca-opt ${what === p.id ? "on" : ""}`}
              onClick={() => setWhat(p.id)}
            >
              <b>
                {p.delivery_mode === "configuration" ? bi("配置交付", "Config Delivery") : bi("集群部署", "Cluster Deployment")}
              </b>
              <span>
                {PLAN_PHASE[planPhase(p)].label} · {ago(p.created)}
              </span>
            </button>
          ))}
        </div>
        {what === "incident" && (
          <Input
            value={title}
            onChange={setTitle}
            placeholder={bi("给这次故障起个名字，例如：10 月 27 日主库切换后写入中断", "Name this incident, e.g., Write outage after Oct 27 primary failover")}
            maxLength={80}
            aria-label={bi("故障名称", "Incident title")}
            autoFocus
          />
        )}
      </Modal>
    </>
  );
}

/** Asks for an assessment of the cluster: is it big enough (capacity), or which architecture fits (selection). */
function StartAssess({ c, aiOn }: { c: ClusterView; aiOn: boolean }) {
  useLang();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"capacity" | "selection">("capacity");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const examples = {
    capacity: bi(
      "例如：双十一订单量预计是平时的 5 倍，现在一主两从够不够？不够要怎么扩？",
      "e.g., Peak traffic will be 5x normal; is 1 primary + 2 replicas enough, or how should we scale?",
    ),
    selection: bi(
      "例如：应用直连三个节点，要不要在前面加负载均衡？HAProxy 和 Nginx 选哪个？",
      "e.g., Apps connect directly to 3 nodes; should we add HAProxy or Nginx in front?",
    ),
  };
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ id: string }>(`/api/clusters/${c.id}/docs`, {
        method: "POST",
        body: JSON.stringify({ kind: "assess", type, question: q }),
      });
      setOpen(false);
      openDoc(c, r.id);
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button icon={<IconPlus />} onClick={() => (setQ(""), setOpen(true))}>
        {bi("评估", "Assessment")}
      </Button>
      <Modal
        visible={open}
        title={bi("新建评估", "New Assessment")}
        onCancel={() => setOpen(false)}
        onOk={start}
        okText={bi("开始评估", "Create")}
        okButtonProps={{ loading: busy, disabled: !q.trim() }}
        className="dc-rca-new"
      >
        <div className="dc-assess-form">
          <Segmented<"capacity" | "selection">
            value={type}
            onChange={setType}
            label={bi("评估类型", "Assessment type")}
            options={[
              { value: "capacity", label: bi("容量评估", "Capacity") },
              { value: "selection", label: bi("选型建议", "Architecture") },
            ]}
          />
          <Input.TextArea
            value={q}
            onChange={setQ}
            placeholder={examples[type]}
            autoSize={{ minRows: 3, maxRows: 8 }}
            maxLength={1000}
            aria-label={bi("要回答的问题", "Question")}
            autoFocus
          />
          <p className="muted small">
            {aiOn
              ? bi("平台会把集群的拓扑、规格和经历带进评估；业务量、机器配置这些平台不知道的，AI 起草时会先问你。", "Platform includes cluster topology, specs, and history; AI will ask about workload and hardware sizing before drafting.")
              : bi("平台会把集群的拓扑、规格和经历整理进评估模板，创建后逐节填写业务量、机器配置与评估结论。", "Platform prepares a template with cluster topology, specs, and history for you to fill in workload and sizing details.")}
          </p>
        </div>
      </Modal>
    </>
  );
}

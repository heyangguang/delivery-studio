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
import "./docs.css";

/* The documents of a cluster (store_docs.go): the delivery report, the operations handover, a change report per plan
   and a root-cause analysis per failed plan. Facts come from the platform; the sections people write — or let the
   assistant draft and then confirm — are edited in place on the page. Everything exports to Word, one file each or
   merged into one. */

const KIND: Record<ClusterDoc["kind"], { icon: string; group: string }> = {
  delivery: { icon: "报", group: "集群文档" },
  kt: { icon: "交", group: "集群文档" },
  change: { icon: "变", group: "变更实施方案" },
  rca: { icon: "因", group: "根因分析" },
  assess: { icon: "评", group: "评估" },
};

function docState(d: ClusterDoc, aiOn = false): { label: string; tone: string } {
  if (d.drafts)
    return {
      label: aiOn ? `${d.drafts} 段 AI 草稿待确认` : `${d.drafts} 段草稿待确认`,
      tone: aiOn ? "ai" : "todo",
    };
  if (d.stale) return { label: `${d.stale} 节可能过时`, tone: "warn" };
  if (d.empty) return { label: `${d.empty} 节待填写`, tone: "todo" };
  return { label: d.sections ? "已完成" : "无需填写", tone: "ok" };
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
  return (
    <div className={`dc-ropts ${compact ? "compact" : ""}`}>
      <div className="dc-ropt">
        <span className="dc-ropt-l">报告内容</span>
        <Segmented value={view.detail?"detail":"summary"} onChange={v=>setView({...view,detail:v==="detail"})} label="报告内容" options={[{value:"summary",label:"结果摘要"},{value:"detail",label:"摘要与详细证据"}]}/>
      </div>
      {view.detail && <div className="dc-ropt">
        <span className="dc-ropt-l">步骤内容</span>
        <Segmented<ReportView["steps"]>
          value={view.steps}
          onChange={(steps) => setView({ ...view, steps })}
          label="步骤写法"
          options={[
            { value: "cmd", label: "命令版" },
            { value: "auto", label: "Playbook 步骤" },
            { value: "both", label: "两种都要" },
          ]}
        />
        <span className="faint small">
          {view.steps === "cmd"
            ? "计划中的命令与执行位置，实际结果以证据为准"
            : view.steps === "auto"
              ? "计划中的 Playbook 和任务，实际结果以证据为准"
              : "每一步先写自动化执行，再写分机器的命令"}
        </span>
      </div>}{view.detail && <div className="dc-ropt">
        <span className="dc-ropt-l">执行结果</span>
        <Segmented<"yes" | "no">
          value={view.results ? "yes" : "no"}
          onChange={(v) => setView({ ...view, results: v === "yes" })}
          label="执行结果"
          options={[
            { value: "yes", label: "带上现场结果" },
            { value: "no", label: "只要执行步骤" },
          ]}
        />
        <span className="faint small">
          {view.results
            ? "包含执行节点回传的证据，以及现场人员补充的记录"
            : "不含现场记录，可当作操作手册交给下一个现场"}
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
  }, [c.id, c.updated]); // eslint-disable-line react-hooks/exhaustive-deps

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
            <p>文档加载失败：{error}</p>
            <Button size="small" onClick={() => (setError(""), load())}>
              重试
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
        ? "交给日常运维：巡检、常见操作、排查手段"
        : "架构留存：拓扑、版本与集群部署记录";
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
  const groups = ["集群文档", "变更实施方案", "根因分析", "评估"]
    .map((g) => ({
      g,
      items: filteredList.filter((d) => KIND[d.kind].group === g),
    }))
    .filter((x) => x.items.length);
  return (
    <section className="dsec dc-home">
      <div className="dc-home-h">
        <p className="muted small">
          事实（拓扑、版本、执行记录）由平台整理，始终和集群一致；
          {canAI
            ? "概述、风险、结论这类文字由你填写，或让 AI 起草后确认。"
            : "概述、风险、结论这类文字按实际情况逐节填写并确认。"}
          {todo > 0 ? `还有 ${todo} 处待处理。` : ""}
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
              导出 Word…
            </Button>
          )}
        </span>
      </div>
      {(todoDocs.length > 0 && todoDocs.length < list.length) ||
      list.length >= 4 ? (
        <div className="dc-filter-bar">
          {todoDocs.length > 0 && todoDocs.length < list.length ? (
            <div className="dc-filter-pills" role="group" aria-label="文档筛选">
              <button
                type="button"
                className={`dc-filter-pill ${!onlyTodo ? "on" : ""}`}
                onClick={() => setOnlyTodo(false)}
              >
                全部 <em>{list.length}</em>
              </button>
              <button
                type="button"
                className={`dc-filter-pill ${onlyTodo ? "on" : ""}`}
                onClick={() => setOnlyTodo(true)}
              >
                待完善 <em>{todoDocs.length}</em>
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
              placeholder="搜索文档标题或说明…"
              aria-label="搜索运维文档"
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
                      {d.updated ? `${ago(d.updated)}编辑` : ""}
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
          <p>没有匹配的文档</p>
          <Button
            size="small"
            onClick={() => {
              setDocQuery("");
              setOnlyTodo(false);
            }}
          >
            显示全部文档
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
  }, [c.id, id, itemUrl]);
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
      if (!r.findings.length) Message.success("没有发现问题");
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
      <nav className="cl-crumb" aria-label="位置">
        <button
          type="button"
          className="link quiet"
          onClick={() => openDoc(c, undefined, true)}
        >
          <IconArrowLeft /> 全部文档
        </button>
        <span className="cl-switch">
          <Button
            size="mini"
            disabled={!prev}
            onClick={() => prev && openDoc(c, prev.id, true)}
          >
            上一份
          </Button>
          <Button
            size="mini"
            disabled={!next}
            onClick={() => next && openDoc(c, next.id, true)}
          >
            下一份
          </Button>
        </span>
      </nav>
      {!d ? (
        error ? (
          <div className="detail-none">
            <h2>打不开这份文档</h2>
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
                  content="让 AI 对照执行记录，检查文字有没有和事实矛盾、回避问题或遗漏"
                  mini
                >
                  <Button
                    shape="round"
                    className="ai-pill"
                    icon={<Spark size={14} rainbow />}
                    loading={checking}
                    onClick={check}
                  >
                    AI 检查
                  </Button>
                </Tooltip>
              )}
              {aiOn && (d.kind === "rca" || d.kind === "change") && can("kb.submit") && (
                <ToKB c={c} d={d} />
              )}
              {d.manual && can("report.edit") && (
                <Tooltip content={`删除这份${d.title}和其中写好的内容`} mini>
                  <Button
                    icon={<IconDelete />}
                    aria-label={`删除这份${d.title}`}
                    onClick={() =>
                      Modal.confirm({
                        title: `删除这份${d.title}？`,
                        content: "写好的内容会一起删除，不能恢复。",
                        okText: "删除",
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
                  导出 Word
                </Button>
              )}
            </div>
          </header>
          {findings && findings.length > 0 && (
            <div className="dc-findings" role="region" aria-label="AI 检查结果">
              <div className="dc-findings-h">
                <b>AI 检查发现 {findings.length} 处可以改进</b>
                <button
                  type="button"
                  className="link quiet"
                  onClick={() => setFindings(null)}
                >
                  收起
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
                    {f.suggest && <small>建议：{f.suggest}</small>}
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
        <nav className="dc-outline" aria-label="文档章节导航">
          <span className="dc-outline-label">章节</span>
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
  const [copied, setCopied] = useState(false);
  return (
    <div className="dc-code-wrap">
      <pre className="dc-code">{text}</pre>
      {text.trim() && (
        <Tooltip content={copied ? "已复制" : "复制代码"} mini>
          <button
            type="button"
            className={`dc-code-copy ${copied ? "copied" : ""}`}
            aria-label={copied ? "已复制代码" : "复制代码"}
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
              title="在新标签页打开原图"
            >
              <img
                src={`/api/jobs/${b.job}/progress/img/${n}`}
                alt={`现场截图 ${i + 1}`}
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
      Message.info("AI 起草好了，请核对后确认");
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
                  <Spark /> AI 草稿 · 待确认
                </>
              ) : (
                <>草稿 · 待确认</>
              )
            ) : (
              <>
                <IconCheck /> {b.source === "ai" && aiOn ? "AI 起草，已确认" : "已填写"}
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
                确认
              </Button>
            )}
            {has && (
              <Button size="mini" icon={<IconEdit />} onClick={startEdit}>
                编辑
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
                {has ? "重新起草" : "AI 起草"}
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
            placeholder="补充要求（可选），例如：写得简短些；强调备份还没有定时任务"
            onPressEnter={() => runDraft()}
            autoFocus
            aria-label="给 AI 的补充要求"
          />
          <Button size="small" type="primary" onClick={() => runDraft()}>
            开始起草
          </Button>
          <Button size="small" onClick={() => setAsking(false)}>
            取消
          </Button>
        </div>
      )}
      {has && b.stale && !edit && busy !== "draft" && (
        <div className="dc-stale">
          <span>
            集群在这之后完成了{b.stale}，这一节可能已经不符合现在的样子。
          </span>
          {may && (
            <span className="dc-stale-acts">
              <button
                type="button"
                className="link"
                disabled={busy === "save"}
                onClick={() => save(b.text || "", true)}
              >
                仍然适用
              </button>
              {b.ai && canAI && (
                <button
                  type="button"
                  className="link"
                  onClick={() => runDraft()}
                >
                  按现在的集群重新起草
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {questions.length > 0 && busy !== "draft" && (
        <div className="dc-qs" role="group" aria-label="AI 的提问">
          <span className="dc-qs-h">
            <Spark /> 写这一节之前，AI 需要你补充：
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
                placeholder="或者自己写"
                aria-label={`回答：${q.question}`}
              />
            </div>
          ))}
          <div className="dc-qs-foot">
            <Button size="small" onClick={() => setQuestions([])}>
              先不写
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
              回答并起草
            </Button>
          </div>
        </div>
      )}
      {busy === "draft" ? (
        <div className="dc-drafting" aria-live="polite">
          <span>
            <Spark /> AI 正在阅读平台整理的事实并起草…
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
              空行分段，"- " 开头为列表，**文字** 加粗；导出 Word 时保持一致。
            </span>
            <Button size="small" onClick={() => setEdit(false)}>
              取消
            </Button>
            <Button
              size="small"
              type="primary"
              loading={busy === "save"}
              onClick={() => save(text, true)}
            >
              保存
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
                自己填写
              </button>
              {b.ai && canAI && (
                <button
                  type="button"
                  className="link"
                  onClick={() => setAsking(true)}
                >
                  让 AI 起草
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
  }, [pick]);
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
      title="导出 Word"
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
              模板与公文规范
            </button>
          )}
          <Button onClick={close}>取消</Button>
          <Button
            type="primary"
            icon={<IconDownload />}
            disabled={!sel.length}
            onClick={() => {
              window.location.href = url;
              close();
            }}
          >
            {sel.length > 1 && merge === "each"
              ? `下载 ${sel.length} 个文件（zip）`
              : "下载"}
          </Button>
        </>
      }
    >
      {tplSummary && (
        <div className="dc-ex-tpl">
          <span>
            当前版式：
            <b>
              {tplSummary.use_template && tplSummary.template
                ? `自定义模板（${tplSummary.template}）`
                : `${tplSummary.theme_name || "深青标准"} · 企业公文规范 ${tplSummary.doc_version || "V1.0"}`}
            </b>
            {tplSummary.org ? ` · ${tplSummary.org}` : ""}
          </span>
          {can("settings.report") && (
            <button
              type="button"
              className="link small"
              onClick={() => (close(), go({ name: "settings", id: "report" }))}
            >
              调整版式
            </button>
          )}
        </div>
      )}
      <div className="dc-ex-list" role="group" aria-label="要导出的文档">
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
            label="导出方式"
            options={[
              { value: "one", label: "合并成一个 Word" },
              { value: "each", label: "每份一个文件" },
            ]}
          />
          <span className="faint small">
            {merge === "one"
              ? "统一封面和目录，按所选顺序排列"
              : "每份文档独立成一个 Word，打包下载"}
          </span>
        </div>
      )}
      {reports && <ReportOptions view={view} setView={setView} compact />}
      <div className="dc-ex-front">
        <Checkbox checked={front} onChange={setFront}>
          使用标准公文版式（含封面、罗马页码目录与版本控制页）
        </Checkbox>
      </div>
      {(drafts > 0 || empty > 0) && (
        <p className="dc-ex-warn">
          <IconFile /> 所选文档还有
          {[
            drafts ? (aiOn ? ` ${drafts} 段 AI 草稿没确认` : ` ${drafts} 段草稿没确认`) : "",
            empty ? ` ${empty} 节没填写` : "",
          ]
            .filter(Boolean)
            .join("、")}
          。可以照常导出：
          {[
            drafts ? "草稿按现在的内容写入" : "",
            empty ? "没填写的会标为“未填写”" : "",
          ]
            .filter(Boolean)
            .join("，")}
          。
        </p>
      )}
    </Modal>
  );
}

/** Sends a root-cause analysis or verified change SOP to the team knowledge base, where it is reviewed before the assistant can use it. */
function ToKB({ c, d }: { c: ClusterView; d: ClusterDoc }) {
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
        [`适用：${c.app_name}（集群 ${c.id}，${d.subtitle || "变更实施方案"}）`, sopBody]
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
          .some((x) => x.kind === "h" && x.text?.includes("失败的步骤")),
    );
    const step = (failed?.text || "")
      .replace(/^阶段：/, "")
      .replace(/^\[[^\]]+\]\s*/, "");
    setTitle(
      `${c.app_name} ${d.subtitle || "交付"}${step ? `在「${step}」` : ""}失败的原因与处理`,
    );
    setText(
      [
        `适用：${c.app_name}（集群 ${c.id}，${d.subtitle}）`,
        sec("symptom") && `## 现象\n${sec("symptom")}`,
        sec("cause") && `## 根因\n${sec("cause")}`,
        sec("handling") && `## 处理\n${sec("handling")}`,
        sec("improve") && `## 以后怎么避免\n${sec("improve")}`,
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
          source: `${isChange ? "变更实施方案" : "根因分析报告"} · ${c.id} · ${d.subtitle || d.title}`,
        }),
      });
      Message.success("已提交到团队知识库，审核通过后 AI 回答时就能查到");
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
            ? "把经测试环境演练通过的变更实施方案沉淀为团队知识库经验"
            : ready
              ? "把现象、根因和处理办法整理成一条经验，审核后进入团队知识库"
              : "先写好「根因分析」一节"
        }
        mini
      >
        <span>
          <Button icon={<IconBook />} disabled={!ready} onClick={start}>
            存入知识库
          </Button>
        </span>
      </Tooltip>
      <Modal
        visible={open}
        title="存入团队知识库"
        onCancel={() => setOpen(false)}
        onOk={send}
        okText="提交审核"
        okButtonProps={{
          loading: busy,
          disabled: !title.trim() || !text.trim(),
        }}
        className="dc-kb"
      >
        <div className="dc-kb-form">
          <label>
            <span>标题</span>
            <Input
              value={title}
              onChange={setTitle}
              maxLength={120}
              aria-label="标题"
            />
          </label>
          {teams.length > 0 && (
            <label>
              <span>提交到</span>
              <Segmented<string>
                value={team}
                onChange={setTeam}
                label="提交到"
                options={[
                  ...teams.map((t) => ({ value: t.id, label: t.name })),
                  { value: "", label: "全平台" },
                ]}
              />
            </label>
          )}
          <label>
            <span>内容</span>
            <Input.TextArea
              value={text}
              onChange={setText}
              autoSize={{ minRows: 8, maxRows: 18 }}
              aria-label="内容"
            />
          </label>
          <p className="faint small">
            提交后由知识库管理员审核；通过后，大家用 AI
            排障时遇到相同问题就能查到这条经验。
          </p>
        </div>
      </Modal>
    </>
  );
}

/** Starts a root-cause analysis by hand: for one of the cluster's plans, or for an incident outside any plan. */
function StartRCA({ c }: { c: ClusterView }) {
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
        根因分析
      </Button>
      <Modal
        visible={open}
        title="发起根因分析"
        onCancel={() => setOpen(false)}
        onOk={start}
        okText="开始写"
        okButtonProps={{
          loading: busy,
          disabled: what === "incident" && !title.trim(),
        }}
        className="dc-rca-new"
      >
        <p className="muted small">
          分析什么？部署执行失败时平台已经自动建好了；这里用于交付完成后运行中才暴露的问题，或者和部署过程无关的集群故障。
        </p>
        <div className="dc-rca-opts" role="radiogroup" aria-label="分析对象">
          <button
            type="button"
            role="radio"
            aria-checked={what === "incident"}
            className={`dc-rca-opt ${what === "incident" ? "on" : ""}`}
            onClick={() => setWhat("incident")}
          >
            <b>集群故障</b>
            <span>和部署交付无关，例如运行中主库切换、节点掉线</span>
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
                {p.delivery_mode === "configuration" ? "配置交付" : "集群部署"}
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
            placeholder="给这次故障起个名字，例如：10 月 27 日主库切换后写入中断"
            maxLength={80}
            aria-label="故障名称"
            autoFocus
          />
        )}
      </Modal>
    </>
  );
}

/** Asks for an assessment of the cluster: is it big enough (capacity), or which architecture fits (selection). */
function StartAssess({ c, aiOn }: { c: ClusterView; aiOn: boolean }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"capacity" | "selection">("capacity");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const examples = {
    capacity:
      "例如：双十一订单量预计是平时的 5 倍，现在一主两从够不够？不够要怎么扩？",
    selection:
      "例如：应用直连三个节点，要不要在前面加负载均衡？HAProxy 和 Nginx 选哪个？",
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
        评估
      </Button>
      <Modal
        visible={open}
        title="新建评估"
        onCancel={() => setOpen(false)}
        onOk={start}
        okText="开始评估"
        okButtonProps={{ loading: busy, disabled: !q.trim() }}
        className="dc-rca-new"
      >
        <div className="dc-assess-form">
          <Segmented<"capacity" | "selection">
            value={type}
            onChange={setType}
            label="评估类型"
            options={[
              { value: "capacity", label: "容量评估" },
              { value: "selection", label: "选型建议" },
            ]}
          />
          <Input.TextArea
            value={q}
            onChange={setQ}
            placeholder={examples[type]}
            autoSize={{ minRows: 3, maxRows: 8 }}
            maxLength={1000}
            aria-label="要回答的问题"
            autoFocus
          />
          <p className="muted small">
            {aiOn
              ? "平台会把集群的拓扑、规格和经历带进评估；业务量、机器配置这些平台不知道的，AI 起草时会先问你。"
              : "平台会把集群的拓扑、规格和经历整理进评估模板，创建后逐节填写业务量、机器配置与评估结论。"}
          </p>
        </div>
      </Modal>
    </>
  );
}

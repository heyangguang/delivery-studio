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
  IconCheckCircleFill,
  IconCopy,
  IconDelete,
  IconPlus,
  IconDownload,
  IconEdit,
  IconFile,
  IconRefresh,
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
  toPasteSafeShell,
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
export type ReportView = {
  detail?: boolean;
  steps: "cmd" | "auto" | "both";
  results: boolean;
  logStyle: "cmd" | "auto" | "both";
};
const DEFAULT_VIEW: ReportView = {
  detail: false,
  steps: "cmd",
  results: true,
  logStyle: "cmd",
};
const keeps = (v: DocBlock["variant"], view: ReportView) =>
  v === "cmd"
    ? view.steps !== "auto"
    : v === "auto"
      ? view.steps !== "cmd"
      : v === "result"
        ? view.results
        : v === "result_auto"
          ? view.results && view.logStyle !== "cmd"
          : v === "result_cmd"
            ? view.results && view.logStyle !== "auto"
            : true;
const hasVariants = (d: ClusterDoc) => (d.blocks || []).some((b) => b.variant);
const exportQuery = (view: ReportView) =>
  `&steps=${view.steps === "both" ? "cmd,auto" : view.steps}&results=${view.results ? 1 : 0}&detail=${view.detail ? 1 : 0}&log_style=${view.logStyle === "both" ? "cmd,auto" : view.logStyle}`;

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
      {view.detail && (
        <div className="dc-ropt">
          <span className="dc-ropt-l">{bi("步骤内容", "Steps")}</span>
          <Segmented<ReportView["steps"]>
            value={view.steps}
            onChange={(steps) =>
              setView({
                ...view,
                steps,
                logStyle: steps,
              })
            }
            label={bi("步骤写法", "Step format")}
            options={[
              { value: "cmd", label: bi("命令版", "Commands") },
              { value: "auto", label: bi("Playbook 步骤", "Playbooks") },
              { value: "both", label: bi("两种都要", "Both") },
            ]}
          />
          <span className="faint small">
            {view.steps === "cmd"
              ? bi("按机器整理的 Linux 命令与成功判据，适合直接作为客户交付手册", "Per-host Linux commands and pass criteria in ops-manual style")
              : view.steps === "auto"
                ? bi("计划中的 Playbook 和任务，实际结果以证据为准", "Planned playbooks and tasks; actual outcomes come from evidence")
                : bi("每一步先写自动化执行，再写分机器的命令", "Lists automation execution first, followed by per-host commands")}
          </span>
        </div>
      )}
      {view.detail && (
        <div className="dc-ropt">
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
        </div>
      )}
      {view.detail && view.results && (
        <div className="dc-ropt">
          <span className="dc-ropt-l">{bi("执行日志", "Log format")}</span>
          <Segmented<ReportView["logStyle"]>
            value={view.logStyle}
            onChange={(logStyle) => setView({ ...view, logStyle })}
            label={bi("执行日志样式", "Execution log format")}
            options={[
              { value: "cmd", label: bi("命令终端版", "Terminal Log") },
              { value: "auto", label: bi("Ansible 日志", "Ansible Log") },
              { value: "both", label: bi("两种都要", "Both") },
            ]}
          />
          <span className="faint small">
            {view.logStyle === "cmd"
              ? bi("紧贴每一步展示 Linux 终端命令与真实回显（[root@host ~]#），简洁直观", "Clean Linux terminal prompt & real stdout right beneath each step")
              : view.logStyle === "auto"
                ? bi("保留 Ansible 主机执行汇总表（Recap）与 Playbook 原始输出日志", "Ansible host Recap summary tables and raw playbook output logs")
                : bi("同时保留命令终端回显与完整 Ansible 自动化执行日志", "Includes both Linux terminal transcripts and Ansible execution logs")}
          </span>
        </div>
      )}
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

export function DocsTab({
  c,
  doc,
}: {
  c: ClusterView;
  doc?: string;
}) {
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
  id?: string;
  section_key?: string;
  section: string;
  category?: "completeness" | "consistency" | "honesty" | "security" | "clarity" | string;
  level: "error" | "warn" | "tip" | string;
  problem: string;
  evidence?: string;
  suggest: string;
  proposed_text?: string;
  action_kind?: "apply_text" | "draft_section" | "confirm_draft" | "jump" | string;
};

type DocCheckMetrics = {
  total_sections: number;
  completed: number;
  empty: number;
  drafts: number;
  stale: number;
  errors: number;
  warns: number;
  tips: number;
};

type DocCheckResult = {
  score: number;
  verdict: "ready" | "needs_fill" | "needs_fix" | string;
  summary: string;
  checked_at?: string;
  model?: string;
  metrics?: DocCheckMetrics;
  findings: Finding[];
};

const RV_CAT_LABEL: Record<string, () => string> = {
  completeness: () => bi("完整性", "Completeness"),
  consistency: () => bi("事实核对", "Fact Check"),
  honesty: () => bi("客观坦诚", "Objectivity"),
  security: () => bi("安全合规", "Security"),
  clarity: () => bi("交付规范", "Clarity"),
};

function jumpToDocEl(elId: string) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.scrollIntoView({
    behavior: reducedMotion() ? "auto" : "smooth",
    block: "start",
  });
  el.classList.remove("dc-flash");
  void el.offsetWidth;
  el.classList.add("dc-flash");
  setTimeout(() => el.classList.remove("dc-flash"), 1400);
}

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
  const [draftingAll, setDraftingAll] = useState(false);
  const [review, setReview] = useState<DocCheckResult | null>(null);
  const [appliedIDs, setAppliedIDs] = useState<Record<string, boolean>>({});
  const [busyItem, setBusyItem] = useState<string>("");
  const [applyingAll, setApplyingAll] = useState(false);
  const ai = useAIStatus();
  const aiOn = ai.enabled;
  const canAI = aiOn && !!ai.features?.docs && can("ai.use") && can("report.edit");
  useEffect(() => {
    let alive = true;
    const hit = cached<ClusterDoc>(itemUrl);
    setD(hit ?? null);
    setError("");
    setReview(null);
    setAppliedIDs({});
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
    if (checking) return;
    setChecking(true);
    try {
      const r = await api<DocCheckResult>(
        `/api/clusters/${c.id}/docs/${id}/check`,
        { method: "POST" },
      );
      setReview(r);
      setAppliedIDs({});
      if (!r.findings?.length) {
        Message.success(bi("AI 审阅通过，文档达到交付标准", "AI review passed"));
      }
    } catch (e) {
      err(e);
    } finally {
      setChecking(false);
    }
  };
  const draftAllEmpty = async () => {
    if (draftingAll) return;
    setDraftingAll(true);
    try {
      const r = await api<{ drafted: number; doc: ClusterDoc }>(
        `/api/clusters/${c.id}/docs/${id}/draft-all`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (r.doc) update(r.doc);
      if (r.drafted > 0) {
        Message.success(
          bi(
            `已一次性起草 ${r.drafted} 个待填章节草稿，请逐节核对确认`,
            `Drafted ${r.drafted} empty section(s); please review and confirm`,
          ),
        );
      } else {
        Message.info(bi("所有可起草章节均已填写", "All draftable sections are already filled"));
      }
    } catch (e) {
      err(e);
    } finally {
      setDraftingAll(false);
    }
  };
  const applyFindingProposal = async (
    f: Finding,
    fid: string,
    confirmed: boolean,
  ) => {
    if (!f.section_key || !f.proposed_text || busyItem) return;
    setBusyItem(fid);
    try {
      const nd = await api<ClusterDoc>(
        `/api/clusters/${c.id}/docs/${id}/sections/${f.section_key}`,
        {
          method: "PUT",
          body: JSON.stringify({
            text: f.proposed_text,
            confirmed,
            source: "ai",
          }),
        },
      );
      update(nd);
      setAppliedIDs((prev) => ({ ...prev, [fid]: true }));
      Message.success(
        confirmed
          ? bi(`已采纳并确认「${f.section}」`, `Applied & confirmed "${f.section}"`)
          : bi(`已写入「${f.section}」为待确认草稿`, `Saved "${f.section}" as draft`),
      );
    } catch (e) {
      err(e);
    } finally {
      setBusyItem("");
    }
  };
  const draftFindingSection = async (f: Finding, fid: string) => {
    if (!f.section_key || busyItem) return;
    setBusyItem(fid);
    try {
      const nd = await api<ClusterDoc>(
        `/api/clusters/${c.id}/docs/${id}/sections/${f.section_key}/draft`,
        { method: "POST", body: JSON.stringify({}) },
      );
      update(nd);
      setAppliedIDs((prev) => ({ ...prev, [fid]: true }));
      Message.success(bi(`已为「${f.section}」生成 AI 草稿`, `Drafted "${f.section}"`));
      jumpToDocEl(`sec-${f.section_key}`);
    } catch (e) {
      err(e);
    } finally {
      setBusyItem("");
    }
  };
  const confirmFindingDraft = async (f: Finding, fid: string) => {
    if (!f.section_key || !d || busyItem) return;
    const sec = (d.blocks || []).find(
      (b) => b.kind === "section" && b.key === f.section_key,
    );
    if (!sec?.text) return;
    setBusyItem(fid);
    try {
      const nd = await api<ClusterDoc>(
        `/api/clusters/${c.id}/docs/${id}/sections/${f.section_key}`,
        {
          method: "PUT",
          body: JSON.stringify({ text: sec.text, confirmed: true, source: "ai" }),
        },
      );
      update(nd);
      setAppliedIDs((prev) => ({ ...prev, [fid]: true }));
      Message.success(bi(`已确认「${f.section}」`, `Confirmed "${f.section}"`));
    } catch (e) {
      err(e);
    } finally {
      setBusyItem("");
    }
  };
  const applyAllProposals = async () => {
    if (!review || applyingAll) return;
    const seen = new Set<string>();
    const queue = (review.findings || []).filter((f, idx) => {
      const fid = f.id || String(idx);
      if (appliedIDs[fid] || !f.section_key || !f.proposed_text) return false;
      if (seen.has(f.section_key)) return false;
      seen.add(f.section_key);
      return true;
    });
    if (!queue.length) return;
    setApplyingAll(true);
    let okN = 0;
    try {
      for (const f of queue) {
        const fid = f.id || `${f.section_key}`;
        const nd = await api<ClusterDoc>(
          `/api/clusters/${c.id}/docs/${id}/sections/${f.section_key}`,
          {
            method: "PUT",
            body: JSON.stringify({
              text: f.proposed_text,
              confirmed: true,
              source: "ai",
            }),
          },
        );
        update(nd);
        setAppliedIDs((prev) => ({ ...prev, [fid]: true }));
        okN++;
      }
      Message.success(
        bi(`已一键采纳并写入 ${okN} 个章节建议`, `Applied ${okN} section suggestion(s)`),
      );
    } catch (e) {
      err(e);
    } finally {
      setApplyingAll(false);
    }
  };
  const emptyAICount = (d?.blocks || []).filter(
    (b) => b.kind === "section" && b.ai && !(b.text || "").trim(),
  ).length;
  const applicableProposalCount = (review?.findings || []).filter((f, idx) => {
    const fid = f.id || String(idx);
    return !appliedIDs[fid] && Boolean(f.section_key) && Boolean(f.proposed_text);
  }).length;
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
          className="cl-return"
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
              {canAI && emptyAICount > 0 && (
                <Tooltip
                  content={bi(
                    "结合本集群交付记录与安全态势，一次性起草全部尚未填写的章节",
                    "Draft all empty sections in one pass grounded in delivery & security facts",
                  )}
                  mini
                >
                  <Button
                    shape="round"
                    type="secondary"
                    icon={<Spark size={13} />}
                    loading={draftingAll}
                    disabled={checking}
                    onClick={draftAllEmpty}
                  >
                    {bi(`AI 补全待填 (${emptyAICount})`, `AI Fill Empty (${emptyAICount})`)}
                  </Button>
                </Tooltip>
              )}
              {canAI && (
                <Tooltip
                  content={bi(
                    "对照集群拓扑、执行记录与安全态势深度审阅全文，并直接生成可一键采纳的改写建议",
                    "Audit prose against topology, execution logs, and security posture with 1-click apply proposals",
                  )}
                  mini
                >
                  <Button
                    shape="round"
                    className="ai-pill"
                    icon={<Spark size={14} rainbow />}
                    loading={checking}
                    disabled={draftingAll}
                    onClick={check}
                  >
                    {bi("AI 深度审阅", "AI Audit")}
                  </Button>
                </Tooltip>
              )}
              {aiOn && !!ai.features?.kb && (d.kind === "rca" || d.kind === "change") && can("kb.submit") && (
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
          {(checking || draftingAll) && (
            <div className="dc-rv-busy" role="status">
              <Spark size={16} rainbow />
              <div className="dc-rv-busy-t">
                <b>
                  {draftingAll
                    ? bi(
                        `正在依据真实交付记录与安全态势批量起草 ${emptyAICount} 个待填章节…`,
                        `Drafting ${emptyAICount} empty section(s) from delivery & security facts…`,
                      )
                    : bi(
                        "AI 正在对照拓扑规格、执行记录、CVE 漏洞与配置基线进行深度审阅…",
                        "AI is auditing topology, execution logs, CVEs, and config baselines…",
                      )}
                </b>
                <small className="faint">
                  {draftingAll
                    ? bi("生成后将自动写入对应章节为待确认草稿，不编造任何现场数据", "Drafts will be saved as unconfirmed drafts grounded in facts")
                    : bi("审阅完成后将给出就绪评分、核查依据与可一键采纳的正文改写方案", "Will return a readiness score, evidence citations, and 1-click rewrite proposals")}
                </small>
              </div>
            </div>
          )}

          {review && !checking && (
            <section
              className={`dc-review v-${review.verdict}`}
              role="region"
              aria-label={bi("AI 深度审阅报告", "AI Audit Report")}
            >
              <div className="dc-rv-head">
                <div className="dc-rv-score-wrap">
                  <div
                    className={`dc-rv-score ${
                      review.score >= 85 ? "ok" : review.score >= 65 ? "warn" : "bad"
                    }`}
                  >
                    <b className="num">{review.score}</b>
                    <span>/100</span>
                  </div>
                  <div className="dc-rv-meta">
                    <div className="dc-rv-title-row">
                      <b>{bi("AI 交付审阅报告", "AI Delivery Audit")}</b>
                      <span className={`dc-rv-verdict v-${review.verdict}`}>
                        {review.verdict === "ready"
                          ? bi("可导出交付", "Ready to Export")
                          : review.verdict === "needs_fill"
                            ? bi("存在待填章节", "Sections Incomplete")
                            : bi("建议修订后交付", "Needs Revision")}
                      </span>
                      {review.model && (
                        <span className="dc-rv-model mono">{review.model}</span>
                      )}
                    </div>
                    <p className="dc-rv-sum">{review.summary}</p>
                    {review.metrics && (
                      <div className="dc-rv-stats num">
                        {review.metrics.errors > 0 && (
                          <span className="s-bad">
                            {bi(`严重 ${review.metrics.errors}`, `${review.metrics.errors} error(s)`)}
                          </span>
                        )}
                        {review.metrics.warns > 0 && (
                          <span className="s-warn">
                            {bi(`提醒 ${review.metrics.warns}`, `${review.metrics.warns} warning(s)`)}
                          </span>
                        )}
                        {review.metrics.tips > 0 && (
                          <span className="s-tip">
                            {bi(`建议 ${review.metrics.tips}`, `${review.metrics.tips} tip(s)`)}
                          </span>
                        )}
                        <span className="s-neutral">
                          {bi(
                            `章节已完成 ${review.metrics.completed}/${review.metrics.total_sections}`,
                            `Sections ${review.metrics.completed}/${review.metrics.total_sections}`,
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="dc-rv-head-acts">
                  {applicableProposalCount > 0 && can("report.edit") && (
                    <Button
                      size="small"
                      type="primary"
                      icon={<IconCheck />}
                      loading={applyingAll}
                      onClick={() => void applyAllProposals()}
                    >
                      {bi(
                        `一键采纳全部建议 (${applicableProposalCount})`,
                        `Apply All (${applicableProposalCount})`,
                      )}
                    </Button>
                  )}
                  <Button
                    size="small"
                    icon={<IconRefresh />}
                    loading={checking}
                    onClick={check}
                  >
                    {bi("重新审阅", "Re-audit")}
                  </Button>
                  <Button
                    size="small"
                    type="text"
                    onClick={() => setReview(null)}
                  >
                    {bi("收起", "Dismiss")}
                  </Button>
                </div>
              </div>

              {review.findings.length === 0 ? (
                <div className="dc-rv-pass">
                  <IconCheckCircleFill />
                  <span>
                    {bi(
                      "全文事实核对、完整性与安全基线披露均已通过，可直接导出正式 Word 报告。",
                      "All fact checks, completeness checks, and security disclosures passed. Ready to export.",
                    )}
                  </span>
                </div>
              ) : (
                <div className="dc-rv-list">
                  {review.findings.map((f, idx) => {
                    const fid = f.id || String(idx);
                    const done = Boolean(appliedIDs[fid]);
                    const isBusy = busyItem === fid;
                    const catLbl =
                      (f.category && RV_CAT_LABEL[f.category]?.()) ||
                      bi("规范检查", "Review");
                    const lvLbl =
                      f.level === "error"
                        ? bi("严重", "Error")
                        : f.level === "tip"
                          ? bi("建议", "Tip")
                          : bi("提醒", "Warn");
                    return (
                      <div
                        key={fid}
                        className={`dc-rv-item lv-${f.level} ${done ? "is-done" : ""}`}
                      >
                        <div className="dc-rv-item-top">
                          <div className="dc-rv-item-tags">
                            <span className={`dc-rv-lv lv-${f.level}`}>{lvLbl}</span>
                            <span className="dc-rv-cat">{catLbl}</span>
                            {f.section_key ? (
                              <button
                                type="button"
                                className="dc-rv-jump"
                                onClick={() => jumpToDocEl(`sec-${f.section_key}`)}
                              >
                                {f.section} ↗
                              </button>
                            ) : (
                              <b className="dc-rv-sec-txt">{f.section}</b>
                            )}
                            {done && (
                              <span className="dc-rv-applied">
                                <IconCheck /> {bi("已采纳写入", "Applied")}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="dc-rv-problem">{f.problem}</div>

                        {f.evidence && (
                          <div className="dc-rv-evidence">
                            <span>{bi("核查依据：", "Evidence: ")}</span>
                            {f.evidence}
                          </div>
                        )}

                        {f.suggest && (
                          <div className="dc-rv-suggest">
                            <span>{bi("改进建议：", "Suggestion: ")}</span>
                            {f.suggest}
                          </div>
                        )}

                        {f.proposed_text && f.section_key && !done && (
                          <div className="dc-rv-proposal">
                            <div className="dc-rv-prop-h">
                              <span>
                                <Spark size={12} />{" "}
                                {bi(
                                  `AI 建议改写稿（将写入「${f.section}」）`,
                                  `AI Proposed Text for "${f.section}"`,
                                )}
                              </span>
                            </div>
                            <div className="dc-rv-prop-body">{f.proposed_text}</div>
                            {can("report.edit") && (
                              <div className="dc-rv-prop-acts">
                                <Button
                                  size="mini"
                                  type="primary"
                                  icon={<IconCheck />}
                                  loading={isBusy}
                                  onClick={() => void applyFindingProposal(f, fid, true)}
                                >
                                  {bi("一键采纳并确认", "Apply & Confirm")}
                                </Button>
                                <Button
                                  size="mini"
                                  type="secondary"
                                  loading={isBusy}
                                  onClick={() => void applyFindingProposal(f, fid, false)}
                                >
                                  {bi("存为待确认草稿", "Save as Draft")}
                                </Button>
                                <Button
                                  size="mini"
                                  type="text"
                                  onClick={() => jumpToDocEl(`sec-${f.section_key}`)}
                                >
                                  {bi("定位该节", "Jump to Section")}
                                </Button>
                              </div>
                            )}
                          </div>
                        )}

                        {!f.proposed_text && !done && f.section_key && (
                          <div className="dc-rv-item-acts">
                            {f.action_kind === "draft_section" && canAI && (
                              <Button
                                size="mini"
                                type="primary"
                                icon={<Spark size={11} />}
                                loading={isBusy}
                                onClick={() => void draftFindingSection(f, fid)}
                              >
                                {bi("AI 立即起草此节", "AI Draft Section")}
                              </Button>
                            )}
                            {f.action_kind === "confirm_draft" && can("report.edit") && (
                              <Button
                                size="mini"
                                type="primary"
                                icon={<IconCheck />}
                                loading={isBusy}
                                onClick={() => void confirmFindingDraft(f, fid)}
                              >
                                {bi("确认此节草稿", "Confirm Draft")}
                              </Button>
                            )}
                            <Button
                              size="mini"
                              type="secondary"
                              onClick={() => jumpToDocEl(`sec-${f.section_key}`)}
                            >
                              {bi("跳转到该章节 ↗", "Go to Section ↗")}
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
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
  const [activeId, setActiveId] = useState<string>("");
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
          editable: true,
        };
      }
      if (b.kind === "h" && (b.level || 1) === 1 && b.text) {
        return {
          id: `doc-h-${idx}`,
          label: b.text,
          tone: "",
          editable: false,
        };
      }
      return null;
    })
    .filter(
      (x): x is { id: string; label: string; tone: string; editable: boolean } =>
        Boolean(x),
    );
  const editableTotal = outline.filter((x) => x.editable).length;
  const emptyTotal = outline.filter((x) => x.tone === "empty").length;
  const draftTotal = outline.filter((x) => x.tone === "draft").length;
  const doneTotal = outline.filter((x) => x.tone === "done").length;

  return (
    <>
      {outline.length >= 2 && (
        <nav className="dc-outline" aria-label={bi("文档章节导航", "Document sections")}>
          <div className="dc-outline-head">
            <span className="dc-outline-label">{bi("章节导航", "Chapters")}</span>
            {editableTotal > 0 && (
              <div className="dc-outline-meta">
                {emptyTotal > 0 && (
                  <span className="dc-ol-stat is-empty">
                    <i className="dc-outline-dot empty" />
                    {bi(`${emptyTotal} 节待填写`, `${emptyTotal} to fill`)}
                  </span>
                )}
                {draftTotal > 0 && (
                  <span className="dc-ol-stat is-draft">
                    <i className="dc-outline-dot draft" />
                    {bi(`${draftTotal} 节待确认`, `${draftTotal} pending`)}
                  </span>
                )}
                <span className="dc-ol-stat is-done">
                  <i className="dc-outline-dot done" />
                  {bi(`已完成 ${doneTotal}/${editableTotal}`, `Done ${doneTotal}/${editableTotal}`)}
                </span>
              </div>
            )}
          </div>
          <div className="dc-outline-list">
            {outline.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`dc-outline-btn ${item.tone ? `is-${item.tone}` : "is-auto"} ${activeId === item.id ? "is-active" : ""}`}
                onClick={() => {
                  setActiveId(item.id);
                  jumpToDocEl(item.id);
                }}
              >
                {item.tone === "done" ? (
                  <IconCheck className="dc-outline-chk" aria-hidden />
                ) : item.tone ? (
                  <i className={`dc-outline-dot ${item.tone}`} aria-hidden />
                ) : null}
                <span>{item.label}</span>
                {item.tone === "empty" && (
                  <em className="dc-outline-tag empty">{bi("待填", "Empty")}</em>
                )}
                {item.tone === "draft" && (
                  <em className="dc-outline-tag draft">{bi("待确认", "Draft")}</em>
                )}
              </button>
            ))}
          </div>
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

const CAUTION_RE = /注意|警告|WARN|严禁|务必|不可逆|必须确认|慎用|CAUTION|CRITICAL|DO NOT/i;
const TERM_PROMPT_RE = /^(\[[^\]]+\][#$]\s+)(.*)$/;
const SHELL_OPS = new Set(["|", "||", "&&", ";", ">", ">>", "<", "2>&1"]);
const SHELL_WRAPPERS = new Set(["sudo", "env", "nohup", "time"]);

function splitShellComment(line: string): [string, string] {
  const dbl = line.indexOf("  #");
  if (dbl > 0) return [line.slice(0, dbl), line.slice(dbl)];
  const tab = line.indexOf("\t#");
  if (tab > 0) return [line.slice(0, tab), line.slice(tab)];
  const sp = line.indexOf(" # ");
  if (sp > 0) {
    const pre = line.slice(0, sp);
    if ((pre.split("'").length - 1) % 2 === 0 && (pre.split('"').length - 1) % 2 === 0) {
      return [pre, line.slice(sp)];
    }
  }
  return [line, ""];
}

function renderShellLine(line: string, lineIdx: number): React.ReactNode {
  const trim = line.trim();
  if (!trim) return "\n";
  if (trim.startsWith("#") || trim.startsWith("//") || trim.startsWith("-- ")) {
    const cls = CAUTION_RE.test(trim) ? "dc-sh-warn" : "dc-sh-cmt";
    return (
      <span key={lineIdx} className={cls}>
        {line}
        {"\n"}
      </span>
    );
  }
  const [cmd, comment] = splitShellComment(line);
  const parts: React.ReactNode[] = [];
  let i = 0;
  let expectCmd = true;
  let tokIdx = 0;
  while (i < cmd.length) {
    if (cmd[i] === " " || cmd[i] === "\t") {
      const start = i;
      while (i < cmd.length && (cmd[i] === " " || cmd[i] === "\t")) i++;
      parts.push(cmd.slice(start, i));
      continue;
    }
    if (cmd[i] === '"' || cmd[i] === "'") {
      const q = cmd[i];
      const start = i++;
      while (i < cmd.length && cmd[i] !== q) {
        if (cmd[i] === "\\" && q === '"' && i + 1 < cmd.length) i++;
        i++;
      }
      if (i < cmd.length) i++;
      parts.push(
        <span key={tokIdx++} className="dc-sh-str">
          {cmd.slice(start, i)}
        </span>,
      );
      expectCmd = false;
      continue;
    }
    const start = i;
    while (i < cmd.length && cmd[i] !== " " && cmd[i] !== "\t") i++;
    const tok = cmd.slice(start, i);
    if (SHELL_OPS.has(tok)) {
      parts.push(
        <span key={tokIdx++} className="dc-sh-op">
          {tok}
        </span>,
      );
      expectCmd = tok === "|" || tok === "||" || tok === "&&" || tok === ";";
    } else if (expectCmd) {
      if (tok.includes("=") && !tok.startsWith("-") && !tok.includes("/")) {
        parts.push(
          <span key={tokIdx++} className="dc-sh-str">
            {tok}
          </span>,
        );
      } else {
        parts.push(
          <span key={tokIdx++} className="dc-sh-cmd">
            {tok}
          </span>,
        );
        expectCmd = SHELL_WRAPPERS.has(tok);
      }
    } else if (/^-[A-Za-z0-9-]/.test(tok) && tok !== "--") {
      parts.push(
        <span key={tokIdx++} className="dc-sh-flag">
          {tok}
        </span>,
      );
    } else {
      parts.push(
        <span key={tokIdx++} className="dc-sh-arg">
          {tok}
        </span>,
      );
    }
  }
  if (comment) {
    const cls = CAUTION_RE.test(comment) ? "dc-sh-warn" : "dc-sh-cmt";
    parts.push(
      <span key="cmt" className={cls}>
        {comment}
      </span>,
    );
  }
  return (
    <React.Fragment key={lineIdx}>
      {parts}
      {"\n"}
    </React.Fragment>
  );
}

function renderTerminalLine(line: string, lineIdx: number): React.ReactNode {
  const trim = line.trim();
  if (!trim) return "\n";
  const pm = TERM_PROMPT_RE.exec(line);
  if (pm) {
    return (
      <React.Fragment key={lineIdx}>
        <span className="dc-tm-prompt">{pm[1]}</span>
        <span className="dc-tm-cmd">{pm[2]}</span>
        {"\n"}
      </React.Fragment>
    );
  }
  if (trim.startsWith("# ✓") || trim.startsWith("✓ ")) {
    return (
      <span key={lineIdx} className="dc-tm-ok">
        {line}
        {"\n"}
      </span>
    );
  }
  if (
    trim.startsWith("# ✗") ||
    trim.startsWith("stderr:") ||
    trim.startsWith("[FAILED") ||
    trim.startsWith("[UNREACHABLE") ||
    trim.startsWith("[exit code:")
  ) {
    return (
      <span key={lineIdx} className="dc-tm-err">
        {line}
        {"\n"}
      </span>
    );
  }
  if (trim.startsWith("#")) {
    const cls = trim.includes("FAILED")
      ? "dc-tm-err"
      : trim.includes("[OK")
        ? "dc-tm-ok"
        : "dc-tm-meta";
    return (
      <span key={lineIdx} className={cls}>
        {line}
        {"\n"}
      </span>
    );
  }
  if (trim.endsWith(": OK") || trim === "active") {
    return (
      <span key={lineIdx} className="dc-tm-ok-soft">
        {line}
        {"\n"}
      </span>
    );
  }
  return (
    <span key={lineIdx} className="dc-tm-out">
      {line}
      {"\n"}
    </span>
  );
}

function renderAnsibleLine(line: string, lineIdx: number): React.ReactNode {
  const trim = line.trim();
  if (!trim) return "\n";
  const stripped = trim.replace(/^\d\d:\d\d:\d\d\s+/, "");
  if (
    stripped.startsWith("PLAY  ") ||
    stripped.startsWith("TASK  ") ||
    stripped === "RECAP" ||
    trim.startsWith("# ")
  ) {
    return (
      <span key={lineIdx} className="dc-ans-head">
        {line}
        {"\n"}
      </span>
    );
  }
  if (/^(FAILED|UNREACHABLE)\b/.test(stripped) || stripped.includes("RESULT  FAILED")) {
    return (
      <span key={lineIdx} className="dc-ans-bad">
        {line}
        {"\n"}
      </span>
    );
  }
  if (/^changed\b/.test(stripped)) {
    return (
      <span key={lineIdx} className="dc-ans-chg">
        {line}
        {"\n"}
      </span>
    );
  }
  if (/^ok\b/.test(stripped) || stripped.includes("RESULT  PASSED")) {
    return (
      <span key={lineIdx} className="dc-ans-ok">
        {line}
        {"\n"}
      </span>
    );
  }
  return (
    <React.Fragment key={lineIdx}>
      {line}
      {"\n"}
    </React.Fragment>
  );
}

function DocCodeBlock({ text, style }: { text: string; style?: DocBlock["style"] }) {
  useLang();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );
  const isAnsible =
    style === "ansible" ||
    (!style && (text.includes("TASK  ") || text.includes("PLAY  ") || text.includes("STEP_RESULT ")));
  const isTerminal = style === "terminal";
  const isShell = !isAnsible && !isTerminal;
  const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const copyPayload = isShell ? toPasteSafeShell(text).text : text;

  const copyBtn = text.trim() ? (
    <Tooltip content={copied ? bi("已复制", "Copied") : bi("复制内容", "Copy")} mini>
      <button
        type="button"
        className={`dc-code-copy ${copied ? "copied" : ""}`}
        aria-label={copied ? bi("已复制", "Copied") : bi("复制内容", "Copy")}
        onClick={() => {
          copy(copyPayload);
          setCopied(true);
          if (copyTimer.current) window.clearTimeout(copyTimer.current);
          copyTimer.current = window.setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
    </Tooltip>
  ) : null;

  if (isTerminal) {
    return (
      <div className="dc-term">
        <div className="dc-term-bar">
          <span className="dc-term-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span className="dc-term-title">
            {bi("Linux 终端执行记录", "Linux Terminal Transcript")}
          </span>
          {copyBtn}
        </div>
        <pre className="dc-term-body">
          {lines.map((ln, idx) => renderTerminalLine(ln, idx))}
        </pre>
      </div>
    );
  }

  if (isAnsible) {
    return (
      <div className="dc-code-wrap is-ansible">
        <div className="dc-ans-bar">
          <span>{bi("Ansible 自动化日志", "Ansible Automation Log")}</span>
          {copyBtn}
        </div>
        <pre className="dc-code dc-code-ans">
          {lines.map((ln, idx) => renderAnsibleLine(ln, idx))}
        </pre>
      </div>
    );
  }

  return (
    <div className="dc-code-wrap is-shell">
      <pre className="dc-code dc-code-shell">
        {lines.map((ln, idx) => renderShellLine(ln, idx))}
      </pre>
      {copyBtn}
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
    case "p": {
      const txt = (b.text || "").trim();
      const critMatch = /^(✓\s*判据：|✓\s*Criteria:\s*)(.+)$/s.exec(txt);
      if (critMatch) {
        return (
          <div className="dc-criteria">
            <span className="dc-criteria-k">{critMatch[1]}</span>
            <span className="dc-criteria-v">
              {critMatch[2].split("**").map((x, idx) => (idx % 2 ? <b key={idx}>{x}</b> : x))}
            </span>
          </div>
        );
      }
      return (
        <div className="dc-p">
          <Rich text={b.text || ""} />
        </div>
      );
    }
    case "note":
      return <p className="dc-note">{b.text}</p>;
    case "code":
      return <DocCodeBlock text={b.text || ""} style={b.style} />;
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
    if (busy) return;
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
    if (busy) return;
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
                <span className="muted" title={d.subtitle}>
                  {d.subtitle}
                </span>
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
    if (busy) return;
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
        onCancel={() => !busy && setOpen(false)}
        maskClosable={!busy}
        cancelButtonProps={{ disabled: busy }}
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
  const plans = (c.plans || []).filter(
    (p) => p.state === "succeeded" && p.outcome !== "void",
  );
  const start = async () => {
    if (busy) return;
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
        onCancel={() => !busy && setOpen(false)}
        maskClosable={!busy}
        cancelButtonProps={{ disabled: busy }}
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
    if (busy) return;
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
        onCancel={() => !busy && setOpen(false)}
        maskClosable={!busy}
        cancelButtonProps={{ disabled: busy }}
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

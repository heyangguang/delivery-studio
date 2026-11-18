import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  Message,
  Modal,
  Select,
  Skeleton,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheck,
  IconClose,
  IconDelete,
  IconEdit,
  IconEye,
  IconFile,
  IconPlus,
  IconSearch,
  IconSend,
  IconStorage,
  IconUpload,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  cached,
  can,
  err,
  fullTime,
  myTeams,
  putCached,
  useMedia,
} from "./shared";
import { go } from "./router";
import { Segmented } from "./ui";
import { DocToc, StructuredDoc, extractDocSections } from "./docrender";
import { FileIcon, FileView, MyFiles, UsageBar, bytesText } from "./myfiles";
import type { FileNode, Usage } from "./myfiles";
import "./me.css";
import "./respage.css";
import "./kb.css";

/* The team knowledge base: what the organisation knows about its sites and its past problems, for everyone's
   conversations with the assistant. People propose documents; those who manage the base approve them, for everyone or
   for one team. A person's own documents stay in their account. */

type Doc = {
  id: string;
  title: string;
  name?: string;
  size: number;
  created: string;
  updated: string;
  text?: string;
  team?: string;
  by: string;
  source?: string;
  editor?: string;
};
type Sub = {
  id: string;
  title: string;
  text?: string;
  team?: string;
  source?: string;
  by: string;
  at: string;
  status: "pending" | "approved" | "rejected";
  reviewer?: string;
  reviewed_at?: string;
  note?: string;
  doc?: string;
};
type Hit = { id: string; title: string; part: number; text: string };
type Home = {
  docs: Doc[];
  mine: Sub[];
  pending?: number;
  can_submit: boolean;
  can_manage: boolean;
};
type Team = { id: string; name: string };

const kib = (n: number) =>
  n >= 1 << 20
    ? `${(n / (1 << 20)).toFixed(1)} MiB`
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${n} 字节`;
const STATUS: Record<string, string> = {
  pending: "等待审核",
  approved: "已入库",
  rejected: "未通过",
};

/** The teams a document can be meant for: those of the person, or every team for someone who manages the base. */
function useTeams(): Team[] {
  const [all, setAll] = useState<Team[]>([]);
  useEffect(() => {
    if (can("iam.user|iam.role|iam.team"))
      api<{ teams: Team[] }>("/api/iam")
        .then((r) => setAll(r.teams))
        .catch(() => undefined);
  }, []);
  return can("kb.manage") && all.length ? all : myTeams();
}

/** A troubleshooting record written as a document of the base. */
export function reportDoc(
  r: {
    title: string;
    symptom: string;
    evidence?: string;
    cause: string;
    fix: string;
    followups?: string[];
  },
  where?: string,
) {
  const parts = [`## 现象\n\n${r.symptom}`];
  if (r.evidence) parts.push(`## 证据\n\n\`\`\`\n${r.evidence}\n\`\`\``);
  parts.push(`## 原因\n\n${r.cause}`, `## 处理\n\n${r.fix}`);
  if (r.followups?.length)
    parts.push(`## 待跟进\n\n${r.followups.map((f) => `- ${f}`).join("\n")}`);
  if (where) parts.push(`> 来自 ${where}`);
  return { title: r.title, text: parts.join("\n\n"), source: where || "" };
}

/** Proposing a document to the team base, from anywhere: an empty one, or one already written (a troubleshooting record). */
export function useSubmitKB(): [
  (pre?: { title?: string; text?: string; source?: string }) => void,
  React.ReactNode,
] {
  const [draft, setDraft] = useState<{
    title: string;
    text: string;
    source: string;
    team: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const teams = useTeams();
  const open = (pre: { title?: string; text?: string; source?: string } = {}) =>
    setDraft({
      title: pre.title || "",
      text: pre.text || "",
      source: pre.source || "",
      team: "",
    });
  const submit = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await api("/api/kb/submissions", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setDraft(null);
      Message.success("已提交，审核通过后进入团队知识库");
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const node = (
    <Modal
      visible={!!draft}
      title="提交到团队知识库"
      onCancel={() => setDraft(null)}
      okText="提交审核"
      confirmLoading={busy}
      okButtonProps={{ disabled: !draft?.title.trim() || !draft?.text.trim() }}
      onOk={submit}
      style={{ width: 760, maxWidth: "96vw" }}
    >
      {draft && (
        <div className="st-form">
          <p className="muted small kb-sub-lead">
            审核通过后，大家和 AI
            都能用到它。可以先改得更通用一些：去掉只和这一次有关的细节，写清楚什么情况下会遇到。口令、私钥这类内容会在交给
            AI 前被去掉。
          </p>
          <div className="st-field">
            <span>标题</span>
            <Input
              value={draft.title}
              onChange={(v) => setDraft({ ...draft, title: v })}
              maxLength={120}
              placeholder="例如：etcd 频繁选主，原因是成员用了机械盘"
              aria-label="标题"
            />
          </div>
          <div className="st-field">
            <span>内容（Markdown）</span>
            <Input.TextArea
              className="mono"
              value={draft.text}
              onChange={(v) => setDraft({ ...draft, text: v })}
              autoSize={{ minRows: 10, maxRows: 24 }}
              aria-label="内容"
            />
          </div>
          <div className="st-field">
            <span>给谁用</span>
            <Select
              value={draft.team}
              onChange={(v) => setDraft({ ...draft, team: v })}
              triggerProps={{
                autoFitPosition: true,
                autoAlignPopupWidth: false,
                autoAlignPopupMinWidth: true,
              }}
              options={[
                { value: "", label: "全平台" },
                ...teams.map((t) => ({
                  value: t.id,
                  label: `团队：${t.name}`,
                })),
              ]}
              aria-label="给谁用"
            />
            <small>审核的人可以再调整。</small>
          </div>
        </div>
      )}
    </Modal>
  );
  return [open, node];
}

/* ---------------------------------------------------------------- page */

type Scope = "team" | "mine";
/** Where a document lives: the team base, or the person's own (ids "my-…"). */
const docBase = (scope: Scope) => (scope === "mine" ? "/api/me/kb" : "/api/kb");
const docKey = (scope: Scope, id: string) =>
  scope === "mine" ? `my-${id}` : id;

export function KnowledgePage({ selected }: { selected?: string }) {
  const narrow = useMedia("(max-width: 900px)");
  const initFiles = cached<{ nodes: FileNode[]; usage: Usage }>(
    "/api/me/files?recent=1",
  );
  const [home, setHome] = useState<Home | null>(() =>
    can("kb.view|kb.submit")
      ? cached<Home>("/api/kb") ?? null
      : { docs: [], mine: [], can_submit: false, can_manage: false },
  );
  const [own, setOwn] = useState<FileNode[] | null>(
    () => initFiles?.nodes ?? null,
  );
  const [usage, setUsage] = useState<Usage | null>(
    () => initFiles?.usage ?? null,
  );
  const [newIn, setNewIn] = useState("");
  const [scopePick, setScope] = useState<Scope>(() =>
    selected?.startsWith("my-") || selected === "~my" ? "mine" : "team",
  );
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [openSubmit, submitNode] = useSubmitKB();
  const teams = useTeams();
  const scope: Scope =
    selected?.startsWith("my-") || selected === "~my" || selected === "~my-new"
      ? "mine"
      : selected && !selected.startsWith("~")
        ? "team"
        : scopePick;
  const load = () => {
    if (can("kb.view|kb.submit"))
      api<Home>("/api/kb")
        .then((r) => {
          putCached("/api/kb", r);
          setHome(r);
        })
        .catch(err);
    else setHome({ docs: [], mine: [], can_submit: false, can_manage: false });
    api<{ nodes: FileNode[]; usage: Usage }>("/api/me/files?recent=1")
      .then((r) => {
        putCached("/api/me/files?recent=1", r);
        setOwn(r.nodes || []);
        setUsage(r.usage);
      })
      .catch(err);
  };
  useEffect(load, []);
  useEffect(() => {
    const t = q.trim();
    if (!t) return setHits(null);
    const h = window.setTimeout(
      () =>
        api<{ hits: Hit[] }>(
          `${docBase(scope)}/search?q=${encodeURIComponent(t)}`,
        )
          .then((r) => setHits(r.hits))
          .catch(() => setHits([])),
      250,
    );
    return () => window.clearTimeout(h);
  }, [q, scope]);
  const nav = (id?: string) =>
    go({ name: "kb", id }, { replace: !narrow && !!selected });
  const teamName = (id?: string) =>
    !id ? "全平台" : teams.find((t) => t.id === id)?.name || "某个团队";
  const docs: Doc[] | null =
    scope === "mine" ? (own ? [] : null) : home?.docs || null;
  const total = useMemo(
    () =>
      scope === "mine" ? 0 : (home?.docs || []).reduce((n, d) => n + d.size, 0),
    [home, scope],
  );
  const teamOK =
    !!home &&
    (home.docs.length > 0 ||
      home.can_submit ||
      home.can_manage ||
      can("kb.view"));

  const view =
    selected === "~review"
      ? "review"
      : selected === "~mine"
        ? "subs"
        : selected === "~new"
          ? "new-team"
          : selected === "~my-new"
            ? "new-mine"
            : selected === "~my"
              ? "my-home"
              : selected
                ? "doc"
                : "home";

  return (
    <div className="md-split">
      {(!narrow || !selected) && (
        <aside className="md-list kb-side" aria-label="知识库">
          <div className="list-head">
            <div className="list-title">
              <h1>知识库</h1>
              {scope === "mine" ? null : home?.can_manage ? (
                <Button
                  type="primary"
                  size="small"
                  icon={<IconPlus />}
                  onClick={() => nav("~new")}
                >
                  新建
                </Button>
              ) : home?.can_submit ? (
                <Button
                  type="primary"
                  size="small"
                  icon={<IconSend />}
                  onClick={() => openSubmit()}
                >
                  提交资料
                </Button>
              ) : null}
            </div>
            {teamOK && (
              <Segmented<Scope>
                size="sm"
                label="资料范围"
                value={scope}
                onChange={(v) => {
                  setScope(v);
                  setQ("");
                  nav(v === "mine" ? "~my" : undefined);
                }}
                options={[
                  {
                    value: "team",
                    label: "团队资料",
                    count: home?.docs.length,
                  },
                  { value: "mine", label: "我的资料" },
                ]}
              />
            )}
            <Input
              prefix={<IconSearch />}
              allowClear
              placeholder={
                scope === "mine" ? "搜索我的资料内容" : "搜索团队资料内容"
              }
              value={q}
              onChange={setQ}
              aria-label="搜索资料"
            />
            {scope === "team" && (home?.can_manage || home?.can_submit) && (
              <nav className="sx-nav" aria-label="审核与提交">
                {home?.can_manage && (
                  <button
                    type="button"
                    className={`sx-nav-i ${view === "review" ? "on" : ""}`}
                    onClick={() => nav("~review")}
                  >
                    <span className="sx-nav-ic">
                      <IconCheck />
                    </span>
                    <span className="sx-nav-t">
                      <b>待审核</b>
                      <small>
                        {home.pending
                          ? `${home.pending} 份等你处理`
                          : "没有待审核的"}
                      </small>
                    </span>
                    {!!home.pending && (
                      <em className="kb-badge num">{home.pending}</em>
                    )}
                  </button>
                )}
                {home?.can_submit && (
                  <button
                    type="button"
                    className={`sx-nav-i ${view === "subs" ? "on" : ""}`}
                    onClick={() => nav("~mine")}
                  >
                    <span className="sx-nav-ic">
                      <IconSend />
                    </span>
                    <span className="sx-nav-t">
                      <b>我的提交</b>
                      <small>
                        {home.mine.length
                          ? `${home.mine.length} 份 · ${home.mine.filter((x) => x.status === "pending").length} 份待审核`
                          : "还没有提交过"}
                      </small>
                    </span>
                  </button>
                )}
              </nav>
            )}
          </div>
          {docs === null ? (
            <div className="list-body">
              <Skeleton animation text={{ rows: 4 }} />
            </div>
          ) : hits ? (
            hits.length === 0 ? (
              <div className="list-state">
                <p>没有找到相关内容</p>
              </div>
            ) : (
              <div className="list-body rp-list">
                {hits.map((h) => (
                  <a
                    key={h.id + h.part}
                    href={`#/kb/${docKey(scope, h.id)}`}
                    className={`rp-row kb-hit ${selected === docKey(scope, h.id) ? "on" : ""}`}
                    onClick={(e) => {
                      e.preventDefault();
                      nav(docKey(scope, h.id));
                    }}
                  >
                    <span className="rp-t">
                      <b>
                        {h.title}{" "}
                        <small className="faint">第 {h.part} 段</small>
                      </b>
                      <small className="kb-snip">{h.text.slice(0, 140)}</small>
                    </span>
                  </a>
                ))}
              </div>
            )
          ) : scope === "mine" ? (
            <div className="list-body rp-list">
              <button
                type="button"
                className={`mf-all ${view === "my-home" ? "on" : ""}`}
                onClick={() => nav("~my")}
              >
                <span className="rp-ic k-mine">
                  <IconStorage />
                </span>
                <span className="rp-t">
                  <b>全部资料</b>
                  <small>文件夹、文档、图片和文件</small>
                </span>
              </button>
              <UsageBar u={usage} />
              {(own || []).length > 0 && <div className="rp-group">最近</div>}
              {(own || []).slice(0, 12).map((n) => (
                <a
                  key={n.id}
                  href={`#/kb/my-${n.id}`}
                  className={`rp-row ${selected === `my-${n.id}` ? "on" : ""}`}
                  onClick={(e) => {
                    e.preventDefault();
                    nav(`my-${n.id}`);
                  }}
                >
                  <FileIcon n={n} size={32} />
                  <span className="rp-t">
                    <b>{n.name}</b>
                    <small>
                      {bytesText(n.size)} · {ago(n.updated)}
                    </small>
                  </span>
                </a>
              ))}
            </div>
          ) : docs.length === 0 ? (
            <div className="list-state">
              <p>团队知识库还是空的。</p>
            </div>
          ) : (
            <div className="list-body rp-list" role="listbox" aria-label="资料">
              <div className="rp-group">
                {docs.length} 份 · {kib(total)}
              </div>
              {docs.map((d) => (
                <a
                  key={d.id}
                  href={`#/kb/${docKey(scope, d.id)}`}
                  role="option"
                  aria-selected={selected === docKey(scope, d.id)}
                  className={`rp-row ${selected === docKey(scope, d.id) ? "on" : ""}`}
                  onClick={(e) => {
                    e.preventDefault();
                    nav(docKey(scope, d.id));
                  }}
                >
                  <span className="rp-ic k-doc">
                    <IconFile />
                  </span>
                  <span className="rp-t">
                    <b>{d.title}</b>
                    <small>{`${teamName(d.team)} · ${d.by} · ${ago(d.updated)}`}</small>
                  </span>
                </a>
              ))}
            </div>
          )}
        </aside>
      )}
      {(!narrow || selected) && (
        <section className="md-detail">
          <div className="rp-detail">
            {narrow && selected && (
              <Button
                type="text"
                className="back"
                icon={<IconArrowLeft />}
                onClick={() => go({ name: "kb" })}
              >
                知识库
              </Button>
            )}
            {view === "review" ? (
              <ReviewView teams={teams} changed={load} />
            ) : view === "subs" ? (
              <MineView subs={home?.mine || []} teamName={teamName} />
            ) : view === "new-team" || view === "new-mine" ? (
              <DocEditor
                scope={view === "new-mine" ? "mine" : "team"}
                parent={newIn}
                teams={teams}
                onDone={(id) => (
                  load(),
                  nav(docKey(view === "new-mine" ? "mine" : "team", id))
                )}
                onCancel={() => nav(view === "new-mine" ? "~my" : undefined)}
              />
            ) : view === "doc" && scope === "mine" ? (
              <MineNode
                key={selected}
                id={selected!.slice(3)}
                render={() => (
                  <DocView
                    key={selected}
                    scope="mine"
                    id={selected!.slice(3)}
                    manage
                    teams={teams}
                    teamName={teamName}
                    changed={load}
                    gone={() => (load(), nav("~my"))}
                    share={
                      home?.can_submit
                        ? (d) =>
                            openSubmit({
                              title: d.title,
                              text: d.text,
                              source: "我的资料",
                            })
                        : undefined
                    }
                  />
                )}
                changed={load}
                gone={() => nav("~my")}
              />
            ) : view === "doc" ? (
              <DocView
                key={selected}
                scope={scope}
                id={scope === "mine" ? selected!.slice(3) : selected!}
                manage={scope === "mine" || !!home?.can_manage}
                teams={teams}
                teamName={teamName}
                changed={load}
                gone={() => (load(), nav(scope === "mine" ? "~my" : undefined))}
                share={
                  scope === "mine" && !!home?.can_submit
                    ? (d) =>
                        openSubmit({
                          title: d.title,
                          text: d.text,
                          source: "我的资料",
                        })
                    : undefined
                }
              />
            ) : view === "my-home" ? (
              <MyFiles
                open={(n) => {
                  if (n.id.startsWith("~new:")) {
                    setNewIn(n.id.slice(5));
                    nav("~my-new");
                  } else nav(`my-${n.id}`);
                }}
              />
            ) : (
              <div className="rp-intro enter">
                <span className="rp-ic xl k-doc">
                  <IconStorage />
                </span>
                <h2>团队一起积累的现场知识</h2>
                <p>
                  机房和网络规划、变更规范、过往故障和处理办法。所有人和 AI
                  对话时，AI
                  都会先在这里找，回答里会说明出自哪份资料。排障解决后可以一键把经过提交进来，审核通过就入库。
                </p>
                {home?.can_submit && (
                  <Button
                    type="primary"
                    icon={<IconSend />}
                    onClick={() => openSubmit()}
                  >
                    提交一份资料
                  </Button>
                )}
              </div>
            )}
          </div>
        </section>
      )}
      {submitNode}
    </div>
  );
}

function DocView({
  scope,
  id,
  manage,
  teams,
  teamName,
  changed,
  gone,
  share,
}: {
  scope: Scope;
  id: string;
  manage: boolean;
  teams: Team[];
  teamName: (id?: string) => string;
  changed: () => void;
  gone: () => void;
  share?: (d: Doc) => void;
}) {
  const [d, setD] = useState<Doc | null>(null);
  const [missing, setMissing] = useState(false);
  const [raw, setRaw] = useState(false);
  const [editing, setEditing] = useState(false);
  const base = docBase(scope);
  useEffect(() => {
    api<Doc>(`${base}/${id}`)
      .then(setD)
      .catch(() => setMissing(true));
  }, [id, base]);
  const docSections = useMemo(
    () =>
      d && !raw
        ? extractDocSections(d.text || "", d.title, `kb-${id}`).sections
        : [],
    [d, raw, id],
  );
  if (missing)
    return (
      <div className="detail-none enter">
        <h2>找不到这份资料</h2>
        <p>它可能已被删除，或只给某个团队用。</p>
      </div>
    );
  if (!d) return <Skeleton animation text={{ rows: 8 }} />;
  if (editing)
    return (
      <DocEditor
        scope={scope}
        teams={teams}
        doc={d}
        onDone={() => {
          setEditing(false);
          changed();
          api<Doc>(`${base}/${id}`).then(setD);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  return (
    <article className="rp-doc enter">
      <header className="rp-head">
        <span className={`rp-ic lg ${scope === "mine" ? "k-mine" : "k-doc"}`}>
          <IconFile />
        </span>
        <div className="rp-head-t">
          <h1>{d.title}</h1>
          <div className="rp-meta">
            <span>{scope === "mine" ? "我的资料" : teamName(d.team)}</span>
            <span>
              <time title={fullTime(d.updated)}>{ago(d.updated)}更新</time>
            </span>
            <span>{kib(d.size)}</span>
          </div>
        </div>
        <span className="rp-acts">
          <Button icon={<IconEye />} onClick={() => setRaw(!raw)}>
            {raw ? "看排版" : "看原文"}
          </Button>
          {share && (
            <Button icon={<IconSend />} onClick={() => share(d)}>
              提交到团队
            </Button>
          )}
          {manage && (
            <>
              <Button icon={<IconEdit />} onClick={() => setEditing(true)}>
                编辑
              </Button>
              <Button
                status="danger"
                icon={<IconDelete />}
                aria-label="删除"
                onClick={() =>
                  Modal.confirm({
                    title: `删除「${d.title}」？`,
                    content:
                      scope === "mine"
                        ? "删除后 AI 不会再用到它。"
                        : "删除后所有人和 AI 都不会再用到它。",
                    okText: "删除",
                    okButtonProps: { status: "danger" },
                    onOk: async () => {
                      try {
                        await api(`${base}/${d.id}`, { method: "DELETE" });
                        gone();
                      } catch (e) {
                        err(e);
                      }
                    },
                  })
                }
              />
            </>
          )}
        </span>
      </header>
      <div className="rp-body">
        <div className="rp-main">
          {raw ? (
            <pre className="kb-raw mono">{d.text}</pre>
          ) : (
            <StructuredDoc
              text={d.text || ""}
              docTitle={d.title}
              idPrefix={`kb-${id}`}
            />
          )}
        </div>
        <aside className="rp-side">
          {!raw && <DocToc sections={docSections} />}
          <dl>
            <dt>给谁用</dt>
            <dd>
              {scope === "mine"
                ? "只有我的对话"
                : d.team
                  ? `团队「${teamName(d.team)}」`
                  : "全平台所有人"}
            </dd>
            {scope === "team" && (
              <>
                <dt>提交</dt>
                <dd>
                  {d.by}
                  {d.editor && d.editor !== d.by ? `，${d.editor} 审核` : ""}
                </dd>
              </>
            )}
            {(d.source || d.name) && (
              <>
                <dt>来源</dt>
                <dd>{d.source || d.name}</dd>
              </>
            )}
            <dt>AI 怎么用它</dt>
            <dd>
              对话时 AI
              先在知识库里搜索相关片段，需要时读全文；口令和私钥会在交给 AI
              前被去掉。
            </dd>
          </dl>
        </aside>
      </div>
    </article>
  );
}

function DocEditor({
  scope,
  parent,
  teams,
  doc,
  onDone,
  onCancel,
}: {
  scope: Scope;
  parent?: string;
  teams: Team[];
  doc?: Doc;
  onDone: (id: string) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(doc?.title || "");
  const [text, setText] = useState(doc?.text || "");
  const [team, setTeam] = useState(doc?.team || "");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const base = docBase(scope);
  const save = async () => {
    setBusy(true);
    try {
      const body = JSON.stringify(
        scope === "mine" ? { title, text, parent } : { title, text, team },
      );
      const r = doc
        ? await api<Doc>(`${base}/${doc.id}`, { method: "PUT", body })
        : await api<{ id?: string; added?: Doc[] }>(base, {
            method: "POST",
            body,
          });
      Message.success("已保存");
      onDone((r as Doc).id || (r as { added?: Doc[] }).added?.[0]?.id || "");
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rp-edit enter">
      <header className="rp-edit-h">
        <h1>
          {doc
            ? "编辑资料"
            : scope === "mine"
              ? "写一份我的资料"
              : "新建团队资料"}
        </h1>
        <span className="rp-acts">
          {onCancel && <Button onClick={onCancel}>取消</Button>}
          <Button
            type="primary"
            loading={busy}
            disabled={!title.trim() || !text.trim()}
            onClick={save}
          >
            保存
          </Button>
        </span>
      </header>
      <div className="rp-grid2">
        <div className="rp-field">
          <span>标题</span>
          <Input
            value={title}
            onChange={setTitle}
            placeholder="例如：一号机房网络规划"
            maxLength={120}
            aria-label="标题"
          />
        </div>
        {scope === "team" ? (
          <div className="rp-field">
            <span>给谁用</span>
            <Select
              value={team}
              onChange={setTeam}
              triggerProps={{
                autoFitPosition: true,
                autoAlignPopupWidth: false,
                autoAlignPopupMinWidth: true,
              }}
              options={[
                { value: "", label: "全平台" },
                ...teams.map((t) => ({
                  value: t.id,
                  label: `团队：${t.name}`,
                })),
              ]}
              aria-label="给谁用"
            />
          </div>
        ) : (
          <div className="rp-field">
            <span>&nbsp;</span>
            {!doc && (
              <>
                <Button
                  icon={<IconUpload />}
                  onClick={() => file.current?.click()}
                >
                  从文件读取内容
                </Button>
                <input
                  ref={file}
                  type="file"
                  hidden
                  accept=".md,.markdown,.txt,.log,.yaml,.yml,.json,.conf,.cfg,.ini,.toml,.sh,.sql,.csv,.xml"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (f.size > 1 << 20)
                      return Message.warning("单份资料不能超过 1 MiB");
                    setText(await f.text());
                    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
                    e.target.value = "";
                  }}
                />
              </>
            )}
          </div>
        )}
      </div>
      <div className="rp-field">
        <span className="rp-field-h">
          内容（Markdown）
          <Segmented<string>
            size="sm"
            label="视图"
            value={preview ? "p" : "e"}
            onChange={(v) => setPreview(v === "p")}
            options={[
              { value: "e", label: "编辑" },
              { value: "p", label: "预览" },
            ]}
          />
        </span>
        {preview ? (
          <div className="rp-preview">
            <StructuredDoc
              text={text || "（还没有内容）"}
              docTitle={title}
              idPrefix="kb-preview"
            />
          </div>
        ) : (
          <Input.TextArea
            className="mono"
            value={text}
            onChange={setText}
            placeholder="粘贴或写下内容，支持 Markdown。"
            autoSize={{ minRows: 16, maxRows: 40 }}
            aria-label="内容"
          />
        )}
        <small>
          {text.length.toLocaleString("en-US")} 字 · 口令、私钥这类内容会在交给
          AI 前被去掉
        </small>
      </div>
    </div>
  );
}

function ReviewView({
  teams,
  changed,
}: {
  teams: Team[];
  changed: () => void;
}) {
  const [subs, setSubs] = useState<Sub[] | null>(null);
  const [cur, setCur] = useState<Sub | null>(null);
  const [edit, setEdit] = useState<{
    title: string;
    text: string;
    team: string;
    note: string;
  } | null>(null);
  const [busy, setBusy] = useState("");
  const [showDone, setShowDone] = useState(false);
  const load = () =>
    api<{ submissions: Sub[] }>("/api/kb/submissions")
      .then((r) => setSubs(r.submissions))
      .catch(err);
  useEffect(() => {
    load();
  }, []);
  const pick = (x: Sub) => {
    setCur(x);
    setEdit({
      title: x.title,
      text: x.text || "",
      team: x.team || "",
      note: "",
    });
  };
  const decide = async (verb: "approve" | "reject") => {
    if (!cur || !edit) return;
    setBusy(verb);
    try {
      await api(`/api/kb/submissions/${cur.id}/${verb}`, {
        method: "POST",
        body: JSON.stringify(edit),
      });
      Message.success(
        verb === "approve" ? "已入库" : "已退回，提交的人能看到你的说明",
      );
      setCur(null);
      setEdit(null);
      load();
      changed();
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };
  const list = (subs || []).filter((x) => showDone || x.status === "pending");
  return (
    <div className="kb-review enter">
      <header className="iam-h">
        <div>
          <h1>待审核</h1>
          <p>
            通过后进入团队知识库，所有人（或选定的团队）和 AI
            都会用到。可以先改标题和内容，让它对别人也有用。
          </p>
        </div>
        <label className="sec-check">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
          />{" "}
          也显示审核过的
        </label>
      </header>
      {!subs ? (
        <Skeleton animation text={{ rows: 6 }} />
      ) : list.length === 0 ? (
        <div className="iam-empty">
          <IconCheck />
          <b>没有待审核的提交</b>
        </div>
      ) : (
        <div className="kb-rv">
          <ul className="kb-rv-list">
            {list.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  className={cur?.id === x.id ? "on" : ""}
                  onClick={() => pick(x)}
                >
                  <b>{x.title}</b>
                  <small>
                    {x.by} · {ago(x.at)}
                    {x.status !== "pending" && (
                      <span className={`kb-st ${x.status}`}>
                        {STATUS[x.status]}
                      </span>
                    )}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {cur && edit ? (
            <section className="kb-rv-ed">
              {cur.source && <p className="faint small">来源：{cur.source}</p>}
              <Input
                className="kb-title-in"
                value={edit.title}
                onChange={(v) => setEdit({ ...edit, title: v })}
                disabled={cur.status !== "pending"}
                aria-label="标题"
              />
              <Input.TextArea
                className="mono kb-text-in"
                value={edit.text}
                onChange={(v) => setEdit({ ...edit, text: v })}
                disabled={cur.status !== "pending"}
                autoSize={{ minRows: 12, maxRows: 30 }}
                aria-label="内容"
              />
              {cur.status === "pending" ? (
                <div className="kb-rv-acts">
                  <Select
                    value={edit.team}
                    onChange={(v) => setEdit({ ...edit, team: v })}
                    triggerProps={{
                      autoFitPosition: true,
                      autoAlignPopupWidth: false,
                      autoAlignPopupMinWidth: true,
                    }}
                    options={[
                      { value: "", label: "给全平台" },
                      ...teams.map((t) => ({
                        value: t.id,
                        label: `只给团队：${t.name}`,
                      })),
                    ]}
                    aria-label="给谁用"
                  />
                  <Input
                    value={edit.note}
                    onChange={(v) => setEdit({ ...edit, note: v })}
                    placeholder="说明（退回时告诉对方原因）"
                    maxLength={500}
                    aria-label="说明"
                  />
                  <Button
                    status="danger"
                    icon={<IconClose />}
                    loading={busy === "reject"}
                    onClick={() => decide("reject")}
                  >
                    退回
                  </Button>
                  <Button
                    type="primary"
                    icon={<IconCheck />}
                    loading={busy === "approve"}
                    disabled={!edit.title.trim() || !edit.text.trim()}
                    onClick={() => decide("approve")}
                  >
                    通过并入库
                  </Button>
                </div>
              ) : (
                <p className="faint small">
                  {cur.reviewer} {ago(cur.reviewed_at || cur.at)}
                  {STATUS[cur.status]}
                  {cur.note ? `：${cur.note}` : ""}
                </p>
              )}
            </section>
          ) : (
            <p className="faint kb-rv-hint">从左边选一份来审核。</p>
          )}
        </div>
      )}
    </div>
  );
}

function MineView({
  subs,
  teamName,
}: {
  subs: Sub[];
  teamName: (id?: string) => string;
}) {
  return (
    <div className="enter">
      <header className="iam-h">
        <div>
          <h1>我的提交</h1>
          <p>提交后由能管理知识库的人审核；通过后会出现在团队资料里。</p>
        </div>
      </header>
      {subs.length === 0 ? (
        <div className="iam-empty">
          <IconSend />
          <b>还没有提交过</b>
          <span>排障解决后，可以把经过一键提交到团队知识库。</span>
        </div>
      ) : (
        <ul className="kb-mine">
          {subs.map((x) => (
            <li key={x.id}>
              <span className={`kb-st ${x.status}`}>{STATUS[x.status]}</span>
              <span className="kb-mine-t">
                {x.doc ? (
                  <a
                    href={`#/kb/${x.doc}`}
                    onClick={(e) => {
                      e.preventDefault();
                      go({ name: "kb", id: x.doc });
                    }}
                  >
                    {x.title}
                  </a>
                ) : (
                  <b>{x.title}</b>
                )}
                <small>
                  {ago(x.at)}提交 · {teamName(x.team)}
                  {x.reviewer ? ` · ${x.reviewer} 审核` : ""}
                  {x.note ? `：${x.note}` : ""}
                </small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A person's own item: a document opens in the editor view, anything else shows as a file. */
function MineNode({
  id,
  render,
  changed,
  gone,
}: {
  id: string;
  render: () => React.ReactNode;
  changed: () => void;
  gone: () => void;
}) {
  const [kind, setKind] = useState("");
  useEffect(() => {
    api<{ node: FileNode }>(`/api/me/files/${id}`)
      .then((r) => setKind(r.node.kind))
      .catch(() => gone());
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!kind) return <div className="mf-view" aria-busy />;
  return kind === "doc" ? (
    <>{render()}</>
  ) : (
    <FileView id={id} changed={changed} gone={gone} />
  );
}

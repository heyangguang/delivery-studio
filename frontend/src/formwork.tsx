import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheck,
  IconCheckCircleFill,
  IconExclamationCircleFill,
  IconRight,
} from "@arco-design/web-react/icon";
import {
  AIEmblem,
  Bubble,
  ChatErrorCard,
  LiveBubble,
  Spark,
  UnansweredTurnCard,
} from "./aichat";
import type { Msg } from "./aichat";
import { Composer, ConfirmCard, ORDER } from "./formchat";
import type { Attach, Change, FormAI } from "./formchat";
import { bi, useLang } from "./i18n";
import "./formwork.css";

/* The assistant's workspace for a new delivery. Once someone chooses to be helped, the step list steps aside and the
   middle of the page is the conversation. The steps stay one click away in a bar above it: a step opens in the same
   place, the conversation comes back with one click, and what the assistant is writing is shown as it happens. */

type Sec = { id: string; title: string };

/** The bar above the workspace: back, the conversation, every step of the form, and the way to generate. */
export function AIStageBar({
  fa,
  sections,
  view,
  onView,
  issuesOf,
  onBack,
  onForm,
  blocking,
  issues,
  titles,
  onGenerate,
  onNew,
}: {
  fa: FormAI;
  sections: Sec[];
  view: string;
  onView: (v: string) => void;
  issuesOf: (id: string) => number;
  onBack: () => void;
  onForm: () => void;
  blocking: number;
  issues: string[];
  titles: Record<string, string>;
  onGenerate: () => void;
  onNew?: () => void;
}) {
  useLang();
  const working = fa.run?.active ? fa.run.stage : "";
  return (
    <div className="fw-bar">
      <div className="fw-bar-row">
        <button
          type="button"
          className="fw-back"
          onClick={onBack}
          aria-label={bi("返回", "Back")}
        >
          <IconArrowLeft />
        </button>
        <span className="fw-bar-title">{bi("创建交付", "New delivery")}</span>
        <div
          className="fw-tabs"
          role="tablist"
          aria-label={bi("对话与表单步骤", "Chat and form steps")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === "chat"}
            className={`fw-tab ai ${view === "chat" ? "on" : ""} ${fa.busy ? "busy" : ""}`}
            onClick={() => onView("chat")}
          >
            <Spark size={14} rainbow />
            {bi("AI 对话", "AI Chat")}
            {fa.busy && <i className="fw-live" aria-hidden />}
          </button>
          <span className="fw-sep" aria-hidden />
          {sections.map((x, i) => {
            const n = issuesOf(x.id);
            return (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={view === x.id}
                className={`fw-tab ${view === x.id ? "on" : ""} ${working === x.id ? "work" : ""}`}
                onClick={() => onView(x.id)}
              >
                <span
                  className={`rail-mark ${n < 0 ? "idle" : n ? "bad" : "ok"}`}
                  aria-hidden
                >
                  {n < 0 ? null : n ? n : <IconCheck />}
                </span>
                <span className="fw-tab-n num">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {x.title}
                {working === x.id ? (
                  <i
                    className="fw-live"
                    aria-label={bi("AI 正在填写这一步", "AI is filling this step")}
                  />
                ) : (
                  fa.sections.has(x.id) && (
                    <span
                      className="fc-navdot"
                      title={bi("AI 改过，等你确认", "Edited by AI, pending review")}
                      aria-label={bi("AI 改过", "Edited by AI")}
                    />
                  )
                )}
              </button>
            );
          })}
        </div>
        <div className="fw-end">
          {onNew && (
            <button type="button" className="fw-ghost" onClick={onNew}>
              {bi("重新开始", "Start over")}
            </button>
          )}
          <button type="button" className="fw-ghost" onClick={onForm}>
            {bi("自己填", "Edit manually")}
          </button>
          <Button type="primary" onClick={onGenerate}>
            {bi("核对并生成", "Review & generate")}
          </Button>
        </div>
      </div>
      <ConfirmCard
        fa={fa}
        titles={titles}
        blocking={blocking}
        issues={issues}
      />
    </div>
  );
}

/** What one fill changed, in the form's own words, step by step; each step can be opened from here. */
function Changes({
  changes,
  titles,
  onGo,
}: {
  changes: Change[];
  titles: Record<string, string>;
  onGo: (s: string) => void;
}) {
  useLang();
  return (
    <dl className="fw-changes">
      {ORDER.filter((x) => changes.some((c) => c.section === x)).map((x) => (
        <React.Fragment key={x}>
          <dt>
            <button
              type="button"
              className="link quiet"
              onClick={() => onGo(x)}
              title={bi(`打开「${titles[x] || x}」`, `Open "${titles[x] || x}"`)}
            >
              {titles[x] || x}
              <IconRight />
            </button>
          </dt>
          <dd>
            {changes
              .filter((c) => c.section === x)
              .map((c, i) => (
                <span key={i}>
                  {c.label !== titles[x] && <em>{c.label}</em>} {c.detail}
                </span>
              ))}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** The fill as it comes in: the steps light up in turn and each field appears with its value. */
function RunCard({
  fa,
  titles,
}: {
  fa: FormAI;
  titles: Record<string, string>;
}) {
  useLang();
  const r = fa.run;
  if (!r || !r.active) return null;
  const stages = ORDER.filter((x) => r.all.some((c) => c.section === x));
  const total = r.all.length;
  const done = r.items.length;
  const finished = (x: string) =>
    r.items.filter((c) => c.section === x).length >=
    r.all.filter((c) => c.section === x).length;
  return (
    <div
      className="fw-run"
      role="status"
      aria-live="polite"
      aria-label={bi(
        `AI 正在填写表单，${done} / ${total}`,
        `AI is filling the form, ${done} / ${total}`,
      )}
    >
      <div className="fw-run-h">
        <span className="fw-run-emblem" aria-hidden>
          <AIEmblem size={22} />
        </span>
        <b>{bi("AI 正在填写表单", "AI is filling the form")}</b>
        <span className="fw-run-count num">
          {done} / {total}
        </span>
        <button type="button" className="fw-run-skip" onClick={fa.skipRun}>
          {bi("跳过动画，直接完成", "Skip animation & apply")}
        </button>
      </div>
      <div className="fw-run-meter" aria-hidden>
        <span style={{ transform: `scaleX(${total ? done / total : 0})` }} />
      </div>
      <ol className="fw-run-stages">
        {stages.map((x) => (
          <li
            key={x}
            className={x === r.stage ? "on" : finished(x) ? "done" : ""}
          >
            {finished(x) ? <IconCheck /> : <i aria-hidden />}
            <span>{titles[x] || x}</span>
          </li>
        ))}
      </ol>
      <ul className="fw-run-items">
        {r.items.slice(-7).map((c, i, arr) => {
          const isNew = i === arr.length - 1;
          return (
            <li
              key={`${c.section}${c.path}${c.label}${c.detail}`}
              className={isNew ? "new" : ""}
            >
              <em>{titles[c.section] || c.section}</em>
              <b>{c.label}</b>
              <span>{c.detail}</span>
            </li>
          );
        })}
      </ul>
      <p className="fw-run-note">
        {bi(
          "表单暂时锁定，写完就能继续编辑；也可以点上面的步骤去看它被填写。",
          "Form temporarily locked while filling; you can edit again once done, or click a step above to watch.",
        )}
      </p>
    </div>
  );
}

function Filled({
  m,
  titles,
  onGo,
}: {
  m: Msg;
  titles: Record<string, string>;
  onGo: (s: string) => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const changes = (m.form?.changes || []) as Change[];
  return (
    <div className={`fw-filled ${open ? "open" : ""}`}>
      <div className="fw-filled-row">
        <IconCheckCircleFill />
        <span>
          {m.form?.target_component
            ? bi("已切换部署组件", "Switched component")
            : bi("填进了表单", "Applied to form")}
          {m.form?.summary
            ? bi(`：${m.form.summary}`, `: ${m.form.summary}`)
            : ""}
        </span>
        {changes.length > 0 ? (
          <button
            type="button"
            className="link quiet"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            {open
              ? bi("收起", "Collapse")
              : bi(`看改了 ${changes.length} 处`, `View ${changes.length} changes`)}
          </button>
        ) : (
          <button
            type="button"
            className="link quiet"
            onClick={() => onGo("basics")}
          >
            {bi("去看看", "View")}
          </button>
        )}
      </div>
      {open && changes.length > 0 && (
        <Changes changes={changes} titles={titles} onGo={onGo} />
      )}
    </div>
  );
}

/** The conversation, as the whole middle of the page. */
export function FormWorkspace({
  fa,
  titles,
  onGo,
  focus,
  attach,
}: {
  fa: FormAI;
  titles: Record<string, string>;
  onGo: (section: string) => void;
  focus?: boolean;
  attach?: Attach;
}) {
  useLang();
  const list = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const lastForm = (() => {
    for (let i = fa.msgs.length - 1; i >= 0; i--) if (fa.msgs[i].form) return i;
    return -1;
  })();
  // follow the conversation as it grows, unless the person scrolled up to read something
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [fa.msgs.length, fa.live, fa.run?.items.length, fa.error, stick]);
  useEffect(() => {
    // answering or sending always brings the newest into view
    if (fa.busy) setStick(true);
  }, [fa.busy]);
  const onScroll = () => {
    const el = list.current;
    if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };
  const empty = !fa.started && !fa.live;
  return (
    <div className={`fw ${empty ? "empty" : ""}`}>
      <div
        className="fw-list"
        ref={list}
        onScroll={onScroll}
        aria-live="polite"
        aria-busy={fa.busy}
      >
        <div className="fw-col">
          {empty && (
            <div className="fw-hero">
              <span className="fw-hero-orb" aria-hidden>
                <AIEmblem size={52} />
              </span>
              <h2>{bi("说说你要的集群", "Describe your cluster")}</h2>
              <p>
                {bi(
                  "AI 帮你把表填好。你说得越具体越好：机器和地址、几主几从、有没有入口域名、盘要不要格式化。",
                  "AI will fill out the form for you. Be specific about hosts and IPs, primary/replica counts, ingress domains, and whether disks should be formatted.",
                )}
              </p>
            </div>
          )}
          {fa.msgs.map((m, i) => {
            const prevUser =
              i > 0 && fa.msgs[i - 1]?.role === "user" ? fa.msgs[i - 1] : null;
            const isLast = i === fa.msgs.length - 1;
            return (
              <React.Fragment key={i}>
                <Bubble
                  m={m}
                  jobBase=""
                  props={{}}
                  deciding=""
                  decide={() => undefined}
                  comp={false}
                  busy={fa.busy}
                  answer={isLast && !fa.busy ? (t) => fa.send(t) : undefined}
                  onRetry={
                    isLast && !fa.busy && m.error && prevUser?.text
                      ? () => fa.send(prevUser.text, [], "", true)
                      : undefined
                  }
                />
                {m.form && !(i === lastForm && fa.run?.active) && (
                  <Filled m={m} titles={titles} onGo={onGo} />
                )}
              </React.Fragment>
            );
          })}
          {fa.live && (
            <LiveBubble
              live={fa.live}
              props={{}}
              deciding=""
              decide={() => undefined}
              comp={false}
            />
          )}
          <RunCard fa={fa} titles={titles} />
          {!fa.busy &&
            !fa.live &&
            !fa.error &&
            fa.msgs.length > 0 &&
            fa.msgs[fa.msgs.length - 1].role === "user" &&
            fa.msgs[fa.msgs.length - 1].text && (
              <UnansweredTurnCard
                busy={fa.busy}
                onRetry={() =>
                  fa.send(fa.msgs[fa.msgs.length - 1].text, [], "", true)
                }
              />
            )}
          {fa.error && (
            <ChatErrorCard
              text={fa.error.text}
              diag={fa.error.diag}
              kind={fa.error.kind}
              rawError={fa.error.rawError}
              busy={fa.busy}
              onRetry={
                fa.error.retry
                  ? () => (
                      fa.setError(null),
                      fa.send(fa.error!.retry!, [], "", true)
                    )
                  : undefined
              }
            />
          )}
        </div>
        {!stick && (
          <button
            type="button"
            className="fw-down"
            onClick={() => (
              setStick(true),
              list.current?.scrollTo({
                top: list.current.scrollHeight,
                behavior: "smooth",
              })
            )}
          >
            {bi("回到最新", "Jump to latest")}
          </button>
        )}
      </div>
      <div className="fw-foot">
        <div className="fw-col">
          <Composer fa={fa} variant="work" focus={focus} attach={attach} />
        </div>
      </div>
    </div>
  );
}

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheck,
  IconCheckCircleFill,
  IconDown,
  IconExclamationCircleFill,
  IconRight,
  IconSafe,
  IconUp,
} from "@arco-design/web-react/icon";
import {
  AIEmblem,
  Bubble,
  ChatErrorCard,
  LiveBubble,
  Spark,
  UnansweredTurnCard,
} from "../ai/aichat";
import type { Msg } from "../ai/aichat";
import { Composer, ConfirmCard, ORDER } from "./formchat";
import type { Attach, Change, FormAI, FormBaseline } from "./formchat";
import { bi, useLang } from "../../app/i18n";
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

const Filled = React.memo(function Filled({
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
  const baselines = (m.form?.baselines || []) as FormBaseline[];
  const baselineOk = Boolean(m.form?.baseline_checked && baselines.length === 0);
  return (
    <div className={`fw-filled ${open ? "open" : ""}`}>
      <div className="fw-filled-row">
        <IconCheckCircleFill />
        <span className="fw-filled-txt">
          {m.form?.target_component
            ? bi("已切换部署组件", "Switched component")
            : bi("填进了表单", "Applied to form")}
          {m.form?.summary
            ? bi(`：${m.form.summary}`, `: ${m.form.summary}`)
            : ""}
        </span>
        {baselineOk && (
          <span className="fw-base-ok">
            <IconSafe />
            {bi("常见生产基线已就绪", "Baselines ready")}
          </span>
        )}
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
});

const baselineCatLabel = (cat: string) => {
  switch (cat) {
    case "storage":
      return bi("存储", "Storage");
    case "logging":
      return bi("日志", "Logging");
    case "security":
      return bi("安全", "Security");
    case "backup":
      return bi("备份", "Backup");
    case "ha":
      return bi("高可用", "HA");
    case "resource":
      return bi("资源", "Sizing");
    default:
      return bi("基线", "Baseline");
  }
};

type BaselineSessionPref = {
  collapsed: boolean;
  seenIds: string[];
};

function readBaselinePref(chatId: string): BaselineSessionPref {
  if (!chatId) return { collapsed: false, seenIds: [] };
  try {
    const raw = sessionStorage.getItem(`ds-fw-base-v1:${chatId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        collapsed: Boolean(parsed?.collapsed),
        seenIds: Array.isArray(parsed?.seenIds) ? parsed.seenIds : [],
      };
    }
  } catch {
    /* ignore storage issues */
  }
  return { collapsed: false, seenIds: [] };
}

function writeBaselinePref(chatId: string, pref: BaselineSessionPref) {
  if (!chatId) return;
  try {
    sessionStorage.setItem(`ds-fw-base-v1:${chatId}`, JSON.stringify(pref));
  } catch {
    /* ignore storage issues */
  }
}

/**
 * Interactive configuration optimization card shown on the latest AI form fill:
 * - Auto-expands ONLY on the first form-fill turn in a conversation if not yet minimized;
 * - Once the user clicks "缩小" (Minimize) or continues into subsequent turns, stays folded
 *   as a quiet, unobtrusive reminder pill that highlights new suggestions on demand.
 */
const BaselineCard = React.memo(function BaselineCard({
  items,
  chatId,
  turnCount,
  busy,
  titles,
  onGo,
  onApply,
}: {
  items: FormBaseline[];
  chatId: string;
  turnCount: number;
  busy: boolean;
  titles: Record<string, string>;
  onGo: (s: string) => void;
  onApply: (prompt: string) => void;
}) {
  useLang();
  const [pref, setPref] = useState<BaselineSessionPref>(() =>
    readBaselinePref(chatId),
  );
  const [manualOpen, setManualOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(
    () =>
      new Set(
        items
          .filter((it) => it.default_checked && it.action_prompt)
          .map((it) => it.id),
      ),
  );

  // Sync session state when chatId changes (e.g., starting a fresh chat).
  useEffect(() => {
    setPref(readBaselinePref(chatId));
    setManualOpen(false);
    setShowAll(false);
  }, [chatId]);

  const sig = items.map((x) => x.id).join("|");
  useEffect(() => {
    setChecked(
      new Set(
        items
          .filter((it) => it.default_checked && it.action_prompt)
          .map((it) => it.id),
      ),
    );
    setShowAll(false);
    // Once a 2nd+ form-fill turn arrives, automatically fold any previously un-minimized card into the quiet reminder pill.
    if (turnCount > 1) {
      setManualOpen(false);
      setPref((prev) => {
        if (prev.collapsed) return prev;
        const next: BaselineSessionPref = {
          collapsed: true,
          seenIds: prev.seenIds,
        };
        writeBaselinePref(chatId, next);
        return next;
      });
    }
  }, [sig, turnCount, chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isExpanded = manualOpen || (!pref.collapsed && turnCount <= 1);

  // Record currently visible item IDs whenever the card is open so we can badge genuinely new items later.
  useEffect(() => {
    if (!isExpanded || !items.length) return;
    const ids = items.map((it) => it.id);
    const missing = ids.some((id) => !pref.seenIds.includes(id));
    if (missing) {
      const merged = Array.from(new Set([...pref.seenIds, ...ids]));
      const next = { ...pref, seenIds: merged };
      setPref(next);
      writeBaselinePref(chatId, next);
    }
  }, [isExpanded, sig, chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!items.length) return null;

  const minimize = () => {
    const merged = Array.from(
      new Set([...pref.seenIds, ...items.map((it) => it.id)]),
    );
    const next: BaselineSessionPref = { collapsed: true, seenIds: merged };
    setPref(next);
    writeBaselinePref(chatId, next);
    setManualOpen(false);
  };

  const reopen = () => {
    const merged = Array.from(
      new Set([...pref.seenIds, ...items.map((it) => it.id)]),
    );
    const next: BaselineSessionPref = { collapsed: true, seenIds: merged };
    setPref(next);
    writeBaselinePref(chatId, next);
    setManualOpen(true);
  };

  const actionCount = items.filter((it) => it.severity === "action").length;
  const warnCount = items.filter((it) => it.severity === "warn").length;
  const actionable = items.filter((it) => !!it.action_prompt);
  const selectedItems = actionable.filter((it) => checked.has(it.id));
  const newCount = items.filter((it) => !pref.seenIds.includes(it.id)).length;

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedItems.length === actionable.length) {
      setChecked(new Set());
    } else {
      setChecked(new Set(actionable.map((it) => it.id)));
    }
  };

  const applySelected = () => {
    if (!selectedItems.length || busy) return;
    minimize();
    if (selectedItems.length === 1 && selectedItems[0].action_prompt) {
      onApply(selectedItems[0].action_prompt);
      return;
    }
    const lines = selectedItems.map(
      (it, idx) => `${idx + 1}. ${it.title}：${it.action_prompt}`,
    );
    onApply(
      `请按配置优化建议一次性补齐以下 ${selectedItems.length} 项表单配置（其余已有配置保持不变）：\n` +
        lines.join("\n"),
    );
  };

  if (!isExpanded) {
    return (
      <div className="fw-base-remind-wrap">
        <button
          type="button"
          className={`fw-base-remind ${newCount > 0 ? "has-new" : ""}`}
          onClick={reopen}
        >
          <span
            className={`fw-base-remind-dot ${actionCount > 0 ? "is-action" : warnCount > 0 ? "is-warn" : ""}`}
            aria-hidden
          />
          <span className="fw-base-remind-txt">
            {bi(
              `有 ${items.length} 项配置优化建议`,
              `${items.length} configuration suggestion${items.length === 1 ? "" : "s"}`,
            )}
          </span>
          {newCount > 0 && (
            <span className="fw-base-remind-new">
              {bi(`+${newCount} 新增`, `+${newCount} new`)}
            </span>
          )}
          <span className="fw-base-remind-cta">
            {bi("查看建议", "Review")}
            <IconDown />
          </span>
        </button>
      </div>
    );
  }

  const visible = showAll || items.length <= 4 ? items : items.slice(0, 4);
  const hiddenCount = items.length - visible.length;

  return (
    <section
      className="fw-base"
      aria-label={bi("配置优化建议", "Configuration suggestions")}
    >
      <header className="fw-base-h">
        <div className="fw-base-title">
          <span className="fw-base-spark" aria-hidden>
            <Spark size={13} rainbow />
          </span>
          <b>{bi("配置优化建议", "Configuration Suggestions")}</b>
          <span className="fw-base-count">{items.length}</span>
          {actionCount > 0 && (
            <span className="fw-base-sub">
              {bi(`含 ${actionCount} 项重点`, `${actionCount} key`)}
            </span>
          )}
        </div>
        <button
          type="button"
          className="fw-base-fold"
          onClick={minimize}
          title={bi(
            "缩小为单行提醒，后续仅在有需要时点击查看",
            "Minimize to a compact reminder pill",
          )}
        >
          {bi("缩小", "Minimize")}
          <IconUp />
        </button>
      </header>

      <ul className="fw-base-list">
        {visible.map((it) => {
          const canCheck = !!it.action_prompt;
          const isChecked = canCheck && checked.has(it.id);
          const title = bi(it.title, it.title_en || it.title);
          const detail = bi(it.detail, it.detail_en || it.detail);
          const cur = bi(it.current || "", it.current_en || it.current || "");
          const rec = bi(
            it.recommended || "",
            it.recommended_en || it.recommended || "",
          );
          const actLabel = bi(
            it.action_label || "采纳",
            it.action_label_en || "Apply",
          );
          const secTitle = it.section ? titles[it.section] || it.section : "";
          return (
            <li
              key={it.id}
              className={`fw-base-item ${isChecked ? "is-checked" : ""}`}
            >
              <div className="fw-base-lead">
                {canCheck ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isChecked}
                    aria-label={title}
                    className={`fw-base-chk ${isChecked ? "on" : ""}`}
                    disabled={busy}
                    onClick={() => toggle(it.id)}
                  >
                    {isChecked && <IconCheck />}
                  </button>
                ) : (
                  <span
                    className={`fw-base-dot is-${it.severity || "info"}`}
                    aria-hidden
                  />
                )}
              </div>

              <div
                className="fw-base-body"
                onClick={canCheck && !busy ? () => toggle(it.id) : undefined}
              >
                <div className="fw-base-top">
                  <span className="fw-base-name">{title}</span>
                  <span className="fw-base-cat">
                    {baselineCatLabel(it.category)}
                  </span>
                  {(cur || rec) && (
                    <span className="fw-base-diff">
                      {cur && <span className="fw-base-cur">{cur}</span>}
                      {cur && rec && (
                        <span className="fw-base-arr" aria-hidden>
                          →
                        </span>
                      )}
                      {rec && <span className="fw-base-rec">{rec}</span>}
                    </span>
                  )}
                </div>
                <p className="fw-base-desc">{detail}</p>
              </div>

              <div className="fw-base-acts">
                {it.section && (
                  <button
                    type="button"
                    className="fw-base-loc"
                    onClick={() => onGo(it.section!)}
                    title={bi(`打开「${secTitle}」步骤查看`, `Open "${secTitle}" step`)}
                  >
                    {bi("定位", "Locate")}
                  </button>
                )}
                {it.action_prompt && (
                  <button
                    type="button"
                    className="fw-base-one"
                    disabled={busy}
                    onClick={() => {
                      minimize();
                      onApply(it.action_prompt!);
                    }}
                  >
                    {actLabel}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {hiddenCount > 0 && (
        <button
          type="button"
          className="fw-base-more"
          onClick={() => setShowAll(true)}
        >
          <IconDown />
          {bi(
            `展开其余 ${hiddenCount} 项建议`,
            `Show ${hiddenCount} more`,
          )}
        </button>
      )}
      {showAll && items.length > 4 && (
        <button
          type="button"
          className="fw-base-more"
          onClick={() => setShowAll(false)}
        >
          <IconUp />
          {bi("收起部分项", "Show fewer")}
        </button>
      )}

      {actionable.length > 0 && (
        <footer className="fw-base-foot">
          <button
            type="button"
            className="fw-base-selall"
            disabled={busy}
            onClick={toggleAll}
          >
            {selectedItems.length === actionable.length
              ? bi("取消全选", "Deselect all")
              : bi(`全选 (${actionable.length})`, `Select all (${actionable.length})`)}
          </button>
          <div className="fw-base-foot-btns">
            <button
              type="button"
              className="fw-base-skip"
              onClick={minimize}
            >
              {bi("暂不调整", "Not now")}
            </button>
            <button
              type="button"
              className="fw-base-apply"
              disabled={busy || selectedItems.length === 0}
              onClick={applySelected}
            >
              {selectedItems.length > 0
                ? bi(
                    `一键采纳 (${selectedItems.length})`,
                    `Apply selected (${selectedItems.length})`,
                  )
                : bi("请选择建议项", "Select items")}
            </button>
          </div>
        </footer>
      )}
    </section>
  );
});

const EMPTY_PROPS: Record<string, never> = {};
const NOOP_DECIDE = () => undefined;

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
  const stickRef = useRef(true);
  const progScrollRef = useRef(false);
  const scrollRafRef = useRef<number>(0);
  const sendRef = useRef(fa.send);
  sendRef.current = fa.send;
  const handleAnswer = useCallback((t: string) => {
    void sendRef.current(t);
  }, []);
  const lastForm = (() => {
    for (let i = fa.msgs.length - 1; i >= 0; i--) if (fa.msgs[i].form) return i;
    return -1;
  })();
  const formTurnCount = useMemo(
    () => fa.msgs.reduce((n, m) => (m.form ? n + 1 : n), 0),
    [fa.msgs],
  );
  // follow the conversation as it grows via coalesced rAF, unless the person scrolled up to read something
  useEffect(() => {
    if (!stickRef.current) return;
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const el = list.current;
      if (!el || !stickRef.current) return;
      progScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        progScrollRef.current = false;
      });
    });
  }, [fa.msgs.length, fa.live, fa.run?.items.length, fa.error, stick]);
  useEffect(
    () => () => {
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = 0;
      }
    },
    [],
  );
  const prevMsgCountRef = useRef(fa.msgs.length);
  useEffect(() => {
    // sending a new user turn brings the newest into view; streaming chunks preserve user scroll-up lock
    if (fa.msgs.length > prevMsgCountRef.current) {
      const newest = fa.msgs[fa.msgs.length - 1];
      if (newest?.role === "user") {
        stickRef.current = true;
        setStick(true);
      }
    }
    prevMsgCountRef.current = fa.msgs.length;
  }, [fa.msgs]);
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < -2 && stickRef.current) {
      stickRef.current = false;
      setStick(false);
    }
  };
  const onScroll = () => {
    const el = list.current;
    if (!el || progScrollRef.current) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (stickRef.current !== near) {
      stickRef.current = near;
      setStick(near);
    }
  };
  const empty = !fa.started && !fa.live;
  return (
    <div className={`fw ${empty ? "empty" : ""}`}>
      <div
        className="fw-list"
        ref={list}
        onWheel={onWheel}
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
            const nextUser =
              i + 1 < fa.msgs.length && fa.msgs[i + 1]?.role === "user"
                ? fa.msgs[i + 1]
                : null;
            const isLast = i === fa.msgs.length - 1;
            const isLatestForm = i === lastForm;
            const baselines = (m.form?.baselines || []) as FormBaseline[];
            return (
              <React.Fragment key={i}>
                <Bubble
                  m={m}
                  jobBase=""
                  props={EMPTY_PROPS}
                  deciding=""
                  decide={NOOP_DECIDE}
                  comp={false}
                  busy={fa.busy}
                  answer={isLast && !fa.busy ? handleAnswer : undefined}
                  answered={nextUser?.text}
                  onRetry={
                    isLast && !fa.busy && m.error && prevUser?.text
                      ? () => fa.send(prevUser.text, [], "", true)
                      : undefined
                  }
                />
                {m.form && !(isLatestForm && fa.run?.active) && (
                  <>
                    <Filled m={m} titles={titles} onGo={onGo} />
                    {isLatestForm && baselines.length > 0 && (
                      <BaselineCard
                        items={baselines}
                        chatId={fa.chatId}
                        turnCount={formTurnCount}
                        busy={fa.busy}
                        titles={titles}
                        onGo={onGo}
                        onApply={handleAnswer}
                      />
                    )}
                  </>
                )}
              </React.Fragment>
            );
          })}
          {fa.live && (
            <LiveBubble
              live={fa.live}
              props={EMPTY_PROPS}
              deciding=""
              decide={NOOP_DECIDE}
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
            onClick={() => {
              stickRef.current = true;
              setStick(true);
              list.current?.scrollTo({
                top: list.current.scrollHeight,
                behavior: "smooth",
              });
            }}
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

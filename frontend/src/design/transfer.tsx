import React, { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Input } from "@arco-design/web-react";
import {
  IconClose,
  IconEmpty,
  IconLeft,
  IconPlus,
  IconRight,
  IconSearch,
} from "@arco-design/web-react/icon";
import { bi, useLang } from "../app/i18n";
import "./transfer.css";

export type ProTransferItem = {
  key: string;
  title: string;
  monoTitle?: boolean;
  href?: string;
  onOpenLink?: () => void;
  badge?: string;
  tag?: {
    text: string;
    tone?: "ok" | "brand" | "cobalt" | "warn" | "neutral";
  };
  avatarText?: string;
  avatarIcon?: React.ReactNode;
  avatarTeam?: boolean;
  statusDot?: "online" | "offline" | "disabled";
  subtitle?: string;
  /** Lowercase searchable text; supports multi-token space-separated AND matching */
  searchText: string;
  disabled?: boolean;
  leftExtra?: React.ReactNode;
  rightExtra?: React.ReactNode;
};

export type ProTransferDualAction = {
  label: string;
  type?: "primary" | "secondary" | "outline";
  onTrigger: (keys: string[]) => void;
};

function matchesTokens(searchText: string, rawKw: string): boolean {
  const kw = rawKw.trim().toLowerCase();
  if (!kw) return true;
  const hay = searchText.toLowerCase();
  const tokens = kw.split(/\s+/).filter(Boolean);
  return tokens.every((tok) => hay.includes(tok));
}

/**
 * Pixel-locked equal-height dual-pane Transfer Box.
 * - Left & right panes are strictly locked to identical CSS Grid height (`height` prop, default 364px).
 * - Multi-keyword space-separated AND search (e.g. `pg 172.30 ubuntu`).
 * - Supports Select All, Invert Selection (`反选`), double-click row transfer, and `≫ / › / ‹ / ≪` batch controls.
 */
export function ProTransfer({
  leftTitle,
  rightTitle,
  leftItems,
  rightItems,
  leftPlaceholder,
  rightPlaceholder,
  leftEmptyText,
  rightEmptyText,
  busy = false,
  height = 364,
  topBar,
  onAdd,
  onRemove,
  dualAddActions,
}: {
  leftTitle: string;
  rightTitle: string;
  leftItems: ProTransferItem[];
  rightItems: ProTransferItem[];
  leftPlaceholder?: string;
  rightPlaceholder?: string;
  leftEmptyText?: string;
  rightEmptyText?: string;
  busy?: boolean;
  height?: number;
  topBar?: React.ReactNode;
  onAdd?: (keys: string[]) => void;
  onRemove: (keys: string[]) => void;
  /** Optional multi-mode add buttons (e.g. IAM "设为运维" + "设为只读") instead of single `›` button */
  dualAddActions?: ProTransferDualAction[];
}) {
  useLang();
  const [leftKw, setLeftKw] = useState("");
  const [rightKw, setRightKw] = useState("");
  const [leftSel, setLeftSel] = useState<Set<string>>(() => new Set());
  const [rightSel, setRightSel] = useState<Set<string>>(() => new Set());
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) {
      setPendingAction(null);
    }
  }, [busy]);

  const leftKeySig = useMemo(
    () => leftItems.map((x) => x.key).join("|"),
    [leftItems],
  );
  const rightKeySig = useMemo(
    () => rightItems.map((x) => x.key).join("|"),
    [rightItems],
  );

  useEffect(() => {
    setLeftSel((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(leftItems.filter((x) => !x.disabled).map((x) => x.key));
      const next = new Set<string>();
      for (const k of prev) if (valid.has(k)) next.add(k);
      return next.size === prev.size ? prev : next;
    });
  }, [leftKeySig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setRightSel((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(rightItems.filter((x) => !x.disabled).map((x) => x.key));
      const next = new Set<string>();
      for (const k of prev) if (valid.has(k)) next.add(k);
      return next.size === prev.size ? prev : next;
    });
  }, [rightKeySig]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredLeft = useMemo(
    () => leftItems.filter((it) => matchesTokens(it.searchText, leftKw)),
    [leftItems, leftKw],
  );
  const filteredRight = useMemo(
    () => rightItems.filter((it) => matchesTokens(it.searchText, rightKw)),
    [rightItems, rightKw],
  );

  const enabledLeft = useMemo(
    () => filteredLeft.filter((it) => !it.disabled),
    [filteredLeft],
  );
  const enabledRight = useMemo(
    () => filteredRight.filter((it) => !it.disabled),
    [filteredRight],
  );

  const validLeftIds = useMemo(
    () => enabledLeft.filter((it) => leftSel.has(it.key)).map((it) => it.key),
    [enabledLeft, leftSel],
  );
  const validRightIds = useMemo(
    () => enabledRight.filter((it) => rightSel.has(it.key)).map((it) => it.key),
    [enabledRight, rightSel],
  );

  const allLeftChecked =
    enabledLeft.length > 0 && validLeftIds.length === enabledLeft.length;
  const someLeftChecked = validLeftIds.length > 0 && !allLeftChecked;

  const allRightChecked =
    enabledRight.length > 0 && validRightIds.length === enabledRight.length;
  const someRightChecked = validRightIds.length > 0 && !allRightChecked;

  const invertLeft = () => {
    setLeftSel((prev) => {
      const next = new Set(prev);
      for (const it of enabledLeft) {
        if (next.has(it.key)) next.delete(it.key);
        else next.add(it.key);
      }
      return next;
    });
  };

  const invertRight = () => {
    setRightSel((prev) => {
      const next = new Set(prev);
      for (const it of enabledRight) {
        if (next.has(it.key)) next.delete(it.key);
        else next.add(it.key);
      }
      return next;
    });
  };

  const triggerAdd = (keys: string[]) => {
    if (!keys.length || busy) return;
    if (onAdd) {
      setPendingAction("add");
      onAdd(keys);
      setLeftSel(new Set());
    } else if (dualAddActions?.[0]) {
      setPendingAction("dual-0");
      dualAddActions[0].onTrigger(keys);
      setLeftSel(new Set());
    }
  };

  const triggerRemove = (keys: string[]) => {
    if (!keys.length || busy) return;
    setPendingAction("remove");
    onRemove(keys);
    setRightSel(new Set());
  };

  const isCompactMid = !dualAddActions || dualAddActions.length === 0;

  return (
    <div
      className="ptf-root"
      style={{ "--ptf-h": `${height}px` } as React.CSSProperties}
    >
      {topBar && <div className="ptf-topbar">{topBar}</div>}

      <div className="ptf-grid">
        {/* Left Source Pane */}
        <div className="ptf-pane">
          <div className="ptf-head">
            <label className="ptf-head-left">
              <Checkbox
                checked={allLeftChecked}
                indeterminate={someLeftChecked}
                disabled={busy || enabledLeft.length === 0}
                onChange={(chk) => {
                  const next = new Set(leftSel);
                  for (const it of enabledLeft) {
                    if (chk) next.add(it.key);
                    else next.delete(it.key);
                  }
                  setLeftSel(next);
                }}
              />
              <span>{leftTitle}</span>
            </label>
            <div className="ptf-head-right">
              {enabledLeft.length > 1 && (
                <button
                  type="button"
                  className="ptf-invert-btn"
                  disabled={busy}
                  onClick={invertLeft}
                >
                  {bi("反选", "Invert")}
                </button>
              )}
              <span className="ptf-cnt num">
                {validLeftIds.length > 0
                  ? `${validLeftIds.length} / ${filteredLeft.length}`
                  : filteredLeft.length}
              </span>
            </div>
          </div>

          <div className="ptf-search">
            <Input
              size="small"
              prefix={<IconSearch />}
              allowClear
              value={leftKw}
              onChange={setLeftKw}
              placeholder={
                leftPlaceholder ||
                bi(
                  "输入多关键词空格组合检索（如 pg 172.30）…",
                  "Multi-keyword search (e.g. pg 172.30)…",
                )
              }
            />
          </div>

          <div className="ptf-list">
            {filteredLeft.length === 0 ? (
              <div className="ptf-empty">
                <IconEmpty />
                <span>
                  {leftKw.trim()
                    ? bi("没有匹配的候选项", "No matching items")
                    : leftEmptyText || bi("暂无可选项", "No items available")}
                </span>
              </div>
            ) : (
              filteredLeft.map((it) => {
                const checked = leftSel.has(it.key);
                return (
                  <div
                    key={it.key}
                    className={`ptf-row ${checked ? "is-checked" : ""} ${
                      it.disabled ? "is-disabled" : ""
                    }`}
                    onClick={() => {
                      if (it.disabled || busy) return;
                      const next = new Set(leftSel);
                      if (checked) next.delete(it.key);
                      else next.add(it.key);
                      setLeftSel(next);
                    }}
                    onDoubleClick={() => {
                      if (!it.disabled && !busy && onAdd) {
                        triggerAdd([it.key]);
                      }
                    }}
                  >
                    <span
                      className="ptf-row-chk"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={it.disabled || busy}
                        onChange={(v) => {
                          const next = new Set(leftSel);
                          if (v) next.add(it.key);
                          else next.delete(it.key);
                          setLeftSel(next);
                        }}
                      />
                    </span>

                    <div className="ptf-row-body">
                      {it.statusDot && (
                        <span className={`ptf-dot is-${it.statusDot}`} />
                      )}
                      {(it.avatarText || it.avatarIcon) && (
                        <span
                          className={`ptf-ava ${it.avatarTeam ? "is-team" : ""}`}
                          aria-hidden
                        >
                          {it.avatarIcon || it.avatarText}
                        </span>
                      )}
                      <div className="ptf-text">
                        <div className="ptf-line1">
                          <span
                            className={`ptf-title ${it.monoTitle ? "mono" : ""}`}
                            title={it.title}
                          >
                            {it.title}
                          </span>
                          {it.badge && (
                            <span className="ptf-badge">{it.badge}</span>
                          )}
                          {it.tag && (
                            <span
                              className={`ptf-tag is-${it.tag.tone || "neutral"}`}
                            >
                              {it.tag.text}
                            </span>
                          )}
                        </div>
                        {it.subtitle && (
                          <div className="ptf-sub" title={it.subtitle}>
                            {it.subtitle}
                          </div>
                        )}
                      </div>
                    </div>

                    <div
                      className="ptf-row-acts"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {it.leftExtra ? (
                        it.leftExtra
                      ) : (
                        !it.disabled &&
                        onAdd && (
                          <button
                            type="button"
                            className="ptf-icon-btn"
                            disabled={busy}
                            title={bi("移入右侧", "Add")}
                            onClick={() => triggerAdd([it.key])}
                          >
                            <IconPlus />
                          </button>
                        )
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Center Transfer Column */}
        <div className={`ptf-mid ${isCompactMid ? "is-compact" : ""}`}>
          {dualAddActions && dualAddActions.length > 0 ? (
            <>
              {dualAddActions.map((act, idx) => (
                <Button
                  key={idx}
                  size="small"
                  type={act.type || (idx === 0 ? "primary" : "secondary")}
                  disabled={busy || validLeftIds.length === 0}
                  loading={busy && pendingAction === `dual-${idx}`}
                  onClick={() => {
                    setPendingAction(`dual-${idx}`);
                    act.onTrigger(validLeftIds);
                    setLeftSel(new Set());
                  }}
                >
                  {act.label} <IconRight />
                </Button>
              ))}
              <Button
                size="small"
                status="danger"
                disabled={busy || validRightIds.length === 0}
                loading={busy && pendingAction === "remove"}
                onClick={() => triggerRemove(validRightIds)}
              >
                <IconLeft /> {bi("移除", "Remove")}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="small"
                type="primary"
                disabled={busy || validLeftIds.length === 0}
                loading={busy && pendingAction === "add"}
                onClick={() => triggerAdd(validLeftIds)}
                aria-label={bi("移入右侧", "Move selected")}
              >
                <IconRight />
              </Button>
              <Button
                size="small"
                type="secondary"
                disabled={busy || validRightIds.length === 0}
                loading={busy && pendingAction === "remove"}
                onClick={() => triggerRemove(validRightIds)}
                aria-label={bi("移出已选", "Remove selected")}
              >
                <IconLeft />
              </Button>
            </>
          )}
        </div>

        {/* Right Target Pane */}
        <div className="ptf-pane is-target">
          <div className="ptf-head">
            <label className="ptf-head-left">
              <Checkbox
                checked={allRightChecked}
                indeterminate={someRightChecked}
                disabled={busy || enabledRight.length === 0}
                onChange={(chk) => {
                  const next = new Set(rightSel);
                  for (const it of enabledRight) {
                    if (chk) next.add(it.key);
                    else next.delete(it.key);
                  }
                  setRightSel(next);
                }}
              />
              <span>{rightTitle}</span>
            </label>
            <div className="ptf-head-right">
              {enabledRight.length > 1 && (
                <button
                  type="button"
                  className="ptf-invert-btn"
                  disabled={busy}
                  onClick={invertRight}
                >
                  {bi("反选", "Invert")}
                </button>
              )}
              <span className="ptf-cnt is-target num">
                {validRightIds.length > 0
                  ? `${validRightIds.length} / ${rightItems.length}`
                  : rightItems.length}
              </span>
            </div>
          </div>

          <div className="ptf-search">
            <Input
              size="small"
              prefix={<IconSearch />}
              allowClear
              value={rightKw}
              onChange={setRightKw}
              placeholder={
                rightPlaceholder || bi("筛选右侧已选项…", "Filter selected…")
              }
            />
          </div>

          <div className="ptf-list">
            {filteredRight.length === 0 ? (
              <div className="ptf-empty">
                <IconEmpty />
                <span>
                  {rightKw.trim()
                    ? bi("没有匹配的已选项", "No matching items")
                    : rightEmptyText ||
                      bi(
                        "从左侧勾选或双击条目即可移入",
                        "Select or double-click items on the left",
                      )}
                </span>
              </div>
            ) : (
              filteredRight.map((it) => {
                const checked = rightSel.has(it.key);
                return (
                  <div
                    key={it.key}
                    className={`ptf-row ${checked ? "is-checked" : ""} ${
                      it.disabled ? "is-disabled" : ""
                    }`}
                    onClick={() => {
                      if (it.disabled || busy) return;
                      const next = new Set(rightSel);
                      if (checked) next.delete(it.key);
                      else next.add(it.key);
                      setRightSel(next);
                    }}
                    onDoubleClick={() => {
                      if (!it.disabled && !busy) {
                        triggerRemove([it.key]);
                      }
                    }}
                  >
                    <span
                      className="ptf-row-chk"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={it.disabled || busy}
                        onChange={(v) => {
                          const next = new Set(rightSel);
                          if (v) next.add(it.key);
                          else next.delete(it.key);
                          setRightSel(next);
                        }}
                      />
                    </span>

                    <div className="ptf-row-body">
                      {it.statusDot && (
                        <span className={`ptf-dot is-${it.statusDot}`} />
                      )}
                      {(it.avatarText || it.avatarIcon) && (
                        <span
                          className={`ptf-ava ${it.avatarTeam ? "is-team" : ""}`}
                          aria-hidden
                        >
                          {it.avatarIcon || it.avatarText}
                        </span>
                      )}
                      <div className="ptf-text">
                        <div className="ptf-line1">
                          {it.href ? (
                            <a
                              href={it.href}
                              className={`ptf-title ${it.monoTitle ? "mono" : ""}`}
                              title={it.title}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                it.onOpenLink?.();
                              }}
                            >
                              {it.title}
                            </a>
                          ) : (
                            <span
                              className={`ptf-title ${it.monoTitle ? "mono" : ""}`}
                              title={it.title}
                            >
                              {it.title}
                            </span>
                          )}
                          {it.badge && (
                            <span className="ptf-badge">{it.badge}</span>
                          )}
                          {it.tag && (
                            <span
                              className={`ptf-tag is-${it.tag.tone || "neutral"}`}
                            >
                              {it.tag.text}
                            </span>
                          )}
                        </div>
                        {it.subtitle && (
                          <div className="ptf-sub" title={it.subtitle}>
                            {it.subtitle}
                          </div>
                        )}
                      </div>
                    </div>

                    <div
                      className="ptf-row-acts"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {it.rightExtra}
                      {!it.disabled && (
                        <button
                          type="button"
                          className="ptf-icon-btn is-rm"
                          disabled={busy}
                          title={bi("移出", "Remove")}
                          onClick={() => triggerRemove([it.key])}
                        >
                          <IconClose />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Tooltip } from "@arco-design/web-react";
import {
  IconArrowRight,
  IconCheck,
  IconClose,
  IconDelete,
  IconDown,
  IconEdit,
  IconFile,
  IconSend,
  IconUp,
} from "@arco-design/web-react/icon";
import { bi, useLang } from "./i18n";
import "./aiqueue.css";

export type QueuedAttachment = {
  id: string;
  name: string;
};

export type QueuedMsg<F extends QueuedAttachment = QueuedAttachment> = {
  id: string;
  text: string;
  images?: string[];
  files?: F[];
  at: number;
};

const mkQueueId = () =>
  `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Per-thread FIFO message queue with priority reordering, inline editing, deletion, pause/resume, and jump-ahead. */
export function useMessageQueue<F extends QueuedAttachment = QueuedAttachment>(
  threadKey: string,
) {
  const [byThread, setByThread] = useState<Record<string, QueuedMsg<F>[]>>({});
  const [pausedByThread, setPausedByThread] = useState<Record<string, boolean>>(
    {},
  );
  const keyRef = useRef(threadKey);
  keyRef.current = threadKey;

  const items = byThread[threadKey] || [];
  const paused = Boolean(pausedByThread[threadKey]);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const enqueue = useCallback(
    (msg: Omit<QueuedMsg<F>, "id" | "at">) => {
      const text = msg.text.trim();
      const images = msg.images?.length ? [...msg.images] : undefined;
      const files = msg.files?.length ? [...msg.files] : undefined;
      if (!text && !images?.length && !files?.length) return false;
      const k = keyRef.current;
      const entry: QueuedMsg<F> = {
        id: mkQueueId(),
        text,
        images,
        files,
        at: Date.now(),
      };
      setByThread((prev) => ({ ...prev, [k]: [...(prev[k] || []), entry] }));
      setPausedByThread((prev) => (prev[k] ? { ...prev, [k]: false } : prev));
      return true;
    },
    [],
  );

  const remove = useCallback((id: string) => {
    const k = keyRef.current;
    setByThread((prev) => {
      const next = (prev[k] || []).filter((x) => x.id !== id);
      if (!next.length) {
        const copy = { ...prev };
        delete copy[k];
        return copy;
      }
      return { ...prev, [k]: next };
    });
  }, []);

  const update = useCallback((id: string, nextText: string) => {
    const k = keyRef.current;
    const trimmed = nextText.trim();
    setByThread((prev) => {
      const list = prev[k] || [];
      const target = list.find((x) => x.id === id);
      if (!target) return prev;
      if (!trimmed && !target.images?.length && !target.files?.length) {
        const filtered = list.filter((x) => x.id !== id);
        if (!filtered.length) {
          const copy = { ...prev };
          delete copy[k];
          return copy;
        }
        return { ...prev, [k]: filtered };
      }
      return {
        ...prev,
        [k]: list.map((x) => (x.id === id ? { ...x, text: trimmed } : x)),
      };
    });
  }, []);

  const move = useCallback((fromIdx: number, toIdx: number) => {
    const k = keyRef.current;
    setByThread((prev) => {
      const list = [...(prev[k] || [])];
      if (
        fromIdx < 0 ||
        toIdx < 0 ||
        fromIdx >= list.length ||
        toIdx >= list.length ||
        fromIdx === toIdx
      )
        return prev;
      const [moved] = list.splice(fromIdx, 1);
      list.splice(toIdx, 0, moved);
      return { ...prev, [k]: list };
    });
  }, []);

  const moveUp = useCallback((id: string) => {
    const idx = itemsRef.current.findIndex((x) => x.id === id);
    if (idx > 0) move(idx, idx - 1);
  }, [move]);

  const moveDown = useCallback((id: string) => {
    const idx = itemsRef.current.findIndex((x) => x.id === id);
    if (idx >= 0 && idx < itemsRef.current.length - 1) move(idx, idx + 1);
  }, [move]);

  const take = useCallback((id?: string): QueuedMsg<F> | undefined => {
    const cur = itemsRef.current;
    if (!cur.length) return undefined;
    const target = id ? cur.find((x) => x.id === id) : cur[0];
    if (!target) return undefined;
    const k = keyRef.current;
    const rest = cur.filter((x) => x.id !== target.id);
    itemsRef.current = rest;
    setByThread((prev) => {
      const next = (prev[k] || []).filter((x) => x.id !== target.id);
      if (!next.length) {
        const copy = { ...prev };
        delete copy[k];
        return copy;
      }
      return { ...prev, [k]: next };
    });
    return target;
  }, []);

  const clear = useCallback(() => {
    const k = keyRef.current;
    setByThread((prev) => {
      if (!prev[k]) return prev;
      const copy = { ...prev };
      delete copy[k];
      return copy;
    });
    setPausedByThread((prev) => {
      if (!prev[k]) return prev;
      const copy = { ...prev };
      delete copy[k];
      return copy;
    });
  }, []);

  const setPaused = useCallback((p: boolean) => {
    const k = keyRef.current;
    setPausedByThread((prev) => ({ ...prev, [k]: p }));
  }, []);

  return {
    items,
    paused,
    setPaused,
    enqueue,
    remove,
    update,
    move,
    moveUp,
    moveDown,
    take,
    clear,
  };
}

export function MessageQueueTray<
  F extends QueuedAttachment = QueuedAttachment,
>({
  items,
  busy,
  paused,
  compact,
  onResume,
  onSendNow,
  onEdit,
  onDelete,
  onMove,
  onMoveUp,
  onMoveDown,
  onClear,
}: {
  items: QueuedMsg<F>[];
  busy: boolean;
  paused: boolean;
  compact?: boolean;
  onResume: () => void;
  onSendNow: (item: QueuedMsg<F>) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onMove: (fromIdx: number, toIdx: number) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onClear: () => void;
}) {
  useLang();
  const [collapsed, setCollapsed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editingId && !items.some((x) => x.id === editingId)) {
      setEditingId(null);
      setDraft("");
    }
  }, [items, editingId]);

  useEffect(() => {
    if (editingId) {
      requestAnimationFrame(() => {
        const el = editRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  }, [editingId]);

  if (!items.length) return null;

  const startEdit = (item: QueuedMsg<F>) => {
    setCollapsed(false);
    setEditingId(item.id);
    setDraft(item.text);
  };

  const commitEdit = () => {
    if (!editingId) return;
    onEdit(editingId, draft);
    setEditingId(null);
    setDraft("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };

  return (
    <div
      className={`aq-tray ${compact ? "compact" : ""} ${collapsed ? "is-collapsed" : ""}`}
      role="region"
      aria-label={bi("待发送消息队列", "Queued messages")}
    >
      <div className="aq-head">
        <button
          type="button"
          className="aq-head-toggle"
          onClick={() => setCollapsed((x) => !x)}
          aria-expanded={!collapsed}
        >
          <span className="aq-title">{bi("待发送队列", "Queued Messages")}</span>
          <span className="aq-count num">{items.length}</span>
          <span className="aq-hint">
            {paused && !busy
              ? bi("已暂停自动发送", "Auto-send paused")
              : busy
                ? bi("当前回复完成后依次发送", "Sends after current reply")
                : bi("准备发送下一条…", "Sending next…")}
          </span>
        </button>

        <div className="aq-head-acts">
          {paused && !busy && (
            <button
              type="button"
              className="aq-resume"
              onClick={onResume}
            >
              <IconSend />
              <span>{bi("继续发送", "Resume")}</span>
            </button>
          )}
          {items.length > 1 && (
            <button
              type="button"
              className="aq-clear"
              onClick={onClear}
            >
              {bi("清空", "Clear")}
            </button>
          )}
          <button
            type="button"
            className="aq-chev"
            onClick={() => setCollapsed((x) => !x)}
            aria-label={collapsed ? bi("展开队列", "Expand queue") : bi("收起队列", "Collapse queue")}
          >
            {collapsed ? <IconUp /> : <IconDown />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <ul className="aq-list">
          {items.map((item, idx) => {
            const isEditing = editingId === item.id;
            const isFirst = idx === 0;
            const isLast = idx === items.length - 1;
            const firstImg = item.images?.[0];
            const extraImgs = (item.images?.length || 0) - (firstImg ? 1 : 0);
            const fileCount = item.files?.length || 0;
            return (
              <li
                key={item.id}
                className={`aq-item ${isFirst ? "is-next" : ""} ${isEditing ? "is-editing" : ""} ${dragIdx === idx ? "is-dragging" : ""} ${overIdx === idx && dragIdx !== null && dragIdx !== idx ? "is-over" : ""}`}
                draggable={!isEditing && items.length > 1}
                onDragStart={(e) => {
                  setDragIdx(idx);
                  e.dataTransfer.effectAllowed = "move";
                  try {
                    e.dataTransfer.setData("text/plain", item.id);
                  } catch {
                    /* ignore */
                  }
                }}
                onDragOver={(e) => {
                  if (dragIdx === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overIdx !== idx) setOverIdx(idx);
                }}
                onDrop={(e) => {
                  if (dragIdx === null) return;
                  e.preventDefault();
                  if (dragIdx !== idx) onMove(dragIdx, idx);
                  setDragIdx(null);
                  setOverIdx(null);
                }}
                onDragEnd={() => {
                  setDragIdx(null);
                  setOverIdx(null);
                }}
              >
                <span
                  className={`aq-rank num ${isFirst ? "is-next" : ""}`}
                  title={
                    items.length > 1
                      ? bi("可拖拽或使用上下箭头调整发送优先级", "Drag or use arrows to adjust priority")
                      : bi("下一条自动发送", "Next to send")
                  }
                >
                  {idx + 1}
                </span>

                {firstImg && (
                  <span className="aq-thumb">
                    <img src={firstImg} alt="" />
                    {extraImgs > 0 && <em>+{extraImgs}</em>}
                  </span>
                )}

                {isEditing ? (
                  <div className="aq-edit-box">
                    <textarea
                      ref={editRef}
                      className="aq-edit-in"
                      rows={2}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          commitEdit();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelEdit();
                        }
                      }}
                      aria-label={bi("修改队列消息", "Edit queued message")}
                    />
                    <div className="aq-edit-acts">
                      <button
                        type="button"
                        className="aq-edit-btn ok"
                        onClick={commitEdit}
                      >
                        <IconCheck /> {bi("保存", "Save")}
                      </button>
                      <button
                        type="button"
                        className="aq-edit-btn"
                        onClick={cancelEdit}
                      >
                        <IconClose /> {bi("取消", "Cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="aq-body"
                    onDoubleClick={() => startEdit(item)}
                    title={item.text}
                  >
                    <p className="aq-text">
                      {item.text ||
                        (firstImg
                          ? bi("（仅图片消息）", "(Image message)")
                          : bi("（仅附件消息）", "(Attachment message)"))}
                    </p>
                    {fileCount > 0 && (
                      <span className="aq-meta">
                        <IconFile />{" "}
                        {fileCount === 1
                          ? item.files![0].name
                          : bi(`${fileCount} 个附件`, `${fileCount} files`)}
                      </span>
                    )}
                  </div>
                )}

                {!isEditing && (
                  <div className="aq-acts">
                    {items.length > 1 && (
                      <>
                        <Tooltip content={bi("提高优先级（上移）", "Move up (higher priority)")} mini>
                          <button
                            type="button"
                            className="aq-act"
                            disabled={isFirst}
                            onClick={() => onMoveUp(item.id)}
                            aria-label={bi("上移优先级", "Move up")}
                          >
                            <IconUp />
                          </button>
                        </Tooltip>
                        <Tooltip content={bi("降低优先级（下移）", "Move down (lower priority)")} mini>
                          <button
                            type="button"
                            className="aq-act"
                            disabled={isLast}
                            onClick={() => onMoveDown(item.id)}
                            aria-label={bi("下移优先级", "Move down")}
                          >
                            <IconDown />
                          </button>
                        </Tooltip>
                      </>
                    )}
                    <Tooltip
                      content={
                        busy
                          ? bi("立即插队发送（停止当前回复）", "Send now (stops current reply)")
                          : bi("立即发送", "Send now")
                      }
                      mini
                    >
                      <button
                        type="button"
                        className="aq-act is-go"
                        onClick={() => onSendNow(item)}
                        aria-label={bi("立即发送", "Send now")}
                      >
                        <IconArrowRight />
                      </button>
                    </Tooltip>
                    <Tooltip content={bi("修改消息", "Edit message")} mini>
                      <button
                        type="button"
                        className="aq-act"
                        onClick={() => startEdit(item)}
                        aria-label={bi("修改消息", "Edit message")}
                      >
                        <IconEdit />
                      </button>
                    </Tooltip>
                    <Tooltip content={bi("移除", "Delete")} mini>
                      <button
                        type="button"
                        className="aq-act is-del"
                        onClick={() => onDelete(item.id)}
                        aria-label={bi("移除队列消息", "Remove queued message")}
                      >
                        <IconDelete />
                      </button>
                    </Tooltip>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

import React, { useState } from "react";
import {
  Button,
  Input,
  InputNumber,
  InputTag,
  Select,
  Switch,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowDown,
  IconArrowUp,
  IconCopy,
  IconDelete,
  IconDown,
  IconPlus,
  IconRight,
} from "@arco-design/web-react/icon";
import { aiTouched, get, isEmpty, useWb } from "./wbdoc";
import type { Path } from "./wbdoc";
import { bi, useLang } from "./i18n";

/* Form building blocks of the component workbench. Every field writes straight into the manifest through the shared
   ops, so there is no "apply" step and the YAML source tab is always current. */

export type Opt = { value: string; label: string };
export type FieldSpec = {
  key: string;
  label: string;
  kind:
    | "text"
    | "mono"
    | "number"
    | "bool"
    | "select"
    | "tags"
    | "area"
    | "expr"
    | "multi";
  options?: Opt[] | ((item: any) => Opt[]);
  hint?: string;
  placeholder?: string;
  /** s = a quarter row, m = half, l = whole row. */
  width?: "s" | "m" | "l";
  show?: (item: any) => boolean;
  /** For free-typed values that must be numbers when they look like numbers (param defaults). */
  loose?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
};

const looseValue = (s: string): unknown => {
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t) && !/^0\d/.test(t)) return Number(t);
  return s;
};

export function Field({
  spec,
  path,
  item,
}: {
  spec: FieldSpec;
  path: Path;
  item: any;
}) {
  useLang();
  const { ops, readOnly, params, roles, aiMarks } = useWb();
  const v = item?.[spec.key];
  const p = [...path, spec.key];
  const marked = aiTouched(aiMarks, p);
  const set = (x: unknown) => ops.set(p, x);
  const box = React.useRef<HTMLDivElement>(null);
  // the label is plain text (so the hint stays out of the control's accessible name); clicking it still focuses the control
  const focus = () =>
    box.current
      ?.querySelector<HTMLElement>(
        "input,textarea,.arco-select-view,.arco-switch",
      )
      ?.focus();
  const opts =
    typeof spec.options === "function" ? spec.options(item) : spec.options;
  let control: React.ReactNode;
  switch (spec.kind) {
    case "bool":
      control = (
        <Switch
          checked={!!v}
          disabled={readOnly}
          onChange={set}
          aria-label={spec.label}
        />
      );
      break;
    case "number":
      control = (
        <InputNumber
          size="default"
          hideControl
          disabled={readOnly}
          value={typeof v === "number" ? v : undefined}
          min={spec.min}
          max={spec.max}
          placeholder={spec.placeholder}
          onChange={(x) => set(x === undefined || x === null ? undefined : x)}
          aria-label={spec.label}
        />
      );
      break;
    case "select":
      control = (
        <Select
          disabled={readOnly}
          allowClear={!spec.required}
          value={v === undefined || v === null ? undefined : String(v)}
          placeholder={spec.placeholder || bi("请选择", "Select")}
          options={opts}
          onChange={(x) => set(x)}
          aria-label={spec.label}
        />
      );
      break;
    case "multi":
      control = (
        <Select
          mode="multiple"
          disabled={readOnly}
          allowClear
          value={Array.isArray(v) ? v : []}
          placeholder={spec.placeholder || bi("请选择", "Select")}
          options={opts}
          onChange={(x) => set(x)}
          aria-label={spec.label}
        />
      );
      break;
    case "tags":
      control = (
        <InputTag
          disabled={readOnly}
          allowClear
          saveOnBlur
          value={Array.isArray(v) ? v.map(String) : []}
          placeholder={spec.placeholder || bi("输入后回车", "Type and press Enter")}
          onChange={(x) => set(x.length ? x : undefined)}
          aria-label={spec.label}
        />
      );
      break;
    case "area":
      control = (
        <Input.TextArea
          disabled={readOnly}
          autoSize={{ minRows: 2, maxRows: 8 }}
          value={v == null ? "" : String(v)}
          placeholder={spec.placeholder}
          onChange={set}
          aria-label={spec.label}
        />
      );
      break;
    case "expr":
      control = (
        <>
          <Input
            className="wb-mono"
            disabled={readOnly}
            allowClear
            value={v == null ? "" : String(v)}
            placeholder={spec.placeholder || bi("例如 params.replicas > 0", "e.g. params.replicas > 0")}
            onChange={set}
            aria-label={spec.label}
          />
          <ExprChips
            params={params}
            roles={roles}
            onPick={(s) =>
              set(`${v == null ? "" : String(v)}${v ? " " : ""}${s}`)
            }
          />
        </>
      );
      break;
    default:
      control = (
        <Input
          className={spec.kind === "mono" ? "wb-mono" : undefined}
          disabled={readOnly}
          allowClear
          value={v == null ? "" : String(v)}
          placeholder={spec.placeholder}
          onChange={(x) => set(spec.loose ? looseValue(x) : x)}
          aria-label={spec.label}
        />
      );
  }
  return (
    <div
      className={`wb-field w-${spec.width || "m"} ${spec.kind === "bool" ? "bool" : ""}`}
      ref={box}
      data-wb={p.join(".")}
      data-wb-ai={marked ? "" : undefined}
    >
      <span className="wb-flabel" onClick={focus}>
        {spec.label}
        {spec.required && <i className="req">{bi("必填", "Required")}</i>}
      </span>
      {control}
      {spec.hint && <span className="wb-fhint">{spec.hint}</span>}
    </div>
  );
}

/** Variables an expression may use, one click each. */
function ExprChips({
  params,
  roles,
  onPick,
}: {
  params: { key: string }[];
  roles: string[];
  onPick: (s: string) => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const items = [
    ...params.map((x) => `params.${x.key}`),
    ...roles.map((r) => `count(roles.${r})`),
    "version",
  ];
  if (!items.length) return null;
  return (
    <span className="wb-chips">
      <button
        type="button"
        className="wb-chips-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? <IconDown /> : <IconRight />} {bi("可用变量", "Available variables")}
      </button>
      {open && (
        <span className="wb-chips-list">
          {items.map((s) => (
            <button
              type="button"
              key={s}
              className="wb-chip mono"
              onClick={() => onPick(s)}
            >
              {s}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function Fields({
  specs,
  path,
  item,
}: {
  specs: FieldSpec[];
  path: Path;
  item: any;
}) {
  return (
    <div className="wb-grid">
      {specs
        .filter((s) => !s.show || s.show(item))
        .map((s) => (
          <Field key={s.key} spec={s} path={path} item={item} />
        ))}
    </div>
  );
}

/* ---------- lists ---------- */

export type ListProps = {
  /** Where the list lives in the manifest. */
  path: Path;
  fields: FieldSpec[];
  /** The collapsed row: a short title and a quiet detail. */
  head: (
    item: any,
    i: number,
  ) => { title: React.ReactNode; sub?: React.ReactNode; tag?: React.ReactNode };
  blank: () => Record<string, unknown>;
  noun: string;
  empty?: string;
  /** Extra controls inside an opened item, after its fields. */
  extra?: (item: any, itemPath: Path, i: number) => React.ReactNode;
  /** Problems for item i (matched by the caller's path rule). */
  flagged?: (item: any, i: number) => number;
  defaultOpen?: boolean;
  visibleIndex?: number;
  onAdded?: (index: number) => void;
  /** Items are shown in this order of keys when created; ids are made unique with this key. */
  idKey?: string;
};

export function ListEditor(p: ListProps) {
  useLang();
  const { ops, readOnly, aiMarks } = useWb();
  const items: any[] = get(ops.js, p.path) || [];
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const scrolled = React.useRef(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const dragCleanupRef = React.useRef<(() => void) | null>(null);
  const suppressClickRef = React.useRef(false);
  const canDrag = !readOnly && items.length > 1 && p.visibleIndex === undefined;

  React.useEffect(() => () => dragCleanupRef.current?.(), []);

  const startDrag = (e: React.PointerEvent<HTMLButtonElement>, fromIdx: number) => {
    if (e.button !== 0 || !canDrag) return;
    const listEl = listRef.current;
    if (!listEl) return;
    const nodes = Array.from(listEl.querySelectorAll<HTMLElement>(":scope > .wb-item"));
    const dragNode = nodes[fromIdx];
    if (!dragNode) return;
    e.preventDefault();
    e.stopPropagation();
    dragCleanupRef.current?.();

    const rects = nodes.map((n) => n.getBoundingClientRect());
    const startY = e.clientY;
    let latestY = startY;
    let rafId = 0;
    let moved = false;
    let targetIdx = fromIdx;

    dragNode.classList.add("is-dragging");
    document.body.classList.add("is-dragging-item");

    const renderFrame = () => {
      rafId = 0;
      const dy = latestY - startY;
      if (!moved && Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      dragNode.style.transform = `translate3d(0, ${Math.round(dy)}px, 0)`;
      nodes.forEach((n) => n.classList.remove("drop-before", "drop-after"));
      let next = fromIdx;
      if (dy < 0) {
        for (let k = 0; k < fromIdx; k++) {
          if (latestY < rects[k].top + rects[k].height * 0.5) {
            next = k;
            break;
          }
        }
      } else if (dy > 0) {
        for (let k = nodes.length - 1; k > fromIdx; k--) {
          if (latestY > rects[k].top + rects[k].height * 0.5) {
            next = k;
            break;
          }
        }
      }
      targetIdx = next;
      if (next < fromIdx) nodes[next]?.classList.add("drop-before");
      else if (next > fromIdx) nodes[next]?.classList.add("drop-after");
    };

    const onMove = (ev: PointerEvent) => {
      latestY = ev.clientY;
      if (!rafId) rafId = window.requestAnimationFrame(renderFrame);
    };

    const clearVisuals = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      dragNode.style.transform = "";
      nodes.forEach((n) => n.classList.remove("is-dragging", "drop-before", "drop-after"));
      document.body.classList.remove("is-dragging-item");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      if (dragCleanupRef.current === clearVisuals) dragCleanupRef.current = null;
    };

    const onUp = () => {
      clearVisuals();
      if (moved) {
        suppressClickRef.current = true;
        window.requestAnimationFrame(() => {
          suppressClickRef.current = false;
        });
        if (targetIdx !== fromIdx) {
          setOpen((prev) => {
            const nextOpen: Record<number, boolean> = {};
            const order = items.map((_, idx) => idx);
            const [picked] = order.splice(fromIdx, 1);
            order.splice(targetIdx, 0, picked);
            order.forEach((oldIdx, newIdx) => {
              if (prev[oldIdx] !== undefined) nextOpen[newIdx] = prev[oldIdx];
            });
            return nextOpen;
          });
          ops.move(p.path, fromIdx, targetIdx);
        }
      }
    };

    const onCancel = () => {
      clearVisuals();
    };

    dragCleanupRef.current = clearVisuals;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
  };

  const unique = (item: Record<string, unknown>) => {
    if (!p.idKey) return item;
    const base = String(item[p.idKey] || p.noun);
    let n = 1,
      id = base;
    const taken = new Set(items.map((x) => String(x?.[p.idKey!])));
    while (taken.has(id)) id = `${base}-${++n}`;
    return { ...item, [p.idKey]: id };
  };
  const add = () => {
    ops.add(p.path, unique(p.blank()));
    setOpen((o) => ({ ...o, [items.length]: true }));
    p.onAdded?.(items.length);
  };
  return (
    <div className="wb-list" ref={listRef}>
      {items.length === 0 && (
        <div className="wb-empty">
          {p.empty || bi(`还没有${p.noun}`, `No ${p.noun.toLowerCase()} yet`)}
        </div>
      )}
      {items.map((item, i) => {
        if (p.visibleIndex !== undefined && p.visibleIndex !== i) return null;
        const h = p.head(item, i);
        const flags = p.flagged?.(item, i) || 0;
        const ip = [...p.path, i];
        const marked = aiTouched(aiMarks, ip);
        const on = open[i] ?? (!!p.defaultOpen || flags > 0 || marked);
        return (
          <div
            className={`wb-item ${on ? "on" : ""} ${flags ? "flagged" : ""}`}
            key={i}
            data-wb={ip.join(".")}
            data-wb-ai={marked ? "" : undefined}
            ref={
              flags && !scrolled.current
                ? (el) => {
                    if (el) {
                      scrolled.current = true;
                      el.scrollIntoView({
                        block: "center",
                        behavior: "smooth",
                      });
                    }
                  }
                : undefined
            }
          >
            <div className="wb-item-head">
              {canDrag && (
                <button
                  type="button"
                  className="wb-drag-handle"
                  aria-label={bi("拖拽调整顺序", "Drag to reorder")}
                  title={bi("按住上下拖拽调整顺序", "Drag up or down to reorder")}
                  onPointerDown={(e) => startDrag(e, i)}
                  onClick={(e) => e.preventDefault()}
                >
                  <svg width={12} height={12} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                    <circle cx="4" cy="2.5" r="1.1" />
                    <circle cx="8" cy="2.5" r="1.1" />
                    <circle cx="4" cy="6" r="1.1" />
                    <circle cx="8" cy="6" r="1.1" />
                    <circle cx="4" cy="9.5" r="1.1" />
                    <circle cx="8" cy="9.5" r="1.1" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                className="wb-item-toggle"
                aria-expanded={on}
                onClick={(e) => {
                  if (suppressClickRef.current) {
                    e.preventDefault();
                    return;
                  }
                  setOpen((o) => ({ ...o, [i]: !on }));
                }}
              >
                <span className="wb-caret">
                  {on ? <IconDown /> : <IconRight />}
                </span>
                <span className="wb-item-title">{h.title}</span>
                {h.tag && <span className="wb-item-tag">{h.tag}</span>}
                {h.sub && <span className="wb-item-sub">{h.sub}</span>}
                {flags > 0 && <span className="wb-flag">{flags}</span>}
              </button>
              {!readOnly && (
                <span className="wb-item-actions">
                  <Tooltip content={bi("上移", "Move up")}>
                    <Button
                      size="mini"
                      type="text"
                      aria-label={bi("上移", "Move up")}
                      disabled={i === 0}
                      icon={<IconArrowUp />}
                      onClick={() => ops.move(p.path, i, i - 1)}
                    />
                  </Tooltip>
                  <Tooltip content={bi("下移", "Move down")}>
                    <Button
                      size="mini"
                      type="text"
                      aria-label={bi("下移", "Move down")}
                      disabled={i === items.length - 1}
                      icon={<IconArrowDown />}
                      onClick={() => ops.move(p.path, i, i + 1)}
                    />
                  </Tooltip>
                  <Tooltip content={bi("复制", "Duplicate")}>
                    <Button
                      size="mini"
                      type="text"
                      aria-label={bi("复制", "Duplicate")}
                      icon={<IconCopy />}
                      onClick={() => {
                        ops.add(
                          p.path,
                          unique(JSON.parse(JSON.stringify(item))),
                          i + 1,
                        );
                        setOpen((o) => ({ ...o, [i + 1]: true }));
                      }}
                    />
                  </Tooltip>
                  <Tooltip content={bi("删除", "Delete")}>
                    <Button
                      size="mini"
                      type="text"
                      status="danger"
                      aria-label={bi("删除", "Delete")}
                      icon={<IconDelete />}
                      onClick={() => ops.remove(p.path, i)}
                    />
                  </Tooltip>
                </span>
              )}
            </div>
            {on && (
              <div className="wb-item-body">
                <Fields specs={p.fields} path={ip} item={item} />
                {p.extra?.(item, ip, i)}
              </div>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <Button
          className="wb-add"
          long
          type="outline"
          icon={<IconPlus />}
          onClick={add}
        >
          {bi(`添加${p.noun}`, `Add ${p.noun}`)}
        </Button>
      )}
    </div>
  );
}

/** A section of a tab: a title, one line of help, then content. */
export function Section({
  title,
  help,
  actions,
  children,
  id,
}: {
  title: string;
  help?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section className="wb-section" id={id}>
      <header>
        <div>
          <h2>{title}</h2>
          {help && <p>{help}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/** A plain key/value map editor (step vars, preset params). Values are typed loosely: 3 is a number, true a bool. */
export function MapEditor({
  path,
  value,
  keyLabel,
  valueLabel,
}: {
  path: Path;
  value: Record<string, unknown> | undefined;
  keyLabel?: string;
  valueLabel?: string;
}) {
  useLang();
  const kLabel = keyLabel ?? bi("名称", "Name");
  const vLabel = valueLabel ?? bi("值", "Value");
  const { ops, readOnly } = useWb();
  const fromValue = () =>
    Object.entries(value || {}).map(([k, v]) => [k, v] as [string, unknown]);
  const [rows, setRows] = useState<[string, unknown][]>(fromValue);
  const written = React.useRef(JSON.stringify(value || {}));
  // A change from elsewhere (source tab, restore) replaces the rows; our own writes do not.
  React.useEffect(() => {
    const now = JSON.stringify(value || {});
    if (now !== written.current) {
      written.current = now;
      setRows(fromValue());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const write = (next: [string, unknown][]) => {
    setRows(next);
    const o: Record<string, unknown> = {};
    next.forEach(([k, v]) => {
      if (k) o[k] = v;
    });
    written.current = JSON.stringify(o);
    ops.set(path, Object.keys(o).length ? o : undefined);
  };
  return (
    <div className="wb-map">
      {rows.map(([k, v], i) => (
        <div className="wb-map-row" key={i}>
          <Input
            disabled={readOnly}
            className="wb-mono"
            value={k}
            placeholder={kLabel}
            onChange={(x) =>
              write(rows.map((e, j) => (j === i ? [x, e[1]] : e)))
            }
          />
          <Input
            disabled={readOnly}
            className="wb-mono"
            value={isEmpty(v) && v !== 0 && v !== false ? "" : String(v)}
            placeholder={vLabel}
            onChange={(x) =>
              write(rows.map((e, j) => (j === i ? [e[0], looseValue(x)] : e)))
            }
          />
          {!readOnly && (
            <Button
              size="mini"
              type="text"
              status="danger"
              aria-label={bi("删除", "Delete")}
              icon={<IconDelete />}
              onClick={() => write(rows.filter((_, j) => j !== i))}
            />
          )}
        </div>
      ))}
      {!readOnly && (
        <Button
          size="mini"
          type="text"
          icon={<IconPlus />}
          onClick={() => write([...rows, ["", ""]])}
        >
          {bi("添加", "Add")}
        </Button>
      )}
    </div>
  );
}

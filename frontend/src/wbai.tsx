import React, { useState } from "react";
import { Button } from "@arco-design/web-react";
import { IconUndo } from "@arco-design/web-react/icon";
import { parse } from "yaml";
import { Spark } from "./aichat";

/* What the component assistant changed when its proposal was accepted, in the words of the workbench's forms: which
   tab, which item, from what to what. The workbench walks the person through it the way the new-delivery form does
   (each tab opened in turn, each field lit up as it is reached), keeps the places marked, and asks for one
   confirmation — or puts everything back. */

export type AIChange = {
  /** The place in the manifest ("params.3.default"), or a file path for other files. */
  path: string;
  file: string;
  tab: string;
  label: string;
  op: "add" | "remove" | "change";
  from?: string;
  to?: string;
};

const NAMES: Record<string, string> = {
  title: "显示名",
  summary: "简介",
  tags: "标签",
  provides: "提供的能力",
  detail: "详细说明",
  roles: "角色",
  flows: "数据流",
  groups: "参数分组",
  params: "参数",
  rules: "规则",
  ports: "端口",
  endpoints: "入口",
  secrets: "密钥",
  inputs: "上传项",
  requires: "依赖",
  versions: "版本",
  packages: "软件包",
  lifecycle: "部署步骤",
  shared_files: "公共依赖文件",
  tests: "测试",
  cleanup: "清理",
  addons: "附加项",
  scope: "挂接对象",
  defaults: "默认对象",
  lb: "负载均衡",
  default: "默认值",
  label: "名称",
  hint: "说明",
  min: "最小值",
  max: "最大值",
  status: "状态",
  includes: "包含",
  features: "特性",
};
const SKIP = new Set(["items", "detail"]);

const idOf = (x: unknown): string | undefined => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return undefined;
  const o = x as Record<string, unknown>;
  const v = o.id ?? o.key ?? o.name;
  return v === undefined || v === null ? undefined : String(v);
};
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const show = (v: unknown) => {
  if (v === undefined) return "";
  if (isObj(v) && (v.title || idOf(v))) return String(v.title || idOf(v));
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 78) + "…" : s;
};

type Raw = {
  path: (string | number)[];
  op: AIChange["op"];
  from?: unknown;
  to?: unknown;
};

function walk(a: unknown, b: unknown, path: (string | number)[], out: Raw[]) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const keyed =
      a.length + b.length > 0 &&
      a.every((x) => idOf(x) !== undefined) &&
      b.every((x) => idOf(x) !== undefined);
    if (keyed) {
      const old = new Map(a.map((x) => [idOf(x)!, x]));
      b.forEach((x, i) => {
        const id = idOf(x)!;
        if (!old.has(id)) out.push({ path: [...path, i], op: "add", to: x });
        else walk(old.get(id), x, [...path, i], out);
        old.delete(id);
      });
      old.forEach((x) => out.push({ path, op: "remove", from: x }));
      return;
    }
    if ([...a, ...b].every((x) => typeof x !== "object")) {
      out.push({ path, op: "change", from: a, to: b });
      return;
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      walk(a[i], b[i], [...path, i], out);
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
      walk(a[k], b[k], [...path, k], out);
    return;
  }
  out.push({
    path,
    op: a === undefined ? "add" : b === undefined ? "remove" : "change",
    from: a,
    to: b,
  });
}

/** A place in the manifest in the words a person would use: 附加项 · pgcrypto · 显示名. */
function labelOf(path: (string | number)[], a: unknown, b: unknown) {
  const parts: string[] = [];
  let x: unknown = b;
  let y: unknown = a;
  path.forEach((seg, i) => {
    const nx =
      x == null ? undefined : (x as Record<string, unknown>)[seg as never];
    const ny =
      y == null ? undefined : (y as Record<string, unknown>)[seg as never];
    if (typeof seg === "number") {
      const id = idOf(nx) ?? idOf(ny);
      // a version's own settings: say which version
      if (path[i - 1] === "versions") parts.push(`${id ?? seg} 版`);
      else parts.push(id ?? `第 ${seg + 1} 项`);
    } else if (!SKIP.has(seg)) parts.push(NAMES[seg] || seg);
    x = nx;
    y = ny;
  });
  return parts.join(" · ") || "组件清单";
}

/** Every change between two drafts: the manifest field by field, other files as a whole. */
export function diffDrafts(
  before: Record<string, string>,
  after: Record<string, string>,
  tabOf: (path: (string | number)[]) => string,
): AIChange[] {
  const out: AIChange[] = [];
  const a = before["component.yaml"];
  const b = after["component.yaml"];
  if (a !== b) {
    let ja: unknown, jb: unknown;
    try {
      ja = parse(a || "");
      jb = parse(b || "");
    } catch {
      ja = jb = undefined;
    }
    if (ja !== undefined && jb !== undefined) {
      const raw: Raw[] = [];
      walk(ja, jb, [], raw);
      for (const r of raw)
        out.push({
          path: r.path.join("."),
          file: "component.yaml",
          tab: tabOf(r.path),
          label: labelOf(r.path, ja, jb),
          op: r.op,
          from: show(r.from),
          to: show(r.to),
        });
    } else
      out.push({
        path: "component.yaml",
        file: "component.yaml",
        tab: "source",
        label: "组件清单",
        op: "change",
      });
  }
  for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (f === "component.yaml" || before[f] === after[f]) continue;
    out.push({
      path: f,
      file: f,
      tab: "files",
      label: f,
      op:
        before[f] === undefined
          ? "add"
          : after[f] === undefined
            ? "remove"
            : "change",
    });
  }
  return out;
}

const OP: Record<string, string> = {
  add: "新增",
  remove: "删除",
  change: "修改",
};

/** The workbench while the assistant's change is being looked at: the conversation, then each part it touched (done,
 *  being shown, still to come), and one confirmation — the way the new-delivery form shows the assistant's work. */
export function AIStage({
  changes,
  tabTitle,
  playing,
  current,
  shown,
  onTab,
  onChat,
  onUndo,
  onConfirm,
  onReplay,
  onAll,
}: {
  changes: AIChange[];
  tabTitle: (t: string) => string;
  playing: boolean;
  /** The part being shown now. */
  current: string;
  /** Parts already walked through. */
  shown: Set<string>;
  onTab: (t: string) => void;
  onChat: () => void;
  onUndo: () => void;
  onConfirm: () => void;
  onReplay: () => void;
  onAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const tabs = [...new Set(changes.map((c) => c.tab))];
  const done = tabs.filter((t) => shown.has(t)).length;
  return (
    <div
      className={`wb-stage ${playing ? "playing" : ""}`}
      role="group"
      aria-label="AI 的改动"
    >
      <div className="wb-stage-row">
        <button type="button" className="wb-stage-chat" onClick={onChat}>
          <Spark size={14} rainbow />
          AI 对话
        </button>
        <span className="wb-stage-sep" aria-hidden />
        <nav className="wb-stage-tabs" aria-label="AI 改动的部分">
          {tabs.map((t, i) => {
            const st = t === current ? "now" : shown.has(t) ? "done" : "todo";
            return (
              <button
                key={t}
                type="button"
                className={`wb-stage-tab ${st}`}
                aria-current={t === current ? "step" : undefined}
                onClick={() => onTab(t)}
              >
                <span className="wb-stage-mark" aria-hidden>
                  {st === "done" ? "✓" : st === "now" ? "" : i + 1}
                </span>
                {tabTitle(t)}
                <em>{changes.filter((c) => c.tab === t).length}</em>
              </button>
            );
          })}
        </nav>
        <button type="button" className="wb-stage-all" onClick={onAll}>
          全部页签
        </button>
      </div>
      <div className="wb-stage-row sub">
        <b className="wb-stage-status">
          {playing
            ? `AI 正在写入 · ${done}/${tabs.length}`
            : `AI 改了 ${changes.length} 处，确认后才算定稿；也可以直接在下面接着改`}
        </b>
        <button
          type="button"
          className="wb-aicard-more"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? "收起清单" : "看改了什么"}
        </button>
        {!playing && (
          <button type="button" className="wb-aicard-more" onClick={onReplay}>
            再演示一遍
          </button>
        )}
        <span className="wb-aicard-btns">
          <Button
            size="small"
            icon={<IconUndo />}
            disabled={playing}
            onClick={onUndo}
          >
            撤销
          </Button>
          <Button
            size="small"
            type="primary"
            disabled={playing}
            onClick={onConfirm}
          >
            确认
          </Button>
        </span>
      </div>
      {open && (
        <ul className="wb-aicard-list">
          {changes.map((c, i) => (
            <li key={i}>
              <span className={`wb-aiop ${c.op}`}>{OP[c.op]}</span>
              <button
                type="button"
                className="link"
                onClick={() => onTab(c.tab)}
              >
                {c.label}
              </button>
              {c.op === "change" &&
                c.from !== undefined &&
                c.to !== undefined &&
                c.from !== "" && (
                  <span className="wb-aival">
                    <s>{c.from}</s> → <b>{c.to}</b>
                  </span>
                )}
              {c.op === "add" && c.to && (
                <span className="wb-aival">
                  <b>{c.to}</b>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

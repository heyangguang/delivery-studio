import { createContext, useContext } from "react";
import { Document, isMap, isSeq, parseDocument } from "yaml";

/* The manifest is edited as a YAML Document, not as plain objects: every form change touches only the node it is
   about, so the author's comments, ordering and flow-style lines (`- {key: a, label: b}`) survive a round trip. */

export type Path = (string | number)[];
export type Doc = Document.Parsed;

export const parseManifest = (text: string): Doc =>
  parseDocument(text, { keepSourceTokens: false });

/** A value is "empty" when writing it would only add noise to the file. */
export const isEmpty = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === "" ||
  v === false ||
  (typeof v === "number" && Number.isNaN(v)) ||
  (Array.isArray(v) && v.length === 0);

/** Run a change against a fresh parse of the text and return the new text. */
export function change(text: string, fn: (d: Doc) => void): string {
  const d = parseManifest(text);
  if (d.errors.length) return text;
  fn(d);
  return d.toString({ lineWidth: 0, indent: 2, flowCollectionPadding: false });
}

/** The order the manifest's top-level keys are written in; a new key goes before the first existing key that follows it. */
const TOP_ORDER = [
  "schema",
  "component",
  "short",
  "title",
  "category",
  "icon",
  "color",
  "summary",
  "tags",
  "kind",
  "provides",
  "data_volume",
  "detail",
  "roles",
  "flows",
  "groups",
  "params",
  "rules",
  "ports",
  "endpoints",
  "secrets",
  "inputs",
  "requires",
  "versions",
  "shared_files",
  "lifecycle",
  "changes",
  "tests",
  "cleanup",
  "addons",
  "lb",
];

export function setValue(d: Doc, path: Path, value: unknown) {
  if (value === false && d.hasIn(path)) {
    // an existing switch stays in place when turned off, so the file does not reshuffle
    d.setIn(path, false);
    return;
  }
  if (isEmpty(value)) {
    if (d.hasIn(path)) d.deleteIn(path);
    // An emptied map or list that was only there for this value goes too, so the file stays tidy.
    for (let n = path.length - 1; n >= 1; n--) {
      const parent = d.getIn(path.slice(0, n), true);
      if (
        (isMap(parent) && parent.items.length === 0) ||
        (isSeq(parent) && parent.items.length === 0)
      )
        d.deleteIn(path.slice(0, n));
      else break;
    }
    return;
  }
  let node: unknown = value;
  if (Array.isArray(value) && value.every((x) => typeof x !== "object")) {
    // a short list of plain values reads best on one line, as the manifests write them
    const n = d.createNode(value) as { flow?: boolean };
    n.flow = true;
    node = n;
  }
  if (path.length === 1 && !d.hasIn(path) && isMap(d.contents)) {
    const key = String(path[0]);
    const at = TOP_ORDER.indexOf(key);
    const items = d.contents.items;
    let idx = items.length;
    if (at >= 0) {
      const next = items.findIndex(
        (it) =>
          TOP_ORDER.indexOf(String((it.key as { value?: unknown })?.value)) >
          at,
      );
      if (next >= 0) idx = next;
    }
    items.splice(idx, 0, d.createPair(key, node) as never);
    return;
  }
  d.setIn(path, node);
}

export function addItem(d: Doc, path: Path, item: unknown, at?: number) {
  const seq = d.getIn(path, true);
  const node = d.createNode(item) as { flow?: boolean };
  if (isSeq(seq)) {
    const first = seq.items[0] as { flow?: boolean } | undefined;
    if (first && isMap(first as never)) node.flow = !!first.flow;
    else if (!first && typeof item === "object") node.flow = false;
    if (at === undefined || at >= seq.items.length) seq.add(node as never);
    else seq.items.splice(at, 0, node as never);
    return;
  }
  const created = d.createNode([item]);
  d.setIn(path, created);
}

export function removeItem(d: Doc, path: Path, i: number) {
  d.deleteIn([...path, i]);
  const seq = d.getIn(path, true);
  if (isSeq(seq) && seq.items.length === 0) setValue(d, path, undefined);
}

export function moveItem(d: Doc, path: Path, from: number, to: number) {
  const seq = d.getIn(path, true);
  if (!isSeq(seq) || to < 0 || to >= seq.items.length) return;
  const [x] = seq.items.splice(from, 1);
  seq.items.splice(to, 0, x);
}

export type Ops = {
  js: any;
  broken: string;
  set: (path: Path, value: unknown) => void;
  add: (path: Path, item: unknown, at?: number) => void;
  remove: (path: Path, i: number) => void;
  move: (path: Path, from: number, to: number) => void;
  /** Several changes as one edit (and one undo step in the saved draft). */
  batch: (fn: (d: Doc) => void) => void;
};

export type Problem = {
  severity: "error" | "warning";
  file?: string;
  line?: number;
  path?: string;
  message: string;
};

export type WbCtx = {
  ops: Ops;
  files: string[];
  problems: Problem[];
  roles: string[];
  groups: { id: string; label: string }[];
  params: { key: string; label: string; type: string }[];
  versions: string[];
  platforms: { id: string; title: string }[];
  openFile: (path: string, line?: number) => void;
  /** Every task file as role → names, for step pickers. */
  tasks: Record<string, string[]>;
  readOnly: boolean;
  /** Places in the manifest the assistant just changed ("params.3.default"), marked until the person confirms. */
  aiMarks?: string[];
  /** Sets a warning aside ("看过了，没问题") or takes that back. */
  ignoreWarning?: (p: Problem, undo?: boolean) => void;
  /** Files the assistant just changed. */
  aiFiles?: string[];
};

/** Whether a place in the manifest, or anything under it, was just changed by the assistant. */
export const aiTouched = (marks: string[] | undefined, path: Path) => {
  if (!marks?.length) return false;
  const k = path.join(".");
  // the place itself or something inside it; a whole new item is marked once, on the item, not on each of its fields
  return marks.some((m) => m === k || m.startsWith(k + "."));
};

export const Wb = createContext<WbCtx>(null as never);
export const useWb = () => useContext(Wb);

export const get = (obj: any, path: Path): any =>
  path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Problems whose manifest path starts with a prefix (versions[3.5].params... also matches under "params"). */
export function problemsFor(
  problems: Problem[],
  match: (p: string) => boolean,
) {
  return problems.filter(
    (x) => x.file === "component.yaml" && x.path && match(x.path),
  );
}

const tokens = (path: string) => path.split(/[.[\]]/).filter(Boolean);
/** How many problems are about one list item: its path holds the section tokens followed by the item's key. */
export function itemFlags(
  problems: Problem[],
  section: string[],
  key: string,
): number {
  if (!key) return 0;
  const want = [...section, key];
  return problems.filter((x) => {
    if (x.file !== "component.yaml" || !x.path) return false;
    const t = tokens(x.path);
    for (let i = 0; i + want.length <= t.length; i++)
      if (want.every((w, j) => t[i + j] === w)) return true;
    return false;
  }).length;
}

import React, { useState } from "react";
import { Message } from "@arco-design/web-react";
import katex from "katex";
import "katex/dist/katex.min.css";
import {
  IconCheck,
  IconCopy,
  IconDownload,
  IconSave,
} from "@arco-design/web-react/icon";
import { api, copy, err, toPasteSafeShell } from "./shared";
import { bi, useLang } from "./i18n";
import { uploadFiles } from "./myfiles";
import type { FileNode } from "./myfiles";

/* The Markdown the assistant writes: headings, paragraphs, nested lists, tables, quotes, rules, fenced code with a copy
   button, and inline code, bold, italic and links. Everything becomes React nodes; no HTML from the model is trusted. */

type Block =
  | { t: "code"; lang: string; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "quote"; text: string }
  | { t: "hr" }
  | { t: "math"; text: string }
  | {
      t: "table";
      head: string[];
      rows: string[][];
      align: (string | undefined)[];
    }
  | {
      t: "list";
      ordered: boolean;
      start: number;
      items: { text: string; children: Block[] }[];
    };

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/(^|[^\\])\|$/, "$1")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
const aligns = (l: string) =>
  cells(l).map((c) =>
    /^:-+:$/.test(c)
      ? "center"
      : /-+:$/.test(c)
        ? "right"
        : /^:-+/.test(c)
          ? "left"
          : undefined,
  );

function parseList(lines: string[], i: number): [Block, number] {
  const first = LIST.exec(lines[i])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: { text: string; children: Block[] }[] = [];
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m) {
      // a continuation line of the last item, indented under it
      if (
        items.length &&
        lines[i].trim() &&
        /^\s+/.test(lines[i]) &&
        lines[i].search(/\S/) > indent
      ) {
        items[items.length - 1].text += "\n" + lines[i].trim();
        i++;
        continue;
      }
      break;
    }
    const ind = m[1].length;
    if (ind < indent) break;
    if (ind > indent) {
      const [sub, next] = parseList(lines, i);
      if (items.length) items[items.length - 1].children.push(sub);
      i = next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    items.push({ text: m[3], children: [] });
    i++;
  }
  return [
    {
      t: "list",
      ordered,
      start: ordered ? parseInt(first[2], 10) || 1 : 1,
      items,
    },
    i,
  ];
}

export function parseMd(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(l);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1]))
        body.push(lines[i++]);
      i++; // the closing fence; an unclosed one (still streaming) just ends the text
      out.push({ t: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    // a formula on its own lines: \[ … \] or $$ … $$ (possibly all on one line)
    const mathOpen = /^\s*(\\\[|\$\$)(.*)$/.exec(l);
    if (mathOpen) {
      const close = mathOpen[1] === "$$" ? "$$" : "\\]";
      const body: string[] = [];
      let rest = mathOpen[2];
      i++;
      for (;;) {
        const at = rest.indexOf(close);
        if (at >= 0) {
          body.push(rest.slice(0, at));
          break;
        }
        body.push(rest);
        if (i >= lines.length) break;
        rest = lines[i++];
      }
      out.push({ t: "math", text: body.join("\n").trim() });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      out.push({
        t: "h",
        level: h[1].length,
        text: h[2].replace(/\s*#+\s*$/, ""),
      });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^\s*\|/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const head = cells(l);
      const align = aligns(lines[i + 1]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i]))
        rows.push(cells(lines[i++]));
      out.push({ t: "table", head, rows, align });
      continue;
    }
    if (/^\s*>/.test(l)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", text: body.join("\n") });
      continue;
    }
    if (LIST.test(l)) {
      const [b, next] = parseList(lines, i);
      out.push(b);
      i = next;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !LIST.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*(```|~~~|>|\\\[|\$\$)/.test(lines[i]) &&
      !(/^\s*\|/.test(lines[i]) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || ""))
    )
      para.push(lines[i++]);
    out.push({ t: "p", text: para.join("\n") });
  }
  return out;
}

const INLINE =
  /(`[^`\n]+`|\\\([^\n]+?\\\)|\$\$[^\n]+?\$\$|\$[^\s$](?:[^$\n]*?[^\s$])?\$(?!\d)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\s][^*\n]*\*|\[[^\]\n]+\]\(\s*\/(?:out|in|tmp)\/[^)\n]*\)|!?\[[^\]\n]*\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)<>，。；）]+)/g;

/** A formula as HTML (KaTeX, bundled with the page). A formula it cannot read stays as the text that was written. */
export const Tex = React.memo(function Tex({
  src,
  block,
}: {
  src: string;
  block?: boolean;
}) {
  const html = React.useMemo(() => {
    try {
      return katex.renderToString(src, {
        displayMode: !!block,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        maxExpand: 500,
        output: "html",
      });
    } catch {
      return "";
    }
  }, [src, block]);
  if (!html)
    return block ? (
      <pre className="md-math-raw">{src}</pre>
    ) : (
      <code className="md-math-raw">{src}</code>
    );
  return block ? (
    <div className="md-math block" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="md-math" dangerouslySetInnerHTML={{ __html: html }} />
  );
});

export const Inline = React.memo(function Inline({ text }: { text: string }) {
  useLang();
  const parts = text.split(INLINE);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) {
          const lines = p.split("\n");
          return lines.map((ln, k) => (
            <React.Fragment key={`${i}-${k}`}>
              {k > 0 && <br />}
              {ln}
            </React.Fragment>
          ));
        }
        if (p.startsWith("\\(")) return <Tex key={i} src={p.slice(2, -2)} />;
        if (p.startsWith("$$")) return <Tex key={i} src={p.slice(2, -2)} />;
        if (p.startsWith("$")) return <Tex key={i} src={p.slice(1, -1)} />;
        if (/^\[[^\]]+\]\(\s*\/(?:out|in|tmp)\//.test(p))
          return <strong key={i}>{p.slice(1, p.indexOf("]"))}</strong>; // a path inside the sandbox is not a link anyone can open
        if (p.startsWith("~~")) return <del key={i}>{p.slice(2, -2)}</del>;
        if (p.startsWith("![")) {
          const im = /^!\[([^\]]*)\]\((.+)\)$/.exec(p);
          return (
            <a
              key={i}
              href={im?.[2]}
              target="_blank"
              rel="noreferrer noopener"
              className="md-img-link"
            >
              {im?.[1] || bi("图片", "Image")}
              {bi("（图片，点开查看）", " (image, click to view)")}
            </a>
          );
        }
        if (p.startsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
        if (p.startsWith("**") || p.startsWith("__"))
          return (
            <strong key={i}>
              <Inline text={p.slice(2, -2)} />
            </strong>
          );
        if (p.startsWith("*"))
          return (
            <em key={i}>
              <Inline text={p.slice(1, -1)} />
            </em>
          );
        const link = /^\[([^\]]+)\]\((.+)\)$/.exec(p);
        const url = link ? link[2] : p;
        return (
          <a key={i} href={url} target="_blank" rel="noreferrer noopener">
            {link ? link[1] : p}
          </a>
        );
      })}
    </>
  );
});

const LANG: Record<string, string> = {
  bash: "Shell",
  sh: "Shell",
  shell: "Shell",
  get console() {
    return bi("终端", "Terminal");
  },
  yaml: "YAML",
  yml: "YAML",
  json: "JSON",
  sql: "SQL",
  ini: "INI",
  get conf() {
    return bi("配置", "Config");
  },
  jinja: "Jinja",
  j2: "Jinja",
  python: "Python",
  py: "Python",
  get diff() {
    return bi("差异", "Diff");
  },
};

const EXT: Record<string, string> = {
  bash: "sh",
  sh: "sh",
  shell: "sh",
  console: "sh",
  python: "py",
  py: "py",
  yaml: "yaml",
  yml: "yml",
  json: "json",
  sql: "sql",
  ini: "ini",
  conf: "conf",
  jinja: "j2",
  j2: "j2",
  diff: "diff",
  xml: "xml",
  toml: "toml",
};
const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/** The folder AI-written scripts are kept in, made the first time. */
async function scriptFolder(): Promise<string> {
  const top = await api<{ nodes: FileNode[] }>("/api/me/files");
  const have = top.nodes.find(
    (n) =>
      n.kind === "folder" &&
      (n.name === "AI 脚本" || n.name === "AI Scripts"),
  );
  if (have) return have.id;
  const made = await api<FileNode>("/api/me/files", {
    method: "POST",
    body: JSON.stringify({
      kind: "folder",
      name: bi("AI 脚本", "AI Scripts"),
    }),
  });
  return made.id;
}

export const CodeBlock = React.memo(function CodeBlock({
  text,
  lang,
  caption,
}: {
  text: string;
  lang?: string;
  caption?: string;
}) {
  useLang();
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = React.useRef(false);
  const copyTimerRef = React.useRef<number>(0);
  const revokeUrlsRef = React.useRef<Map<number, string>>(new Map());
  React.useEffect(
    () => () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      revokeUrlsRef.current.forEach((href, tid) => {
        window.clearTimeout(tid);
        URL.revokeObjectURL(href);
      });
      revokeUrlsRef.current.clear();
    },
    [],
  );
  const ext = EXT[(lang || "").toLowerCase()];
  // a one-line command is just copied; a script or a config can be kept
  const keep = !!ext || text.includes("\n");
  const file = () =>
    new File(
      [text.endsWith("\n") ? text : text + "\n"],
      `ai-${stamp()}-${Math.random().toString(36).slice(2, 6)}.${ext || "txt"}`,
      { type: "text/plain" },
    );
  const download = () => {
    const f = file();
    const a = document.createElement("a");
    const href = URL.createObjectURL(f);
    a.href = href;
    a.download = f.name;
    a.click();
    const tid = window.setTimeout(() => {
      revokeUrlsRef.current.delete(tid);
      URL.revokeObjectURL(href);
    }, 2000);
    revokeUrlsRef.current.set(tid, href);
  };
  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const r = await uploadFiles([file()], await scriptFolder());
      if (r.added.length)
        Message.success(
          bi(
            `已保存到「我的资料 / AI 脚本」：${r.added[0].name}`,
            `Saved to "My Files / AI Scripts": ${r.added[0].name}`,
          ),
        );
      r.failed.forEach((m) => Message.warning(m));
    } catch (e) {
      err(e);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <figure className="md-code">
      <figcaption>
        <span className="md-code-cap">
          {caption ||
            LANG[(lang || "").toLowerCase()] ||
            lang ||
            bi("命令", "Command")}
        </span>
        <span className="md-code-acts">
          {keep && (
            <>
              <button
                type="button"
                onClick={download}
                aria-label={bi("下载为文件", "Download as file")}
              >
                <IconDownload /> {bi("下载", "Download")}
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                aria-label={bi("保存到我的资料", "Save to My Files")}
              >
                <IconSave /> {bi("保存", "Save")}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              const isShell = /^(ba|z|k)?sh$|^shell$|^console$/i.test(
                (lang || "").trim(),
              );
              const payload = isShell ? toPasteSafeShell(text).text : text;
              copy(payload);
              setDone(true);
              if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
              copyTimerRef.current = window.setTimeout(() => {
                copyTimerRef.current = 0;
                setDone(false);
              }, 1400);
            }}
            aria-label={bi("复制代码", "Copy code")}
          >
            {done ? <IconCheck /> : <IconCopy />}
            {done ? bi("已复制", "Copied") : bi("复制", "Copy")}
          </button>
        </span>
      </figcaption>
      <pre>
        <code>{text}</code>
      </pre>
    </figure>
  );
});

function blocksEqual(a: Block[], b: Block[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!blockEqual(a[i], b[i])) return false;
  }
  return true;
}

function blockEqual(a: Block, b: Block): boolean {
  if (a === b) return true;
  if (a.t !== b.t) return false;
  switch (a.t) {
    case "hr":
      return true;
    case "code":
      return b.t === "code" && a.lang === b.lang && a.text === b.text;
    case "h":
      return b.t === "h" && a.level === b.level && a.text === b.text;
    case "p":
    case "quote":
    case "math":
      return (
        (b.t === "p" || b.t === "quote" || b.t === "math") && a.text === b.text
      );
    case "table":
      return (
        b.t === "table" &&
        a.head.length === b.head.length &&
        a.rows.length === b.rows.length &&
        a.align.length === b.align.length &&
        a.head.every((c, k) => c === b.head[k]) &&
        a.align.every((c, k) => c === b.align[k]) &&
        a.rows.every(
          (r, k) =>
            r.length === b.rows[k].length &&
            r.every((c, m) => c === b.rows[k][m]),
        )
      );
    case "list":
      return (
        b.t === "list" &&
        a.ordered === b.ordered &&
        a.start === b.start &&
        a.items.length === b.items.length &&
        a.items.every(
          (it, k) =>
            it.text === b.items[k].text &&
            blocksEqual(it.children, b.items[k].children),
        )
      );
  }
}

const BlockNode = React.memo(
  function BlockNode({ b }: { b: Block }) {
    useLang();
    switch (b.t) {
      case "code":
        return <CodeBlock text={b.text} lang={b.lang} />;
      case "h":
        return React.createElement(
          `h${Math.min(6, b.level + 2)}`,
          { className: "md-h" },
          <Inline text={b.text} />,
        );
      case "hr":
        return <hr />;
      case "math":
        return <Tex src={b.text} block />;
      case "quote":
        return (
          <blockquote>
            <Inline text={b.text} />
          </blockquote>
        );
      case "table":
        return (
          <div className="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, k) => (
                    <th
                      key={k}
                      style={{
                        textAlign: b.align[
                          k
                        ] as React.CSSProperties["textAlign"],
                      }}
                    >
                      <Inline text={c} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, k) => (
                  <tr key={k}>
                    {r.map((c, m) => (
                      <td
                        key={m}
                        style={{
                          textAlign: b.align[
                            m
                          ] as React.CSSProperties["textAlign"],
                        }}
                      >
                        <Inline text={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "list": {
        const items = b.items.map((it, k) => (
          <li
            key={k}
            className={/^\[[ xX]\]\s/.test(it.text) ? "md-task" : undefined}
          >
            {/^\[[ xX]\]\s/.test(it.text) && (
              <input
                type="checkbox"
                checked={/^\[[xX]\]/.test(it.text)}
                readOnly
                tabIndex={-1}
                aria-label={
                  /^\[[xX]\]/.test(it.text)
                    ? bi("已完成", "Completed")
                    : bi("未完成", "Incomplete")
                }
              />
            )}
            <Inline text={it.text.replace(/^\[[ xX]\]\s/, "")} />
            {it.children.length > 0 && <Blocks blocks={it.children} />}
          </li>
        ));
        return b.ordered ? <ol start={b.start}>{items}</ol> : <ul>{items}</ul>;
      }
      default:
        return (
          <p>
            <Inline text={b.text} />
          </p>
        );
    }
  },
  (prev, next) => blockEqual(prev.b, next.b),
);

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockNode key={i} b={b} />
      ))}
    </>
  );
}

export const Markdown = React.memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  useLang();
  const blocks = React.useMemo(() => parseMd(text), [text]);
  return (
    <div className={`md ${className || ""}`}>
      <Blocks blocks={blocks} />
    </div>
  );
});

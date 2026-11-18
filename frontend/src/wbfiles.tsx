import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  Message,
  Modal,
  Radio,
  Select,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconCode,
  IconDelete,
  IconDown,
  IconFile,
  IconFolder,
  IconPlus,
  IconQuestionCircle,
  IconRight,
  IconSearch,
  IconSettings,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import { useAIDock } from "./aichat";
import { CodeEditor } from "./wbcode";
import type { Lang } from "./wbcode";
import { useWb } from "./wbdoc";
import type { Problem } from "./wbdoc";
import { bi, useLang } from "./i18n";

export type RenderFn = (
  path: string,
  preset: string,
  host: string,
) => Promise<{ ok: boolean; text?: string; error?: string }>;

const langOf = (p: string): Lang =>
  p === "component.yaml"
    ? "manifest"
    : p.endsWith(".j2")
      ? "template"
      : /\.ya?ml$/.test(p)
        ? "yaml"
        : p.endsWith(".py")
          ? "python"
          : p.endsWith(".sh")
            ? "shell"
            : "text";

/* ---------------------------------------------------------------- tree */

/** The kind of a file at a glance: the manifest, a task, a template, a script. */
function FileIcon({ path }: { path: string }) {
  const k =
    path === "component.yaml"
      ? "manifest"
      : path.endsWith(".j2")
        ? "tpl"
        : /\.ya?ml$/.test(path)
          ? "yaml"
          : /\.(py|sh)$/.test(path)
            ? "script"
            : "file";
  return (
    <span className={`wb-fic k-${k}`} aria-hidden>
      {k === "manifest" ? (
        <IconSettings />
      ) : k === "script" || k === "tpl" ? (
        <IconCode />
      ) : (
        <IconFile />
      )}
    </span>
  );
}

/** Finding a file by name, and text in every file, the way a code host does it. */
function Finder({
  paths,
  files,
  open,
}: {
  paths: string[];
  files: Record<string, string>;
  open: (path: string, line?: number) => void;
}) {
  useLang();
  const [q, setQ] = useState("");
  const [inText, setInText] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setInText(false);
        box.current?.focus();
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        setInText(true);
        box.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  const t = q.trim().toLowerCase();
  const byName = useMemo(() => {
    if (!t || inText) return [];
    // every character in order, the way a fuzzy finder matches; closer matches first
    const score = (p: string) => {
      const s = p.toLowerCase();
      if (s.includes(t)) return 1000 - s.indexOf(t) - s.length / 100;
      let i = 0;
      for (const ch of s) if (ch === t[i]) i++;
      return i === t.length ? 100 - s.length / 100 : -1;
    };
    return paths
      .map((p) => [p, score(p)] as const)
      .filter(([, n]) => n >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([p]) => p);
  }, [t, inText, paths]);
  const inside = useMemo(() => {
    if (!t || !inText || t.length < 2) return [];
    const out: { path: string; hits: { line: number; text: string }[] }[] = [];
    let n = 0;
    for (const p of paths) {
      const body = files[p];
      if (body === undefined) continue;
      const hits: { line: number; text: string }[] = [];
      body.split("\n").forEach((l, i) => {
        if (n < 300 && l.toLowerCase().includes(t)) {
          hits.push({ line: i + 1, text: l });
          n++;
        }
      });
      if (hits.length) out.push({ path: p, hits });
    }
    return out;
  }, [t, inText, paths, files]);
  const mark = (s: string) => {
    const i = s.toLowerCase().indexOf(t);
    if (i < 0) return s;
    return (
      <>
        {s.slice(0, i)}
        <mark>{s.slice(i, i + t.length)}</mark>
        {s.slice(i + t.length)}
      </>
    );
  };
  return (
    <div className="wb-finder">
      <div className="wb-find-box">
        <IconSearch />
        <input
          ref={box}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQ("");
            if (e.key === "Enter" && byName[0]) {
              open(byName[0]);
              setQ("");
            }
          }}
          placeholder={
            inText
              ? bi("在全部文件里搜索内容", "Search across all files")
              : bi("查找文件", "Find file")
          }
          aria-label={
            inText
              ? bi("搜索文件内容", "Search file contents")
              : bi("查找文件", "Find file")
          }
        />
        <kbd>{inText ? "⇧Ctrl F" : "Ctrl P"}</kbd>
      </div>
      <div className="wb-find-seg" role="group" aria-label={bi("查找范围", "Search scope")}>
        <button
          type="button"
          className={!inText ? "on" : ""}
          onClick={() => setInText(false)}
        >
          {bi("文件名", "File name")}
        </button>
        <button
          type="button"
          className={inText ? "on" : ""}
          onClick={() => setInText(true)}
        >
          {bi("文件内容", "Contents")}
        </button>
      </div>
      {t && !inText && (
        <ul className="wb-find-list">
          {byName.map((p) => (
            <li key={p}>
              <button
                type="button"
                onClick={() => {
                  open(p);
                  setQ("");
                }}
              >
                <FileIcon path={p} />
                <span className="wb-find-name">{p.split("/").pop()}</span>
                <span className="wb-find-dir">
                  {p.split("/").slice(0, -1).join("/")}
                </span>
              </button>
            </li>
          ))}
          {byName.length === 0 && (
            <li className="wb-find-none">{bi("没有这个文件", "No matching files")}</li>
          )}
        </ul>
      )}
      {t && inText && (
        <ul className="wb-find-list text">
          {t.length < 2 ? (
            <li className="wb-find-none">
              {bi("至少输入两个字", "Enter at least 2 characters")}
            </li>
          ) : inside.length === 0 ? (
            <li className="wb-find-none">{bi("没有找到", "No matches")}</li>
          ) : (
            inside.map((f) => (
              <li key={f.path}>
                <div className="wb-find-file">
                  <FileIcon path={f.path} />
                  <b>{f.path}</b>
                  <em>{f.hits.length}</em>
                </div>
                {f.hits.slice(0, 20).map((h) => (
                  <button
                    type="button"
                    key={h.line}
                    className="wb-find-hit"
                    onClick={() => open(f.path, h.line)}
                  >
                    <span className="num">{h.line}</span>
                    <code>{mark(h.text.trim())}</code>
                  </button>
                ))}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

type Node = { name: string; path: string; dir: boolean; children: Node[] };
function build(paths: string[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let next = cur.children.find((c) => c.name === part);
      if (!next) {
        next = { name: part, path, dir: i < parts.length - 1, children: [] };
        cur.children.push(next);
      }
      cur = next;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
    );
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function Tree({
  nodes,
  active,
  setActive,
  flagged,
  depth = 0,
}: {
  nodes: Node[];
  active: string;
  setActive: (p: string) => void;
  flagged: Map<string, "error" | "warning">;
  depth?: number;
}) {
  useLang();
  const { aiFiles } = useWb();
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  return (
    <>
      {nodes.map((n) =>
        n.dir ? (
          <div key={n.path}>
            <button
              type="button"
              className="wb-tnode dir"
              style={{ paddingLeft: 6 + depth * 12 }}
              aria-expanded={!closed[n.path]}
              onClick={() => setClosed((c) => ({ ...c, [n.path]: !c[n.path] }))}
            >
              {closed[n.path] ? <IconRight /> : <IconDown />}
              <IconFolder />
              <span>{n.name}</span>
            </button>
            {!closed[n.path] && (
              <Tree
                nodes={n.children}
                active={active}
                setActive={setActive}
                flagged={flagged}
                depth={depth + 1}
              />
            )}
          </div>
        ) : (
          <button
            type="button"
            key={n.path}
            className={`wb-tnode ${active === n.path ? "on" : ""} ${aiFiles?.includes(n.path) ? "ai" : ""}`}
            style={{ paddingLeft: 6 + depth * 12 + 14 }}
            onClick={() => setActive(n.path)}
            aria-current={active === n.path}
          >
            <FileIcon path={n.path} />
            <span className="wb-tname">{n.name}</span>
            {flagged.has(n.path) && (
              <i
                className={`wb-dot ${flagged.get(n.path)}`}
                aria-label={
                  flagged.get(n.path) === "error"
                    ? bi("有错误，打开文件查看说明", "Has errors; open file for details")
                    : bi("有警告，打开文件查看说明", "Has warnings; open file for details")
                }
                title={
                  flagged.get(n.path) === "error"
                    ? bi("有错误，打开文件查看顶部说明", "Has errors; open file to view details")
                    : bi("有提醒，打开文件查看顶部说明", "Has warnings; open file to view details")
                }
              />
            )}
          </button>
        ),
      )}
    </>
  );
}

/* ---------------------------------------------------------------- new file */

type Kind = "task" | "template" | "file" | "defaults";
const STARTER: Record<Kind, (role: string, name: string) => string> = {
  task: (_r, n) =>
    bi(
      `# ${n}：在目标机器上执行的 Ansible 任务。\n# 可用变量见上方「变量速查」，如 {{ mw.params.xxx }}、{{ mw_hosts[inventory_hostname].ip }}。\n- name: 示例任务\n  ansible.builtin.debug:\n    msg: "${n} on {{ inventory_hostname }}"\n`,
      `# ${n}: Ansible tasks executed on target hosts.\n# See Variable Reference above for variables such as {{ mw.params.xxx }} and {{ mw_hosts[inventory_hostname].ip }}.\n- name: Example task\n  ansible.builtin.debug:\n    msg: "${n} on {{ inventory_hostname }}"\n`,
    ),
  template: () =>
    "# Managed by Middleware Hub for {{ mw_cluster.id }}/{{ mw.id }}. Do not edit by hand.\n",
  file: () => "",
  defaults: () => bi("# 角色默认变量\n", "# Role default variables\n"),
};

function NewFile({
  open,
  close,
  roles,
  create,
}: {
  open: boolean;
  close: () => void;
  roles: string[];
  create: (path: string, text: string) => void;
}) {
  useLang();
  const [kind, setKind] = useState<Kind>("task");
  const [role, setRole] = useState("");
  const [name, setName] = useState("");
  const base =
    kind === "task"
      ? "tasks"
      : kind === "template"
        ? "templates"
        : kind === "defaults"
          ? "defaults"
          : "files";
  const file =
    kind === "task" ? `${name}.yml` : kind === "defaults" ? "main.yml" : name;
  const path = `roles/${role}/${base}/${file}`;
  const valid =
    /^[A-Za-z0-9._@+-]+$/.test(role) &&
    (kind === "defaults" || /^[A-Za-z0-9._@+-]+$/.test(name)) &&
    !path.includes("..");
  const names: Record<Kind, [string, string]> = {
    task: [bi("任务文件", "Task file"), bi("如 install、configure", "e.g. install, configure")],
    template: [bi("配置模板", "Config template"), bi("如 redis.conf.j2", "e.g. redis.conf.j2")],
    file: [bi("静态文件", "Static file"), bi("如 limits.conf", "e.g. limits.conf")],
    defaults: [bi("默认变量", "Default vars"), ""],
  };
  return (
    <Modal
      visible={open}
      onCancel={close}
      title={bi("新建文件", "New File")}
      okText={bi("创建", "Create")}
      okButtonProps={{ disabled: !valid }}
      onOk={() => {
        create(path, STARTER[kind](role, name));
        close();
        setName("");
      }}
      style={{ width: 520, maxWidth: "94vw" }}
    >
      <div className="wb-newfile">
        <Radio.Group
          type="button"
          value={kind}
          onChange={setKind}
          options={(Object.keys(names) as Kind[]).map((k) => ({
            value: k,
            label: names[k][0],
          }))}
        />
        <div className="wb-field w-l">
          <span className="wb-flabel">{bi("放进哪个角色目录", "Target role directory")}</span>
          <Select
            showSearch
            allowCreate
            value={role || undefined}
            placeholder={bi("选择，或输入新名字", "Select or enter a new name")}
            options={roles.map((r) => ({ value: r, label: r }))}
            onChange={setRole}
            aria-label={bi("角色目录", "Role directory")}
          />
        </div>
        {kind !== "defaults" && (
          <div className="wb-field w-l">
            <span className="wb-flabel">{bi("文件名", "File name")}</span>
            <Input
              value={name}
              onChange={setName}
              placeholder={names[kind][1]}
              aria-label={bi("文件名", "File name")}
            />
          </div>
        )}
        <p className="wb-fhint">
          {bi("将创建", "Will create")} <code>{valid ? path : "…"}</code>
        </p>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- cheat sheet */

function CheatPanel({ close }: { close: () => void }) {
  useLang();
  const { ops } = useWb();
  const js = ops.js;
  const [q, setQ] = useState("");
  const rows: [string, string][] = [
    ["mw.id", bi("这个实例的名字", "Name of this instance")],
    ["mw.version", bi("选用的版本", "Selected version")],
    ...((js.params || []) as any[]).map((p): [string, string] => [
      `mw.params.${p.key}`,
      `${p.label || p.key} (${p.type})`,
    ]),
    ...((js.roles || []) as any[]).map((r): [string, string] => [
      `mw.roles.${r.name}`,
      bi(
        `${r.title || r.name}：这个角色的机器名列表`,
        `${r.title || r.name}: host list for this role`,
      ),
    ]),
    ...((js.secrets || []) as any[]).map((s): [string, string] => [
      `mw.secrets.${s.name}`,
      bi("自动生成的密钥", "Auto-generated secret"),
    ]),
    ["mw.packages", bi("本版本的软件包（每项有 name、version、spec）", "Packages for this version (each with name, version, spec)")],
    ["inventory_hostname", bi("当前这台机器的名字", "Current target host name")],
    ["mw_hosts[inventory_hostname].ip", bi("当前机器的 IP", "IP of the current host")],
    ["mw_hosts", bi("所有机器：名字 → {ip, ...}", "All hosts: name → {ip, ...}")],
    ["mw_cluster.id", bi("这次交付的编号", "ID of this delivery")],
    ["mw_platform", bi("目标系统（ubuntu 或 el9）", "Target OS (ubuntu or el9)")],
  ];
  const t = q.trim().toLowerCase();
  const shown = rows.filter(
    ([k, d]) => !t || `${k} ${d}`.toLowerCase().includes(t),
  );
  const copy = async (k: string) => {
    try {
      await navigator.clipboard.writeText(`{{ ${k} }}`);
      Message.success(bi("已复制，粘贴到文件里即可", "Copied; paste into your file"));
    } catch {
      Message.info(`{{ ${k} }}`);
    }
  };
  return (
    <aside className="wb-cheat" aria-label={bi("变量速查", "Variable Reference")}>
      <header>
        <b>{bi("变量速查", "Variable Reference")}</b>
        <Button size="mini" type="text" onClick={close}>
          {bi("关闭", "Close")}
        </Button>
      </header>
      <Input
        allowClear
        size="small"
        placeholder={bi("按名字或说明筛选", "Filter by name or description")}
        value={q}
        onChange={setQ}
        aria-label={bi("筛选变量", "Filter variables")}
      />
      <ul>
        {shown.map(([k, d]) => (
          <li key={k}>
            <button type="button" onClick={() => copy(k)} title={bi("点击复制", "Click to copy")}>
              <code>{`{{ ${k} }}`}</code>
              <span>{d}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="muted small">{bi("没有匹配的变量", "No matching variables")}</li>
        )}
      </ul>
      <p className="wb-fhint">
        {bi("点一行复制，然后粘贴到任务文件或模板里。", "Click a row to copy, then paste into a task file or template.")}
      </p>
    </aside>
  );
}

/* ---------------------------------------------------------------- the tab */

export function FilesTab(p: {
  files: Record<string, string>;
  binaries: string[];
  active: string;
  setActive: (p: string) => void;
  edit: (path: string, text: string) => void;
  create: (path: string, text: string) => void;
  remove: (path: string) => void;
  rename: (from: string, to: string) => void;
  jump?: { file: string; line: number; n: number };
  readOnly: boolean;
  onSave: () => void;
  render: RenderFn;
  ansibleReady: boolean;
  ansibleWhy: string;
}) {
  useLang();
  const { problems, tasks, ops, ignoreWarning } = useWb();
  const paths = useMemo(
    () => [...Object.keys(p.files), ...p.binaries].sort(),
    [p.files, p.binaries],
  );
  const nodes = useMemo(() => build(paths), [paths]);
  const flagged = useMemo(() => {
    const m = new Map<string, "error" | "warning">();
    for (const x of problems)
      if (x.file && m.get(x.file) !== "error") m.set(x.file, x.severity);
    return m;
  }, [problems]);
  const [newOpen, setNewOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [cheat, setCheat] = useState(false);
  const [target, setTarget] = useState("");
  const here = problems.filter((x) => x.file === p.active);
  const dock = useAIDock();
  // a place to go to from the finder or a problem; the page's own jump (from a check result) still works
  const [go, setGo] = useState<{ file: string; line: number; n: number }>();
  // a newer jump from the page (a check result) takes over from the finder's
  useEffect(() => setGo(undefined), [p.jump?.n]);
  const jump = go ?? p.jump;
  const openAt = (path: string, line?: number) => {
    p.setActive(path);
    if (line) setGo({ file: path, line, n: Date.now() });
  };
  const askProblem = (x: Problem) =>
    dock?.open({
      key: "comp",
      title: bi("组件工作台", "Component Workbench"),
      context: bi("组件工作台", "Component Workbench"),
      prefill: bi(
        `请解释这条检查提示：它是什么意思、对这个组件有没有实际影响、需不需要处理、怎么改（需要改就提议最小的局部修改）。\n${x.file}${x.line ? `:${x.line}` : ""} [${x.severity === "error" ? "错误" : "提示"}] ${x.message}`,
        `Please explain this check finding: what it means, whether it actually affects this component, whether it needs fixing, and the minimal local edit if needed.\n${x.file}${x.line ? `:${x.line}` : ""} [${x.severity === "error" ? "Error" : "Warning"}] ${x.message}`,
      ),
    });
  const roleNames = Array.from(
    new Set(
      paths.filter((x) => x.startsWith("roles/")).map((x) => x.split("/")[1]),
    ),
  );
  const isBinary = p.binaries.includes(p.active);
  const text = p.files[p.active];
  return (
    <div className="wb-files">
      <aside className="wb-tree" aria-label={bi("文件", "Files")}>
        <div className="wb-tree-head">
          <b>{bi("文件", "Files")}</b>
          {!p.readOnly && (
            <Button
              size="mini"
              type="text"
              icon={<IconPlus />}
              onClick={() => setNewOpen(true)}
            >
              {bi("新建", "New")}
            </Button>
          )}
        </div>
        <Finder paths={paths} files={p.files} open={openAt} />
        <div className="wb-tree-body">
          <Tree
            nodes={nodes}
            active={p.active}
            setActive={p.setActive}
            flagged={flagged}
          />
        </div>
        <p className="wb-fhint wb-tree-note">
          {bi(
            "component.yaml 的内容也可以在其他页签用表单改。roles/ 下是在目标机器上执行的任务，templates/ 是配置模板。",
            "component.yaml can also be edited via forms on other tabs. roles/ holds tasks executed on target hosts; templates/ holds config templates.",
          )}
        </p>
      </aside>
      <div className="wb-editor">
        {!p.active || (text === undefined && !isBinary) ? (
          <div className="wb-editor-empty">
            {bi("从左边选一个文件，或新建一个。", "Select a file on the left or create a new one.")}
          </div>
        ) : (
          <>
            <div className="wb-editor-bar">
              <nav className="wb-crumbs" aria-label={bi("路径", "Path")}>
                {p.active.split("/").map((seg, i, all) => (
                  <React.Fragment key={i}>
                    {i > 0 && <span className="sep">/</span>}
                    <span className={i === all.length - 1 ? "last" : ""}>
                      {seg}
                    </span>
                  </React.Fragment>
                ))}
              </nav>
              <span className="wb-grow" />
              {here.length > 0 && (
                <span className="wb-fhint">
                  {bi(
                    `${here.filter((x) => x.severity === "error").length} 个错误 · ${here.filter((x) => x.severity === "warning").length} 个警告`,
                    `${here.filter((x) => x.severity === "error").length} error(s) · ${here.filter((x) => x.severity === "warning").length} warning(s)`,
                  )}
                </span>
              )}
              <Button
                size="mini"
                type="text"
                onClick={() => setCheat((c) => !c)}
                aria-pressed={cheat}
              >
                {bi("变量速查", "Variables")}
              </Button>
              {!p.readOnly && p.active !== "component.yaml" && !isBinary && (
                <Button
                  size="mini"
                  type="text"
                  onClick={() => {
                    setTarget(p.active);
                    setRenaming(true);
                  }}
                >
                  {bi("重命名", "Rename")}
                </Button>
              )}
              {!p.readOnly && p.active !== "component.yaml" && (
                <Tooltip content={bi("删除这个文件", "Delete this file")}>
                  <Button
                    size="mini"
                    type="text"
                    status="danger"
                    icon={<IconDelete />}
                    aria-label={bi("删除文件", "Delete file")}
                    onClick={() =>
                      Modal.confirm({
                        title: bi(`删除 ${p.active}？`, `Delete ${p.active}?`),
                        content: bi(
                          "只影响草稿，发布前随时可以从修订里找回。",
                          "Only affects this draft; you can restore from revisions before publishing.",
                        ),
                        okText: bi("删除", "Delete"),
                        okButtonProps: { status: "danger" },
                        onOk: () => p.remove(p.active),
                      })
                    }
                  />
                </Tooltip>
              )}
            </div>
            {here.length > 0 && !isBinary && (
              <ul
                className="wb-probs wb-probs-visible"
                aria-label={bi("这个文件的检查结果", "Check findings for this file")}
              >
                {here.map((x, i) => (
                  <li key={i} className={x.severity}>
                    <i className={`wb-dot ${x.severity}`} aria-hidden />
                    <button
                      type="button"
                      className="wb-prob-at"
                      onClick={() => x.line && openAt(p.active, x.line)}
                    >
                      {x.line ? bi(`第 ${x.line} 行`, `Line ${x.line}`) : bi("整个文件", "Whole file")}
                    </button>
                    <span className="wb-prob-msg">
                      <strong>
                        {x.severity === "error" ? bi("错误：", "Error: ") : bi("提示：", "Notice: ")}
                      </strong>
                      {x.message}
                    </span>
                    {x.severity === "warning" &&
                      ignoreWarning &&
                      !p.readOnly && (
                        <button
                          type="button"
                          className="wb-prob-ign"
                          title={bi("看过了、确认没问题：以后不再提醒", "Reviewed and confirmed safe: dismiss future warnings")}
                          onClick={() => ignoreWarning(x)}
                        >
                          {bi("忽略", "Ignore")}
                        </button>
                      )}
                    {!!dock?.available("comp") && (
                      <Tooltip content={bi("问 AI 这条提示", "Ask AI about this issue")} mini>
                        <button
                          type="button"
                          className="wb-prob-q"
                          aria-label={bi("问 AI 这条提示", "Ask AI about this issue")}
                          onClick={() => askProblem(x)}
                        >
                          <IconQuestionCircle />
                        </button>
                      </Tooltip>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {isBinary ? (
              <div className="wb-editor-empty">
                {bi("这是二进制文件，不能在这里编辑。", "Binary file; cannot be edited here.")}
              </div>
            ) : (
              <div className="wb-editor-main">
                <CodeEditor
                  key={p.active}
                  label={p.active}
                  value={text ?? ""}
                  lang={langOf(p.active)}
                  readOnly={p.readOnly}
                  problems={here as Problem[]}
                  onChange={(v) => p.edit(p.active, v)}
                  onSave={p.onSave}
                  jumpTo={jump && jump.file === p.active ? jump : undefined}
                />
              </div>
            )}
            {cheat && <CheatPanel close={() => setCheat(false)} />}
            {p.active.endsWith(".j2") && !isBinary && (
              <RenderPane
                path={p.active}
                render={p.render}
                ready={p.ansibleReady}
                why={p.ansibleWhy}
                presets={
                  (ops.js.detail?.presets || []) as {
                    id: string;
                    name: string;
                  }[]
                }
              />
            )}
          </>
        )}
      </div>
      <Modal
        visible={renaming}
        onCancel={() => setRenaming(false)}
        title={bi("重命名 / 移动文件", "Rename / Move File")}
        okText={bi("确定", "OK")}
        okButtonProps={{
          disabled:
            !/^(roles|templates|files)\/[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/.test(
              target,
            ) ||
            target === p.active ||
            paths.includes(target),
        }}
        onOk={() => {
          p.rename(p.active, target);
          setRenaming(false);
        }}
        style={{ width: 520, maxWidth: "94vw" }}
      >
        <div className="wb-newfile">
          <div className="wb-field w-l">
            <span className="wb-flabel">{bi("新路径", "New Path")}</span>
            <Input
              className="wb-mono"
              value={target}
              onChange={setTarget}
              aria-label={bi("新路径", "New path")}
            />
            <span className="wb-fhint">
              {bi(
                "要放在 roles/、templates/ 或 files/ 目录下。改了角色目录名的话，别忘了同步改步骤里的 run.role。",
                "Must be placed under roles/, templates/, or files/. If you rename a role directory, remember to update run.role in your steps.",
              )}
            </span>
          </div>
        </div>
      </Modal>
      <NewFile
        open={newOpen}
        close={() => setNewOpen(false)}
        roles={Array.from(new Set([...roleNames, ...Object.keys(tasks)]))}
        create={(path, t) => {
          p.create(path, t);
          p.setActive(path);
        }}
      />
    </div>
  );
}

function RenderPane({
  path,
  render,
  ready,
  why,
  presets,
}: {
  path: string;
  render: RenderFn;
  ready: boolean;
  why: string;
  presets: { id: string; name: string }[];
}) {
  useLang();
  const [preset, setPreset] = useState("");
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{
    ok: boolean;
    text?: string;
    error?: string;
  } | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setOut(await render(path, preset, host));
    } catch (e) {
      setOut({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wb-render">
      <div className="wb-render-bar">
        <b>{bi("渲染预览", "Render Preview")}</b>
        <span className="wb-fhint">
          {bi(
            "用样例机器和这个组件的默认参数，让 Ansible 真的把模板渲染一遍",
            "Renders this template via Ansible using sample hosts and the component's defaults",
          )}
        </span>
        <span className="wb-grow" />
        <Select
          size="small"
          allowClear
          style={{ width: 150 }}
          placeholder={bi("方案：默认", "Scheme: default")}
          value={preset || undefined}
          options={presets.map((x) => ({ value: x.id, label: x.name || x.id }))}
          onChange={(v) => setPreset(v || "")}
          aria-label={bi("方案", "Scheme")}
        />
        <Input
          size="small"
          style={{ width: 110 }}
          placeholder={bi("机器：host1", "Host: host1")}
          value={host}
          onChange={setHost}
          aria-label={bi("样例机器", "Sample host")}
        />
        <Tooltip content={ready ? "" : why} disabled={ready}>
          <span>
            <Button
              size="small"
              type="primary"
              icon={<IconThunderbolt />}
              loading={busy}
              disabled={!ready}
              onClick={run}
            >
              {bi("渲染", "Render")}
            </Button>
          </span>
        </Tooltip>
      </div>
      {out &&
        (out.ok ? (
          <pre className="wb-render-out mono">{out.text}</pre>
        ) : (
          <pre className="wb-render-out mono bad">{out.error}</pre>
        ))}
    </div>
  );
}

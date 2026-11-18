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
          placeholder={inText ? "在全部文件里搜索内容" : "查找文件"}
          aria-label={inText ? "搜索文件内容" : "查找文件"}
        />
        <kbd>{inText ? "⇧Ctrl F" : "Ctrl P"}</kbd>
      </div>
      <div className="wb-find-seg" role="group" aria-label="查找范围">
        <button
          type="button"
          className={!inText ? "on" : ""}
          onClick={() => setInText(false)}
        >
          文件名
        </button>
        <button
          type="button"
          className={inText ? "on" : ""}
          onClick={() => setInText(true)}
        >
          文件内容
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
            <li className="wb-find-none">没有这个文件</li>
          )}
        </ul>
      )}
      {t && inText && (
        <ul className="wb-find-list text">
          {t.length < 2 ? (
            <li className="wb-find-none">至少输入两个字</li>
          ) : inside.length === 0 ? (
            <li className="wb-find-none">没有找到</li>
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
                    ? "有错误，打开文件查看说明"
                    : "有警告，打开文件查看说明"
                }
                title={
                  flagged.get(n.path) === "error"
                    ? "有错误，打开文件查看顶部说明"
                    : "有提醒，打开文件查看顶部说明"
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
    `# ${n}：在目标机器上执行的 Ansible 任务。\n# 可用变量见上方「变量速查」，如 {{ mw.params.xxx }}、{{ mw_hosts[inventory_hostname].ip }}。\n- name: 示例任务\n  ansible.builtin.debug:\n    msg: "${n} on {{ inventory_hostname }}"\n`,
  template: () =>
    "# Managed by Middleware Hub for {{ mw_cluster.id }}/{{ mw.id }}. Do not edit by hand.\n",
  file: () => "",
  defaults: () => "# 角色默认变量\n",
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
    task: ["任务文件", "如 install、configure"],
    template: ["配置模板", "如 redis.conf.j2"],
    file: ["静态文件", "如 limits.conf"],
    defaults: ["默认变量", ""],
  };
  return (
    <Modal
      visible={open}
      onCancel={close}
      title="新建文件"
      okText="创建"
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
          <span className="wb-flabel">放进哪个角色目录</span>
          <Select
            showSearch
            allowCreate
            value={role || undefined}
            placeholder="选择，或输入新名字"
            options={roles.map((r) => ({ value: r, label: r }))}
            onChange={setRole}
            aria-label="角色目录"
          />
        </div>
        {kind !== "defaults" && (
          <div className="wb-field w-l">
            <span className="wb-flabel">文件名</span>
            <Input
              value={name}
              onChange={setName}
              placeholder={names[kind][1]}
              aria-label="文件名"
            />
          </div>
        )}
        <p className="wb-fhint">
          将创建 <code>{valid ? path : "…"}</code>
        </p>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- cheat sheet */

function CheatPanel({ close }: { close: () => void }) {
  const { ops } = useWb();
  const js = ops.js;
  const [q, setQ] = useState("");
  const rows: [string, string][] = [
    ["mw.id", "这个实例的名字"],
    ["mw.version", "选用的版本"],
    ...((js.params || []) as any[]).map((p): [string, string] => [
      `mw.params.${p.key}`,
      `${p.label || p.key}（${p.type}）`,
    ]),
    ...((js.roles || []) as any[]).map((r): [string, string] => [
      `mw.roles.${r.name}`,
      `${r.title || r.name}：这个角色的机器名列表`,
    ]),
    ...((js.secrets || []) as any[]).map((s): [string, string] => [
      `mw.secrets.${s.name}`,
      "自动生成的密钥",
    ]),
    ["mw.packages", "本版本的软件包（每项有 name、version、spec）"],
    ["inventory_hostname", "当前这台机器的名字"],
    ["mw_hosts[inventory_hostname].ip", "当前机器的 IP"],
    ["mw_hosts", "所有机器：名字 → {ip, ...}"],
    ["mw_cluster.id", "这次交付的编号"],
    ["mw_platform", "目标系统（ubuntu 或 el9）"],
  ];
  const t = q.trim().toLowerCase();
  const shown = rows.filter(
    ([k, d]) => !t || `${k} ${d}`.toLowerCase().includes(t),
  );
  const copy = async (k: string) => {
    try {
      await navigator.clipboard.writeText(`{{ ${k} }}`);
      Message.success("已复制，粘贴到文件里即可");
    } catch {
      Message.info(`{{ ${k} }}`);
    }
  };
  return (
    <aside className="wb-cheat" aria-label="变量速查">
      <header>
        <b>变量速查</b>
        <Button size="mini" type="text" onClick={close}>
          关闭
        </Button>
      </header>
      <Input
        allowClear
        size="small"
        placeholder="按名字或说明筛选"
        value={q}
        onChange={setQ}
        aria-label="筛选变量"
      />
      <ul>
        {shown.map(([k, d]) => (
          <li key={k}>
            <button type="button" onClick={() => copy(k)} title="点击复制">
              <code>{`{{ ${k} }}`}</code>
              <span>{d}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="muted small">没有匹配的变量</li>}
      </ul>
      <p className="wb-fhint">点一行复制，然后粘贴到任务文件或模板里。</p>
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
      title: "组件工作台",
      context: "组件工作台",
      prefill: `请解释这条检查提示：它是什么意思、对这个组件有没有实际影响、需不需要处理、怎么改（需要改就提议最小的局部修改）。\n${x.file}${x.line ? `:${x.line}` : ""} [${x.severity === "error" ? "错误" : "提示"}] ${x.message}`,
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
      <aside className="wb-tree" aria-label="文件">
        <div className="wb-tree-head">
          <b>文件</b>
          {!p.readOnly && (
            <Button
              size="mini"
              type="text"
              icon={<IconPlus />}
              onClick={() => setNewOpen(true)}
            >
              新建
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
          component.yaml 的内容也可以在其他页签用表单改。roles/
          下是在目标机器上执行的任务，templates/ 是配置模板。
        </p>
      </aside>
      <div className="wb-editor">
        {!p.active || (text === undefined && !isBinary) ? (
          <div className="wb-editor-empty">从左边选一个文件，或新建一个。</div>
        ) : (
          <>
            <div className="wb-editor-bar">
              <nav className="wb-crumbs" aria-label="路径">
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
                  {here.filter((x) => x.severity === "error").length} 个错误 ·{" "}
                  {here.filter((x) => x.severity === "warning").length} 个警告
                </span>
              )}
              <Button
                size="mini"
                type="text"
                onClick={() => setCheat((c) => !c)}
                aria-pressed={cheat}
              >
                变量速查
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
                  重命名
                </Button>
              )}
              {!p.readOnly && p.active !== "component.yaml" && (
                <Tooltip content="删除这个文件">
                  <Button
                    size="mini"
                    type="text"
                    status="danger"
                    icon={<IconDelete />}
                    aria-label="删除文件"
                    onClick={() =>
                      Modal.confirm({
                        title: `删除 ${p.active}？`,
                        content: "只影响草稿，发布前随时可以从修订里找回。",
                        okText: "删除",
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
                aria-label="这个文件的检查结果"
              >
                {here.map((x, i) => (
                  <li key={i} className={x.severity}>
                    <i className={`wb-dot ${x.severity}`} aria-hidden />
                    <button
                      type="button"
                      className="wb-prob-at"
                      onClick={() => x.line && openAt(p.active, x.line)}
                    >
                      {x.line ? `第 ${x.line} 行` : "整个文件"}
                    </button>
                    <span className="wb-prob-msg">
                      <strong>
                        {x.severity === "error" ? "错误：" : "提示："}
                      </strong>
                      {x.message}
                    </span>
                    {x.severity === "warning" &&
                      ignoreWarning &&
                      !p.readOnly && (
                        <button
                          type="button"
                          className="wb-prob-ign"
                          title="看过了、确认没问题：以后不再提醒"
                          onClick={() => ignoreWarning(x)}
                        >
                          忽略
                        </button>
                      )}
                    {!!dock?.available("comp") && (
                      <Tooltip content="问 AI 这条提示" mini>
                        <button
                          type="button"
                          className="wb-prob-q"
                          aria-label="问 AI 这条提示"
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
                这是二进制文件，不能在这里编辑。
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
        title="重命名 / 移动文件"
        okText="确定"
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
            <span className="wb-flabel">新路径</span>
            <Input
              className="wb-mono"
              value={target}
              onChange={setTarget}
              aria-label="新路径"
            />
            <span className="wb-fhint">
              要放在 roles/、templates/ 或 files/
              目录下。改了角色目录名的话，别忘了同步改步骤里的 run.role。
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
        <b>渲染预览</b>
        <span className="wb-fhint">
          用样例机器和这个组件的默认参数，让 Ansible 真的把模板渲染一遍
        </span>
        <span className="wb-grow" />
        <Select
          size="small"
          allowClear
          style={{ width: 150 }}
          placeholder="方案：默认"
          value={preset || undefined}
          options={presets.map((x) => ({ value: x.id, label: x.name || x.id }))}
          onChange={(v) => setPreset(v || "")}
          aria-label="方案"
        />
        <Input
          size="small"
          style={{ width: 110 }}
          placeholder="机器：host1"
          value={host}
          onChange={setHost}
          aria-label="样例机器"
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
              渲染
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

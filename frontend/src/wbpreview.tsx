import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Drawer, Select, Spin } from "@arco-design/web-react";
import {
  IconCheckCircle,
  IconCloseCircle,
  IconExclamationCircle,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import { api, size } from "./shared";
import type { PlanView } from "./shared";
import { InstanceGraph, Segmented } from "./ui";
import type { Problem } from "./wbdoc";

/* ---------------------------------------------------------------- checks */

export type Check = {
  ok: boolean;
  errors: number;
  warnings: number;
  problems: Problem[];
  /** Warnings someone decided are fine; they are not counted. */
  ignored?: Problem[];
};

export function ProblemList({
  check,
  stale,
  open,
  ignore,
}: {
  check: Check | null;
  stale: boolean;
  /** Sets a warning aside, or takes that back. */
  ignore?: (p: Problem, undo?: boolean) => void;
  open: (
    file: string,
    line: number | undefined,
    path: string | undefined,
    source: boolean,
  ) => void;
}) {
  if (!check)
    return <p className="muted">还没有检查过。保存草稿后会自动检查。</p>;
  const groups = new Map<string, Problem[]>();
  check.problems.forEach((p) =>
    groups.set(p.file || "（整体）", [
      ...(groups.get(p.file || "（整体）") || []),
      p,
    ]),
  );
  return (
    <div className="wb-problems">
      <div className={`wb-verdict ${check.ok ? "ok" : "bad"}`}>
        {check.ok ? <IconCheckCircle /> : <IconCloseCircle />}
        <b>
          {check.ok
            ? check.warnings
              ? `没有错误，${check.warnings} 个提醒`
              : "全部通过"
            : `${check.errors} 处错误${check.warnings ? `，${check.warnings} 个提醒` : ""}`}
        </b>
        {stale && (
          <span className="muted small">（之后又改过，稍后自动重查）</span>
        )}
      </div>
      {[...groups.entries()].map(([file, list]) => (
        <section key={file}>
          <h3 className="mono">{file}</h3>
          {list.map((p, i) => (
            <div className={`wb-problem ${p.severity}`} key={i}>
              {p.severity === "error" ? (
                <IconCloseCircle />
              ) : (
                <IconExclamationCircle />
              )}
              <button
                type="button"
                className="wb-problem-main"
                disabled={!p.file}
                onClick={() => p.file && open(p.file, p.line, p.path, false)}
              >
                {p.path && <code>{p.path}</code>}
                {p.message}
              </button>
              {p.file === "component.yaml" && p.line ? (
                <button
                  type="button"
                  className="wb-link wb-problem-src"
                  onClick={() => open(p.file!, p.line, p.path, true)}
                >
                  源码第 {p.line} 行
                </button>
              ) : null}
              {p.severity === "warning" && ignore && (
                <button
                  type="button"
                  className="wb-link wb-problem-src"
                  title="看过了、确认没问题：以后不再提醒"
                  onClick={() => ignore(p)}
                >
                  忽略
                </button>
              )}
            </div>
          ))}
        </section>
      ))}
      {check.problems.length === 0 && (
        <p className="muted small">没有发现问题。</p>
      )}
      {(check.ignored || []).length > 0 && (
        <details className="wb-ignored">
          <summary>已忽略的提醒 {check.ignored!.length}</summary>
          {check.ignored!.map((p, i) => (
            <div className="wb-problem warning" key={i}>
              <span className="wb-problem-main muted">
                {p.file ? <code>{p.file}</code> : null}
                {p.message}
              </span>
              {ignore && (
                <button
                  type="button"
                  className="wb-link wb-problem-src"
                  onClick={() => ignore(p, true)}
                >
                  恢复提醒
                </button>
              )}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- markdown (just enough for the handbooks) */

function Md({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: React.ReactNode[] = [];
    const lines = text.split("\n");
    let i = 0;
    const inline = (s: string) =>
      s
        .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
        .map((x, k) =>
          x.startsWith("`") && x.endsWith("`") ? (
            <code key={k}>{x.slice(1, -1)}</code>
          ) : x.startsWith("**") && x.endsWith("**") ? (
            <b key={k}>{x.slice(2, -2)}</b>
          ) : (
            <React.Fragment key={k}>{x}</React.Fragment>
          ),
        );
    const cells = (l: string) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith("```")) {
        const buf: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```"))
          buf.push(lines[i++]);
        i++;
        out.push(
          <pre key={out.length} className="mono">
            {buf.join("\n")}
          </pre>,
        );
      } else if (/^#{1,4} /.test(l)) {
        const n = l.match(/^#+/)![0].length;
        out.push(
          React.createElement(
            `h${Math.min(n + 1, 5)}`,
            { key: out.length },
            inline(l.replace(/^#+ /, "")),
          ),
        );
        i++;
      } else if (l.trim().startsWith("|")) {
        const rows: string[][] = [];
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          if (!/^\|[\s:|-]+\|?$/.test(lines[i].trim()))
            rows.push(cells(lines[i]));
          i++;
        }
        const [head, ...body] = rows;
        out.push(
          <div className="wb-md-table" key={out.length}>
            <table>
              <thead>
                <tr>
                  {head.map((c, k) => (
                    <th key={k}>{inline(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((r, k) => (
                  <tr key={k}>
                    {r.map((c, j) => (
                      <td key={j}>{c ? inline(c) : "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      } else if (/^\s*[-*] /.test(l)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*] /.test(lines[i]))
          items.push(lines[i++].replace(/^\s*[-*] /, ""));
        out.push(
          <ul key={out.length}>
            {items.map((x, k) => (
              <li key={k}>{inline(x)}</li>
            ))}
          </ul>,
        );
      } else if (/^\s*\d+\. /.test(l) && !/^\s*\d+\. \S.*[：:]?$/.test("")) {
        const items: string[] = [];
        while (i < lines.length && /^\s*\d+\. /.test(lines[i]))
          items.push(lines[i++].replace(/^\s*\d+\. /, ""));
        out.push(
          <ol key={out.length}>
            {items.map((x, k) => (
              <li key={k}>{inline(x)}</li>
            ))}
          </ol>,
        );
      } else if (l.startsWith("> ")) {
        out.push(
          <blockquote key={out.length}>{inline(l.slice(2))}</blockquote>,
        );
        i++;
      } else if (l.trim()) {
        out.push(<p key={out.length}>{inline(l)}</p>);
        i++;
      } else i++;
    }
    return out;
  }, [text]);
  return <div className="wb-md">{blocks}</div>;
}

/* ---------------------------------------------------------------- trial generation */

type Preview = {
  delivery_modes?: string[];
  ok: boolean;
  error?: string;
  sample?: {
    delivery_mode?: string;
    instance: string;
    version: string;
    platform: string;
    preset?: string;
    hosts: string[];
    placement: Record<string, string[]>;
  };
  plan?: PlanView;
  issues: { severity: string; path?: string; message: string }[];
  handbooks: { name: string; markdown: string }[];
  files: {
    path: string;
    size: number;
    status: "same" | "added" | "changed" | "removed";
    diff?: string;
  }[];
  compared: boolean;
  changes: number;
  ansible: {
    ready: boolean;
    version?: string;
    reason?: string;
    where?: string;
  };
  syntax: { playbook: string; ok: boolean; output?: string }[];
  versions: string[];
  presets: { id: string; name: string; tag?: string }[];
  platforms: string[];
  roles: { name: string; title?: string; min: number; max: number }[];
  params: {
    key: string;
    label?: string;
    type: string;
    default?: unknown;
    options?: string[];
  }[];
};
/** A sample arranged by hand: how many machines, which hold each role, and parameters changed from their defaults. */
type Custom = {
  hosts: number;
  placement: Record<string, string[]>;
  params: Record<string, string>;
};

const STATUS: Record<string, string> = {
  added: "新增",
  changed: "有变化",
  removed: "已移除",
  same: "无变化",
};
type View = "overview" | "graph" | "steps" | "handbook" | "files" | "syntax";

export function PreviewDrawer({
  name,
  open,
  close,
  flush,
  openFile,
}: {
  name: string;
  open: boolean;
  close: () => void;
  flush: () => Promise<void>;
  openFile: (p: string) => void;
}) {
  const [req, setReq] = useState({ version: "", preset: "", platform: "", delivery_mode: "" });
  const [data, setData] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("overview");
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [handbook, setHandbook] = useState(0);
  const [custom, setCustom] = useState<Custom | null>(null);
  const [setup, setSetup] = useState(false);
  const loose = (v: string): unknown =>
    v === "true"
      ? true
      : v === "false"
        ? false
        : /^-?\d+(\.\d+)?$/.test(v.trim())
          ? Number(v)
          : v;
  const body = (r: typeof req, c: Custom | null) => ({
    ...r,
    ...(c
      ? {
          hosts: c.hosts,
          placement: c.placement,
          params: Object.fromEntries(
            Object.entries(c.params)
              .filter(([k]) => k)
              .map(([k, v]) => [k, loose(v)]),
          ),
        }
      : {}),
  });
  const requestID = useRef(0);
  const run = async (r = req, c: Custom | null = custom) => {
    const id = ++requestID.current;
    setBusy(true);
    setError("");
    try {
      await flush();
      const d = await api<Preview>(`/api/components/${name}/draft/preview`, {
        method: "POST",
        body: JSON.stringify(body(r, c)),
      });
      if (id !== requestID.current) return;
      setData(d);
      setHandbook(0);
    } catch (e) {
      if (id === requestID.current) setError((e as Error).message);
    } finally {
      if (id === requestID.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (open) run();
    return () => { requestID.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof typeof req) => (v: string) => {
    const next = { ...req, [k]: v || "" };
    setReq(next);
    // a different version, plan or system has different roles: go back to the automatic arrangement
    setCustom(null);
    run(next, null);
  };
  const openSetup = () => {
    if (!custom && data?.sample)
      setCustom({
        hosts: data.sample.hosts.length,
        placement: Object.fromEntries(Object.entries(data.sample.placement)),
        params: {},
      });
    setSetup((x) => !x);
  };
  const hosts = useMemo(
    () =>
      (data?.sample?.hosts || []).map((h, i) => ({
        name: h,
        ip: `10.0.0.${11 + i}`,
      })),
    [data],
  );
  const changedOnly = data?.compared && onlyChanged;
  const files = (data?.files || []).filter(
    (f) => !changedOnly || f.status !== "same",
  );
  const syntaxFail = data?.syntax.filter((s) => !s.ok).length || 0;
  return (
    <Drawer
      width={Math.min(980, window.innerWidth)}
      visible={open}
      onCancel={close}
      footer={null}
      title="试生成"
      unmountOnExit
    >
      <div className="wb-pv">
        {(data || error) && (
          <div className="wb-pv-bar">
            {data?.delivery_modes?.includes("configuration") && <div className="wb-pv-ctl">
              <span>交付内容</span>
              <Select size="small" aria-label="试生成交付内容" style={{width:160}} value={req.delivery_mode || data.sample?.delivery_mode || "offline"} onChange={set("delivery_mode")} options={[
                {value:"offline",label:"部署材料",disabled:!data.delivery_modes.some(m=>m==="offline"||m==="automatic")},
                {value:"configuration",label:"仅生成配置文件"}
              ]}/>
            </div>}
            <div className="wb-pv-ctl">
              <span>版本</span>
              <Select
                size="small"
                value={req.version || data?.sample?.version}
                options={(data?.versions || []).map((v) => ({
                  value: v,
                  label: v,
                }))}
                onChange={set("version")}
                style={{ width: 110 }}
                aria-label="版本"
              />
            </div>
            <div className="wb-pv-ctl">
              <span>方案</span>
              <Select
                size="small"
                allowClear
                placeholder="默认台数"
                value={req.preset || undefined}
                options={(data?.presets || []).map((p) => ({
                  value: p.id,
                  label: p.name + (p.tag ? ` · ${p.tag}` : ""),
                }))}
                onChange={set("preset")}
                style={{ width: 170 }}
                aria-label="方案"
              />
            </div>
            <div className="wb-pv-ctl">
              <span>系统</span>
              <Select
                size="small"
                value={req.platform || data?.sample?.platform}
                options={(data?.platforms || []).map((p) => ({
                  value: p,
                  label: p,
                }))}
                onChange={set("platform")}
                style={{ width: 170 }}
                aria-label="系统"
              />
            </div>
            <span className="wb-grow" />
            <Button
              size="small"
              type="primary"
              icon={<IconThunderbolt />}
              loading={busy}
              onClick={() => run()}
            >
              重新生成
            </Button>
          </div>
        )}
        <p className="wb-pv-lead">
          按草稿生成一套样例交付，走和真实交付完全相同的流程，但不碰任何机器。
        </p>
        {data && data.roles.length > 0 && (
          <div className="wb-sample">
            <button
              type="button"
              className="wb-sample-toggle"
              aria-expanded={setup}
              onClick={openSetup}
            >
              {setup
                ? "收起样例设置"
                : custom
                  ? "样例：已手动调整 · 修改"
                  : "调整样例：机器怎么放、改哪些参数"}
            </button>
            {setup && custom && (
              <SampleEditor
                data={data}
                value={custom}
                onChange={setCustom}
                busy={busy}
                run={() => run(req, custom)}
                reset={() => {
                  setCustom(null);
                  setSetup(false);
                  run(req, null);
                }}
              />
            )}
          </div>
        )}
        {error && <p className="bad">{error}</p>}
        {!data && busy && (
          <div className="wb-pv-wait">
            <Spin /> 正在生成…
          </div>
        )}
        {data && (
          <div className={busy ? "wb-pv-body busy" : "wb-pv-body"}>
            {!data.ok ? (
              <div className="note warn" style={{ whiteSpace: "pre-wrap" }}>
                {data.error}
              </div>
            ) : (
              <>
                <div className="wb-pv-tabs">
                  <Segmented<View>
                    label="结果"
                    value={view}
                    onChange={setView}
                    options={[
                      { value: "overview", label: "概览" },
                      { value: "graph", label: "拓扑" },
                      { value: "steps", label: "步骤" },
                      { value: "handbook", label: "手册" },
                      {
                        value: "files",
                        label: "文件与差异",
                        count: data.compared ? data.changes : undefined,
                      },
                      {
                        value: "syntax",
                        label: "Ansible 检查",
                        count: syntaxFail || undefined,
                      },
                    ]}
                  />
                </div>
                {view === "overview" && (
                  <div className="wb-pv-view">
                    <dl className="wb-facts">
                      <div>
                        <dt>样例</dt>
                        <dd>
                          实例 <b className="mono">{data.sample?.instance}</b> ·
                          版本 {data.sample?.version} · {data.sample?.platform}
                        </dd>
                      </div>
                      <div>
                        <dt>机器</dt>
                        <dd>
                          {Object.entries(data.sample?.placement || {})
                            .map(([r, h]) => `${r}：${h.join("、")}`)
                            .join("；")}
                        </dd>
                      </div>
                      <div>
                        <dt>生成结果</dt>
                        <dd>
                          {data.files.length} 个文件，
                          {data.plan?.phases?.reduce(
                            (n, p) => n + p.steps.length,
                            0,
                          ) ?? 0}{" "}
                          个部署步骤
                        </dd>
                      </div>
                      <div>
                        <dt>和已发布版本相比</dt>
                        <dd>
                          {data.compared
                            ? data.changes
                              ? `${data.changes} 个生成文件不同（在「文件与差异」里看）`
                              : "生成结果完全相同"
                            : "没有已发布的版本可比（这是一个新组件）"}
                        </dd>
                      </div>
                      <div>
                        <dt>Ansible 检查</dt>
                        <dd>
                          {data.sample?.delivery_mode === "configuration" ? "本次仅生成配置文件，不需要执行脚本检查" : data.ansible.ready ? (
                            syntaxFail ? (
                              <span className="bad">
                                {syntaxFail} 个 playbook 语法有误
                              </span>
                            ) : (
                              <span className="ok">
                                {data.syntax.length} 个 playbook
                                语法全部通过（ansible-core{" "}
                                {data.ansible.version}）
                              </span>
                            )
                          ) : (
                            <span className="warn">{data.ansible.reason}</span>
                          )}
                        </dd>
                      </div>
                    </dl>
                    {data.issues.length > 0 && (
                      <div className="wb-pv-issues">
                        <h3>样例交付的提示</h3>
                        {data.issues.map((i, k) => (
                          <div className={`issue-line ${i.severity}`} key={k}>
                            {i.path && <code>{i.path}</code>}
                            <span>{i.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {view === "graph" && (
                  <div className="wb-pv-view">
                    {data.plan && (
                      <InstanceGraph
                        hosts={hosts}
                        instances={data.plan.instances}
                        controller={data.plan.controller}
                        layout="row"
                      />
                    )}
                    <p className="muted small">
                      拓扑图来自你声明的角色和数据流。数据流画不出来，通常是
                      flows 里的 from/to 角色名写错，或 when 条件不成立。
                    </p>
                  </div>
                )}
                {view === "steps" && (
                  <div className="wb-pv-view">
                    {data.plan?.phases?.map((ph) => (
                      <section key={ph.phase} className="wb-pv-phase">
                        <h3>
                          {ph.title}{" "}
                          <span className="mono faint">{ph.phase}</span>
                        </h3>
                        {ph.steps.map((s, i) => (
                          <div
                            className={`wb-pv-step ${s.skipped ? "skipped" : ""}`}
                            key={i}
                          >
                            <div className="wb-pv-step-top">
                              <b>{s.title}</b>
                              <span className={`flag eff-${s.effect}`}>
                                {{
                                  "read-only": "只读",
                                  change: "修改",
                                  disruptive: "中断服务",
                                  destructive: "删除数据",
                                }[s.effect] || s.effect}
                              </span>
                              <span className="faint small">
                                {s.hosts?.join("、")}
                              </span>
                            </div>
                            {s.desc && <p>{s.desc}</p>}
                            {s.expect && (
                              <p className="muted small">
                                成功的样子：{s.expect}
                              </p>
                            )}
                            {s.skipped && (
                              <p className="warn small">不执行：{s.skipped}</p>
                            )}
                          </div>
                        ))}
                      </section>
                    ))}
                  </div>
                )}
                {view === "handbook" && (
                  <div className="wb-pv-view">
                    <div className="wb-hb-tabs">
                      {data.handbooks.map((h, i) => (
                        <button
                          type="button"
                          key={h.name}
                          className={i === handbook ? "on" : ""}
                          onClick={() => setHandbook(i)}
                        >
                          {h.name.replace(/\.md$/, "")}
                        </button>
                      ))}
                    </div>
                    {data.handbooks[handbook] && (
                      <Md text={data.handbooks[handbook].markdown} />
                    )}
                  </div>
                )}
                {view === "files" && (
                  <div className="wb-pv-view">
                    {data.compared && (
                      <label className="wb-check">
                        <input
                          type="checkbox"
                          checked={onlyChanged}
                          onChange={(e) => setOnlyChanged(e.target.checked)}
                        />{" "}
                        只看有变化的（{data.changes} / {data.files.length}）
                      </label>
                    )}
                    {files.length === 0 && (
                      <p className="muted">生成结果和已发布版本完全相同。</p>
                    )}
                    {files.map((f) => (
                      <details
                        className={`wb-pv-file ${f.status}`}
                        key={f.path}
                        open={f.status === "changed" && files.length <= 4}
                      >
                        <summary>
                          <span className="mono">{f.path}</span>
                          {data.compared && (
                            <i className={`wb-st ${f.status}`}>
                              {STATUS[f.status]}
                            </i>
                          )}
                          <em>{size(f.size)}</em>
                        </summary>
                        {f.diff ? (
                          <Diff text={f.diff} />
                        ) : f.status === "same" ||
                          f.status === "removed" ? null : (
                          <p className="muted small">
                            新文件，内容见下载的交付。
                          </p>
                        )}
                        {f.path.startsWith("roles/") &&
                          !/roles\/mw_/.test(f.path) && (
                            <button
                              type="button"
                              className="wb-link"
                              onClick={() => openFile(f.path)}
                            >
                              在编辑器中打开
                            </button>
                          )}
                      </details>
                    ))}
                  </div>
                )}
                {view === "syntax" && (
                  <div className="wb-pv-view">
                    {!data.ansible.ready ? (
                      <div className="note warn">{data.ansible.reason}</div>
                    ) : (
                      <>
                        <p className="muted small">
                          用 ansible-core {data.ansible.version}（
                          {data.ansible.where}）对每个生成的 playbook 做{" "}
                          <code>--syntax-check</code>
                          ：能发现缩进、关键字、任务结构的错误；不会连接任何机器，也不会检查模板里的变量是否存在。
                        </p>
                        {data.syntax.map((s) => (
                          <details
                            className={`wb-pv-file ${s.ok ? "same" : "removed"}`}
                            key={s.playbook}
                            open={!s.ok}
                          >
                            <summary>
                              <span className="mono">{s.playbook}</span>
                              <i
                                className={`wb-st ${s.ok ? "added" : "removed"}`}
                              >
                                {s.ok ? "通过" : "有误"}
                              </i>
                            </summary>
                            {s.output && (
                              <pre className="wb-render-out mono">
                                {s.output}
                              </pre>
                            )}
                          </details>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

const LAST_N = 12;

/** Arrange the sample by hand: a grid of roles against machines, and parameter values. */
function SampleEditor({
  data,
  value,
  onChange,
  run,
  reset,
  busy,
}: {
  data: Preview;
  value: Custom;
  onChange: (c: Custom) => void;
  run: () => void;
  reset: () => void;
  busy: boolean;
}) {
  const hostNames = Array.from(
    { length: value.hosts },
    (_, i) => `host${i + 1}`,
  );
  const has = (role: string, h: string) =>
    (value.placement[role] || []).includes(h);
  const toggle = (role: string, h: string) => {
    const cur = value.placement[role] || [];
    onChange({
      ...value,
      placement: {
        ...value.placement,
        [role]: has(role, h)
          ? cur.filter((x) => x !== h)
          : [...cur, h].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))),
      },
    });
  };
  const setHosts = (n: number) => {
    const hosts = Math.max(1, Math.min(LAST_N, n));
    const keep = new Set(
      Array.from({ length: hosts }, (_, i) => `host${i + 1}`),
    );
    onChange({
      ...value,
      hosts,
      placement: Object.fromEntries(
        Object.entries(value.placement).map(([r, hs]) => [
          r,
          hs.filter((h) => keep.has(h)),
        ]),
      ),
    });
  };
  const rows = Object.entries(value.params);
  const setRow = (i: number, k: string, v: string) =>
    onChange({
      ...value,
      params: Object.fromEntries(
        rows.map(([a, b], j) => (j === i ? [k, v] : [a, b])),
      ),
    });
  const dup = new Set<string>();
  return (
    <div className="wb-sample-body">
      <div className="wb-sample-sec">
        <h4>机器与角色</h4>
        <div className="wb-sample-hosts">
          <span>机器数</span>
          <Button
            size="mini"
            aria-label="减少一台"
            disabled={value.hosts <= 1}
            onClick={() => setHosts(value.hosts - 1)}
          >
            −
          </Button>
          <b className="num">{value.hosts}</b>
          <Button
            size="mini"
            aria-label="增加一台"
            disabled={value.hosts >= LAST_N}
            onClick={() => setHosts(value.hosts + 1)}
          >
            +
          </Button>
        </div>
        <div
          className="wb-grid-matrix"
          style={{
            gridTemplateColumns: `minmax(120px, 1.4fr) repeat(${hostNames.length}, minmax(44px, 1fr)) 70px`,
          }}
          role="grid"
        >
          <span />
          {hostNames.map((h) => (
            <span key={h} className="mono faint small">
              {h}
            </span>
          ))}
          <span className="faint small">台数要求</span>
          {data.roles.map((r) => {
            const n = (value.placement[r.name] || []).length;
            const bad = n < r.min || (r.max > 0 && n > r.max);
            return (
              <div
                className="wb-matrix-row"
                key={r.name}
                role="row"
                style={{ display: "contents" }}
              >
                <span>
                  <b>{r.title || r.name}</b>{" "}
                  <span className="mono faint small">{r.name}</span>
                </span>
                {hostNames.map((h) => (
                  <span key={h} role="gridcell">
                    <input
                      type="checkbox"
                      checked={has(r.name, h)}
                      onChange={() => toggle(r.name, h)}
                      aria-label={`${r.title || r.name} 放在 ${h}`}
                    />
                  </span>
                ))}
                <span className={bad ? "bad small" : "faint small"}>
                  {n} /{" "}
                  {r.max
                    ? r.min === r.max
                      ? r.min
                      : `${r.min}–${r.max}`
                    : `${r.min}+`}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="wb-sample-sec">
        <h4>参数（不改的用默认值）</h4>
        {rows.map(([k, v], i) => {
          const def = data.params.find((p) => p.key === k);
          dup.add(k);
          return (
            <div className="wb-map-row" key={i}>
              <Select
                size="small"
                showSearch
                value={k || undefined}
                placeholder="选择参数"
                options={data.params
                  .filter((p) => p.key === k || !(k in value.params) || true)
                  .map((p) => ({
                    value: p.key,
                    label: `${p.label || p.key}（${p.key}）`,
                  }))}
                onChange={(nk) => setRow(i, nk, "")}
                aria-label="参数"
              />
              {def?.type === "enum" && def.options ? (
                <Select
                  size="small"
                  value={v || undefined}
                  options={def.options.map((o) => ({ value: o, label: o }))}
                  onChange={(nv) => setRow(i, k, nv)}
                  aria-label="值"
                />
              ) : def?.type === "bool" ? (
                <Select
                  size="small"
                  value={v || undefined}
                  options={[
                    { value: "true", label: "开" },
                    { value: "false", label: "关" },
                  ]}
                  onChange={(nv) => setRow(i, k, nv)}
                  aria-label="值"
                />
              ) : (
                <input
                  className="arco-input arco-input-size-small wb-mono"
                  value={v}
                  placeholder={
                    def?.default !== undefined
                      ? `默认 ${String(def.default)}`
                      : "值"
                  }
                  onChange={(e) => setRow(i, k, e.target.value)}
                  aria-label="值"
                />
              )}
              <Button
                size="mini"
                type="text"
                status="danger"
                onClick={() =>
                  onChange({
                    ...value,
                    params: Object.fromEntries(rows.filter((_, j) => j !== i)),
                  })
                }
              >
                删除
              </Button>
            </div>
          );
        })}
        <Button
          size="mini"
          type="text"
          disabled={"" in value.params}
          onClick={() =>
            onChange({ ...value, params: { ...value.params, "": "" } })
          }
        >
          + 改一个参数
        </Button>
      </div>
      <div className="wb-sample-actions">
        <Button size="small" onClick={reset}>
          恢复自动摆放
        </Button>
        <Button size="small" type="primary" loading={busy} onClick={run}>
          按这个样例生成
        </Button>
      </div>
    </div>
  );
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="wb-diff mono">
      {text.split("\n").map((l, i) => (
        <span
          key={i}
          className={
            l.startsWith("+ ")
              ? "add"
              : l.startsWith("- ")
                ? "del"
                : l.startsWith("…")
                  ? "gap"
                  : ""
          }
        >
          {l}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

export { Diff };

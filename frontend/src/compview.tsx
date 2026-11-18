import { memo, useEffect, useMemo, useRef, useState } from "react";
import { OsLogo } from "./oslogo";
import { parse } from "yaml";
import {
  Button,
  Input,
  Message,
  Modal,
  Radio,
  Skeleton,
} from "@arco-design/web-react";
import {
  IconCode,
  IconDown,
  IconEdit,
  IconExclamationCircle,
  IconRefresh,
  IconRight,
} from "@arco-design/web-react/icon";
import { api, ago, cached, can, err, putCached, useAIStatus } from "./shared";
import type { AppInfo } from "./shared";
import { go } from "./router";
import { StatusBadge, UnderlineTabs } from "./ui";
import { styleOf } from "./glyphs";
import { TopoArt } from "./topoart";
import { Terminal } from "./runbook";

const CvIcons: Record<string, React.ReactNode> = {
  versions: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <path d="M8 2.2L13.5 5 8 7.8 2.5 5 8 2.2Z" />
      <path d="M2.5 8.2L8 11l5.5-2.8" />
      <path d="M2.5 11.2L8 14l5.5-2.8" />
    </svg>
  ),
  flow: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <circle cx="3.8" cy="4.2" r="1.8" />
      <circle cx="12.2" cy="4.2" r="1.8" />
      <circle cx="8" cy="12" r="1.8" />
      <path d="M5.6 4.2h4.8M4.8 5.8l2.2 4.6M11.2 5.8L9 10.4" />
    </svg>
  ),
  params: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      <circle cx="5.8" cy="4.5" r="1.5" fill="var(--surface)" />
      <circle cx="10.5" cy="8" r="1.5" fill="var(--surface)" />
      <circle cx="6.8" cy="11.5" r="1.5" fill="var(--surface)" />
    </svg>
  ),
  tests: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <path d="M8 2.2L13 4.1v3.7c0 3.1-2.1 5.2-5 6-2.9-.8-5-2.9-5-6V4.1L8 2.2Z" />
      <path d="M5.8 8.1l1.5 1.5 2.9-3" />
    </svg>
  ),
  links: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <path d="M6.6 9.4l2.8-2.8" />
      <path d="M9.2 10.6l-1.3 1.3a2.4 2.4 0 0 1-3.4-3.4l1.3-1.3" />
      <path d="M6.8 5.4l1.3-1.3a2.4 2.4 0 0 1 3.4 3.4l-1.3 1.3" />
    </svg>
  ),
  about: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M9.8 6.2L8.7 8.7 6.2 9.8l1.1-2.5 2.5-1.1Z" />
    </svg>
  ),
  ops: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <path d="M2 8.2h2.6l1.7-3.6 2.8 6.8 1.8-3.2H14" />
    </svg>
  ),
  revs: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2.2 1.4" />
    </svg>
  ),
  source: (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
    >
      <path d="M5.4 5.2L2.5 8l2.9 2.8M10.6 5.2L13.5 8l-2.9 2.8M9 3.6L7 12.4" />
    </svg>
  ),
};

/* A published component read as one page. Everything a person needs before using or changing it is on the page —
   how it is deployed, what can be tuned, how it is checked, what it connects to — in that order, each part short.
   A rail on the right keeps the shape of the component and a table of contents in view. */

type Any = Record<string, any>;
const PHASES: [string, string][] = [
  ["preflight", "预检"],
  ["install", "安装"],
  ["configure", "配置"],
  ["start", "启动"],
  ["provision", "初始化"],
  ["verify", "复核"],
];
const EFFECT: Record<string, [string, string]> = {
  "read-only": ["只读", "ok"],
  change: ["修改", ""],
  disruptive: ["中断服务", "bad"],
  destructive: ["删除数据", "bad"],
};
const VERSION_STATE: Record<string, [string, string]> = {
  published: ["done", "已发布"],
  verifying: ["queued", "待验证"],
  draft: ["idle", "草稿"],
};
const show = (v: unknown) =>
  v === undefined || v === null || v === "" ? "—" : String(v);
type Rev = {
  rev: number;
  time: string;
  user: string;
  note?: string;
  added: number;
  removed: number;
  changed: number;
};

const Steps = memo(function Steps({
  steps,
  start = 1,
}: {
  steps: Any[];
  start?: number;
}) {
  return (
    <ol className="cv-steps">
      {steps.map((s, i) => {
        const [label, tone] = EFFECT[s.effect || "change"] || [s.effect, ""];
        return (
          <li key={i}>
            <span className="cv-n">{start + i}</span>
            <div>
              <div className="cv-step-top">
                <b>{s.title || s.id}</b>
                <span
                  className={`flag ${tone === "ok" ? "cv-ok" : tone === "bad" ? "bad" : "cv-mute"}`}
                >
                  {label}
                </span>
                {s.run ? (
                  <span className="mono faint small">
                    {s.run.role}/{s.run.tasks}
                  </span>
                ) : s.tasks ? (
                  <span className="faint small">
                    {s.tasks.length} 个内联任务
                  </span>
                ) : null}
              </div>
              {s.desc && <p>{s.desc}</p>}
              {s.expect && <p className="cv-expect">成功的样子：{s.expect}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
});

const STATUS_CHOICES: { v: string; label: string; hint: string }[] = [
  { v: "draft", label: "草稿", hint: "还没验证过，只给自己试" },
  {
    v: "verifying",
    label: "待验证",
    hint: "能生成交付，但还没有在空环境真正部署过；用它生成交付时会提示“不要用于生产”",
  },
  {
    v: "published",
    label: "已发布",
    hint: "已经在空环境真正部署并跑通了测试，可以用于生产",
  },
];

/** A version's status, and for those who may publish, the way to change it: say where it was verified and it is recorded
 *  as a revision of the component (who, when, what), so the status is never just a word someone typed. */
function VersionStatus({
  name,
  v,
  tone,
  label,
}: {
  name: string;
  v: { id: string; status: string };
  tone: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(v.status);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api(
        `/api/components/${name}/versions/${encodeURIComponent(v.id)}/status`,
        { method: "POST", body: JSON.stringify({ status, note }) },
      );
      Message.success(
        `版本 ${v.id} 已改为「${STATUS_CHOICES.find((c) => c.v === status)?.label}」`,
      );
      setOpen(false);
      window.dispatchEvent(new Event("mh-apps-changed"));
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <StatusBadge state={tone} label={label} />
      {can("component.publish") && (
        <button
          type="button"
          className="cv-vedit"
          aria-label={`修改版本 ${v.id} 的状态`}
          onClick={() => {
            setStatus(v.status);
            setNote("");
            setOpen(true);
          }}
        >
          <IconEdit /> 改状态
        </button>
      )}
      <Modal
        visible={open}
        title={`版本 ${v.id} 的状态`}
        okText="保存"
        confirmLoading={busy}
        onOk={save}
        onCancel={() => !busy && setOpen(false)}
        okButtonProps={{
          disabled:
            status === v.status || (status === "published" && !note.trim()),
        }}
      >
        <Radio.Group
          direction="vertical"
          value={status}
          onChange={setStatus}
          className="cv-vradio"
        >
          {STATUS_CHOICES.map((c) => (
            <Radio key={c.v} value={c.v}>
              <b>{c.label}</b>
              <span className="faint small"> {c.hint}</span>
            </Radio>
          ))}
        </Radio.Group>
        <label className="cv-vnote">
          <span>
            {status === "published" ? "在哪验证的（必填）" : "说明（可选）"}
          </span>
          <Input.TextArea
            value={note}
            onChange={setNote}
            maxLength={200}
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder={
              status === "published"
                ? "例如：2026-10-27 在三台全新 Ubuntu 24.04 上部署并通过全部测试"
                : ""
            }
          />
        </label>
        <p className="faint small">
          保存后会记为这个组件的一次修订，可以在工作台的历史里看到是谁、什么时候、因为什么改的。
        </p>
      </Modal>
    </>
  );
}

export function ComponentPanes({
  entry,
  yaml,
  admin,
  error,
  onRetry,
}: {
  entry: AppInfo & { source: string; broken?: boolean; problem?: string };
  yaml: string | null;
  admin: boolean;
  error: string;
  onRetry?: () => void;
}) {
  const revsUrl = `/api/components/${encodeURIComponent(entry.id)}/revisions`;
  const [revs, setRevs] = useState<Rev[] | null>(
    () => cached<Rev[]>(revsUrl) ?? null,
  );
  const [active, setActive] = useState("versions");
  const box = useRef<HTMLDivElement>(null);
  const lock = useRef(0); // while a click is scrolling the page, the table of contents keeps the clicked entry
  const [srcOpen, setSrcOpen] = useState(false);
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null); // the part the reader just asked for, briefly lit
  const [phase, setPhase] = useState("");
  const tocRef = useRef<HTMLElement>(null);
  const manifest = useMemo(() => {
    if (yaml === null) return {value:null as Any | null,error:""};
    try {
      const value=parse(yaml);
      if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("清单应为一个对象");
      const checkReferences=(v:any):void=>{
        if(!v || typeof v!=="object")return;
        if(Object.prototype.hasOwnProperty.call(v,"$file"))throw new Error("清单引用尚未展开，请刷新页面；如仍有问题，请在组件编辑器检查引用文件");
        Object.values(v).forEach(checkReferences);
      };
      checkReferences(value);
      for(const key of ["requires","params","roles","versions","tests","cleanup","endpoints","ports","secrets","inputs","flows","groups"]){
        if(value[key]!=null && !Array.isArray(value[key]))throw new Error(key+" 应为列表，请在组件编辑器修正");
      }
      for(const key of ["lifecycle"]){
        if(value[key]!=null && (typeof value[key]!=="object" || Array.isArray(value[key])))throw new Error(key+" 应为阶段映射");
        for(const steps of Object.values(value[key] || {}))if(!Array.isArray(steps))throw new Error(key+" 的阶段应为步骤列表");
      }
      return {value:value as Any,error:""};
    } catch(e) {return {value:null as Any | null,error:String(e instanceof Error?e.message:e)};}
  }, [yaml]);
  const c=manifest.value;
  const draftOnly = entry.source === "draft";
  useEffect(() => {
    if (!admin || draftOnly) return;
    const hit = cached<Rev[]>(revsUrl);
    if (hit !== undefined) setRevs(hit);
    api<Rev[]>(revsUrl)
      .then((r) => {
        const revList = [...r].reverse();
        putCached(revsUrl, revList);
        setRevs(revList);
      })
      .catch(() => setRevs((prev) => prev ?? []));
  }, [admin, draftOnly, entry.id, entry.source, revsUrl]);

  const lifecycle: Record<string, Any[]> = c?.lifecycle || {};
  const params: Any[] = c?.params || [];
  const stepCount = Object.values(lifecycle).reduce((n, l) => n + l.length, 0);
  const external = entry.kind === "external" || c?.kind === "external";
  const sections: [string, string, number | undefined][] = [
    ["versions", "版本", entry.versions.length],
    ...(external
      ? []
      : ([["flow", "部署流程", stepCount]] as [string, string, number][])),
    ["params", "参数", params.length],
    [
      "tests",
      "验证与清理",
      (c?.tests?.length || 0) + (c?.cleanup?.length || 0),
    ],
    [
      "links",
      "入口与关系",
      (c?.endpoints?.length || 0) +
        (c?.requires?.length || 0) +
        (c?.ports?.length || 0),
    ],
    [
      "about",
      "能力与限制",
      (c?.detail?.capabilities?.length || 0) +
        (c?.detail?.limits?.length || 0) || undefined,
    ],
    ...(external
      ? []
      : ([
          [
            "ops",
            "运维知识",
            (entry.operations?.checks?.length || 0) +
              (entry.operations?.faults?.length || 0) || undefined,
          ],
        ] as [string, string, number | undefined][])),
    ...(admin
      ? ([["revs", "修订", revs?.length]] as [
          string,
          string,
          number | undefined,
        ][])
      : []),
    ["source", "清单源码", yaml ? yaml.split("\n").length : undefined],
  ];

  // the table of contents follows the reader
  useEffect(() => {
    const root = box.current;
    if (!root || !c) return;
    let raf = 0;

    const findScrollParent = (el: HTMLElement): HTMLElement | null => {
      let p = el.parentElement;
      while (
        p &&
        !(
          /(auto|scroll)/.test(getComputedStyle(p).overflowY) &&
          p.scrollHeight > p.clientHeight + 1
        )
      ) {
        p = p.parentElement;
      }
      return p || (document.scrollingElement as HTMLElement | null);
    };

    const compute = () => {
      if (Date.now() < lock.current) return;
      const secs = Array.from(
        root.querySelectorAll<HTMLElement>("section[id^='cv-']"),
      );
      if (!secs.length) return;

      const sc = findScrollParent(secs[0]);
      const isDoc =
        !sc ||
        sc === document.scrollingElement ||
        sc === document.documentElement ||
        sc === document.body;
      const viewTop = isDoc ? 0 : sc.getBoundingClientRect().top;
      const viewH = isDoc ? window.innerHeight : sc.clientHeight;
      const scrollTop = isDoc ? window.scrollY : sc.scrollTop;
      const maxScroll = sc ? Math.max(0, sc.scrollHeight - viewH) : 0;
      const remaining = Math.max(0, maxScroll - scrollTop);

      if (maxScroll > 2 && remaining <= 6) {
        setActive(secs[secs.length - 1].id.replace(/^cv-/, ""));
        return;
      }

      const baseOffset = Math.min(104, viewH * 0.2);
      const bottomOffset = Math.max(baseOffset, viewH - 24);
      const tailSpan =
        maxScroll > 2 ? Math.min(maxScroll, Math.max(180, viewH * 0.6)) : 0;
      const tailProgress =
        tailSpan > 0 ? Math.max(0, Math.min(1, 1 - remaining / tailSpan)) : 0;
      const anchorY =
        viewTop + baseOffset + tailProgress * (bottomOffset - baseOffset);

      let chosen = secs[0];
      for (const sec of secs) {
        if (sec.getBoundingClientRect().top <= anchorY) chosen = sec;
      }
      setActive(chosen.id.replace(/^cv-/, ""));
    };

    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        compute();
      });
    };

    compute();
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [c]);

  if (draftOnly) return null;
  const loadErr = error || manifest.error;
  if (loadErr) {
    if (entry.broken && !c) return null;
    const missingShared =
      /\$file|common|shared|公共|引用|not found|no such file|不存在/i.test(
        loadErr,
      );
    return (
      <div className="cv-err-panel" role="alert">
        <div className="cv-err-head">
          <IconExclamationCircle className="cv-err-ic" />
          <div>
            <b>组件清单暂时无法载入</b>
            <p>
              {missingShared
                ? "检测到清单引用或共享流程文件缺失，请确认平台公共流程（platform-shared）或组件内的被引用文件是否存在。"
                : "清单语法或字段结构未通过校验，请在组件编辑器中检查修正后重新载入。"}
            </p>
          </div>
        </div>
        <pre className="cv-err-detail mono">{loadErr}</pre>
        <div className="cv-err-acts">
          {onRetry && (
            <Button size="small" icon={<IconRefresh />} onClick={onRetry}>
              重新载入
            </Button>
          )}
          {admin && (
            <Button
              size="small"
              type="primary"
              icon={<IconEdit />}
              onClick={() =>
                go({ name: "components", id: entry.id, edit: "overview" })
              }
            >
              打开编辑器排障
            </Button>
          )}
          {admin && (
            <Button
              size="small"
              icon={<IconCode />}
              onClick={() =>
                go({
                  name: "components",
                  id: "platform-shared",
                  edit: "files",
                })
              }
            >
              检查平台公共流程
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (c === null) return <Skeleton animation text={{ rows: 8 }} />;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lightUp = (id: string) => {
    setFlash({ id, n: Date.now() });
    window.setTimeout(
      () => setFlash((f) => (f && f.id === id ? null : f)),
      2000,
    );
  };
  // The browser's own smooth scrolling takes longer the further it goes; this always takes about a third of a second,
  // so jumping across the whole page is as quick as jumping to the next part.
  const scrollTo = (id: string, where: "start" | "center") => {
    const el = document.getElementById(id);
    if (!el) return;
    // the page may scroll in the window or in a pane around it; find whichever really scrolls
    let sc: HTMLElement | null = el.parentElement;
    while (
      sc &&
      !(
        /(auto|scroll)/.test(getComputedStyle(sc).overflowY) &&
        sc.scrollHeight > sc.clientHeight + 1
      )
    )
      sc = sc.parentElement;
    const top = (sc ? sc.getBoundingClientRect().top : 0) + 76;
    const viewH = sc ? sc.clientHeight : window.innerHeight;
    const cur = () => (sc ? sc.scrollTop : window.scrollY);
    const set = (y: number) =>
      sc ? (sc.scrollTop = y) : window.scrollTo(0, y);
    const r = el.getBoundingClientRect();
    const target = Math.max(
      0,
      cur() +
        r.top -
        (where === "start"
          ? top
          : (viewH - r.height) / 2 + (sc ? sc.getBoundingClientRect().top : 0)),
    );
    if (reduced) return set(target);
    const from = cur();
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 360);
      set(from + (target - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const jump = (id: string) => {
    lock.current = Date.now() + 700;
    setActive(id);
    setPhase("");
    scrollTo(`cv-${id}`, "start");
    lightUp(`cv-${id}`);
  };
  const jumpPhase = (id: string) => {
    lock.current = Date.now() + 700;
    setActive("flow");
    setPhase(id);
    scrollTo(`cv-ph-${id}`, "center");
    lightUp(`cv-ph-${id}`);
  };
  const lit = (id: string) => (flash?.id === id ? "lit" : "");
  const st = styleOf(entry.id, entry.category, entry.icon, entry.color);

  return (
    <div className="cv-wrap" ref={box}>
      <UnderlineTabs
        className="cv-utabs"
        label="组件详情分区"
        value={active}
        onChange={jump}
        items={sections.map(([id, label, count]) => ({
          value: id,
          label,
          count,
          icon: CvIcons[id],
        }))}
      />
      <div className="cv2">
        <div className="cv2-main">
          <section id="cv-versions" className={`cv-sec ${lit("cv-versions")}`}>
          <h2>版本</h2>
          <ul className="cv-versions">
            {entry.versions.map((v) => {
              const [tone, label] =
                VERSION_STATE[v.status] || VERSION_STATE.draft;
              return (
                <li key={v.id}>
                  <b className="mono">{v.id}</b>
                  <VersionStatus
                    name={entry.id}
                    v={v}
                    tone={tone}
                    label={label}
                  />
                  <span className="cv-plats">
                    {(v.platforms || []).map((p) => {
                      const k = v.coverage?.[p];
                      return (
                        <span
                          key={p}
                          className={`cv-plat ${k ? (k.deployable ? "ok" : "warn") : ""}`}
                        >
                          <OsLogo id={p} size={13} /> {p.replace("-amd64", "")}
                          {k
                            ? k.deployable
                              ? " · 可生成"
                              : k.ready
                                ? " · 缺运行环境"
                                : ` · 缺 ${k.missing?.length ?? ""} 个包`
                            : ""}
                        </span>
                      );
                    })}
                    {!v.platforms?.length && (
                      <span className="faint small">
                        {external ? "不安装到机器上" : "没有声明支持的系统"}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {!external && (
          <section id="cv-flow" className={`cv-sec ${lit("cv-flow")}`}>
            <h2>
              部署流程
              <span className="cv-sub">
                平台按这些步骤生成 Ansible
                脚本和部署手册，每一步都会出现在交付的手册里
              </span>
            </h2>
            <ol className="cv-pipe" aria-label="部署阶段">
              {PHASES.map(([id, label]) => {
                const n = lifecycle[id]?.length || 0;
                return (
                  <li
                    key={id}
                    className={`${n ? "" : "empty"} ${phase === id ? "on" : ""}`}
                  >
                    <button
                      type="button"
                      disabled={!n}
                      onClick={() => jumpPhase(id)}
                    >
                      <b>{label}</b>
                      <span>{n ? `${n} 步` : "—"}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            {stepCount === 0 && (
              <p className="muted">这个组件没有声明部署步骤。</p>
            )}
            {PHASES.filter(([id]) => lifecycle[id]?.length).map(
              ([id, label]) => (
                <div
                  className={`cv-phase ${lit(`cv-ph-${id}`)}`}
                  key={id}
                  id={`cv-ph-${id}`}
                >
                  <h3>
                    {label}
                    <span className="mono faint small">{id}</span>
                  </h3>
                  <Steps steps={lifecycle[id]} />
                </div>
              ),
            )}
          </section>
        )}

        <section id="cv-params" className={`cv-sec ${lit("cv-params")}`}>
          <h2>
            参数
            <span className="cv-sub">
              新建集群时可以调整；超出范围或不满足规则会被拦下
            </span>
          </h2>
          <Params c={c} />
        </section>

        <section id="cv-tests" className={`cv-sec ${lit("cv-tests")}`}>
          <h2>
            验证与清理
            <span className="cv-sub">
              部署完成后交给人执行的验收，以及拆除时的步骤
            </span>
          </h2>
          {c.tests?.length > 0 && (
            <div className="cv-phase">
              <h3>功能测试</h3>
              <Steps steps={c.tests} />
            </div>
          )}
          {c.cleanup?.length > 0 && (
            <div className="cv-phase">
              <h3>清理</h3>
              <Steps steps={c.cleanup} />
            </div>
          )}
          {!c.tests?.length && !c.cleanup?.length && (
            <p className="muted">这个组件没有声明验收测试和清理步骤。</p>
          )}
        </section>

        <section id="cv-links" className={`cv-sec ${lit("cv-links")}`}>
          <h2>入口与关系</h2>
          <Links c={c} />
        </section>

        <section id="cv-about" className={`cv-sec ${lit("cv-about")}`}>
          <h2>能力与限制</h2>
          <About c={c} />
        </section>

        {!external && (
          <section id="cv-ops" className={`cv-sec ${lit("cv-ops")}`}>
            <h2>
              运维知识
              <span className="cv-sub">
                写进每个集群的运维交接文档，按实际拓扑和参数展开
              </span>
            </h2>
            <Ops o={entry.operations} />
          </section>
        )}

        {admin && (
          <section id="cv-revs" className={`cv-sec ${lit("cv-revs")}`}>
            <h2>修订</h2>
            {revs === null ? (
              <Skeleton animation text={{ rows: 3 }} />
            ) : revs.length === 0 ? (
              <p className="muted">
                还没有修订。通过工作台发布或导入组件包后，每一次都会留下一条。
              </p>
            ) : (
              <ol className="cv-revs">
                {revs.slice(0, 6).map((r) => (
                  <li key={r.rev}>
                    <b>修订 {r.rev}</b>
                    <span>{r.note || "（无说明）"}</span>
                    <small className="faint">
                      {r.user} · {ago(r.time)} ·{" "}
                      {[
                        r.added && `新增 ${r.added}`,
                        r.changed && `修改 ${r.changed}`,
                        r.removed && `删除 ${r.removed}`,
                      ]
                        .filter(Boolean)
                        .join("，") || "无文件变化"}
                    </small>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        <section id="cv-source" className={`cv-sec ${lit("cv-source")}`}>
          <h2>
            清单源码
            <span className="cv-sub">
              component.yaml · 平台代码里没有任何应用特例
            </span>
            <button
              type="button"
              className="cv-src-toggle"
              aria-expanded={srcOpen}
              onClick={() => setSrcOpen((o) => !o)}
            >
              {srcOpen ? "收起" : "展开查看"}
            </button>
          </h2>
          {srcOpen &&
            (error ? (
              <p className="bad">{error}</p>
            ) : (
              yaml !== null && (
                <Terminal code={yaml} host="component.yaml" plain />
              )
            ))}
        </section>
      </div>

      <aside className="cv2-rail">
        {!external && (entry.plans?.[1] || entry.plans?.[0]) && (
          <div className="cv-rail-cap">
            典型部署：{(entry.plans?.[1] || entry.plans?.[0])!.name}
            {(entry.plans?.[1] || entry.plans?.[0])!.spec
              ? ` · ${(entry.plans?.[1] || entry.plans?.[0])!.spec}`
              : ""}
          </div>
        )}
        <div
          className="cv-topo"
          style={
            {
              "--h0": st.color.hero[0],
              "--h1": st.color.hero[1],
            } as React.CSSProperties
          }
        >
          {external ? (
            <ExternalArt />
          ) : (
            <TopoArt
              compact
              app={entry}
              plan={entry.plans?.[1] || entry.plans?.[0]}
            />
          )}
        </div>
        <dl className="cv-facts">
          {!external && (
            <div>
              <dt>角色</dt>
              <dd>
                {entry.roles.map((r) => (
                  <span key={r.name}>
                    {r.title || r.name}{" "}
                    <em>
                      {r.max && r.min === r.max
                        ? `固定 ${r.min} 台`
                        : `${r.min} 台起，常用 ${r.default ?? r.min} 台`}
                      {r.odd ? "，建议奇数" : ""}
                    </em>
                  </span>
                ))}
              </dd>
            </div>
          )}
          {(c.flows || []).length > 0 && (
            <div>
              <dt>数据流</dt>
              <dd>
                {(c.flows as Any[]).map((f) => (
                  <span key={f.id}>{f.title || f.id}</span>
                ))}
              </dd>
            </div>
          )}
          {(entry.provides || []).length > 0 && (
            <div>
              <dt>提供</dt>
              <dd className="mono">{entry.provides!.join("、")}</dd>
            </div>
          )}
          {(c.requires || []).length > 0 && (
            <div>
              <dt>依赖</dt>
              <dd>
                {(c.requires as Any[]).map((r) => (
                  <span key={r.capability}>
                    <span className="mono">{r.capability}</span>
                    {r.default_impl && <em>默认 {r.default_impl}</em>}
                  </span>
                ))}
              </dd>
            </div>
          )}
          {(c.ports || []).length > 0 && (
            <div>
              <dt>端口</dt>
              <dd className="mono">
                {(c.ports as Any[])
                  .map((p) => show(p.value).replace(/^=params\./, ""))
                  .join("、")}
              </dd>
            </div>
          )}
        </dl>
        <nav
          className="cv-toc"
          aria-label="本页内容"
          ref={tocRef as React.RefObject<HTMLElement>}
          style={
            {
              "--ty": `${
                Math.max(
                  0,
                  sections.findIndex(([id]) => id === active),
                ) * 34
              }px`,
            } as React.CSSProperties
          }
        >
          <span className="cv-toc-mark" aria-hidden />
          {sections.map(([id, label, n]) => (
            <button
              type="button"
              key={id}
              className={active === id ? "on" : ""}
              onClick={() => jump(id)}
            >
              <span className="cv-toc-label">
                {CvIcons[id]}
                <span>{label}</span>
              </span>
              <i>{n ?? ""}</i>
            </button>
          ))}
        </nav>
      </aside>
      </div>
    </div>
  );
}

/** A component the customer operates: the platform only produces its configuration sheet. */
function ExternalArt() {
  return (
    <div className="cv-ext">
      <svg viewBox="0 0 300 120" aria-hidden>
        <rect
          x="8"
          y="44"
          width="62"
          height="32"
          rx="8"
          className="ext-box dim"
        />
        <text x="39" y="64" textAnchor="middle" className="ext-t">
          客户端
        </text>
        <path d="M72 60h44" className="ext-wire" />
        <rect
          x="118"
          y="34"
          width="84"
          height="52"
          rx="10"
          className="ext-box lead"
        />
        <text x="160" y="58" textAnchor="middle" className="ext-t b">
          负载均衡
        </text>
        <text x="160" y="74" textAnchor="middle" className="ext-t">
          客户运维
        </text>
        <path
          d="M204 60c22 0 22-34 44-34M204 60h44M204 60c22 0 22 34 44 34"
          className="ext-wire"
        />
        <rect
          x="248"
          y="14"
          width="44"
          height="24"
          rx="6"
          className="ext-box"
        />
        <rect
          x="248"
          y="48"
          width="44"
          height="24"
          rx="6"
          className="ext-box"
        />
        <rect
          x="248"
          y="82"
          width="44"
          height="24"
          rx="6"
          className="ext-box"
        />
      </svg>
      <p>
        平台不在机器上安装它，只生成一份要在它上面配置的监听、后端和健康检查清单。
      </p>
    </div>
  );
}

const Params = memo(function Params({ c }: { c: Any }) {
  const groups: Any[] = c.groups || [];
  const params: Any[] = c.params || [];
  const sets = groups
    .map((g) => ({ g, list: params.filter((p) => p.group === g.id) }))
    .filter((x) => x.list.length);
  const loose = params.filter((p) => !groups.some((g) => g.id === p.group));
  if (loose.length) sets.push({ g: { id: "_", label: "其他" }, list: loose });
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sets.slice(0, 2).map(({ g }) => [g.id, true])),
  );
  if (!params.length) return <p className="muted">这个组件没有可调的参数。</p>;
  const allOpen = sets.every(({ g }) => open[g.id]);
  return (
    <>
      <div className="cv-bar">
        <span className="faint small">
          {params.length} 项，分 {sets.length} 组
        </span>
        <button
          type="button"
          className="link quiet"
          onClick={() =>
            setOpen(
              allOpen
                ? {}
                : Object.fromEntries(sets.map(({ g }) => [g.id, true])),
            )
          }
        >
          {allOpen ? "全部收起" : "全部展开"}
        </button>
      </div>
      <div className="cv-groups">
        {sets.map(({ g, list }) => {
          const on = !!open[g.id];
          return (
            <div className={`cv-group ${on ? "on" : ""}`} key={g.id}>
              <button
                type="button"
                className="cv-group-head"
                aria-expanded={on}
                onClick={() => setOpen((o) => ({ ...o, [g.id]: !on }))}
              >
                {on ? <IconDown /> : <IconRight />}
                <b>{g.label || g.id}</b>
                <i>{list.length}</i>
                {!on && (
                  <span className="cv-peek">
                    {list.map((p) => p.label || p.key).join("、")}
                  </span>
                )}
              </button>
              {on && (
                <div className="cv-params" role="table">
                  {list.map((p) => (
                    <div className="cv-prow" role="row" key={p.key}>
                      <span className="cv-pname">
                        <b>{p.label || p.key}</b>
                        <span className="mono faint small">{p.key}</span>
                        {p.hint && <small>{p.hint}</small>}
                      </span>
                      <span className="mono faint">{p.type}</span>
                      <span className="mono">
                        {show(p.default)}
                        {p.unit ? ` ${p.unit}` : ""}
                      </span>
                      <span className="cv-prange">
                        {p.options
                          ? p.options.join(" / ")
                          : p.min !== undefined || p.max !== undefined
                            ? `${show(p.min)} – ${show(p.max)}`
                            : p.pattern
                              ? "有格式要求"
                              : ""}
                        <span className="cv-flags">
                          {p.required && <span className="flag">必填</span>}
                          {p.restart && (
                            <span className="flag cv-mute">改后重启</span>
                          )}
                          {p.advanced && (
                            <span className="flag cv-mute">高级</span>
                          )}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
});

const Links = memo(function Links({ c }: { c: Any }) {
  const rows: [string, string, string, string][] = [
    ...((c.endpoints || []) as Any[]).map(
      (e): [string, string, string, string] => [
        "对外入口",
        e.title || e.name,
        `${e.protocol} · 端口 ${show(e.port).replace(/^=params\./, "")}`,
        e.note || "",
      ],
    ),
    ...((c.requires || []) as Any[]).map(
      (r): [string, string, string, string] => [
        "依赖",
        r.capability,
        r.default_impl
          ? `没指定时自动加入 ${r.default_impl}`
          : "部署时要指定由谁来提供",
        r.when ? `当 ${r.when} 时需要` : "",
      ],
    ),
    ...((c.ports || []) as Any[]).map((p): [string, string, string, string] => [
      "占用端口",
      p.name,
      show(p.value).replace(/^=params\./, "参数 "),
      "",
    ]),
    ...((c.secrets || []) as Any[]).map(
      (x): [string, string, string, string] => [
        "自动生成的密钥",
        x.name,
        x.length ? `${x.length} 位` : "",
        "",
      ],
    ),
    ...((c.inputs || []) as Any[]).map(
      (x): [string, string, string, string] => [
        "需要上传",
        x.label || x.name,
        x.kind === "tls-bundle" ? "TLS 证书包" : x.kind,
        "",
      ],
    ),
  ];
  if (!rows.length)
    return <p className="muted">这个组件没有声明入口、依赖或端口。</p>;
  return (
    <ul className="cv-links">
      {rows.map(([k, name, v, note], i) => (
        <li key={i}>
          <span className="cv-kind">{k}</span>
          <b>{name}</b>
          <span className="small">{v}</span>
          {note && <small className="faint">{note}</small>}
        </li>
      ))}
    </ul>
  );
});

/** The author's operations knowledge: what to check every day, routine tasks, typical problems, where the logs are. */
function Ops({ o }: { o?: Any }) {
  const aiStatus = useAIStatus();
  if (!o || !(o.checks?.length || o.tasks?.length || o.faults?.length))
    return (
      <p className="muted">
        这个组件还没有写运维知识。在工作台的清单里补上
        operations（巡检、常见操作、典型问题、日志位置），交接文档就会带上
        {aiStatus.enabled ? "；也可以让组件 AI 起草。" : "。"}
      </p>
    );
  const when = (w?: string) =>
    w ? (
      <span className="cv-when" title="只在这个条件成立的集群里出现">
        {w}
      </span>
    ) : null;
  return (
    <div className="cv-ops">
      {o.overview && <p className="cv-ops-lead">{o.overview}</p>}
      {(
        [
          ["日常巡检", o.checks],
          ["常见操作", o.tasks],
        ] as [string, Any[]][]
      )
        .filter(([, l]) => l?.length)
        .map(([h, l]) => (
          <div key={h} className="cv-ops-g">
            <h3>
              {h} <em className="num">{l.length}</em>
            </h3>
            <ul>
              {l.map((x: Any) => (
                <li key={x.title}>
                  <b>{x.title}</b>
                  {when(x.when)}
                  {x.hosts && <span className="faint small">在{x.hosts}</span>}
                  {x.cmd && <code className="cv-ops-cmd">{x.cmd}</code>}
                  {(x.expect || x.note) && (
                    <small>{x.expect ? `正常：${x.expect}` : x.note}</small>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {o.faults?.length > 0 && (
        <div className="cv-ops-g">
          <h3>
            典型问题 <em className="num">{o.faults.length}</em>
          </h3>
          <ul>
            {o.faults.map((x: Any) => (
              <li key={x.title}>
                <b>{x.title}</b>
                {when(x.when)}
                {x.symptom && <small>现象：{x.symptom}</small>}
                <ol>
                  {(x.steps || []).map((st: string, i: number) => (
                    <li key={i}>{st}</li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        </div>
      )}
      {o.logs?.length > 0 && (
        <p className="faint small">
          日志与文件：{o.logs.map((l: Any) => `${l.name} ${l.text}`).join("；")}
        </p>
      )}
    </div>
  );
}

function About({ c }: { c: Any }) {
  const caps: Any[] = c.detail?.capabilities || [];
  const limits: string[] = c.detail?.limits || [];
  if (!caps.length && !limits.length)
    return <p className="muted">没有填写能力与限制的说明。</p>;
  return (
    <dl className="cv-caps">
      {caps.map((x, i) => (
        <div key={`c${i}`}>
          <dt>{x.name}</dt>
          <dd>{x.text}</dd>
        </div>
      ))}
      {limits.map((x, i) => (
        <div key={`l${i}`} className="limit">
          <dt>限制</dt>
          <dd>{x}</dd>
        </div>
      ))}
    </dl>
  );
}

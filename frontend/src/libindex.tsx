import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Drawer,
  Input,
  Message,
  Skeleton,
  Upload,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconBook,
  IconCode,
  IconCheck,
  IconCheckCircleFill,
  IconCloudDownload,
  IconDownload,
  IconExclamationCircleFill,
  IconRefresh,
  IconRight,
  IconSearch,
  IconUpload,
} from "@arco-design/web-react/icon";
import { TaskCard } from "./libtask";
import { api, ago, can, err, size, useLocal, useMedia } from "./shared";
import type {
  ApiError,
  DepPlan,
  FetchTask,
  PackageRequest,
  PlatformStatus,
  SearchHit,
  VersionDetail,
} from "./shared";
import { go } from "./router";

const daysSince = (iso?: string) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : -1;

/* ---------------------------------------------------------------- what has been done to the library */

const KIND_TITLE: Record<string, string> = {
  index: "更新软件源索引",
  python: "准备运行环境",
  "": "下载软件包",
};

/** Every update and download that has been run, newest first, with the same step list the live card shows. */
function TaskHistory({
  open,
  close,
  platform,
  running,
}: {
  open: boolean;
  close: () => void;
  platform: string;
  running: boolean;
}) {
  const [list, setList] = useState<FetchTask[] | null>(null);
  const [fail, setFail] = useState("");
  const [shown, setShown] = useState("");
  const loadHistory = () => {
    setFail("");
    api<FetchTask[]>("/api/library/tasks")
      .then((r) => setList(r.filter((t) => t.platform === platform)))
      .catch((e) => setFail((e as Error).message));
  };
  useEffect(() => {
    if (!open) return;
    loadHistory();
  }, [open, platform, running]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Drawer
      width={560}
      visible={open}
      onCancel={close}
      title="更新与下载记录"
      footer={null}
    >
      {fail ? (
        <div className="list-state">
          <p className="bad">{fail}</p>
          <Button size="small" icon={<IconRefresh />} onClick={loadHistory}>
            重试
          </Button>
        </div>
      ) : list === null ? (
        <Skeleton animation text={{ rows: 5 }} />
      ) : list.length === 0 ? (
        <div className="sx-empty">
          还没有记录。更新索引、下载软件包之后会留在这里。
        </div>
      ) : (
        <ul className="th-list">
          {list.map((t) => (
            <li key={t.id} className={`th-item st-${t.state}`}>
              <button
                type="button"
                className="th-head"
                aria-expanded={shown === t.id}
                onClick={() => setShown(shown === t.id ? "" : t.id)}
              >
                <b>{KIND_TITLE[t.kind || ""] || "任务"}</b>
                <span className={`th-state ${t.state}`}>
                  {t.state === "done"
                    ? "完成"
                    : t.state === "failed"
                      ? "失败"
                      : "进行中"}
                </span>
                <span className="faint small">
                  {ago(t.started)}
                  {t.by ? ` · ${t.by}` : ""}
                </span>
              </button>
              {shown === t.id && (
                <TaskCard task={{ ...t, logs: t.logs || [] }} />
              )}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

/* ---------------------------------------------------------------- the index line */

/**
 * Where the package names and versions come from, and the ways to refresh it: one quiet line, not a box. While an
 * update runs it shows what is happening now; the full log stays one click away.
 */
export function SourcePanel({
  p,
  admin,
  busy,
  task,
  update,
  onImport,
  onGuide,
  onDismiss,
}: {
  p: PlatformStatus;
  admin: boolean;
  busy: boolean;
  task: FetchTask | null;
  update: () => void;
  onImport: () => void;
  onGuide: () => void;
  onDismiss: () => void;
}) {
  const [history, setHistory] = useState(false);
  const has = p.index.files.length > 0;
  const old = daysSince(p.index.updated) >= 14;
  const running = task?.kind === "index" && task.state === "running";
  const repoGroups = useMemo(() => {
    const map = new Map<
      string,
      { source: string; suites: Set<string>; packages: number }
    >();
    for (const f of p.index.files) {
      let cur = map.get(f.source);
      if (!cur) {
        cur = { source: f.source, suites: new Set(), packages: 0 };
        map.set(f.source, cur);
      }
      if (f.suite) cur.suites.add(f.suite);
      cur.packages += f.packages || 0;
    }
    return [...map.values()];
  }, [p.index.files]);
  const sources = repoGroups.length;
  const pill = running
    ? { tone: "brand", text: "更新中" }
    : !has
      ? { tone: "idle", text: "还没有" }
      : old
        ? { tone: "warn", text: "需要更新" }
        : { tone: "ok", text: "最新" };
  const exported = () =>
    Message.info(
      `已开始下载 source-index-${p.id}-….tar.gz：拷到不能联网的平台，在那边点“导入”选择它`,
    );
  return (
    <section className="lp" aria-label="软件源索引">
      <div className="lp-head">
        <span className={`lp-ic ${has ? "is-brand" : ""}`} aria-hidden>
          <IconCloudDownload />
        </span>
        <div className="lp-htext">
          <div className="lp-trow">
            <b className="lp-title">软件源索引</b>
            <span className={`lp-pill ${pill.tone}`}>{pill.text}</span>
          </div>
          {has ? (
            <div className="lp-metrics">
              <span className="lp-m num">
                <b>{p.index.packages.toLocaleString()}</b> 个软件包版本
              </span>
              <span className="lp-m num">
                <b>{sources}</b> 个软件源
              </span>
              <span className="lp-m">
                更新于 <b>{ago(p.index.updated || "")}</b>
              </span>
              {p.index.imported && (
                <span className="lp-m is-tag">跨平台导入</span>
              )}
            </div>
          ) : (
            <span className="lp-sub">
              软件源的软件清单。有了它才能搜索软件包、查看所有版本、预览依赖
            </span>
          )}
        </div>
        <div className="lp-actions">
          <Button type="text" onClick={() => setHistory(true)}>
            更新记录
          </Button>
          {admin && (
            <>
              <Button
                type={has ? "secondary" : "primary"}
                icon={<IconRefresh />}
                loading={running}
                onClick={update}
                disabled={busy && !running}
              >
                {has ? "更新" : "联网更新"}
              </Button>
              <Button
                type="secondary"
                icon={<IconUpload />}
                disabled={busy}
                onClick={onImport}
              >
                导入
              </Button>
              <Button
                type="secondary"
                icon={<IconDownload />}
                disabled={!has}
                href={
                  has
                    ? `/api/library/index/export?platform=${encodeURIComponent(p.id)}`
                    : undefined
                }
                onClick={has ? exported : undefined}
              >
                导出
              </Button>
            </>
          )}
        </div>
      </div>
      <TaskHistory
        open={history}
        close={() => setHistory(false)}
        platform={p.id}
        running={running}
      />
      {task ? (
        <div className="lp-body">
          <TaskCard task={task} onClose={onDismiss} />
        </div>
      ) : (
        has &&
        repoGroups.length > 0 && (
          <div className="lp-body src-overview">
            <div className="src-grid" aria-label="已索引软件源">
              {repoGroups.map((g) => (
                <div className="src-chip" key={g.source}>
                  <div className="src-chip-top">
                    <span className="src-dot" aria-hidden="true" />
                    <b className="src-name">{g.source}</b>
                    <span className="src-cnt num">
                      {g.packages.toLocaleString()} 版本
                    </span>
                  </div>
                  {g.suites.size > 0 && (
                    <div className="src-suites">
                      {[...g.suites].map((st) => (
                        <span className="src-suite mono" key={st}>
                          {st}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      )}
      <button className="lp-foot" onClick={onGuide}>
        <span className="lp-foot-ic" aria-hidden>
          <IconBook />
        </span>
        <span>
          <b>内网不能联网？</b>{" "}
          在能联网的平台准备好索引和软件包，导出后带进内网导入，部署时都不需要联网。
        </span>
        <span className="lp-go">
          查看步骤 <IconRight />
        </span>
      </button>
    </section>
  );
}

/* ---------------------------------------------------------------- ansible runtime */

/**
 * The Ansible the deliveries of this system carry to their controller: which version, what the controller must run,
 * and what the offline bundle is made of. Without one the system can hold packages but cannot be delivered to.
 */
export function RuntimePanel({ p }: { p: PlatformStatus }) {
  const r = p.runtime;
  const [open, setOpen] = useState(false);
  return (
    <section className="lp" aria-label="Ansible 运行环境">
      <div className="lp-head">
        <span className={`lp-ic ${r ? "is-ok" : "is-warn"}`} aria-hidden>
          <IconCode />
        </span>
        <div className="lp-htext">
          <div className="lp-trow">
            <b className="lp-title">Ansible 运行环境</b>
            <span className={`lp-pill ${r ? "ok" : "warn"}`}>
              {r ? "就绪" : "还没有"}
            </span>
          </div>
          {r ? (
            <div className="lp-metrics">
              <span className="lp-m mono">
                <b>ansible-core {r.ansible || "?"}</b>
              </span>
              <span className="lp-m">
                控制节点 <b>{r.controller || p.title}</b>
                {r.python ? ` · Python ${r.python}` : ""}
              </span>
              <span className="lp-m num">
                <b>{r.packages.length}</b> 个离线包 · {size(r.size)}
              </span>
            </div>
          ) : (
            <span className="lp-sub">
              生成交付时，控制节点要用它离线安装 Ansible。这个系统还没有选定运行环境，所以暂时不能生成交付。
            </span>
          )}
        </div>
        <span className="row-gap">
          {r && (
            <Button
              type="secondary"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
            >
              {open ? "收起" : "查看组成"}
            </Button>
          )}
          <Button onClick={() => go({ name: "library", id: "ansible" })}>
            {can("library.runtime") ? "管理运行环境" : "查看运行环境"}
          </Button>
        </span>
      </div>
      {r && open && (
        <div className="lp-body rt">
          <dl className="rt-facts">
            {r.bundle && (
              <>
                <dt>来源</dt>
                <dd className="mono">{r.bundle}</dd>
              </>
            )}
            <dt>文件</dt>
            <dd className="mono">
              {r.file} · {size(r.size)}
            </dd>
            {r.sha256 && (
              <>
                <dt>SHA256</dt>
                <dd className="mono" title={r.sha256}>
                  {r.sha256.slice(0, 24)}…
                </dd>
              </>
            )}
          </dl>
          <ul className="rt-pkgs" aria-label="离线安装包">
            {r.packages.map((x) => (
              <li
                key={x.name}
                className={x.name === "ansible-core" ? "rt-core" : ""}
              >
                <span className="mono">{x.name}</span>
                <span className="mono small faint">{x.version}</span>
              </li>
            ))}
          </ul>
          <p className="small muted rt-note">
            它随每份交付打进控制节点的上传包；现场在控制节点运行
            bootstrap/bootstrap-ansible.sh 离线安装，不访问
            PyPI，也不改动系统自带的 Python。
          </p>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- offline guide */

type Step = {
  n: number;
  title: string;
  text: string;
  done?: boolean;
  action?: React.ReactNode;
};

function StepList({
  title,
  hint,
  steps,
}: {
  title: string;
  hint: string;
  steps: Step[];
}) {
  return (
    <div className="gd-lane">
      <header>
        <b>{title}</b>
        <span className="muted small">{hint}</span>
      </header>
      <ol>
        {steps.map((s) => (
          <li key={s.n} className={s.done ? "done" : ""}>
            <span className="gd-n" aria-hidden>
              {s.done ? <IconCheck /> : s.n}
            </span>
            <div>
              <b>{s.title}</b>
              <p className="muted small">{s.text}</p>
              {s.action && <div className="gd-act">{s.action}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * How to prepare packages where there is a network and use them where there is none, as a drawer reached from the
 * index panel and the page menu. Each step has its button right there and is ticked once it is done here.
 */
export function GuideDrawer({
  open,
  onClose,
  p,
  admin,
  hasPackages,
  onUpdate,
  onAdd,
  onExportAll,
  onImportIndex,
  onImportPackages,
}: {
  open: boolean;
  onClose: () => void;
  p: PlatformStatus;
  admin: boolean;
  hasPackages: boolean;
  onUpdate: () => void;
  onAdd: () => void;
  onExportAll: () => void;
  onImportIndex: () => void;
  onImportPackages: () => void;
}) {
  const narrow = useMedia("(max-width: 900px)");
  const hasIndex = p.index.files.length > 0;
  const act = (label: string, fn: () => void, icon?: React.ReactNode) =>
    admin ? (
      <Button size="small" icon={icon} onClick={() => (onClose(), fn())}>
        {label}
      </Button>
    ) : null;
  return (
    <Drawer
      width={narrow ? "100%" : 900}
      visible={open}
      onCancel={onClose}
      title="离线使用指南"
      footer={null}
    >
      <div className="gd">
        <p className="muted gd-lead">
          平台本身和部署都不需要联网。只是软件包得先在一台能联网的平台上准备好，再带进内网。
        </p>
        <div className="gd-grid">
          <StepList
            title="在能联网的平台"
            hint="准备"
            steps={[
              {
                n: 1,
                title: "更新索引",
                text: "联网下载软件源的软件清单，约 25 MB。",
                done: hasIndex,
                action: act("联网更新", onUpdate, <IconRefresh />),
              },
              {
                n: 2,
                title: "添加软件版本",
                text: "搜软件包、选版本，看依赖，确认后下载到本地。",
                done: hasPackages,
                action: act("添加软件版本", onAdd),
              },
              {
                n: 3,
                title: "导出两个文件",
                text: `索引面板的“导出”得到 source-index-${p.id}-日期.tar.gz；页面右上角“更多”菜单里的“导出全部软件包”得到 library-${p.id}.tar.gz。`,
                action: act("导出全部软件包", onExportAll, <IconDownload />),
              },
            ]}
          />
          <StepList
            title="在不能联网的平台"
            hint="使用"
            steps={[
              {
                n: 1,
                title: "导入索引",
                text: "索引面板点“导入”，选 source-index-… 文件；会重新验签，被改动或更旧的会被拒绝。",
                action: act("导入索引", onImportIndex, <IconUpload />),
              },
              {
                n: 2,
                title: "导入软件包",
                text: "右上角“更多”菜单里点“导入软件包”，选 library-… 文件，逐个校验哈希。",
                action: act("导入软件包", onImportPackages, <IconUpload />),
              },
              {
                n: 3,
                title: "生成交付",
                text: "新建集群和生成交付时软件包自动取用，手册和上传包都不需要联网。",
                action: (
                  <Button
                    size="small"
                    onClick={() => (onClose(), go({ name: "apps" }))}
                  >
                    去新建集群
                  </Button>
                ),
              },
            ]}
          />
        </div>
      </div>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- importing */

const importHint = (m: string) => {
  if (m.includes("更旧"))
    return "这份比本机现有的更旧。请在能联网的平台先“更新索引”，再重新导出一份最新的。";
  if (m.includes("没有这个软件源"))
    return "这个平台缺少对应的软件源。到左上角“软件源”里添加同 id 的源后再导入。";
  if (m.includes("签名"))
    return "签名没有通过：文件可能被改动过，或这个平台上这个软件源的密钥和外网平台不一样。请重新导出再试。";
  if (
    m.includes("哈希") ||
    m.includes("不一致") ||
    m.includes("不完整") ||
    m.includes("损坏")
  )
    return "文件在拷贝过程中可能损坏。请重新拷贝，并核对文件大小和外网导出时一致。";
  if (m.includes("不是") || m.includes("有效"))
    return "请确认选的是外网平台导出的 .tar.gz 文件，没有被解压或改名。";
  return "";
};

/**
 * Importing, explained from the other end: where the file comes from, what it is called, how to get it here — then the
 * file picker, what is checked, and what to do when it is refused.
 */
export function ImportDrawer({
  open,
  kind,
  platform,
  onClose,
  done,
}: {
  open: boolean;
  kind: "index" | "packages";
  platform: PlatformStatus;
  onClose: () => void;
  done: () => void;
}) {
  const narrow = useMedia("(max-width: 900px)");
  const [file, setFile] = useState<File | undefined>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setFile(undefined);
      setResult("");
      setError("");
    }
  }, [open, kind]);
  const isIndex = kind === "index";
  const sample = isIndex
    ? `source-index-${platform.id}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}.tar.gz`
    : `library-${platform.id}.tar.gz`;
  const wrongKind =
    file &&
    ((isIndex && file.name.startsWith("library-")) ||
      (!isIndex && file.name.startsWith("source-index-")));
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const f = new FormData();
      f.set("pack", file);
      if (isIndex) {
        f.set("platform", platform.id);
        const r = await api<{ packages: number }>("/api/library/index/import", {
          method: "POST",
          body: f,
        });
        setResult(
          `索引已导入：${r.packages.toLocaleString()} 个软件包版本。现在可以在“添加软件版本”里搜索它们。`,
        );
      } else {
        const r = await api<{ closures: number; files: number }>(
          "/api/library/import",
          { method: "POST", body: f },
        );
        setResult(
          `已导入 ${r.closures} 个软件包版本，新增 ${r.files} 个文件。之后新建集群和生成交付时会自动取用它们。`,
        );
      }
      done();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const steps = [
    <>
      在<b>能联网的平台</b>打开“软件库”，左侧选 <b>{platform.title}</b>。
    </>,
    isIndex ? (
      <>
        点“软件源索引”这一行右边的 <b>导出索引</b>
        。（那一行显示“联网更新”的话，先点它更新一次。）
      </>
    ) : (
      <>
        点右上角 <b>“更多” → 导出全部软件包</b>
        。（想只导出一部分，先在列表里勾选再导出。）
      </>
    ),
    <>
      浏览器会保存一个文件，名字类似 <code className="mono">{sample}</code>
      {isIndex ? "，约 28 MB" : ""}。
    </>,
    <>
      把它拷到能打开这个页面的电脑（U 盘、堡垒机上传都可以），然后在下面选择它。
    </>,
  ];
  return (
    <Drawer
      width={narrow ? "100%" : 580}
      visible={open}
      onCancel={onClose}
      title={isIndex ? "导入软件源索引" : "导入软件包"}
      footer={
        <div className="review-foot">
          <span className="muted small">
            {isIndex
              ? "导入的索引会替换本机现有的索引"
              : "有任何一项校验不过，整包都不会导入"}
          </span>
          <div className="row-gap">
            {result ? (
              <Button type="primary" onClick={onClose}>
                完成
              </Button>
            ) : (
              <>
                <Button onClick={onClose}>取消</Button>
                <Button
                  type="primary"
                  icon={<IconUpload />}
                  loading={busy}
                  disabled={!file || !!wrongKind}
                  onClick={submit}
                >
                  开始导入
                </Button>
              </>
            )}
          </div>
        </div>
      }
    >
      <div className="imp">
        <section>
          <h3>这个文件从哪里来</h3>
          <ol className="imp-steps">
            {steps.map((t, i) => (
              <li key={i}>
                <span className="gd-n" aria-hidden>
                  {i + 1}
                </span>
                <div>{t}</div>
              </li>
            ))}
          </ol>
          <details className="imp-cli">
            <summary className="small muted">
              没法用页面操作？命令行也可以
            </summary>
            <pre className="mono small">
              {isIndex
                ? `middleware-hub library index-export --library <软件库目录> --platform ${platform.id} --out ${sample}`
                : `middleware-hub library export --library <软件库目录> --platform ${platform.id} --pkg 名称=版本 --out ${sample}`}
            </pre>
          </details>
        </section>
        <section>
          <h3>选择文件</h3>
          {result ? (
            <p className="imp-ok">
              <IconCheckCircleFill /> {result}
            </p>
          ) : (
            <>
              <Upload
                drag
                autoUpload={false}
                limit={1}
                accept=".gz,.tgz"
                fileList={
                  file
                    ? [
                        {
                          uid: "p",
                          name: file.name,
                          originFile: file,
                          status: "done",
                        },
                      ]
                    : []
                }
                onChange={(l) => (setFile(l[0]?.originFile), setError(""))}
                tip={
                  isIndex
                    ? "把文件拖到这里，或点击选择。索引文件通常不到 50 MB。"
                    : "把文件拖到这里，或点击选择。软件包文件可能有几百 MB，上传需要一些时间。"
                }
              />
              {wrongKind && (
                <div className="note warn">
                  这个文件看起来是
                  {isIndex
                    ? "软件包文件（library-…）"
                    : "索引文件（source-index-…）"}
                  ，请改用“{isIndex ? "导入软件包" : "导入索引"}”。
                </div>
              )}
              {error && (
                <div className="imp-err" role="alert">
                  <IconExclamationCircleFill />
                  <div>
                    <b>没有导入：</b>
                    {error}
                    {importHint(error) && (
                      <p className="muted small">{importHint(error)}</p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </section>
        <section>
          <h3>导入时会检查</h3>
          <ul className="imp-checks small muted">
            {isIndex ? (
              <>
                <li>
                  用<b>这个平台自己的</b>软件源密钥重新验证签名，不信任文件本身
                </li>
                <li>逐个核对软件包清单的大小和 SHA256</li>
                <li>比本机现有的更旧的索引会被拒绝，防止被回退</li>
              </>
            ) : (
              <>
                <li>逐个文件核对哈希，任一项不符整包拒绝</li>
                <li>拒绝路径穿越、未知的操作系统，以及同名但内容不同的文件</li>
              </>
            )}
          </ul>
        </section>
      </div>
    </Drawer>
  );
}

/* ---------------------------------------------------------------- adding versions */

/** Where a version comes from, in words: the suites of an Ubuntu mirror are releases, updates and security fixes. */
const channel = (v: VersionDetail): { text: string; tone: string } => {
  if (v.source.startsWith("percona"))
    return { text: "Percona 官方源", tone: "third" };
  if (v.suite.endsWith("-security")) return { text: "安全更新", tone: "sec" };
  if (v.suite.endsWith("-updates")) return { text: "软件更新", tone: "upd" };
  return { text: "系统自带版本", tone: "base" };
};

/**
 * The versions of a package as a short list to pick from: newest first, with its size and whether the library has it.
 * Where the versions come from different channels each says which; when they all come from one, it is said once above.
 */
function VersionPicker({
  versions,
  value,
  onChange,
}: {
  versions: VersionDetail[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [all, setAll] = useState(false);
  const mixed = new Set(versions.map((v) => channel(v).text)).size > 1;
  const i = versions.findIndex((v) => v.version === value);
  const shown = all || i >= 4 ? versions : versions.slice(0, 4);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const n = Math.min(
      versions.length - 1,
      Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)),
    );
    if (n >= 4) setAll(true);
    onChange(versions[n].version);
    setTimeout(
      () =>
        (document.querySelector(".vp-row.on") as HTMLElement | null)?.focus(),
      0,
    );
  };
  return (
    <div className="vp" role="radiogroup" aria-label="版本" onKeyDown={onKey}>
      {shown.map((v, k) => {
        const on = v.version === value;
        return (
          <button
            key={v.version}
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`vp-row ${on ? "on" : ""}`}
            onClick={() => onChange(v.version)}
          >
            <span className="vp-radio" aria-hidden />
            <span className="mono vp-ver">{v.version}</span>
            {k === 0 && <span className="vp-tag new">最新</span>}
            {mixed && (
              <span className={`vp-tag ${channel(v).tone}`}>
                {channel(v).text}
              </span>
            )}
            {v.have && (
              <span className="vp-have">
                <IconCheck /> 已在库
              </span>
            )}
            <span className="num small faint vp-size">{size(v.size)}</span>
          </button>
        );
      })}
      {versions.length > 4 && i < 4 && (
        <button className="link vp-more small" onClick={() => setAll(!all)}>
          {all ? "收起" : `显示全部 ${versions.length} 个版本`}
        </button>
      )}
    </div>
  );
}

const EXAMPLES = [
  "etcd",
  "haproxy",
  "keepalived",
  "nginx",
  "redis-server",
  "postgresql-17",
];

type Picked = { name: string; desc?: string };

/**
 * Master–detail: names on the left, and for the one chosen its versions and everything it would bring along on the
 * right, with what is already in the library marked. A tray at the bottom collects what to download.
 */
export function AddDrawer({
  open,
  onClose,
  platform,
  start,
  ready,
  updateIndex,
  admin,
}: {
  open: boolean;
  onClose: () => void;
  platform: PlatformStatus;
  start: (p: PackageRequest[]) => void;
  ready: boolean;
  updateIndex: () => void;
  admin: boolean;
}) {
  const narrow = useMedia("(max-width: 900px)");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [versions, setVersions] = useState<VersionDetail[]>([]);
  const [version, setVersion] = useState("");
  const [plan, setPlan] = useState<DepPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [list, setList] = useState<{ req: PackageRequest; plan: DepPlan }[]>(
    [],
  );
  const [recent, setRecent] = useLocal<string[]>("mh-lib-recent", []);
  const seq = useRef(0);
  const planSeq = useRef(0);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setHits(null);
      setPicked(null);
      setVersions([]);
      setVersion("");
      setPlan(null);
      setList([]);
      setActive(0);
      setTimeout(() => input.current?.focus(), 120);
    }
  }, [open]);

  // Search while typing: answers come from the cached index, so there is nothing to wait for.
  useEffect(() => {
    const term = q.trim();
    if (!open || !ready || term.length < 2) {
      setHits(null);
      setSearching(false);
      return;
    }
    const n = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      api<{ hits: SearchHit[] }>(
        `/api/library/search?platform=${encodeURIComponent(platform.id)}&q=${encodeURIComponent(term)}`,
      )
        .then((r) => {
          if (n !== seq.current) return;
          setHits(r.hits);
          setActive(0);
        })
        .catch((e) => n === seq.current && (setHits([]), err(e)))
        .finally(() => n === seq.current && setSearching(false));
    }, 160);
    return () => clearTimeout(t);
  }, [q, open, ready, platform.id]);

  const loadPlan = (name: string, ver: string) => {
    const n = ++planSeq.current;
    setPlan(null);
    setPlanning(true);
    api<DepPlan>(
      `/api/library/plan?platform=${encodeURIComponent(platform.id)}&package=${encodeURIComponent(name)}&version=${encodeURIComponent(ver)}`,
    )
      .then((r) => n === planSeq.current && setPlan(r))
      .catch((e) => n === planSeq.current && err(e))
      .finally(() => n === planSeq.current && setPlanning(false));
  };
  const pick = async (h: Picked) => {
    setPicked(h);
    setVersions([]);
    setVersion("");
    setPlan(null);
    try {
      const r = await api<{ versions: string[]; details: VersionDetail[] }>(
        `/api/library/versions?platform=${encodeURIComponent(platform.id)}&package=${encodeURIComponent(h.name)}`,
      );
      setVersions(r.details);
      setVersion(r.versions[0]);
      loadPlan(h.name, r.versions[0]);
      setRecent([h.name, ...recent.filter((x) => x !== h.name)].slice(0, 6));
    } catch (e) {
      err(e);
    }
  };
  const inList = (n: string, v: string) =>
    list.some((x) => x.req.name === n && x.req.version === v);
  const add = () => {
    if (
      !picked ||
      !version ||
      !plan ||
      plan.unresolved.length ||
      inList(picked.name, version) ||
      plan.stored
    )
      return;
    setList([...list, { req: { name: picked.name, version }, plan }]);
  };
  // A file two requests share is downloaded once, so it is counted once.
  const total = useMemo(() => {
    const seen = new Set<string>();
    let bytes = 0;
    let files = 0;
    list.forEach((x) =>
      x.plan.packages.forEach(
        (r) =>
          !r.have &&
          !seen.has(r.file) &&
          (seen.add(r.file), (bytes += r.size), files++),
      ),
    );
    return { bytes, files };
  }, [list]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && q) {
      e.stopPropagation();
      setQ("");
      return;
    }
    if (!hits?.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = hits[active];
      if (h) pick(h);
    }
  };
  useEffect(() => {
    document.querySelector(".ad-hit.cur")?.scrollIntoView({ block: "nearest" });
  }, [active, hits]);

  const detailShown = !narrow || !!picked;
  const listShown = !narrow || !picked;
  const needN = plan ? plan.packages.filter((x) => !x.have).length : 0;
  const haveN = plan ? plan.packages.length - needN : 0;

  return (
    <Drawer
      width={narrow ? "100%" : "min(1080px, 94vw)"}
      visible={open}
      onCancel={onClose}
      className="ad"
      title={`添加软件版本 · ${platform.title}`}
      footer={
        <div className="ad-foot">
          <div className="ad-tray" aria-label="下载清单">
            {list.length === 0 ? (
              <span className="muted small">
                选好版本后点“加入下载清单”，可以一次下载多个。
              </span>
            ) : (
              <>
                {list.map((x) => (
                  <span className="ad-chip" key={x.req.name + x.req.version}>
                    <span className="mono">{x.req.name}</span>
                    <span className="faint mono">
                      {x.req.version.length > 18
                        ? x.req.version.slice(0, 17) + "…"
                        : x.req.version}
                    </span>
                    <button
                      aria-label={`移除 ${x.req.name}`}
                      onClick={() => setList(list.filter((y) => y !== x))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <span className="muted small ad-sum">
                  共 {total.files} 个文件 · {size(total.bytes)}
                </span>
              </>
            )}
          </div>
          <div className="row-gap">
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              icon={<IconDownload />}
              disabled={!list.length}
              onClick={() => start(list.map((x) => x.req))}
            >
              下载到本地{list.length ? `（${list.length}）` : ""}
            </Button>
          </div>
        </div>
      }
    >
      {!ready ? (
        <div className="ad-empty">
          <h3>先有一份软件源索引</h3>
          <p className="muted">
            索引是软件源的软件清单。有了它，在这里搜软件包、看所有版本、预览依赖都是即时的。
          </p>
          <ul className="ad-ways">
            <li>
              <b>这台能联网</b>
              <span className="muted small">
                点下面的按钮，约 25 MB，不到一分钟。
              </span>
              {admin && (
                <Button
                  type="primary"
                  icon={<IconRefresh />}
                  onClick={updateIndex}
                >
                  联网更新索引
                </Button>
              )}
            </li>
            <li>
              <b>这台不能联网</b>
              <span className="muted small">
                在能联网的平台“导出索引”，回到软件库页点“导入索引”。
              </span>
            </li>
          </ul>
        </div>
      ) : (
        <div className={`ad-split ${narrow ? "narrow" : ""}`}>
          {listShown && (
            <div className="ad-left">
              <Input
                allowClear
                prefix={<IconSearch />}
                value={q}
                onChange={setQ}
                onKeyDown={onKey}
                placeholder="搜软件包名或关键词"
                aria-label="搜索软件包"
                ref={input as never}
                className="mono-in"
              />
              <div className="ad-hits" role="listbox" aria-label="搜索结果">
                {q.trim().length < 2 && (
                  <div className="ad-hint">
                    <p className="muted small">
                      输入至少两个字符。可以搜名称，也可以搜描述里的词。
                    </p>
                    <div className="ad-eg">
                      {[
                        ...recent,
                        ...EXAMPLES.filter((x) => !recent.includes(x)),
                      ]
                        .slice(0, 8)
                        .map((x) => (
                          <button
                            key={x}
                            className="ad-chip ghost mono"
                            onClick={() => (setQ(x), input.current?.focus())}
                          >
                            {x}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
                {searching && !hits && (
                  <Skeleton animation text={{ rows: 3 }} />
                )}
                {q.trim().length >= 2 && hits && hits.length === 0 && (
                  <p className="muted small ad-none">
                    软件源里没有匹配“{q.trim()}”的软件包
                  </p>
                )}
                {hits?.map((h, i) => (
                  <button
                    key={h.name}
                    role="option"
                    aria-selected={picked?.name === h.name}
                    className={`ad-hit ${picked?.name === h.name ? "on" : ""} ${i === active ? "cur" : ""}`}
                    onClick={() => pick(h)}
                    onMouseMove={() => setActive(i)}
                  >
                    <span className="mono ad-name">{h.name}</span>
                    <span
                      className="mono small faint ad-latest"
                      title={h.latest}
                    >
                      {h.latest}
                    </span>
                    <span className="small muted ad-desc">{h.desc}</span>
                    <span className="small faint ad-n">
                      {h.versions} 个版本
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {detailShown && (
            <div className="ad-right">
              {narrow && (
                <Button
                  type="text"
                  className="back"
                  icon={<IconArrowLeft />}
                  onClick={() => setPicked(null)}
                >
                  搜索结果
                </Button>
              )}
              {!picked ? (
                <div className="ad-empty tight">
                  <h3>选一个软件包</h3>
                  <p className="muted">
                    左边搜到后点一下，这里会列出它的所有版本，以及装它需要一起下载的全部依赖包。
                  </p>
                </div>
              ) : (
                <>
                  <header className="ad-head">
                    <div>
                      <h3 className="mono">{picked.name}</h3>
                      <p className="muted small">
                        {picked.desc}
                        {versions.length > 0 &&
                          new Set(versions.map((v) => channel(v).text)).size ===
                            1 &&
                          ` · 来自 ${channel(versions[0]).text.replace("系统自带版本", "Ubuntu 官方源")}`}
                      </p>
                    </div>
                  </header>
                  {/transitional|dummy package/i.test(picked.desc || "") && (
                    <div className="note">
                      这是一个过渡包，本身几乎没有内容，装它是为了带上真正的程序。实际要用的软件包在下面的依赖清单里；也可以直接搜索它们（比如
                      etcd-server）。
                    </div>
                  )}
                  {versions.length > 0 && (
                    <div className="vp-wrap">
                      <div className="vp-label small">
                        <b>选择要下载的版本</b>
                        <span className="muted">
                          共 {versions.length}{" "}
                          个，选好后点下面的“加入下载清单”；可以加入多个版本
                        </span>
                      </div>
                      <VersionPicker
                        versions={versions}
                        value={version}
                        onChange={(v) => (
                          setVersion(v),
                          loadPlan(picked.name, v)
                        )}
                      />
                    </div>
                  )}
                  {planning && <Skeleton animation text={{ rows: 5 }} />}
                  {plan && (
                    <>
                      <div className="ad-stats" aria-label="汇总">
                        <div>
                          <span className="num">{plan.packages.length}</span>
                          <small>个软件包</small>
                        </div>
                        <div>
                          <span className="num">{size(plan.bytes)}</span>
                          <small>合计</small>
                        </div>
                        <div className={needN ? "need" : "ok"}>
                          <span className="num">
                            {size(plan.download_bytes)}
                          </span>
                          <small>
                            {needN ? `还需下载 ${needN} 个` : "无需下载"}
                          </small>
                        </div>
                      </div>
                      <div className="ad-meter" aria-hidden>
                        <i
                          className="have"
                          style={{
                            width: `${plan.bytes ? ((plan.bytes - plan.download_bytes) / plan.bytes) * 100 : 0}%`,
                          }}
                        />
                        <i
                          className="need"
                          style={{
                            width: `${plan.bytes ? (plan.download_bytes / plan.bytes) * 100 : 0}%`,
                          }}
                        />
                      </div>
                      {plan.stored && (
                        <p className="ad-ok">
                          <IconCheckCircleFill />{" "}
                          这个版本和它的全部依赖都已经在软件库里了。
                        </p>
                      )}
                      {plan.unresolved.length > 0 && (
                        <div className="note warn">
                          <b>依赖没有找全，不能下载：</b>
                          {plan.unresolved.map((u) => (
                            <div key={u}>{u}</div>
                          ))}
                        </div>
                      )}
                      {plan.notes.map((n) => (
                        <div className="note" key={n}>
                          {n}
                        </div>
                      ))}
                      <ul className="ad-deps" aria-label="依赖清单">
                        {plan.packages.map((r) => (
                          <li key={r.file} className={r.have ? "have" : ""}>
                            <div className="ad-dep-main">
                              <span className="mono ad-dep-name">{r.name}</span>
                              <span className="mono small faint ad-dep-ver">
                                {r.version}
                              </span>
                              <span className="small muted ad-dep-why">
                                {r.reason}
                              </span>
                            </div>
                            <span className="num small ad-dep-size">
                              {size(r.size)}
                            </span>
                            <span
                              className={`ad-st ${r.have ? "have" : r.upgrade ? "up" : "need"}`}
                            >
                              {r.have ? (
                                <>
                                  <IconCheck /> 已在库
                                </>
                              ) : r.upgrade ? (
                                "替换系统自带"
                              ) : (
                                "需下载"
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="ad-act">
                        <Button
                          type="primary"
                          disabled={
                            plan.unresolved.length > 0 ||
                            inList(picked.name, version) ||
                            plan.stored
                          }
                          onClick={add}
                        >
                          {plan.stored
                            ? "已在库"
                            : inList(picked.name, version)
                              ? "已加入下载清单"
                              : `加入下载清单${needN ? `（${needN} 个文件）` : ""}`}
                        </Button>
                        {haveN > 0 && !plan.stored && (
                          <span className="small muted">
                            库里已有的 {haveN} 个不会重复下载
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

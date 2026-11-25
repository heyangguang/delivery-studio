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
import { bi, biv, getLang, useLang, withLang } from "./i18n";
import { osTitle } from "./oslogo";

const daysSince = (iso?: string) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : -1;

/* ---------------------------------------------------------------- what has been done to the library */

const kindTitle = (kind?: string) =>
  kind === "index"
    ? bi("更新软件源索引", "Update source index")
    : kind === "python"
      ? bi("准备运行环境", "Build runtime")
      : !kind
        ? bi("下载软件包", "Download packages")
        : bi("任务", "Task");

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
  useLang();
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
      width="min(560px, 100vw)"
      visible={open}
      onCancel={close}
      title={bi("更新与下载记录", "Update & Download History")}
      footer={null}
    >
      {fail ? (
        <div className="list-state">
          <p className="bad">{fail}</p>
          <Button size="small" icon={<IconRefresh />} onClick={loadHistory}>
            {bi("重试", "Retry")}
          </Button>
        </div>
      ) : list === null ? (
        <Skeleton animation text={{ rows: 5 }} />
      ) : list.length === 0 ? (
        <div className="sx-empty">
          {bi(
            "还没有记录。更新索引、下载软件包之后会留在这里。",
            "No history yet. Index updates and package downloads will appear here.",
          )}
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
                <b>{kindTitle(t.kind)}</b>
                <span className={`th-state ${t.state}`}>
                  {t.state === "done"
                    ? bi("完成", "Done")
                    : t.state === "failed"
                      ? bi("失败", "Failed")
                      : bi("进行中", "Running")}
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
  useLang();
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
    ? { tone: "brand", text: bi("更新中", "Updating") }
    : !has
      ? { tone: "idle", text: bi("还没有", "Not fetched") }
      : old
        ? { tone: "warn", text: bi("需要更新", "Needs update") }
        : { tone: "ok", text: bi("最新", "Up to date") };
  const exported = () =>
    Message.info(
      bi(
        `已开始下载 source-index-${p.id}-….tar.gz：拷到不能联网的平台，在那边点“导入”选择它`,
        `Downloading source-index-${p.id}-….tar.gz. Transfer it to an air-gapped instance and click "Import" there.`,
      ),
    );
  return (
    <section className="lp" aria-label={bi("软件源索引", "Source Index")}>
      <div className="lp-head">
        <span className={`lp-ic ${has ? "is-brand" : ""}`} aria-hidden>
          <IconCloudDownload />
        </span>
        <div className="lp-htext">
          <div className="lp-trow">
            <b className="lp-title">{bi("软件源索引", "Source Index")}</b>
            <span className={`lp-pill ${pill.tone}`}>{pill.text}</span>
          </div>
          {has ? (
            <div className="lp-metrics">
              <span className="lp-m num">
                <b>{p.index.packages.toLocaleString(getLang())}</b>{" "}
                {bi("个软件包版本", "package versions")}
              </span>
              <span className="lp-m num">
                <b>{sources}</b>{" "}
                {bi("个软件源", sources === 1 ? "source" : "sources")}
              </span>
              <span className="lp-m">
                {bi("更新于", "Updated")} <b>{ago(p.index.updated || "")}</b>
              </span>
              {p.index.imported && (
                <span className="lp-m is-tag">
                  {bi("跨平台导入", "Imported")}
                </span>
              )}
            </div>
          ) : (
            <span className="lp-sub">
              {bi(
                "软件源的软件清单。有了它才能搜索软件包、查看所有版本、预览依赖",
                "Catalog of repository packages. Required to search packages, browse versions, and preview dependencies.",
              )}
            </span>
          )}
        </div>
        <div className="lp-actions">
          <Button type="text" onClick={() => setHistory(true)}>
            {bi("更新记录", "History")}
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
                {has ? bi("更新", "Update") : bi("联网更新", "Fetch index")}
              </Button>
              <Button
                type="secondary"
                icon={<IconUpload />}
                disabled={busy}
                onClick={onImport}
              >
                {bi("导入", "Import")}
              </Button>
              <Button
                type="secondary"
                icon={<IconDownload />}
                disabled={!has}
                href={
                  has
                    ? withLang(
                        `/api/library/index/export?platform=${encodeURIComponent(p.id)}`,
                      )
                    : undefined
                }
                onClick={has ? exported : undefined}
              >
                {bi("导出", "Export")}
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
      {task && (
        <div className="lp-body">
          <TaskCard task={task} onClose={onDismiss} />
        </div>
      )}
      {has && repoGroups.length > 0 && (
        <div className="lp-body src-overview">
          <div className="src-grid" aria-label={bi("已索引软件源", "Indexed sources")}>
            {repoGroups.map((g) => (
              <div className="src-chip" key={g.source}>
                <div className="src-chip-top">
                  <span className="src-dot" aria-hidden="true" />
                  <b className="src-name">{g.source}</b>
                  <span className="src-cnt num">
                    {g.packages.toLocaleString(getLang())}{" "}
                    {bi("版本", g.packages === 1 ? "ver" : "vers")}
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
      )}
      <button type="button" className="lp-foot" onClick={onGuide}>
        <span className="lp-foot-ic" aria-hidden>
          <IconBook />
        </span>
        <span>
          <b>{bi("内网不能联网？", "Air-gapped environment?")}</b>{" "}
          {bi(
            "在能联网的平台准备好索引和软件包，导出后带进内网导入，部署时都不需要联网。",
            "Prepare indexes and packages on an online instance, export and import them offline — deployments need no internet.",
          )}
        </span>
        <span className="lp-go">
          {bi("查看步骤", "View guide")} <IconRight />
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
  useLang();
  const r = p.runtime;
  const [open, setOpen] = useState(false);
  return (
    <section className="lp" aria-label={bi("Ansible 运行环境", "Ansible Runtime")}>
      <div className="lp-head">
        <span className={`lp-ic ${r ? "is-ok" : "is-warn"}`} aria-hidden>
          <IconCode />
        </span>
        <div className="lp-htext">
          <div className="lp-trow">
            <b className="lp-title">{bi("Ansible 运行环境", "Ansible Runtime")}</b>
            <span className={`lp-pill ${r ? "ok" : "warn"}`}>
              {r ? bi("就绪", "Ready") : bi("还没有", "Not set")}
            </span>
          </div>
          {r ? (
            <div className="lp-metrics">
              <span className="lp-m mono">
                <b>ansible-core {r.ansible || "?"}</b>
              </span>
              <span className="lp-m">
                {bi("控制节点", "Controller")}{" "}
                <b>{osTitle(r.controller || p.title)}</b>
                {r.python ? ` · Python ${r.python}` : ""}
              </span>
              <span className="lp-m num">
                <b>{r.packages.length}</b>{" "}
                {bi(
                  "个离线包",
                  r.packages.length === 1 ? "offline pkg" : "offline pkgs",
                )}{" "}
                · {size(r.size)}
              </span>
            </div>
          ) : (
            <span className="lp-sub">
              {bi(
                "生成交付时，控制节点要用它离线安装 Ansible。这个系统还没有选定运行环境，所以暂时不能生成交付。",
                "Used to install Ansible offline on the control node when building deliveries. No runtime is selected for this OS yet, so deliveries cannot be built.",
              )}
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
              {open ? bi("收起", "Collapse") : bi("查看组成", "Inspect")}
            </Button>
          )}
          <Button onClick={() => go({ name: "library", id: "ansible" })}>
            {can("library.runtime")
              ? bi("管理运行环境", "Manage runtimes")
              : bi("查看运行环境", "View runtimes")}
          </Button>
        </span>
      </div>
      {r && open && (
        <div className="lp-body rt">
          <dl className="rt-facts">
            {r.bundle && (
              <>
                <dt>{bi("来源", "Source")}</dt>
                <dd className="mono">{r.bundle}</dd>
              </>
            )}
            <dt>{bi("文件", "File")}</dt>
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
          <ul className="rt-pkgs" aria-label={bi("离线安装包", "Offline packages")}>
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
            {bi(
              "它随每份交付打进控制节点的上传包；现场在控制节点运行 bootstrap/bootstrap-ansible.sh 离线安装，不访问 PyPI，也不改动系统自带的 Python。",
              "Bundled into each delivery's controller upload archive. On site, run bootstrap/bootstrap-ansible.sh to install offline without PyPI or modifying system Python.",
            )}
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
  useLang();
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
      width={narrow ? "100%" : "min(900px, 96vw)"}
      visible={open}
      onCancel={onClose}
      title={bi("离线使用指南", "Offline Workflow Guide")}
      footer={null}
    >
      <div className="gd">
        <p className="muted gd-lead">
          {bi(
            "平台本身和部署都不需要联网。只是软件包得先在一台能联网的平台上准备好，再带进内网。",
            "Neither the platform nor deployments require internet access. Prepare indexes and packages on an online instance first, then transfer them.",
          )}
        </p>
        <div className="gd-grid">
          <StepList
            title={bi("在能联网的平台", "On an online instance")}
            hint={bi("准备", "Prepare")}
            steps={[
              {
                n: 1,
                title: bi("更新索引", "Update index"),
                text: bi(
                  "联网下载软件源的软件清单，约 25 MB。",
                  "Download repository package lists (~25 MB).",
                ),
                done: hasIndex,
                action: act(bi("联网更新", "Fetch index"), onUpdate, <IconRefresh />),
              },
              {
                n: 2,
                title: bi("添加软件版本", "Add package versions"),
                text: bi(
                  "搜软件包、选版本，看依赖，确认后下载到本地。",
                  "Search packages, select versions, inspect dependencies, and download locally.",
                ),
                done: hasPackages,
                action: act(bi("添加软件版本", "Add packages"), onAdd),
              },
              {
                n: 3,
                title: bi("导出两个文件", "Export two bundles"),
                text: bi(
                  `索引面板的“导出”得到 source-index-${p.id}-日期.tar.gz；页面右上角“更多”菜单里的“导出全部软件包”得到 library-${p.id}.tar.gz。`,
                  `Use "Export" in the Index panel for source-index-${p.id}-<date>.tar.gz, and "More → Export all packages" at top right for library-${p.id}.tar.gz.`,
                ),
                action: act(
                  bi("导出全部软件包", "Export all packages"),
                  onExportAll,
                  <IconDownload />,
                ),
              },
            ]}
          />
          <StepList
            title={bi("在不能联网的平台", "On an air-gapped instance")}
            hint={bi("使用", "Use")}
            steps={[
              {
                n: 1,
                title: bi("导入索引", "Import index"),
                text: bi(
                  "索引面板点“导入”，选 source-index-… 文件；会重新验签，被改动或更旧的会被拒绝。",
                  'Click "Import" in the Index panel and select source-index-…. Signatures are re-verified; tampered or older indexes are rejected.',
                ),
                action: act(bi("导入索引", "Import index"), onImportIndex, <IconUpload />),
              },
              {
                n: 2,
                title: bi("导入软件包", "Import packages"),
                text: bi(
                  "右上角“更多”菜单里点“导入软件包”，选 library-… 文件，逐个校验哈希。",
                  'Open "More → Import packages" at top right and select library-…. Every file checksum is verified.',
                ),
                action: act(
                  bi("导入软件包", "Import packages"),
                  onImportPackages,
                  <IconUpload />,
                ),
              },
              {
                n: 3,
                title: bi("生成交付", "Build deliveries"),
                text: bi(
                  "新建集群和生成交付时软件包自动取用，手册和上传包都不需要联网。",
                  "Packages are used automatically when creating clusters and building deliveries; runbooks and archives work completely offline.",
                ),
                action: (
                  <Button
                    size="small"
                    onClick={() => (onClose(), go({ name: "apps" }))}
                  >
                    {bi("去新建集群", "Go to App Catalog")}
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
  const low = m.toLowerCase();
  if (m.includes("更旧") || low.includes("older"))
    return bi(
      "这份比本机现有的更旧。请在能联网的平台先“更新索引”，再重新导出一份最新的。",
      'This archive is older than the local index. Run "Update" on the online instance and export a fresh bundle.',
    );
  if (m.includes("没有这个软件源") || low.includes("no such source") || low.includes("missing source"))
    return bi(
      "这个平台缺少对应的软件源。到左上角“软件源”里添加同 id 的源后再导入。",
      'A matching source is missing on this instance. Add a source with the same id under "Sources" first.',
    );
  if (m.includes("签名") || low.includes("signature"))
    return bi(
      "签名没有通过：文件可能被改动过，或这个平台上这个软件源的密钥和外网平台不一样。请重新导出再试。",
      "Signature verification failed: the file may have been modified, or this instance uses a different repository key. Re-export and retry.",
    );
  if (
    m.includes("哈希") ||
    m.includes("不一致") ||
    m.includes("不完整") ||
    m.includes("损坏") ||
    low.includes("hash") ||
    low.includes("checksum") ||
    low.includes("mismatch") ||
    low.includes("corrupt")
  )
    return bi(
      "文件在拷贝过程中可能损坏。请重新拷贝，并核对文件大小和外网导出时一致。",
      "The file may have been corrupted during transfer. Re-copy it and verify its file size matches the exported archive.",
    );
  if (m.includes("不是") || m.includes("有效") || low.includes("invalid") || low.includes("not a valid"))
    return bi(
      "请确认选的是外网平台导出的 .tar.gz 文件，没有被解压或改名。",
      "Ensure you selected an intact .tar.gz archive exported from an online instance without extracting or renaming it.",
    );
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
  useLang();
  const narrow = useMedia("(max-width: 900px)");
  const [file, setFile] = useState<File | undefined>();
  const [busy, setBusy] = useState(false);
  const busyLockRef = useRef(false);
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
    if (!file || busyLockRef.current) return;
    busyLockRef.current = true;
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
          bi(
            `索引已导入：${r.packages.toLocaleString(getLang())} 个软件包版本。现在可以在“添加软件版本”里搜索它们。`,
            `Index imported: ${r.packages.toLocaleString(getLang())} package versions. You can now search them in "Add packages".`,
          ),
        );
      } else {
        const r = await api<{ closures: number; files: number }>(
          "/api/library/import",
          { method: "POST", body: f },
        );
        setResult(
          bi(
            `已导入 ${r.closures} 个软件包版本，新增 ${r.files} 个文件。之后新建集群和生成交付时会自动取用它们。`,
            `Imported ${r.closures} package versions (${r.files} new files). They will be used automatically when building deliveries.`,
          ),
        );
      }
      done();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busyLockRef.current = false;
      setBusy(false);
    }
  };
  const steps = [
    biv(
      <>
        在<b>能联网的平台</b>打开“软件库”，左侧选 <b>{platform.title}</b>。
      </>,
      <>
        Open <b>Software Library</b> on an <b>online instance</b> and select{" "}
        <b>{osTitle(platform.title)}</b> on the left.
      </>,
    ),
    isIndex
      ? biv(
          <>
            点“软件源索引”这一行右边的 <b>导出索引</b>
            。（那一行显示“联网更新”的话，先点它更新一次。）
          </>,
          <>
            Click <b>Export</b> on the right side of the Source Index panel. (If
            it shows &ldquo;Fetch index&rdquo;, update it first.)
          </>,
        )
      : biv(
          <>
            点右上角 <b>“更多” → 导出全部软件包</b>
            。（想只导出一部分，先在列表里勾选再导出。）
          </>,
          <>
            Click <b>More → Export all packages</b> at the top right. (Select
            items in the list first to export only a subset.)
          </>,
        ),
    biv(
      <>
        浏览器会保存一个文件，名字类似 <code className="mono">{sample}</code>
        {isIndex ? "，约 28 MB" : ""}。
      </>,
      <>
        Your browser will download a file named like{" "}
        <code className="mono">{sample}</code>
        {isIndex ? " (~28 MB)" : ""}.
      </>,
    ),
    biv(
      <>
        把它拷到能打开这个页面的电脑（U 盘、堡垒机上传都可以），然后在下面选择它。
      </>,
      <>
        Transfer the archive to a machine that can access this page (via USB or
        bastion upload), then select it below.
      </>,
    ),
  ];
  return (
    <Drawer
      width={narrow ? "100%" : "min(580px, 100vw)"}
      visible={open}
      onCancel={onClose}
      title={
        isIndex
          ? bi("导入软件源索引", "Import Source Index")
          : bi("导入软件包", "Import Packages")
      }
      footer={
        <div className="review-foot">
          <span className="muted small">
            {isIndex
              ? bi(
                  "导入的索引会替换本机现有的索引",
                  "The imported index replaces the existing local index",
                )
              : bi(
                  "有任何一项校验不过，整包都不会导入",
                  "If any verification fails, the entire archive is rejected",
                )}
          </span>
          <div className="row-gap">
            {result ? (
              <Button type="primary" onClick={onClose}>
                {bi("完成", "Done")}
              </Button>
            ) : (
              <>
                <Button onClick={onClose}>{bi("取消", "Cancel")}</Button>
                <Button
                  type="primary"
                  icon={<IconUpload />}
                  loading={busy}
                  disabled={!file || !!wrongKind}
                  onClick={submit}
                >
                  {bi("开始导入", "Start Import")}
                </Button>
              </>
            )}
          </div>
        </div>
      }
    >
      <div className="imp">
        <section>
          <h3>{bi("这个文件从哪里来", "Where to get this file")}</h3>
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
              {bi("没法用页面操作？命令行也可以", "No web access? Use the CLI")}
            </summary>
            <pre className="mono small">
              {isIndex
                ? `middleware-hub library index-export --library ${bi("<软件库目录>", "<library-dir>")} --platform ${platform.id} --out ${sample}`
                : `middleware-hub library export --library ${bi("<软件库目录>", "<library-dir>")} --platform ${platform.id} --pkg ${bi("名称=版本", "name=version")} --out ${sample}`}
            </pre>
          </details>
        </section>
        <section>
          <h3>{bi("选择文件", "Select File")}</h3>
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
                    ? bi(
                        "把文件拖到这里，或点击选择。索引文件通常不到 50 MB。",
                        "Drag the archive here or click to browse. Index files are usually under 50 MB.",
                      )
                    : bi(
                        "把文件拖到这里，或点击选择。软件包文件可能有几百 MB，上传需要一些时间。",
                        "Drag the archive here or click to browse. Package bundles can be hundreds of MB and may take a while.",
                      )
                }
              />
              {wrongKind && (
                <div className="note warn">
                  {bi(
                    `这个文件看起来是${isIndex ? "软件包文件（library-…）" : "索引文件（source-index-…）"}，请改用“${isIndex ? "导入软件包" : "导入索引"}”。`,
                    `This looks like a ${isIndex ? "package bundle (library-…)" : "source index (source-index-…)"}. Please use "${isIndex ? "Import Packages" : "Import Index"}" instead.`,
                  )}
                </div>
              )}
              {error && (
                <div className="imp-err" role="alert">
                  <IconExclamationCircleFill />
                  <div>
                    <b>{bi("没有导入：", "Import failed: ")}</b>
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
          <h3>{bi("导入时会检查", "Verification checks")}</h3>
          <ul className="imp-checks small muted">
            {isIndex ? (
              <>
                <li>
                  {biv(
                    <>
                      用<b>这个平台自己的</b>软件源密钥重新验证签名，不信任文件本身
                    </>,
                    <>
                      Re-verifies signatures using <b>this instance&apos;s own</b>{" "}
                      repository keys without trusting the bundle
                    </>,
                  )}
                </li>
                <li>
                  {bi(
                    "逐个核对软件包清单的大小和 SHA256",
                    "Checks size and SHA256 of every package list file",
                  )}
                </li>
                <li>
                  {bi(
                    "比本机现有的更旧的索引会被拒绝，防止被回退",
                    "Rejects indexes older than the local one to prevent rollback",
                  )}
                </li>
              </>
            ) : (
              <>
                <li>
                  {bi(
                    "逐个文件核对哈希，任一项不符整包拒绝",
                    "Verifies SHA256 of every file; rejects whole bundle on any mismatch",
                  )}
                </li>
                <li>
                  {bi(
                    "拒绝路径穿越、未知的操作系统，以及同名但内容不同的文件",
                    "Rejects path traversal, unknown OS targets, and conflicting filenames",
                  )}
                </li>
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
const channel = (
  v: VersionDetail,
): { text: string; origin?: string; tone: string } => {
  if (v.source.startsWith("percona"))
    return { text: bi("Percona 官方源", "Percona Official"), tone: "third" };
  if (v.suite.endsWith("-security"))
    return { text: bi("安全更新", "Security update"), tone: "sec" };
  if (v.suite.endsWith("-updates"))
    return { text: bi("软件更新", "Updates"), tone: "upd" };
  return {
    text: bi("系统自带版本", "OS Base"),
    origin: bi("Ubuntu 官方源", "Official OS repo"),
    tone: "base",
  };
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
  useLang();
  const [all, setAll] = useState(false);
  const focusTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    },
    [],
  );
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
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    focusTimerRef.current = window.setTimeout(
      () =>
        (document.querySelector(".vp-row.on") as HTMLElement | null)?.focus(),
      0,
    );
  };
  return (
    <div
      className="vp"
      role="radiogroup"
      aria-label={bi("版本", "Versions")}
      onKeyDown={onKey}
    >
      {shown.map((v, k) => {
        const on = v.version === value;
        return (
          <button
            type="button"
            key={v.version}
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`vp-row ${on ? "on" : ""}`}
            onClick={() => onChange(v.version)}
          >
            <span className="vp-radio" aria-hidden />
            <span className="mono vp-ver">{v.version}</span>
            {k === 0 && <span className="vp-tag new">{bi("最新", "Latest")}</span>}
            {mixed && (
              <span className={`vp-tag ${channel(v).tone}`}>
                {channel(v).text}
              </span>
            )}
            {v.have && (
              <span className="vp-have">
                <IconCheck /> {bi("已在库", "In library")}
              </span>
            )}
            <span className="num small faint vp-size">{size(v.size)}</span>
          </button>
        );
      })}
      {versions.length > 4 && i < 4 && (
        <button type="button" className="link vp-more small" onClick={() => setAll(!all)}>
          {all
            ? bi("收起", "Collapse")
            : bi(
                `显示全部 ${versions.length} 个版本`,
                `Show all ${versions.length} versions`,
              )}
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
  useLang();
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
  const startLockRef = useRef(false);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    startLockRef.current = false;
    if (open) {
      setQ("");
      setHits(null);
      setPicked(null);
      setVersions([]);
      setVersion("");
      setPlan(null);
      setList([]);
      setActive(0);
      const t = window.setTimeout(() => input.current?.focus(), 120);
      return () => window.clearTimeout(t);
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
      title={bi(
        `添加软件版本 · ${platform.title}`,
        `Add Packages · ${osTitle(platform.title)}`,
      )}
      footer={
        <div className="ad-foot">
          <div className="ad-tray" aria-label={bi("下载清单", "Download queue")}>
            {list.length === 0 ? (
              <span className="muted small">
                {bi(
                  "选好版本后点“加入下载清单”，可以一次下载多个。",
                  'Pick a version and click "Add to queue" to download multiple packages together.',
                )}
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
                      type="button"
                      aria-label={bi(`移除 ${x.req.name}`, `Remove ${x.req.name}`)}
                      onClick={() => setList(list.filter((y) => y !== x))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <span className="muted small ad-sum">
                  {bi(
                    `共 ${total.files} 个文件`,
                    `${total.files} ${total.files === 1 ? "file" : "files"}`,
                  )}{" "}
                  · {size(total.bytes)}
                </span>
              </>
            )}
          </div>
          <div className="row-gap">
            <Button onClick={onClose}>{bi("取消", "Cancel")}</Button>
            <Button
              type="primary"
              icon={<IconDownload />}
              disabled={!list.length}
              onClick={() => {
                if (!list.length || startLockRef.current) return;
                startLockRef.current = true;
                start(list.map((x) => x.req));
              }}
            >
              {bi("下载到本地", "Download to library")}
              {list.length ? bi(`（${list.length}）`, ` (${list.length})`) : ""}
            </Button>
          </div>
        </div>
      }
    >
      {!ready ? (
        <div className="ad-empty">
          <h3>{bi("先有一份软件源索引", "Fetch a source index first")}</h3>
          <p className="muted">
            {bi(
              "索引是软件源的软件清单。有了它，在这里搜软件包、看所有版本、预览依赖都是即时的。",
              "The index catalogs available packages so searching, listing versions, and resolving dependencies are instant.",
            )}
          </p>
          <ul className="ad-ways">
            <li>
              <b>{bi("这台能联网", "Online instance")}</b>
              <span className="muted small">
                {bi(
                  "点下面的按钮，约 25 MB，不到一分钟。",
                  "Click below to fetch (~25 MB, under a minute).",
                )}
              </span>
              {admin && (
                <Button
                  type="primary"
                  icon={<IconRefresh />}
                  onClick={updateIndex}
                >
                  {bi("联网更新索引", "Fetch Source Index")}
                </Button>
              )}
            </li>
            <li>
              <b>{bi("这台不能联网", "Air-gapped instance")}</b>
              <span className="muted small">
                {bi(
                  "在能联网的平台“导出索引”，回到软件库页点“导入索引”。",
                  'Click "Export" on an online instance, then click "Import" in the Source Index panel here.',
                )}
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
                placeholder={bi("搜软件包名或关键词", "Search package name or keyword")}
                aria-label={bi("搜索软件包", "Search packages")}
                ref={input as never}
                className="mono-in"
              />
              <div
                className="ad-hits"
                role="listbox"
                aria-label={bi("搜索结果", "Search results")}
              >
                {q.trim().length < 2 && (
                  <div className="ad-hint">
                    <p className="muted small">
                      {bi(
                        "输入至少两个字符。可以搜名称，也可以搜描述里的词。",
                        "Enter at least 2 characters to search by name or description.",
                      )}
                    </p>
                    <div className="ad-eg">
                      {[
                        ...recent,
                        ...EXAMPLES.filter((x) => !recent.includes(x)),
                      ]
                        .slice(0, 8)
                        .map((x) => (
                          <button
                            type="button"
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
                    {bi(
                      `软件源里没有匹配“${q.trim()}”的软件包`,
                      `No packages matching "${q.trim()}" in sources`,
                    )}
                  </p>
                )}
                {hits?.map((h, i) => (
                  <button
                    type="button"
                    key={h.name}
                    role="option"
                    aria-selected={picked?.name === h.name}
                    className={`ad-hit ${picked?.name === h.name ? "on" : ""} ${i === active ? "cur" : ""}`}
                    onClick={() => pick(h)}
                    onMouseMove={() => {
                      if (active !== i) setActive(i);
                    }}
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
                      {bi(
                        `${h.versions} 个版本`,
                        `${h.versions} ${h.versions === 1 ? "ver" : "vers"}`,
                      )}
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
                  {bi("搜索结果", "Search results")}
                </Button>
              )}
              {!picked ? (
                <div className="ad-empty tight">
                  <h3>{bi("选一个软件包", "Select a package")}</h3>
                  <p className="muted">
                    {bi(
                      "左边搜到后点一下，这里会列出它的所有版本，以及装它需要一起下载的全部依赖包。",
                      "Pick a package on the left to view its versions and resolve all required dependencies.",
                    )}
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
                          bi(
                            ` · 来自 ${channel(versions[0]).origin || channel(versions[0]).text}`,
                            ` · From ${channel(versions[0]).origin || channel(versions[0]).text}`,
                          )}
                      </p>
                    </div>
                  </header>
                  {/transitional|dummy package/i.test(picked.desc || "") && (
                    <div className="note">
                      {bi(
                        "这是一个过渡包，本身几乎没有内容，装它是为了带上真正的程序。实际要用的软件包在下面的依赖清单里；也可以直接搜索它们（比如 etcd-server）。",
                        "This is a transitional/meta package that pulls in the actual package listed in the dependencies below. You can also search for the target package directly (e.g., etcd-server).",
                      )}
                    </div>
                  )}
                  {versions.length > 0 && (
                    <div className="vp-wrap">
                      <div className="vp-label small">
                        <b>{bi("选择要下载的版本", "Select version")}</b>
                        <span className="muted">
                          {bi(
                            `共 ${versions.length} 个，选好后点下面的“加入下载清单”；可以加入多个版本`,
                            `${versions.length} available — pick one and click "Add to queue" below`,
                          )}
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
                      <div className="ad-stats" aria-label={bi("汇总", "Summary")}>
                        <div>
                          <span className="num">{plan.packages.length}</span>
                          <small>
                            {bi(
                              "个软件包",
                              plan.packages.length === 1 ? "package" : "packages",
                            )}
                          </small>
                        </div>
                        <div>
                          <span className="num">{size(plan.bytes)}</span>
                          <small>{bi("合计", "Total")}</small>
                        </div>
                        <div className={needN ? "need" : "ok"}>
                          <span className="num">
                            {size(plan.download_bytes)}
                          </span>
                          <small>
                            {needN
                              ? bi(`还需下载 ${needN} 个`, `${needN} to download`)
                              : bi("无需下载", "All in library")}
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
                          {bi(
                            "这个版本和它的全部依赖都已经在软件库里了。",
                            "This version and all of its dependencies are already in the library.",
                          )}
                        </p>
                      )}
                      {plan.unresolved.length > 0 && (
                        <div className="note warn">
                          <b>
                            {bi(
                              "依赖没有找全，不能下载：",
                              "Unresolved dependencies — cannot download:",
                            )}
                          </b>
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
                      <ul
                        className="ad-deps"
                        aria-label={bi("依赖清单", "Dependency list")}
                      >
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
                                  <IconCheck /> {bi("已在库", "In library")}
                                </>
                              ) : r.upgrade ? (
                                bi("替换系统自带", "Upgrades base pkg")
                              ) : (
                                bi("需下载", "Download")
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
                            ? bi("已在库", "Already in library")
                            : inList(picked.name, version)
                              ? bi("已加入下载清单", "Added to queue")
                              : bi(
                                  `加入下载清单${needN ? `（${needN} 个文件）` : ""}`,
                                  `Add to queue${needN ? ` (${needN} ${needN === 1 ? "file" : "files"})` : ""}`,
                                )}
                        </Button>
                        {haveN > 0 && !plan.stored && (
                          <span className="small muted">
                            {bi(
                              `库里已有的 ${haveN} 个不会重复下载`,
                              `${haveN} already in library won't be re-downloaded`,
                            )}
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

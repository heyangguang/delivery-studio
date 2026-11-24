import React, { useEffect, useMemo, useRef, useState } from "react";
import { OsLogo, osTitle } from "./oslogo";
import {
  Button,
  Drawer,
  Dropdown,
  Input,
  Menu,
  Message,
  Modal,
  Select,
  Skeleton,
  Upload,
} from "@arco-design/web-react";
import {
  IconCode,
  IconArrowLeft,
  IconBook,
  IconDelete,
  IconDownload,
  IconExclamationCircle,
  IconMore,
  IconPlus,
  IconQuestionCircle,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconStorage,
  IconUpload,
} from "@arco-design/web-react/icon";
import {
  can,
  api,
  ago,
  cached,
  err,
  fetchCached,
  putCached,
  size,
  typing,
  useDelayed,
  useLocal,
  useMedia,
} from "./shared";
import type {
  ApiError,
  ClosureRow,
  FetchTask,
  LibraryOverview,
  PackageRequest,
  PackageSource,
  PlatformStatus,
  Session,
} from "./shared";
import {
  AddDrawer,
  GuideDrawer,
  ImportDrawer,
  RuntimePanel,
  SourcePanel,
} from "./libindex";
import { RuntimesView } from "./libruntime";
import { PackageList } from "./libpkgs";
import { TaskCard } from "./libtask";
import { go } from "./router";
import { UnderlineTabs } from "./ui";
import { Terminal } from "./runbook";
import { bi, biv, getLang, useLang, withLang } from "./i18n";

const FAMILY: Record<string, string> = { apt: "apt · .deb", rpm: "dnf · .rpm" };

const LibIcons = {
  all: (
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
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </svg>
  ),
  packages: (
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
      <path d="M8 2.2L13.5 5v6L8 13.8 2.5 11V5L8 2.2Z" />
      <path d="M2.5 5L8 7.8 13.5 5M8 7.8v6" />
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
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.7 8h10.6M8 2.6c1.6 1.5 2.4 3.3 2.4 5.4S9.6 11.9 8 13.4C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.6Z" />
    </svg>
  ),
  runtime: (
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
      <rect x="2.2" y="3" width="11.6" height="10" rx="2" />
      <path d="M5.2 6.4L7.2 8l-2 1.6M8.6 9.8h2.4" />
    </svg>
  ),
};

/** "RedHat 系 9（RHEL / Rocky / Alma）(amd64)" / "RedHat 9 family (RHEL / Rocky / Alma) (amd64)" → name, variant, arch. */
const splitTitle = (t: string) => {
  let rest = t.trim();
  let arch = "";
  const am = /\s*[（(]([^（）()]+)[）)]\s*$/.exec(rest);
  if (
    am &&
    (/^(amd64|arm64|x86_64|aarch64|ppc64le|s390x)$/i.test(am[1].trim()) ||
      /[（(][^（）()]+[）)]/.test(rest.slice(0, am.index)))
  ) {
    arch = am[1].trim();
    rest = rest.slice(0, am.index).trim();
  }
  let variant = "";
  const vm = /\s*[（(]([^（）()]+)[）)]\s*$/.exec(rest);
  if (vm) {
    variant = vm[1].trim();
    rest = rest.slice(0, vm.index).trim();
  }
  const el =
    /^(?:Red\s*Hat|RedHat|RHEL)\s*(?:系|family)?\s*(\d+)(?:\s*family)?/i.exec(
      rest,
    );
  const name = el ? bi(`RedHat 系 ${el[1]}`, `RHEL ${el[1]} family`) : rest;
  return { name, variant, arch };
};

/** A plain mark for a family of systems: a ring of three for apt systems, a box for rpm systems. */
function OsGlyph({ family, size: s = 36 }: { family: string; size?: number }) {
  return (
    <span
      className={`os-glyph ${family}`}
      style={{ width: s, height: s }}
      aria-hidden
    >
      {family === "apt" ? (
        <svg viewBox="0 0 24 24" width={s * 0.56} height={s * 0.56}>
          <circle
            cx="12"
            cy="12"
            r="6.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle cx="12" cy="4.6" r="2.3" fill="currentColor" />
          <circle cx="5.6" cy="15.7" r="2.3" fill="currentColor" />
          <circle cx="18.4" cy="15.7" r="2.3" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width={s * 0.56} height={s * 0.56}>
          <path
            d="M4 8.2 12 4l8 4.2v7.6L12 20l-8-4.2Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M4.5 8.4 12 12.3l7.5-3.9M12 12.3V19.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

const closuresPath = (id: string) =>
  `/api/library/closures?platform=${encodeURIComponent(id)}`;
type ClosuresReply = { closures: ClosureRow[]; missing: PackageRequest[] };

export function LibraryPage({
  me,
  selected,
}: {
  me: Session;
  selected?: string;
}) {
  const lang = useLang();
  const narrow = useMedia("(max-width: 900px)");
  const admin = can("library.manage");
  const [ov, setOv] = useState<LibraryOverview | null>(
    () => cached<LibraryOverview>("/api/library") ?? null,
  );
  const [load, setLoad] = useState<"loading" | "error" | "ready">(() =>
    cached("/api/library") ? "ready" : "loading",
  );
  const [message, setMessage] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [railImportOpen, setRailImportOpen] = useState(false);
  const [railSyncing, setRailSyncing] = useState(false);

  const reload = (fresh?: unknown) =>
    (fresh === true ? api : fetchCached)<LibraryOverview>("/api/library")
      .then((r) => {
        putCached("/api/library", r);
        setOv(r);
        setLoad("ready");
      })
      .catch((e) => {
        setMessage((e as Error).message);
        setLoad((s) => (s === "ready" ? s : "error"));
      });
  const prevLang = useRef(lang);
  useEffect(() => {
    const langChanged = prevLang.current !== lang;
    prevLang.current = lang;
    reload(langChanged);
    // the list of the system that will be shown is fetched alongside the overview, not after it
    if (!langChanged && selected !== "ansible") {
      fetchCached(
        closuresPath(selected || ov?.default_platform || "ubuntu-24.04-amd64"),
      ).catch(() => {});
    }
  }, [lang]);
  // A fetch or import in progress changes the library under us; keep the numbers fresh while it runs.
  useEffect(() => {
    if (!ov?.busy) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [ov?.busy]);

  useEffect(() => {
    if (!narrow && !selected && ov && selected !== "ansible")
      go(
        { name: "library", id: ov.default_platform },
        { replace: true, instant: true },
      ); // automatic, so no transition
  }, [narrow, selected, ov?.default_platform]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        typing(e) ||
        !ov ||
        document.querySelector(".pal-mask,.arco-drawer-wrapper")
      )
        return;
      const d =
        e.key === "ArrowDown" || e.key === "j"
          ? 1
          : e.key === "ArrowUp" || e.key === "k"
            ? -1
            : 0;
      if (!d) return;
      e.preventDefault();
      const ids = ["ansible", ...ov.platforms.map((p) => p.id)];
      const curId = selected || (!narrow ? ov.default_platform : undefined);
      const i = ids.indexOf(curId || "");
      const next = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + d))];
      if (next) go({ name: "library", id: next }, { replace: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ov, selected, narrow]);

  // on a wide screen the default system is drawn straight away; the address catches up without a second paint
  const shownId = selected || (!narrow ? ov?.default_platform : undefined);
  const current = ov?.platforms.find((p) => p.id === shownId);
  const runtimes = selected === "ansible";
  const slowList = useDelayed(load === "loading" && !ov);
  const activePlat =
    current ||
    ov?.platforms.find((p) => p.id === ov?.default_platform) ||
    ov?.platforms[0];
  const totalClosures = ov
    ? ov.platforms.reduce((s, p) => s + (p.stats?.closures || 0), 0)
    : 0;
  const totalBytes = ov
    ? ov.platforms.reduce((s, p) => s + (p.stats?.bytes || 0), 0)
    : 0;
  const readyPlats = ov ? ov.platforms.filter((p) => p.deployable).length : 0;
  const latestIndex = ov
    ? ov.platforms
        .map((p) => p.index?.updated || "")
        .filter(Boolean)
        .sort()
        .pop() || ""
    : "";
  const syncActiveIndex = async () => {
    if (!activePlat || railSyncing || ov?.busy) return;
    setRailSyncing(true);
    try {
      await api<FetchTask>("/api/library/index/update", {
        method: "POST",
        body: JSON.stringify({ platform: activePlat.id }),
      });
      if (runtimes) {
        go({ name: "library", id: activePlat.id }, { replace: true });
      }
      await reload(true);
    } catch (e) {
      err(e);
    } finally {
      setRailSyncing(false);
    }
  };
  return (
    <div className="md-split">
      {(!narrow || !selected) && (
        <aside className="md-list" aria-label={bi("操作系统", "Operating systems")}>
          <div className="list-head">
            <div className="list-title">
              <h1>{bi("软件库", "Software Library")}</h1>
              {admin && (
                <Button
                  size="small"
                  icon={<IconSettings />}
                  onClick={() => setSourcesOpen(true)}
                >
                  {bi("软件源", "Sources")}
                </Button>
              )}
            </div>
            <p className="muted small lib-intro">
              {bi(
                "交付里的软件包都从这里取：按操作系统分库，部署时不需要联网。",
                "All offline packages for deliveries are pulled from here, organized by OS so deployments require no internet.",
              )}
            </p>
          </div>
          {load === "loading" && !ov ? (
            <div
              className="list-body"
              style={{ visibility: slowList ? "visible" : "hidden" }}
            >
              {[0, 1].map((i) => (
                <div className="row-skel" key={i}>
                  <Skeleton
                    animation
                    text={{ rows: 2, width: ["45%", "65%"] }}
                  />
                </div>
              ))}
            </div>
          ) : load === "error" && !ov ? (
            <div className="list-state">
              <IconExclamationCircle className="bad" />
              <p>{message || bi("软件库加载失败", "Failed to load software library")}</p>
              <Button size="small" icon={<IconRefresh />} onClick={reload}>
                {bi("重试", "Retry")}
              </Button>
            </div>
          ) : (
            <div
              className="list-body"
              role="listbox"
              aria-label={bi("操作系统", "Operating systems")}
            >
              <a
                href="#/library/ansible"
                role="option"
                aria-selected={runtimes}
                className={`row plat ${runtimes ? "on" : ""}`}
                onClick={(e) => {
                  e.preventDefault();
                  go(
                    { name: "library", id: "ansible" },
                    { replace: !!selected },
                  );
                }}
              >
                <span className="lib-rt-ic" aria-hidden>
                  <IconCode />
                </span>
                <div className="row-main">
                  <div className="row-top">
                    <span className="row-name sans">
                      {bi("Ansible 运行环境", "Ansible Runtimes")}
                    </span>
                  </div>
                  <div className="row-sub">
                    {bi(
                      "控制节点上的离线 Ansible，各系统共用",
                      "Offline Ansible for control nodes, shared across OS targets",
                    )}
                  </div>
                </div>
              </a>
              {ov!.platforms.map((p) => {
                const t = splitTitle(p.title);
                return (
                  <a
                    key={p.id}
                    href={`#/library/${p.id}`}
                    role="option"
                    aria-selected={p.id === shownId}
                    className={`row plat ${p.id === shownId ? "on" : ""}`}
                    onClick={(e) => {
                      e.preventDefault();
                      go(
                        { name: "library", id: p.id },
                        { replace: !!selected },
                      );
                    }}
                  >
                    <OsLogo id={p.id} size={34} />
                    <div className="row-main">
                      <div className="row-top">
                        <span className="row-name sans">{t.name}</span>
                        <span className="plat-arch mono">{t.arch}</span>
                      </div>
                      {t.variant && <div className="row-sub">{t.variant}</div>}
                      <div className="row-sub">
                        <span
                          className={`plat-state ${p.deployable ? "ok" : "warn"}`}
                        >
                          {p.deployable
                            ? bi("可生成交付", "Ready")
                            : bi("暂无运行环境", "No runtime")}
                        </span>
                        <span>
                          {" "}
                          ·{" "}
                          {bi(
                            `${p.stats.closures} 个软件包`,
                            `${p.stats.closures} ${p.stats.closures === 1 ? "package" : "packages"}`,
                          )}{" "}
                          · {size(p.stats.bytes)}
                        </span>
                      </div>
                    </div>
                  </a>
                );
              })}
            </div>
          )}
          {ov && (
            <div className="lib-rail-foot">
              <div className="lib-rail-card">
                <div className="lib-rail-top">
                  <span className="lib-rail-label">
                    <i
                      className={`lib-rail-dot ${
                        ov.busy
                          ? "busy"
                          : readyPlats > 0 && totalClosures > 0
                            ? "ok"
                            : "empty"
                      }`}
                      aria-hidden
                    />
                    <b>{bi("本地软件库", "Local Library")}</b>
                  </span>
                  <span className="lib-rail-time num">
                    {ov.busy
                      ? bi("同步中…", "Syncing…")
                      : latestIndex
                        ? ago(latestIndex)
                        : size(totalBytes)}
                  </span>
                </div>
                <div className="lib-rail-meta num">
                  {bi(
                    `${totalClosures} 个软件包 · ${size(totalBytes)} · ${readyPlats}/${ov.platforms.length} 系统就绪`,
                    `${totalClosures} pkgs · ${size(totalBytes)} · ${readyPlats}/${ov.platforms.length} OS ready`,
                  )}
                </div>
                {admin && activePlat && (
                  <div className="lib-rail-acts">
                    <Button
                      size="mini"
                      icon={<IconRefresh />}
                      loading={railSyncing || ov.busy}
                      onClick={() => void syncActiveIndex()}
                      title={bi(
                        `更新 ${osTitle(activePlat.title)} 的软件源索引`,
                        `Update package index for ${osTitle(activePlat.title)}`,
                      )}
                    >
                      {bi("更新索引", "Sync Index")}
                    </Button>
                    <Button
                      size="mini"
                      icon={<IconUpload />}
                      disabled={ov.busy}
                      onClick={() => setRailImportOpen(true)}
                      title={bi(
                        `向 ${osTitle(activePlat.title)} 导入离线软件包`,
                        `Import offline packages into ${osTitle(activePlat.title)}`,
                      )}
                    >
                      {bi("导入离线包", "Import")}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
      )}
      {(!narrow || selected) && (
        <section className="md-detail">
          {runtimes ? (
            <RuntimesView admin={can("library.runtime")} narrow={narrow} />
          ) : ov && current ? (
            <PlatformDetail
              key={current.id}
              p={current}
              ov={ov}
              admin={admin}
              narrow={narrow}
              changed={reload}
            />
          ) : selected && load === "ready" ? (
            <div className="detail-none enter">
              <h2>{bi("没有这个操作系统", "OS not found")}</h2>
              <Button
                onClick={() => go({ name: "library" }, { replace: true })}
              >
                {bi("返回", "Back")}
              </Button>
            </div>
          ) : null}
        </section>
      )}
      <SourcesDrawer
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        narrow={narrow}
        changed={reload}
      />
      {activePlat && (
        <ImportDrawer
          open={railImportOpen}
          kind="packages"
          platform={activePlat}
          onClose={() => setRailImportOpen(false)}
          done={() => {
            setRailImportOpen(false);
            reload(true);
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- one operating system */

function PlatformDetail({
  p,
  ov,
  admin,
  narrow,
  changed,
}: {
  p: PlatformStatus;
  ov: LibraryOverview;
  admin: boolean;
  narrow: boolean;
  changed: () => void;
}) {
  useLang();
  const [rows, setRows] = useState<ClosureRow[] | null>(
    () => cached<ClosuresReply>(closuresPath(p.id))?.closures ?? null,
  );
  const [missing, setMissing] = useState<PackageRequest[]>(
    () => cached<ClosuresReply>(closuresPath(p.id))?.missing ?? [],
  );
  const [chosen, setChosen] = useState<string[]>([]);
  const [fetchOpen, setFetchOpen] = useState(false);
  // a closed result stays closed after a refresh; the history keeps it
  const [dismissed, setDismissed] = useLocal("mh-lib-dismissed", "");
  const [importKind, setImportKind] = useState<"index" | "packages" | null>(
    null,
  );
  const lastKind = useRef<"index" | "packages">("packages");
  if (importKind) lastKind.current = importKind;
  const [task, setTask] = useState<FetchTask | null>(
    ov.last_task &&
      ov.last_task.platform === p.id &&
      ov.last_task.state === "running"
      ? ov.last_task
      : null,
  );
  const [error, setError] = useState("");
  const [sec, setSec] = useState<"all" | "packages" | "source" | "runtime">(
    "all",
  );

  const slowRows = useDelayed(rows === null);
  const reloadRows = (force = false) => {
    setError("");
    const req = force
      ? api<ClosuresReply>(closuresPath(p.id))
      : fetchCached<ClosuresReply>(closuresPath(p.id));
    return req
      .then((r) => {
        setRows(r.closures);
        setMissing(r.missing);
      })
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => {
    reloadRows(false);
  }, [p.id, ov.busy, p.stats.closures]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (
      ov.last_task &&
      ov.last_task.platform === p.id &&
      ov.last_task.state === "running" &&
      task?.id !== ov.last_task.id
    ) {
      setTask(ov.last_task);
    }
  }, [ov.last_task, p.id, task?.id]);

  // Follow a running fetch until it ends.
  useEffect(() => {
    if (!task || task.state !== "running") return;
    const t = setInterval(() => {
      api<FetchTask>(`/api/library/tasks/${task.id}`)
        .then((x) => {
          setTask(x);
          if (x.state !== "running") {
            changed();
            reloadRows();
            x.state === "done"
              ? Message.success(
                  x.kind === "index"
                    ? bi("索引已更新", "Index updated")
                    : bi("软件包已入库", "Packages stored"),
                )
              : Message.error(
                  x.kind === "index"
                    ? bi("更新索引失败，详情见日志", "Index update failed; see logs")
                    : bi("获取失败，详情见日志", "Fetch failed; see logs"),
                );
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [task?.id, task?.state]);

  const keyOf = (r: PackageRequest) => `${r.name}=${r.version}`;

  const remove = (r: ClosureRow) =>
    Modal.confirm({
      title: bi(
        `从软件库删除 ${r.request.name} ${r.request.version}？`,
        `Delete ${r.request.name} ${r.request.version} from library?`,
      ),
      content: r.used_by?.length
        ? bi(
            `${r.used_by.join("、")} 需要它：删除后这些组件在 ${p.title} 上不能生成交付，直到重新获取或导入。已生成的交付不受影响。`,
            `Required by ${r.used_by.join(", ")}. Deliveries for these components on ${osTitle(p.title)} will be blocked until re-fetched or imported. Existing deliveries are unaffected.`,
          )
        : bi(
            "删除后释放它独占的文件；已生成的交付不受影响。",
            "Frees files exclusively used by this package; existing deliveries are unaffected.",
          ),
      okText: bi("删除", "Delete"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          await api("/api/library/delete", {
            method: "POST",
            body: JSON.stringify({
              platform: p.id,
              name: r.request.name,
              version: r.request.version,
            }),
          });
          Message.success(bi("已删除", "Deleted"));
          changed();
          reloadRows();
        } catch (e) {
          err(e);
        }
      },
    });

  const startFetch = async (pkgs: PackageRequest[]) => {
    try {
      const t = await api<FetchTask>("/api/library/fetch", {
        method: "POST",
        body: JSON.stringify({ platform: p.id, packages: pkgs }),
      });
      setTask(t);
      setFetchOpen(false);
      changed();
    } catch (e) {
      err(e);
    }
  };

  const direct = p.direct && p.index.files.length > 0; // search and download from the cached source indexes, no container
  const updateIndex = async () => {
    try {
      const t = await api<FetchTask>("/api/library/index/update", {
        method: "POST",
        body: JSON.stringify({ platform: p.id }),
      });
      setTask(t);
      changed();
    } catch (e) {
      err(e);
    }
  };
  const exportHref = withLang(
    `/api/library/export?platform=${encodeURIComponent(p.id)}${chosen.map((k) => `&pkg=${encodeURIComponent(k)}`).join("")}`,
  );
  const [guideOpen, setGuideOpen] = useState(false);
  const exportAll = () => {
    if (!rows?.length)
      return Message.info(
        bi("软件库里还没有软件包可以导出", "No packages in library to export"),
      );
    window.location.href = exportHref;
    Message.info(
      bi(
        `已开始下载 library-${p.id}.tar.gz：拷到不能联网的平台，在那边的软件库页点“更多 → 导入软件包”选择它`,
        `Downloading library-${p.id}.tar.gz. Transfer it to an air-gapped instance and choose "More → Import packages" on its Library page.`,
      ),
    );
  };
  const menu = (
    <Menu
      onClickMenuItem={(k) => {
        if (k === "import") setImportKind("packages");
        if (k === "export") exportAll();
        if (k === "guide") {
          setGuideOpen(true);
        }
      }}
    >
      <Menu.Item key="import" disabled={ov.busy}>
        <IconUpload /> {bi("导入软件包", "Import packages")}
      </Menu.Item>
      <Menu.Item key="export" disabled={!rows?.length}>
        <IconDownload />{" "}
        {chosen.length
          ? bi(`导出所选 ${chosen.length} 项`, `Export selected (${chosen.length})`)
          : bi("导出全部软件包", "Export all packages")}
      </Menu.Item>
      <Menu.Item key="guide">
        <IconQuestionCircle /> {bi("离线使用指引", "Offline workflow guide")}
      </Menu.Item>
    </Menu>
  );
  const t = splitTitle(p.title);
  const indexTask =
    task && task.kind === "index" && dismissed !== task.id ? task : null;
  const pkgTask =
    task && task.kind !== "index" && dismissed !== task.id ? task : null;
  return (
    <article className="detail enter lib">
      {narrow && (
        <Button
          type="text"
          className="back"
          icon={<IconArrowLeft />}
          onClick={() => go({ name: "library" })}
        >
          {bi("软件库", "Library")}
        </Button>
      )}
      <header className="lib-head">
        <OsLogo id={p.id} size={48} />
        <div className="lib-title">
          <h1>{t.name}</h1>
          <div className="lib-tags">
            {t.variant && <span className="lib-tag">{t.variant}</span>}
            {t.arch && <span className="lib-tag mono">{t.arch}</span>}
            <span className="lib-tag">{FAMILY[p.family]}</span>
            <span className={`plat-state pill ${p.deployable ? "ok" : "warn"}`}>
              {p.deployable
                ? bi("可生成离线交付", "Ready for offline delivery")
                : bi(
                    "还没有 Ansible 运行环境，暂时不能生成交付",
                    "No Ansible runtime selected; cannot build deliveries yet",
                  )}
            </span>
          </div>
        </div>
        {admin ? (
          <div className="lib-actions">
            <Button
              type="primary"
              icon={<IconPlus />}
              onClick={() => setFetchOpen(true)}
              disabled={ov.busy}
            >
              {bi("添加软件版本", "Add packages")}
            </Button>
            <Dropdown
              droplist={menu}
              trigger="click"
              position="br"
              triggerProps={{ autoFitPosition: true }}
            >
              <Button icon={<IconMore />} aria-label={bi("更多操作", "More actions")} />
            </Dropdown>
          </div>
        ) : (
          <div className="lib-actions">
            {p.direct && (
              <Button
                size="small"
                type="text"
                icon={<IconQuestionCircle />}
                onClick={() => setGuideOpen(true)}
              >
                {bi("离线使用指引", "Offline guide")}
              </Button>
            )}
            <span className="lib-ro-pill" role="status">
              {bi("只读浏览", "Read-only")}
            </span>
          </div>
        )}
      </header>

      <div className="lib-kpis" aria-label={bi("当前系统软件库概览", "OS library overview")}>
        {p.direct && (
          <button
            type="button"
            className="lib-kpi"
            onClick={() => setSec("source")}
          >
            <span className="lib-kpi-k">{bi("软件源索引", "Source Index")}</span>
            <b className="lib-kpi-v num">
              {p.index.files.length > 0
                ? bi(
                    `${p.index.packages.toLocaleString(getLang())} 个版本`,
                    `${p.index.packages.toLocaleString(getLang())} versions`,
                  )
                : bi("尚未拉取", "Not fetched")}
            </b>
            <span className="lib-kpi-s">
              {p.index.files.length > 0
                ? bi(
                    `${new Set(p.index.files.map((f) => f.source)).size} 个软件源 · 更新于 ${ago(p.index.updated || "")}`,
                    `${new Set(p.index.files.map((f) => f.source)).size} sources · updated ${ago(p.index.updated || "")}`,
                  )
                : bi("联网刷新或从外网导入", "Fetch online or import bundle")}
            </span>
          </button>
        )}
        <button
          type="button"
          className={`lib-kpi ${missing.length > 0 ? "is-warn" : ""}`}
          onClick={() => setSec("packages")}
        >
          <span className="lib-kpi-k">{bi("已入库软件包", "Stored Packages")}</span>
          <b className="lib-kpi-v num">
            {bi(
              `${rows?.length ?? p.stats.closures} 项`,
              `${rows?.length ?? p.stats.closures} items`,
            )}
          </b>
          <span className="lib-kpi-s">
            {missing.length > 0
              ? bi(
                  `${missing.length} 项待下载 · ${size(p.stats.bytes)}`,
                  `${missing.length} missing · ${size(p.stats.bytes)}`,
                )
              : bi(
                  `${p.stats.files} 个文件 · ${size(p.stats.bytes)}`,
                  `${p.stats.files} ${p.stats.files === 1 ? "file" : "files"} · ${size(p.stats.bytes)}`,
                )}
          </span>
        </button>
        <button
          type="button"
          className={`lib-kpi ${p.runtime ? "" : "is-warn"}`}
          onClick={() =>
            p.runtime
              ? setSec("runtime")
              : go({ name: "library", id: "ansible" })
          }
        >
          <span className="lib-kpi-k">{bi("Ansible 运行环境", "Ansible Runtime")}</span>
          <b className="lib-kpi-v mono">
            {p.runtime
              ? `ansible-core ${p.runtime.ansible || "?"}`
              : bi("未选定", "Unset")}
          </b>
          <span className="lib-kpi-s">
            {p.runtime
              ? bi(
                  `${p.runtime.packages.length} 个离线包 · ${size(p.runtime.size)}`,
                  `${p.runtime.packages.length} wheels · ${size(p.runtime.size)}`,
                )
              : bi("点此前往运行环境库配置", "Click to configure runtime")}
          </span>
        </button>
        <div className={`lib-kpi static ${p.deployable ? "is-ok" : "is-warn"}`}>
          <span className="lib-kpi-k">{bi("离线交付状态", "Delivery Readiness")}</span>
          <b className="lib-kpi-v">
            {p.deployable
              ? bi("就绪 · 可生成交付", "Ready to build")
              : bi("待补齐环境", "Needs runtime")}
          </b>
          <span className="lib-kpi-s">
            {p.deployable
              ? bi("目标机与控制节点均无需联网", "Air-gapped targets & controller")
              : bi("缺少 Ansible 离线运行环境", "Missing offline Ansible runtime")}
          </span>
        </div>
      </div>

      <UnderlineTabs
        className="lib-utabs"
        label={bi("软件库分区", "Library sections")}
        value={!p.direct && sec === "source" ? "all" : sec}
        onChange={(v) => setSec(v as typeof sec)}
        items={[
          { value: "all", label: bi("全部概览", "Overview"), icon: LibIcons.all },
          {
            value: "packages",
            label: bi("已入库软件包", "Packages"),
            count: rows?.length ?? p.stats.closures,
            icon: LibIcons.packages,
          },
          ...(p.direct
            ? [
                {
                  value: "source",
                  label: bi("软件源索引", "Source Index"),
                  count: p.index.files.length ? p.index.packages : undefined,
                  icon: LibIcons.source,
                },
              ]
            : []),
          {
            value: "runtime",
            label: bi("Ansible 运行环境", "Runtime"),
            icon: LibIcons.runtime,
          },
        ]}
      />

      <div className="lib-panels">
        {p.direct &&
          ((!p.direct && sec === "source" ? "all" : sec) === "all" ||
            sec === "source") && (
            <SourcePanel
              p={p}
              admin={admin}
              busy={ov.busy}
              task={indexTask}
              update={updateIndex}
              onImport={() => setImportKind("index")}
              onGuide={() => setGuideOpen(true)}
              onDismiss={() => indexTask && setDismissed(indexTask.id)}
            />
          )}

        {((!p.direct && sec === "source" ? "all" : sec) === "all" ||
          sec === "runtime") && <RuntimePanel p={p} />}

        {((!p.direct && sec === "source" ? "all" : sec) === "all" ||
          sec === "packages") && (
          <section className="lp" aria-label={bi("库里的软件包", "Packages in library")}>
          <div className="lp-head">
            <span className="lp-ic" aria-hidden>
              <IconStorage />
            </span>
            <div className="lp-htext">
              <div className="lp-trow">
                <b className="lp-title">{bi("库里的软件包", "Packages in Library")}</b>
                <span className="lp-count num">{rows?.length ?? 0}</span>
              </div>
              <span className="lp-sub">
                {bi(
                  `${p.stats.files} 个文件 · ${size(p.stats.bytes)} · 点开一项，看它装的时候会带上哪些依赖包`,
                  `${p.stats.files} ${p.stats.files === 1 ? "file" : "files"} · ${size(p.stats.bytes)} · expand a package to inspect its dependency tree`,
                )}
              </span>
            </div>
          </div>
          {pkgTask && (
            <div className="lp-body">
              <TaskCard
                task={pkgTask}
                onClose={() => setDismissed(pkgTask.id)}
              />
            </div>
          )}
          {missing.length > 0 && (
            <div className="lp-missing" role="status">
              <div className="lp-missing-left">
                <span className="lp-missing-ic" aria-hidden>
                  <IconExclamationCircle />
                </span>
                <div className="lp-missing-body">
                  <b>
                    {bi(
                      `组件需要、库里还没有的 ${missing.length} 个`,
                      `${missing.length} required ${missing.length === 1 ? "package" : "packages"} missing from library`,
                    )}
                  </b>
                  <div className="missing">
                    {missing.map((m) => (
                      <span className="lp-missing-chip mono" key={keyOf(m)}>
                        <span>{m.name}</span>
                        <span className="faint">{m.version}</span>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              {admin && direct && (
                <Button
                  type="primary"
                  size="small"
                  icon={<IconDownload />}
                  disabled={ov.busy}
                  onClick={() => startFetch(missing)}
                >
                  {bi("全部下载", "Download all")}
                </Button>
              )}
            </div>
          )}
          {error ? (
            <div className="lib-empty">
              <IconExclamationCircle className="bad" />
              <p>{error}</p>
              <Button
                size="small"
                icon={<IconRefresh />}
                onClick={() => reloadRows(true)}
              >
                {bi("重试", "Retry")}
              </Button>
            </div>
          ) : rows === null ? (
            <div
              className="lp-body"
              style={{ visibility: slowRows ? "visible" : "hidden" }}
            >
              <Skeleton animation text={{ rows: 4 }} />
            </div>
          ) : !rows.length ? (
            <div className="lib-empty">
              <p>
                <b>
                  {bi(
                    "这个系统的软件库还是空的",
                    "No packages in library for this OS",
                  )}
                </b>
              </p>
              <p className="muted small">
                {admin
                  ? bi(
                      "能联网就直接添加；不能联网，先在能联网的平台准备好再导入进来。",
                      "Fetch directly if online, or prepare on an online instance and import here.",
                    )
                  : bi("请管理员先准备软件包。", "Ask an administrator to prepare packages.")}
              </p>
              {admin && (
                <div className="row-gap">
                  <Button
                    type="primary"
                    size="small"
                    icon={<IconPlus />}
                    onClick={() => setFetchOpen(true)}
                  >
                    {bi("添加软件版本", "Add packages")}
                  </Button>
                  <Button
                    size="small"
                    icon={<IconUpload />}
                    onClick={() => setImportKind("packages")}
                  >
                    {bi("导入软件包", "Import packages")}
                  </Button>
                  {p.direct && (
                    <Button
                      size="small"
                      type="text"
                      icon={<IconBook />}
                      onClick={() => setGuideOpen(true)}
                    >
                      {bi("离线使用指南", "Offline guide")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <PackageList
              rows={rows}
              platformId={p.id}
              admin={admin}
              busy={ov.busy}
              chosen={chosen}
              setChosen={setChosen}
              remove={remove}
              exportHref={(k) =>
                withLang(
                  `/api/library/export?platform=${encodeURIComponent(p.id)}&pkg=${encodeURIComponent(k)}`,
                )
              }
            />
          )}
          </section>
        )}
      </div>

      <AddDrawer
        open={fetchOpen}
        onClose={() => setFetchOpen(false)}
        platform={p}
        start={startFetch}
        ready={direct}
        updateIndex={() => (setFetchOpen(false), updateIndex())}
        admin={admin}
      />
      <ImportDrawer
        open={importKind !== null}
        kind={lastKind.current}
        platform={p}
        onClose={() => setImportKind(null)}
        done={() => (changed(), reloadRows(true))}
      />
      {p.direct && (
        <GuideDrawer
          open={guideOpen}
          onClose={() => setGuideOpen(false)}
          p={p}
          admin={admin}
          hasPackages={(rows?.length || 0) > 0}
          onUpdate={updateIndex}
          onAdd={() => setFetchOpen(true)}
          onExportAll={exportAll}
          onImportIndex={() => setImportKind("index")}
          onImportPackages={() => setImportKind("packages")}
        />
      )}
    </article>
  );
}

/* ---------------------------------------------------------------- import */

/* ---------------------------------------------------------------- sources */

function SourcesDrawer({
  open,
  onClose,
  narrow,
  changed,
}: {
  open: boolean;
  onClose: () => void;
  narrow: boolean;
  changed: () => void;
}) {
  useLang();
  const [data, setData] = useState<{
    effective: PackageSource[];
    custom: string;
    builtin: string;
  } | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError("");
    api<{ effective: PackageSource[]; custom: string; builtin: string }>(
      "/api/library/sources",
    )
      .then((r) => {
        setData(r);
        setText(r.custom || "");
      })
      .catch((e) => setError((e as Error).message));
  }, [open]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{
        effective: PackageSource[];
        custom: string;
        builtin: string;
      }>("/api/library/sources", {
        method: "PUT",
        body: JSON.stringify({ yaml: text }),
      });
      setData(r);
      Message.success(bi("软件源已保存", "Sources saved"));
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      width={narrow ? "100%" : 720}
      visible={open}
      onCancel={onClose}
      title={bi("软件源", "Package Sources")}
      footer={
        <div className="review-foot">
          <span className="muted small">
            {bi(
              "只影响以后“获取软件包”；库里已有的不变",
              "Affects future package fetches only; stored packages stay untouched",
            )}
          </span>
          <div className="row-gap">
            <Button onClick={() => setText(data?.builtin || "")}>
              {bi("以内置列表为底稿", "Use built-in as draft")}
            </Button>
            <Button type="primary" loading={busy} onClick={save}>
              {bi("保存", "Save")}
            </Button>
          </div>
        </div>
      }
    >
      <p className="muted small">
        {biv(
          <>
            平台内置了各系统官方源。下面的“自定义”会按 <code>id</code>{" "}
            覆盖同名内置源：把地址改成内网镜像、或加 <code>disabled: true</code>{" "}
            关掉某个源，也可以新增。获取软件包时始终验证签名，所以{" "}
            <code>key_file</code> 必填。
          </>,
          <>
            Official OS sources are built in. Custom entries below override
            matching built-in sources by <code>id</code> (for example, to use an
            internal mirror or set <code>disabled: true</code>), or add new
            ones. Signature verification is always enforced, so{" "}
            <code>key_file</code> is required.
          </>,
        )}
      </p>
      {error && <div className="note warn">{error}</div>}
      <h4>{bi("当前生效", "Active Sources")}</h4>
      <table className="rtable">
        <tbody>
          {(data?.effective || []).map((s) => (
            <tr key={s.id} className={s.disabled ? "old" : ""}>
              <th>
                <span className="mono">{s.id}</span>
                <div className="small faint">{s.title}</div>
              </th>
              <td className="small">
                {s.platforms.join(bi("、", ", "))}
                <div className="mono faint">{s.url || s.baseurl}</div>
              </td>
              <td>
                {s.disabled ? (
                  <span className="flag">{bi("已停用", "Disabled")}</span>
                ) : s.builtin ? (
                  <span className="flag">{bi("内置", "Built-in")}</span>
                ) : (
                  <span className="flag warn">{bi("自定义", "Custom")}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>{bi("自定义（YAML）", "Custom (YAML)")}</h4>
      <textarea
        className="yaml-edit mono"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={bi("自定义软件源 YAML", "Custom sources YAML")}
        placeholder={
          "- id: ubuntu-noble\n  platforms: [ubuntu-24.04-amd64]\n  kind: apt\n  url: https://mirrors.example.com/ubuntu\n  suites: [noble, noble-updates, noble-security]\n  components: [main, universe]\n  key_file: ubuntu-archive-keyring.gpg"
        }
      />
      {data?.builtin && (
        <details>
          <summary className="small muted">
            {bi("查看内置列表", "View built-in sources")}
          </summary>
          <Terminal code={data.builtin} host="sources.yaml" />
        </details>
      )}
    </Drawer>
  );
}

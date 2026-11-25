import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@arco-design/web-react";
import {
  IconCheck,
  IconCheckCircleFill,
  IconCloseCircleFill,
  IconCode,
  IconCopy,
  IconDown,
  IconList,
  IconLoading,
} from "@arco-design/web-react/icon";
import { copy, size } from "./shared";
import type { FetchTask, TaskStep } from "./shared";
import { bi, getLang, useLang } from "./i18n";

function txStep(s: string): string {
  if (!s || getLang() !== "en-US") return s;
  const exact: Record<string, string> = {
    软件包: "Packages",
    软件包清单: "Package index",
    仓库清单与签名: "Repo metadata & signature",
    发布清单与签名: "Release manifest & signature",
    "解析依赖并下载 wheel": "Resolve deps & download wheels",
    存入软件库: "Save to library",
    下载并校验: "Downloading & verifying",
    读取并验证签名: "Reading & verifying signature",
    已校验: "Verified",
    签名有效: "Signature valid",
    库里已有: "In library",
    没有变化: "No changes",
    其他: "Other",
  };
  if (exact[s]) return exact[s];
  let m = /^(.+?)\s*·\s*发布清单与签名$/.exec(s);
  if (m) return `${m[1]} · Release manifest & signature`;
  m = /^下载\s+(.+)$/.exec(s);
  if (m) return `Downloading ${m[1]}`;
  m = /^运行环境\s+(.+)$/.exec(s);
  if (m) return `Runtime ${m[1]}`;
  m = /^已入库\s*·\s*(\d+)\s*个文件$/.exec(s);
  if (m) return `Stored · ${m[1]} ${m[1] === "1" ? "file" : "files"}`;
  m = /^(\d[\d,]*)\s*个版本$/.exec(s);
  if (m) return `${m[1]} ${m[1] === "1" ? "version" : "versions"}`;
  m = /^(\d+)\s*个\s*wheel$/i.exec(s);
  if (m) return `${m[1]} ${m[1] === "1" ? "wheel" : "wheels"}`;
  m = /^(\d+)\s*个软件包\s*·\s*(.+)$/.exec(s);
  if (m) return `${m[1]} ${m[1] === "1" ? "package" : "packages"} · ${m[2]}`;
  m = /^(\d+)\s*个文件$/.exec(s);
  if (m) return `${m[1]} ${m[1] === "1" ? "file" : "files"}`;
  return s;
}

const finished = (s: TaskStep) => s.state === "done" || s.state === "skipped";

const seconds = (task: FetchTask, nowMs = Date.now()) => {
  const a = Date.parse(task.started);
  const b = task.finished ? Date.parse(task.finished) : nowMs;
  return Number.isFinite(a) && Number.isFinite(b)
    ? Math.max(1, Math.round((b - a) / 1000))
    : 0;
};

const TASK_LOG_WINDOW_STEP = 1000;

/** Isolated 1Hz elapsed clock leaf so ticking never re-renders TaskCard step groups or multi-thousand-line logs. */
function LiveTaskElapsed({ task }: { task: FetchTask }) {
  useLang();
  const running = task.state === "running" && !task.finished;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    const t = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [running]);
  const secs = seconds(task, now);
  if (secs <= 0) return null;
  return (
    <span className="tk-stat time num">
      <ClockGlyph /> {bi(`用时 ${secs} 秒`, `${secs}s elapsed`)}
    </span>
  );
}

type StepFilter = "all" | "done" | "skipped" | "failed";

type TaskGroup = {
  key: string;
  head?: TaskStep;
  title: string;
  items: TaskStep[];
};

function ClockGlyph() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6v3.5l2.3 1.4" />
    </svg>
  );
}

function WrapGlyph() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4.2h11M2.5 8h8a2.2 2.2 0 1 1 0 4.4H8.6M10.2 10.7 8.2 12.4l2 1.7M2.5 11.8h3.4" />
    </svg>
  );
}

function StepMark({ s }: { s: TaskStep["state"] }) {
  useLang();
  if (s === "done")
    return (
      <IconCheckCircleFill
        className="tk-ic s-done"
        aria-label={bi("完成", "Done")}
      />
    );
  if (s === "failed")
    return (
      <IconCloseCircleFill
        className="tk-ic s-fail"
        aria-label={bi("失败", "Failed")}
      />
    );
  if (s === "running")
    return (
      <IconLoading
        spin
        className="tk-ic s-run"
        aria-label={bi("进行中", "Running")}
      />
    );
  if (s === "skipped")
    return (
      <span className="tk-ic s-skip" aria-label={bi("沿用本地", "Cached")}>
        –
      </span>
    );
  return <span className="tk-ic s-wait" aria-label={bi("等待", "Pending")} />;
}

/** Break step labels like "noble-updates · main 软件包清单" into suite/component pills. */
function renderStepLabel(s: TaskStep) {
  const raw = s.label || s.id.split("|").slice(1).join(" · ") || s.id;
  const dotIdx = raw.indexOf(" · ");
  if (dotIdx > 0) {
    const scope = raw.slice(0, dotIdx).trim();
    const rest = raw.slice(dotIdx + 3).trim();
    const pkgMatch = /^(\S+)\s+(软件包清单|Package index)$/i.exec(rest);
    if (pkgMatch) {
      return (
        <span className="tk-label">
          <span className="tk-tag suite mono">{scope}</span>
          <span className="tk-tag comp mono">{pkgMatch[1]}</span>
          <span className="tk-title-txt">{txStep(pkgMatch[2])}</span>
        </span>
      );
    }
    return (
      <span className="tk-label">
        <span className="tk-tag suite mono">{scope}</span>
        <span className="tk-title-txt">{txStep(rest)}</span>
      </span>
    );
  }
  if (s.id.startsWith("f|")) {
    const sp = raw.lastIndexOf(" ");
    if (sp > 0) {
      return (
        <span className="tk-label">
          <span className="tk-pkg-name mono">{raw.slice(0, sp)}</span>
          <span className="tk-tag ver mono">{raw.slice(sp + 1)}</span>
        </span>
      );
    }
  }
  return (
    <span className="tk-label">
      <span className="tk-title-txt">{txStep(raw)}</span>
    </span>
  );
}

/** Format step detail + byte size as readable chips and semantic state badges. */
function renderStepMeta(s: TaskStep, withSize: boolean) {
  const detail = (s.detail || "").trim();
  const sz = withSize && s.size ? size(s.size) : "";

  if (s.state === "failed") {
    return (
      <span className="tk-meta">
        {detail && <span className="tk-fail-msg">{detail}</span>}
        <span className="tk-badge bad">{bi("失败", "Failed")}</span>
      </span>
    );
  }

  if (s.state === "running") {
    return (
      <span className="tk-meta">
        <span className="tk-badge run">
          {detail ? txStep(detail) : bi("处理中", "Processing")}
        </span>
      </span>
    );
  }

  if (s.state === "skipped") {
    const parts = detail
      ? detail
          .split("·")
          .map((p) => p.trim())
          .filter((p) => p && !/^(没有变化|No changes)$/i.test(p))
      : [];
    return (
      <span className="tk-meta">
        {parts.map((p, idx) => (
          <span key={idx} className="tk-chip num">
            {txStep(p)}
          </span>
        ))}
        {sz && <span className="tk-chip num sz">{sz}</span>}
        <span className="tk-badge skip">{bi("沿用本地", "Cached")}</span>
      </span>
    );
  }

  if (detail === "签名有效" || detail === "Signature valid") {
    return (
      <span className="tk-meta">
        <span className="tk-badge ok">{bi("签名有效", "Signature valid")}</span>
      </span>
    );
  }

  const parts = detail
    ? detail
        .split("·")
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  if (s.state === "done" && parts.length > 0) {
    const verPart = parts.find((p) => /个版本|wheel|version/i.test(p));
    const sizePart = parts.find((p) => /\b(B|KB|MB|GB)\b/i.test(p));
    const otherParts = parts.filter((p) => p !== verPart && p !== sizePart);
    return (
      <span className="tk-meta">
        {verPart && <span className="tk-chip num">{txStep(verPart)}</span>}
        {(sizePart || sz) && (
          <span className="tk-chip num sz">{sizePart || sz}</span>
        )}
        {otherParts.map((p, idx) => (
          <span key={idx} className="tk-badge ok">
            {txStep(p)}
          </span>
        ))}
        {!otherParts.length && (
          <span className="tk-badge ok">{bi("已更新", "Updated")}</span>
        )}
      </span>
    );
  }

  return (
    <span className="tk-meta">
      {detail && <span className="tk-detail">{txStep(detail)}</span>}
      {sz && <span className="tk-chip num sz">{sz}</span>}
    </span>
  );
}

function Rows({ steps, withSize }: { steps: TaskStep[]; withSize: boolean }) {
  return (
    <ul className="tk-rows">
      {steps.map((s) => (
        <li key={s.id} className={`st-${s.state}`}>
          <StepMark s={s.state} />
          {renderStepLabel(s)}
          {renderStepMeta(s, withSize)}
        </li>
      ))}
    </ul>
  );
}

function SourceGroupCard({
  group,
  withSize,
  collapsed,
  onToggle,
}: {
  group: TaskGroup;
  withSize: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  useLang();
  const doneCount = group.items.filter((x) => x.state === "done").length;
  const skipCount = group.items.filter((x) => x.state === "skipped").length;
  const failCount = group.items.filter((x) => x.state === "failed").length;
  const runCount = group.items.filter((x) => x.state === "running").length;
  const total = Math.max(1, group.items.length);

  const groupState: TaskStep["state"] = group.head
    ? group.head.state
    : failCount > 0
      ? "failed"
      : runCount > 0
        ? "running"
        : doneCount > 0
          ? "done"
          : skipCount === group.items.length && total > 0
            ? "skipped"
            : "pending";

  return (
    <div className={`tk-group ${collapsed ? "is-collapsed" : ""}`}>
      {group.title && (
        <button
          type="button"
          className="tk-gh"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <IconDown className={`tk-gchev ${collapsed ? "is-shut" : ""}`} />
          <StepMark s={groupState} />
          <b className="tk-gtitle">{txStep(group.title)}</b>
          <span className="tk-gmeta">
            {group.head?.detail ? (
              <span className="tk-chip">{txStep(group.head.detail)}</span>
            ) : (
              <>
                <span className="tk-gbar" aria-hidden="true">
                  {doneCount > 0 && (
                    <i
                      className="is-done"
                      style={{ width: `${(doneCount / total) * 100}%` }}
                    />
                  )}
                  {skipCount > 0 && (
                    <i
                      className="is-skip"
                      style={{ width: `${(skipCount / total) * 100}%` }}
                    />
                  )}
                  {failCount > 0 && (
                    <i
                      className="is-fail"
                      style={{ width: `${(failCount / total) * 100}%` }}
                    />
                  )}
                </span>
                {doneCount > 0 && (
                  <span className="tk-gpill ok num">
                    {bi(`${doneCount} 更新`, `${doneCount} updated`)}
                  </span>
                )}
                {skipCount > 0 && (
                  <span className="tk-gpill skip num">
                    {bi(`${skipCount} 沿用`, `${skipCount} cached`)}
                  </span>
                )}
                {failCount > 0 && (
                  <span className="tk-gpill bad num">
                    {bi(`${failCount} 失败`, `${failCount} failed`)}
                  </span>
                )}
                {!doneCount && !skipCount && !failCount && (
                  <span className="tk-gpill num">
                    {bi(
                      `${group.items.length} 项`,
                      `${group.items.length} ${group.items.length === 1 ? "item" : "items"}`,
                    )}
                  </span>
                )}
              </>
            )}
          </span>
        </button>
      )}
      {(!group.title || !collapsed) && (
        <Rows steps={group.items} withSize={withSize} />
      )}
    </div>
  );
}

/** Classify & highlight console log lines for fast visual scanning while preserving raw clipboard output. */
function renderLogLine(line: string, lineNo: number) {
  const trimmed = line.trim();
  const isErr = /失败|错误|拒绝|不一致|\berror\b|\bfailed\b|\brefused\b|\bmismatch\b/i.test(trimmed);
  const isOk = !isErr && /(索引已更新|已入库|已准备好|同步完成|\bIndex updated\b|\bStored\b)/i.test(trimmed);
  const isSkip =
    !isErr && /(没有变化|沿用本地|库里已有|\bNo changes\b|\bCached\b)/i.test(trimmed);
  const isDl = !isErr && !isSkip && /^(下载|Downloading)\s+/i.test(trimmed);
  const isPhase =
    !isErr && !isOk && !isSkip && !isDl && /^(读取|在\s+\S+\s+容器|解析|Reading|Resolving)/i.test(trimmed);

  const kind = isErr
    ? "is-err"
    : isOk
      ? "is-ok"
      : isDl
        ? "is-dl"
        : isPhase
          ? "is-phase"
          : isSkip
            ? "is-skip"
            : "is-plain";

  let body: React.ReactNode = line;

  if (isErr) {
    body = <span className="tk-lerr">{trimmed}</span>;
  } else if (isOk) {
    const m = /^(索引已更新)\s*[:：]\s*(.+)$/.exec(trimmed);
    body = m ? (
      <>
        <span className="tk-ltag ok">DONE</span>
        <span className="tk-lok">{m[1]}</span>
        <span className="tk-lsep">·</span>
        <span className="tk-lcnt num">{m[2]}</span>
      </>
    ) : (
      <>
        <span className="tk-ltag ok">DONE</span>
        <span className="tk-lok">{trimmed}</span>
      </>
    );
  } else if (isPhase) {
    const m = /^读取\s+(.+?)\s+\/\s+(\S+)\s+(的发布清单.*)$/.exec(trimmed);
    if (m) {
      body = (
        <>
          <span className="tk-ltag read">READ</span>
          <span className="tk-lsrc">{m[1]}</span>
          <span className="tk-lsep">/</span>
          <span className="tk-lsuite">{m[2]}</span>
          <span className="tk-lmute">{m[3]}</span>
        </>
      );
    } else {
      body = (
        <>
          <span className="tk-ltag read">STEP</span>
          <span className="tk-lsrc">{trimmed}</span>
        </>
      );
    }
  } else if (isDl) {
    const m = /^下载\s+(.+?)\s*[（(]([^）)]+)[）)]$/.exec(trimmed);
    if (m) {
      body = (
        <>
          <span className="tk-ltag dl">GET</span>
          <span className="tk-lpath">{m[1]}</span>
          <span className="tk-lsize num">{m[2]}</span>
        </>
      );
    } else {
      body = (
        <>
          <span className="tk-ltag dl">GET</span>
          <span className="tk-lpath">{trimmed.replace(/^下载\s+/, "")}</span>
        </>
      );
    }
  } else if (isSkip) {
    const m = /^(.+?)\s+(没有变化，沿用本地|库里已有.*)$/.exec(trimmed);
    if (m) {
      body = (
        <>
          <span className="tk-ltag skip">SKIP</span>
          <span className="tk-lpath dim">{m[1]}</span>
          <span className="tk-lskip">{m[2]}</span>
        </>
      );
    } else {
      body = (
        <>
          <span className="tk-ltag skip">SKIP</span>
          <span className="tk-lskip">{trimmed}</span>
        </>
      );
    }
  }

  return (
    <div className={`tk-log-ln ${kind}`} key={lineNo}>
      <span className="tk-ln-no num" aria-hidden="true">
        {lineNo + 1}
      </span>
      <span className="tk-ln-msg">{body}</span>
    </div>
  );
}

const MemoTaskLogLines = React.memo(function MemoTaskLogLines({
  lines,
  offset,
}: {
  lines: string[];
  offset: number;
}) {
  return <>{lines.map((l, idx) => renderLogLine(l, offset + idx))}</>;
});

/**
 * Structured operation progress and result panel for source index refreshes, package fetches, and Python runtimes.
 */
export function TaskCard({
  task,
  onClose,
}: {
  task: FetchTask;
  onClose?: () => void;
}) {
  const lang = useLang();
  const steps = task.steps || [];
  const isPy = task.kind === "python";
  const isIndex = task.kind === "index" || isPy;
  const running = task.state === "running";
  const failed = task.state === "failed";
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState<StepFilter>("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [wrap, setWrap] = useState(true);
  const [logLimit, setLogLimit] = useState(TASK_LOG_WINDOW_STEP);
  const logRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (failed) setOpen(true);
  }, [failed]);

  useEffect(() => {
    setFilter("all");
    setCollapsed({});
    setLogLimit(TASK_LOG_WINDOW_STEP);
    nearBottomRef.current = true;
  }, [task.id]);

  useEffect(() => {
    if (!raw || !nearBottomRef.current) return;
    const raf = window.requestAnimationFrame(() => {
      const el = logRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [raw, task.logs.length]);

  const reqs = steps.filter((s) => s.id.startsWith("req|"));
  const files = steps.filter((s) => s.id.startsWith("f|"));
  const unit = isIndex ? steps : files.length ? files : steps;
  const bytesTotal = files.reduce((n, s) => n + (s.size || 0), 0);
  const bytesDone = files
    .filter(finished)
    .reduce((n, s) => n + (s.size || 0), 0);
  const percent = !running
    ? 100
    : !isIndex && bytesTotal
      ? Math.round((bytesDone / bytesTotal) * 100)
      : Math.round(
          (unit.filter(finished).length / Math.max(1, unit.length)) * 100,
        );
  const now =
    steps.find((s) => s.state === "running" && !s.id.startsWith("req|")) ||
    steps.find((s) => s.state === "running");
  const bad = steps.find((s) => s.state === "failed");
  const downloaded = files.filter((s) => s.state === "done");
  const skipped = (isIndex ? steps : files).filter(
    (s) => s.state === "skipped",
  );
  const doneSteps = steps.filter((s) => s.state === "done");
  const failedSteps = steps.filter((s) => s.state === "failed");

  const title = isPy
    ? running
      ? bi("正在准备运行环境", "Building runtime")
      : failed
        ? bi("运行环境没有准备好", "Runtime build failed")
        : bi("运行环境已准备好", "Runtime ready")
    : isIndex
      ? running
        ? bi("正在更新软件源索引", "Updating source index")
        : failed
          ? bi("更新软件源索引没有完成", "Source index update failed")
          : bi("软件源索引已更新", "Source index updated")
      : running
        ? bi(
            `正在下载 ${task.packages.length} 个软件版本`,
            `Downloading ${task.packages.length} ${task.packages.length === 1 ? "package" : "packages"}`,
          )
        : failed
          ? bi("下载没有完成", "Download failed")
          : bi("下载完成", "Download complete");

  const groups: TaskGroup[] = useMemo(() => {
    if (isIndex) {
      const grouped = steps.reduce<Record<string, TaskStep[]>>((m, s) => {
        (m[s.group || bi("其他", "Other")] ||= []).push(s);
        return m;
      }, {});
      return Object.entries(grouped).map(([gTitle, items]) => ({
        key: gTitle,
        title: gTitle,
        items,
      }));
    }
    if (reqs.length) {
      return reqs.map((r) => ({
        key: r.id,
        head: r,
        title: r.label,
        items: files.filter((f) => f.group === r.label),
      }));
    }
    return [{ key: "all", title: "", items: steps }];
  }, [isIndex, steps, reqs, files, lang]);

  const visibleGroups = useMemo(() => {
    if (filter === "all" || running) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter((s) => s.state === filter),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, filter, running]);

  const detailCount = steps.filter((s) => !s.id.startsWith("req|")).length;
  const hasLogs = (task.logs.length > 0 || steps.length === 0) && !running;
  const allCollapsed =
    visibleGroups.length > 1 &&
    visibleGroups.every((g) => collapsed[g.key]);

  const renderSummaryChips = () => {
    if (running) {
      return (
        <div className="tk-summary-pills">
          <span className="tk-sub muted">
            {now
              ? `${txStep(now.label)}${now.detail ? " · " + txStep(now.detail) : ""}`
              : task.logs[task.logs.length - 1]?.trim() ||
                bi("准备中…", "Preparing…")}
          </span>
          <LiveTaskElapsed task={task} />
        </div>
      );
    }
    if (failed) {
      return (
        <div className="tk-summary-pills">
          <span className="tk-stat bad">
            <i />
            {bad
              ? `${txStep(bad.label)}${bi("：", ": ")}${bad.detail ? txStep(bad.detail) : task.error || bi("失败", "Failed")}`
              : task.error || bi("操作失败", "Operation failed")}
          </span>
          <LiveTaskElapsed task={task} />
        </div>
      );
    }
    if (isPy) {
      const pySummary = (
        steps.find((s) => s.id === "parse") ||
        steps.find((s) => s.id === "query") ||
        steps.find((s) => s.id === "save")
      )?.detail;
      return (
        <div className="tk-summary-pills">
          <span className="tk-stat ok">
            <i /> {pySummary ? txStep(pySummary) : bi("已完成", "Completed")}
          </span>
          <LiveTaskElapsed task={task} />
        </div>
      );
    }
    if (isIndex) {
      return (
        <div className="tk-summary-pills">
          <span className="tk-stat ok num">
            <i /> {bi(`${doneSteps.length} 项已更新`, `${doneSteps.length} updated`)}
          </span>
          {skipped.length > 0 && (
            <span className="tk-stat skip num">
              <i /> {bi(`${skipped.length} 项沿用本地`, `${skipped.length} cached`)}
            </span>
          )}
          <LiveTaskElapsed task={task} />
        </div>
      );
    }
    const dlBytes = downloaded.reduce((n, s) => n + (s.size || 0), 0);
    return (
      <div className="tk-summary-pills">
        <span className="tk-stat ok num">
          <i />{" "}
          {bi(
            `${downloaded.length} 个文件已下载（${size(dlBytes)}）`,
            `${downloaded.length} ${downloaded.length === 1 ? "file" : "files"} downloaded (${size(dlBytes)})`,
          )}
        </span>
        {skipped.length > 0 && (
          <span className="tk-stat skip num">
            <i /> {bi(`${skipped.length} 个库中已有`, `${skipped.length} in library`)}
          </span>
        )}
        <LiveTaskElapsed task={task} />
      </div>
    );
  };

  return (
    <section
      className={`tk ${task.state}`}
      aria-live="polite"
      aria-label={title}
    >
      <div className="tk-top">
        <span className="tk-state" aria-hidden="true">
          {running ? (
            <IconLoading spin />
          ) : failed ? (
            <IconCloseCircleFill />
          ) : (
            <IconCheckCircleFill />
          )}
        </span>
        <div className="tk-text">
          <div className="tk-title-line">
            <b>{title}</b>
          </div>
          {renderSummaryChips()}
        </div>
        <div className="tk-acts">
          {running && <span className="num small tk-pct">{percent}%</span>}
          {!running && steps.length > 0 && (
            <button
              type="button"
              className={`tk-pill ${open ? "on" : ""}`}
              onClick={() => setOpen(!open)}
              aria-expanded={open}
            >
              <IconList />
              <span>{bi("明细", "Details")}</span>
              <em className="num">{detailCount}</em>
              <IconDown className={open ? "tk-flip" : ""} />
            </button>
          )}
          {hasLogs && (
            <button
              type="button"
              className={`tk-pill ${raw ? "on" : ""}`}
              onClick={() => setRaw(!raw)}
              aria-expanded={raw}
            >
              <IconCode />
              <span>{bi("原始日志", "Raw logs")}</span>
              {task.logs.length > 0 && (
                <em className="num">{task.logs.length}</em>
              )}
              <IconDown className={raw ? "tk-flip" : ""} />
            </button>
          )}
          {!running && onClose && (
            <Button
              type="text"
              size="mini"
              className="tk-close"
              onClick={onClose}
            >
              {bi("收起", "Hide")}
            </Button>
          )}
        </div>
      </div>

      {running && (
        <div
          className="tk-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={bi("总进度", "Overall progress")}
        >
          <i style={{ width: `${Math.max(3, percent)}%` }} />
        </div>
      )}

      {(open || running) && steps.length > 0 && (
        <div className="tk-detail-box">
          {!running &&
            (groups.length > 1 || (doneSteps.length > 0 && skipped.length > 0)) && (
              <div className="tk-dbar">
                <div
                  className="tk-dfilters"
                  role="group"
                  aria-label={bi("按结果筛选", "Filter by status")}
                >
                  <button
                    type="button"
                    className={`tk-df ${filter === "all" ? "on" : ""}`}
                    onClick={() => setFilter("all")}
                  >
                    {bi("全部", "All")} <em className="num">{detailCount}</em>
                  </button>
                  {doneSteps.length > 0 && (
                    <button
                      type="button"
                      className={`tk-df ${filter === "done" ? "on" : ""}`}
                      onClick={() => setFilter("done")}
                    >
                      {bi("已更新", "Updated")}{" "}
                      <em className="num">{doneSteps.length}</em>
                    </button>
                  )}
                  {skipped.length > 0 && (
                    <button
                      type="button"
                      className={`tk-df ${filter === "skipped" ? "on" : ""}`}
                      onClick={() => setFilter("skipped")}
                    >
                      {bi("沿用本地", "Cached")}{" "}
                      <em className="num">{skipped.length}</em>
                    </button>
                  )}
                  {failedSteps.length > 0 && (
                    <button
                      type="button"
                      className={`tk-df bad ${filter === "failed" ? "on" : ""}`}
                      onClick={() => setFilter("failed")}
                    >
                      {bi("失败", "Failed")}{" "}
                      <em className="num">{failedSteps.length}</em>
                    </button>
                  )}
                </div>
                {visibleGroups.length > 1 && (
                  <button
                    type="button"
                    className="tk-df-fold"
                    onClick={() => {
                      const next: Record<string, boolean> = {};
                      if (!allCollapsed) {
                        visibleGroups.forEach((g) => {
                          next[g.key] = true;
                        });
                      }
                      setCollapsed(next);
                    }}
                  >
                    {allCollapsed
                      ? bi("全部展开", "Expand all")
                      : bi("全部收起", "Collapse all")}
                  </button>
                )}
              </div>
            )}
          <div className="tk-groups">
            {visibleGroups.map((g) => (
              <SourceGroupCard
                key={g.key}
                group={g}
                withSize={!isIndex}
                collapsed={!!collapsed[g.key]}
                onToggle={() =>
                  setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))
                }
              />
            ))}
          </div>
        </div>
      )}

      {raw && (
        <div className="tk-log-box">
          <div className="tk-log-head">
            <div className="tk-log-left">
              <span className="tk-log-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="tk-log-title">
                <IconCode /> {bi("同步输出日志", "Sync output log")}
              </span>
              {task.logs.length > 0 && (
                <em className="tk-log-cnt num">
                  {bi(
                    `${task.logs.length} 行`,
                    `${task.logs.length} ${task.logs.length === 1 ? "line" : "lines"}`,
                  )}
                </em>
              )}
            </div>
            <div className="tk-log-tools">
              <button
                type="button"
                className={`tk-log-btn ${wrap ? "on" : ""}`}
                onClick={() => setWrap((w) => !w)}
                title={
                  wrap
                    ? bi(
                        "当前自动换行，点击改为横向滚动",
                        "Line wrap enabled; click for horizontal scroll",
                      )
                    : bi("点击开启自动换行", "Enable line wrap")
                }
              >
                <WrapGlyph />
                <span>{bi("换行", "Wrap")}</span>
              </button>
              {task.logs.length > 0 && (
                <button
                  type="button"
                  className={`tk-log-btn ${copied ? "done" : ""}`}
                  onClick={() => {
                    copy(task.logs.join("\n"));
                    setCopied(true);
                    if (copyTimerRef.current !== null)
                      window.clearTimeout(copyTimerRef.current);
                    copyTimerRef.current = window.setTimeout(
                      () => setCopied(false),
                      1500,
                    );
                  }}
                >
                  {copied ? <IconCheck /> : <IconCopy />}
                  <span>
                    {copied ? bi("已复制", "Copied") : bi("复制", "Copy")}
                  </span>
                </button>
              )}
            </div>
          </div>
          <div
            className={`tk-log-body mono ${wrap ? "wrap" : ""}`}
            ref={logRef}
            role="log"
            aria-label={bi("原始日志", "Raw logs")}
            onScroll={(e) => {
              const el = e.currentTarget;
              nearBottomRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
          >
            {task.logs.length ? (
              (() => {
                const startIdx = Math.max(0, task.logs.length - logLimit);
                const visibleLogs =
                  startIdx > 0 ? task.logs.slice(startIdx) : task.logs;
                return (
                  <>
                    {startIdx > 0 && (
                      <div className="tk-log-window-bar">
                        <span>
                          {bi(
                            `已折叠较早的 ${startIdx} 行输出`,
                            `${startIdx} earlier lines hidden`,
                          )}
                        </span>
                        <span className="tk-log-window-acts">
                          <button
                            type="button"
                            onClick={() => {
                              nearBottomRef.current = false;
                              setLogLimit((n) => n + TASK_LOG_WINDOW_STEP);
                            }}
                          >
                            {bi(
                              `加载前 ${Math.min(startIdx, TASK_LOG_WINDOW_STEP)} 行`,
                              `Load ${Math.min(startIdx, TASK_LOG_WINDOW_STEP)} earlier`,
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              nearBottomRef.current = false;
                              setLogLimit(task.logs.length);
                            }}
                          >
                            {bi("显示全部", "Show all")}
                          </button>
                        </span>
                      </div>
                    )}
                    <MemoTaskLogLines lines={visibleLogs} offset={startIdx} />
                  </>
                );
              })()
            ) : (
              <div className="tk-log-ln is-plain">
                <span className="tk-ln-no num">1</span>
                <span className="tk-ln-msg tk-lmute">
                  {bi("准备中…", "Preparing…")}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {failed && task.error && !bad && (
        <div className="note warn tk-err-note">{task.error}</div>
      )}
    </section>
  );
}

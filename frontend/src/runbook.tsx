import React, { useContext, useEffect, useMemo, useState } from "react";
import { AI_CHANGED, AIReports, Spark, readFile, useAIDock } from "./aichat";
import type { AIReport } from "./aichat";
import {
  Button,
  Input,
  Message,
  Modal,
  Radio,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowDown,
  IconBulb,
  IconCode,
  IconImage,
  IconLock,
  IconPlayArrow,
  IconUpload,
  IconCheck,
  IconClose,
  IconCopy,
  IconDown,
  IconDownload,
  IconEdit,
  IconExclamationCircle,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  can,
  copy,
  err,
  fullTime,
  reducedMotion,
  size,
  useAIStatus,
} from "./shared";
import type { DeliveryPlan, JobFile, JobSync, PlanStep } from "./shared";
import { Segmented } from "./ui";
import { dispatchExecLaunchIntent, StepHotfixDrawer } from "./stephotfix";
import { bi, getLang, useLang, withLang } from "./i18n";

const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "do",
  "done",
  "while",
  "case",
  "esac",
  "in",
]);
const TOKEN =
  /(#.*$)|('[^']*'|"(?:[^"\\]|\\.)*")|(\$\{[^}]+\}|\$\w+)|(&&|\|\||[;|<>])|(\[\[|\]\])|([^\s'"$;&|<>]+)|(\s+)/g;

function highlight(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let expectCmd = true;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  let k = 0;
  while ((m = TOKEN.exec(line))) {
    const [tok, comment, str, variable, op, bracket, word] = m;
    let cls = "";
    if (comment && (m.index === 0 || /\s/.test(line[m.index - 1])))
      cls = "tk-c";
    else if (str) cls = "tk-s";
    else if (variable) cls = "tk-v";
    else if (op) {
      cls = "tk-o";
      expectCmd = true;
    } else if (bracket) cls = "tk-o";
    else if (word) {
      if (KEYWORDS.has(word)) {
        cls = "tk-k";
        expectCmd = word !== "in";
      } else if (expectCmd) {
        cls = "tk-cmd";
        expectCmd = false;
      } else if (/^--?[\w-]/.test(word)) cls = "tk-f";
      else if (/^\d+$/.test(word)) cls = "tk-n";
    }
    out.push(
      cls ? (
        <span key={k++} className={cls}>
          {tok}
        </span>
      ) : (
        tok
      ),
    );
  }
  return out;
}

const CONTROL = /^(if|then|else|elif|fi|for|do|done|while|case|esac)\b/;
const TERM_FOLD_THRESHOLD = 18;
const TERM_FOLD_PREVIEW = 12;

type CopyGuard = {
  locked: boolean;
  onBlocked: () => void;
};
const UNLOCKED_GUARD: CopyGuard = {
  locked: false,
  onBlocked: () => {},
};
const CopyGuardContext = React.createContext<CopyGuard>(UNLOCKED_GUARD);

export function Terminal({
  code,
  host,
  compact,
  plain,
  noPerLine,
}: {
  code: string;
  host?: string;
  compact?: boolean;
  plain?: boolean;
  noPerLine?: boolean;
}) {
  useLang();
  const guard = useContext(CopyGuardContext);
  const [copied, setCopied] = useState(false);
  const [copiedLine, setCopiedLine] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const lines = code.replace(/\s+$/, "").split("\n");
  const perLine = !noPerLine && lines.length > 1;
  const canFold = lines.length > TERM_FOLD_THRESHOLD;
  const visibleLines =
    canFold && !expanded ? lines.slice(0, TERM_FOLD_PREVIEW) : lines;
  return (
    <div className={`term ${compact ? "compact" : ""} ${guard.locked ? "is-locked" : ""}`}>
      <div className="term-bar">
        <span className="term-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="term-who">
          {host ? `root@${host}` : plain ? "manifest" : "bash"}
          {lines.length > 4 && (
            <em className="term-lines num">
              {bi(`${lines.length} 行`, `${lines.length} lines`)}
            </em>
          )}
        </span>
        <button
          type="button"
          className={`term-copy ${guard.locked ? "locked" : copied ? "done" : ""}`}
          onClick={async () => {
            if (guard.locked) {
              guard.onBlocked();
              return;
            }
            await copy(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          aria-label={
            guard.locked
              ? bi("请先确认上方更新再复制", "Confirm update above before copying")
              : bi("复制全部命令", "Copy all commands")
          }
        >
          {guard.locked ? <IconLock /> : copied ? <IconCheck /> : <IconCopy />}
          <span>
            {guard.locked
              ? bi("先确认更新", "Confirm first")
              : copied
                ? bi("已复制", "Copied")
                : bi("复制", "Copy")}
          </span>
        </button>
      </div>
      <pre
        className="term-body"
        onCopy={(e) => {
          if (guard.locked) {
            e.preventDefault();
            guard.onBlocked();
          }
        }}
      >
        <code>
          {visibleLines.map((l, i) => {
            // plain text (a YAML manifest) keeps its own indentation; the shell styling is for commands
            if (plain)
              return (
                <span className="ln" key={i}>
                  {l}
                  {"\n"}
                </span>
              );
            const indent = l.length - l.trimStart().length;
            const single =
              !guard.locked &&
              perLine &&
              l.trim() &&
              !indent &&
              !CONTROL.test(l.trim());
            const lineDone = copiedLine === i;
            return (
              <span
                className="ln"
                key={i}
                style={
                  indent
                    ? { paddingLeft: `calc(${indent}ch + 2ch)` }
                    : undefined
                }
              >
                {highlight(l.trimStart())}
                {single && (
                  <button
                    type="button"
                    className={`ln-copy ${lineDone ? "done" : ""}`}
                    onClick={() => {
                      copy(l.trim());
                      setCopiedLine(i);
                      setTimeout(
                        () => setCopiedLine((cur) => (cur === i ? null : cur)),
                        1300,
                      );
                    }}
                    aria-label={
                      lineDone
                        ? bi("已复制这一行", "Line copied")
                        : bi(`复制这一行：${l.trim()}`, `Copy line: ${l.trim()}`)
                    }
                    tabIndex={-1}
                  >
                    {lineDone ? <IconCheck /> : <IconCopy />}
                  </button>
                )}
                {"\n"}
              </span>
            );
          })}
        </code>
      </pre>
      {canFold && (
        <button
          type="button"
          className="term-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <IconDown className={expanded ? "open" : ""} />
          <span className="num">
            {expanded
              ? bi("收起长内容", "Collapse")
              : bi(
                  `展开其余 ${lines.length - TERM_FOLD_PREVIEW} 行（共 ${lines.length} 行）`,
                  `Show remaining ${lines.length - TERM_FOLD_PREVIEW} lines (${lines.length} total)`,
                )}
          </span>
        </button>
      )}
    </div>
  );
}

function CodeChip({ value }: { value: string }) {
  useLang();
  const guard = useContext(CopyGuardContext);
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip
      content={
        guard.locked
          ? bi("请先确认上方更新再复制", "Confirm update above before copying")
          : copied
            ? bi("已复制", "Copied")
            : bi("点击复制", "Click to copy")
      }
      mini
      position="top"
    >
      <button
        type="button"
        className={`chip-code ${copied ? "copied" : ""}`}
        onClick={() => {
          if (guard.locked) {
            guard.onBlocked();
            return;
          }
          copy(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1300);
        }}
      >
        {value}
      </button>
    </Tooltip>
  );
}

/** Inline `code` becomes a copy chip; the text around it stays prose. */
function Prose({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") ? (
          <CodeChip key={i} value={p.slice(1, -1)} />
        ) : (
          <React.Fragment key={i}>{p.replace(/\*\*/g, "")}</React.Fragment>
        ),
      )}
    </>
  );
}

/* ---------- runbook ---------- */
/* ---------- structured runbook ---------- */

type RStep = {
  ai?: { id: string; by: string; changed?: boolean; before?: string };
  key: string;
  title: string;
  lead?: string;
  detail?: string;
  effect: string;
  hosts: string[];
  code: string;
  files: JobFile[];
  /** How to get back, per changing step it covers (a deploy phase covers several). */
  rollback?: { title: string; text: string; noRollback?: boolean }[];
};
type Tab = {
  id: string;
  label: string;
  doc?: JobFile;
  steps: RStep[];
  notes: { id: string; title: string; reason: string; group?: string }[];
  lead?: string;
};

const EFFECT: Record<string, string> = {
  get "read-only"() { return bi("只读", "Read-only"); },
  get change() { return bi("修改", "Change"); },
  get disruptive() { return bi("会中断服务", "Disruptive"); },
  get destructive() { return bi("不可撤销", "Destructive"); },
};
const DANGER = new Set(["destructive"]);

const stepOf = (
  s: PlanStep,
  cd: string,
  key: string,
  files: JobFile[],
): RStep => ({
  key,
  title: (s.instance ? `[${s.instance}] ` : "") + s.title,
  lead: s.desc,
  detail: s.expect ? bi(`通过标准：${s.expect}`, `Expected: ${s.expect}`) : undefined,
  effect: s.effect,
  hosts: s.hosts.length > 3 ? [s.hosts[0]] : s.hosts,
  code: cd ? `cd ${cd}\n${s.command}` : s.command,
  files,
  rollback:
    s.effect !== "read-only" && s.rollback
      ? [{ title: "", text: s.rollback }]
      : undefined,
});

const noRollbackMsg = () =>
  bi(
    "组件没有声明。先停下，保留现场和输出，联系平台维护人员，不要自行尝试撤销。",
    "Not declared by component. Stop, preserve outputs and state, and contact platform maintainers instead of attempting manual rollback.",
  );

function buildTabs(
  plan: DeliveryPlan,
  docs: JobFile[],
  files: JobFile[],
): Tab[] {
  const doc = (prefix: string) => docs.find((d) => d.name.startsWith(prefix));
  const cd = plan.project_dir;
  const tabs: Tab[] = [];
  // Which delivered files a preparation step asks the user to upload.
  const attach = (s: PlanStep) => {
    if (s.id.startsWith("unpack-")) {
      const host = s.id.slice("unpack-".length);
      const ix = plan.hosts.findIndex((h) => h.name === host);
      const pkg = files.filter(
        (f) =>
          ix >= 0 &&
          f.name.startsWith(`node${String(ix + 1).padStart(2, "0")}-`),
      );
      return host === plan.controller
        ? [
            ...pkg,
            ...files.filter(
              (f) =>
                f.name === "SHA256SUMS" ||
                (f.name.endsWith(".tar.gz") &&
                  !/^node\d\d-/.test(f.name) &&
                  !/^update-\d+-/.test(f.name)),
            ),
          ]
        : pkg;
    }
    return [];
  };
  tabs.push({
    id: "prepare",
    label: bi("环境准备", "Environment Prep"),
    doc: doc("00-"),
    steps: (plan.prepare || []).map((s, i) =>
      stepOf(s, "", (plan.step_format || 0) >= 2 && s.id ? s.id : "prepare-" + i, attach(s)),
    ),
    notes: [],
  });
  const isAutoDelivery = plan.delivery_mode === "automatic";
  tabs.push({
    id: "deploy",
    label: bi("部署", "Deploy"),
    doc: doc("01-"),
    lead: isAutoDelivery
      ? bi(
          "自动化部署模式：环境准备通过执行准备检查后，即可通过上方控制台批量或按步自动执行；每一步的结果、主机汇总与完整日志会直接展示在对应步骤下方。",
          "Automated mode: once environment prep passes pre-flight checks, trigger batch or step-by-step execution above; results, host recaps, and logs appear inline under each step.",
        )
      : bi(
          "全部在控制节点的 root 终端完成。每一步的 Ansible 输出末尾必须是 failed=0、unreachable=0 才继续下一步；失败或中断时保留日志，不要删锁、不要删数据目录。",
          "Run all commands as root on the controller. Proceed only when Ansible reports failed=0 and unreachable=0; on failure, keep logs and do not delete locks or data directories.",
        ),
    steps: [
      ...(isAutoDelivery
        ? []
        : [
            {
              key: "deploy-bootstrap",
              title: bi("离线安装 Ansible 并核对清单", "Install Offline Ansible & Verify Inventory"),
              lead: bi("引导脚本只使用随包的离线材料，不访问外网。", "Bootstrap uses bundled offline artifacts only with no internet access."),
              detail: bi("清单应列出全部机器和各实例的分组。", "Inventory should list all hosts and instance groups."),
              effect: "change",
              hosts: [plan.controller],
              code: `cd ${cd.replace(/\/projects\/[^/]+\/?$/, "")}\nbash bootstrap/bootstrap-ansible.sh\ncd ${cd}\n../../bin/ansible-inventory -i inventory/hosts.yml --graph`,
              files: [],
            },
          ]),
      ...plan.deploy.flatMap((ph): RStep[] => (plan.step_format || 0) >= 2 ? ph.steps.map((s) => stepOf(s, cd, ph.phase + "/" + (s.instance ? "instance-" + s.instance : "platform") + "/" + s.id, [])) : [{
        key: `deploy-${ph.phase}`,
        title: bi(`阶段：${ph.title}`, `Phase: ${ph.title}`),
        lead: ph.steps
          .map((s) => `${s.instance ? `[${s.instance}] ` : ""}${s.title}`)
          .join(bi("；", "; ")),
        detail: ph.steps.some((s) => s.effect === "disruptive")
          ? bi("包含会短暂中断连接的步骤，应在应用接入前的窗口执行。", "Includes steps that briefly interrupt connections; run prior to application cutover.")
          : undefined,
        effect: ph.steps.some((s) => s.effect === "destructive")
          ? "destructive"
          : ph.steps.some((s) => s.effect === "disruptive")
            ? "disruptive"
            : ph.steps.every((s) => s.effect === "read-only")
              ? "read-only"
              : "change",
        hosts: [plan.controller],
        code: `cd ${cd}\n${ph.command}`,
        files: [],
        rollback: ph.steps
          .filter((x) => x.effect !== "read-only")
          .map((x) => ({
            title: `${x.instance ? `[${x.instance}] ` : ""}${x.title}`,
            text: x.rollback || noRollbackMsg(),
            noRollback: !x.rollback,
          })),
      }]),
    ],
    notes: [],
  });
  const list = (
    id: string,
    label: string,
    steps: PlanStep[],
    prefix: string,
    lead?: string,
  ) => {
    const live = steps.filter((s) => !s.skipped);
    const skipped = steps.filter((s) => s.skipped);
    if (!live.length && !skipped.length) return;
    tabs.push({
      id,
      label,
      doc: doc(prefix),
      lead,
      steps: live.map((s, i) =>
        stepOf(s, cd, (plan.step_format || 0) >= 2 ? (s.instance || "") + "/" + s.id : id + "-" + i + "-" + s.instance + "-" + s.id, []),
      ),
      notes: [
        ...skipped.filter((s) => {
          // Managed database definitions are not additional user tasks.
          if (plan.instances.some((i) => !!s.instance && i.managed_context === s.instance)) return false;
          const owner = plan.instances.find((i) => i.id === s.instance);
          // Disabled PG TLS checks are summarized with TDE in functional tests.
          return !(s.id === "tls-negative" && owner?.params.tls === false &&
            (owner.component === "postgresql" || owner.component === "patroni"));
        }).map((s) => ({
          id: [s.instance, s.id].filter(Boolean).join("/"),
          title: s.title || s.id,
          reason: s.skipped!,
        })),
        ...(id === "tests" ? plan.instances.filter((i) =>
          i.component === "postgresql" && i.params.tls === false
        ).map((i) => ({
          id: (plan.instances.find((m) => m.managed_context === i.id)?.id || i.id) + "/tls-negative",
          title: bi("TLS 连接安全验证", "TLS Security Verification"),
          reason: bi("未启用 TLS", "TLS disabled"),
        })) : []),
      ],
    });
  };
  list(
    "tests",
    bi("功能测试", "Functional Tests"),
    plan.tests || [],
    "02-",
    bi(
      "逐项执行；标为“会中断服务”的项目应在应用接入前的窗口做。每项必须 failed=0 才继续。",
      "Run each test; execute Disruptive tests before application traffic. Ensure failed=0 before proceeding.",
    ),
  );
  list(
    "endpoint",
    bi("入口测试", "Endpoint Tests"),
    plan.endpoint_tests || [],
    "03-",
    bi("先在入口（负载均衡）处完成配置，再逐项执行。", "Configure the frontend load balancer first, then run each check."),
  );
  list(
    "cleanup",
    bi("清理", "Cleanup"),
    plan.cleanup || [],
    "04-",
    bi(
      "只处理本集群的测试资源，逐项执行，失败就停下，不要手工删除生产目录。",
      "Cleans only test resources for this cluster; stop on failure and never manually delete production directories.",
    ),
  );
  return tabs.filter((tab) => tab.steps.length > 0 || tab.notes.length > 0);
}

export type Amendment = {
  kind?: string;
  id: string;
  phase: string;
  after_title?: string;
  step: {
    title: string;
    desc?: string;
    command: string;
    effect: string;
    hosts: string[];
    expect?: string;
    rollback?: string;
  };
  reason: string;
  by: string;
  at: string;
};

/**
 * Omit tabs that have zero executable steps (e.g. Endpoint Tests when no load balancer / external endpoint
 * is configured) so they don't appear as an uncompletable numbered stage. Their skipped-item explanations are
 * folded into the Functional Tests tab's collapsible "Skipped tests" drawer so auditability is preserved.
 */
function finalizeTabs(tabs: Tab[]): Tab[] {
  const out = tabs.map((t) => ({ ...t, notes: [...t.notes] }));
  const findFoldTarget = (fromIdx: number, id: string): Tab | undefined => {
    if (id === "endpoint") {
      const testsTab = out.find((t) => t.id === "tests" && t.steps.length > 0);
      if (testsTab) return testsTab;
    }
    for (let i = fromIdx - 1; i >= 0; i--) {
      if (out[i].steps.length > 0) return out[i];
    }
    return out.find((t) => t.steps.length > 0);
  };
  out.forEach((t, i) => {
    if (t.steps.length === 0 && t.notes.length > 0) {
      const target = findFoldTarget(i, t.id);
      if (target) {
        target.notes.push(
          ...t.notes.map((n) => ({ ...n, group: n.group || t.label })),
        );
      }
    }
  });
  const active = out.filter((t) => t.steps.length > 0);
  return active.length > 0
    ? active
    : out.filter((t) => t.steps.length > 0 || t.notes.length > 0);
}

/** Steps the person accepted from the assistant, placed after the step they follow. Existing step keys do not move. */
function withAmendments(
  tabs: Tab[],
  ams: Amendment[],
  plan: DeliveryPlan,
): Tab[] {
  if (!ams.length) return finalizeTabs(tabs);
  const cd = plan.project_dir;
  const amended = tabs.map((t) => {
    const mine = ams.filter((a) => a.phase === t.id);
    if (!mine.length) return t;
    const steps = [...t.steps];
    // a changed command replaces the step's own; its key stays, so records made before it still belong to it
    for (const a of mine.filter((x) => x.kind === "replace")) {
      const i = steps.findIndex((s) => s.title === a.after_title);
      if (i < 0) continue;
      const old = steps[i];
      steps[i] = {
        ...old,
        ai: {
          id: a.id,
          by: a.by,
          changed: true,
          before: old.ai?.before ?? old.code,
        },
        code: cd ? `cd ${cd}\n${a.step.command}` : a.step.command,
        effect: a.step.effect,
        lead: [
          old.lead,
          bi(`已修改：${a.reason}`, `Modified: ${a.reason}`),
          a.step.rollback ? bi(`回退：${a.step.rollback}`, `Rollback: ${a.step.rollback}`) : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    for (const a of mine.filter((x) => x.kind !== "replace")) {
      const step: RStep = {
        key: `ai-${a.id}`,
        ai: { id: a.id, by: a.by },
        title: a.step.title,
        lead: [
          a.step.desc,
          a.step.rollback ? bi(`回退：${a.step.rollback}`, `Rollback: ${a.step.rollback}`) : "",
          bi(`缘由：${a.reason}`, `Reason: ${a.reason}`),
        ]
          .filter(Boolean)
          .join("\n"),
        detail: a.step.expect ? bi(`通过标准：${a.step.expect}`, `Expected: ${a.step.expect}`) : undefined,
        effect: a.step.effect,
        hosts: a.step.hosts,
        code: cd ? `cd ${cd}\n${a.step.command}` : a.step.command,
        files: [],
      };
      let at = a.after_title
        ? steps.findIndex((s) => s.title === a.after_title)
        : -1;
      if (at >= 0) while (at + 1 < steps.length && steps[at + 1].ai) at++;
      steps.splice(at >= 0 ? at + 1 : steps.length, 0, step);
    }
    return { ...t, steps };
  });
  return finalizeTabs(amended);
}

const doneKey = (job: string) => `mh-run-${job}`;
const tabKey = (job: string) => `mh-rb-tab-${job}`;

function readSavedTab(job: string, validTabs: Tab[]): string | null {
  try {
    const saved = localStorage.getItem(tabKey(job));
    if (!saved) return null;
    if (saved === "record" || validTabs.some((t) => t.id === saved)) {
      return saved;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeSavedTab(job: string, id: string) {
  try {
    localStorage.setItem(tabKey(job), id);
  } catch {
    /* ignore */
  }
}

function pickResumeTab(
  validTabs: Tab[],
  steps: Record<string, Rec>,
  events: Ev[],
): string | null {
  if (!validTabs.length) return null;
  const isDone = (tId: string, sKey: string) =>
    ["done", "skipped", "resolved"].includes(
      steps[`${tId}/${sKey}`]?.state || "",
    );
  const firstUnfinished = validTabs.find((t) =>
    t.steps.some((s) => !isDone(t.id, s.key)),
  );

  let latestPhase = "";
  let latestAt = "";
  const consider = (key: string, at?: string) => {
    const slash = key.indexOf("/");
    if (slash <= 0) return;
    const phase = key.slice(0, slash);
    if (!validTabs.some((t) => t.id === phase)) return;
    const ts = at || "";
    if (!latestPhase || ts >= latestAt) {
      latestPhase = phase;
      latestAt = ts;
    }
  };
  for (const [k, r] of Object.entries(steps)) {
    if (r?.state) consider(k, r.at);
  }
  for (const ev of events) {
    if (ev?.key) consider(ev.key, ev.at);
  }

  if (latestPhase) {
    const latestTab = validTabs.find((t) => t.id === latestPhase);
    if (latestTab && latestTab.steps.some((s) => !isDone(latestTab.id, s.key))) {
      return latestTab.id;
    }
  }
  const failedTab = validTabs.find((t) =>
    t.steps.some((s) => steps[`${t.id}/${s.key}`]?.state === "failed"),
  );
  if (failedTab) return failedTab.id;
  if (firstUnfinished) {
    if (Object.keys(steps).length === 0 && events.length === 0) return null;
    return firstUnfinished.id;
  }
  return latestPhase || (events.length > 0 ? "record" : null);
}

type HostRecap = {
  host: string;
  ok: number;
  changed: number;
  failed: number;
  unreachable: number;
  skipped: number;
};
type StepAttempt = {
  execution: string;
  attempt: string;
  run_index?: number;
  state: string;
  auto_state?: string;
  executor?: string;
  by?: string;
  started?: string;
  finished?: string;
  at?: string;
  exit_code?: number;
  message?: string;
  recap?: HostRecap[];
  log_seq?: number;
  snapshot?: string;
  outdated?: boolean;
};
type Rec = {
  source?: string;
  execution?: string;
  attempt?: string;
  auto_state?: string;
  executor?: string;
  started?: string;
  finished?: string;
  exit_code?: number;
  recap?: HostRecap[];
  log_seq?: number;
  state: "done" | "failed" | "skipped" | "resolved" | "";
  by: string;
  at: string;
  note?: string;
  log?: string;
  images?: string[];
  attempts?: StepAttempt[];
};
const AUTO_LIVE = new Set(["queued", "leased", "running"]);
const AUTO_STATE_LABEL: Record<string, string> = {
  get queued() { return bi("等待自动执行", "Queued"); },
  get leased() { return bi("已授权，等待启动", "Starting"); },
  get running() { return bi("正在自动执行…", "Running…"); },
  get unknown() { return bi("现场状态待核实", "State unknown"); },
  get blocked() { return bi("准备受阻，未启动", "Blocked before start"); },
};
type RunLog = {
  file: string;
  playbook: string;
  started: string;
  result: string;
  step?: string;
};
type Ev = {
  at: string;
  by: string;
  key: string;
  title?: string;
  state: string;
  source?: string;
  execution?: string;
  attempt?: string;
  note?: string;
  started?: string;
  finished?: string;
  exit_code?: number;
  recap?: HostRecap[];
  log_seq?: number;
  executor?: string;
  snapshot?: string;
};
const STATE_LABEL: Record<string, string> = {
  get "ai-accepted"() { return bi("采纳 AI 补充步骤", "Adopted AI step"); },
  get "ai-rejected"() { return bi("拒绝 AI 提案", "Dismissed AI proposal"); },
  get sync() { return bi("组件更新", "Update Sync"); },
  get done() { return bi("完成", "Completed"); },
  get failed() { return bi("失败", "Failed"); },
  get skipped() { return bi("跳过", "Skipped"); },
  get resolved() { return bi("完成（遇到问题已解决）", "Completed (issue resolved)"); },
  get ""() { return bi("清除记录", "Cleared"); },
};

export function Runbook({
  plan,
  docs,
  jobId,
  files,
  deliveryMode,
  latestSync,
  onSyncConfirmed,
  focusSyncTick = 0,
}: {
  plan: DeliveryPlan;
  docs: JobFile[];
  jobId: string;
  files: JobFile[];
  deliveryMode?: string;
  latestSync?: JobSync | null;
  onSyncConfirmed?: () => Promise<void>;
  focusSyncTick?: number;
}) {
  const lang = useLang();
  const [amends, setAmends] = useState<Amendment[]>([]);
  const base = useMemo(() => buildTabs(plan, docs, files), [plan, docs, files, lang]);
  const tabs = useMemo(
    () => withAmendments(base, amends, plan),
    [base, amends, plan, lang],
  );
  const initialSavedTab = readSavedTab(jobId, tabs);
  const [tab, setTab] = useState<string>(initialSavedTab ?? tabs[0].id);
  const tabRef = React.useRef(tab);
  tabRef.current = tab;
  const manualTabRef = React.useRef(false);
  const hasSavedTabRef = React.useRef(initialSavedTab !== null);
  const [dir, setDir] = useState(0);
  const [rec, setRec] = useState<Record<string, Rec>>({});
  // versions of a step a sync replaced, with what was recorded against them
  const [olds, setOlds] = useState<Record<string, OldVersion[]>>({});
  const [events, setEvents] = useState<Ev[]>([]);
  const [sync, setSync] = useState<"loading" | "ok" | "error">("loading");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [hotfixTarget, setHotfixTarget] = useState<{
    key: string;
    title: string;
  } | null>(null);
  const dock = useAIDock();
  const aiStatus = useAIStatus();
  const [reports, setReports] = useState<AIReport[]>([]);
  const total = tabs.reduce((n, t) => n + t.steps.length, 0);
  const keyOf = (t: string, k: string) => `${t}/${k}`;
  const titleOf = (key: string) => {
    for (const t of tabs)
      for (const s of t.steps)
        if (keyOf(t.id, s.key) === key) return `${t.label} · ${s.title}`;
    return key;
  };
  const apply = (d: {
    steps: Record<string, Rec>;
    events: Ev[];
    reports?: AIReport[];
    amendments?: Amendment[];
    superseded?: Record<string, OldVersion[]>;
  }) => {
    setOlds(d.superseded || {});
    setReports(d.reports || []);
    if (d.amendments) setAmends(d.amendments);
    setRec(d.steps || {});
    setEvents(d.events || []);
  };

  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent).detail?.jobId !== jobId || editing) return;
      api<{
        steps: Record<string, Rec>;
        events: Ev[];
        reports?: AIReport[];
        amendments?: Amendment[];
        superseded?: Record<string, OldVersion[]>;
      }>(`/api/jobs/${jobId}/progress`)
        .then((d) => {
          apply(d);
          if (!manualTabRef.current) {
            const effectiveTabs = withAmendments(
              base,
              d.amendments || amends,
              plan,
            );
            const resumed = pickResumeTab(
              effectiveTabs,
              d.steps || {},
              d.events || [],
            );
            if (resumed && resumed !== tabRef.current) {
              setDir(0);
              setTab(resumed);
              writeSavedTab(jobId, resumed);
            }
          }
        })
        .catch(() => setSync("error"));
    };
    window.addEventListener("execution-updated", refresh);
    return () => window.removeEventListener("execution-updated", refresh);
  }, [jobId, editing, base, amends, plan]);

  // The record lives on the server so everyone who opens the delivery sees the same progress. Ticks kept in this
  // browser by an earlier version are moved over once.
  useEffect(() => {
    let live = true;
    manualTabRef.current = false;
    const saved = readSavedTab(jobId, tabs);
    hasSavedTabRef.current = saved !== null;
    if (saved) setTab(saved);
    api<{
      steps: Record<string, Rec>;
      events: Ev[];
      reports?: AIReport[];
      amendments?: Amendment[];
      superseded?: Record<string, OldVersion[]>;
    }>(`/api/jobs/${jobId}/progress`)
      .then(async (d) => {
        if (!live) return;
        apply(d);
        setSync("ok");
        let legacy: Record<string, string[]> = {};
        try {
          legacy = JSON.parse(localStorage.getItem(doneKey(jobId)) || "{}");
        } catch {
          /* ignore */
        }
        const old = Object.entries(legacy).flatMap(([t, ks]) =>
          ks.map((k) => keyOf(t, k)),
        );
        let eff = d;
        if (Object.keys(d.steps || {}).length === 0 && old.length) {
          let last = d;
          for (const key of old)
            last = await api(`/api/jobs/${jobId}/progress`, {
              method: "PUT",
              body: JSON.stringify({
                key,
                title: titleOf(key),
                state: "done",
                total,
              }),
            });
          if (live) {
            apply(last);
            eff = last;
          }
        }
        localStorage.removeItem(doneKey(jobId));
        if (!live || manualTabRef.current) return;
        const effectiveTabs = withAmendments(
          base,
          eff.amendments || amends,
          plan,
        );
        const savedAfter = readSavedTab(jobId, effectiveTabs);
        if (savedAfter) {
          hasSavedTabRef.current = true;
          setTab(savedAfter);
        } else if (!hasSavedTabRef.current) {
          const resumed = pickResumeTab(
            effectiveTabs,
            eff.steps || {},
            eff.events || [],
          );
          if (resumed) {
            setDir(0);
            setTab(resumed);
            writeSavedTab(jobId, resumed);
          }
        }
      })
      .catch(() => live && setSync("error"));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, lang]);

  // the assistant changed the record (an accepted proposal, a write-up): read it again
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent).detail === jobId)
        api<Parameters<typeof apply>[0]>(`/api/jobs/${jobId}/progress`)
          .then(apply)
          .catch(() => undefined);
    };
    window.addEventListener(AI_CHANGED, on);
    return () => window.removeEventListener(AI_CHANGED, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, lang]);
  const askAI = (t: Tab, s: RStep, prefill?: string) => {
    const key = keyOf(t.id, s.key);
    dock?.open({
      prefill,
      key: `step:${key}`,
      title: s.title,
      context: bi(`现场排障 · ${t.label}`, `On-site troubleshooting · ${t.label}`),
      step: {
        title: s.title,
        phase: t.label,
        command: s.code,
        hosts: s.hosts,
        effect: s.effect,
        desc: s.lead,
        expect: s.detail,
        record: rec[key],
      },
    });
  };

  const withdraw = (id: string, title: string) =>
    Modal.confirm({
      title: bi(`撤销「${title}」？`, `Withdraw "${title}"?`),
      content: bi("这一步会从手册和交付文档里移除，已记录的结果保留在执行记录中。", "Removes this step from the runbook and docs while keeping logged results in history."),
      okText: bi("撤销", "Withdraw"),
      onOk: async () => {
        try {
          await api(`/api/jobs/${jobId}/ai/proposals/amendment/${id}`, {
            method: "DELETE",
          });
          apply(await api(`/api/jobs/${jobId}/progress`));
        } catch (e) {
          err(e);
        }
      },
    });

  const save = async (
    t: string,
    stepKey: string,
    state: "" | Rec["state"],
    note = "",
    log = "",
    images: string[] = [],
  ) => {
    const key = keyOf(t, stepKey);
    try {
      apply(
        await api(`/api/jobs/${jobId}/progress`, {
          method: "PUT",
          body: JSON.stringify({
            key,
            title: titleOf(key),
            state,
            note,
            log,
            images,
            total,
          }),
        }),
      );
      writeSavedTab(jobId, t);
      setSync("ok");
    } catch (e) {
      err(e);
    }
  };
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [uploading, setUploading] = useState(false);
  const pickLogs = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    api<RunLog[]>(`/api/jobs/${jobId}/progress/logs`)
      .then(setLogs)
      .catch(() => undefined);
  }, [jobId]);
  const uploadLogs = async (files: FileList | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("files", f));
    setUploading(true);
    try {
      const r = await api<{
        imported: string[];
        skipped: string[];
        matched: number;
        logs: RunLog[];
      }>(`/api/jobs/${jobId}/progress/logs`, { method: "POST", body: fd });
      setLogs(r.logs);
      const d = await api<Parameters<typeof apply>[0]>(
        `/api/jobs/${jobId}/progress`,
      );
      apply(d);
      if (r.matched > 0 && tab !== "record") {
        const nextTab = pickResumeTab(
          withAmendments(base, d.amendments || amends, plan),
          d.steps || {},
          d.events || [],
        );
        if (nextTab && nextTab !== tab) {
          switchTo(nextTab);
        }
      }
      Message.success(
        bi(
          `导入 ${r.imported.length} 份日志，对上了 ${r.matched} 个步骤${(r.skipped?.length ?? 0) ? `；${r.skipped?.length ?? 0} 个文件不是执行日志，已忽略` : ""}`,
          `Imported ${r.imported.length} ${r.imported.length === 1 ? "log" : "logs"}, matched ${r.matched} ${r.matched === 1 ? "step" : "steps"}${(r.skipped?.length ?? 0) ? `; ignored ${r.skipped?.length ?? 0} non-log files` : ""}`,
        ),
      );
    } catch (e) {
      err(e);
    } finally {
      setUploading(false);
      if (pickLogs.current) pickLogs.current.value = "";
    }
  };
  const dropLog = async (name: string) => {
    try {
      setLogs(
        await api<RunLog[]>(
          `/api/jobs/${jobId}/progress/logs?name=${encodeURIComponent(name)}`,
          { method: "DELETE" },
        ),
      );
    } catch (e) {
      err(e);
    }
  };
  const clearAll = async (everything = false) => {
    try {
      apply(
        await api(`/api/jobs/${jobId}/progress${everything ? "?all=1" : ""}`, {
          method: "DELETE",
        }),
      );
      if (everything) setLogs([]);
    } catch (e) {
      err(e);
    }
  };

  const passed = (t: string, k: string) =>
    ["done", "skipped", "resolved"].includes(rec[keyOf(t, k)]?.state || "");
  const finished = tabs.reduce(
    (n, t) => n + t.steps.filter((s) => passed(t.id, s.key)).length,
    0,
  );
  const failed = Object.values(rec).filter((r) => r.state === "failed").length;
  const next = (() => {
    for (const t of tabs) {
      const s = t.steps.find((x) => !passed(t.id, x.key));
      if (s) return { tab: t.id, step: s };
    }
  })();
  const switchTo = (id: string) => {
    manualTabRef.current = true;
    writeSavedTab(jobId, id);
    setDir(
      tabs.findIndex((t) => t.id === id) > tabs.findIndex((t) => t.id === tab)
        ? 1
        : -1,
    );
    setTab(id);
  };
  // ticking or un-ticking a step changes its result only: what was written and attached stays
  const toggle = (t: string, key: string) => {
    const r = rec[keyOf(t, key)];
    return r?.state
      ? save(t, key, "")
      : save(t, key, "done", r?.note || "", r?.log || "", r?.images || []);
  };
  const goNext = () => {
    if (!next) return;
    if (next.tab !== tab) switchTo(next.tab);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.getElementById(`rs-${next.tab}-${next.step.key}`);
        el?.scrollIntoView({
          behavior: reducedMotion() ? "auto" : "smooth",
          block: "center",
        });
        el?.querySelector<HTMLButtonElement>(".rstep-check")?.focus({
          preventScroll: true,
        });
      }),
    );
  };

  const hasLiveAuto = useMemo(
    () =>
      Object.values(rec).some((r) =>
        Boolean(r?.auto_state && AUTO_LIVE.has(r.auto_state)),
      ),
    [rec],
  );
  useEffect(() => {
    if (!hasLiveAuto || editing) return;
    let dead = false;
    const id = window.setInterval(() => {
      if (dead) return;
      api<Parameters<typeof apply>[0]>(`/api/jobs/${jobId}/progress`)
        .then((d) => !dead && apply(d))
        .catch(() => undefined);
    }, 4000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [hasLiveAuto, editing, jobId]);

  // "go and look at it": the assistant's adopted proposal says where it went; this opens that step
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent<{ title?: string; key?: string }>).detail;
      const title = detail?.title;
      for (const t of tabs)
        for (const s of t.steps)
          if (detail?.key ? t.id + "/" + s.key === detail.key : s.title === title) {
            if (t.id !== tab) switchTo(t.id);
            setOpen((o) => ({ ...o, [`${t.id}-${s.key}`]: true }));
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const el = document.getElementById(`rs-${t.id}-${s.key}`);
                el?.scrollIntoView({
                  behavior: reducedMotion() ? "auto" : "smooth",
                  block: "center",
                });
                el?.classList.add("rstep-flash");
                window.setTimeout(
                  () => el?.classList.remove("rstep-flash"),
                  1800,
                );
              }),
            );
            return;
          }
    };
    window.addEventListener("mh-runbook-focus", h);
    return () => window.removeEventListener("mh-runbook-focus", h);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const showRecord = tab === "record";
  const cur = tabs.find((t) => t.id === tab) || tabs[0];
  const currentKey = cur.steps.find((s) => !passed(cur.id, s.key))?.key;
  const idx = tabs.findIndex((t) => t.id === cur.id);
  const nameOf = (h: string) => plan.hosts.find((x) => x.name === h);
  const isAutoDelivery = (deliveryMode || plan.delivery_mode) === "automatic";
  const activeSync =
    !isAutoDelivery && latestSync?.update ? latestSync : null;
  const syncConfirmed = Boolean(activeSync?.applied_at);
  const syncPending = Boolean(activeSync && !syncConfirmed);
  const [syncConfirming, setSyncConfirming] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  useEffect(() => {
    setSyncOpen(false);
  }, [activeSync?.n, activeSync?.applied_at]);

  const jumpToSyncStep = () => {
    if (tabRef.current !== "deploy") switchTo("deploy");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.getElementById("sync-runbook-step");
        if (!el) return;
        el.scrollIntoView({
          behavior: reducedMotion() ? "auto" : "smooth",
          block: "center",
        });
        el.classList.remove("is-flash");
        void el.offsetWidth;
        el.classList.add("is-flash");
        window.setTimeout(() => el.classList.remove("is-flash"), 1600);
      }),
    );
  };
  useEffect(() => {
    if (focusSyncTick > 0) jumpToSyncStep();
  }, [focusSyncTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const confirmLatestSync = async () => {
    if (!activeSync || syncConfirming) return;
    setSyncConfirming(true);
    try {
      await api(`/api/jobs/${jobId}/sync/confirm`, {
        method: "POST",
        body: JSON.stringify({ sync: activeSync.n, mode: "verified" }),
      });
      await onSyncConfirmed?.();
      window.dispatchEvent(
        new CustomEvent("execution-updated", { detail: { jobId } }),
      );
      Message.success(
        bi(
          "已确认控制节点校验通过，部署及后续步骤已解锁",
          "Controller verification confirmed; deploy & test steps unlocked",
        ),
      );
    } catch (e) {
      err(e);
    } finally {
      setSyncConfirming(false);
    }
  };

  // Environment prep (upload & unpack base bundle) MUST stay unlocked so fresh deliveries can unpack
  // node01 before verifying/applying updates; all Ansible execution phases lock until verified.
  const ctlUnpacked =
    passed("prepare", `unpack-${plan.controller}`) ||
    (tabs.find((t) => t.id === "prepare")?.steps.every((s) => passed("prepare", s.key)) ?? false);
  const phaseLocked = syncPending && cur.id !== "prepare";
  const nextNeedsSyncFirst = Boolean(syncPending && (!next || next.tab !== "prepare"));
  const copyGuard = useMemo<CopyGuard>(
    () => ({
      locked: phaseLocked,
      onBlocked: () => {
        jumpToSyncStep();
        Message.warning({
          id: "sync-copy-lock",
          content:
            activeSync?.kind === "patch"
              ? bi(
                  `第 ${activeSync.n} 次 AI 补丁更新尚未在 ${plan.controller} 核对：请先执行「部署」第 0 步校验命令并确认`,
                  `AI Patch #${activeSync.n} not yet verified on ${plan.controller}: run Deploy step 0 and confirm first`,
                )
              : bi(
                  `第 ${activeSync?.n ?? ""} 次同步更新尚未在 ${plan.controller} 核对：请先执行「部署」第 0 步校验命令并确认`,
                  `Sync #${activeSync?.n ?? ""} not yet verified on ${plan.controller}: run Deploy step 0 and confirm first`,
                ),
        });
      },
    }),
    [phaseLocked, activeSync, plan.controller, lang], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const syncUpdFile = activeSync?.update
    ? files.find((f) => f.name === activeSync.update)
    : undefined;
  const syncSumFile = activeSync?.update
    ? files.find((f) => f.name === `${activeSync.update}.sha256`)
    : undefined;
  const syncVerifyCmd = (() => {
    if (!activeSync) return "";
    if (activeSync.verify_cmd) return activeSync.verify_cmd;
    const pkgBase =
      plan.project_dir.match(/^(.*)\/middleware-automation\/projects\/[^/]+\/?$/)?.[1] ||
      "/root";
    const uploadDir = (plan.upload_dir || "/tmp/mw-upload").replace(/\/+$/, "");
    return [
      `cd ${uploadDir}`,
      `tar -xzf ${activeSync.update} -C ${pkgBase}`,
      ...(activeSync.remove?.length
        ? [`cd ${plan.project_dir} && rm -f ${activeSync.remove.join(" ")}`]
        : []),
    ].join("\n");
  })();

  return (
    <JobIdContext.Provider value={jobId}>
      <CopyGuardContext.Provider value={copyGuard}>
      <div className="rb">
        <div className="rb-head">
          <div
            className="rb-progress"
            aria-label={bi(`现场进度 ${finished} / ${total}`, `On-site progress ${finished} / ${total}`)}
          >
            <div className="rb-meter" aria-hidden>
              <span
                style={{ transform: `scaleX(${total ? finished / total : 0})` }}
              />
            </div>
            <span className="num">
              {finished === total
                ? bi("全部步骤已完成", "All steps completed")
                : bi(`已完成 ${finished} / ${total} 步`, `${finished} / ${total} steps done`)}
            </span>
            {failed > 0 && (
              <span className="rb-failed num">
                {failed === 1 ? bi("1 步失败", "1 failed") : bi(`${failed} 步失败`, `${failed} failed`)}
              </span>
            )}
            {(sync === "error" || sync === "loading") && (
              <span className="faint small">
                {sync === "error"
                  ? bi("记录暂时无法同步", "Unable to sync records")
                  : bi("同步中…", "Syncing…")}
              </span>
            )}
          </div>
          <div className="rb-actions">
            {can("delivery.run") && !isAutoDelivery && (
              <>
                <Tooltip
                  content={bi(
                    "把控制节点项目目录 logs/ 下的日志（.log，或整个目录打成 .zip / .tar.gz）传上来，平台自动写好各步的结果和输出",
                    "Upload logs (.log, .zip, or .tar.gz) from the controller's logs/ directory to auto-populate step statuses and outputs",
                  )}
                  mini
                >
                  <Button
                    size="small"
                    loading={uploading}
                    icon={<IconUpload />}
                    onClick={() => pickLogs.current?.click()}
                  >
                    {bi("上传执行日志", "Upload Logs")}
                  </Button>
                </Tooltip>
                <input
                  ref={pickLogs}
                  type="file"
                  multiple
                  hidden
                  accept=".log,.zip,.gz,.tgz"
                  onChange={(e) => uploadLogs(e.target.files)}
                />
              </>
            )}
            {(finished > 0 || failed > 0) && (
              <button
                className="link quiet"
                onClick={() => {
                  const m = Modal.confirm({
                    title: bi("清除执行结果？", "Clear execution results?"),
                    content: (
                      <div className="rb-clear">
                        <p>
                          {bi("所有步骤会回到“未执行”。你写下的说明、粘贴的输出、上传的截图和执行日志都会", "All steps will reset to pending. Your notes, pasted output, screenshots, and imported logs will be ")}
                          <b>{bi("保留", "preserved")}</b>
                          {bi("，重新标记结果后还在原来的步骤下。", " under their original steps.")}
                        </p>
                        <p className="faint small">
                          {bi("想把这些也删掉？", "Delete those too? ")}
                          <button
                            type="button"
                            className="link quiet danger"
                            onClick={() => {
                              m.close();
                              Modal.confirm({
                                title: bi("连输出和截图一起删除？", "Delete outputs and screenshots too?"),
                                content: bi(
                                  "说明、粘贴的输出、截图和导入的日志都会删除，不能恢复。",
                                  "Notes, pasted outputs, screenshots, and imported logs will be permanently deleted.",
                                ),
                                okText: bi("全部删除", "Delete All"),
                                okButtonProps: { status: "danger" },
                                onOk: () => clearAll(true),
                              });
                            }}
                          >
                            {bi("全部删除…", "Delete everything…")}
                          </button>
                        </p>
                      </div>
                    ),
                    okText: bi("只清除结果", "Clear Results Only"),
                    onOk: () => clearAll(false),
                  });
                }}
              >
                {bi("清除记录", "Clear Records")}
              </button>
            )}
            {next && (
              <Button
                size="small"
                type={nextNeedsSyncFirst ? "outline" : isAutoDelivery ? "default" : "primary"}
                status={nextNeedsSyncFirst ? "warning" : undefined}
                icon={nextNeedsSyncFirst ? <IconLock /> : <IconArrowDown />}
                onClick={nextNeedsSyncFirst ? jumpToSyncStep : goNext}
              >
                {nextNeedsSyncFirst
                  ? bi("先核对更新", "Verify Update First")
                  : !can("delivery.run")
                    ? bi("查看执行步骤", "View Steps")
                    : failed
                      ? bi("回到出错的一步", "Jump to Failed Step")
                      : finished
                        ? bi("继续下一步", "Next Step")
                        : bi("从第一步开始", "Start Step 1")}
              </Button>
            )}
          </div>
        </div>
        {syncPending && activeSync && (
          cur.id === "prepare" && !ctlUnpacked ? (
            <div className="rb-sync-gate is-info" role="status">
              <div className="rb-sync-gate-msg">
                <IconBulb />
                <span>
                  <b>
                    {activeSync.kind === "patch"
                      ? bi(
                          `已包含第 ${activeSync.n} 次 AI 补丁更新`,
                          `Includes AI Patch #${activeSync.n}`,
                        )
                      : bi(
                          `已同步至第 ${activeSync.n} 次组件更新`,
                          `Synced to Update #${activeSync.n}`,
                        )}
                  </b>
                  {bi(
                    ` · 请先按本页完成基础包解包与免密准备；进入「部署」第 0 步时会在 ${plan.controller} 自动核对文件版本（新包免覆盖，旧包自动打补丁）。`,
                    ` · Finish unpacking base bundles here first; Deploy step 0 will automatically verify ${plan.controller} (fresh bundle passes, older bundle patches in place).`,
                  )}
                </span>
              </div>
              <Button size="small" onClick={jumpToSyncStep}>
                {bi("查看核对步骤", "View Verify Step")}
              </Button>
            </div>
          ) : (
            <div className="rb-sync-gate" role="alert">
              <div className="rb-sync-gate-msg">
                <IconLock />
                <span>
                  <b>
                    {activeSync.kind === "patch"
                      ? bi(
                          `第 ${activeSync.n} 次 AI 补丁更新尚未在 ${plan.controller} 核对`,
                          `AI Patch #${activeSync.n} not yet verified on ${plan.controller}`,
                        )
                      : activeSync.kind === "hotfix" ||
                          activeSync.kind === "hotfix-revert"
                        ? bi(
                            `第 ${activeSync.n} 次脚本热修补丁尚未在 ${plan.controller} 核对`,
                            `Script Hotfix #${activeSync.n} not yet verified on ${plan.controller}`,
                          )
                        : bi(
                            `第 ${activeSync.n} 次同步更新尚未在 ${plan.controller} 核对`,
                            `Sync #${activeSync.n} not yet verified on ${plan.controller}`,
                          )}
                  </b>
                  {bi(
                    " · 为防止用旧文件执行，部署及后续步骤命令已暂停复制。请在「部署」第 0 步执行自动核对命令并确认。",
                    " · Deploy & test commands are paused so stale files are never run. Run and confirm Deploy step 0 first.",
                  )}
                </span>
              </div>
              <Button
                size="small"
                type="primary"
                status="warning"
                icon={<IconArrowDown />}
                onClick={jumpToSyncStep}
              >
                {bi("前往核对步骤", "Go to Verify Step")}
              </Button>
            </div>
          )
        )}
        {logs.length > 0 && (
          <details className="rb-logs">
            <summary>{bi(`已导入 ${logs.length} 份执行日志`, `${logs.length} imported ${logs.length === 1 ? "log" : "logs"}`)}</summary>
            <ul>
              {logs.map((l) => (
                <li key={l.file}>
                  <span
                    className={`rb-log-r ${l.result === "PASSED" ? "ok" : "bad"}`}
                  >
                    {l.result === "PASSED"
                      ? bi("通过", "PASSED")
                      : l.result === "FAILED"
                        ? bi("失败", "FAILED")
                        : bi("未结束", "INCOMPLETE")}
                  </span>
                  <span className="mono small">{l.file}</span>
                  <span className="faint small">
                    {l.step ? `→ ${l.step}` : bi("没有对上手册里的步骤", "No matching runbook step")}
                  </span>
                  {can("delivery.run") && (
                    <button
                      type="button"
                      className="link quiet"
                      onClick={() => dropLog(l.file)}
                    >
                      {bi("移除", "Remove")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="rb-tabs">
          <Segmented
            size="md"
            label={bi("手册", "Runbook")}
            value={showRecord ? "record" : cur.id}
            onChange={switchTo}
            options={[
              ...tabs.map((t, i) => {
                const n = t.steps.filter((s) => passed(t.id, s.key)).length;
                const skippedCount = t.steps.filter(
                  (s) => rec[keyOf(t.id, s.key)]?.state === "skipped",
                ).length;
                const errCount = t.steps.filter(
                  (s) => rec[keyOf(t.id, s.key)]?.state === "failed",
                ).length;
                const all = t.steps.length > 0 && n === t.steps.length;
                const allSkipped = all && skippedCount === t.steps.length;
                const partial = !all && n > 0;
                const needsSyncDot = syncPending && t.id === "deploy";
                return {
                  value: t.id,
                  sig: `${needsSyncDot ? "sync" : allSkipped ? "skip" : all ? "ok" : errCount ? "bad" : n}`,
                  label: (
                    <>
                      <span
                        className={`rb-tab-n ${
                          needsSyncDot
                            ? "warn"
                            : errCount > 0
                              ? "bad"
                              : allSkipped
                                ? "skip"
                                : all
                                  ? "ok"
                                  : partial
                                    ? "part"
                                    : ""
                        }`}
                      >
                        {needsSyncDot ? (
                          <IconLock />
                        ) : allSkipped ? (
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
                            <path
                              d="M3.5 4.2L8.2 8l-4.7 3.8M11.5 4.2v7.6"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        ) : all ? (
                          <IconCheck />
                        ) : (
                          i + 1
                        )}
                      </span>
                      <span>{t.label}</span>
                      {partial && (
                        <span className="rb-tab-prog num">
                          {n}/{t.steps.length}
                        </span>
                      )}
                    </>
                  ),
                };
              }),
              {
                value: "record",
                label: bi("执行记录", "History"),
                count: events.length || undefined,
              },
            ]}
          />
          {!showRecord && cur.doc && (
            <a className="rb-dl" href={withLang(cur.doc.url)} download={cur.doc.name}>
              <IconDownload /> {bi("下载此篇", "Download MD")}
            </a>
          )}
        </div>

        {showRecord ? (
          <>
            <RecordView
              events={events}
              rec={rec}
              titleOf={titleOf}
              total={total}
              finished={finished}
              failed={failed}
            />
            <AIReports reports={reports} where={bi(`交付 ${plan.cluster}`, `Delivery ${plan.cluster}`)} />
          </>
        ) : (
          <div className={`rb-phase dir-${dir}`} key={cur.id}>
            <div className="rb-phase-head">
              <h3>{cur.label}</h3>
              <span className="faint small num">
                {cur.steps.length === 1 ? bi("1 步", "1 step") : bi(`${cur.steps.length} 步`, `${cur.steps.length} steps`)}
                {cur.id === "deploy" && activeSync
                  ? bi(" + 1 项更新核对", " + 1 update check")
                  : ""}
              </span>
            </div>
            {cur.lead && (
              <p className="rb-lead">
                <Prose text={cur.lead} />
              </p>
            )}
            <ol className="rsteps">
              {cur.id === "deploy" && activeSync && (
                <li
                  id="sync-runbook-step"
                  className={`rstep rstep-sync ${syncConfirmed ? "done" : "is-pending current"}`}
                >
                  <button
                    type="button"
                    className="rstep-check"
                    aria-label={
                      syncConfirmed
                        ? bi("更新核对已确认", "Update verification confirmed")
                        : bi("前置更新核对（未确认）", "Pre-flight update verification (pending)")
                    }
                    onClick={() => {
                      if (syncConfirmed) setSyncOpen((v) => !v);
                    }}
                  >
                    {syncConfirmed ? <IconCheck /> : <IconLock />}
                  </button>
                  <div className="rstep-main">
                    <div className="rstep-head">
                      <b>
                        {activeSync.kind === "patch"
                          ? bi(
                              `核对并应用第 ${activeSync.n} 次 AI 补丁更新`,
                              `Verify & Apply AI Patch #${activeSync.n}`,
                            )
                          : bi(
                              `核对并应用第 ${activeSync.n} 次同步更新`,
                              `Verify & Apply Sync #${activeSync.n}`,
                            )}
                      </b>
                      <span className="hosts">
                        <span
                          className="host p"
                          title={nameOf(plan.controller)?.ip}
                        >
                          <i aria-hidden />
                          {plan.controller}
                        </span>
                      </span>
                      <span className={`rstep-sync-badge ${syncConfirmed ? "ok" : ""}`}>
                        {syncConfirmed
                          ? bi("已核对通过", "Verified")
                          : bi("前置必做", "Required First")}
                      </span>
                      {syncConfirmed && activeSync.applied_at && (
                        <span className="faint small">
                          {activeSync.applied_by || activeSync.by} ·{" "}
                          <time title={fullTime(activeSync.applied_at)}>
                            {ago(activeSync.applied_at)}
                          </time>
                        </span>
                      )}
                      {syncConfirmed && (
                        <button
                          type="button"
                          className="rstep-toggle"
                          aria-expanded={syncOpen}
                          onClick={() => setSyncOpen((v) => !v)}
                        >
                          <IconDown className={syncOpen ? "open" : ""} />
                          {syncOpen ? bi("收起", "Hide") : bi("展开", "Show")}
                        </button>
                      )}
                    </div>
                    {(syncPending || syncOpen) && (
                      <div className="rstep-fold open">
                        <div className="rstep-body">
                          <p className="rstep-lead">
                            {activeSync.kind === "patch"
                              ? bi(
                                  `AI 补丁更新不会重打基础包：请先将下方补丁包上传至 ${plan.controller} 的 ${plan.upload_dir || "/tmp/mw-upload"}，再执行下方命令自动校验并覆盖生效。`,
                                  `AI patches do not rebuild base bundles: upload the patch below to ${plan.upload_dir || "/tmp/mw-upload"} on ${plan.controller}, then run the command below to verify and apply it.`,
                                )
                              : bi(
                                  `不用凭记忆判断 ${plan.controller} 之前传的是旧包还是最新完整包：直接执行下方命令，它会自动按 SHA256 核对本次改动的项目文件——已是最新则直接放行，仍是旧版则自动校验并覆盖增量更新包，漏传则会立即拦截提醒。`,
                                  `No need to guess whether ${plan.controller} has an older bundle or the latest full bundle: this command verifies changed project files by SHA-256—passes immediately if up to date, applies the patch automatically if present, or stops with upload instructions.`,
                                )}
                          </p>
                          {activeSync.kind === "patch" && activeSync.reason && (
                            <p className="rstep-detail">{activeSync.reason}</p>
                          )}
                          {syncUpdFile && (
                            <div className="rstep-files">
                              <a
                                href={withLang(syncUpdFile.url)}
                                download={syncUpdFile.name}
                                className="fchip"
                              >
                                <IconDownload />
                                <span className="mono">{syncUpdFile.name}</span>
                                <span className="faint num">{size(syncUpdFile.bytes)}</span>
                              </a>
                              {syncSumFile && (
                                <a
                                  href={withLang(syncSumFile.url)}
                                  download={syncSumFile.name}
                                  className="fchip"
                                >
                                  <IconDownload />
                                  <span className="mono">{syncSumFile.name}</span>
                                  <span className="faint num">{size(syncSumFile.bytes)}</span>
                                </a>
                              )}
                            </div>
                          )}
                          <CopyGuardContext.Provider value={UNLOCKED_GUARD}>
                            <Terminal
                              code={syncVerifyCmd}
                              host={plan.controller}
                              noPerLine
                            />
                          </CopyGuardContext.Provider>
                          <p className="rstep-detail">
                            {bi(
                              "通过标准：终端输出 OK: ...（已是最新无需覆盖，或已覆盖更新包并校验通过）。",
                              "Expected: terminal prints OK: ... (already up to date, or update archive applied and verified).",
                            )}
                          </p>
                          {syncPending && (
                            <div className="rstep-sync-confirm">
                              <span className="rstep-sync-confirm-note">
                                <IconLock />
                                {bi(
                                  `在 ${plan.controller} 运行上方命令并看到 OK 输出后，点击确认解锁下方步骤`,
                                  `After seeing OK on ${plan.controller}, confirm below to unlock the remaining steps`,
                                )}
                              </span>
                              {can("delivery.run") ? (
                                <Button
                                  size="small"
                                  type="primary"
                                  icon={<IconCheck />}
                                  loading={syncConfirming}
                                  onClick={confirmLatestSync}
                                >
                                  {bi(
                                    `已在 ${plan.controller} 校验输出 OK，解锁后续步骤`,
                                    `Verified OK on ${plan.controller}, Unlock Steps`,
                                  )}
                                </Button>
                              ) : (
                                <span className="faint small">
                                  {bi("需由有执行权限的人员确认后解锁", "Requires run permission to confirm")}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </li>
              )}
              {cur.steps.map((s, k) => {
                const r = rec[keyOf(cur.id, s.key)];
                const isDone = r?.state === "done" || r?.state === "resolved";
                const isSkipped = r?.state === "skipped";
                const isSettled = isDone || isSkipped;
                const isFailed = r?.state === "failed";
                const isAutoLive = Boolean(
                  r?.auto_state && AUTO_LIVE.has(r.auto_state),
                );
                const isAutoAlert =
                  r?.auto_state === "unknown" || r?.auto_state === "blocked";
                const hasAutoLog = Boolean(
                  r?.execution && r?.attempt && (r?.log_seq ?? 0) > 0,
                );
                const expanded =
                  !isSettled ||
                  isAutoLive ||
                  isAutoAlert ||
                  open[`${cur.id}-${s.key}`];
                const danger = DANGER.has(s.effect);
                const collapseCmd =
                  isAutoDelivery && cur.id !== "prepare" && Boolean(s.code);
                return (
                  <li
                    key={s.key}
                    id={`rs-${cur.id}-${s.key}`}
                    className={`rstep ${isDone ? "done" : ""} ${isSkipped ? "skipped" : ""} ${isFailed ? "failed" : ""} ${isAutoLive ? "running" : ""} ${s.key === currentKey ? "current" : ""} ${danger ? "danger" : ""}`}
                  >
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isSettled}
                      aria-label={bi(
                        `第 ${k + 1} 步${isDone ? "，已完成" : isSkipped ? "，已跳过" : isFailed ? "，失败" : ""}`,
                        `Step ${k + 1}${isDone ? ", completed" : isSkipped ? ", skipped" : isFailed ? ", failed" : ""}`,
                      )}
                      className="rstep-check"
                      onClick={() => toggle(cur.id, s.key)}
                    >
                      {isDone ? (
                        <IconCheck />
                      ) : isSkipped ? (
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                          <path
                            d="M3.2 4.2L8 8l-4.8 3.8M11.6 4.2v7.6"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : isFailed ? (
                        <IconClose />
                      ) : (
                        <span className="num">{k + 1}</span>
                      )}
                    </button>
                    <div className="rstep-main">
                      <div className="rstep-head">
                        <b>{s.title}</b>
                        {s.hosts.length > 0 && (
                          <span
                            className="hosts"
                            aria-label={bi(`执行机器：${s.hosts.join("，")}`, `Target hosts: ${s.hosts.join(", ")}`)}
                          >
                            {s.hosts.map((h, i) => (
                              <React.Fragment key={h}>
                                {i > 0 && (
                                  <span className="hosts-then" aria-hidden>
                                    →
                                  </span>
                                )}
                                <span
                                  className={`host ${h === plan.controller ? "p" : ""}`}
                                  title={nameOf(h)?.ip}
                                >
                                  <i aria-hidden />
                                  {h}
                                </span>
                              </React.Fragment>
                            ))}
                          </span>
                        )}
                        {aiStatus.enabled && s.ai && (
                          <span
                            className="rstep-ai-badge"
                            title={bi(
                              `${s.ai.by} 采纳的 AI 提案，已写入交付文档${s.ai.changed ? "；原命令见步骤下方" : ""}`,
                              `AI proposal accepted by ${s.ai.by} and saved to docs${s.ai.changed ? "; original command shown below" : ""}`,
                            )}
                          >
                            {s.ai.changed ? bi("AI 修改", "AI Edited") : bi("AI 补充", "AI Added")}
                          </span>
                        )}
                        {danger ? (
                          <span className="tag-danger">{bi("不可撤销", "Destructive")}</span>
                        ) : (
                          <span className={`rstep-effect e-${s.effect}`}>
                            {EFFECT[s.effect] || s.effect}
                          </span>
                        )}
                        {(isAutoLive || isAutoAlert) && r?.auto_state && (
                          <span className={`rstep-live-pill ${r.auto_state}`}>
                            <i aria-hidden />
                            {AUTO_STATE_LABEL[r.auto_state] || r.auto_state}
                          </span>
                        )}
                        {!isAutoLive &&
                          !isAutoAlert &&
                          r?.source === "automatic" &&
                          (isSettled || isFailed) && (
                            <span
                              className={`rstep-auto-badge ${isFailed ? "bad" : isSkipped ? "skip" : "ok"}`}
                            >
                              {bi("自动执行", "Auto")}
                              {r.recap && r.recap.length > 0
                                ? ` · ${r.recap.length}${bi("节点", "h")}`
                                : ""}
                            </span>
                          )}
                        {!isAutoLive &&
                          (r?.attempts?.length || 0) > 1 && (() => {
                            const atts = r!.attempts!;
                            const priorFails = atts
                              .slice(0, -1)
                              .filter((a) => a.state === "failed").length;
                            const recovered =
                              (r!.state === "done" || r!.state === "resolved") &&
                              priorFails > 0;
                            return (
                              <span
                                className={`rstep-retry-badge ${recovered ? "recovered" : ""}`}
                                title={bi(
                                  `该步骤共有 ${atts.length} 次自动执行记录，展开可切换查看每次日志`,
                                  `${atts.length} automated runs recorded; expand to inspect every attempt`,
                                )}
                              >
                                {recovered
                                  ? bi(
                                      `第 ${atts.length} 次通过 · 曾失败 ${priorFails} 次`,
                                      `Passed on run #${atts.length} · ${priorFails} prior fail`,
                                    )
                                  : bi(
                                      `共 ${atts.length} 次执行`,
                                      `${atts.length} runs`,
                                    )}
                              </span>
                            );
                          })()}
                        {s.key === currentKey && !isAutoLive && (
                          <span
                            className={isFailed ? "tag-danger" : "tag-next"}
                          >
                            {isFailed ? bi("失败，处理后重试", "Failed · retry after fix") : bi("下一步", "Next")}
                          </span>
                        )}
                        {isSkipped && (
                          <span className="rstep-skip-badge">{bi("已跳过", "Skipped")}</span>
                        )}
                        {r?.state === "resolved" && (
                          <span className="rstep-effect e-resolved">
                            {bi("已解决", "Resolved")}
                          </span>
                        )}
                        {isSettled && (
                          <button
                            className="rstep-toggle"
                            onClick={() =>
                              setOpen((o) => ({
                                ...o,
                                [`${cur.id}-${s.key}`]:
                                  !o[`${cur.id}-${s.key}`],
                              }))
                            }
                            aria-expanded={expanded}
                          >
                            <IconDown className={expanded ? "rstep-chevron-open" : ""} />
                            {expanded
                              ? bi("收起", "Collapse")
                              : hasAutoLog || r?.log
                                ? bi("查看结果与日志", "View result & log")
                                : bi("展开", "Expand")}
                          </button>
                        )}
                      </div>
                      <div className={`rstep-fold ${expanded ? "open" : ""}`}>
                        <div>
                          {s.lead && (
                            <p className="rstep-lead">
                              <Prose text={s.lead} />
                            </p>
                          )}
                          {s.detail && (
                            <p className="rstep-detail">{s.detail}</p>
                          )}
                          {s.rollback && s.rollback.length > 0 && (
                            <details className="rstep-rb">
                              <summary>
                                {bi("出了问题怎么退回", "Rollback guidance")}
                                {s.rollback.length > 1
                                  ? bi(`（${s.rollback.length} 步）`, ` (${s.rollback.length} steps)`)
                                  : ""}
                              </summary>
                              {s.rollback.length === 1 &&
                              !s.rollback[0].title ? (
                                <p>{s.rollback[0].text}</p>
                              ) : (
                                <ul>
                                  {s.rollback.map((r, i) => (
                                    <li
                                      key={i}
                                      className={
                                        r.noRollback ? "none" : ""
                                      }
                                    >
                                      <b>{r.title}</b>
                                      <span>{r.text}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </details>
                          )}
                          {s.files.length > 0 && (
                            <div className="rstep-files">
                              {s.files.map((f) => (
                                <a
                                  key={f.name}
                                  href={withLang(f.url)}
                                  download={f.name}
                                  className="fchip"
                                >
                                  <IconDownload />
                                  <span className="mono">{f.name}</span>
                                  <span className="faint num">
                                    {size(f.bytes)}
                                  </span>
                                </a>
                              ))}
                            </div>
                          )}
                          {(olds[keyOf(cur.id, s.key)] || []).map((o, oi) => (
                            <OldStep
                              key={oi}
                              o={o}
                              host={s.hosts[0]}
                              jobId={jobId}
                              stepKey={keyOf(cur.id, s.key)}
                              onKept={() =>
                                api<Parameters<typeof apply>[0]>(
                                  `/api/jobs/${jobId}/progress`,
                                ).then(apply)
                              }
                            />
                          ))}
                          {s.code &&
                            (collapseCmd ? (
                              <details className="rstep-cmd-ref">
                                <summary>
                                  {bi(
                                    "查看底层执行命令（供审计与手工排障参考）",
                                    "View underlying command (for audit / troubleshooting)",
                                  )}
                                </summary>
                                <Terminal code={s.code} host={s.hosts[0]} />
                              </details>
                            ) : (
                              <Terminal code={s.code} host={s.hosts[0]} />
                            ))}
                          {s.ai?.before && (
                            <details className="rstep-before">
                              <summary>{bi("修改前的命令", "Original command")}</summary>
                              <Terminal code={s.ai.before} host={s.hosts[0]} />
                            </details>
                          )}
                          <div className="rstep-acts">
                            {can("delivery.run") ? (
                              <ResultBar
                                r={r}
                                isAutoDelivery={isAutoDelivery}
                                isPrep={cur.id === "prepare"}
                                editing={editing === keyOf(cur.id, s.key)}
                                setEditing={(v) =>
                                  setEditing(v ? keyOf(cur.id, s.key) : null)
                                }
                                save={(state, note, log, images) =>
                                  save(cur.id, s.key, state, note, log, images)
                                }
                                askAI={
                                  dock?.available("step:x")
                                    ? (prefill) => askAI(cur, s, prefill)
                                    : undefined
                                }
                              />
                            ) : (
                              r && (r.state || isAutoLive || isAutoAlert) && (
                                <StepRecord r={r} />
                              )
                            )}
                            {cur.id !== "prepare" &&
                              editing !== keyOf(cur.id, s.key) && (
                                <button
                                  type="button"
                                  className="rstep-log"
                                  onClick={() =>
                                    setHotfixTarget({
                                      key: keyOf(cur.id, s.key),
                                      title: s.title,
                                    })
                                  }
                                >
                                  <IconCode />{" "}
                                  {can("delivery.run")
                                    ? bi("编辑本步脚本", "Edit Script")
                                    : bi("查看脚本", "View Script")}
                                </button>
                              )}
                            {isAutoDelivery &&
                              cur.id !== "prepare" &&
                              editing !== keyOf(cur.id, s.key) &&
                              can("delivery.execute") && (
                                <button
                                  type="button"
                                  className="rstep-log"
                                  onClick={() =>
                                    dispatchExecLaunchIntent({
                                      jobId,
                                      mode: "from",
                                      stepKey: keyOf(cur.id, s.key),
                                    })
                                  }
                                >
                                  <IconPlayArrow />{" "}
                                  {bi("从此步续跑", "Resume Here")}
                                </button>
                              )}
                            {aiStatus.enabled &&
                              s.ai &&
                              editing !== keyOf(cur.id, s.key) &&
                              can("delivery.run") && (
                                <button
                                  type="button"
                                  className="rstep-log rstep-ai"
                                  onClick={() => withdraw(s.ai!.id, s.title)}
                                >
                                  <IconClose />{" "}
                                  {s.ai.changed ? bi("撤销这处修改", "Revert edit") : bi("撤销这一步", "Remove step")}
                                </button>
                              )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
              {cur.notes.length > 0 && (
                <li className="rb-note rb-skipped">
                  <details key={cur.id}>
                    <summary>
                      <IconDown className="rb-skipped-arrow" />
                      <strong>{cur.id === "cleanup" ? bi("未执行的步骤", "Skipped steps") : bi("未执行的测试", "Skipped tests")}</strong>
                      <span className="rb-skipped-count">
                        {cur.notes.length === 1
                          ? bi("1 项", "1 item")
                          : bi(`${cur.notes.length} 项`, `${cur.notes.length} items`)}
                      </span>
                      <span className="rb-skipped-toggle"><span className="when-closed">{bi("查看原因", "Show reason")}</span><span className="when-open">{bi("收起", "Hide")}</span></span>
                    </summary>
                    <p className="rb-skipped-help">{bi("以下项目不适用于本次配置，无需执行。", "The following items do not apply to this configuration and require no action.")}</p>
                    <ul className="rb-skipped-list">
                      {cur.notes.map((note, i) => (
                        <li key={note.id + i}>
                          <div className="rb-skipped-name">
                            <div className="rb-skipped-name-row">
                              <strong>{note.title}</strong>
                              {note.group && (
                                <span className="rb-skipped-tag">{note.group}</span>
                              )}
                            </div>
                            <code>{note.id}</code>
                          </div>
                          <p>{note.reason}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              )}
            </ol>
            {idx < tabs.length - 1 && (
              <button
                className="rb-nextphase"
                onClick={() => switchTo(tabs[idx + 1].id)}
              >
                <span>{bi("下一篇", "Next section")}</span>
                <b>{tabs[idx + 1].label}</b>
              </button>
            )}
          </div>
        )}
      </div>
      <StepHotfixDrawer
        open={!!hotfixTarget}
        jobId={jobId}
        stepKey={hotfixTarget?.key}
        stepTitle={hotfixTarget?.title}
        deliveryMode={deliveryMode}
        onClose={() => setHotfixTarget(null)}
        onPatched={() => {
          window.dispatchEvent(
            new CustomEvent("mh-delivery-patched", { detail: { jobId } }),
          );
          void onSyncConfirmed?.();
        }}
        onLaunchStep={
          isAutoDelivery
            ? (mode, key) =>
                dispatchExecLaunchIntent({ jobId, mode, stepKey: key })
            : undefined
        }
      />
      </CopyGuardContext.Provider>
    </JobIdContext.Provider>
  );
}

/** What was written down for one step: who, when, the note, and the pasted output behind a click. */
/** Writing down how a step went: one click when it worked; when it failed, the output pasted right here, and the
 *  assistant can read it straight away. The record is what everyone opening the delivery sees later. */
function ResultBar({
  r,
  isAutoDelivery,
  isPrep,
  editing,
  setEditing,
  save,
  askAI,
}: {
  r?: Rec;
  isAutoDelivery?: boolean;
  isPrep?: boolean;
  editing: boolean;
  setEditing: (v: boolean) => void;
  save: (
    state: Rec["state"],
    note: string,
    log: string,
    images: string[],
  ) => Promise<void>;
  askAI?: (prefill?: string) => void;
}) {
  useLang();
  const jobId = React.useContext(JobIdContext);
  const [mode, setMode] = useState<"" | Rec["state"]>("");
  const [note, setNote] = useState("");
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState("");
  const shots = useShots();
  const isAutoLive = Boolean(r?.auto_state && AUTO_LIVE.has(r.auto_state));
  const isAutoAlert =
    r?.auto_state === "unknown" || r?.auto_state === "blocked";
  const open = (m: Rec["state"]) => {
    setMode(m);
    // what was written before stays, whatever result it is now given
    setNote(r?.note || "");
    setLog(r?.log || "");
    shots.reset(r?.images || []);
    setEditing(true);
  };
  const close = () => {
    setMode("");
    setEditing(false);
  };
  const askFailedAI = async () => {
    if (!askAI || !r) return;
    let output = r.log || "";
    if (!output && r.execution && r.attempt && (r.log_seq ?? 0) > 0 && jobId) {
      try {
        const resp = await fetch(
          withLang(
            `/api/jobs/${jobId}/executions/${r.execution}/logs/${r.attempt}?tail=1`,
          ),
          { headers: { "X-Lang": getLang() } },
        );
        if (resp.ok) output = await resp.text();
      } catch {
        /* fallback to note only */
      }
    }
    askAI(
      bi(
        `这一步执行失败了。${r.note ? "现象：" + r.note + "\n" : ""}${output ? "终端输出：\n```\n" + output.slice(-6000) + "\n```" : ""}\n请帮我分析原因和下一步。`,
        `This step failed. ${r.note ? "Symptom: " + r.note + "\n" : ""}${output ? "Terminal output:\n```\n" + output.slice(-6000) + "\n```" : ""}\nPlease analyze the root cause and next steps.`,
      ),
    );
  };
  const tooBig = new Blob([log]).size > 64 << 10 || shots.busy > 0;
  const submit = async (thenAsk: boolean) => {
    if (!mode) return;
    setBusy(thenAsk ? "ai" : "save");
    try {
      await save(mode, note.trim(), log, mode === "skipped" ? [] : shots.names);
      close();
      if (thenAsk && askAI)
        askAI(
          bi(
            `这一步执行失败了。${note.trim() ? "现象：" + note.trim() + "\n" : ""}${log.trim() ? "终端输出：\n```\n" + log.trim().slice(-6000) + "\n```" : ""}\n请帮我分析原因和下一步。`,
            `This step failed. ${note.trim() ? "Symptom: " + note.trim() + "\n" : ""}${log.trim() ? "Terminal output:\n```\n" + log.trim().slice(-6000) + "\n```" : ""}\nPlease analyze the root cause and next steps.`,
          ),
        );
    } finally {
      setBusy("");
    }
  };
  if (editing && mode) {
    return (
      <div
        className={`rb-form m-${mode} ${shots.drag ? "dragging" : ""}`}
        {...(mode === "skipped" ? {} : shots.bind)}
      >
        <div className="rb-form-h">
          <b>
            {mode === "failed"
              ? bi("记录失败", "Record Failure")
              : mode === "skipped"
                ? bi("跳过这一步", "Skip Step")
                : bi("记录完成", "Record Completion")}
          </b>
          <span className="faint small">
            {mode === "failed"
              ? bi("把报错贴进来，之后谁打开这份交付都能看到当时的现场", "Paste the error output so anyone viewing this delivery sees what happened")
              : mode === "skipped"
                ? bi("写一句为什么跳过", "Briefly explain why this step was skipped")
                : bi("可以附上输出，留作凭据", "Optionally attach terminal output as evidence")}
          </span>
        </div>
        {mode !== "done" && (
          <Input
            value={note}
            onChange={setNote}
            maxLength={500}
            placeholder={
              mode === "failed"
                ? bi("一句话说明现象，例如：解包时提示空间不足", "Briefly describe the issue, e.g., insufficient disk space on unpack")
                : bi("为什么跳过", "Reason for skipping")
            }
            aria-label={bi("说明", "Notes")}
            autoFocus={mode === "skipped"}
          />
        )}
        {mode !== "skipped" && (
          <textarea
            className="rec-area mono"
            spellCheck={false}
            value={log}
            onChange={(e) => setLog(e.target.value)}
            placeholder={bi(
              "粘贴终端输出（可选，最多 64 KiB；通常最后几十行就够）。也可以直接粘贴或拖入截图",
              "Paste terminal output (optional, max 64 KiB; last few dozen lines usually suffice). You can also paste or drop screenshots",
            )}
            aria-label={bi("终端输出", "Terminal output")}
            autoFocus
          />
        )}
        {mode !== "skipped" && <Shots shots={shots} />}
        {new Blob([log]).size > 64 << 10 && (
          <span className="bad small">{bi("输出超过 64 KiB，请只保留关键部分", "Output exceeds 64 KiB; trim to key lines")}</span>
        )}
        <div className="rec-actions">
          <Button size="small" onClick={close}>
            {bi("取消", "Cancel")}
          </Button>
          <Button
            size="small"
            type={mode === "failed" && askAI ? "outline" : "primary"}
            loading={busy === "save"}
            disabled={tooBig}
            onClick={() => submit(false)}
          >
            {bi("保存", "Save")}
          </Button>
          {mode === "failed" && askAI && (
            <Button
              size="small"
              type="primary"
              loading={busy === "ai"}
              disabled={tooBig}
              onClick={() => submit(true)}
            >
              <Spark size={12} /> {bi("保存并让 AI 分析", "Save & Ask AI")}
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (r && (r.state || isAutoLive || isAutoAlert)) {
    const failedOrAlert = r.state === "failed" || isAutoAlert;
    return (
      <div className="rb-done">
        <StepRecord r={r} />
        <div className="rb-done-acts">
          {!isAutoLive && (
            <button
              type="button"
              className="rstep-log"
              onClick={() => open(r.state || "done")}
            >
              <IconEdit />{" "}
              {r.source === "automatic"
                ? bi("人工补充/修改", "Override / edit")
                : bi("修改", "Edit")}
            </button>
          )}
          {failedOrAlert && askAI && (
            <button
              type="button"
              className="rstep-log rstep-ai"
              onClick={() => void askFailedAI()}
            >
              <Spark size={13} /> {bi("让 AI 分析这次失败", "Analyze failure with AI")}
            </button>
          )}
          {!failedOrAlert && askAI && (
            <button
              type="button"
              className="rstep-log rstep-ai"
              onClick={() => askAI()}
            >
              <Spark size={13} /> {bi("有疑问，问 AI", "Ask AI")}
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <>
      {r && (r.note || r.log || (r.images && r.images.length > 0)) && (
        <div className="rb-kept">
          <StepRecord r={r} />
          <span className="faint small">
            {bi(
              "结果已清除，上面写下的内容还在；重新标记结果时会带上它。",
              "Status cleared; notes and attachments above are preserved and will stay when re-marked.",
            )}
          </span>
        </div>
      )}
      {isAutoDelivery && !isPrep ? (
        <div className="rb-auto-wait">
          <span>
            {bi(
              "等待在上方执行控制栏发起自动执行；运行后状态与日志将自动回填到此步骤",
              "Start automated execution from the control bar above; status and logs will appear here automatically",
            )}
          </span>
          <button type="button" className="rb-link" onClick={() => open("done")}>
            {bi("人工记录…", "Record manually…")}
          </button>
          {askAI && (
            <button
              type="button"
              className="rstep-log rstep-ai rb-ask"
              onClick={() => askAI()}
            >
              <Spark size={13} /> {bi("遇到问题，问 AI", "Stuck? Ask AI")}
            </button>
          )}
        </div>
      ) : (
        <div className="rb-bar" role="group" aria-label={bi("记录这一步的结果", "Record step result")}>
          <span className="rb-q">{bi("执行结果", "Result")}</span>
          <button
            type="button"
            className="rb-btn ok"
            disabled={!!busy}
            onClick={async () => {
              setBusy("done");
              try {
                await save("done", r?.note || "", r?.log || "", r?.images || []);
              } finally {
                setBusy("");
              }
            }}
          >
            <IconCheck /> {bi("成功", "Pass")}
          </button>
          <button
            type="button"
            className="rb-btn bad"
            onClick={() => open("failed")}
          >
            <IconClose /> {bi("失败…", "Fail…")}
          </button>
          <button
            type="button"
            className="rb-btn"
            onClick={() => open("skipped")}
          >
            {bi("跳过…", "Skip…")}
          </button>
          <button type="button" className="rb-link" onClick={() => open("done")}>
            {bi("附上输出", "Attach output")}
          </button>
          {askAI && (
            <button
              type="button"
              className="rstep-log rstep-ai rb-ask"
              onClick={() => askAI()}
            >
              <Spark size={13} /> {bi("遇到问题，问 AI", "Stuck? Ask AI")}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/* ---------- screenshots next to a step's output ---------- */

export const JobIdContext = React.createContext("");
const SHOT_TYPES = /^image\/(png|jpeg|gif|webp)$/;

function useShots() {
  const job = React.useContext(JobIdContext);
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(0);
  const [drag, setDrag] = useState(false);
  const add = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith("image/"));
    if (!pics.length) return;
    if (pics.some((f) => !SHOT_TYPES.test(f.type)))
      return Message.warning(bi("图片需要是 png、jpg、gif 或 webp", "Images must be PNG, JPG, GIF, or WebP"));
    if (names.length + pics.length > 8)
      return Message.warning(bi("每一步最多附 8 张图片", "Maximum 8 screenshots per step"));
    if (pics.some((f) => f.size > 4 << 20))
      return Message.warning(bi("每张图片不能超过 4 MiB", "Each image must be under 4 MiB"));
    setBusy((n) => n + pics.length);
    for (const f of pics) {
      try {
        const r = await api<{ name: string }>(`/api/jobs/${job}/progress/img`, {
          method: "POST",
          body: JSON.stringify({ data: await readFile(f) }),
        });
        setNames((x) => (x.includes(r.name) ? x : [...x, r.name]));
      } catch (e) {
        err(e);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };
  const bind = {
    onPaste: (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (!files.length) return;
      e.preventDefault();
      add(files);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDrag(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      setDrag(false);
      add(Array.from(e.dataTransfer.files));
    },
  };
  return {
    names,
    busy,
    drag,
    add,
    bind,
    reset: (n: string[]) => setNames(n),
    remove: (n: string) => setNames((x) => x.filter((y) => y !== n)),
  };
}

function ShotList({
  names,
  remove,
}: {
  names: string[];
  remove?: (n: string) => void;
}) {
  useLang();
  const job = React.useContext(JobIdContext);
  return (
    <div className="shots">
      {names.map((n, i) => (
        <div key={n} className="shot">
          <a
            href={`/api/jobs/${job}/progress/img/${n}`}
            target="_blank"
            rel="noreferrer"
            title={bi("在新标签页打开原图", "Open full image in new tab")}
          >
            <img
              src={`/api/jobs/${job}/progress/img/${n}`}
              alt={bi(`截图 ${i + 1}`, `Screenshot ${i + 1}`)}
              loading="lazy"
            />
          </a>
          {remove && (
            <button
              type="button"
              className="shot-x"
              aria-label={bi(`移除截图 ${i + 1}`, `Remove screenshot ${i + 1}`)}
              onClick={() => remove(n)}
            >
              <IconClose />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Shots({ shots }: { shots: ReturnType<typeof useShots> }) {
  useLang();
  const pick = React.useRef<HTMLInputElement>(null);
  return (
    <div className="shots-box">
      {(shots.names.length > 0 || shots.busy > 0) && (
        <div className="shots-row">
          <ShotList names={shots.names} remove={shots.remove} />
          {shots.busy > 0 && (
            <span className="faint small">{bi(`正在上传 ${shots.busy} 张…`, `Uploading ${shots.busy}…`)}</span>
          )}
        </div>
      )}
      <button
        type="button"
        className="shots-add"
        onClick={() => pick.current?.click()}
      >
        <IconImage /> {bi("添加截图", "Add Screenshot")}
        <span className="faint">　{bi("点击选择，或在这里粘贴 / 拖入", "Click to browse, or paste / drop here")}</span>
      </button>
      <input
        ref={pick}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) shots.add(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
    </div>
  );
}

type OldVersion = {
  sync: number;
  at: string;
  title: string;
  purpose?: string;
  expect?: string;
  command?: string;
  /** What reaches the step from the sync's changes. */
  why?: string;
  record: Rec;
};

/** A version of the step that a sync with the component replaced: struck through, with what was recorded against it,
 *  so the step's history stays readable. */
function OldStep({
  o,
  host,
  jobId,
  stepKey,
  onKept,
}: {
  o: OldVersion;
  host: string;
  jobId: string;
  stepKey: string;
  onKept: () => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  // a person's call that the change does not touch this step: it is recorded with their name and reason
  const keep = () => {
    let reason = "";
    Modal.confirm({
      title: bi("确认这一步不受这次同步影响？", "Confirm this step is unaffected?"),
      content: (
        <div className="sync-confirm">
          <p>
            {bi(
              "平台没法证明改动碰不到它，所以划掉了旧结果。如果你核对过确实无关，可以让旧结果重新生效。这个决定会连同你的名字和理由记在交付里，写进报告。",
              "The platform cannot prove the change doesn't reach this step, so the prior result was crossed out. If you verified it's unaffected, restore it with your name and reason.",
            )}
          </p>
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder={bi(
              "为什么不受影响，例如：只改了入口测试里的函数，这个测试不会执行",
              "Why unaffected, e.g., only helper in endpoint test changed; this step won't run it",
            )}
            onChange={(v) => (reason = v)}
          />
        </div>
      ),
      okText: bi("确认不受影响", "Confirm Unaffected"),
      onOk: async () => {
        try {
          await api(`/api/jobs/${jobId}/sync/keep`, {
            method: "POST",
            body: JSON.stringify({ key: stepKey, sync: o.sync, reason }),
          });
          Message.success(bi("已记录，旧结果重新生效", "Recorded; previous result restored"));
          onKept();
        } catch (e) {
          err(e);
          throw e;
        }
      },
    });
  };
  return (
    <div className="rstep-old">
      <button
        type="button"
        className="rstep-old-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="rstep-old-tag">{bi("旧版本", "Previous")}</span>
        <s>{o.title}</s>
        <span className="faint small">
          {bi(`第 ${o.sync} 次按最新组件同步前 · `, `Before sync #${o.sync} · `)}
          {o.record.state ? STATE_LABEL[o.record.state] : bi("有记录", "Has record")}
        </span>
        <span className="link quiet small">{open ? bi("收起", "Collapse") : bi("展开", "Expand")}</span>
      </button>
      {open && (
        <div className="rstep-old-body">
          {o.command && <Terminal code={o.command} host={host} />}
          <StepRecord r={o.record} />
        </div>
      )}
      {(o.why || can("delivery.run")) && (
        <div className="rstep-old-why">
          {o.why && (
            <div className="rstep-old-reasons">
              <b>{bi("为什么要重新执行：", "Why re-verification is needed:")}</b>
              <ul>
                {o.why
                  .split("\n")
                  .filter(Boolean)
                  .map((l) => (
                    <li key={l}>{l}</li>
                  ))}
              </ul>
            </div>
          )}
          {can("delivery.run") && (
            <button type="button" className="link" onClick={keep}>
              {bi("我核对过，不受影响", "Verified unaffected")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function formatDuration(started?: string, finished?: string): string {
  if (!started || !finished) return "";
  const a = Date.parse(started);
  const b = Date.parse(finished);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return "";
  const sec = Math.max(0, Math.round((b - a) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

function StepRecord({ r }: { r: Rec }) {
  useLang();
  const jobId = React.useContext(JobIdContext);
  const attempts = r.attempts && r.attempts.length > 0 ? r.attempts : null;
  const [selectedAttempt, setSelectedAttempt] = useState<string>("");

  // Reset to latest attempt when a newer attempt arrives on the step.
  useEffect(() => {
    setSelectedAttempt("");
  }, [r.execution, r.attempt, attempts?.length]);

  const viewingHistorical = Boolean(
    selectedAttempt &&
      attempts &&
      attempts.some((a) => a.attempt === selectedAttempt) &&
      selectedAttempt !== r.attempt,
  );
  const activeAttempt =
    viewingHistorical && attempts
      ? attempts.find((a) => a.attempt === selectedAttempt) || null
      : null;

  const viewExecution = activeAttempt ? activeAttempt.execution : r.execution;
  const viewAttemptId = activeAttempt ? activeAttempt.attempt : r.attempt;
  const viewAutoState = activeAttempt ? activeAttempt.auto_state : r.auto_state;
  const viewLogSeq = activeAttempt ? activeAttempt.log_seq : r.log_seq;
  const viewState = activeAttempt ? activeAttempt.state : r.state;
  const viewExecutor = activeAttempt ? activeAttempt.executor : r.executor;
  const viewStarted = activeAttempt ? activeAttempt.started : r.started;
  const viewFinished = activeAttempt ? activeAttempt.finished : r.finished;
  const viewExitCode = activeAttempt ? activeAttempt.exit_code : r.exit_code;
  const viewRecap = activeAttempt ? activeAttempt.recap : r.recap;
  const viewNote = activeAttempt ? activeAttempt.message : r.note;
  const viewBy = activeAttempt ? activeAttempt.by : r.by;
  const viewAt = activeAttempt ? activeAttempt.at || activeAttempt.finished : r.at;

  const hasExecLog = Boolean(
    viewExecution && viewAttemptId && (viewLogSeq ?? 0) > 0 && jobId,
  );
  const execLogUrl = hasExecLog
    ? `/api/jobs/${jobId}/executions/${viewExecution}/logs/${viewAttemptId}`
    : "";
  const [show, setShow] = useState(() => r.state === "failed" && Boolean(r.log));
  const [logCopied, setLogCopied] = useState(false);
  const [showExec, setShowExec] = useState(
    () =>
      hasExecLog &&
      (r.state === "failed" ||
        r.auto_state === "running" ||
        r.auto_state === "unknown"),
  );
  const [execText, setExecText] = useState<string | null>(null);
  const [execLoading, setExecLoading] = useState(false);
  const [execErr, setExecErr] = useState("");
  const [execCopied, setExecCopied] = useState(false);

  useEffect(() => {
    if (hasExecLog && viewAutoState === "running") {
      setShowExec(true);
    }
  }, [hasExecLog, viewAutoState]);

  useEffect(() => {
    setExecText(null);
    setExecErr("");
  }, [viewExecution, viewAttemptId]);

  useEffect(() => {
    if (!showExec || !hasExecLog) return;
    let cancelled = false;
    const load = async (initial: boolean) => {
      if (initial) setExecLoading(true);
      try {
        const resp = await fetch(withLang(`${execLogUrl}?tail=1`), {
          headers: { "X-Lang": getLang() },
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const text = await resp.text();
        if (!cancelled) {
          setExecText(text);
          setExecErr("");
        }
      } catch (e) {
        if (!cancelled) {
          setExecErr(
            bi(
              `加载执行日志失败：${err(e)}`,
              `Failed to load execution log: ${err(e)}`,
            ),
          );
        }
      } finally {
        if (!cancelled && initial) setExecLoading(false);
      }
    };
    void load(execText === null);
    if (viewAutoState !== "running") {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => {
      void load(false);
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [showExec, hasExecLog, execLogUrl, viewLogSeq, viewAutoState]);

  const logLines = r.log ? r.log.replace(/\s+$/, "").split("\n").length : 0;
  const clsState =
    viewState ||
    (viewAutoState === "unknown" || viewAutoState === "blocked"
      ? "failed"
      : viewAutoState || "");
  const stateTitle = viewState
    ? STATE_LABEL[viewState] || viewState
    : viewAutoState && AUTO_STATE_LABEL[viewAutoState]
      ? AUTO_STATE_LABEL[viewAutoState]
      : bi("没有标记结果", "Unmarked");
  const isAuto = Boolean(activeAttempt) || r.source === "automatic" || Boolean(r.execution);
  const dur = formatDuration(viewStarted, viewFinished);

  return (
    <div className={`rec rec-${clsState}${viewingHistorical ? " is-historical" : ""}`}>
      {attempts && attempts.length > 1 && (
        <div
          className="rec-attempts"
          role="tablist"
          aria-label={bi("该步骤的执行尝试历史", "Step execution attempts")}
        >
          <span className="rec-attempts-label">
            {bi(`共 ${attempts.length} 次执行`, `${attempts.length} attempts`)}
          </span>
          <div className="rec-attempt-tabs">
            {[...attempts].reverse().map((att, revIdx) => {
              const ord = attempts.length - revIdx;
              const isLatest = revIdx === 0;
              const isSelected = activeAttempt
                ? activeAttempt.attempt === att.attempt
                : isLatest;
              const stLabel =
                att.state === "done"
                  ? bi("通过", "Passed")
                  : att.state === "failed"
                    ? bi("失败", "Failed")
                    : att.state === "skipped"
                      ? bi("跳过", "Skipped")
                      : AUTO_STATE_LABEL[att.auto_state || att.state] || att.state;
              return (
                <button
                  key={att.attempt}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className={`rec-att-tab st-${att.state} ${isSelected ? "on" : ""}`}
                  title={
                    (att.at ? fullTime(att.at) : "") +
                    (att.snapshot ? ` · snapshot ${att.snapshot.slice(0, 12)}` : "") +
                    (att.outdated ? bi(" · 同步前旧快照", " · prior snapshot") : "")
                  }
                  onClick={() => {
                    setSelectedAttempt(isLatest ? "" : att.attempt);
                    if (att.state === "failed" && (att.log_seq ?? 0) > 0) {
                      setShowExec(true);
                    }
                  }}
                >
                  <i aria-hidden />
                  <span>
                    {bi(`第 ${ord} 次`, `Run #${ord}`)} · {stLabel}
                    {isLatest ? bi("（当前）", " (latest)") : ""}
                  </span>
                  {att.outdated && (
                    <em className="rec-att-snap">
                      {bi("旧快照", "prior")}
                    </em>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="rec-top">
        <b>{stateTitle}</b>
        {viewingHistorical && (
          <span className="rec-hist-tag">
            {bi("历史尝试（只读）", "Historical attempt")}
          </span>
        )}
        {isAuto && (
          <span className="rec-auto-pill">
            {bi("自动执行", "Automated")}
            {viewExecutor ? ` · ${viewExecutor}` : ""}
          </span>
        )}
        {dur && <span className="faint small num">{dur}</span>}
        {typeof viewExitCode === "number" && viewExitCode !== 0 && (
          <span className="rec-exit-code">exit {viewExitCode}</span>
        )}
        {activeAttempt?.snapshot && (
          <span className="faint small mono" title={activeAttempt.snapshot}>
            {bi("快照", "snap")} {activeAttempt.snapshot.slice(0, 8)}
          </span>
        )}
        {(viewBy || viewAt) && (
          <span className="faint small">
            {viewBy}
            {viewBy && viewAt ? " · " : ""}
            {viewAt && <time title={fullTime(viewAt)}>{ago(viewAt)}</time>}
          </span>
        )}
        {(hasExecLog || (!viewingHistorical && r.log)) && (
          <span className="rec-top-acts">
            {hasExecLog && (
              <>
                <button
                  type="button"
                  className="link quiet num"
                  onClick={() => setShowExec((v) => !v)}
                  aria-expanded={showExec}
                >
                  {showExec
                    ? bi("收起执行日志", "Hide execution log")
                    : bi("查看执行日志", "View execution log")}
                </button>
                <a
                  className="rec-dl-link"
                  href={withLang(execLogUrl)}
                  download={`execution-${viewAttemptId}.log`}
                >
                  <IconDownload /> {bi("下载完整日志", "Download full log")}
                </a>
              </>
            )}
            {!viewingHistorical && r.log && (
              <button
                type="button"
                className="link quiet num"
                onClick={() => setShow(!show)}
                aria-expanded={show}
              >
                {show
                  ? bi("收起输出", "Hide output")
                  : bi(
                      `查看输出（${logLines} 行 · ${size(new Blob([r.log]).size)}）`,
                      `View output (${logLines} lines · ${size(new Blob([r.log]).size)})`,
                    )}
              </button>
            )}
          </span>
        )}
      </div>
      {viewNote && <p>{viewNote}</p>}
      {viewRecap && viewRecap.length > 0 && (
        <div className="rec-recap">
          {viewRecap.map((raw, idx) => {
            const h = raw as HostRecap & {
              Host?: string;
              OK?: number;
              Changed?: number;
              Failed?: number;
              Unreachable?: number;
              Skipped?: number;
            };
            const host = h.host ?? h.Host ?? "";
            const ok = h.ok ?? h.OK ?? 0;
            const changed = h.changed ?? h.Changed ?? 0;
            const skipped = h.skipped ?? h.Skipped ?? 0;
            const failed = h.failed ?? h.Failed ?? 0;
            const unreachable = h.unreachable ?? h.Unreachable ?? 0;
            const bad = failed > 0 || unreachable > 0;
            return (
              <span
                key={host || idx}
                className={`rec-recap-chip${bad ? " bad" : ""}`}
              >
                <b>{host}</b>
                <span>
                  ok={ok} changed={changed}
                  {skipped > 0 ? ` skipped=${skipped}` : ""}
                  {failed > 0 ? ` failed=${failed}` : ""}
                  {unreachable > 0 ? ` unreachable=${unreachable}` : ""}
                </span>
              </span>
            );
          })}
        </div>
      )}
      {!viewingHistorical && r.images && r.images.length > 0 && <ShotList names={r.images} />}
      {showExec && hasExecLog && (
        <div className="rec-log">
          {execErr ? (
            <span className="bad small">{execErr}</span>
          ) : execLoading && execText === null ? (
            <span className="faint small">
              {bi("正在加载执行日志…", "Loading execution log…")}
            </span>
          ) : (
            <>
              <button
                type="button"
                className="link quiet"
                onClick={() => {
                  copy(execText || "");
                  setExecCopied(true);
                  setTimeout(() => setExecCopied(false), 1400);
                }}
              >
                {execCopied ? <IconCheck /> : <IconCopy />}{" "}
                {execCopied ? bi("已复制", "Copied") : bi("复制", "Copy")}
              </button>
              <pre className="mono">
                {execText || bi("（暂无输出）", "(No output yet)")}
              </pre>
            </>
          )}
        </div>
      )}
      {!viewingHistorical && show && r.log && (
        <div className="rec-log">
          <button
            type="button"
            className="link quiet"
            onClick={() => {
              copy(r.log!);
              setLogCopied(true);
              setTimeout(() => setLogCopied(false), 1400);
            }}
          >
            {logCopied ? <IconCheck /> : <IconCopy />}{" "}
            {logCopied ? bi("已复制", "Copied") : bi("复制", "Copy")}
          </button>
          <pre className="mono">{r.log}</pre>
        </div>
      )}
    </div>
  );
}

function StepForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Rec;
  onSave: (state: Rec["state"], note: string, log: string) => Promise<void>;
  onCancel: () => void;
}) {
  useLang();
  const [state, setState] = useState<Rec["state"]>(initial?.state || "done");
  const [note, setNote] = useState(initial?.note || "");
  const [log, setLog] = useState(initial?.log || "");
  const [busy, setBusy] = useState(false);
  const tooBig = new Blob([log]).size > 64 << 10;
  return (
    <div className="rec-form">
      <Radio.Group
        type="button"
        size="small"
        value={state}
        onChange={setState}
        options={[
          { value: "done", label: bi("完成", "Done") },
          { value: "failed", label: bi("失败", "Failed") },
          { value: "skipped", label: bi("跳过", "Skipped") },
        ]}
      />
      <Input
        value={note}
        onChange={setNote}
        maxLength={500}
        placeholder={
          state === "failed" ? bi("出了什么问题（可选）", "What went wrong (optional)") : bi("备注（可选）", "Note (optional)")
        }
        aria-label={bi("备注", "Note")}
      />
      <textarea
        className="rec-area mono"
        spellCheck={false}
        value={log}
        onChange={(e) => setLog(e.target.value)}
        placeholder={bi(
          "把这一步的终端输出粘贴在这里（可选，最多 64 KiB），日后排查失败时能直接看到当时的现场",
          "Paste terminal output here (optional, max 64 KiB) for future troubleshooting",
        )}
        aria-label={bi("输出", "Output")}
      />
      {tooBig && (
        <span className="bad small">
          {bi("输出超过 64 KiB，请只保留关键部分（通常是最后几十行）", "Output exceeds 64 KiB; keep only the essential lines")}
        </span>
      )}
      <div className="rec-actions">
        <Button size="small" onClick={onCancel}>
          {bi("取消", "Cancel")}
        </Button>
        <Button
          size="small"
          type="primary"
          loading={busy}
          disabled={tooBig}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(state, note, log);
            } finally {
              setBusy(false);
            }
          }}
        >
          {bi("保存记录", "Save")}
        </Button>
      </div>
    </div>
  );
}

function EventLogPanel({
  jobId,
  execution,
  attempt,
}: {
  jobId: string;
  execution: string;
  attempt: string;
}) {
  useLang();
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [copied, setCopied] = useState(false);
  const url = `/api/jobs/${jobId}/executions/${execution}/logs/${attempt}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadErr("");
    fetch(withLang(`${url}?tail=1`), { headers: { "X-Lang": getLang() } })
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.text();
      })
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((e) => {
        if (!cancelled)
          setLoadErr(
            bi(
              `加载执行日志失败：${err(e)}`,
              `Failed to load log: ${err(e)}`,
            ),
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="rec-log rec-tl-log">
      {loadErr ? (
        <span className="bad small">{loadErr}</span>
      ) : loading && text === null ? (
        <span className="faint small">
          {bi("正在加载执行日志…", "Loading execution log…")}
        </span>
      ) : (
        <>
          <div className="rec-tl-log-acts">
            <button
              type="button"
              className="link quiet"
              onClick={() => {
                copy(text || "");
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
            >
              {copied ? <IconCheck /> : <IconCopy />}{" "}
              {copied ? bi("已复制", "Copied") : bi("复制", "Copy")}
            </button>
            <a
              className="rec-dl-link"
              href={withLang(url)}
              download={`execution-${attempt}.log`}
            >
              <IconDownload /> {bi("下载完整日志", "Download full log")}
            </a>
          </div>
          <pre className="mono">
            {text || bi("（暂无输出）", "(No output)")}
          </pre>
        </>
      )}
    </div>
  );
}

/** Everything that was written down, newest first: the story of the rollout. */
function RecordView({
  events,
  rec,
  titleOf,
  total,
  finished,
  failed,
}: {
  events: Ev[];
  rec: Record<string, Rec>;
  titleOf: (k: string) => string;
  total: number;
  finished: number;
  failed: number;
}) {
  useLang();
  const jobId = React.useContext(JobIdContext);
  const [filter, setFilter] = useState<"all" | "failed" | "auto" | "manual">("all");
  const [openLogs, setOpenLogs] = useState<Record<string, boolean>>({});
  const list = [...events].reverse();
  if (!list.length)
    return (
      <div className="rb-phase">
        <p className="muted">
          {bi(
            "还没有执行记录。在每一步下面点“记录结果或粘贴输出”，或直接勾选，之后这里会按时间列出谁在什么时候做了什么。",
            "No execution records yet. Mark steps or attach outputs below to build an audit timeline.",
          )}
        </p>
      </div>
    );
  const isAutoEv = (e: Ev) =>
    e.source === "automatic" || Boolean(e.execution && e.attempt);
  const failCount = list.filter((e) => e.state === "failed").length;
  const autoCount = list.filter(isAutoEv).length;
  const manualCount = list.length - autoCount;
  const shown = list.filter((e) => {
    if (filter === "failed") return e.state === "failed";
    if (filter === "auto") return isAutoEv(e);
    if (filter === "manual") return !isAutoEv(e);
    return true;
  });
  return (
    <div className="rb-phase">
      <div className="rb-phase-head">
        <h3>{bi("执行记录", "Execution History")}</h3>
        <span className="faint small num">
          {bi(`当前最终态：完成 ${finished} / ${total}`, `Current: ${finished} / ${total} done`)}
          {failed ? bi(` · 失败 ${failed}`, ` · ${failed} failed`) : ""}
        </span>
      </div>
      <div className="rec-tl-filters" role="group" aria-label={bi("筛选执行记录", "Filter execution history")}>
        <button
          type="button"
          className={filter === "all" ? "on" : ""}
          onClick={() => setFilter("all")}
        >
          {bi("全部", "All")} <em className="num">{list.length}</em>
        </button>
        {failCount > 0 && (
          <button
            type="button"
            className={`is-fail ${filter === "failed" ? "on" : ""}`}
            onClick={() => setFilter("failed")}
          >
            {bi("历史失败", "Failures")} <em className="num">{failCount}</em>
          </button>
        )}
        {autoCount > 0 && (
          <button
            type="button"
            className={filter === "auto" ? "on" : ""}
            onClick={() => setFilter("auto")}
          >
            {bi("自动执行", "Automated")} <em className="num">{autoCount}</em>
          </button>
        )}
        {manualCount > 0 && (
          <button
            type="button"
            className={filter === "manual" ? "on" : ""}
            onClick={() => setFilter("manual")}
          >
            {bi("手动与同步", "Manual & sync")} <em className="num">{manualCount}</em>
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="muted small">
          {bi("该筛选条件下暂无记录。", "No events match this filter.")}
        </p>
      ) : (
        <ol className="rec-tl">
          {shown.map((e, i) => {
            const resolved = e.key ? titleOf(e.key) : "";
            const heading =
              resolved && resolved !== e.key ? resolved : e.title || e.key;
            const evKey = e.attempt || `${e.at}-${e.key}-${i}`;
            const hasLog = Boolean(
              jobId && e.execution && e.attempt && (e.log_seq ?? 0) > 0,
            );
            const logOpen = Boolean(openLogs[evKey]);
            const dur = formatDuration(e.started, e.finished);
            const evNote =
              e.note ||
              (e.state === "failed" &&
              !e.attempt &&
              rec[e.key]?.state === "failed"
                ? rec[e.key]?.note
                : "");
            const laterRecovered =
              e.state === "failed" &&
              Boolean(e.key) &&
              ["done", "resolved", "skipped"].includes(rec[e.key]?.state || "");
            return (
              <li key={evKey} className={`s-${e.state || "clear"}`}>
                <i aria-hidden />
                <div className="rec-tl-item">
                  <div className="rec-tl-row">
                    <b>{heading}</b>
                    <span className="rec-chip">
                      {STATE_LABEL[e.state] ?? e.state}
                    </span>
                    {laterRecovered && (
                      <span className="rec-tl-recovered">
                        {bi("后续已通过", "later passed")}
                      </span>
                    )}
                    {isAutoEv(e) && (
                      <span className="rec-auto-pill">
                        {bi("自动", "Auto")}
                        {e.executor ? ` · ${e.executor}` : ""}
                      </span>
                    )}
                    {e.source === "sync" && (
                      <span className="rec-sync-pill">
                        {bi("同步更新", "Sync")}
                      </span>
                    )}
                    {dur && <span className="faint small num">{dur}</span>}
                    {typeof e.exit_code === "number" && e.exit_code !== 0 && (
                      <span className="rec-exit-code">exit {e.exit_code}</span>
                    )}
                    {e.execution && (
                      <code className="faint small mono" title={e.execution}>
                        #{e.execution.slice(0, 8)}
                      </code>
                    )}
                    <span className="faint small">
                      {e.by} · <time title={fullTime(e.at)}>{ago(e.at)}</time>
                    </span>
                    {hasLog && (
                      <button
                        type="button"
                        className="link quiet small rec-tl-log-btn"
                        aria-expanded={logOpen}
                        onClick={() =>
                          setOpenLogs((prev) => ({
                            ...prev,
                            [evKey]: !prev[evKey],
                          }))
                        }
                      >
                        {logOpen
                          ? bi("收起日志", "Hide log")
                          : bi("查看日志", "View log")}
                      </button>
                    )}
                  </div>
                  {evNote && <p className="rec-tl-note">{evNote}</p>}
                  {e.recap && e.recap.length > 0 && (
                    <div className="rec-recap">
                      {e.recap.map((raw, idx) => {
                        const h = raw as HostRecap & {
                          Host?: string;
                          OK?: number;
                          Changed?: number;
                          Failed?: number;
                          Unreachable?: number;
                          Skipped?: number;
                        };
                        const host = h.host ?? h.Host ?? "";
                        const ok = h.ok ?? h.OK ?? 0;
                        const changed = h.changed ?? h.Changed ?? 0;
                        const skipped = h.skipped ?? h.Skipped ?? 0;
                        const failed = h.failed ?? h.Failed ?? 0;
                        const unreachable = h.unreachable ?? h.Unreachable ?? 0;
                        const bad = failed > 0 || unreachable > 0;
                        return (
                          <span
                            key={host || idx}
                            className={`rec-recap-chip${bad ? " bad" : ""}`}
                          >
                            <b>{host}</b>
                            <span>
                              ok={ok} changed={changed}
                              {skipped > 0 ? ` skipped=${skipped}` : ""}
                              {failed > 0 ? ` failed=${failed}` : ""}
                              {unreachable > 0 ? ` unreachable=${unreachable}` : ""}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {logOpen && hasLog && (
                    <EventLogPanel
                      jobId={jobId}
                      execution={e.execution!}
                      attempt={e.attempt!}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

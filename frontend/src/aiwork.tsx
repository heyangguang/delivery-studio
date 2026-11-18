import React, { useEffect, useState } from "react";
import {
  IconBook,
  IconBulb,
  IconCheck,
  IconClose,
  IconCode,
  IconDown,
  IconFile,
  IconFolder,
  IconLanguage,
  IconLink,
  IconList,
  IconSearch,
  IconStorage,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import { Markdown } from "./aimd";
import { bi, useLang } from "./i18n";
import "./aiwork.css";

/* How the assistant got to an answer, shown the way modern assistants do: one quiet line that says how long it worked
   and what it used, opening into a timeline of its thinking, the tools it called, the skills it read and the outside
   services it asked, each with what came back. */

export type Step = {
  kind:
    | "think"
    | "thought"
    | "tool"
    | "skill"
    | "mcp"
    | "web"
    | "kb"
    | "memory"
    | "sandbox";
  text?: string;
  id?: string;
  name?: string;
  args?: string;
  summary?: string;
  preview?: string;
  ms?: number;
  ok?: boolean;
  running?: boolean;
};

const jsonArgs = (args?: string): Record<string, unknown> => {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {};
  }
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const PHASE: Record<string, string> = {
  get prepare() {
    return bi("环境准备", "Environment setup");
  },
  get deploy() {
    return bi("部署", "Deploy");
  },
  get tests() {
    return bi("功能测试", "Functional tests");
  },
  get cleanup() {
    return bi("清理", "Cleanup");
  },
};

/** What a step says in a few words, the thing it touched, and an icon for it. */
export function stepLabel(st: Step): {
  verb: string;
  what: string;
  icon: React.ReactNode;
} {
  const a = jsonArgs(st.args);
  const where = str(a.delivery);
  if (st.name === "run_skill_script")
    return {
      verb: bi("运行技能脚本", "Run skill script"),
      what:
        [str(a.skill), str(a.script)].filter(Boolean).join("/") ||
        str(a.purpose),
      icon: <IconCode />,
    };
  if (st.kind === "skill")
    return { verb: bi("使用技能", "Use skill"), what: str(a.name), icon: <IconBook /> };
  if (st.name === "view_images")
    return {
      verb: bi("查看图片", "View images"),
      what:
        (jsonArgs(st.args).files as string[] | undefined)?.join(
          bi("、", ", "),
        ) || "",
      icon: <IconFile />,
    };
  if (st.name === "run_python")
    return {
      verb: bi("运行 Python", "Run Python"),
      what: str(a.purpose),
      icon: <IconCode />,
    };
  if (st.name === "run_shell")
    return {
      verb: bi("运行沙箱命令", "Run sandbox command"),
      what: str(a.purpose) || str(a.command).split(/\r?\n/)[0].slice(0, 60),
      icon: <IconCode />,
    };
  if (st.name === "save_memory")
    return { verb: bi("记住", "Save memory"), what: str(a.text), icon: <IconBulb /> };
  if (st.name === "search_knowledge")
    return {
      verb: bi("查知识库", "Search knowledge base"),
      what: str(a.query),
      icon: <IconStorage />,
    };
  if (st.name === "read_knowledge")
    return {
      verb: bi("读知识库资料", "Read knowledge doc"),
      what: str(a.id),
      icon: <IconStorage />,
    };
  if (st.name === "web_search")
    return {
      verb: bi("搜索网页", "Search web"),
      what: str(a.query),
      icon: <IconLanguage />,
    };
  if (st.name === "web_fetch")
    return {
      verb: bi("打开网页", "Fetch page"),
      what: str(a.url).replace(/^https?:\/\//, ""),
      icon: <IconLanguage />,
    };
  if (st.kind === "mcp") {
    const parts = (st.name || "").split("__");
    return {
      verb: bi("调用外部服务", "Call external service"),
      what: parts.slice(2).join("__") || st.name || "",
      icon: <IconLink />,
    };
  }
  switch (st.name) {
    case "delivery_info":
      return { verb: bi("查看交付概况", "View delivery overview"), what: where, icon: <IconFile /> };
    case "runbook":
      return {
        verb: bi("阅读执行手册", "Read runbook"),
        what: PHASE[str(a.phase)] || where,
        icon: <IconList />,
      };
    case "execution_record":
      return { verb: bi("查看执行记录", "View execution record"), what: where, icon: <IconList /> };
    case "list_files":
      return {
        verb: bi("浏览项目文件", "Browse project files"),
        what: str(a.prefix) || where,
        icon: <IconFolder />,
      };
    case "read_file":
      return {
        verb: bi("读取文件", "Read file"),
        what:
          str(a.path) +
          (a.offset
            ? bi(` · 从 ${a.offset} 字节`, ` · from byte ${a.offset}`)
            : ""),
        icon: <IconFile />,
      };
    case "list_deliveries":
      return { verb: bi("查看你的交付", "List deliveries"), what: "", icon: <IconSearch /> };
    case "component_guide":
      return {
        verb: bi("查阅设计指南", "Read design guide"),
        what: str(a.section)
          ? bi(`第 ${a.section} 节`, `Section ${a.section}`)
          : bi("目录", "Table of contents"),
        icon: <IconBook />,
      };
    case "list_components":
      return { verb: bi("查看现有组件", "List components"), what: "", icon: <IconSearch /> };
    case "example_component":
      return {
        verb: bi("参考组件", "Reference component"),
        what: [str(a.name), str(a.path)].filter(Boolean).join(" / "),
        icon: <IconFile />,
      };
    case "draft_files":
      return { verb: bi("查看草稿文件", "List draft files"), what: "", icon: <IconFolder /> };
    case "draft_read":
      return { verb: bi("读取草稿", "Read draft"), what: str(a.path), icon: <IconFile /> };
    case "run_check":
      return { verb: bi("运行平台检查", "Run platform check"), what: "", icon: <IconThunderbolt /> };
    case "propose_step":
      return { verb: bi("提交步骤提案", "Propose step"), what: str(a.title), icon: <IconCode /> };
    case "propose_change":
      return {
        verb: bi("提交修改提案", "Propose change"),
        what: str(a.target_title),
        icon: <IconCode />,
      };
    case "propose_file_change":
      return {
        verb: bi("提议修改自动化文件", "Propose automation file edit"),
        what: str(a.path),
        icon: <IconCode />,
      };
    case "suggest_component_change":
      return {
        verb: bi("建议改进组件", "Suggest component improvement"),
        what: [str(a.component), str(a.title)]
          .filter(Boolean)
          .join(bi("：", ": ")),
        icon: <IconCode />,
      };
    case "workspace_search":
      return { verb: bi("跨组件查找引用", "Search across components"), what: str(a.text), icon: <IconCode /> };
    case "component_files":
      return {
        verb: bi("读取关联组件", "Read related component"),
        what: [str(a.name), str(a.path)].filter(Boolean).join(" / "),
        icon: <IconCode />,
      };
    case "propose_component_files":
      return {
        verb: bi("提交关联组件提案", "Propose related component edits"),
        what: [str(a.name), str(a.summary)]
          .filter(Boolean)
          .join(bi("：", ": ")),
        icon: <IconCode />,
      };
    case "check_workspace":
      return { verb: bi("联合检查公共流程与组件", "Check shared workflows & components"), what: "", icon: <IconCode /> };
    case "platform_files":
      return {
        verb: bi("读取平台公共流程", "Read platform workflows"),
        what: str(a.path),
        icon: <IconCode />,
      };
    case "propose_platform_files":
      return {
        verb: bi("提出公共流程修改", "Propose workflow changes"),
        what: str(a.summary),
        icon: <IconCode />,
      };
    case "propose_files":
      return { verb: bi("提交改动提案", "Propose file changes"), what: str(a.summary), icon: <IconCode /> };
    case "read_form":
      return { verb: bi("读取表单", "Read form"), what: "", icon: <IconList /> };
    case "describe_component":
      return {
        verb: bi("查看组件", "Inspect component"),
        what: [str(a.name), str(a.version)].filter(Boolean).join(" "),
        icon: <IconBook />,
      };
    case "switch_form":
      return {
        verb: bi("切换部署组件", "Switch component"),
        what: str(a.target_component),
        icon: <IconCode />,
      };
    case "fill_form":
      return { verb: bi("填写表单", "Fill form"), what: str(a.summary), icon: <IconCode /> };
  }
  return { verb: st.name || bi("工具", "Tool"), what: "", icon: <IconCode /> };
}

export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return bi("不到 1 秒", "< 1s");
  if (s < 60) return bi(`${s} 秒`, `${s}s`);
  return bi(`${Math.floor(s / 60)} 分 ${s % 60} 秒`, `${Math.floor(s / 60)}m ${s % 60}s`);
}
const fmtMs = (ms?: number) =>
  !ms || ms < 50 ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

function Think({ st, live }: { st: Step; live?: boolean }) {
  useLang();
  const [open, setOpen] = useState(false);
  const long = (st.text || "").length > 260;
  if (!st.text && !live)
    // the model thought but does not show it: say that it did, and for how long
    return (
      <li className="wk-n k-think">
        <span className="wk-dot" aria-hidden>
          <IconBulb />
        </span>
        <div className="wk-body">
          <span className="wk-line quiet">
            <b>{bi("思考", "Thought")}</b>
            {st.ms ? <small>{fmtDur(st.ms)}</small> : null}
          </span>
        </div>
      </li>
    );
  return (
    <li className={`wk-n k-think ${live ? "live" : ""}`}>
      <span className="wk-dot" aria-hidden>
        <IconBulb />
      </span>
      <div className="wk-body">
        <button
          type="button"
          className="wk-line"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          disabled={!long && !live}
        >
          <b>{live ? bi("正在思考", "Thinking") : bi("思考", "Thought")}</b>
          {!live && st.ms ? <small>{fmtDur(st.ms)}</small> : null}
          {long && <IconDown className="wk-chev" />}
        </button>
        <div
          className={`wk-think ${open || live ? "open" : ""} ${live ? "live" : ""}`}
        >
          <Markdown text={st.text || ""} className={live ? "streaming" : ""} />
        </div>
      </div>
    </li>
  );
}

/** The call as a command line: the tool, then each argument. */
const cmdLine = (st: Step, args: Record<string, unknown>) =>
  [
    st.name || "tool",
    ...Object.entries(args).map(
      ([k, v]) =>
        `${k}=${typeof v === "string" ? (/\s/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v)}`,
    ),
  ].join(" ");

function Call({ st }: { st: Step }) {
  useLang();
  const [open, setOpen] = useState(false);
  const { verb, what, icon } = stepLabel(st);
  const args = jsonArgs(st.args);
  const hasDetail = Object.keys(args).length > 0 || !!st.preview;
  return (
    <li
      className={`wk-n k-${st.kind} ${st.running ? "run" : st.ok === false ? "bad" : ""}`}
    >
      <span className="wk-dot" aria-hidden>
        {st.running ? (
          <i className="wk-spin" />
        ) : st.ok === false ? (
          <IconClose />
        ) : (
          icon
        )}
      </span>
      <div className="wk-body">
        <button
          type="button"
          className="wk-line"
          onClick={() => hasDetail && setOpen(!open)}
          aria-expanded={hasDetail ? open : undefined}
          disabled={!hasDetail}
        >
          <b>{verb}</b>
          {st.kind === "mcp" && <span className="wk-tag">MCP</span>}
          {st.kind === "skill" && (
            <span className="wk-tag sk">{bi("技能", "Skill")}</span>
          )}
          {st.kind === "web" && (
            <span className="wk-tag web">{bi("联网", "Web")}</span>
          )}
          {st.kind === "kb" && (
            <span className="wk-tag kb">{bi("知识库", "KB")}</span>
          )}
          {st.kind === "memory" && (
            <span className="wk-tag kb">{bi("记忆", "Memory")}</span>
          )}
          {st.kind === "sandbox" && (
            <span className="wk-tag sk">{bi("沙箱", "Sandbox")}</span>
          )}
          {what && <code title={what}>{what}</code>}
          <span className="wk-meta">
            {st.summary && (
              <small className={st.ok === false ? "bad" : ""}>
                {st.summary}
              </small>
            )}
            {fmtMs(st.ms) && <small>{fmtMs(st.ms)}</small>}
          </span>
          {hasDetail && <IconDown className="wk-chev" />}
        </button>
        {open && (
          <div className="wk-detail">
            <div className="wk-term">
              <div className="wk-term-h">
                {st.kind === "sandbox"
                  ? bi("代码沙箱 · Python", "Code sandbox · Python")
                  : st.kind === "mcp"
                    ? bi("外部服务", "External service")
                    : st.kind === "web"
                      ? bi("联网", "Web")
                      : st.kind === "skill"
                        ? bi("技能", "Skill")
                        : st.kind === "kb"
                          ? bi("知识库", "Knowledge base")
                          : st.kind === "memory"
                            ? bi("记忆", "Memory")
                            : bi("查阅", "Inspect")}
              </div>
              {st.name === "run_python" ? (
                <pre className="wk-cmd code">{str(args.code)}</pre>
              ) : (
                <pre className="wk-cmd">
                  <span aria-hidden>$ </span>
                  {cmdLine(st, args)}
                </pre>
              )}
              {st.preview && <pre className="wk-out">{st.preview}</pre>}
              {!st.running && (
                <div className={`wk-term-f ${st.ok === false ? "bad" : ""}`}>
                  {st.ok === false ? <IconClose /> : <IconCheck />}{" "}
                  {st.ok === false
                    ? bi("失败", "Failed")
                    : bi("成功", "Succeeded")}
                  {fmtMs(st.ms) ? ` · ${fmtMs(st.ms)}` : ""}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

/** The assistant's work: a summary line, and under it each step. While it works the list stays open and the line says what it is doing. */
export function Process({
  steps,
  ms,
  live,
  t0,
  thinking,
}: {
  steps: Step[];
  ms?: number;
  live?: boolean;
  t0?: number;
  thinking?: string;
}) {
  useLang();
  const [open, setOpen] = useState<boolean | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [live]);
  const shown = open ?? !!live;
  if (!live && steps.length === 0) return null;
  const calls = steps.filter((s) => s.kind === "tool").length;
  const skills = steps.filter((s) => s.kind === "skill");
  const mcp = steps.filter((s) => s.kind === "mcp").length;
  const web = steps.filter((s) => s.kind === "web").length;
  const kb = steps.filter((s) => s.kind === "kb").length;
  const thinkMs = steps
    .filter((s) => s.kind === "think")
    .reduce((n, s) => n + (s.ms || 0), 0);
  const running = [...steps].reverse().find((s) => s.running);
  const doing = thinking
    ? bi("思考中", "Thinking")
    : running
      ? `${stepLabel(running).verb}${stepLabel(running).what ? " " + stepLabel(running).what : ""}`
      : bi("思考中", "Thinking");
  // with nothing to show yet (no thinking text, no tool), the line is only a status and cannot be opened
  const canOpen = steps.length > 0 || !!thinking;
  const Head = canOpen ? "button" : "div";
  return (
    <div
      className={`wk ${live ? "live" : ""} ${shown && canOpen ? "open" : ""}`}
    >
      <Head
        {...(canOpen
          ? {
              type: "button" as const,
              onClick: () => setOpen(!shown),
              "aria-expanded": shown,
            }
          : { role: "status" })}
        className={`wk-head ${canOpen ? "" : "plain"}`}
      >
        {live ? (
          <i className="wk-spin" aria-hidden />
        ) : (
          <IconCheck className="wk-ok" aria-hidden />
        )}
        {live ? (
          <span className="wk-doing">
            {doing}… <small>{fmtDur(now - (t0 || now))}</small>
          </span>
        ) : (
          <span>{bi(`已处理 ${fmtDur(ms || 0)}`, `Processed for ${fmtDur(ms || 0)}`)}</span>
        )}
        {!live && (
          <span className="wk-chips">
            {thinkMs > 0 && (
              <em>{bi(`思考 ${fmtDur(thinkMs)}`, `Thought ${fmtDur(thinkMs)}`)}</em>
            )}
            {calls > 0 && (
              <em>{bi(`查阅 ${calls} 次`, `${calls} checks`)}</em>
            )}
            {skills.length > 0 && (
              <em className="sk">
                {bi(`技能 ${skills.length}`, `Skills ${skills.length}`)}
              </em>
            )}
            {web > 0 && (
              <em className="web">{bi(`联网 ${web}`, `Web ${web}`)}</em>
            )}
            {kb > 0 && (
              <em className="kb">{bi(`知识库 ${kb}`, `KB ${kb}`)}</em>
            )}
            {mcp > 0 && <em className="mcp">MCP {mcp}</em>}
          </span>
        )}
        {canOpen && <IconDown className="wk-chev" aria-hidden />}
      </Head>
      <div className={`wk-fold ${shown && canOpen ? "open" : ""}`}>
        <div>
          <ol className="wk-list">
            {steps.map((st, i) =>
              st.kind === "think" ? (
                <Think key={i} st={st} />
              ) : st.kind === "thought" ? (
                <li key={i} className="wk-n k-said">
                  <span className="wk-dot" aria-hidden />
                  <div className="wk-body">
                    <Markdown text={st.text || ""} />
                  </div>
                </li>
              ) : (
                <Call key={st.id || i} st={st} />
              ),
            )}
            {live && thinking && (
              <Think st={{ kind: "think", text: thinking }} live />
            )}
          </ol>
        </div>
      </div>
    </div>
  );
}

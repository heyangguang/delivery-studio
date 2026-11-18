import React, { useEffect, useState } from "react";
import { Button, InputNumber, Message, Switch } from "@arco-design/web-react";
import {
  IconCheckCircleFill,
  IconCloseCircleFill,
} from "@arco-design/web-react/icon";
import { api, cached, err, putCached } from "./shared";
import { Segmented } from "./ui";
import { bi, biv, useLang } from "./i18n";
import "./storageview.css";
import "./sandboxview.css";

/* Settings → Code sandbox: lets the assistant run code & skill scripts in the platform's cross-platform isolated sandbox. */

type ExecPolicy = "ask" | "auto" | "open";
type NetPolicy = "deny" | "ask" | "allow";

type Check = { name: string; ok: boolean; note?: string };
type Settings = {
  enabled: boolean;
  seconds: number;
  memory_mb: number;
  procs: number;
  output_mb: number;
  exec_policy?: ExecPolicy;
  net_policy?: NetPolicy;
  checked_at?: string;
  passed: boolean;
  checks?: Check[];
  note?: string;
};
type Data = {
  settings: Settings;
  runtime_ok: boolean;
  runtime_error?: string;
  backend?: string;
  os?: string;
  runtime_source?: string;
  python_version?: string;
  packages?: string[];
};

const EXEC_OPTIONS: {
  value: ExecPolicy;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    value: "ask",
    get label() {
      return bi("每次询问 (Ask)", "Always Ask");
    },
    get hint() {
      return bi(
        "AI 每次执行 Python 代码、Shell 命令或技能脚本前，都在对话中展示代码与文件范围，由客户确认后才运行。",
        "Before running any Python code, shell command, or skill script, the AI displays the code and file scope in chat and waits for user confirmation.",
      );
    },
  },
  {
    value: "auto",
    get label() {
      return bi("智能分级 (Auto)", "Smart Tiered (Auto)");
    },
    get hint() {
      return bi(
        "平台已审校的只读计算与表格解析脚本直接隔离运行；任意 Shell/CLI 命令、个人自定义脚本、含网络或动态调用特征的代码自动弹窗询问客户。",
        "Platform-vetted read-only math and spreadsheet parsing scripts run directly in isolation; arbitrary shell/CLI commands, custom scripts, and code with network or dynamic calls prompt for approval.",
      );
    },
  },
  {
    value: "open",
    get label() {
      return bi("沙箱内开放 (Open)", "Open in Sandbox");
    },
    get hint() {
      return bi(
        "在隔离沙箱边界内允许 AI 直接运行计算、Shell 检查与文件生成脚本，无需逐次点击确认（仍受限于下方资源配额与文件隔离）。",
        "Allows the AI to run computation, shell checks, and file generation scripts inside the isolated sandbox without per-call confirmation (still subject to the resource quotas and file boundaries below).",
      );
    },
  },
];

const NET_OPTIONS: {
  value: NetPolicy;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    value: "deny",
    get label() {
      return bi("完全断网", "Offline Only");
    },
    get hint() {
      return bi(
        "所有沙箱代码与技能脚本均处于离线隔离状态，禁止任何外网或内网连接。",
        "All sandbox code and skill scripts run strictly offline with no external or internal network access.",
      );
    },
  },
  {
    value: "ask",
    get label() {
      return bi("按需询问授权", "Ask on Demand");
    },
    get hint() {
      return bi(
        "默认离线隔离；当脚本或代码确需联网时，在对话中说明原因并由客户点击授权（即便允许外网，本机回环与平台端口仍被封禁）。",
        "Offline by default; when a script requires network access, the reason is explained in chat for user approval (loopback and platform ports remain blocked even when approved).",
      );
    },
  },
  {
    value: "allow",
    get label() {
      return bi("允许外网", "Allow External");
    },
    get hint() {
      return bi(
        "声明需要外网的脚本可访问外部网络，但沙箱仍强制拦截宿主机回环地址（127.0.0.1 / ::1）与平台自身监听端口。",
        "Scripts declaring external access can reach public networks, while the sandbox still enforces blocking of host loopback addresses (127.0.0.1 / ::1) and platform ports.",
      );
    },
  },
];

export function SandboxView() {
  useLang();
  const initSandbox = cached<Data>("/api/settings/sandbox");
  const [d, setD] = useState<Data | null>(() => initSandbox ?? null);
  const [f, setF] = useState<Settings | null>(
    () => initSandbox?.settings ?? null,
  );
  const [busy, setBusy] = useState("");
  const load = () =>
    api<Data>("/api/settings/sandbox")
      .then((r) => {
        putCached("/api/settings/sandbox", r);
        setD(r);
        setF(r.settings);
      })
      .catch(err);
  useEffect(() => {
    load();
  }, []);
  const check = async () => {
    setBusy("check");
    try {
      const r = await api<Data>("/api/settings/sandbox/check", {
        method: "POST",
      });
      setF((x) =>
        x
          ? {
              ...x,
              ...r.settings,
              seconds: x.seconds,
              memory_mb: x.memory_mb,
              procs: x.procs,
              output_mb: x.output_mb,
              exec_policy: x.exec_policy ?? r.settings.exec_policy,
              net_policy: x.net_policy ?? r.settings.net_policy,
            }
          : r.settings,
      );
      setD((x) => {
        const next = x ? { ...x, ...r, settings: r.settings } : r;
        putCached("/api/settings/sandbox", next);
        return next;
      });
      Message[r.settings.passed ? "success" : "warning"](
        r.settings.passed
          ? bi("所有安全自检均已通过", "All security self-checks passed")
          : bi("有安全检查未通过", "Some security checks failed"),
      );
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };
  const save = async (next: Settings) => {
    setBusy("save");
    try {
      const r = await api<{ settings: Settings }>("/api/settings/sandbox", {
        method: "PUT",
        body: JSON.stringify(next),
      });
      setD((x) => {
        const merged = x ? { ...x, settings: r.settings } : x;
        if (merged) putCached("/api/settings/sandbox", merged);
        return merged;
      });
      setF(r.settings);
      Message.success(bi("已保存", "Saved"));
    } catch (e) {
      err(e);
      load();
    } finally {
      setBusy("");
    }
  };
  const s = d?.settings;
  const curExec: ExecPolicy = f?.exec_policy || "auto";
  const curNet: NetPolicy = f?.net_policy || "ask";
  const savedExec: ExecPolicy = s?.exec_policy || "auto";
  const savedNet: NetPolicy = s?.net_policy || "ask";
  const dirty =
    !!s &&
    !!f &&
    (f.seconds !== s.seconds ||
      f.memory_mb !== s.memory_mb ||
      f.procs !== s.procs ||
      f.output_mb !== s.output_mb ||
      curExec !== savedExec ||
      curNet !== savedNet);
  const num = (
    k: "seconds" | "memory_mb" | "procs" | "output_mb",
    v: number | undefined,
  ) => f && setF({ ...f, [k]: Number(v) || 0 });
  return (
    <article className="sx-page st-main enter">
      <header className="sx-page-h">
        <div>
          <h1>{bi("代码沙箱", "Code Sandbox")}</h1>
          <p>
            {bi(
              "AI 编写的 Python 代码与「技能」挂载的随附脚本共用这一套平台内置跨平台隔离沙箱（自动适配 Linux / Windows / macOS），用于精确统计表格、解析快照日志、生成 Word 或图表，并在权限与网络受控下运行。",
              "AI-generated Python code and Skill scripts share this built-in cross-platform isolated sandbox (Linux / Windows / macOS) for accurate table aggregation, log parsing, and Word/chart generation under controlled permissions and networking.",
            )}
          </p>
        </div>
        <Button
          type="primary"
          loading={busy === "save"}
          disabled={!dirty}
          onClick={() => f && save(f)}
        >
          {bi("保存", "Save")}
        </Button>
      </header>
      {!d && <div className="st-skel" aria-label={bi("载入中", "Loading")} />}
      {d && f && (
        <>
          <section className="sx-sec">
            <div className="sb-on">
              <div>
                <div className="sb-title-row">
                  <h2>
                    {bi(
                      "允许 AI 运行代码与技能脚本",
                      "Allow AI to run code & skill scripts",
                    )}
                  </h2>
                  {d.backend && <span className="sb-badge">{d.backend}</span>}
                  {d.python_version && (
                    <span className="sb-badge mono">
                      Python {d.python_version}
                    </span>
                  )}
                </div>
                <p className={`small ${!d.runtime_ok ? "bad" : "faint"}`}>
                  {!d.runtime_ok
                    ? d.runtime_error ||
                      bi(
                        "未检测到可用的 Python 3 运行环境，可点击右侧「检测」重新探测",
                        "No usable Python 3 runtime detected; click “Check” on the right to probe again",
                      )
                    : s?.passed
                      ? bi(
                          `上次安全自检通过（${s.checked_at}）`,
                          `Last self-check passed (${s.checked_at})`,
                        )
                      : s?.checked_at
                        ? bi(
                            `上次安全自检未通过（${s.checked_at}），修复后可点击「检测」重试`,
                            `Last self-check failed (${s.checked_at}); fix issues and click “Check” to retry`,
                          )
                        : bi(
                            "首次启用前，请先点击右侧「检测」完成全部沙箱隔离自检",
                            "Before enabling for the first time, click “Check” on the right to pass all isolation self-checks",
                          )}
                </p>
              </div>
              <Button
                loading={busy === "check"}
                disabled={busy !== "" && busy !== "check"}
                onClick={check}
              >
                {bi("检测", "Check")}
              </Button>
              <Switch
                checked={s!.enabled}
                disabled={!s!.passed || busy !== ""}
                onChange={(v) => save({ ...f, enabled: v })}
                aria-label={bi("允许 AI 运行代码", "Allow AI to run code")}
              />
            </div>
            {s?.note && <p className="sb-note">{s.note}</p>}
            {(s?.checks || []).length > 0 && (
              <ul
                className="sb-checks"
                aria-label={bi("检测结果", "Check results")}
              >
                {s!.checks!.map((c) => (
                  <li key={c.name} className={c.ok ? "ok" : "bad"}>
                    {c.ok ? <IconCheckCircleFill /> : <IconCloseCircleFill />}
                    <span>{c.name}</span>
                    {c.note && <small>{c.note}</small>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="sx-sec">
            <h2>
              {bi(
                "执行权限与网络授权策略",
                "Execution & Network Authorization Policy",
              )}
            </h2>
            <div className="sb-policies">
              <div className="sb-pol">
                <div className="sb-pol-h">
                  <b>{bi("执行权限模式", "Execution Mode")}</b>
                  <Segmented<ExecPolicy>
                    size="sm"
                    label={bi("执行权限模式", "Execution mode")}
                    value={curExec}
                    onChange={(v) => setF({ ...f, exec_policy: v })}
                    options={EXEC_OPTIONS.map((o) => ({
                      value: o.value,
                      label: o.label,
                    }))}
                  />
                </div>
                <p className="sb-pol-hint">
                  {EXEC_OPTIONS.find((o) => o.value === curExec)?.hint}
                </p>
              </div>
              <div className="sb-pol">
                <div className="sb-pol-h">
                  <b>{bi("沙箱网络访问", "Sandbox Network")}</b>
                  <Segmented<NetPolicy>
                    size="sm"
                    label={bi("沙箱网络访问", "Sandbox network")}
                    value={curNet}
                    onChange={(v) => setF({ ...f, net_policy: v })}
                    options={NET_OPTIONS.map((o) => ({
                      value: o.value,
                      label: o.label,
                    }))}
                  />
                </div>
                <p className="sb-pol-hint">
                  {NET_OPTIONS.find((o) => o.value === curNet)?.hint}
                </p>
              </div>
            </div>
          </section>
          <section className="sx-sec">
            <h2>{bi("每次运行的上限", "Per-Run Resource Limits")}</h2>
            <div className="sv-fields">
              <label>
                <span>{bi("运行时间", "Timeout")}</span>
                <InputNumber
                  min={5}
                  max={1800}
                  precision={0}
                  value={f.seconds}
                  onChange={(v) => num("seconds", v)}
                  suffix={bi("秒", "sec")}
                  aria-label={bi("运行时间", "Timeout")}
                />
              </label>
              <label>
                <span>{bi("内存", "Memory")}</span>
                <InputNumber
                  min={256}
                  max={65536}
                  precision={0}
                  value={f.memory_mb}
                  onChange={(v) => num("memory_mb", v)}
                  suffix="MB"
                  aria-label={bi("内存", "Memory")}
                />
              </label>
              <label>
                <span>{bi("进程数", "Processes")}</span>
                <InputNumber
                  min={8}
                  max={1024}
                  precision={0}
                  value={f.procs}
                  onChange={(v) => num("procs", v)}
                  aria-label={bi("进程数", "Processes")}
                />
              </label>
              <label>
                <span>{bi("生成文件的总大小", "Total Output Size")}</span>
                <InputNumber
                  min={1}
                  max={10240}
                  precision={0}
                  value={f.output_mb}
                  onChange={(v) => num("output_mb", v)}
                  suffix="MB"
                  aria-label={bi("生成文件的总大小", "Total output size")}
                />
              </label>
            </div>
          </section>
          <section className="sx-sec">
            <h2>{bi("安全隔离边界", "Isolation & Security Boundaries")}</h2>
            <ul className="sb-rules">
              <li>
                {biv(
                  <>
                    <b>统一沙箱引擎</b>：AI 临时编写的{" "}
                    <code className="mono">run_python</code>、命令行工具{" "}
                    <code className="mono">run_shell</code> 与技能随附的{" "}
                    <code className="mono">run_skill_script</code>{" "}
                    共用同一套跨平台隔离引擎（Linux 内核命名空间 + Seccomp、macOS
                    Seatbelt、Windows Job Object + UI 隔离；Python 模式额外启用
                    PEP-578 审计钩子）。
                  </>,
                  <>
                    <b>Unified Sandbox Engine</b>:{" "}
                    <code className="mono">run_python</code>,{" "}
                    <code className="mono">run_shell</code>, and{" "}
                    <code className="mono">run_skill_script</code> share the same
                    cross-platform isolation engine (Linux namespaces + Seccomp,
                    macOS Seatbelt, Windows Job Object + UI isolation; Python mode
                    also enables PEP-578 audit hooks).
                  </>,
                )}
              </li>
              <li>
                {biv(
                  <>
                    <b>严格文件与只读工作区边界</b>
                    ：默认只能读取提问者本人在对话中传入的文件（
                    <code className="mono">/in</code>
                    ）；仅在交付排障或组件工作台对话中按需将当前工程只读暴露为{" "}
                    <code className="mono">/workspace</code>
                    （自动剔除密钥/凭据且始终不可写）；输出写入{" "}
                    <code className="mono">/out</code> 并自动存入「我的资料 / AI
                    生成」。
                  </>,
                  <>
                    <b>Strict File & Read-Only Workspace Scope</b>: By default,
                    only files attached by the current user in chat (
                    <code className="mono">/in</code>) are readable; during
                    delivery troubleshooting or Component Workbench sessions, the
                    active project is exposed read-only at{" "}
                    <code className="mono">/workspace</code> (credentials stripped,
                    always immutable). Outputs go to{" "}
                    <code className="mono">/out</code> and are saved under My
                    Files / AI Generated.
                  </>,
                )}
              </li>
              <li>
                {biv(
                  <>
                    <b>受控网络保护</b>
                    ：默认无网络运行；即便客户授权某次联网，沙箱仍强制拦截宿主机回环地址（127.0.0.1
                    / ::1）与平台管理端口，防止 SSRF 探测内部服务。
                  </>,
                  <>
                    <b>Controlled Network Guard</b>: Network is disabled by
                    default; even when a run is authorized for outbound access,
                    host loopback addresses (127.0.0.1 / ::1) and platform ports
                    remain strictly blocked to prevent SSRF.
                  </>,
                )}
              </li>
              <li>
                {bi(
                  "每次运行都在全新临时目录中启动，超时或超出内存/进程数上限会被立即强制终止并记入审计日志。",
                  "Each run starts in a fresh temporary directory; exceeding timeout, memory, or process limits terminates it immediately and records an audit event.",
                )}
              </li>
              {(d.packages || []).length > 0 && (
                <li>
                  {bi(
                    `预置可用的 Python 库：${d.packages!.join("、")}`,
                    `Pre-installed Python packages: ${d.packages!.join(", ")}`,
                  )}
                </li>
              )}
            </ul>
          </section>
        </>
      )}
    </article>
  );
}

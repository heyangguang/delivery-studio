import React, { useEffect, useState } from "react";
import {
  Button,
  Input,
  InputNumber,
  Message,
  Switch,
} from "@arco-design/web-react";
import {
  IconCheck,
  IconCheckCircleFill,
  IconCloseCircleFill,
  IconDown,
  IconEye,
  IconLock,
  IconSafe,
  IconStop,
  IconThunderbolt,
  IconUp,
  IconWifi,
} from "@arco-design/web-react/icon";
import { api, cached, err, putCached } from "./shared";
import { bi, biv, useLang } from "./i18n";
import "./storageview.css";
import "./sandboxview.css";

/* Settings → Code sandbox: lets the assistant run code & skill scripts in the platform's cross-platform isolated sandbox. */

type ExecPolicy = "ask" | "auto" | "open";
type NetPolicy = "deny" | "ask" | "auto" | "allow";

type Check = { name: string; ok: boolean; note?: string };
type Settings = {
  enabled: boolean;
  seconds: number;
  memory_mb: number;
  procs: number;
  output_mb: number;
  exec_policy?: ExecPolicy;
  net_policy?: NetPolicy;
  net_allow_domains?: string[];
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
  builtin_net_domains?: string[];
};

const parseDomainList = (text: string): string[] =>
  text
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const EXEC_OPTIONS: {
  value: ExecPolicy;
  icon: React.ReactNode;
  tone: "warn" | "brand" | "ok";
  badge?: () => string;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    value: "ask",
    icon: <IconEye />,
    tone: "warn",
    get label() {
      return bi("每次询问", "Request Review");
    },
    get hint() {
      return bi(
        "每次执行 Python、Shell 命令或技能脚本前，均展示代码与文件范围并等待用户确认。",
        "Show code and file scope and wait for confirmation before every run.",
      );
    },
  },
  {
    value: "auto",
    icon: <IconSafe />,
    tone: "brand",
    badge: () => bi("推荐", "Recommended"),
    get label() {
      return bi("智能分级", "Smart Auto");
    },
    get hint() {
      return bi(
        "纯离线计算、表格解析与内置脚本直接隔离运行；Shell 命令、个人脚本与高危调用弹窗确认。",
        "Safe offline computation runs directly; shell commands, personal scripts, and risky calls prompt.",
      );
    },
  },
  {
    value: "open",
    icon: <IconThunderbolt />,
    tone: "ok",
    get label() {
      return bi("沙箱内开放", "Open in Sandbox");
    },
    get hint() {
      return bi(
        "在隔离沙箱与资源配额边界内直接运行，不逐次弹窗确认（终端用户可在对话中随时自由切换）。",
        "Run directly inside the isolated sandbox without per-call prompts (users can freely switch modes in chat).",
      );
    },
  },
];

const NET_OPTIONS: {
  value: NetPolicy;
  icon: React.ReactNode;
  tone: "mute" | "warn" | "brand" | "ok";
  badge?: () => string;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    value: "deny",
    icon: <IconStop />,
    tone: "mute",
    get label() {
      return bi("完全断网", "Offline Only");
    },
    get hint() {
      return bi(
        "彻底禁止沙箱内的一切外网与内网连接，所有代码与脚本严格离线执行。",
        "Disable all outbound and internal networking; strictly offline execution.",
      );
    },
  },
  {
    value: "ask",
    icon: <IconLock />,
    tone: "warn",
    get label() {
      return bi("每次询问", "Always Ask");
    },
    get hint() {
      return bi(
        "默认离线；只要脚本或代码请求联网，就在对话中说明用途并由用户点击授权。",
        "Offline by default; every network request prompts the user with its purpose.",
      );
    },
  },
  {
    value: "auto",
    icon: <IconSafe />,
    tone: "brand",
    badge: () => bi("推荐", "Recommended"),
    get label() {
      return bi("智能审批", "Smart Auto");
    },
    get hint() {
      return bi(
        "未挂载文件且仅对可信只读域名发起 HTTPS GET 时自动放行并加运行时只读锁；涉及文件出网、未知域名、写入或 Shell 仍弹窗。",
        "Auto-approves read-only HTTPS GET to trusted domains with no mounted files (enforced at runtime); prompts on files, unknown hosts, writes, or shell.",
      );
    },
  },
  {
    value: "allow",
    icon: <IconWifi />,
    tone: "ok",
    get label() {
      return bi("允许外网", "Allow External");
    },
    get hint() {
      return bi(
        "声明需要外网的脚本可直接访问外部公网，无需逐次审批（本机回环与平台端口仍封禁）。",
        "Scripts declaring network access reach public endpoints without prompts (loopback & platform ports stay blocked).",
      );
    },
  },
];

export function SandboxView() {
  const lang = useLang();
  const initSandbox = cached<Data>("/api/settings/sandbox");
  const [d, setD] = useState<Data | null>(() => initSandbox ?? null);
  const [f, setF] = useState<Settings | null>(
    () => initSandbox?.settings ?? null,
  );
  const [domainsText, setDomainsText] = useState(
    () => (initSandbox?.settings?.net_allow_domains || []).join("\n"),
  );
  const [showBuiltin, setShowBuiltin] = useState(false);
  const [busy, setBusy] = useState("");
  const load = () =>
    api<Data>("/api/settings/sandbox")
      .then((r) => {
        putCached("/api/settings/sandbox", r);
        setD(r);
        setF(r.settings);
        setDomainsText((r.settings.net_allow_domains || []).join("\n"));
      })
      .catch(err);
  useEffect(() => {
    load();
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
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
              net_allow_domains:
                x.net_allow_domains ?? r.settings.net_allow_domains,
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
      const payload: Settings = {
        ...next,
        net_allow_domains: parseDomainList(domainsText),
      };
      const r = await api<{
        settings: Settings;
        builtin_net_domains?: string[];
      }>("/api/settings/sandbox", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setD((x) => {
        const merged = x
          ? {
              ...x,
              settings: r.settings,
              builtin_net_domains:
                r.builtin_net_domains ?? x.builtin_net_domains,
            }
          : x;
        if (merged) putCached("/api/settings/sandbox", merged);
        return merged;
      });
      setF(r.settings);
      setDomainsText((r.settings.net_allow_domains || []).join("\n"));
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
  const savedDomainsStr = (s?.net_allow_domains || []).join("\n");
  const curDomainsStr = parseDomainList(domainsText).join("\n");
  const dirty =
    !!s &&
    !!f &&
    (f.seconds !== s.seconds ||
      f.memory_mb !== s.memory_mb ||
      f.procs !== s.procs ||
      f.output_mb !== s.output_mb ||
      curExec !== savedExec ||
      curNet !== savedNet ||
      curDomainsStr !== savedDomainsStr);
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
            <div className="sb-pol-groups">
              {/* Group 1: Default Execution Policy */}
              <div className="sb-pol-group">
                <div className="sb-pol-gh">
                  <b>{bi("默认执行权限", "Default Execution Permission")}</b>
                  <span>
                    {bi(
                      "新对话默认使用的执行模式；终端用户可在对话底部「沙箱权限」中自由切换，个人选择优先于平台默认",
                      "Default execution mode for chats; end-users can freely override it in the chat permission picker",
                    )}
                  </span>
                </div>
                <div
                  className="sb-opt-grid cols-3"
                  role="radiogroup"
                  aria-label={bi("执行权限模式", "Execution mode")}
                >
                  {EXEC_OPTIONS.map((o) => {
                    const active = curExec === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`sb-opt-card ${active ? "on" : ""}`}
                        onClick={() => setF({ ...f, exec_policy: o.value })}
                      >
                        <div className="sb-opt-top">
                          <span className={`sb-opt-ic t-${o.tone}`}>
                            {o.icon}
                          </span>
                          <div className="sb-opt-name">
                            <b>{o.label}</b>
                            {o.badge && (
                              <em className="sb-opt-badge">{o.badge()}</em>
                            )}
                          </div>
                          <span
                            className={`sb-opt-radio ${active ? "on" : ""}`}
                            aria-hidden
                          >
                            {active && <IconCheck />}
                          </span>
                        </div>
                        <p className="sb-opt-desc">{o.hint}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Group 2: Sandbox Network Policy */}
              <div className="sb-pol-group">
                <div className="sb-pol-gh">
                  <b>{bi("沙箱网络访问", "Sandbox Network Access")}</b>
                  <span>
                    {bi(
                      "宿主机回环（127.0.0.1 / ::1）与平台端口在所有模式下均强制封禁",
                      "Host loopback (127.0.0.1 / ::1) and platform ports stay blocked in every mode",
                    )}
                  </span>
                </div>
                <div
                  className="sb-opt-grid cols-2"
                  role="radiogroup"
                  aria-label={bi("沙箱网络访问", "Sandbox network")}
                >
                  {NET_OPTIONS.map((o) => {
                    const active = curNet === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`sb-opt-card ${active ? "on" : ""}`}
                        onClick={() => setF({ ...f, net_policy: o.value })}
                      >
                        <div className="sb-opt-top">
                          <span className={`sb-opt-ic t-${o.tone}`}>
                            {o.icon}
                          </span>
                          <div className="sb-opt-name">
                            <b>{o.label}</b>
                            {o.badge && (
                              <em className="sb-opt-badge">{o.badge()}</em>
                            )}
                          </div>
                          <span
                            className={`sb-opt-radio ${active ? "on" : ""}`}
                            aria-hidden
                          >
                            {active && <IconCheck />}
                          </span>
                        </div>
                        <p className="sb-opt-desc">{o.hint}</p>
                      </button>
                    );
                  })}
                </div>

                {curNet === "auto" && (
                  <div className="sb-net-auto">
                    <div className="sb-net-auto-head">
                      <div>
                        <b>
                          {bi(
                            "智能审批可信只读域名白名单",
                            "Trusted Read-Only Domain Allowlist",
                          )}
                        </b>
                        <p>
                          {bi(
                            `已内置 ${(d.builtin_net_domains || []).length} 个公共技术、软件包与安全公告域名（PyPI / OSV / NVD / GitHub / Ansible / Docker Hub / 主流中间件与系统官方源）`,
                            `${(d.builtin_net_domains || []).length} built-in public package, docs, and advisory domains (PyPI / OSV / NVD / GitHub / Ansible / Docker Hub / middleware & OS advisories)`,
                          )}
                        </p>
                      </div>
                      {(d.builtin_net_domains || []).length > 0 && (
                        <button
                          type="button"
                          className="sb-domain-toggle"
                          onClick={() => setShowBuiltin((v) => !v)}
                        >
                          {showBuiltin ? (
                            <>
                              <IconUp />
                              {bi("收起内置清单", "Hide built-in")}
                            </>
                          ) : (
                            <>
                              <IconDown />
                              {bi(
                                `查看 ${(d.builtin_net_domains || []).length} 个内置域名`,
                                `View ${(d.builtin_net_domains || []).length} built-in`,
                              )}
                            </>
                          )}
                        </button>
                      )}
                    </div>
                    {showBuiltin && (d.builtin_net_domains || []).length > 0 && (
                      <div className="sb-domain-chips">
                        {d.builtin_net_domains!.map((dom) => (
                          <code key={dom} className="mono">
                            {dom}
                          </code>
                        ))}
                      </div>
                    )}
                    <div className="sb-domain-field">
                      <label htmlFor="sb-net-domains">
                        {bi(
                          "企业补充只读白名单域名（可选）",
                          "Additional enterprise read-only domains (optional)",
                        )}
                      </label>
                      <Input.TextArea
                        id="sb-net-domains"
                        autoSize={{ minRows: 2, maxRows: 5 }}
                        value={domainsText}
                        onChange={setDomainsText}
                        placeholder={bi(
                          "每行或逗号分隔，支持精确域名与子域通配，如：\npypi.corp.example.com\n*.mirrors.internal.net",
                          "One per line or comma-separated (exact or *.suffix), e.g.:\npypi.corp.example.com\n*.mirrors.internal.net",
                        )}
                      />
                      <small>
                        {bi(
                          "仅用于无文件挂载的只读 HTTPS GET 自动放行；本机回环与平台端口始终封禁，点击右上角「保存」后生效。",
                          "Used only for auto-approving read-only HTTPS GET without mounted files; loopback and platform ports remain blocked. Click Save to apply.",
                        )}
                      </small>
                    </div>
                  </div>
                )}
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

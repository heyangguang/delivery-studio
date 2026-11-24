import { useEffect, useId, useRef, useState } from "react";
import { Button, Checkbox, Dropdown, Input, Menu, Tooltip } from "@arco-design/web-react";
import { api, setAuthToken, setCsrf, useConnectivity, type Session } from "./shared";
import { BrandMark, Smooth } from "./ui";
import { AIEmblem, Spark } from "./aichat";
import { useI18n } from "./i18n";
import "./login.css";

type LoginVersionInfo = {
  version: string;
  date?: string;
  released_at?: string;
  title?: string;
} | null;

type ThemePref = "light" | "dark" | "system";

type LoginThemeControl = {
  dark: boolean;
  pref: ThemePref;
  choose: (p: ThemePref) => void;
};

type Phase = "idle" | "verifying" | "entering";

const REMEMBER_KEY = "mh-login-remember";

const reduceMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

type AskItem = {
  tag: string;
  ask: string;
  hint: string;
};

/* rolling showcase of real Kyndryl Delivery Studio AI workflows */
const ASKS: (AskItem & { tagEn: string; askEn: string; hintEn: string })[] = [
  {
    tag: "沙箱排障",
    tagEn: "Sandbox Debug",
    ask: "帮我排查 PostgreSQL 主从复制延迟原因",
    askEn: "Diagnose PostgreSQL replication lag",
    hint: "只读挂载 $MW_WORKSPACE，定位 WAL 重放滞后并生成调优建议",
    hintEn: "Mounts $MW_WORKSPACE read-only to isolate WAL replay lag and propose tuning",
  },
  {
    tag: "变更预审",
    tagEn: "Change Review",
    ask: "这次参数变更会影响哪些集群节点？",
    askEn: "Which cluster nodes are impacted by this parameter change?",
    hint: "比对参数基线与拓扑角色，预演滚动变更范围后待人工确认",
    hintEn: "Compares parameter baselines and topology roles for rolling rehearsal before sign-off",
  },
  {
    tag: "离线闭包",
    tagEn: "Offline Bundle",
    ask: "生成信创 ARM64 集群的离线安装包",
    askEn: "Build offline package bundle for ARM64 cluster",
    hint: "联动本地软件库校验 RPM 与系统依赖，自动匹配完整离线闭包",
    hintEn: "Resolves full RPM & system dependency closures against the local package library",
  },
  {
    tag: "基线核验",
    tagEn: "Baseline Check",
    ask: "检查目标机器的端口占用与内核参数",
    askEn: "Verify port availability and kernel sysctls on targets",
    hint: "并行扫描执行环境基线项，标出冲突端口与系统调优缺口",
    hintEn: "Scans execution baselines in parallel to highlight port conflicts and sysctl gaps",
  },
  {
    tag: "交付手册",
    tagEn: "Runbook Draft",
    ask: "基于本次执行证据起草标准实施手册",
    askEn: "Draft enterprise delivery handbook from run evidence",
    hint: "汇总脱敏拓扑、配置清单与多机验收回执，输出标准 Word 文档",
    hintEn: "Compiles redacted topology, configs, and host verification results into a .docx manual",
  },
];

const Svg = ({ children, size = 16 }: { children: React.ReactNode; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);
const IcArrow = () => (
  <Svg>
    <path d="M2.5 8h11M9.5 4l4 4-4 4" />
  </Svg>
);
const IcCheck = () => (
  <Svg>
    <path d="m3.5 8.5 3 3 6-7" />
  </Svg>
);
const IcSend = () => (
  <Svg size={14}>
    <path d="M2.5 8 13.5 2.5 10 13.5 8 9 2.5 8Z" />
    <path d="M8 9 13.5 2.5" />
  </Svg>
);
const IcLock = () => (
  <Svg size={12}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.4" />
    <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
  </Svg>
);
const IcAlert = () => (
  <Svg size={14}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 5v3.4M8 10.8v.1" />
  </Svg>
);
const IcGlobe = () => (
  <Svg size={14}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2.3 8h11.4M8 2c1.8 1.9 1.8 10.1 0 12M8 2c-1.8 1.9-1.8 10.1 0 12" />
  </Svg>
);
const IcTheme = ({ pref, dark }: { pref: ThemePref; dark: boolean }) =>
  pref === "system" ? (
    <Svg size={14}>
      <rect x="2" y="3" width="12" height="8.5" rx="1.5" />
      <path d="M6 14h4" />
    </Svg>
  ) : dark ? (
    <Svg size={14}>
      <path d="M12.9 9.9a5.2 5.2 0 0 1-6.8-6.8 5.4 5.4 0 1 0 6.8 6.8Z" />
    </Svg>
  ) : (
    <Svg size={14}>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" />
    </Svg>
  );

function PanelArt() {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <div className="ib-geo" aria-hidden="true">
      {/* top-left whisper-quiet corner arc for diagonal poise */}
      <svg className="ib-art ib-art-tl" viewBox="0 0 220 220" fill="none">
        <defs>
          <linearGradient id={`tl-${uid}`} x1="0" y1="0" x2="180" y2="180" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--brand)" stopOpacity="0.14" />
            <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M0 164A164 164 0 0 0 164 0" stroke="currentColor" strokeOpacity="0.08" />
        <path d="M0 112A112 112 0 0 0 112 0" fill={`url(#tl-${uid})`} stroke="var(--brand)" strokeOpacity="0.14" />
        <rect x="64" y="64" width="10" height="10" rx="2.5" transform="rotate(45 69 69)" fill="var(--brand)" fillOpacity="0.28" />
      </svg>

      {/* top-right Kyndryl Delivery Studio orbital prism cluster */}
      <svg className="ib-art ib-art-tr" viewBox="0 0 460 360" fill="none">
        <defs>
          <radialGradient id={`tr-glow-${uid}`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(382 62) rotate(135) scale(310)">
            <stop offset="0" stopColor="var(--brand)" stopOpacity="0.22" />
            <stop offset="0.55" stopColor="#29707a" stopOpacity="0.08" />
            <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`tr-plate-${uid}`} x1="255" y1="24" x2="415" y2="184" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ff462d" stopOpacity="0.24" />
            <stop offset="1" stopColor="#1d1c1a" stopOpacity="0.08" />
          </linearGradient>
          <linearGradient id={`tr-core-${uid}`} x1="312" y1="90" x2="346" y2="124" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.52" stopColor="#ff7a59" />
            <stop offset="1" stopColor="#ff462d" />
          </linearGradient>
        </defs>

        <circle cx="382" cy="62" r="280" fill={`url(#tr-glow-${uid})`} />
        <circle cx="382" cy="62" r="268" stroke="currentColor" strokeOpacity="0.065" />
        <circle cx="382" cy="62" r="204" stroke="var(--brand)" strokeOpacity="0.16" strokeDasharray="5 7" />
        <circle cx="382" cy="62" r="138" stroke="currentColor" strokeOpacity="0.1" />
        <circle cx="382" cy="62" r="78" stroke="var(--brand)" strokeOpacity="0.2" />

        {/* layered chamfered prism cards */}
        <g className="ib-art-float">
          <rect
            x="278"
            y="38"
            width="126"
            height="126"
            rx="24"
            transform="rotate(45 341 101)"
            fill={`url(#tr-plate-${uid})`}
            stroke="var(--brand)"
            strokeOpacity="0.24"
          />
          <rect
            x="301"
            y="61"
            width="80"
            height="80"
            rx="16"
            transform="rotate(45 341 101)"
            fill="var(--ib-prism-inner)"
            stroke="var(--ib-prism-rim)"
          />
          <rect
            x="329"
            y="89"
            width="24"
            height="24"
            rx="5.5"
            transform="rotate(45 341 101)"
            fill={`url(#tr-core-${uid})`}
          />
        </g>

        {/* cluster nodes resting cleanly on orbital paths */}
        <circle cx="212" cy="176" r="5" fill="var(--brand)" fillOpacity="0.52" />
        <circle cx="212" cy="176" r="10" stroke="var(--brand)" strokeOpacity="0.22" />
        <rect x="319" y="253" width="10" height="10" rx="2.5" transform="rotate(45 324 258)" fill="#29707a" fillOpacity="0.7" />
        <circle cx="418" cy="195" r="4" fill="#147a4b" fillOpacity="0.8" />
      </svg>

      {/* bottom-right architectural stepped strata & node trace */}
      <svg className="ib-art ib-art-br" viewBox="0 0 540 320" fill="none">
        <defs>
          <linearGradient id={`br-1-${uid}`} x1="120" y1="320" x2="540" y2="90" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--brand)" stopOpacity="0.04" />
            <stop offset="1" stopColor="var(--brand)" stopOpacity="0.16" />
          </linearGradient>
          <linearGradient id={`br-2-${uid}`} x1="220" y1="320" x2="540" y2="150" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#1f5e66" stopOpacity="0.06" />
            <stop offset="1" stopColor="#29707a" stopOpacity="0.2" />
          </linearGradient>
          <linearGradient id={`br-3-${uid}`} x1="340" y1="320" x2="540" y2="210" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#1d1c1a" stopOpacity="0.12" />
            <stop offset="1" stopColor="#ff462d" stopOpacity="0.24" />
          </linearGradient>
        </defs>

        <path
          d="M64 320C146 226 294 168 540 124V320H64Z"
          fill={`url(#br-1-${uid})`}
          stroke="var(--brand)"
          strokeOpacity="0.13"
        />
        <path
          d="M172 320C248 238 368 192 540 162V320H172Z"
          fill={`url(#br-2-${uid})`}
          stroke="var(--brand)"
          strokeOpacity="0.18"
        />
        <path
          d="M286 320C346 256 426 222 540 202V320H286Z"
          fill={`url(#br-3-${uid})`}
          stroke="var(--ib-prism-rim)"
        />

        {/* minimal cluster status nodes anchored on strata crest */}
        <path d="M326 218Q416 184 504 170" stroke="var(--brand)" strokeOpacity="0.32" strokeDasharray="3 5" />
        <rect x="321" y="213" width="10" height="10" rx="2.5" fill="var(--brand)" fillOpacity="0.48" />
        <rect x="408" y="182" width="12" height="12" rx="3" transform="rotate(45 414 188)" fill="#29707a" fillOpacity="0.72" />
        <circle cx="496" cy="172" r="4.5" fill="#147a4b" />
        <circle cx="496" cy="172" r="9.5" stroke="#147a4b" strokeOpacity="0.28" />
      </svg>
    </div>
  );
}

function IntroPanel() {
  const { bi } = useI18n();
  const [slot, setSlot] = useState({ cur: 0, prev: -1 });
  const [paused, setPaused] = useState(false);

  const select = (next: number) => {
    setSlot((s) => (s.cur === next ? s : { cur: next, prev: s.cur }));
  };

  useEffect(() => {
    if (reduceMotion() || paused) return;
    const t = window.setTimeout(() => {
      setSlot((s) => ({ cur: (s.cur + 1) % ASKS.length, prev: s.cur }));
    }, 3400);
    return () => window.clearTimeout(t);
  }, [slot.cur, paused]);

  const { cur, prev } = slot;
  const n = ASKS.length;

  return (
    <aside className="ib-panel" aria-label={bi("AI 交付工作台介绍", "AI Delivery Workbench Overview")}>
      <PanelArt />

      <div
        className="ib-ask"
        aria-hidden="true"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div className="ib-ask-eyebrow">
          <AIEmblem size={20} />
          <span>
            <b className="ib-eyebrow-k">Kyndryl</b> Delivery Studio AI
          </span>
          <em>{bi("隔离沙箱 · 只读诊断", "Isolated Sandbox · Read-Only")}</em>
        </div>

        <div className="ib-ask-box">
          <span className="ib-ask-spark">
            <Spark size={15} rainbow />
          </span>
          <div className="ib-ask-viewport">
            {ASKS.map((item, idx) => {
              const cls =
                idx === cur ? "is-cur" : idx === prev ? "is-prev" : "is-idle";
              return (
                <div key={idx} className={`ib-ask-row ${cls}`}>
                  <span className="ib-ask-pill">{bi(item.tag, item.tagEn)}</span>
                  <span className="ib-ask-text">
                    <span className="ib-ask-str">{bi(item.ask, item.askEn)}</span>
                    <i className="ib-caret" />
                  </span>
                </div>
              );
            })}
          </div>
          <span className="ib-ask-send">
            <IcSend />
          </span>
        </div>

        <div className="ib-ask-hint">
          <i />
          <div className="ib-hint-viewport">
            {ASKS.map((item, idx) => {
              const cls =
                idx === cur ? "is-cur" : idx === prev ? "is-prev" : "is-idle";
              return (
                <span key={idx} className={`ib-hint-row ${cls}`}>
                  {bi(item.hint, item.hintEn)}
                </span>
              );
            })}
          </div>
        </div>

        <ul className="ib-ask-more">
          {ASKS.map((item, idx) => {
            const pos = (idx - cur + n) % n;
            return (
              <li key={idx} className={`ib-more-slot is-pos-${pos}`}>
                <button
                  type="button"
                  tabIndex={-1}
                  className="ib-more-btn"
                  onClick={() => select(idx)}
                >
                  <span className="ib-more-tag">{bi(item.tag, item.tagEn)}</span>
                  <span className="ib-more-ask">{bi(item.ask, item.askEn)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="ib-caption" aria-hidden="true">
        <b>{bi("AI 交付助手", "AI Delivery Assistant")}</b>
        <span>
          {bi(
            "在隔离沙箱中排障、预审变更与起草交付手册，所有写入操作均需人工核准",
            "Troubleshoot, rehearse changes, and draft handbooks inside isolated sandboxes with human approval",
          )}
        </span>
      </div>
    </aside>
  );
}

export function Login({
  done,
  versionInfo,
  theme,
}: {
  done: (s: Session) => void;
  versionInfo?: LoginVersionInfo;
  theme?: LoginThemeControl;
}) {
  const { lang, setLang, bi } = useI18n();
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(REMEMBER_KEY) || "";
    } catch {
      return "";
    }
  });
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<{ field: "name" | "pw"; text: string } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [shaking, setShaking] = useState(false);
  const [probing, setProbing] = useState(false);
  const [remember, setRemember] = useState(() => {
    try {
      return Boolean(localStorage.getItem(REMEMBER_KEY));
    } catch {
      return false;
    }
  });
  const [capsOn, setCapsOn] = useState(false);

  const nameRef = useRef<any>(null);
  const pwRef = useRef<any>(null);
  const conn = useConnectivity();
  const busy = phase !== "idle";

  const domValue = (ref: any, field: string) => {
    const el =
      (ref?.current?.dom as HTMLInputElement | undefined) ??
      document.querySelector<HTMLInputElement>(`input[name="${field}"]`);
    return el?.value ?? "";
  };

  useEffect(() => {
    const t = window.requestAnimationFrame(() => (name ? pwRef : nameRef).current?.focus?.());
    const sync = window.setTimeout(() => {
      const n = domValue(nameRef, "username");
      const p = domValue(pwRef, "password");
      if (n) setName((cur) => cur || n);
      if (p) setPw((cur) => cur || p);
    }, 200);
    return () => {
      window.cancelAnimationFrame(t);
      window.clearTimeout(sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fail = (field: "name" | "pw", text: string) => {
    setErr({ field, text });
    setShaking(false);
    window.requestAnimationFrame(() => setShaking(true));
    (field === "name" ? nameRef : pwRef).current?.focus?.();
  };

  const retry = async () => {
    if (probing) return;
    setProbing(true);
    try {
      await api("/api/version", { cache: "no-store" });
    } catch {
      /* connectivity state updates itself */
    } finally {
      setProbing(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const u = (domValue(nameRef, "username") || name).trim();
    const p = domValue(pwRef, "password") || pw;
    if (!u) return fail("name", bi("请输入账号", "Please enter username"));
    if (!p) return fail("pw", bi("请输入密码", "Please enter password"));
    setErr(null);
    setPhase("verifying");
    try {
      const s = await api<Session>("/api/login", {
        method: "POST",
        body: JSON.stringify({ username: u, password: p }),
      });
      try {
        if (remember) localStorage.setItem(REMEMBER_KEY, u);
        else localStorage.removeItem(REMEMBER_KEY);
      } catch {
        /* storage unavailable */
      }
      setAuthToken(s.access_token);
      setCsrf(s.csrf);
      setPhase("entering");
      window.setTimeout(() => done(s), reduceMotion() ? 0 : 480);
    } catch (ex) {
      setPhase("idle");
      setPw("");
      fail("pw", (ex as Error).message || bi("账号或密码不正确", "Incorrect username or password"));
    }
  };

  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  const host = typeof window !== "undefined" ? window.location.host : "";
  const themeLabel =
    theme?.pref === "system"
      ? bi("跟随系统", "System")
      : theme?.dark
        ? bi("深色", "Dark")
        : bi("浅色", "Light");
  const d = (n: number) => ({ "--d": n }) as React.CSSProperties;

  return (
    <div className={`ib-root${phase === "entering" ? " is-leaving" : ""}`}>
      <header className="ib-top">
        <span className="ib-brand">
          <BrandMark size={22} />
          <span className="brand-word">
            <span className="brand-k">kyndryl</span>
            <span className="brand-sep" aria-hidden />
            <span className="brand-prod">Delivery Studio</span>
          </span>
        </span>
        <div className="ib-top-right">
          {conn === "online" ? (
            <span className="ib-top-item ib-ver">
              <i className="ib-dot" />
              {versionInfo?.version ? `v${versionInfo.version}` : bi("服务在线", "Online")}
            </span>
          ) : (
            <button type="button" className="ib-top-item is-bad" onClick={retry} disabled={probing}>
              <i className="ib-dot" />
              {probing
                ? bi("正在检测…", "Checking…")
                : conn === "offline"
                  ? bi("网络已断开 · 重试", "Offline · Retry")
                  : bi("服务不可达 · 重试", "Unreachable · Retry")}
            </button>
          )}
          <Dropdown
            position="br"
            trigger="click"
            droplist={
              <Menu selectedKeys={[lang]} onClickMenuItem={(k) => setLang(k as "zh-CN" | "en-US")}>
                <Menu.Item key="zh-CN">简体中文</Menu.Item>
                <Menu.Item key="en-US">English</Menu.Item>
              </Menu>
            }
          >
            <button
              type="button"
              className="ib-top-item"
              aria-label={bi("切换语言", "Switch language")}
            >
              <IcGlobe />
              {lang === "en-US" ? "English" : "简体中文"}
            </button>
          </Dropdown>
          {theme && (
            <Dropdown
              position="br"
              trigger="click"
              droplist={
                <Menu selectedKeys={[theme.pref]} onClickMenuItem={(k) => theme.choose(k as ThemePref)}>
                  <Menu.Item key="system">{bi("跟随系统", "System")}</Menu.Item>
                  <Menu.Item key="light">{bi("浅色", "Light")}</Menu.Item>
                  <Menu.Item key="dark">{bi("深色", "Dark")}</Menu.Item>
                </Menu>
              }
            >
              <button type="button" className="ib-top-item" aria-label={bi(`外观：${themeLabel}`, `Theme: ${themeLabel}`)}>
                <IcTheme pref={theme.pref} dark={theme.dark} />
                {themeLabel}
              </button>
            </Dropdown>
          )}
        </div>
      </header>

      <div className="ib-body">
        <main className="ib-left">
          <div
            className={`ib-col${shaking ? " is-shaking" : ""}`}
            onAnimationEnd={(e) => {
              if (e.animationName === "ib-shake") setShaking(false);
            }}
          >
            <div className="ib-logo ib-in" style={d(0)}>
              <BrandMark size={40} />
            </div>
            <h1 className="ib-title ib-in" style={d(1)}>
              {bi("登录", "Sign in to")}{" "}
              <span className="ib-title-k">Kyndryl</span>{" "}
              <b>Delivery Studio</b>
            </h1>
            <p className="ib-sub ib-in" style={d(2)}>
              {bi(
                "还没有账号？请联系平台管理员开通",
                "Don't have an account? Contact your platform administrator",
              )}
            </p>

            {conn !== "online" && (
              <div className="ib-banner" role="alert">
                <IcAlert />
                <span>
                  {conn === "offline"
                    ? bi("网络已断开，恢复后即可登录", "Network disconnected; sign in once reconnected")
                    : bi("暂时无法连接到平台服务", "Unable to reach the platform service")}
                </span>
                <button type="button" onClick={retry} disabled={probing}>
                  {probing ? bi("正在重试…", "Retrying…") : bi("重试", "Retry")}
                </button>
              </div>
            )}

            <form className="ib-form" onSubmit={submit} noValidate>
              <div className="ib-field ib-in" style={d(3)}>
                <label htmlFor="ib-username">{bi("账号", "Username")}</label>
                <Input
                  ref={nameRef}
                  id="ib-username"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={bi("用户名", "Enter username")}
                  value={name}
                  disabled={phase === "entering"}
                  error={err?.field === "name"}
                  aria-invalid={err?.field === "name"}
                  aria-describedby={err?.field === "name" ? "ib-err" : undefined}
                  onChange={(v) => {
                    setName(v);
                    if (err) setErr(null);
                  }}
                />
              </div>

              <div className="ib-field ib-in" style={d(4)}>
                <label htmlFor="ib-password">{bi("密码", "Password")}</label>
                <Input.Password
                  ref={pwRef}
                  id="ib-password"
                  name="password"
                  autoComplete="current-password"
                  placeholder={bi("密码", "Enter password")}
                  value={pw}
                  disabled={phase === "entering"}
                  error={err?.field === "pw"}
                  aria-invalid={err?.field === "pw"}
                  aria-describedby={err ? "ib-err" : capsOn ? "ib-caps" : undefined}
                  onKeyDown={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
                  onKeyUp={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
                  onBlur={() => setCapsOn(false)}
                  onChange={(v) => {
                    setPw(v);
                    if (err) setErr(null);
                  }}
                />
                <Smooth>
                  {err ? (
                    <span className="ib-msg is-error" id="ib-err" role="alert">
                      <IcAlert />
                      {err.text}
                    </span>
                  ) : capsOn ? (
                    <span className="ib-msg is-warn" id="ib-caps" role="status">
                      <IcAlert />
                      {bi("大写锁定已开启", "Caps Lock is on")}
                    </span>
                  ) : null}
                </Smooth>
              </div>

              <Button
                type="primary"
                htmlType="submit"
                long
                className={`ib-submit ib-in${phase === "entering" ? " is-done" : ""}`}
                style={d(5)}
                loading={phase === "verifying"}
                disabled={conn === "offline"}
              >
                <span>
                  {phase === "entering"
                    ? bi("已验证", "Verified")
                    : phase === "verifying"
                      ? bi("正在验证", "Signing in")
                      : bi("登录", "Sign in")}
                </span>
                {phase !== "verifying" && (
                  <span className="ib-submit-ic">{phase === "entering" ? <IcCheck /> : <IcArrow />}</span>
                )}
              </Button>
            </form>

            <div className="ib-after ib-in" style={d(6)}>
              <Tooltip
                position="right"
                content={bi(
                  "请联系平台管理员在「IAM → 用户」中重置密码",
                  "Ask your platform administrator to reset your password in IAM -> Users",
                )}
              >
                <button type="button" className="ib-link">
                  {bi("忘记密码？", "Forgot password?")}
                </button>
              </Tooltip>
              <Checkbox checked={remember} onChange={setRemember}>
                {bi("记住账号", "Remember username")}
              </Checkbox>
            </div>

            <div className="ib-meta ib-in" style={d(7)}>
              <Tooltip
                content={bi(
                  secure ? "连接已加密" : "当前未加密，建议使用 https:// 地址访问",
                  secure ? "Encrypted TLS connection" : "Unencrypted connection; HTTPS is recommended",
                )}
              >
                <span className={`ib-host${secure ? "" : " is-plain"}`}>
                  <IcLock />
                  {host}
                </span>
              </Tooltip>
              <span>
                {bi(
                  "会话有效期 8 小时，登录与关键操作记入审计日志",
                  "Sessions expire after 8h · Sign-ins & actions are audited",
                )}
              </span>
            </div>
          </div>

          <footer className="ib-foot">
            © {new Date().getFullYear()} Kyndryl Delivery Studio · {bi("仅限授权人员访问", "Authorized Access Only")}
          </footer>
        </main>

        <IntroPanel />
      </div>
    </div>
  );
}

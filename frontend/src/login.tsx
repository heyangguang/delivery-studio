import { useEffect, useId, useRef, useState } from "react";
import { Button, Checkbox, Dropdown, Input, Menu, Tooltip } from "@arco-design/web-react";
import { api, setAuthToken, setCsrf, useConnectivity, type Session } from "./shared";
import { BrandMark, Smooth } from "./ui";
import { AIEmblem, Spark } from "./aichat";
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

/* rolling showcase of real Middleware Hub AI workflows */
const ASKS: AskItem[] = [
  {
    tag: "沙箱排障",
    ask: "帮我排查 PostgreSQL 主从复制延迟原因",
    hint: "只读挂载 $MW_WORKSPACE，定位 WAL 重放滞后并生成调优建议",
  },
  {
    tag: "变更预审",
    ask: "这次参数变更会影响哪些集群节点？",
    hint: "比对参数基线与拓扑角色，预演滚动变更范围后待人工确认",
  },
  {
    tag: "离线闭包",
    ask: "生成信创 ARM64 集群的离线安装包",
    hint: "联动本地软件库校验 RPM 与系统依赖，自动匹配完整离线闭包",
  },
  {
    tag: "基线核验",
    ask: "检查目标机器的端口占用与内核参数",
    hint: "并行扫描执行环境基线项，标出冲突端口与系统调优缺口",
  },
  {
    tag: "交付手册",
    ask: "基于本次执行证据起草标准实施手册",
    hint: "汇总脱敏拓扑、配置清单与多机验收回执，输出标准 Word 文档",
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

      {/* top-right Middleware Hub orbital prism cluster */}
      <svg className="ib-art ib-art-tr" viewBox="0 0 460 360" fill="none">
        <defs>
          <radialGradient id={`tr-glow-${uid}`} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(382 62) rotate(135) scale(310)">
            <stop offset="0" stopColor="var(--brand)" stopOpacity="0.22" />
            <stop offset="0.55" stopColor="#38bdf8" stopOpacity="0.07" />
            <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`tr-plate-${uid}`} x1="255" y1="24" x2="415" y2="184" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#6366f1" stopOpacity="0.28" />
            <stop offset="1" stopColor="#282670" stopOpacity="0.08" />
          </linearGradient>
          <linearGradient id={`tr-core-${uid}`} x1="312" y1="90" x2="346" y2="124" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.52" stopColor="#38bdf8" />
            <stop offset="1" stopColor="#5856d6" />
          </linearGradient>
        </defs>

        <circle cx="382" cy="62" r="280" fill={`url(#tr-glow-${uid})`} />
        <circle cx="382" cy="62" r="268" stroke="currentColor" strokeOpacity="0.065" />
        <circle cx="382" cy="62" r="204" stroke="var(--brand)" strokeOpacity="0.14" strokeDasharray="5 7" />
        <circle cx="382" cy="62" r="138" stroke="currentColor" strokeOpacity="0.1" />
        <circle cx="382" cy="62" r="78" stroke="var(--brand)" strokeOpacity="0.18" />

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
        <circle cx="212" cy="176" r="5" fill="var(--brand)" fillOpacity="0.48" />
        <circle cx="212" cy="176" r="10" stroke="var(--brand)" strokeOpacity="0.2" />
        <rect x="319" y="253" width="10" height="10" rx="2.5" transform="rotate(45 324 258)" fill="#38bdf8" fillOpacity="0.65" />
        <circle cx="418" cy="195" r="4" fill="#3ddc84" fillOpacity="0.75" />
      </svg>

      {/* bottom-right architectural stepped strata & node trace */}
      <svg className="ib-art ib-art-br" viewBox="0 0 540 320" fill="none">
        <defs>
          <linearGradient id={`br-1-${uid}`} x1="120" y1="320" x2="540" y2="90" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--brand)" stopOpacity="0.04" />
            <stop offset="1" stopColor="var(--brand)" stopOpacity="0.16" />
          </linearGradient>
          <linearGradient id={`br-2-${uid}`} x1="220" y1="320" x2="540" y2="150" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#312e81" stopOpacity="0.06" />
            <stop offset="1" stopColor="#4f46e5" stopOpacity="0.22" />
          </linearGradient>
          <linearGradient id={`br-3-${uid}`} x1="340" y1="320" x2="540" y2="210" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#1e1b4b" stopOpacity="0.12" />
            <stop offset="1" stopColor="#4338ca" stopOpacity="0.32" />
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
        <rect x="321" y="213" width="10" height="10" rx="2.5" fill="var(--brand)" fillOpacity="0.42" />
        <rect x="408" y="182" width="12" height="12" rx="3" transform="rotate(45 414 188)" fill="#38bdf8" fillOpacity="0.72" />
        <circle cx="496" cy="172" r="4.5" fill="#3ddc84" />
        <circle cx="496" cy="172" r="9.5" stroke="#3ddc84" strokeOpacity="0.28" />
      </svg>
    </div>
  );
}

function IntroPanel() {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduceMotion()) return;
    const t = window.setTimeout(() => setI((n) => (n + 1) % ASKS.length), 2400);
    return () => window.clearTimeout(t);
  }, [i]);

  const cur = ASKS[i];
  const rest = [1, 2, 3].map((k) => ({
    idx: (i + k) % ASKS.length,
    ...ASKS[(i + k) % ASKS.length],
  }));

  return (
    <aside className="ib-panel" aria-label="AI 交付工作台介绍">
      <PanelArt />

      <div className="ib-ask" aria-hidden="true">
        <div className="ib-ask-eyebrow">
          <AIEmblem size={20} />
          <span>Middleware Hub AI</span>
          <em>隔离沙箱 · 只读诊断</em>
        </div>

        <div className="ib-ask-box">
          <span className="ib-ask-spark">
            <Spark size={15} rainbow />
          </span>
          <span className="ib-ask-pill" key={`tag-${i}`}>
            {cur.tag}
          </span>
          <span className="ib-ask-text" key={`txt-${i}`}>
            {cur.ask}
            <i className="ib-caret" />
          </span>
          <span className="ib-ask-send">
            <IcSend />
          </span>
        </div>

        <div className="ib-ask-hint" key={`hint-${i}`}>
          <i />
          <span>{cur.hint}</span>
        </div>

        <ul className="ib-ask-more" key={`more-${i}`}>
          {rest.map((item) => (
            <li key={item.idx}>
              <button
                type="button"
                tabIndex={-1}
                className="ib-more-btn"
                onClick={() => setI(item.idx)}
              >
                <span className="ib-more-tag">{item.tag}</span>
                <span className="ib-more-ask">{item.ask}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="ib-caption" aria-hidden="true">
        <b>AI 交付助手</b>
        <span>在隔离沙箱中排障、预审变更与起草交付手册，所有写入操作均需人工核准</span>
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
    if (!u) return fail("name", "请输入账号");
    if (!p) return fail("pw", "请输入密码");
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
      fail("pw", (ex as Error).message || "账号或密码不正确");
    }
  };

  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  const host = typeof window !== "undefined" ? window.location.host : "";
  const themeLabel = theme?.pref === "system" ? "跟随系统" : theme?.dark ? "深色" : "浅色";
  const d = (n: number) => ({ "--d": n }) as React.CSSProperties;

  return (
    <div className={`ib-root${phase === "entering" ? " is-leaving" : ""}`}>
      <header className="ib-top">
        <span className="ib-brand">
          Middleware <b>Hub</b>
        </span>
        <div className="ib-top-right">
          {conn === "online" ? (
            <span className="ib-top-item ib-ver">
              <i className="ib-dot" />
              {versionInfo?.version ? `v${versionInfo.version}` : "服务在线"}
            </span>
          ) : (
            <button type="button" className="ib-top-item is-bad" onClick={retry} disabled={probing}>
              <i className="ib-dot" />
              {probing ? "正在检测…" : conn === "offline" ? "网络已断开 · 重试" : "服务不可达 · 重试"}
            </button>
          )}
          {theme && (
            <Dropdown
              position="br"
              trigger="click"
              droplist={
                <Menu selectedKeys={[theme.pref]} onClickMenuItem={(k) => theme.choose(k as ThemePref)}>
                  <Menu.Item key="system">跟随系统</Menu.Item>
                  <Menu.Item key="light">浅色</Menu.Item>
                  <Menu.Item key="dark">深色</Menu.Item>
                </Menu>
              }
            >
              <button type="button" className="ib-top-item" aria-label={`外观：${themeLabel}`}>
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
              登录 Middleware <b>Hub</b>
            </h1>
            <p className="ib-sub ib-in" style={d(2)}>
              还没有账号？请联系平台管理员开通
            </p>

            {conn !== "online" && (
              <div className="ib-banner" role="alert">
                <IcAlert />
                <span>{conn === "offline" ? "网络已断开，恢复后即可登录" : "暂时无法连接到平台服务"}</span>
                <button type="button" onClick={retry} disabled={probing}>
                  {probing ? "正在重试…" : "重试"}
                </button>
              </div>
            )}

            <form className="ib-form" onSubmit={submit} noValidate>
              <div className="ib-field ib-in" style={d(3)}>
                <label htmlFor="ib-username">账号</label>
                <Input
                  ref={nameRef}
                  id="ib-username"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="用户名"
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
                <label htmlFor="ib-password">密码</label>
                <Input.Password
                  ref={pwRef}
                  id="ib-password"
                  name="password"
                  autoComplete="current-password"
                  placeholder="密码"
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
                      大写锁定已开启
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
                <span>{phase === "entering" ? "已验证" : phase === "verifying" ? "正在验证" : "登录"}</span>
                {phase !== "verifying" && (
                  <span className="ib-submit-ic">{phase === "entering" ? <IcCheck /> : <IcArrow />}</span>
                )}
              </Button>
            </form>

            <div className="ib-after ib-in" style={d(6)}>
              <Tooltip position="right" content="请联系平台管理员在「IAM → 用户」中重置密码">
                <button type="button" className="ib-link">
                  忘记密码？
                </button>
              </Tooltip>
              <Checkbox checked={remember} onChange={setRemember}>
                记住账号
              </Checkbox>
            </div>

            <div className="ib-meta ib-in" style={d(7)}>
              <Tooltip content={secure ? "连接已加密" : "当前未加密，建议使用 https:// 地址访问"}>
                <span className={`ib-host${secure ? "" : " is-plain"}`}>
                  <IcLock />
                  {host}
                </span>
              </Tooltip>
              <span>会话有效期 8 小时，登录与关键操作记入审计日志</span>
            </div>
          </div>

          <footer className="ib-foot">© {new Date().getFullYear()} Middleware Hub · 仅限授权人员访问</footer>
        </main>

        <IntroPanel />
      </div>
    </div>
  );
}

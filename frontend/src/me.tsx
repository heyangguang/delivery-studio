import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Message,
  Popconfirm,
  Skeleton,
} from "@arco-design/web-react";
import {
  IconBook,
  IconCheckCircleFill,
  IconCloseCircleFill,
  IconCodeSquare,
  IconDesktop,
  IconDown,
  IconHistory,
  IconLink,
  IconLock,
  IconMobile,
  IconPoweroff,
  IconRefresh,
  IconRight,
  IconSafe,
  IconStorage,
  IconUp,
  IconUser,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  cached,
  can,
  err,
  formatDuration,
  fullTime,
  planPhase,
  planTitle,
  PLAN_PHASE,
  putCached,
  stamp,
  useAIStatus,
  useConnectivity,
} from "./shared";
import type { Outcome, Session } from "./shared";
import { go } from "./router";
import { auditText, browser, deviceKind, SESSION_REASON } from "./audit";
import type { AuditSessionRow } from "./audit";
import { Avatar } from "./accounts";
import { EffectivePerms, roleTitle } from "./iam";
import type { Perm } from "./iam";
import { bi, getLang, useLang } from "./i18n";
import "./me.css";

/* My account: profile overview, personal AI resources, active sessions, password management, and sign-in history. */

type Me = {
  access?: { perms: Perm[]; scope: string; roles: string[]; teams: string[] };
  username: string;
  role: string;
  skills: number;
  mcp: number;
  kb: number;
  user_mcp: boolean;
  ai: boolean;
};
type Activity = {
  events: {
    time: string;
    action: string;
    job: string;
    ip?: string;
    method?: string;
    duration_sec?: number;
    session_id?: string;
    resource?: { type: string; id?: string; name?: string };
  }[];
  ai: { calls: number; in: number; out: number; cost: number };
  currency: string;
  jobs: {
    id: string;
    cluster_id: string;
    app_name: string;
    version: string;
    state: string;
    outcome?: Outcome;
    created: string;
    delivery_mode?: "offline" | "automatic" | "configuration";
  }[];
};

const SECTIONS = [
  {
    id: "",
    get title() {
      return bi("概览", "Overview");
    },
    icon: <IconUser />,
  },
  {
    id: "security",
    get title() {
      return bi("登录与安全", "Sign-in & Security");
    },
    icon: <IconLock />,
  },
];

export function MePage({
  me,
  section = "",
}: {
  me: Session;
  section?: string;
}) {
  const lang = useLang();
  const aiStatus = useAIStatus();
  const [info, setInfo] = useState<Me | null>(
    () => cached<Me>("/api/me") ?? null,
  );
  const [act, setAct] = useState<Activity | null>(
    () => cached<Activity>("/api/me/activity") ?? null,
  );
  const tabs = useRef<HTMLDivElement>(null);
  const focusRafRef = useRef<number | null>(null);
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  const [barReady, setBarReady] = useState(false);
  const cur = SECTIONS.some((s) => s.id === section) ? section : "";
  useEffect(
    () => () => {
      if (focusRafRef.current !== null) cancelAnimationFrame(focusRafRef.current);
    },
    [],
  );
  useEffect(() => {
    let live = true;
    api<Me>("/api/me")
      .then((r) => {
        if (!live) return;
        putCached("/api/me", r);
        setInfo(r);
      })
      .catch((e) => {
        if (live) err(e);
      });
    api<Activity>("/api/me/activity")
      .then((r) => {
        if (!live) return;
        putCached("/api/me/activity", r);
        setAct(r);
      })
      .catch(() => {
        if (!live) return;
        setAct((prev) =>
          prev ?? {
            events: [],
            ai: { calls: 0, in: 0, out: 0, cost: 0 },
            currency: "CNY",
            jobs: [],
          },
        );
      });
    return () => {
      live = false;
    };
  }, [lang]);
  useLayoutEffect(() => {
    const host = tabs.current;
    if (!host) return;
    const measure = () => {
      const el = host.querySelector<HTMLElement>(`[data-k="${cur}"]`);
      const next = el ? { x: el.offsetLeft, w: el.offsetWidth } : null;
      setBar((prev) => {
        if (!next) return prev === null ? prev : null;
        if (prev && prev.x === next.x && prev.w === next.w) return prev;
        return next;
      });
    };
    measure();
    const raf = requestAnimationFrame(measure);
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(host);
    host.querySelectorAll<HTMLElement>('button[role="tab"]').forEach((btn) => {
      ro?.observe(btn);
    });
    window.addEventListener("resize", measure);
    let cancelled = false;
    document.fonts?.ready
      ?.then(() => {
        if (!cancelled) measure();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [cur, info, lang]);
  useEffect(() => {
    if (!bar || barReady) return;
    const raf = requestAnimationFrame(() => setBarReady(true));
    return () => cancelAnimationFrame(raf);
  }, [bar, barReady]);
  const open = (id: string) =>
    go({ name: "me", id: id || undefined }, { replace: true });

  return (
    <div className="me-page">
      <section className="me-banner">
        <header className="me-hero">
          <Avatar name={me.username} role={me.role} size={58} />
          <div className="me-who">
            <div className="me-name-row">
              <h1>{me.username}</h1>
              {(info?.access?.roles || []).map((r) => (
                <span key={r} className="me-chip role">
                  {roleTitle({ name: r })}
                </span>
              ))}
              {(info?.access?.teams || []).map((t) => (
                <span key={t} className="me-chip team">
                  {t}
                </span>
              ))}
            </div>
            {act && (
              <p className="me-facts-inline">
                <span>
                  {act.jobs.length
                    ? bi(
                        `${act.jobs.length} 份交付`,
                        `${act.jobs.length} ${act.jobs.length === 1 ? "delivery" : "deliveries"}`,
                      )
                    : bi("还没有交付", "No deliveries yet")}
                </span>
                {aiStatus.enabled && act.ai.calls > 0 && (
                  <>
                    <i aria-hidden>·</i>
                    <span>
                      {bi(
                        `本月问了 AI ${act.ai.calls} 次`,
                        `${act.ai.calls} AI ${act.ai.calls === 1 ? "query" : "queries"} this month`,
                      )}
                    </span>
                  </>
                )}
              </p>
            )}
          </div>
          <span className="me-hero-acts">
            {cur !== "security" && (
              <Button icon={<IconLock />} onClick={() => open("security")}>
                {bi("登录与安全", "Security")}
              </Button>
            )}
            {can("iam.user|iam.role|iam.team|audit.view") && (
              <Button onClick={() => go({ name: "accounts" })}>
                IAM <IconRight />
              </Button>
            )}
          </span>
        </header>
        <div
          className="me-tabs"
          role="tablist"
          aria-label={bi("我的账户", "My Account")}
          ref={tabs}
          onKeyDown={(e) => {
            const i = SECTIONS.findIndex((s) => s.id === cur);
            const d =
              e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const next = SECTIONS[(i + d + SECTIONS.length) % SECTIONS.length];
            open(next.id);
            if (focusRafRef.current !== null) {
              cancelAnimationFrame(focusRafRef.current);
            }
            focusRafRef.current = requestAnimationFrame(() => {
              tabs.current
                ?.querySelector<HTMLElement>(`[data-k="${next.id}"]`)
                ?.focus();
            });
          }}
        >
          {bar && (
            <span
              className={`me-tabs-bar${barReady ? " ready" : ""}`}
              style={{ transform: `translate3d(${bar.x}px, 0, 0)`, width: bar.w }}
              aria-hidden
            />
          )}
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              data-k={s.id}
              aria-selected={cur === s.id}
              tabIndex={cur === s.id ? 0 : -1}
              className={cur === s.id ? "on" : ""}
              onClick={() => open(s.id)}
            >
              {s.icon}
              {s.title}
            </button>
          ))}
        </div>
      </section>
      <div className="me-body" key={cur}>
        {cur === "" && <Overview info={info} act={act} />}
        {cur === "security" && <SecurityView me={me} act={act} />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- overview */

function Overview({ info, act }: { info: Me | null; act: Activity | null }) {
  useLang();
  const aiStatus = useAIStatus();
  const cost = act
    ? `${act.currency === "USD" ? "$" : "¥"}${act.ai.cost >= 1 ? act.ai.cost.toFixed(2) : act.ai.cost.toFixed(4)}`
    : "—";
  const clusters = useMemo(
    () =>
      (act?.jobs || [])
        .filter(
          (j, i, all) =>
            all.findIndex((x) => x.cluster_id === j.cluster_id) === i,
        )
        .slice(0, 6),
    [act?.jobs],
  );
  const res = [
    {
      to: { name: "kb", id: "~my" } as const,
      icon: <IconStorage />,
      k: "k-doc",
      title: bi("我的资料", "My Files"),
      n: info?.kb,
      unit: (n: number) => bi(`${n} 份`, `${n} ${n === 1 ? "item" : "items"}`),
      empty: bi(
        "现场资料、网络规划、过往问题",
        "Site docs, network plans & past issues",
      ),
    },
    {
      to: { name: "skills" } as const,
      icon: <IconBook />,
      k: "k-built",
      title: bi("我的技能", "My Skills"),
      n: info?.skills,
      unit: (n: number) => bi(`${n} 个`, `${n} ${n === 1 ? "skill" : "skills"}`),
      empty: bi("写给 AI 照着做的手册", "Playbooks for the AI assistant"),
    },
    {
      to: { name: "mcp" } as const,
      icon: <IconLink />,
      k: "k-mcp",
      title: bi("我的 MCP 服务", "My MCP Servers"),
      n: info?.mcp,
      unit: (n: number) =>
        bi(`${n} 个`, `${n} ${n === 1 ? "server" : "servers"}`),
      empty:
        info && !info.user_mcp
          ? bi("管理员没有开放个人接入", "Personal MCP disabled by admin")
          : bi("让 AI 查你常用的系统", "Connect AI to your own systems"),
    },
  ];
  return (
    <div className="me-ov enter">
      <div className="me-main">
        <section className="me-card">
          <div className="me-card-h">
            <div>
              <h2>{bi("最近的集群", "Recent Clusters")}</h2>
            </div>
            {clusters.length > 0 && (
              <span className="me-pill num">{clusters.length}</span>
            )}
          </div>
          <div className="me-card-b me-card-b-list">
            {!act ? (
              <div className="me-pad">
                <Skeleton animation text={{ rows: 3 }} />
              </div>
            ) : clusters.length === 0 ? (
              <p className="me-empty">
                {bi("还没有交付。", "No deliveries yet.")}
              </p>
            ) : (
              <ul className="me-rows me-card-rows">
                {clusters.map((j) => {
                  const ph = planPhase(j);
                  return (
                    <li key={j.id}>
                      <a
                        href={`#/d/${encodeURIComponent(j.cluster_id)}`}
                        onClick={(e) => {
                          e.preventDefault();
                          go({ name: "deliveries", id: j.cluster_id });
                        }}
                      >
                        <span
                          className={`me-dot s-${PLAN_PHASE[ph].dot}`}
                          aria-hidden
                        />
                        <span className="me-row-t">
                          <b className="mono">{j.cluster_id}</b>
                          <small>
                            {j.app_name} {j.version.split("·")[0].trim()} ·{" "}
                            {bi(
                              `最近：${planTitle(j)} ${PLAN_PHASE[ph].label}`,
                              `Latest: ${planTitle(j)} · ${PLAN_PHASE[ph].label}`,
                            )}
                          </small>
                        </span>
                        <time
                          className="faint small"
                          title={fullTime(j.created)}
                        >
                          {ago(j.created)}
                        </time>
                        <IconRight className="me-chev" />
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
        <section className="me-card">
          <div className="me-card-h">
            <div>
              <h2>{bi("最近的操作", "Recent Activity")}</h2>
            </div>
            {act && act.events.length > 0 && (
              <span className="me-pill num">
                {bi("近 30 天", "Last 30d")}
              </span>
            )}
          </div>
          <div className="me-card-b">
            {!act ? (
              <Skeleton animation text={{ rows: 4 }} />
            ) : act.events.length === 0 ? (
              <p className="me-empty">
                {bi(
                  "最近 30 天没有操作记录。",
                  "No activity in the last 30 days.",
                )}
              </p>
            ) : (
              <ol className="me-tl">
                {act.events.slice(0, 12).map((e, i) => (
                  <li
                    key={i}
                    className={e.action.includes("failed") ? "bad" : ""}
                  >
                    <i aria-hidden />
                    <span>{auditText(e)}</span>
                    <time className="faint small" title={fullTime(e.time)}>
                      {ago(e.time)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </div>
      <aside className="me-aside">
        {aiStatus.enabled && (
          <>
            <section className="me-card">
              <div className="me-card-h">
                <h2>{bi("本月用 AI", "AI Usage This Month")}</h2>
              </div>
              <div className="me-card-b">
                {!act ? (
                  <Skeleton animation text={{ rows: 1 }} />
                ) : (
                  <div className="me-ai-stats">
                    <div className="me-ai-stat">
                      <b className="num">{act.ai.calls}</b>
                      <span>
                        {bi(
                          "对话次数",
                          act.ai.calls === 1 ? "Query" : "Queries",
                        )}
                      </span>
                    </div>
                    <div className="me-ai-stat">
                      {(() => {
                        const tok = act.ai.in + act.ai.out;
                        const shortTok =
                          tok >= 1_000_000_000
                            ? `${(tok / 1_000_000_000).toFixed(2)}B`
                            : tok >= 1_000_000
                              ? `${(tok / 1_000_000).toFixed(2)}M`
                              : tok >= 100_000
                                ? `${(tok / 1_000).toFixed(1)}K`
                                : tok.toLocaleString(getLang());
                        return (
                          <b
                            className="num"
                            title={`${tok.toLocaleString(getLang())} Token`}
                          >
                            {shortTok}
                          </b>
                        );
                      })()}
                      <span>{bi("Token 用量", "Tokens")}</span>
                    </div>
                    <div className="me-ai-stat">
                      <b className="num">{cost}</b>
                      <span>{bi("预估费用", "Est. Cost")}</span>
                    </div>
                  </div>
                )}
              </div>
            </section>
            <section className="me-card">
              <div className="me-card-h">
                <h2>{bi("AI 用到的我的资源", "My AI Resources")}</h2>
              </div>
              <div className="me-card-b">
                <ul className="me-res">
                  {res.map((o) => (
                    <li key={o.k}>
                      <button type="button" onClick={() => go(o.to)}>
                        <span className={`rp-ic ${o.k}`}>{o.icon}</span>
                        <span className="me-row-t">
                          <b>{o.title}</b>
                          <small>{o.n ? o.unit(o.n) : o.empty}</small>
                        </span>
                        <IconRight className="me-chev" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          </>
        )}
        <section className="me-card">
          <div className="me-card-h">
            <h2>{bi("我能做什么", "My Permissions")}</h2>
          </div>
          <div className="me-card-b">
            {info?.access ? (
              <EffectivePerms
                iam={{
                  perms: info.access.perms,
                  roles: [],
                  teams: [],
                  grants: {},
                }}
                perms={new Set(info.access.perms.map((p) => p.id))}
                scope={info.access.scope}
              />
            ) : (
              <Skeleton animation text={{ rows: 3 }} />
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

/* ---------------------------------------------------------------- sign-in and password */

function passwordStrength(pw: string): {
  level: 0 | 1 | 2 | 3 | 4;
  label: string;
  tone: string;
  lenOK: boolean;
  mixOK: boolean;
  symOK: boolean;
} {
  const lenOK = pw.length >= 12;
  const hasLower = /[a-z]/.test(pw);
  const hasUpper = /[A-Z]/.test(pw);
  const hasNum = /\d/.test(pw);
  const hasSym = /[^A-Za-z0-9]/.test(pw);
  const mixOK = (hasLower || hasUpper) && hasNum;
  const symOK = hasSym || (hasLower && hasUpper);
  if (!pw) {
    return { level: 0, label: "", tone: "", lenOK, mixOK, symOK };
  }
  let score = 0;
  if (lenOK) score++;
  if (pw.length >= 16) score++;
  if (mixOK) score++;
  if (hasSym && hasUpper && hasLower) score++;
  else if (symOK) score = Math.min(4, score + 1);
  if (!lenOK) {
    return {
      level: 1,
      label: bi("长度不足", "Too short"),
      tone: "weak",
      lenOK,
      mixOK,
      symOK,
    };
  }
  if (score <= 2) {
    return {
      level: 2,
      label: bi("中等", "Fair"),
      tone: "mid",
      lenOK,
      mixOK,
      symOK,
    };
  }
  if (score === 3) {
    return {
      level: 3,
      label: bi("较强", "Strong"),
      tone: "good",
      lenOK,
      mixOK,
      symOK,
    };
  }
  return {
    level: 4,
    label: bi("极强", "Very strong"),
    tone: "great",
    lenOK,
    mixOK,
    symOK,
  };
}

function DeviceIcon({ ua }: { ua?: string }) {
  const kind = deviceKind(ua);
  if (kind === "mobile") return <IconMobile />;
  if (kind === "cli") return <IconCodeSquare />;
  return <IconDesktop />;
}

function SecurityView({ me, act }: { me: Session; act: Activity | null }) {
  useLang();
  const conn = useConnectivity();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessBusy, setSessBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [sessLoading, setSessLoading] = useState(false);
  const [sessErr, setSessErr] = useState("");
  const [devFilter, setDevFilter] = useState<"all" | "browser" | "cli">("all");
  const [showAllDevs, setShowAllDevs] = useState(false);
  const [sessData, setSessData] = useState<{
    current_session_id: string;
    active: AuditSessionRow[];
    history: AuditSessionRow[];
  } | null>(null);
  const mountedRef = useRef(true);
  const sessSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSessions = () => {
    const seq = ++sessSeqRef.current;
    setSessErr("");
    setSessLoading(true);
    api<typeof sessData>("/api/me/sessions")
      .then((d) => {
        if (!mountedRef.current || seq !== sessSeqRef.current) return;
        setSessData(d);
        setSessErr("");
      })
      .catch((e) => {
        if (!mountedRef.current || seq !== sessSeqRef.current) return;
        setSessErr(
          (e as Error).message ||
            bi("加载已登录设备失败", "Failed to load active sessions"),
        );
      })
      .finally(() => {
        if (mountedRef.current && seq === sessSeqRef.current) {
          setSessLoading(false);
        }
      });
  };
  useEffect(() => {
    loadSessions();
  }, [me.session_id]);

  const revokeOwn = async (id: string) => {
    if (revokingId || sessBusy) return;
    setRevokingId(id);
    try {
      await api(`/api/me/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      Message.success(bi("已退出该设备", "Device signed out"));
      loadSessions();
    } catch (e) {
      err(e);
    } finally {
      if (mountedRef.current) setRevokingId(null);
    }
  };
  const revokeOthers = async () => {
    const others = (sessData?.active || []).filter((s) => !s.current);
    if (!others.length) return;
    setSessBusy(true);
    try {
      await Promise.all(
        others.map((s) =>
          api(`/api/me/sessions/${encodeURIComponent(s.id)}`, {
            method: "DELETE",
          }),
        ),
      );
      Message.success(
        bi(
          `已退出其他 ${others.length} 台设备`,
          `Signed out ${others.length} other ${others.length === 1 ? "device" : "devices"}`,
        ),
      );
      loadSessions();
    } catch (e) {
      err(e);
    } finally {
      setSessBusy(false);
    }
  };

  const short = next.length > 0 && next.length < 12;
  const differ = again.length > 0 && again !== next;
  const strength = useMemo(() => passwordStrength(next), [next]);

  const submit = async () => {
    setBusy(true);
    try {
      await api("/api/me/password", {
        method: "POST",
        body: JSON.stringify({ current: cur, next }),
      });
      Message.success(
        bi(
          "密码已修改；你在其他地方的登录已退出",
          "Password updated; all other active sessions have been signed out",
        ),
      );
      setCur("");
      setNext("");
      setAgain("");
      loadSessions();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  const signins = useMemo(
    () =>
      (act?.events || [])
        .filter((e) =>
          /^(login|logout|me-password|session-expired|session-revoke)/.test(
            e.action,
          ),
        )
        .slice(0, 20),
    [act?.events],
  );
  const failedCount = useMemo(
    () => signins.filter((e) => e.action === "login-failed").length,
    [signins],
  );

  const activeDevs = sessData?.active || [];
  const currentDev = activeDevs.find((s) => s.current) || null;
  const otherCount = activeDevs.filter((s) => !s.current).length;
  const browserCount = activeDevs.filter(
    (s) => deviceKind(s.agent) !== "cli",
  ).length;
  const cliCount = activeDevs.length - browserCount;
  const showTypeTabs = browserCount > 0 && cliCount > 0;

  const filteredDevs = useMemo(() => {
    const list = activeDevs.filter((s) => {
      if (devFilter === "all") return true;
      const isCLI = deviceKind(s.agent) === "cli";
      return devFilter === "cli" ? isCLI : !isCLI;
    });
    // Ensure current device stays pinned at top
    return [...list].sort((a, b) => Number(!!b.current) - Number(!!a.current));
  }, [activeDevs, devFilter]);

  const FOLD_LIMIT = 5;
  const visibleDevs = showAllDevs
    ? filteredDevs
    : filteredDevs.slice(0, FOLD_LIMIT);
  const hiddenCount = Math.max(0, filteredDevs.length - visibleDevs.length);

  return (
    <div className="me-pane me-secv enter">
      {conn !== "online" && (
        <Alert
          type="warning"
          showIcon
          className="me-offline"
          content={
            conn === "offline"
              ? bi(
                  "当前处于离线状态，恢复连接后可刷新或管理已登录设备。",
                  "You are offline. Reconnect to refresh or manage active devices.",
                )
              : bi(
                  "暂无法连接到平台服务，请确认服务正常后重试。",
                  "Unable to reach the platform service. Please verify and retry.",
                )
          }
          action={
            <Button size="mini" onClick={loadSessions}>
              {bi("重新检测", "Retry")}
            </Button>
          }
        />
      )}

      {/* Top 3-card security summary strip */}
      <div className="me-sec-kpis">
        <div className="me-kpi">
          <div className="me-kpi-ic ok">
            <IconSafe />
          </div>
          <div className="me-kpi-body">
            <span className="me-kpi-label">{bi("在线会话", "Active Sessions")}</span>
            <b className="me-kpi-val num">
              {sessData
                ? bi(`${activeDevs.length} 台`, `${activeDevs.length}`)
                : "—"}
            </b>
            <small>
              {!sessData
                ? bi("正在读取会话状态…", "Checking sessions…")
                : otherCount === 0
                  ? bi("仅当前设备在线", "Only this device")
                  : showTypeTabs
                    ? bi(
                        `浏览器 ${browserCount} · 终端/接口 ${cliCount}`,
                        `${browserCount} browser · ${cliCount} CLI/API`,
                      )
                    : bi(
                        `本机 + ${otherCount} 台其他设备`,
                        `This device + ${otherCount} other`,
                      )}
            </small>
          </div>
        </div>

        <div className="me-kpi">
          <div className="me-kpi-ic brand">
            <IconDesktop />
          </div>
          <div className="me-kpi-body">
            <span className="me-kpi-label">{bi("当前设备", "Current Device")}</span>
            <b className="me-kpi-val">
              {currentDev
                ? browser(currentDev.agent) || bi("浏览器会话", "Browser")
                : bi("当前浏览器", "This Browser")}
            </b>
            <small className="num">
              {currentDev
                ? `${currentDev.ip || "—"} · ${bi(`已在线 ${formatDuration(currentDev.duration_seconds)}`, `Online ${formatDuration(currentDev.duration_seconds)}`)}`
                : bi("已建立安全会话", "Active session")}
            </small>
          </div>
        </div>

        <div className="me-kpi">
          <div className={`me-kpi-ic ${failedCount > 0 ? "bad" : "ok"}`}>
            {failedCount > 0 ? <IconCloseCircleFill /> : <IconCheckCircleFill />}
          </div>
          <div className="me-kpi-body">
            <span className="me-kpi-label">
              {bi("近 30 天安全动态", "30-Day Sign-in Health")}
            </span>
            <b className={`me-kpi-val ${failedCount > 0 ? "bad" : ""}`}>
              {!act
                ? "—"
                : failedCount > 0
                  ? bi(`${failedCount} 次登录失败`, `${failedCount} failed`)
                  : bi("状态正常", "All clear")}
            </b>
            <small>
              {!act
                ? bi("正在汇总登录日志…", "Loading sign-in log…")
                : signins.length > 0
                  ? bi(
                      `共 ${signins.length} 条记录 · 最近 ${ago(signins[0].time)}`,
                      `${signins.length} events · latest ${ago(signins[0].time)}`,
                    )
                  : bi("暂无异常登录事件", "No unusual sign-ins")}
            </small>
          </div>
        </div>
      </div>

      {/* Main 2-column security layout: left sessions + history, right sticky password card */}
      <div className="me-sec-grid">
        <div className="me-sec-left">
          {/* Card 1: Active Devices */}
          <section className="me-card me-dev-card">
            <div className="me-card-h">
              <div className="me-card-title">
                <span className="me-card-ic brand">
                  <IconDesktop />
                </span>
                <div>
                  <div className="me-card-title-row">
                    <h2>{bi("已登录设备", "Active Devices")}</h2>
                    {sessData && (
                      <span className="me-pill ok num">
                        {bi(`${activeDevs.length} 台在线`, `${activeDevs.length} online`)}
                      </span>
                    )}
                  </div>
                  <p className="me-card-sub">
                    {bi(
                      "管理当前账号在线的浏览器与终端会话，可随时远程强制退出其他设备。",
                      "Review browsers and CLI/API sessions signed in to your account, and sign out others remotely.",
                    )}
                  </p>
                </div>
              </div>
              <div className="me-card-acts">
                <Button
                  size="small"
                  type="text"
                  icon={<IconRefresh />}
                  loading={sessLoading}
                  onClick={loadSessions}
                  aria-label={bi("刷新设备列表", "Refresh devices")}
                />
                {otherCount > 0 && (
                  <Popconfirm
                    title={bi(
                      `确定退出除本机之外的其他 ${otherCount} 台设备？`,
                      `Sign out all ${otherCount} other ${otherCount === 1 ? "device" : "devices"}?`,
                    )}
                    onOk={revokeOthers}
                  >
                    <Button
                      size="small"
                      status="danger"
                      type="outline"
                      loading={sessBusy}
                      icon={<IconPoweroff />}
                    >
                      {bi("退出其他设备", "Sign Out Others")}
                    </Button>
                  </Popconfirm>
                )}
              </div>
            </div>

            {showTypeTabs && (
              <div className="me-dev-bar">
                <div className="me-dev-filters" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={devFilter === "all"}
                    className={devFilter === "all" ? "on" : ""}
                    onClick={() => {
                      setDevFilter("all");
                      setShowAllDevs(false);
                    }}
                  >
                    {bi("全部", "All")}
                    <em className="num">{activeDevs.length}</em>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={devFilter === "browser"}
                    className={devFilter === "browser" ? "on" : ""}
                    onClick={() => {
                      setDevFilter("browser");
                      setShowAllDevs(false);
                    }}
                  >
                    {bi("浏览器", "Browsers")}
                    <em className="num">{browserCount}</em>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={devFilter === "cli"}
                    className={devFilter === "cli" ? "on" : ""}
                    onClick={() => {
                      setDevFilter("cli");
                      setShowAllDevs(false);
                    }}
                  >
                    {bi("终端与接口", "CLI / API")}
                    <em className="num">{cliCount}</em>
                  </button>
                </div>
              </div>
            )}

            <div className="me-card-b me-card-b-devs">
              {sessErr && (
                <Alert
                  type="error"
                  showIcon
                  className="me-sess-err"
                  content={sessErr}
                  action={
                    <Button size="mini" onClick={loadSessions}>
                      {bi("重试", "Retry")}
                    </Button>
                  }
                />
              )}

              {!sessData && !sessErr ? (
                <Skeleton animation text={{ rows: 3 }} />
              ) : filteredDevs.length === 0 ? (
                <div className="me-dev-empty">
                  <Empty
                    description={bi("暂无符合条件的活跃设备", "No matching active devices")}
                  />
                </div>
              ) : (
                <>
                  <ul
                    className="me-dev-list"
                    aria-label={bi("已登录设备", "Active devices")}
                  >
                    {visibleDevs.map((s) => {
                      const kind = deviceKind(s.agent);
                      const dev =
                        browser(s.agent) ||
                        (kind === "cli"
                          ? bi("终端 / 接口会话", "CLI / API Session")
                          : bi("浏览器会话", "Browser Session"));
                      return (
                        <li
                          key={s.id}
                          className={`me-dev-item ${s.current ? "is-cur" : ""}`}
                        >
                          <span
                            className={`me-dev-ic ${s.current ? "cur" : kind}`}
                            aria-hidden
                          >
                            <DeviceIcon ua={s.agent} />
                          </span>
                          <div className="me-dev-info">
                            <div className="me-dev-title">
                              <b>{dev}</b>
                              {s.current && (
                                <span className="me-cur-tag">
                                  {bi("当前设备", "This Device")}
                                </span>
                              )}
                              {!s.current && kind === "cli" && (
                                <span className="me-kind-tag">
                                  {bi("终端 / 接口", "CLI / API")}
                                </span>
                              )}
                            </div>
                            <div className="me-dev-meta num">
                              <span className="me-ip-chip mono">
                                {s.ip || bi("未知来源", "Unknown IP")}
                              </span>
                              <span>
                                {bi(
                                  `登录于 ${stamp(s.created_at)}`,
                                  `Signed in ${stamp(s.created_at)}`,
                                )}
                              </span>
                              <i aria-hidden>·</i>
                              <span>
                                {bi(
                                  `在线 ${formatDuration(s.duration_seconds)}（活跃 ${formatDuration(s.active_seconds)}）`,
                                  `Online ${formatDuration(s.duration_seconds)} (active ${formatDuration(s.active_seconds)})`,
                                )}
                              </span>
                            </div>
                          </div>
                          <div className="me-dev-act">
                            {s.current ? (
                              <span className="me-using-pill">
                                <i aria-hidden />
                                {bi("正在使用", "In use")}
                              </span>
                            ) : (
                              <Popconfirm
                                title={bi(
                                  "退出该设备的登录状态？",
                                  "Sign out this device?",
                                )}
                                onOk={() => revokeOwn(s.id)}
                              >
                                <Button
                                  size="small"
                                  status="danger"
                                  type="text"
                                  icon={<IconPoweroff />}
                                  loading={revokingId === s.id}
                                  disabled={
                                    sessBusy ||
                                    Boolean(revokingId && revokingId !== s.id)
                                  }
                                >
                                  {bi("退出", "Sign Out")}
                                </Button>
                              </Popconfirm>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {(hiddenCount > 0 ||
                    (showAllDevs && filteredDevs.length > FOLD_LIMIT)) && (
                    <button
                      type="button"
                      className="me-dev-more"
                      onClick={() => setShowAllDevs((v) => !v)}
                    >
                      {showAllDevs ? (
                        <>
                          <IconUp />
                          {bi("收起设备列表", "Show fewer devices")}
                        </>
                      ) : (
                        <>
                          <IconDown />
                          {bi(
                            `展开其余 ${hiddenCount} 台在线设备`,
                            `Show ${hiddenCount} more active ${hiddenCount === 1 ? "device" : "devices"}`,
                          )}
                        </>
                      )}
                    </button>
                  )}
                </>
              )}
            </div>
          </section>

          {/* Card 2: Recent Sign-ins & Session History */}
          <section className="me-card me-log-card">
            <div className="me-card-h">
              <div className="me-card-title">
                <span className="me-card-ic neutral">
                  <IconHistory />
                </span>
                <div>
                  <div className="me-card-title-row">
                    <h2>{bi("最近登录记录", "Recent Sign-ins")}</h2>
                    {signins.length > 0 && (
                      <span className="me-pill num">{signins.length}</span>
                    )}
                  </div>
                  <p className="me-card-sub">
                    {bi(
                      "近 30 天账号登录、退出、改密与历史会话摘要。",
                      "Sign-ins, sign-outs, password changes, and past sessions over the last 30 days.",
                    )}
                  </p>
                </div>
              </div>
            </div>
            <div className="me-card-b me-card-b-list">
              {!act ? (
                <div className="me-pad">
                  <Skeleton animation text={{ rows: 4 }} />
                </div>
              ) : signins.length === 0 &&
                (sessData?.history || []).length === 0 ? (
                <p className="me-empty">
                  {bi(
                    "最近 30 天没有登录记录。",
                    "No sign-in activity in the last 30 days.",
                  )}
                </p>
              ) : (
                <ul className="me-log-list">
                  {signins.map((e, i) => {
                    const isFail = e.action === "login-failed";
                    const isPw = e.action === "me-password";
                    const isOut =
                      e.action === "logout" ||
                      e.action.startsWith("session-");
                    return (
                      <li
                        key={`ev-${i}`}
                        className={`me-log-row ${isFail ? "bad" : ""}`}
                      >
                        <span
                          className={`me-log-dot ${isFail ? "bad" : isPw ? "brand" : isOut ? "mute" : "ok"}`}
                          aria-hidden
                        />
                        <div className="me-log-main">
                          <b>{auditText(e)}</b>
                          <div className="me-log-sub">
                            <span className="me-ip-chip mono">
                              {e.ip || "—"}
                            </span>
                            {e.duration_sec && e.duration_sec > 0 ? (
                              <span className="num">
                                {bi(
                                  `持续 ${formatDuration(e.duration_sec)}`,
                                  `Duration ${formatDuration(e.duration_sec)}`,
                                )}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <time
                          className="me-log-time"
                          title={fullTime(e.time)}
                        >
                          {ago(e.time)}
                        </time>
                      </li>
                    );
                  })}
                  {(sessData?.history || []).slice(0, 6).map((h) => {
                    const reason =
                      (SESSION_REASON[h.end_reason] || [h.end_reason])[0];
                    return (
                      <li key={`hs-${h.id}`} className="me-log-row hist">
                        <span className="me-log-dot mute" aria-hidden />
                        <div className="me-log-main">
                          <b>
                            {browser(h.agent) ||
                              bi("历史设备", "Previous Device")}
                            {reason ? (
                              <span className="me-kind-tag">{reason}</span>
                            ) : null}
                          </b>
                          <div className="me-log-sub">
                            <span className="me-ip-chip mono">
                              {h.ip || "—"}
                            </span>
                            <span className="num">
                              {bi(
                                `在线 ${formatDuration(h.duration_seconds)}（活跃 ${formatDuration(h.active_seconds)}）`,
                                `Online ${formatDuration(h.duration_seconds)} (active ${formatDuration(h.active_seconds)})`,
                              )}
                            </span>
                          </div>
                        </div>
                        <time
                          className="me-log-time"
                          title={fullTime(h.ended_at || h.created_at)}
                        >
                          {ago(h.ended_at || h.created_at)}
                        </time>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </div>

        {/* Right Column: Sticky Password Management Card */}
        <aside className="me-sec-right">
          <section className="me-card me-pw-card">
            <div className="me-card-h">
              <div className="me-card-title">
                <span className="me-card-ic warn">
                  <IconLock />
                </span>
                <div>
                  <h2>{bi("修改密码", "Change Password")}</h2>
                  <p className="me-card-sub">
                    {bi(
                      "定期更新高强度密码以保障账号安全。",
                      "Use a strong unique password to protect your account.",
                    )}
                  </p>
                </div>
              </div>
            </div>
            <div className="me-card-b">
              <form
                className="me-pw"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy && cur && next.length >= 12 && next === again)
                    submit();
                }}
              >
                <input
                  type="text"
                  name="username"
                  value={me.username}
                  autoComplete="username"
                  hidden
                  readOnly
                />
                <label>
                  <span>{bi("当前密码", "Current Password")}</span>
                  <Input.Password
                    value={cur}
                    onChange={setCur}
                    placeholder={bi("输入当前登录密码", "Enter current password")}
                    autoComplete="current-password"
                    aria-label={bi("当前密码", "Current password")}
                  />
                </label>
                <label>
                  <span>{bi("新密码", "New Password")}</span>
                  <Input.Password
                    value={next}
                    onChange={setNext}
                    placeholder={bi("至少 12 位字符", "At least 12 characters")}
                    autoComplete="new-password"
                    status={short ? "warning" : undefined}
                    aria-label={bi("新密码", "New password")}
                  />
                  {next.length > 0 && (
                    <div className="me-pw-meter">
                      <div className="me-pw-bars" aria-hidden>
                        {[1, 2, 3, 4].map((n) => (
                          <span
                            key={n}
                            className={
                              strength.level >= n ? `on ${strength.tone}` : ""
                            }
                          />
                        ))}
                      </div>
                      <em className={`me-pw-lvl ${strength.tone}`}>
                        {strength.label}
                      </em>
                    </div>
                  )}
                  <div className="me-pw-rules">
                    <span className={strength.lenOK ? "ok" : ""}>
                      <IconCheckCircleFill />
                      {bi("至少 12 位", "12+ chars")}
                    </span>
                    <span className={strength.mixOK ? "ok" : ""}>
                      <IconCheckCircleFill />
                      {bi("字母与数字", "Letters & digits")}
                    </span>
                    <span className={strength.symOK ? "ok" : ""}>
                      <IconCheckCircleFill />
                      {bi("大小写或符号", "Case / symbol")}
                    </span>
                  </div>
                </label>
                <label>
                  <span>{bi("确认新密码", "Confirm New Password")}</span>
                  <Input.Password
                    value={again}
                    onChange={setAgain}
                    placeholder={bi("再次输入新密码", "Re-enter new password")}
                    autoComplete="new-password"
                    status={differ ? "error" : undefined}
                    aria-label={bi("再输一次新密码", "Confirm new password")}
                  />
                  {differ && (
                    <small className="bad">
                      {bi("两次输入的密码不一致", "Passwords do not match")}
                    </small>
                  )}
                </label>
                <Button
                  type="primary"
                  long
                  htmlType="submit"
                  loading={busy}
                  disabled={!cur || next.length < 12 || next !== again}
                >
                  {bi("更新密码", "Update Password")}
                </Button>
              </form>
              <p className="me-pw-note">
                {bi(
                  "修改成功后当前设备保持登录，其余在线会话将自动退出。",
                  "Your current device stays signed in; all other sessions will be signed out.",
                )}
              </p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

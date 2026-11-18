import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Message,
  Modal,
  Popconfirm,
  Skeleton,
} from "@arco-design/web-react";
import {
  IconBook,
  IconDelete,
  IconEdit,
  IconEye,
  IconFile,
  IconLink,
  IconLock,
  IconPlus,
  IconPoweroff,
  IconRight,
  IconSearch,
  IconStorage,
  IconUpload,
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
import { StatusDot } from "./ui";
import type { Outcome, Session } from "./shared";
import { go } from "./router";
import {
  auditText,
  browser,
  SESSION_REASON,
} from "./audit";
import type { AuditSessionRow } from "./audit";
import { Avatar } from "./accounts";
import { EffectivePerms } from "./iam";
import type { Perm } from "./iam";
import { Markdown } from "./aimd";
import "./me.css";

/* My account: who I am, what I did lately, and what my own conversations with the assistant draw on — my skills, my
   outside services and my knowledge base. Nobody else sees any of it. Managing other accounts is in IAM. */

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
    delivery_mode?: "offline" | "configuration";
  }[];
};

const SECTIONS = [
  { id: "", title: "概览", icon: <IconUser /> },
  { id: "security", title: "登录与安全", icon: <IconLock /> },
];

export function MePage({
  me,
  section = "",
}: {
  me: Session;
  section?: string;
}) {
  const aiStatus = useAIStatus();
  const [info, setInfo] = useState<Me | null>(
    () => cached<Me>("/api/me") ?? null,
  );
  const [act, setAct] = useState<Activity | null>(
    () => cached<Activity>("/api/me/activity") ?? null,
  );
  const tabs = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  const cur = SECTIONS.some((s) => s.id === section) ? section : "";
  useEffect(() => {
    api<Me>("/api/me")
      .then((r) => {
        putCached("/api/me", r);
        setInfo(r);
      })
      .catch(err);
    api<Activity>("/api/me/activity")
      .then((r) => {
        putCached("/api/me/activity", r);
        setAct(r);
      })
      .catch(() =>
        setAct((prev) =>
          prev ?? {
            events: [],
            ai: { calls: 0, in: 0, out: 0, cost: 0 },
            currency: "CNY",
            jobs: [],
          },
        ),
      );
  }, []);
  useEffect(() => {
    const el = tabs.current?.querySelector<HTMLElement>(`[data-k="${cur}"]`);
    if (el) setBar({ x: el.offsetLeft, w: el.offsetWidth });
  }, [cur, info]);
  const open = (id: string) =>
    go({ name: "me", id: id || undefined }, { replace: true });

  return (
    <div className="me-page">
      <header className="me-hero">
        <Avatar name={me.username} role={me.role} size={68} />
        <div className="me-who">
          <h1>{me.username}</h1>
          <span className="me-chips">
            {(info?.access?.roles || []).map((r) => (
              <span key={r} className="me-chip role">
                {r}
              </span>
            ))}
            {(info?.access?.teams || []).map((t) => (
              <span key={t} className="me-chip team">
                {t}
              </span>
            ))}
            {act && (
              <span className="me-facts-inline">
                {act.jobs.length ? `${act.jobs.length} 份交付` : "还没有交付"}
                {aiStatus.enabled && act.ai.calls
                  ? ` · 本月问了 AI ${act.ai.calls} 次`
                  : ""}
              </span>
            )}
          </span>
        </div>
        <span className="me-hero-acts">
          <Button icon={<IconLock />} onClick={() => open("security")}>
            修改密码
          </Button>
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
        aria-label="我的账户"
        ref={tabs}
        onKeyDown={(e) => {
          const i = SECTIONS.findIndex((s) => s.id === cur);
          const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          const next = SECTIONS[(i + d + SECTIONS.length) % SECTIONS.length];
          open(next.id);
          window.setTimeout(
            () =>
              tabs.current
                ?.querySelector<HTMLElement>(`[data-k="${next.id}"]`)
                ?.focus(),
            0,
          );
        }}
      >
        {bar && (
          <span
            className="me-tabs-bar"
            style={{ transform: `translateX(${bar.x}px)`, width: bar.w }}
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
      <div className="me-body" key={cur}>
        {cur === "" && <Overview info={info} act={act} />}
        {cur === "security" && <SecurityView me={me} act={act} />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- overview */

function Overview({ info, act }: { info: Me | null; act: Activity | null }) {
  const aiStatus = useAIStatus();
  const cost = act
    ? `${act.currency === "USD" ? "$" : "¥"}${act.ai.cost >= 1 ? act.ai.cost.toFixed(2) : act.ai.cost.toFixed(4)}`
    : "—";
  const res = [
    {
      to: { name: "kb", id: "~my" } as const,
      icon: <IconStorage />,
      k: "k-doc",
      title: "我的资料",
      n: info?.kb,
      unit: "份",
      empty: "现场资料、网络规划、过往问题",
    },
    {
      to: { name: "skills" } as const,
      icon: <IconBook />,
      k: "k-built",
      title: "我的技能",
      n: info?.skills,
      unit: "个",
      empty: "写给 AI 照着做的手册",
    },
    {
      to: { name: "mcp" } as const,
      icon: <IconLink />,
      k: "k-mcp",
      title: "我的 MCP 服务",
      n: info?.mcp,
      unit: "个",
      empty:
        info && !info.user_mcp
          ? "管理员没有开放个人接入"
          : "让 AI 查你常用的系统",
    },
  ];
  return (
    <div className="me-ov enter">
      <div className="me-main">
        <section className="me-sec">
          <h2>最近的集群</h2>
          {!act ? (
            <Skeleton animation text={{ rows: 3 }} />
          ) : act.jobs.length === 0 ? (
            <p className="me-empty">还没有交付。</p>
          ) : (
            <ul className="me-rows">
              {act.jobs
                .filter(
                  (j, i, all) =>
                    all.findIndex((x) => x.cluster_id === j.cluster_id) === i,
                )
                .slice(0, 6)
                .map((j) => {
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
                            {j.app_name} {j.version.split("·")[0].trim()} ·
                            最近：{planTitle(j)} {PLAN_PHASE[ph].label}
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
        </section>
        <section className="me-sec">
          <h2>最近的操作</h2>
          {!act ? (
            <Skeleton animation text={{ rows: 4 }} />
          ) : act.events.length === 0 ? (
            <p className="me-empty">最近 30 天没有操作记录。</p>
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
        </section>
      </div>
      <aside className="me-aside">
        {aiStatus.enabled && (
          <>
            <section className="me-sec">
              <h2>AI 用到的我的资源</h2>
              <ul className="me-res">
                {res.map((o) => (
                  <li key={o.title}>
                    <button type="button" onClick={() => go(o.to)}>
                      <span className={`rp-ic ${o.k}`}>{o.icon}</span>
                      <span className="me-row-t">
                        <b>{o.title}</b>
                        <small>{o.n ? `${o.n} ${o.unit}` : o.empty}</small>
                      </span>
                      <IconRight className="me-chev" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <section className="me-sec">
              <h2>本月用 AI</h2>
              {!act ? (
                <Skeleton animation text={{ rows: 1 }} />
              ) : (
                <p className="me-facts">
                  <span>
                    <b className="num">{act.ai.calls}</b> 次
                  </span>
                  <span>
                    <b className="num">
                      {(act.ai.in + act.ai.out).toLocaleString("en-US")}
                    </b>{" "}
                    Token
                  </span>
                  <span>
                    约 <b className="num">{cost}</b>
                  </span>
                </p>
              )}
            </section>
          </>
        )}
        <section className="me-sec">
          <h2>我能做什么</h2>
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
        </section>
      </aside>
    </div>
  );
}

/* ---------------------------------------------------------------- sign-in and password */

function SecurityView({ me, act }: { me: Session; act: Activity | null }) {
  const conn = useConnectivity();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessBusy, setSessBusy] = useState(false);
  const [sessErr, setSessErr] = useState("");
  const [sessData, setSessData] = useState<{
    current_session_id: string;
    active: AuditSessionRow[];
    history: AuditSessionRow[];
  } | null>(null);
  const loadSessions = () => {
    setSessErr("");
    api<typeof sessData>("/api/me/sessions")
      .then((d) => {
        setSessData(d);
        setSessErr("");
      })
      .catch((e) => setSessErr((e as Error).message || "加载已登录设备失败"));
  };
  useEffect(() => {
    loadSessions();
  }, [me.session_id]);
  const revokeOwn = async (id: string) => {
    try {
      await api(`/api/me/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      Message.success("已退出该设备");
      loadSessions();
    } catch (e) {
      err(e);
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
      Message.success(`已退出其他 ${others.length} 台设备`);
      loadSessions();
    } catch (e) {
      err(e);
    } finally {
      setSessBusy(false);
    }
  };
  const short = next.length > 0 && next.length < 12;
  const differ = again.length > 0 && again !== next;
  const submit = async () => {
    setBusy(true);
    try {
      await api("/api/me/password", {
        method: "POST",
        body: JSON.stringify({ current: cur, next }),
      });
      Message.success("密码已修改；你在其他地方的登录已退出");
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
  const signins = (act?.events || [])
    .filter((e) =>
      /^(login|logout|me-password|session-expired|session-revoke)/.test(
        e.action,
      ),
    )
    .slice(0, 15);
  const activeDevs = sessData?.active || [];
  const otherCount = activeDevs.filter((s) => !s.current).length;

  return (
    <div className="me-pane me-secv enter">
      {conn !== "online" && (
        <Alert
          type="warning"
          showIcon
          className="me-offline"
          content={
            conn === "offline"
              ? "当前处于离线状态，恢复连接后可刷新或管理已登录设备。"
              : "暂无法连接到平台服务，请确认服务正常后重试。"
          }
          action={
            <Button size="mini" onClick={loadSessions}>
              重新检测
            </Button>
          }
        />
      )}

      <section className="me-sec me-sess-sec">
        <div className="me-sess-head">
          <div>
            <h2>已登录设备</h2>
            <p className="faint small">
              管理当前账号在线的浏览器或终端，并可随时远程退出其他设备。
            </p>
          </div>
          <div className="me-sess-acts">
            {sessData && (
              <span className="me-sess-sum num">
                {activeDevs.length} 台在线
              </span>
            )}
            {otherCount > 0 && (
              <Popconfirm
                title={`确定退出除本机之外的其他 ${otherCount} 台设备？`}
                onOk={revokeOthers}
              >
                <Button
                  size="small"
                  loading={sessBusy}
                  icon={<IconPoweroff />}
                >
                  退出其他设备
                </Button>
              </Popconfirm>
            )}
          </div>
        </div>

        {sessErr && (
          <Alert
            type="error"
            showIcon
            className="me-sess-err"
            content={sessErr}
            action={
              <Button size="mini" onClick={loadSessions}>
                重试
              </Button>
            }
          />
        )}

        {!sessData && !sessErr ? (
          <Skeleton animation text={{ rows: 3 }} />
        ) : activeDevs.length === 0 ? (
          <div className="me-dev-empty">
            <Empty description="暂无活跃设备记录" />
          </div>
        ) : (
          <ul className="me-rows me-dev-list" aria-label="已登录设备">
            {activeDevs.map((s) => {
              const dev = browser(s.agent) || "浏览器会话";
              return (
                <li
                  key={s.id}
                  className={`me-dev-row ${s.current ? "cur" : ""}`}
                >
                  <StatusDot state="done" />
                  <span className="me-row-t">
                    <span className="me-dev-title">
                      <b>{dev}</b>
                      {s.current && (
                        <span className="me-cur-tag">当前设备</span>
                      )}
                    </span>
                    <small className="num">
                      {s.ip || "未知来源"} · 登录于 {stamp(s.created_at)} ·
                      已在线 {formatDuration(s.duration_seconds)}（活跃{" "}
                      {formatDuration(s.active_seconds)}）
                    </small>
                  </span>
                  <div className="me-dev-act">
                    {s.current ? (
                      <span className="me-using">正在使用</span>
                    ) : (
                      <Popconfirm
                        title="退出该设备的登录状态？"
                        onOk={() => revokeOwn(s.id)}
                      >
                        <Button
                          size="small"
                          status="danger"
                          icon={<IconPoweroff />}
                        >
                          退出
                        </Button>
                      </Popconfirm>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div className="me-cols">
        <section className="me-sec">
          <h2>修改密码</h2>
          <form
            className="me-pw"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && cur && next.length >= 12 && next === again) submit();
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
              <span>当前密码</span>
              <Input.Password
                value={cur}
                onChange={setCur}
                autoComplete="current-password"
                aria-label="当前密码"
              />
            </label>
            <label>
              <span>新密码</span>
              <Input.Password
                value={next}
                onChange={setNext}
                autoComplete="new-password"
                status={short ? "warning" : undefined}
                aria-label="新密码"
              />
              <small className={short ? "warn" : "faint"}>
                至少 12 个字符；改完后你在其他地方的登录会退出
              </small>
            </label>
            <label>
              <span>再输一次</span>
              <Input.Password
                value={again}
                onChange={setAgain}
                autoComplete="new-password"
                status={differ ? "error" : undefined}
                aria-label="再输一次新密码"
              />
              {differ && <small className="bad">两次输入不一样</small>}
            </label>
            <Button
              type="primary"
              htmlType="submit"
              loading={busy}
              disabled={!cur || next.length < 12 || next !== again}
            >
              修改密码
            </Button>
          </form>
        </section>
        <section className="me-sec">
          <h2>最近登录记录</h2>
          {!act ? (
            <Skeleton animation text={{ rows: 4 }} />
          ) : signins.length === 0 &&
            (sessData?.history || []).length === 0 ? (
            <p className="faint small">最近 30 天没有登录记录。</p>
          ) : (
            <ul className="me-rows me-logins">
              {signins.map((e, i) => (
                <li
                  key={`ev-${i}`}
                  className={e.action === "login-failed" ? "bad" : ""}
                >
                  <span
                    className={`me-dot ${e.action === "login-failed" ? "s-failed" : "s-succeeded"}`}
                    aria-hidden
                  />
                  <span className="me-row-t">
                    <b>{auditText(e)}</b>
                    <small className="mono">
                      {e.ip || "—"}
                      {e.duration_sec && e.duration_sec > 0
                        ? ` · 时长 ${formatDuration(e.duration_sec)}`
                        : ""}
                    </small>
                  </span>
                  <time className="faint small" title={fullTime(e.time)}>
                    {ago(e.time)}
                  </time>
                </li>
              ))}
              {(sessData?.history || []).slice(0, 6).map((h) => {
                const reason =
                  (SESSION_REASON[h.end_reason] || [h.end_reason])[0];
                return (
                  <li key={`hs-${h.id}`}>
                    <span className="me-dot" aria-hidden />
                    <span className="me-row-t">
                      <b>
                        {browser(h.agent) || "历史设备"} · {reason}
                      </b>
                      <small className="mono">
                        {h.ip || "—"} · 在线{" "}
                        {formatDuration(h.duration_seconds)}（活跃{" "}
                        {formatDuration(h.active_seconds)}）
                      </small>
                    </span>
                    <time
                      className="faint small"
                      title={fullTime(h.ended_at || h.created_at)}
                    >
                      {ago(h.ended_at || h.created_at)}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

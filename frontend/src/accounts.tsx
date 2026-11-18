import { bytesText } from "./myfiles";
import { editQuota } from "./storageview";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  Message,
  Modal,
  Select,
  Skeleton,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheck,
  IconCopy,
  IconDelete,
  IconExclamationCircle,
  IconLock,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSearch,
  IconSync,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  cached,
  can,
  copy,
  err,
  fullTime,
  planTitle,
  putCached,
  typing,
  useAIStatus,
  useMedia,
} from "./shared";
import { AuditView, auditText } from "./audit";
import type { Account, Session } from "./shared";
import { go } from "./router";
import { Kbd, UnderlineTabs } from "./ui";
import {
  DeletedPane,
  GrantEditor,
  RolePicker,
  RolesPane,
  TeamsPane,
  roleTitle,
  useIAM,
} from "./iam";
import { bi, getLang, useLang } from "./i18n";

export const roleName = (r: string) =>
  r === "admin" ? bi("管理员", "Admin") : bi("交付使用者", "Delivery User");

const AccIcons = {
  roles: (
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
      <path d="M8 2.2L13 4.1v3.7c0 3.1-2.1 5.2-5 6-2.9-.8-5-2.9-5-6V4.1L8 2.2Z" />
      <path d="M6.1 8.1l1.3 1.3 2.6-2.7" />
    </svg>
  ),
  teams: (
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
      <circle cx="6.2" cy="5.6" r="2.2" />
      <path d="M2.4 12.8c0-2 1.7-3.4 3.8-3.4s3.8 1.4 3.8 3.4" />
      <circle cx="11.2" cy="6.1" r="1.7" />
      <path d="M11.4 9.6c1.4.2 2.4 1.3 2.4 2.9" />
    </svg>
  ),
  audit: (
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
      <path d="M8 5v3.2l2.2 1.4" />
    </svg>
  ),
  deleted: (
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
      <circle cx="6.5" cy="5.5" r="2.2" />
      <path d="M2.5 12.8c0-2 1.8-3.4 4-3.4 1 0 1.9.3 2.6.8" />
      <path d="M10.8 10.2l2.8 2.8M13.6 10.2l-2.8 2.8" />
    </svg>
  ),
  activity: (
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
      <path d="M2 8.2h2.6l1.7-3.7 2.8 7 1.8-3.3H14" />
    </svg>
  ),
};
const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const generate = () =>
  Array.from(
    crypto.getRandomValues(new Uint32Array(18)),
    (n) => ALPHABET[n % ALPHABET.length],
  ).join("");

export function Avatar({
  name,
  role,
  size = 30,
}: {
  name: string;
  role: string;
  size?: number;
}) {
  return (
    <span
      className={`avatar ${role}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

type Filter = string;

export function AccountsPage({
  me,
  selected,
}: {
  me: Session;
  selected?: string;
}) {
  useLang();
  const narrow = useMedia("(max-width: 900px)");
  const initUsers = cached<Account[]>("/api/users");
  const [users, setUsers] = useState<Account[]>(() => initUsers ?? []);
  const [load, setLoad] = useState<"loading" | "error" | "ready">(() =>
    initUsers ? "ready" : "loading",
  );
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const search = useRef<HTMLInputElement | null>(null);

  const reload = () =>
    api<Account[]>("/api/users")
      .then((u) => {
        const sorted = [...u].sort((a, b) =>
          a.role === b.role
            ? a.username.localeCompare(b.username)
            : a.role === "admin"
              ? -1
              : 1,
        );
        putCached("/api/users", sorted);
        setUsers(sorted);
        setLoad("ready");
      })
      .catch((e) => {
        setMessage((e as Error).message);
        setLoad((s) => (s === "ready" ? s : "error"));
      });
  useEffect(() => {
    reload();
  }, []);

  const q = query.trim().toLowerCase();
  const { iam, reload: reloadIAM } = useIAM();
  const rolesOf = (u: Account) =>
    iam?.grants[u.username]?.roles || u.roles || [];
  const roleNames = (u: Account) =>
    rolesOf(u)
      .map((id) => {
        const found = iam?.roles.find((r) => r.id === id);
        return found ? roleTitle(found) : id;
      })
      .join(bi("、", ", "));
  const list = useMemo(
    () =>
      users.filter(
        (u) =>
          (filter === "all" || rolesOf(u).includes(filter)) &&
          u.username.includes(q),
      ),
    [users, filter, q, iam],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!can("iam.user") && !selected)
      go(
        {
          name: "accounts",
          id: can("iam.role")
            ? "~roles"
            : can("iam.team")
              ? "~teams"
              : "~audit",
        },
        { replace: true, instant: true },
      );
    else if (!narrow && !selected && load === "ready" && users.length)
      go(
        {
          name: "accounts",
          id:
            users.find((u) => u.username === me.username)?.username ||
            users[0].username,
        },
        { replace: true, instant: true },
      ); // automatic, so no transition
  }, [narrow, selected, load, users.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        document.querySelector(".pal-mask")
      )
        return;
      if (e.key === "/" && !typing(e)) {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      if (typing(e) || !list.length) return;
      const d =
        e.key === "ArrowDown" || e.key === "j"
          ? 1
          : e.key === "ArrowUp" || e.key === "k"
            ? -1
            : 0;
      if (!d) return;
      e.preventDefault();
      const i = list.findIndex((u) => u.username === selected);
      const next =
        list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + d))];
      go({ name: "accounts", id: next.username }, { replace: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, selected]);

  if (me.role !== "admin")
    return (
      <div className="page-empty enter">
        <h1>
          {bi("只有管理员可以管理账户", "Administrator access required")}
        </h1>
      </div>
    );

  const adding = selected === "+new";
  const roles = selected === "~roles";
  const teamsView = selected === "~teams";
  const auditView = selected === "~audit";
  const deletedView = selected === "~deleted";
  const current = users.find((u) => u.username === selected);

  return (
    <div className="md-split">
      {(!narrow || !selected) && (
        <aside
          className="md-list"
          aria-label={bi("账户列表", "Account list")}
        >
          <div className="list-head">
            <div className="list-title">
              <h1>IAM</h1>
              {can("iam.user") && (
                <Button
                  type="primary"
                  size="small"
                  icon={<IconPlus />}
                  onClick={() => go({ name: "accounts", id: "+new" })}
                >
                  {bi("添加用户", "Add User")}
                </Button>
              )}
            </div>
            <Input
              ref={(r) => {
                search.current =
                  (r as unknown as { dom?: HTMLInputElement })?.dom ?? null;
              }}
              prefix={<IconSearch />}
              suffix={!query ? <Kbd>/</Kbd> : undefined}
              allowClear
              placeholder={bi("搜索用户名", "Search username")}
              value={query}
              onChange={setQuery}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (query) setQuery("");
                  (e.target as HTMLElement).blur();
                }
              }}
              aria-label={bi("搜索用户名", "Search username")}
            />
            <nav className="sx-nav" aria-label="IAM">
              {[
                {
                  id: "~roles",
                  icon: AccIcons.roles,
                  title: bi("角色", "Roles"),
                  sub: iam
                    ? bi(
                        `${iam.roles.length} 个角色 · 每个能做什么`,
                        `${iam.roles.length} roles · permissions & scope`,
                      )
                    : bi("每个角色能做什么", "Permissions & scope"),
                },
                {
                  id: "~teams",
                  icon: AccIcons.teams,
                  title: bi("团队", "Teams"),
                  sub: iam
                    ? iam.teams.length
                      ? bi(
                          `${iam.teams.length} 个团队`,
                          `${iam.teams.length} ${iam.teams.length === 1 ? "team" : "teams"}`,
                        )
                      : bi("还没有团队", "No teams yet")
                    : bi("一起看、一起做交付", "Collaborate on deliveries"),
                },
                ...(can("audit.view")
                  ? [
                      {
                        id: "~audit",
                        icon: AccIcons.audit,
                        title: bi("操作审计", "Audit Log"),
                        sub: bi(
                          "谁、何时、对什么、做了什么",
                          "Who did what, when, and where",
                        ),
                      },
                    ]
                  : []),
                ...(iam && iam.deleted?.length
                  ? [
                      {
                        id: "~deleted",
                        icon: AccIcons.deleted,
                        title: bi("已删除的账户", "Deleted Accounts"),
                        sub: bi(
                          `${iam.deleted.length} 个 · 交付可以再转交`,
                          `${iam.deleted.length} · reassign deliveries`,
                        ),
                      },
                    ]
                  : []),
              ]
                .filter(
                  (x) => x.id === "~audit" || can("iam.user|iam.role|iam.team"),
                )
                .map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    className={`sx-nav-i ${selected === x.id ? "on" : ""}`}
                    aria-current={selected === x.id ? "page" : undefined}
                    onClick={() =>
                      go(
                        { name: "accounts", id: x.id },
                        { replace: !!selected },
                      )
                    }
                  >
                    <span className="sx-nav-ic">{x.icon}</span>
                    <span className="sx-nav-t">
                      <b>{x.title}</b>
                      <small>{x.sub}</small>
                    </span>
                  </button>
                ))}
            </nav>
            <div className="iam-users-h">
              {bi("用户", "Users")} <em className="num">{users.length}</em>
            </div>
            {iam && (
              <Select
                size="small"
                value={filter}
                onChange={setFilter}
                aria-label={bi("按角色筛选", "Filter by role")}
                triggerProps={{
                  autoFitPosition: true,
                  autoAlignPopupWidth: false,
                  autoAlignPopupMinWidth: true,
                }}
                options={[
                  {
                    value: "all",
                    label: bi(
                      `所有角色（${users.length}）`,
                      `All Roles (${users.length})`,
                    ),
                  },
                  ...iam.roles
                    .filter((r) => r.holders)
                    .map((r) => ({
                      value: r.id,
                      label: bi(
                        `${roleTitle(r)}（${r.holders}）`,
                        `${roleTitle(r)} (${r.holders})`,
                      ),
                    })),
                ]}
              />
            )}
          </div>
          {!can("iam.user") ? null : load === "loading" && !users.length ? (
            <div className="list-body">
              {[0, 1, 2].map((i) => (
                <div className="row-skel" key={i}>
                  <Skeleton
                    animation
                    text={{ rows: 2, width: ["45%", "65%"] }}
                  />
                </div>
              ))}
            </div>
          ) : load === "error" && !users.length ? (
            <div className="list-state">
              <IconExclamationCircle className="bad" />
              <p>{message || bi("账户加载失败", "Failed to load accounts")}</p>
              <Button size="small" icon={<IconRefresh />} onClick={reload}>
                {bi("重试", "Retry")}
              </Button>
            </div>
          ) : !list.length ? (
            <div className="list-state">
              <p>{bi("没有匹配的账户", "No matching accounts")}</p>
              <Button
                size="small"
                onClick={() => (setQuery(""), setFilter("all"))}
              >
                {bi("清除筛选", "Clear Filters")}
              </Button>
            </div>
          ) : (
            <div
              className="list-body"
              role="listbox"
              aria-label={bi("账户", "Accounts")}
            >
              {list.map((u) => (
                <a
                  key={u.username}
                  href={`#/iam/${encodeURIComponent(u.username)}`}
                  role="option"
                  aria-selected={u.username === selected}
                  className={`row acc-row ${u.username === selected ? "on" : ""}`}
                  onClick={(e) => {
                    e.preventDefault();
                    go(
                      { name: "accounts", id: u.username },
                      { replace: !!selected },
                    );
                  }}
                >
                  <Avatar name={u.username} role={u.role} />
                  <div className="row-main">
                    <div className="row-top">
                      <span className="row-name sans">
                        {u.username}
                        {u.username === me.username && (
                          <span className="you">{bi("你", "You")}</span>
                        )}
                      </span>
                      {!!u.active && (
                        <span className="sbadge s-running small-badge">
                          {bi(`${u.active} 生成中`, `${u.active} building`)}
                        </span>
                      )}
                      {u.disabled && (
                        <span className="acc-off sm">
                          {bi("已停用", "Disabled")}
                        </span>
                      )}
                    </div>
                    <div className="row-sub">
                      {roleNames(u) || roleName(u.role)} ·{" "}
                      {u.deliveries
                        ? bi(
                            `${u.deliveries} 份交付 · ${ago(u.last_delivery!)}`,
                            `${u.deliveries} ${u.deliveries === 1 ? "delivery" : "deliveries"} · ${ago(u.last_delivery!)}`,
                          )
                        : bi("还没有交付", "No deliveries")}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </aside>
      )}
      {(!narrow || selected) && (
        <section className="md-detail">
          {auditView ? (
            <div className="iam-pane">
              {narrow && (
                <div className="iam-pane-back">
                  <Button
                    type="text"
                    className="back"
                    icon={<IconArrowLeft />}
                    onClick={() => go({ name: "accounts" })}
                  >
                    IAM
                  </Button>
                </div>
              )}
              <AuditView />
            </div>
          ) : deletedView ? (
            <DeletedPane users={users} narrow={narrow} />
          ) : roles ? (
            <RolesPane narrow={narrow} />
          ) : teamsView ? (
            <TeamsPane narrow={narrow} users={users.map((u) => u.username)} />
          ) : adding ? (
            <AddAccount
              key="new"
              narrow={narrow}
              taken={(n) => users.some((u) => u.username === n)}
              refresh={async () => {
                await reload();
                reloadIAM();
              }}
              done={async (name) => {
                await reload();
                go({ name: "accounts", id: name }, { replace: true });
              }}
            />
          ) : current ? (
            <AccountDetail
              key={current.username}
              u={current}
              me={me}
              narrow={narrow}
              users={users}
              changed={() => (reload(), reloadIAM())}
            />
          ) : selected && load === "ready" ? (
            <div className="detail-none enter">
              <h2>{bi("找不到这个账户", "Account not found")}</h2>
              <Button
                onClick={() => go({ name: "accounts" }, { replace: true })}
              >
                {bi("返回账户列表", "Back to Accounts")}
              </Button>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

type Activity = {
  events: {
    time: string;
    action: string;
    job: string;
    ip?: string;
    method?: string;
    resource?: { type: string; id?: string; name?: string };
  }[];
  ai: { calls: number; errors: number; in: number; out: number; cost: number };
  currency: string;
  storage?: { used: number; quota: number; custom: boolean };
  jobs: {
    id: string;
    cluster_id: string;
    app_name: string;
    version: string;
    state: string;
    outcome?: string;
    created: string;
    delivery_mode?: string;
  }[];
};

function AccountDetail({
  u,
  me,
  narrow,
  changed,
  users,
}: {
  u: Account;
  me: Session;
  narrow: boolean;
  changed: () => void;
  users: Account[];
}) {
  useLang();
  const aiStatus = useAIStatus();
  const { iam } = useIAM();
  const [act, setAct] = useState<Activity | null>(null);
  const [busy, setBusy] = useState("");
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<"access" | "activity">("access");
  const [removing, setRemoving] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  const load = () =>
    api<Activity>(`/api/users/${u.username}/activity`)
      .then(setAct)
      .catch(() =>
        setAct({
          events: [],
          ai: { calls: 0, errors: 0, in: 0, out: 0, cost: 0 },
          currency: "CNY",
          jobs: [],
        }),
      );
  useEffect(() => {
    load();
  }, [u.username]); // eslint-disable-line react-hooks/exhaustive-deps
  const patch = async (what: string, body: Record<string, unknown>) => {
    setBusy(what);
    try {
      const r = await api<{ password?: string }>(`/api/users/${u.username}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (r.password) setPassword(r.password);
      else Message.success(bi("已保存", "Saved"));
      changed();
      load();
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };
  const remove = async () => {
    setBusy("del");
    try {
      const r = await api<{ moved: number }>(`/api/users/${u.username}`, {
        method: "DELETE",
        body: JSON.stringify({ move_to: moveTo }),
      });
      Message.success(
        r.moved
          ? bi(
              `已删除，${r.moved} 份交付交给了 ${moveTo}`,
              `Deleted; transferred ${r.moved} ${r.moved === 1 ? "delivery" : "deliveries"} to ${moveTo}`,
            )
          : bi(
              "已删除，交付和操作记录都保留着",
              "Deleted; delivery and audit records preserved",
            ),
      );
      setRemoving(false);
      changed();
      go({ name: "accounts" }, { replace: true });
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };
  const self = u.username === me.username;
  const manage = can("iam.user");
  const confirm = (
    title: string,
    content: string,
    ok: string,
    f: () => void,
    danger = false,
  ) =>
    Modal.confirm({
      title,
      content,
      okText: ok,
      cancelText: bi("取消", "Cancel"),
      okButtonProps: danger ? { status: "danger" } : undefined,
      onOk: f,
    });
  const cost = act
    ? `${act.currency === "USD" ? "$" : "¥"}${act.ai.cost >= 1 ? act.ai.cost.toFixed(2) : act.ai.cost.toFixed(4)}`
    : "—";
  const g = iam?.grants[u.username];
  return (
    <article className="iam-user enter">
      {narrow && (
        <Button
          type="text"
          className="back"
          icon={<IconArrowLeft />}
          onClick={() => go({ name: "accounts" })}
        >
          IAM
        </Button>
      )}
      <header className="iam-user-h">
        <Avatar name={u.username} role={u.role} size={64} />
        <div className="iam-user-t">
          <h1>
            {u.username}
            {self && <span className="you">{bi("你", "You")}</span>}
            {u.disabled && (
              <span className="acc-off">{bi("已停用", "Disabled")}</span>
            )}
          </h1>
          <span className="me-chips">
            {(g?.roles || []).map((id) => {
              const found = iam?.roles.find((r) => r.id === id);
              return (
                <span key={id} className="me-chip role">
                  {found ? roleTitle(found) : id}
                </span>
              );
            })}
            {(g?.teams || []).map((id) => (
              <span key={id} className="me-chip team">
                {iam?.teams.find((t) => t.id === id)?.name || id}
              </span>
            ))}
          </span>
          <p className="iam-user-facts">
            <span>
              <b className="num">{u.deliveries ?? 0}</b>{" "}
              {bi(
                "份交付",
                (u.deliveries ?? 0) === 1 ? "delivery" : "deliveries",
              )}
              {u.active
                ? bi(`（${u.active} 份生成中）`, ` (${u.active} building)`)
                : ""}
            </span>
            {aiStatus.enabled && (
              <span>
                {bi("本月 AI", "AI this month")}{" "}
                <b className="num">{act ? act.ai.calls : "—"}</b>{" "}
                {bi("次", act?.ai.calls === 1 ? "call" : "calls")} ·{" "}
                <b className="num">
                  {act ? (act.ai.in + act.ai.out).toLocaleString(getLang()) : "—"}
                </b>{" "}
                {bi("Token", "tokens")} · {bi("约", "Est.")}{" "}
                <b className="num">{cost}</b>
              </span>
            )}
            {act?.storage && (
              <span>
                {bi("存储", "Storage")}{" "}
                <b className="num">{bytesText(act.storage.used)}</b> /{" "}
                {bytesText(act.storage.quota)}
                {can("settings.storage") && (
                  <button
                    type="button"
                    className="iam-link"
                    onClick={() => editQuota(u.username, act.storage!, load)}
                  >
                    {bi("调整额度", "Adjust Quota")}
                  </button>
                )}
              </span>
            )}
            {u.last_delivery && (
              <span>
                {bi(
                  `最近一次交付 ${ago(u.last_delivery)}`,
                  `Last delivery ${ago(u.last_delivery)}`,
                )}
              </span>
            )}
          </p>
        </div>
        {manage && (
          <span className="iam-user-acts">
            <Button
              loading={busy === "pw"}
              icon={<IconLock />}
              onClick={() =>
                confirm(
                  bi(
                    `重置 ${u.username} 的密码？`,
                    `Reset password for ${u.username}?`,
                  ),
                  bi(
                    "会生成一个新密码，只显示一次；对方当前的登录会失效。",
                    "Generates a new password shown only once; all existing sessions for this user will be signed out.",
                  ),
                  bi("重置", "Reset"),
                  () => patch("pw", { reset_password: true }),
                )
              }
            >
              {bi("重置密码", "Reset Password")}
            </Button>
            {!self &&
              (u.disabled ? (
                <Button
                  loading={busy === "dis"}
                  onClick={() => patch("dis", { disabled: false })}
                >
                  {bi("启用", "Enable")}
                </Button>
              ) : (
                <Button
                  loading={busy === "dis"}
                  onClick={() =>
                    confirm(
                      bi(`停用 ${u.username}？`, `Disable ${u.username}?`),
                      bi(
                        "停用后不能登录，当前登录立即失效；交付和记录都保留，随时可以再启用。",
                        "User cannot sign in and active sessions end immediately; deliveries and logs are preserved and the account can be re-enabled anytime.",
                      ),
                      bi("停用", "Disable"),
                      () => patch("dis", { disabled: true }),
                      true,
                    )
                  }
                >
                  {bi("停用", "Disable")}
                </Button>
              ))}
            {!self && (
              <Button
                status="danger"
                icon={<IconDelete />}
                onClick={() => (setMoveTo(""), setRemoving(true))}
              >
                {bi("删除", "Delete")}
              </Button>
            )}
          </span>
        )}
        {!manage && (
          <span className="iam-ro-pill" role="status">
            {bi("只读浏览", "Read-only")}
          </span>
        )}
      </header>
      <UnderlineTabs
        className="iam-utabs"
        label={bi("账户详情分区", "Account detail tabs")}
        value={tab}
        onChange={(v) => setTab(v as "access" | "activity")}
        items={[
          {
            value: "access",
            label: bi("角色与权限", "Roles & Permissions"),
            count: (g?.roles?.length || 0) || undefined,
            icon: AccIcons.roles,
          },
          {
            value: "activity",
            label: bi("活动记录", "Activity"),
            count: act ? act.jobs.length + act.events.length : undefined,
            icon: AccIcons.activity,
          },
        ]}
      />
      {tab === "access" ? (
        <section className="iam-user-sec">
          {iam ? (
            <GrantEditor user={u.username} iam={iam} onSaved={changed} />
          ) : (
            <Skeleton animation text={{ rows: 6 }} />
          )}
        </section>
      ) : (
        <div className="iam-user-act">
          <section>
            <h2>{bi("最近的交付", "Recent Deliveries")}</h2>
            {!act ? (
              <Skeleton animation text={{ rows: 3 }} />
            ) : act.jobs.length === 0 ? (
              <p className="me-empty">
                {bi("还没有交付。", "No deliveries yet.")}
              </p>
            ) : (
              <ul className="me-rows">
                {act.jobs.map((j) => (
                  <li key={j.id}>
                    <a
                      href={`#/d/${encodeURIComponent(j.cluster_id)}/plans/${j.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        go({
                          name: "deliveries",
                          id: j.cluster_id,
                          tab: "plans",
                          plan: j.id,
                        });
                      }}
                    >
                      <span
                        className={`me-dot s-${j.outcome === "failed" ? "failed" : j.state}`}
                        aria-hidden
                      />
                      <span className="me-row-t">
                        <b className="mono">{j.cluster_id}</b>
                        <small>
                          {j.app_name} {j.version.split("·")[0].trim()}
                          {` · ${bi(
                            planTitle(j).replace(/首次部署/g, "集群部署"),
                            planTitle(j).replace(/Initial Deploy/g, "Cluster Deploy"),
                          )}`}
                        </small>
                      </span>
                      <time className="faint small" title={fullTime(j.created)}>
                        {ago(j.created)}
                      </time>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2>{bi("最近 30 天的操作", "Activity (Last 30 Days)")}</h2>
            {!act ? (
              <Skeleton animation text={{ rows: 5 }} />
            ) : act.events.length === 0 ? (
              <p className="me-empty">
                {bi(
                  "这段时间没有操作记录。",
                  "No activity during this period.",
                )}
              </p>
            ) : (
              <ol className="me-tl">
                {act.events.map((e, i) => (
                  <li
                    key={i}
                    className={e.action.includes("failed") ? "bad" : ""}
                  >
                    <i aria-hidden />
                    <span>
                      {auditText(e)}
                      {e.job && <code className="iam-ev-obj">{e.job}</code>}
                    </span>
                    <time className="faint small" title={fullTime(e.time)}>
                      {ago(e.time)}
                      {e.ip ? ` · ${e.ip}` : ""}
                    </time>
                  </li>
                ))}
              </ol>
            )}
            {can("audit.view") && (
              <Button
                type="text"
                size="small"
                onClick={() => go({ name: "accounts", id: "~audit" })}
              >
                {bi("在操作审计里查看全部", "View all in Audit Log")}{" "}
                <IconRight />
              </Button>
            )}
          </section>
        </div>
      )}
      <Modal
        visible={!!password}
        title={bi(`${u.username} 的新密码`, `New Password for ${u.username}`)}
        onCancel={() => setPassword("")}
        footer={null}
      >
        <p className="muted small">
          {bi(
            "只显示这一次，请发给对方。",
            "Shown only once—please share securely with the user.",
          )}
        </p>
        <div className="acc-pw">
          <code>{password}</code>
          <Button
            icon={<IconCopy />}
            onClick={() => {
              copy(
                bi(
                  `平台地址：${location.origin}\n用户名：${u.username}\n新密码：${password}`,
                  `Platform URL: ${location.origin}\nUsername: ${u.username}\nNew Password: ${password}`,
                ),
              );
              Message.success(bi("已复制登录信息", "Credentials copied"));
            }}
          >
            {bi("复制登录信息", "Copy Credentials")}
          </Button>
        </div>
      </Modal>
      <Modal
        visible={removing}
        title={bi(`删除账户 ${u.username}？`, `Delete account ${u.username}?`)}
        onCancel={() => setRemoving(false)}
        okText={bi("删除账户", "Delete Account")}
        cancelText={bi("取消", "Cancel")}
        okButtonProps={{ status: "danger" }}
        confirmLoading={busy === "del"}
        onOk={remove}
      >
        <div className="st-form">
          <p className="iam-del-lead">
            {aiStatus.enabled
              ? bi(
                  "删除后不能登录，这个用户名以后也不能再用。会一起删掉的：密码和登录、AI 对话、个人的技能、MCP 服务和资料。会保留的：交付记录、操作审计。",
                  "Once deleted, this user cannot sign in and the username cannot be reused. Removed: password, sessions, AI chats, personal skills, MCP servers, and files. Preserved: deliveries and audit logs.",
                )
              : bi(
                  "删除后不能登录，这个用户名以后也不能再用。会一起删掉的：密码和登录、个人存储资料。会保留的：交付记录、操作审计。",
                  "Once deleted, this user cannot sign in and the username cannot be reused. Removed: password, sessions, and personal storage files. Preserved: deliveries and audit logs.",
                )}
          </p>
          <div className="st-field">
            <span>
              {u.deliveries
                ? bi(
                    `他名下的 ${u.deliveries} 份交付交给谁`,
                    `Transfer ${u.deliveries} ${u.deliveries === 1 ? "delivery" : "deliveries"} to`,
                  )
                : bi("名下没有交付", "No deliveries under this account")}
            </span>
            {!!u.deliveries && (
              <Select
                value={moveTo}
                onChange={setMoveTo}
                triggerProps={{
                  autoFitPosition: true,
                  autoAlignPopupWidth: false,
                  autoAlignPopupMinWidth: true,
                }}
                options={[
                  {
                    value: "",
                    label: bi(
                      "先不转交（能看全部交付的人仍能看到，以后可以再转交）",
                      "Do not transfer now (global-scope users can still view and transfer later)",
                    ),
                  },
                  ...users
                    .filter((x) => x.username !== u.username && !x.disabled)
                    .map((x) => ({
                      value: x.username,
                      label: bi(`交给 ${x.username}`, `Transfer to ${x.username}`),
                    })),
                ]}
                aria-label={bi("交给谁", "Transfer to")}
              />
            )}
          </div>
        </div>
      </Modal>
    </article>
  );
}

function AddAccount({
  narrow,
  taken,
  refresh,
  done,
}: {
  narrow: boolean;
  taken: (n: string) => boolean;
  refresh: () => Promise<void>;
  done: (name: string) => Promise<void>;
}) {
  useLang();
  const [name, setName] = useState("");
  const { iam } = useIAM();
  const [roles, setRoles] = useState<string[]>(["engineer"]);
  const [teams, setTeams] = useState<string[]>([]);
  const [password, setPassword] = useState(generate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    name: string;
    password: string;
    role: string;
  } | null>(null);
  const nameError = !name
    ? ""
    : !NAME.test(name)
      ? bi(
          "小写字母开头，只含小写字母、数字和 -",
          "Must start with a lowercase letter and contain only a–z, 0–9, and -",
        )
      : taken(name)
        ? bi("这个用户名已存在", "This username already exists")
        : "";
  const pwShort = password.length < 12;

  const submit = async () => {
    if (!name || nameError || pwShort) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({ username: name, roles, teams, password }),
      });
      setCreated({
        name,
        password,
        role: roles
          .map((id) => {
            const found = iam?.roles.find((r) => r.id === id);
            return found ? roleTitle(found) : id;
          })
          .join(bi("、", ", ")),
      });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const text = bi(
      `平台地址：${location.origin}\n用户名：${created.name}\n初始密码：${created.password}`,
      `Platform URL: ${location.origin}\nUsername: ${created.name}\nInitial Password: ${created.password}`,
    );
    return (
      <article className="detail acc-detail enter">
        <header className="acc-hero">
          <span className="acc-done" aria-hidden>
            <IconCheck />
          </span>
          <div>
            <h1>{bi(`已创建 ${created.name}`, `Created ${created.name}`)}</h1>
            <span className="role-tag">{created.role}</span>
          </div>
        </header>
        <section className="dsec">
          <h2 className="dsec-title">
            {bi("发给对方的登录信息", "Credentials to Share")}
          </h2>
          <div className="cred">
            <dl>
              <div>
                <dt>{bi("平台地址", "Platform URL")}</dt>
                <dd className="mono">{location.origin}</dd>
              </div>
              <div>
                <dt>{bi("用户名", "Username")}</dt>
                <dd className="mono">{created.name}</dd>
              </div>
              <div>
                <dt>{bi("初始密码", "Initial Password")}</dt>
                <dd className="mono">{created.password}</dd>
              </div>
            </dl>
            <Button
              type="primary"
              icon={<IconCopy />}
              onClick={() => copy(text)}
            >
              {bi("复制登录信息", "Copy Credentials")}
            </Button>
          </div>
          <p className="warn small">
            {bi(
              "离开此页后不能再次查看密码，请通过安全渠道发送。",
              "This password cannot be viewed again after leaving this page—send via a secure channel.",
            )}
          </p>
        </section>
        <div className="row-gap">
          <Button onClick={() => done(created.name)}>
            {bi("查看账户", "View Account")}
          </Button>
          <Button
            type="text"
            onClick={() => {
              setCreated(null);
              setName("");
              setPassword(generate());
              done("+new");
            }}
          >
            {bi("继续添加", "Add Another")}
          </Button>
        </div>
      </article>
    );
  }

  return (
    <article className="detail acc-detail enter">
      {narrow && (
        <Button
          type="text"
          className="back"
          icon={<IconArrowLeft />}
          onClick={() => go({ name: "accounts" })}
        >
          {bi("账户", "Accounts")}
        </Button>
      )}
      <header className="acc-hero">
        <span className="acc-new" aria-hidden>
          <IconPlus />
        </span>
        <div>
          <h1>{bi("添加账户", "Create Account")}</h1>
          <span className="muted small">
            {bi(
              "创建后把登录信息发给对方",
              "Share the sign-in credentials with the user after creation",
            )}
          </span>
        </div>
      </header>
      <form
        className="acc-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="frow">
          <label className="frow-label" htmlFor="acc-name">
            {bi("用户名", "Username")}
          </label>
          <Input
            id="acc-name"
            value={name}
            onChange={(v) => setName(v.trim())}
            placeholder={bi("zhang-san", "jane-doe")}
            autoComplete="off"
            autoFocus
            status={nameError ? "error" : undefined}
            aria-label={bi("用户名", "Username")}
            className="mono-in"
          />
          <span className={`frow-hint ${nameError ? "bad" : ""}`}>
            {nameError ||
              bi(
                "小写字母开头，只含小写字母、数字和 -",
                "Start with a lowercase letter; lowercase letters, digits, and - only",
              )}
          </span>
        </div>
        <div className="frow">
          <span className="frow-label">{bi("角色", "Roles")}</span>
          {iam ? (
            <RolePicker iam={iam} value={roles} onChange={setRoles} />
          ) : (
            <Skeleton animation text={{ rows: 3 }} />
          )}
        </div>
        {iam && iam.teams.length > 0 && (
          <div className="frow">
            <span className="frow-label">{bi("团队", "Teams")}</span>
            <Select
              mode="multiple"
              value={teams}
              onChange={setTeams}
              triggerProps={{ autoFitPosition: true }}
              placeholder={bi("可以不选", "Optional")}
              options={iam.teams.map((t) => ({ value: t.id, label: t.name }))}
              allowClear
              aria-label={bi("团队", "Teams")}
              style={{ maxWidth: 520 }}
            />
          </div>
        )}
        <div className="frow">
          <label className="frow-label" htmlFor="acc-pw">
            {bi("初始密码", "Initial Password")}
          </label>
          <div className="pw-row">
            <Input.Password
              id="acc-pw"
              value={password}
              onChange={setPassword}
              visibilityToggle
              defaultVisibility
              autoComplete="new-password"
              aria-label={bi("初始密码", "Initial password")}
              className="mono-in"
              status={pwShort ? "error" : undefined}
            />
            <Button
              icon={<IconSync />}
              onClick={() => setPassword(generate())}
              aria-label={bi("重新生成密码", "Regenerate password")}
            >
              {bi("重新生成", "Regenerate")}
            </Button>
          </div>
          <span className={`frow-hint ${pwShort ? "bad" : ""}`}>
            {pwShort
              ? bi(
                  `至少 12 位，当前 ${password.length} 位`,
                  `Minimum 12 characters (currently ${password.length})`,
                )
              : bi(
                  `${password.length} 位，创建后显示一次以便发送`,
                  `${password.length} characters; shown once after creation`,
                )}
          </span>
        </div>
        <div className="login-error" role="alert">
          {error}
        </div>
        <div className="row-gap">
          <Button
            type="primary"
            htmlType="submit"
            loading={busy}
            disabled={!name || !!nameError || pwShort || roles.length === 0}
          >
            {bi("创建账户", "Create Account")}
          </Button>
          <Button
            onClick={() =>
              history.length > 1 ? history.back() : go({ name: "accounts" })
            }
          >
            {bi("取消", "Cancel")}
          </Button>
        </div>
      </form>
    </article>
  );
}

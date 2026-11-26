import { bytesText } from "../ai/myfiles";
import { editQuota } from "../settings/storageview";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
} from "../../shared/shared";
import { AuditView, auditText } from "./audit";
import type { Account, Session } from "../../shared/shared";
import { go } from "../../app/router";
import { Kbd, UnderlineTabs } from "../../design/ui";
import {
  ClusterGrantPicker,
  ClustersAccessPane,
  DeletedPane,
  GrantEditor,
  RolePicker,
  RolesPane,
  TeamsPane,
  effective,
  roleTitle,
  useIAM,
} from "./iam";
import type { ClusterAccessLevel, IAM } from "./iam";
import { bi, getLang, useLang } from "../../app/i18n";

export const roleName = (r: string) =>
  r === "admin" ? bi("管理员", "Admin") : bi("交付使用者", "Delivery User");

const icoProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  style: { display: "block", flex: "none" } as React.CSSProperties,
  "aria-hidden": true,
};

const AccIcons = {
  users: (
    <svg {...icoProps}>
      <circle cx="8" cy="5.4" r="2.5" />
      <path d="M3.2 13.4c0-2.4 2.15-4 4.8-4s4.8 1.6 4.8 4" />
    </svg>
  ),
  roles: (
    <svg {...icoProps}>
      <path d="M8 2.2L13 4.1v3.7c0 3.1-2.1 5.2-5 6-2.9-.8-5-2.9-5-6V4.1L8 2.2Z" />
      <path d="M6.1 8.1l1.3 1.3 2.6-2.7" />
    </svg>
  ),
  teams: (
    <svg {...icoProps}>
      <circle cx="6.2" cy="5.6" r="2.2" />
      <path d="M2.4 12.8c0-2 1.7-3.4 3.8-3.4s3.8 1.4 3.8 3.4" />
      <circle cx="11.2" cy="6.1" r="1.7" />
      <path d="M11.4 9.6c1.4.2 2.4 1.3 2.4 2.9" />
    </svg>
  ),
  clusters: (
    <svg {...icoProps}>
      <ellipse cx="8" cy="4.2" rx="4.8" ry="2" />
      <path d="M3.2 4.2v3.6c0 1.1 2.15 2 4.8 2s4.8-.9 4.8-2V4.2" />
      <path d="M3.2 7.8v3.8c0 1.1 2.15 2 4.8 2s4.8-.9 4.8-2V7.8" />
    </svg>
  ),
  audit: (
    <svg {...icoProps}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2.2 1.4" />
    </svg>
  ),
  deleted: (
    <svg {...icoProps}>
      <circle cx="6.5" cy="5.5" r="2.2" />
      <path d="M2.5 12.8c0-2 1.8-3.4 4-3.4 1 0 1.9.3 2.6.8" />
      <path d="M10.8 10.2l2.8 2.8M13.6 10.2l-2.8 2.8" />
    </svg>
  ),
  activity: (
    <svg {...icoProps}>
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
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    if (!can("iam.user")) {
      setLoad("ready");
      return Promise.resolve();
    }
    return api<Account[]>("/api/users")
      .then((u) => {
        const sorted = [...(u || [])].sort((a, b) =>
          a.role === b.role
            ? a.username.localeCompare(b.username)
            : a.role === "admin"
              ? -1
              : 1,
        );
        putCached("/api/users", sorted);
        if (!mountedRef.current) return;
        setUsers(sorted);
        setLoad("ready");
      })
      .catch((e) => {
        if (!mountedRef.current) return;
        setMessage((e as Error).message);
        setLoad((s) => (s === "ready" ? s : "error"));
      });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const { iam, reload: reloadIAM } = useIAM();

  // Redirect non-user-managers away from the default user directory to their permitted IAM view.
  useEffect(() => {
    if (!can("iam.user") && !selected) {
      const target = can("iam.team")
        ? "~clusters"
        : can("iam.role")
          ? "~roles"
          : "~audit";
      go({ name: "accounts", id: target }, { replace: true, instant: true });
    }
  }, [selected]);

  const hasIAMAccess =
    me.role === "admin" || can("iam.user|iam.role|iam.team|audit.view");

  const adding = selected === "+new";
  const rolesView = selected === "~roles";
  const teamsView = selected === "~teams";
  const clustersView = selected === "~clusters";
  const auditView = selected === "~audit";
  const deletedView = selected === "~deleted";
  const isUsersSection =
    !rolesView && !teamsView && !clustersView && !auditView && !deletedView;
  const current =
    isUsersSection && selected && selected !== "~users" && !adding
      ? users.find((u) => u.username === selected)
      : undefined;

  const activeNavKey = rolesView
    ? "~roles"
    : teamsView
      ? "~teams"
      : clustersView
        ? "~clusters"
        : auditView
          ? "~audit"
          : deletedView
            ? "~deleted"
            : "~users";

  const navGroups = useMemo(() => {
    const orgItems: {
      id: string;
      routeId?: string;
      icon: React.ReactNode;
      title: string;
      hint: string;
      count?: number;
    }[] = [];
    if (can("iam.user")) {
      orgItems.push({
        id: "~users",
        routeId: undefined,
        icon: AccIcons.users,
        title: bi("用户账户", "Users"),
        hint: bi("平台登录成员与个人授权", "Accounts & personal access"),
        count: users.length,
      });
    }
    if (can("iam.user|iam.role|iam.team")) {
      orgItems.push({
        id: "~teams",
        routeId: "~teams",
        icon: AccIcons.teams,
        title: bi("协作团队", "Teams"),
        hint: bi("按项目分组共享集群权限", "Group members & share clusters"),
        count: iam?.teams.length,
      });
    }
    if (can("iam.user") && iam?.deleted?.length) {
      orgItems.push({
        id: "~deleted",
        routeId: "~deleted",
        icon: AccIcons.deleted,
        title: bi("已归档账户", "Archived Users"),
        hint: bi("已删除成员的交付转交", "Reassign orphaned deliveries"),
        count: iam.deleted.length,
      });
    }

    const accessItems: typeof orgItems = [];
    if (can("iam.user|iam.team")) {
      accessItems.push({
        id: "~clusters",
        routeId: "~clusters",
        icon: AccIcons.clusters,
        title: bi("集群授权", "Cluster Access"),
        hint: bi("按集群分配运维或只读权限", "Per-cluster operate / read-only"),
        count: iam?.clusters?.length,
      });
    }
    if (can("iam.user|iam.role|iam.team")) {
      accessItems.push({
        id: "~roles",
        routeId: "~roles",
        icon: AccIcons.roles,
        title: bi("角色与矩阵", "Roles & Matrix"),
        hint: bi("功能权限集合与对比矩阵", "Role definitions & matrix"),
        count: iam?.roles.length,
      });
    }
    if (can("audit.view")) {
      accessItems.push({
        id: "~audit",
        routeId: "~audit",
        icon: AccIcons.audit,
        title: bi("操作审计", "Audit Log"),
        hint: bi("登录会话与全平台操作记录", "Sessions & activity trail"),
      });
    }

    return [
      ...(orgItems.length
        ? [{ id: "org", label: bi("成员与组织", "Members & Teams"), items: orgItems }]
        : []),
      ...(accessItems.length
        ? [{ id: "access", label: bi("权限与审计", "Access & Audit"), items: accessItems }]
        : []),
    ];
  }, [users.length, iam]);

  const flatNavItems = useMemo(
    () => navGroups.flatMap((g) => g.items),
    [navGroups],
  );

  const switchSection = (id: string) => {
    const item = flatNavItems.find((x) => x.id === id);
    go(
      { name: "accounts", id: item ? item.routeId : id === "~users" ? undefined : id },
      { replace: Boolean(selected) && !current && !adding },
    );
  };

  if (!hasIAMAccess) {
    return (
      <div className="page-empty enter">
        <h1>
          {bi("只有管理员或授权负责人可以访问 IAM", "IAM access required")}
        </h1>
      </div>
    );
  }

  return (
    <div className="iam-shell enter">
      {narrow ? (
        <div className="iam-mobile-bar">
          <UnderlineTabs
            className="iam-mobile-tabs"
            label="IAM"
            value={activeNavKey}
            onChange={switchSection}
            items={flatNavItems.map((i) => ({
              value: i.id,
              label: i.title,
              count: i.count,
              icon: i.icon,
            }))}
          />
        </div>
      ) : (
        <aside className="iam-rail" aria-label="IAM">
          <div className="iam-rail-head">
            <div className="iam-rail-title-row">
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
            <p>
              {bi(
                "统一管理登录账户、协作团队、角色权限边界与按集群访问授权。",
                "Unified identity, teams, role permissions, and per-cluster access control.",
              )}
            </p>
          </div>

          <nav className="iam-rail-nav" aria-label={bi("IAM 导航", "IAM navigation")}>
            {navGroups.map((grp) => (
              <div key={grp.id} className="iam-rail-grp">
                <div className="st-nav-g">{grp.label}</div>
                {grp.items.map((item) => {
                  const on = activeNavKey === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`sx-nav-i iam-nav-i ${on ? "on" : ""}`}
                      aria-current={on ? "page" : undefined}
                      onClick={() => switchSection(item.id)}
                    >
                      <span className="sx-nav-ic">{item.icon}</span>
                      <span className="sx-nav-t">
                        <b>{item.title}</b>
                        <small>{item.hint}</small>
                      </span>
                      {item.count !== undefined && (
                        <em className="iam-nav-cnt num">{item.count}</em>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="iam-rail-foot">
            <div className="iam-rail-rule">
              <div className="iam-rail-rule-top">
                <i className="iam-rail-rule-dot" aria-hidden />
                <b>{bi("默认隔离与授权机制", "Default Access Model")}</b>
              </div>
              <p>
                {bi(
                  "成员自己创建的集群默认归本人运维；管理员可见全部；跨人协作可在「集群授权」按需分配运维或只读权限。",
                  "Creators own their clusters by default; global roles see all; grant cross-user Operate or Read-only access per cluster.",
                )}
              </p>
            </div>
          </div>
        </aside>
      )}

      <main className="iam-canvas">
        {auditView ? (
          <AuditView />
        ) : deletedView ? (
          <DeletedPane users={users} narrow={false} />
        ) : rolesView ? (
          <RolesPane narrow={false} />
        ) : teamsView ? (
          <TeamsPane
            narrow={false}
            users={users.map((u) => u.username)}
            onSaved={() => {
              if (can("iam.user")) void reload();
            }}
          />
        ) : clustersView ? (
          <ClustersAccessPane
            narrow={false}
            users={users}
            onSaved={() => {
              if (can("iam.user")) void reload();
            }}
          />
        ) : adding ? (
          <AddAccount
            key="new"
            taken={(n) => users.some((u) => u.username === n)}
            refresh={async () => {
              await reload();
              reloadIAM();
            }}
            done={async (name) => {
              await reload();
              go(
                { name: "accounts", id: name === "+new" ? "+new" : name },
                { replace: true },
              );
            }}
          />
        ) : current ? (
          <AccountDetail
            key={current.username}
            u={current}
            me={me}
            users={users}
            changed={() => (void reload(), reloadIAM())}
          />
        ) : selected && selected !== "~users" && load === "ready" ? (
          <div className="detail-none enter">
            <h2>{bi("找不到这个账户", "Account not found")}</h2>
            <Button onClick={() => go({ name: "accounts" }, { replace: true })}>
              {bi("返回用户账户", "Back to Users")}
            </Button>
          </div>
        ) : (
          <UsersDirectory
            users={users}
            me={me}
            iam={iam}
            load={load}
            message={message}
            onReload={reload}
          />
        )}
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------- users directory */

function UsersDirectory({
  users,
  me,
  iam,
  load,
  message,
  onReload,
}: {
  users: Account[];
  me: Session;
  iam: IAM | null;
  load: "loading" | "error" | "ready";
  message: string;
  onReload: () => Promise<void>;
}) {
  useLang();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const searchRef = useRef<HTMLInputElement | null>(null);

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
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const roleMap = useMemo(
    () => new Map((iam?.roles || []).map((r) => [r.id, r])),
    [iam?.roles],
  );
  const teamMap = useMemo(
    () => new Map((iam?.teams || []).map((t) => [t.id, t])),
    [iam?.teams],
  );

  // Compute each user's effective scope, direct+team cluster grants, and owned cluster count
  const userAccessMeta = useMemo(() => {
    const ownedCountByUser = new Map<string, number>();
    for (const c of iam?.clusters || []) {
      ownedCountByUser.set(c.owner, (ownedCountByUser.get(c.owner) || 0) + 1);
    }
    const meta = new Map<
      string,
      {
        rids: string[];
        tids: string[];
        scope: string;
        ownedCount: number;
        grantedCount: number;
      }
    >();
    for (const u of users) {
      const g = iam?.grants[u.username];
      const rids = g?.roles || u.roles || [];
      const tids = g?.teams || u.teams || [];
      const scope = iam ? effective(iam, rids).scope : u.role === "admin" ? "all" : "own";
      const grantedSet = new Set<string>(Object.keys(g?.clusters || u.clusters || {}));
      for (const tid of tids) {
        const t = teamMap.get(tid);
        if (t?.clusters) {
          for (const cid of Object.keys(t.clusters)) grantedSet.add(cid);
        }
      }
      meta.set(u.username, {
        rids,
        tids,
        scope,
        ownedCount: ownedCountByUser.get(u.username) || 0,
        grantedCount: grantedSet.size,
      });
    }
    return meta;
  }, [users, iam, teamMap]);

  const stats = useMemo(() => {
    let enabled = 0;
    let globalUsers = 0;
    let collabUsers = 0;
    let totalDeliveries = 0;
    for (const u of users) {
      if (!u.disabled) enabled++;
      totalDeliveries += u.deliveries || 0;
      const m = userAccessMeta.get(u.username);
      if (m?.scope === "all") globalUsers++;
      else if ((m?.grantedCount || 0) > 0) collabUsers++;
    }
    return {
      enabled,
      disabled: users.length - enabled,
      globalUsers,
      collabUsers,
      totalDeliveries,
    };
  }, [users, userAccessMeta]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      users.filter((u) => {
        const m = userAccessMeta.get(u.username);
        const rids = m?.rids || [];
        const tids = m?.tids || [];
        if (filter === "disabled") {
          if (!u.disabled) return false;
        } else if (filter !== "all" && !rids.includes(filter)) {
          return false;
        }
        if (!q) return true;
        if (u.username.toLowerCase().includes(q)) return true;
        if (
          rids.some((id) => {
            const r = roleMap.get(id);
            return r && roleTitle(r).toLowerCase().includes(q);
          })
        )
          return true;
        if (
          tids.some((id) =>
            (teamMap.get(id)?.name || "").toLowerCase().includes(q),
          )
        )
          return true;
        return false;
      }),
    [users, userAccessMeta, filter, q, roleMap, teamMap],
  );

  return (
    <article className="iam-page enter">
      <header className="iam-h">
        <div>
          <h1>{bi("用户账户", "User Accounts")}</h1>
          <p>
            {bi(
              "管理平台登录成员，配置角色、所属团队及可访问的集群范围。点击任意成员可查看活动明细与精细授权。",
              "Manage platform accounts, assign roles and teams, and configure accessible clusters per user.",
            )}
          </p>
        </div>
        {can("iam.user") && (
          <Button
            type="primary"
            icon={<IconPlus />}
            onClick={() => go({ name: "accounts", id: "+new" })}
          >
            {bi("添加用户", "Add User")}
          </Button>
        )}
      </header>

      <div className="au-strip iam-kpi-strip">
        <div className="au-stat">
          <span className="au-stat-k">{bi("平台总账户", "Total Users")}</span>
          <strong>{users.length}</strong>
          <small>
            {bi(
              `正常启用 ${stats.enabled} · 已停用 ${stats.disabled}`,
              `${stats.enabled} active · ${stats.disabled} disabled`,
            )}
          </small>
        </div>
        <div className="au-stat">
          <span className="au-stat-k">
            {bi("全局视野成员", "Global Visibility")}
          </span>
          <strong>{stats.globalUsers}</strong>
          <small>
            {bi(
              "自动可见全平台所有集群",
              "Automatically see all platform clusters",
            )}
          </small>
        </div>
        <div className="au-stat">
          <span className="au-stat-k">
            {bi("跨集群协作成员", "Per-Cluster Collaborators")}
          </span>
          <strong>{stats.collabUsers}</strong>
          <small>
            {bi(
              "已额外分配指定集群的运维或只读权限",
              "Granted Operate or Read-only on extra clusters",
            )}
          </small>
        </div>
        <div className="au-stat">
          <span className="au-stat-k">
            {bi("名下交付与纳管记录", "Total Deliveries")}
          </span>
          <strong>{stats.totalDeliveries}</strong>
          <small>
            {bi(
              "默认归各自创建者可见与运维",
              "Owned and operated by their creators by default",
            )}
          </small>
        </div>
      </div>

      <div className="iam-toolbar">
        <Input
          ref={(r) => {
            searchRef.current =
              (r as unknown as { dom?: HTMLInputElement })?.dom ?? null;
          }}
          className="iam-search-in"
          prefix={<IconSearch />}
          suffix={!query ? <Kbd>/</Kbd> : undefined}
          allowClear
          value={query}
          onChange={setQuery}
          placeholder={bi(
            "搜索用户名、角色或所属团队...",
            "Search username, role, or team...",
          )}
          aria-label={bi("搜索用户", "Search users")}
        />
        <div className="iam-pills" role="tablist" aria-label={bi("角色筛选", "Role filter")}>
          <button
            type="button"
            className={`iam-pill ${filter === "all" ? "on" : ""}`}
            onClick={() => setFilter("all")}
          >
            {bi("全部", "All")} <em>{users.length}</em>
          </button>
          {(iam?.roles || [])
            .filter((r) => r.holders > 0)
            .map((r) => (
              <button
                key={r.id}
                type="button"
                className={`iam-pill ${filter === r.id ? "on" : ""}`}
                onClick={() => setFilter(r.id)}
              >
                {roleTitle(r)} <em>{r.holders}</em>
              </button>
            ))}
          {stats.disabled > 0 && (
            <button
              type="button"
              className={`iam-pill ${filter === "disabled" ? "on" : ""}`}
              onClick={() => setFilter("disabled")}
            >
              {bi("已停用", "Disabled")} <em>{stats.disabled}</em>
            </button>
          )}
        </div>
      </div>

      {load === "loading" && !users.length ? (
        <div className="iam-card-pad">
          <Skeleton animation text={{ rows: 5 }} />
        </div>
      ) : load === "error" && !users.length ? (
        <div className="iam-empty">
          <IconExclamationCircle className="bad" />
          <b>{message || bi("账户列表加载失败", "Failed to load accounts")}</b>
          <Button size="small" icon={<IconRefresh />} onClick={onReload}>
            {bi("重试", "Retry")}
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="iam-empty">
          <b>{bi("没有匹配的账户", "No matching accounts")}</b>
          <Button
            size="small"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            {bi("清除筛选条件", "Clear Filters")}
          </Button>
        </div>
      ) : (
        <div className="iam-ledger-card">
          <div className="iam-u-head">
            <span>{bi("成员账户", "Account")}</span>
            <span>{bi("分配角色", "Roles")}</span>
            <span>{bi("所属团队", "Teams")}</span>
            <span>{bi("集群可见范围", "Cluster Scope")}</span>
            <span>{bi("交付动态", "Deliveries")}</span>
            <span className="is-right">{bi("操作", "Actions")}</span>
          </div>
          <div className="iam-u-body">
            {filtered.map((u) => {
              const m = userAccessMeta.get(u.username);
              const isMe = u.username === me.username;
              return (
                <div
                  key={u.username}
                  className={`iam-u-row ${u.disabled ? "is-disabled" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => go({ name: "accounts", id: u.username })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      go({ name: "accounts", id: u.username });
                    }
                  }}
                >
                  <div className="iam-u-who">
                    <Avatar name={u.username} role={u.role} size={34} />
                    <div className="iam-u-who-txt">
                      <span className="iam-u-name">
                        <b>{u.username}</b>
                        {isMe && <span className="you">{bi("你", "You")}</span>}
                        {u.disabled && (
                          <span className="acc-off sm">
                            {bi("已停用", "Disabled")}
                          </span>
                        )}
                      </span>
                      <small>{roleName(u.role)}</small>
                    </div>
                  </div>

                  <div className="iam-u-chips">
                    {(m?.rids || []).map((rid) => {
                      const r = roleMap.get(rid);
                      return (
                        <span key={rid} className="iam-chip is-role">
                          {r ? roleTitle(r) : rid}
                        </span>
                      );
                    })}
                  </div>

                  <div className="iam-u-chips">
                    {m?.tids.length ? (
                      m.tids.map((tid) => (
                        <span key={tid} className="iam-chip is-team">
                          {teamMap.get(tid)?.name || tid}
                        </span>
                      ))
                    ) : (
                      <span className="faint small">—</span>
                    )}
                  </div>

                  <div className="iam-u-scope">
                    {m?.scope === "all" ? (
                      <span className="iam-scope-badge is-all">
                        {bi("全平台全部集群", "All Clusters")}
                      </span>
                    ) : (
                      <>
                        <span className="iam-scope-badge is-own">
                          {m?.scope === "team"
                            ? bi("本人及同团队", "Own & Team")
                            : bi(
                                m?.ownedCount
                                  ? `本人创建 (${m.ownedCount})`
                                  : "本人创建",
                                m?.ownedCount
                                  ? `Own (${m.ownedCount})`
                                  : "Own Only",
                              )}
                        </span>
                        {(m?.grantedCount || 0) > 0 && (
                          <span className="iam-scope-badge is-extra">
                            {bi(
                              `+ ${m!.grantedCount} 个授权集群`,
                              `+ ${m!.grantedCount} granted`,
                            )}
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  <div className="iam-u-dlv num">
                    {u.deliveries ? (
                      <>
                        <b>
                          {bi(
                            `${u.deliveries} 份`,
                            `${u.deliveries} ${u.deliveries === 1 ? "item" : "items"}`,
                          )}
                        </b>
                        {u.last_delivery && (
                          <small>{ago(u.last_delivery)}</small>
                        )}
                      </>
                    ) : (
                      <span className="faint small">
                        {bi("暂无交付", "None")}
                      </span>
                    )}
                  </div>

                  <div
                    className="iam-u-act"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      size="small"
                      onClick={() => go({ name: "accounts", id: u.username })}
                    >
                      {bi("配置权限", "Configure")}
                    </Button>
                    <IconRight className="iam-row-arrow" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}

/* ---------------------------------------------------------------- user detail */

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
  changed,
  users,
}: {
  u: Account;
  me: Session;
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
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    () =>
      api<Activity>(`/api/users/${u.username}/activity`)
        .then((res) => {
          if (mountedRef.current) setAct(res);
        })
        .catch(() => {
          if (mountedRef.current) {
            setAct({
              events: [],
              ai: { calls: 0, errors: 0, in: 0, out: 0, cost: 0 },
              currency: "CNY",
              jobs: [],
            });
          }
        }),
    [u.username],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (what: string, body: Record<string, unknown>) => {
    if (busy) return;
    setBusy(what);
    try {
      const r = await api<{ password?: string }>(`/api/users/${u.username}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (r.password) setPassword(r.password);
      else Message.success(bi("已保存", "Saved"));
      changed();
      void load();
    } catch (e) {
      err(e);
    } finally {
      if (mountedRef.current) setBusy("");
    }
  };

  const remove = async () => {
    if (busy) return;
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
      <div className="iam-crumb-bar">
        <button
          type="button"
          className="iam-crumb-back"
          onClick={() => go({ name: "accounts" })}
        >
          <IconArrowLeft />
          <span>{bi("用户账户", "User Accounts")}</span>
        </button>
        <span className="iam-crumb-sep" aria-hidden>
          /
        </span>
        <span className="iam-crumb-cur mono">{u.username}</span>
      </div>

      <header className="iam-user-h">
        <Avatar name={u.username} role={u.role} size={56} />
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
                  {act
                    ? (act.ai.in + act.ai.out).toLocaleString(getLang())
                    : "—"}
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
                    style={{ marginLeft: 6 }}
                    onClick={() => editQuota(u.username, act.storage!, load)}
                  >
                    {bi("调整额度", "Adjust Quota")}
                  </button>
                )}
              </span>
            )}
            {u.last_delivery && (
              <span className="num">
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
            label: bi("角色与集群权限", "Roles & Cluster Access"),
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
          <section className="iam-card-box">
            <h2 className="iam-card-box-title">
              {bi("名下最近的交付与集群", "Recent Deliveries")}
            </h2>
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
                          {j.app_name} {(j.version || "").split("·")[0].trim()}
                          {` · ${bi(
                            planTitle(j).replace(/首次部署/g, "集群部署"),
                            planTitle(j).replace(
                              /Initial Deploy/g,
                              "Cluster Deploy",
                            ),
                          )}`}
                        </small>
                      </span>
                      <time
                        className="faint small num"
                        title={fullTime(j.created)}
                      >
                        {ago(j.created)}
                      </time>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="iam-card-box">
            <h2 className="iam-card-box-title">
              {bi("最近 30 天的操作", "Activity (Last 30 Days)")}
            </h2>
            {!act ? (
              <Skeleton animation text={{ rows: 5 }} />
            ) : act.events.length === 0 ? (
              <p className="me-empty">
                {bi("这段时间没有操作记录。", "No activity during this period.")}
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
                    <time className="faint small num" title={fullTime(e.time)}>
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
        title={bi(
          `删除账户「${u.username}」？`,
          `Delete account “${u.username}”?`,
        )}
        onCancel={() => setRemoving(false)}
        okText={bi("确认删除", "Delete")}
        cancelText={bi("取消", "Cancel")}
        confirmLoading={busy === "del"}
        okButtonProps={{ status: "danger" }}
        onOk={remove}
      >
        <div className="st-form">
          <p className="iam-del-lead">
            {bi(
              "删除后该用户名永久归档保留，不能再注册同名账户；已有审计与历史记录完整留存。",
              "The username will be permanently retired to preserve audit integrity.",
            )}
          </p>
          <div className="st-field">
            <span>
              {u.deliveries
                ? bi(
                    `名下 ${u.deliveries} 份交付的处理方式`,
                    `How to handle ${u.deliveries} deliveries`,
                  )
                : bi("名下没有交付记录", "No deliveries under this account")}
            </span>
            {!!u.deliveries && (
              <Select
                value={moveTo}
                onChange={setMoveTo}
                triggerProps={{ autoFitPosition: true }}
                options={[
                  {
                    value: "",
                    label: bi(
                      "暂不转交（管理员可见，后续仍可在已归档账户中转交）",
                      "Do not transfer now (global-scope users can reassign later)",
                    ),
                  },
                  ...users
                    .filter((x) => x.username !== u.username && !x.disabled)
                    .map((x) => ({
                      value: x.username,
                      label: bi(`转交给 ${x.username}`, `Transfer to ${x.username}`),
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

/* ---------------------------------------------------------------- add user */

function AddAccount({
  taken,
  refresh,
  done,
}: {
  taken: (n: string) => boolean;
  refresh: () => Promise<void>;
  done: (name: string) => Promise<void>;
}) {
  useLang();
  const [name, setName] = useState("");
  const { iam } = useIAM();
  const [roles, setRoles] = useState<string[]>(["engineer"]);
  const [teams, setTeams] = useState<string[]>([]);
  const [clusters, setClusters] = useState<Record<string, ClusterAccessLevel>>(
    {},
  );
  const [password, setPassword] = useState(generate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    name: string;
    password: string;
    role: string;
  } | null>(null);
  const effScope = useMemo(
    () => (iam ? effective(iam, roles).scope : "own"),
    [iam, roles],
  );
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
    if (busy || !name || nameError || pwShort || roles.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username: name,
          roles,
          teams,
          clusters: effScope === "all" ? {} : clusters,
          password,
        }),
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
      void refresh();
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
      <article className="iam-page acc-detail enter">
        <div className="iam-crumb-bar">
          <button
            type="button"
            className="iam-crumb-back"
            onClick={() => go({ name: "accounts" })}
          >
            <IconArrowLeft />
            <span>{bi("用户账户", "User Accounts")}</span>
          </button>
        </div>
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
          <Button type="primary" onClick={() => done(created.name)}>
            {bi("查看并配置账户", "Open Account")}
          </Button>
          <Button
            onClick={() => {
              setCreated(null);
              setName("");
              setClusters({});
              setPassword(generate());
              void done("+new");
            }}
          >
            {bi("继续添加下一个", "Add Another")}
          </Button>
        </div>
      </article>
    );
  }

  return (
    <article className="iam-page acc-detail enter">
      <div className="iam-crumb-bar">
        <button
          type="button"
          className="iam-crumb-back"
          onClick={() => go({ name: "accounts" })}
        >
          <IconArrowLeft />
          <span>{bi("用户账户", "User Accounts")}</span>
        </button>
        <span className="iam-crumb-sep" aria-hidden>
          /
        </span>
        <span className="iam-crumb-cur">
          {bi("添加新账户", "Create Account")}
        </span>
      </div>

      <header className="iam-h">
        <div>
          <h1>{bi("添加用户账户", "Create User Account")}</h1>
          <p>
            {bi(
              "创建账户并设定角色与初始集群访问范围；生成的一次性初始密码将在创建完成后展示。",
              "Set up username, roles, and initial cluster access; a one-time initial password will be shown upon creation.",
            )}
          </p>
        </div>
      </header>

      <form
        className="iam-new-user-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="iam-card-box iam-form-stack">
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
                  "小写字母开头，仅支持 a–z、0–9 和连字符 -",
                  "Start with a lowercase letter; a–z, 0–9, and - only",
                )}
            </span>
          </div>

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
                htmlType="button"
                icon={<IconSync />}
                onClick={() => setPassword(generate())}
              >
                {bi("换一个", "Regenerate")}
              </Button>
            </div>
            <span className={`frow-hint ${pwShort ? "bad" : ""}`}>
              {pwShort
                ? bi(
                    `至少 12 位，当前 ${password.length} 位`,
                    `Minimum 12 characters (currently ${password.length})`,
                  )
                : bi(
                    `${password.length} 位随机强口令，创建后仅显示一次`,
                    `${password.length}-char password; shown once after creation`,
                  )}
            </span>
          </div>

          <div className="frow">
            <span className="frow-label">{bi("分配角色", "Roles")}</span>
            {iam ? (
              <RolePicker iam={iam} value={roles} onChange={setRoles} />
            ) : (
              <Skeleton animation text={{ rows: 3 }} />
            )}
          </div>

          {iam && iam.teams.length > 0 && (
            <div className="frow">
              <span className="frow-label">
                {bi("加入团队（可选）", "Teams (Optional)")}
              </span>
              <Select
                mode="multiple"
                value={teams}
                onChange={setTeams}
                triggerProps={{ autoFitPosition: true }}
                placeholder={bi("选择所属协作团队...", "Select teams...")}
                options={iam.teams.map((t) => ({ value: t.id, label: t.name }))}
                allowClear
                aria-label={bi("团队", "Teams")}
              />
            </div>
          )}

          {error && (
            <div className="acc-form-err" role="alert">
              {error}
            </div>
          )}

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
              htmlType="button"
              onClick={() =>
                history.length > 1 ? history.back() : go({ name: "accounts" })
              }
            >
              {bi("取消", "Cancel")}
            </Button>
          </div>
        </div>

        <div className="iam-card-box">
          <h3 className="iam-card-box-title">
            {bi("初始集群授权（可选）", "Initial Cluster Access (Optional)")}
          </h3>
          {effScope === "all" ? (
            <div className="iam-cl-all-note">
              <IconCheck />
              <span>
                {bi(
                  "所选角色具备全平台视野，创建后自动可查看全部集群，无需单独勾选。",
                  "Selected role grants global visibility across all clusters automatically.",
                )}
              </span>
            </div>
          ) : iam ? (
            <>
              <p className="faint small iam-cl-subhint">
                {bi(
                  "该用户后续自己创建的集群默认归其本人管理；如需让他协助运维或查看现有集群，可在下方直接点选。",
                  "Clusters created by this user will belong to them automatically; toggle existing clusters below to grant immediate access.",
                )}
              </p>
              <ClusterGrantPicker
                clusters={iam.clusters || []}
                value={clusters}
                onChange={setClusters}
              />
            </>
          ) : (
            <Skeleton animation text={{ rows: 4 }} />
          )}
        </div>
      </form>
    </article>
  );
}

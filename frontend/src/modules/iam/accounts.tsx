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
  Alert,
  Button,
  Drawer,
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
  useConnectivity,
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
import "../settings/settings.css";

export const roleName = (r: string) =>
  r === "admin" ? bi("管理员", "Admin") : bi("交付成员", "Member");

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
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
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
  const conn = useConnectivity();
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
        setMessage("");
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

  const { iam, error: iamError, reload: reloadIAM } = useIAM();

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
        hint: users.length
          ? bi(`${users.length} 位成员 · 角色与范围`, `${users.length} members & access`)
          : bi("成员账户与角色分配", "Accounts & roles"),
        count: users.length || undefined,
      });
    }
    if (can("iam.user|iam.role|iam.team")) {
      const tCnt = iam?.teams.length || 0;
      orgItems.push({
        id: "~teams",
        routeId: "~teams",
        icon: AccIcons.teams,
        title: bi("协作团队", "Teams"),
        hint: tCnt
          ? bi(`${tCnt} 个团队 · 批量共享集群`, `${tCnt} teams · shared access`)
          : bi("还没有团队 · 按组共享集群", "Share clusters by team"),
        count: iam?.teams.length,
      });
    }
    if (can("iam.user") && iam?.deleted?.length) {
      orgItems.push({
        id: "~deleted",
        routeId: "~deleted",
        icon: AccIcons.deleted,
        title: bi("已归档账户", "Archived"),
        hint: bi(`${iam.deleted.length} 个历史归档账户`, `${iam.deleted.length} archived`),
        count: iam.deleted.length,
      });
    }

    const accessItems: typeof orgItems = [];
    if (can("iam.user|iam.team")) {
      const cCnt = iam?.clusters?.length || 0;
      accessItems.push({
        id: "~clusters",
        routeId: "~clusters",
        icon: AccIcons.clusters,
        title: bi("集群权限", "Cluster Access"),
        hint: cCnt
          ? bi(`${cCnt} 个集群 · 按集群分配成员`, `${cCnt} clusters · assign members`)
          : bi("按集群分配协作成员与团队", "Per-cluster member grants"),
        count: iam?.clusters?.length,
      });
    }
    if (can("iam.user|iam.role|iam.team")) {
      const rCnt = iam?.roles.length || 4;
      accessItems.push({
        id: "~roles",
        routeId: "~roles",
        icon: AccIcons.roles,
        title: bi("角色权限", "Roles"),
        hint: bi(`${rCnt} 个角色 · 每个能做什么`, `${rCnt} roles · permissions & scope`),
        count: iam?.roles.length,
      });
    }
    if (can("audit.view")) {
      accessItems.push({
        id: "~audit",
        routeId: "~audit",
        icon: AccIcons.audit,
        title: bi("操作审计", "Audit Log"),
        hint: bi("谁、何时、对什么、做了什么", "Who did what and when"),
      });
    }

    return [
      ...(orgItems.length
        ? [{ id: "org", label: bi("组织与成员", "Directory"), items: orgItems }]
        : []),
      ...(accessItems.length
        ? [{ id: "access", label: bi("访问与审计", "Access & Audit"), items: accessItems }]
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

  const refreshAll = () => {
    void reload();
    void reloadIAM();
  };

  return (
    <div className="st-page">
      {narrow ? (
        <div className="st-mobile-bar iam-mobile-bar">
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
        <aside className="st-nav" aria-label="IAM">
          <h1>IAM</h1>
          {navGroups.map((grp) => (
            <div key={grp.id} className="st-nav-grp">
              <div className="st-nav-g">{grp.label}</div>
              {grp.items.map((item) => {
                const on = activeNavKey === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`sx-nav-i ${on ? "on" : ""}`}
                    aria-current={on ? "page" : undefined}
                    onClick={() => switchSection(item.id)}
                  >
                    <span className="sx-nav-ic">{item.icon}</span>
                    <span className="sx-nav-t">
                      <b>{item.title}</b>
                      <small>{item.hint}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </aside>
      )}

      <main className="st-body iam-canvas">
        {conn !== "online" && !auditView && (
          <div className="iam-conn-banner">
            <Alert
              type="warning"
              showIcon
              content={
                conn === "offline"
                  ? bi(
                      "当前网络连接已断开，正在展示本地缓存；恢复网络后可刷新同步最新权限。",
                      "You appear to be offline. Showing cached data until connectivity returns.",
                    )
                  : bi(
                      "暂时无法连接平台服务，请检查服务状态后重试。",
                      "Unable to reach platform service. Please retry shortly.",
                    )
              }
              action={
                <Button size="mini" onClick={refreshAll}>
                  {bi("重试", "Retry")}
                </Button>
              }
            />
          </div>
        )}

        {auditView ? (
          <AuditView />
        ) : deletedView ? (
          <DeletedPane users={users} narrow={false} iamError={iamError} />
        ) : rolesView ? (
          <RolesPane narrow={false} iamError={iamError} />
        ) : teamsView ? (
          <TeamsPane
            narrow={false}
            users={users.map((u) => u.username)}
            iamError={iamError}
            onSaved={() => {
              if (can("iam.user")) void reload();
            }}
          />
        ) : clustersView ? (
          <ClustersAccessPane
            narrow={false}
            users={users}
            iamError={iamError}
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
              void reloadIAM();
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
            changed={() => {
              void reload();
              void reloadIAM();
            }}
          />
        ) : selected && selected !== "~users" && load === "ready" ? (
          <div className="iam-page iam-stage">
            <div className="iam-empty iam-empty-line">
              <b>{bi("找不到该成员账户", "Account not found")}</b>
              <span>
                {bi(
                  "该账户可能已被删除或用户名输入有误。",
                  "This account may have been removed or renamed.",
                )}
              </span>
              <Button
                size="small"
                onClick={() => go({ name: "accounts" }, { replace: true })}
              >
                {bi("返回用户账户", "Back to Users")}
              </Button>
            </div>
          </div>
        ) : (
          <UsersDirectory
            users={users}
            me={me}
            iam={iam}
            load={load}
            message={message}
            onReload={reload}
            onChanged={() => {
              void reload();
              void reloadIAM();
            }}
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
  onChanged,
}: {
  users: Account[];
  me: Session;
  iam: IAM | null;
  load: "loading" | "error" | "ready";
  message: string;
  onReload: () => Promise<void>;
  onChanged: () => void;
}) {
  useLang();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [focusIdx, setFocusIdx] = useState<number>(-1);
  const [quickGrantUser, setQuickGrantUser] = useState<string>("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        document.querySelector(".pal-mask,.arco-modal,.arco-drawer")
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
      const scope = iam
        ? effective(iam, rids).scope
        : u.role === "admin"
          ? "all"
          : "own";
      const grantedSet = new Set<string>(
        Object.keys(g?.clusters || u.clusters || {}),
      );
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

  const counts = useMemo(() => {
    let enabled = 0;
    let globalUsers = 0;
    for (const u of users) {
      if (!u.disabled) enabled++;
      if (userAccessMeta.get(u.username)?.scope === "all") globalUsers++;
    }
    return {
      enabled,
      disabled: users.length - enabled,
      globalUsers,
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
        } else if (filter === "global") {
          if (m?.scope !== "all") return false;
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

  useEffect(() => {
    setFocusIdx(-1);
  }, [q, filter]);

  const handleRowKeyDown = (e: React.KeyboardEvent, idx: number, uname: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go({ name: "accounts", id: uname });
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(filtered.length - 1, idx + 1);
      setFocusIdx(next);
      rowRefs.current[next]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (idx === 0) {
        setFocusIdx(-1);
        searchRef.current?.focus();
      } else {
        const prev = Math.max(0, idx - 1);
        setFocusIdx(prev);
        rowRefs.current[prev]?.focus();
      }
    }
  };

  const quickUserObj = quickGrantUser
    ? users.find((u) => u.username === quickGrantUser)
    : undefined;

  return (
    <article className="iam-page iam-stage">
      <header className="iam-h">
        <div className="iam-h-main">
          <div className="iam-h-title-row">
            <h1>{bi("用户账户", "Users")}</h1>
            {users.length > 0 && (
              <span className="iam-h-meta num">
                {bi(
                  `${counts.enabled} 启用${counts.disabled ? ` · ${counts.disabled} 已停用` : ""}`,
                  `${counts.enabled} active${counts.disabled ? ` · ${counts.disabled} disabled` : ""}`,
                )}
              </span>
            )}
          </div>
          <p>
            {bi(
              "查看成员所属角色、团队与可访问的集群范围；可就地快捷调整权限，或进入详情查看近期交付与操作记录。",
              "Inspect member roles, teams, and cluster visibility; adjust permissions in place or open full activity details.",
            )}
          </p>
        </div>
        <div className="iam-h-acts">
          {can("iam.user") && (
            <Button
              type="primary"
              icon={<IconPlus />}
              onClick={() => go({ name: "accounts", id: "+new" })}
            >
              {bi("添加用户", "Add User")}
            </Button>
          )}
        </div>
      </header>

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
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "ArrowDown" && filtered.length > 0) {
              e.preventDefault();
              setFocusIdx(0);
              rowRefs.current[0]?.focus();
            }
          }}
          placeholder={bi(
            "搜索用户名、角色或团队…",
            "Search username, role, or team…",
          )}
          aria-label={bi("搜索用户", "Search users")}
        />
        <div
          className="iam-pills"
          role="tablist"
          aria-label={bi("按角色或状态筛选", "Filter by role or status")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
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
                role="tab"
                aria-selected={filter === r.id}
                className={`iam-pill ${filter === r.id ? "on" : ""}`}
                onClick={() => setFilter(filter === r.id ? "all" : r.id)}
              >
                {roleTitle(r)} <em>{r.holders}</em>
              </button>
            ))}
          {counts.disabled > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={filter === "disabled"}
              className={`iam-pill ${filter === "disabled" ? "on" : ""}`}
              onClick={() =>
                setFilter(filter === "disabled" ? "all" : "disabled")
              }
            >
              {bi("已停用", "Disabled")} <em>{counts.disabled}</em>
            </button>
          )}
        </div>
        {(q || filter !== "all") && users.length > 0 && (
          <span className="iam-toolbar-count num">
            {bi(
              `显示 ${filtered.length} / ${users.length}`,
              `${filtered.length} of ${users.length}`,
            )}
          </span>
        )}
      </div>

      {load === "loading" && !users.length ? (
        <div className="iam-skel-list">
          <Skeleton animation text={{ rows: 5 }} />
        </div>
      ) : load === "error" && !users.length ? (
        <div className="iam-empty iam-empty-line">
          <IconExclamationCircle className="bad" />
          <b>{message || bi("账户列表加载失败", "Failed to load accounts")}</b>
          <Button size="small" icon={<IconRefresh />} onClick={onReload}>
            {bi("重试", "Retry")}
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="iam-empty iam-empty-line">
          <b>{bi("没有匹配的成员账户", "No matching accounts")}</b>
          <span>
            {bi(
              "换个关键词试试，或清除角色与状态筛选。",
              "Try a different keyword or clear the active filter.",
            )}
          </span>
          <Button
            size="small"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            {bi("清除筛选", "Clear Filters")}
          </Button>
        </div>
      ) : (
        <div className="iam-ledger" role="table" aria-label={bi("用户账户列表", "Users list")}>
          <div className="iam-u-head" role="row">
            <span>{bi("成员", "Member")}</span>
            <span>{bi("角色与团队", "Roles & Teams")}</span>
            <span>{bi("可访问集群", "Cluster Scope")}</span>
            <span>{bi("交付记录", "Deliveries")}</span>
            <span className="is-right">{bi("操作", "Actions")}</span>
          </div>
          <div className="iam-u-body">
            {filtered.map((u, idx) => {
              const m = userAccessMeta.get(u.username);
              const isMe = u.username === me.username;
              const isQuickOpen = quickGrantUser === u.username;
              return (
                <div
                  key={u.username}
                  ref={(el) => {
                    rowRefs.current[idx] = el;
                  }}
                  className={`iam-u-row ${u.disabled ? "is-disabled" : ""} ${focusIdx === idx || isQuickOpen ? "is-active" : ""}`}
                  role="row"
                  tabIndex={0}
                  onClick={() => go({ name: "accounts", id: u.username })}
                  onFocus={() => setFocusIdx(idx)}
                  onKeyDown={(e) => handleRowKeyDown(e, idx, u.username)}
                >
                  <div className="iam-u-who">
                    <Avatar name={u.username} role={u.role} size={32} />
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
                        <span key={`r:${rid}`} className="iam-chip is-role">
                          {r ? roleTitle(r) : rid}
                        </span>
                      );
                    })}
                    {(m?.tids || []).map((tid) => (
                      <span key={`t:${tid}`} className="iam-chip is-team">
                        {teamMap.get(tid)?.name || tid}
                      </span>
                    ))}
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
                              `+${m!.grantedCount} 授权集群`,
                              `+${m!.grantedCount} granted`,
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
                        {bi("暂无", "None")}
                      </span>
                    )}
                  </div>

                  <div
                    className="iam-u-act"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {can("iam.user") && iam && (
                      <Button
                        size="small"
                        type="secondary"
                        onClick={() => setQuickGrantUser(u.username)}
                      >
                        {bi("快捷授权", "Quick Grant")}
                      </Button>
                    )}
                    <button
                      type="button"
                      className="iam-row-go"
                      aria-label={bi(
                        `查看 ${u.username} 详情`,
                        `Open ${u.username}`,
                      )}
                      onClick={() => go({ name: "accounts", id: u.username })}
                    >
                      <IconRight />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Drawer
        width={760}
        style={{ maxWidth: "100vw" }}
        visible={Boolean(quickUserObj && iam)}
        onCancel={() => setQuickGrantUser("")}
        footer={null}
        title={
          quickUserObj ? (
            <span className="iam-drawer-title">
              <span>{bi("快捷权限配置", "Quick Access Setup")}</span>
              <code className="mono">{quickUserObj.username}</code>
              <Button
                size="mini"
                type="text"
                onClick={() => {
                  const u = quickUserObj.username;
                  setQuickGrantUser("");
                  go({ name: "accounts", id: u });
                }}
              >
                {bi("完整详情", "Full Profile")} <IconRight />
              </Button>
            </span>
          ) : (
            ""
          )
        }
      >
        {quickUserObj && iam && (
          <GrantEditor
            user={quickUserObj.username}
            iam={iam}
            compact
            onSaved={() => {
              onChanged();
              setQuickGrantUser("");
            }}
          />
        )}
      </Drawer>
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
  const { iam, error: iamError, reload: reloadIAM } = useIAM();
  const [act, setAct] = useState<Activity | null>(null);
  const [actErr, setActErr] = useState("");
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

  const load = useCallback(() => {
    setActErr("");
    return api<Activity>(`/api/users/${u.username}/activity`)
      .then((res) => {
        if (mountedRef.current) setAct(res);
      })
      .catch((e) => {
        if (mountedRef.current) {
          setActErr((e as Error).message || bi("活动数据加载失败", "Failed to load activity"));
        }
      });
  }, [u.username]);

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
              `已删除，${r.moved} 份交付已转交给 ${moveTo}`,
              `Deleted; transferred ${r.moved} ${r.moved === 1 ? "delivery" : "deliveries"} to ${moveTo}`,
            )
          : bi(
              "账户已归档，历史交付与审计记录已完整保留",
              "Account archived; delivery and audit records preserved",
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
    <article className="iam-user iam-stage">
      <div className="iam-crumb-bar">
        <button
          type="button"
          className="iam-crumb-back"
          onClick={() => go({ name: "accounts" })}
        >
          <IconArrowLeft />
          <span>{bi("用户账户", "Users")}</span>
        </button>
        <span className="iam-crumb-sep" aria-hidden>
          /
        </span>
        <span className="iam-crumb-cur mono">{u.username}</span>
      </div>

      <header className="iam-user-h">
        <Avatar name={u.username} role={u.role} size={48} />
        <div className="iam-user-t">
          <div className="iam-user-title-line">
            <h1>{u.username}</h1>
            {self && <span className="you">{bi("你", "You")}</span>}
            {u.disabled && (
              <span className="acc-off">{bi("已停用", "Disabled")}</span>
            )}
            <span className="me-chips">
              {(g?.roles || []).map((id) => {
                const found = iam?.roles.find((r) => r.id === id);
                return (
                  <span key={id} className="iam-chip is-role">
                    {found ? roleTitle(found) : id}
                  </span>
                );
              })}
              {(g?.teams || []).map((id) => (
                <span key={id} className="iam-chip is-team">
                  {iam?.teams.find((t) => t.id === id)?.name || id}
                </span>
              ))}
            </span>
          </div>

          <p className="iam-user-facts">
            <span>
              <b className="num">{u.deliveries ?? 0}</b>{" "}
              {bi(
                "份交付",
                (u.deliveries ?? 0) === 1 ? "delivery" : "deliveries",
              )}
              {u.active
                ? bi(`（${u.active} 进行中）`, ` (${u.active} active)`)
                : ""}
            </span>
            {aiStatus.enabled && act && (
              <span>
                {bi("本月 AI", "AI (30d)")}{" "}
                <b className="num">{act.ai.calls}</b>{" "}
                {bi("次", act.ai.calls === 1 ? "call" : "calls")} ·{" "}
                <b className="num">
                  {(act.ai.in + act.ai.out).toLocaleString(getLang())}
                </b>{" "}
                {bi("Token", "tokens")} · <b className="num">{cost}</b>
              </span>
            )}
            {act?.storage && (
              <span>
                {bi("个人空间", "Storage")}{" "}
                <b className="num">{bytesText(act.storage.used)}</b> /{" "}
                {bytesText(act.storage.quota)}
                {can("settings.storage") && (
                  <button
                    type="button"
                    className="iam-link"
                    style={{ marginLeft: 6 }}
                    onClick={() => editQuota(u.username, act.storage!, load)}
                  >
                    {bi("调整额度", "Adjust")}
                  </button>
                )}
              </span>
            )}
            {u.last_delivery && (
              <span className="num">
                {bi(
                  `最近交付 ${ago(u.last_delivery)}`,
                  `Last delivery ${ago(u.last_delivery)}`,
                )}
              </span>
            )}
          </p>
        </div>

        {manage ? (
          <div className="iam-user-acts">
            <Button
              size="small"
              loading={busy === "pw"}
              icon={<IconLock />}
              onClick={() =>
                confirm(
                  bi(
                    `重置 ${u.username} 的登录密码？`,
                    `Reset password for ${u.username}?`,
                  ),
                  bi(
                    "将生成新的随机强口令（仅展示一次），该成员当前已登录的会话将立即下线。",
                    "Generates a one-time password and signs out all active sessions for this user.",
                  ),
                  bi("确认重置", "Reset"),
                  () => patch("pw", { reset_password: true }),
                )
              }
            >
              {bi("重置密码", "Reset Password")}
            </Button>
            {!self &&
              (u.disabled ? (
                <Button
                  size="small"
                  type="primary"
                  loading={busy === "dis"}
                  onClick={() => patch("dis", { disabled: false })}
                >
                  {bi("恢复启用", "Enable")}
                </Button>
              ) : (
                <Button
                  size="small"
                  loading={busy === "dis"}
                  onClick={() =>
                    confirm(
                      bi(`停用账户 ${u.username}？`, `Disable ${u.username}?`),
                      bi(
                        "停用后无法登录且现有会话立即失效；名下集群与历史记录完整保留，可随时恢复启用。",
                        "Blocks sign-in and revokes active sessions; clusters and logs remain intact.",
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
                size="small"
                status="danger"
                icon={<IconDelete />}
                onClick={() => {
                  setMoveTo("");
                  setRemoving(true);
                }}
              >
                {bi("删除", "Delete")}
              </Button>
            )}
          </div>
        ) : (
          <span className="iam-ro-pill" role="status">
            {bi("只读浏览", "Read-only")}
          </span>
        )}
      </header>

      <UnderlineTabs
        className="iam-utabs"
        label={bi("账户详情视图", "Account detail views")}
        value={tab}
        onChange={(v) => setTab(v as "access" | "activity")}
        items={[
          {
            value: "access",
            label: bi("权限与集群范围", "Roles & Cluster Access"),
            count: (g?.roles?.length || 0) || undefined,
            icon: AccIcons.roles,
          },
          {
            value: "activity",
            label: bi("交付与操作动态", "Deliveries & Activity"),
            count: act ? act.jobs.length + act.events.length : undefined,
            icon: AccIcons.activity,
          },
        ]}
      />

      {tab === "access" ? (
        <section className="iam-user-sec iam-stage" key="access">
          {iamError && !iam ? (
            <div className="iam-empty iam-empty-line">
              <IconExclamationCircle className="bad" />
              <b>{iamError}</b>
              <Button size="small" icon={<IconRefresh />} onClick={reloadIAM}>
                {bi("重试", "Retry")}
              </Button>
            </div>
          ) : iam ? (
            <GrantEditor user={u.username} iam={iam} onSaved={changed} />
          ) : (
            <Skeleton animation text={{ rows: 6 }} />
          )}
        </section>
      ) : (
        <div className="iam-user-act iam-stage" key="activity">
          {actErr && !act ? (
            <div className="iam-empty iam-empty-line" style={{ gridColumn: "1 / -1" }}>
              <IconExclamationCircle className="bad" />
              <b>{actErr}</b>
              <Button size="small" icon={<IconRefresh />} onClick={() => void load()}>
                {bi("重试", "Retry")}
              </Button>
            </div>
          ) : (
            <>
              <section className="iam-cont-sec">
                <div className="iam-cont-sec-h">
                  <h2>{bi("名下集群与交付记录", "Clusters & Deliveries")}</h2>
                  {act && <span className="num">{act.jobs.length}</span>}
                </div>
                {!act ? (
                  <Skeleton animation text={{ rows: 4 }} />
                ) : act.jobs.length === 0 ? (
                  <p className="iam-inline-empty">
                    {bi("该成员暂未创建任何交付或纳管集群。", "No deliveries or clusters created yet.")}
                  </p>
                ) : (
                  <ul className="me-rows iam-flat-rows">
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

              <section className="iam-cont-sec">
                <div className="iam-cont-sec-h">
                  <h2>{bi("近 30 天操作轨迹", "Recent Activity (30d)")}</h2>
                  {can("audit.view") && (
                    <button
                      type="button"
                      className="iam-text-act"
                      onClick={() => go({ name: "accounts", id: "~audit" })}
                    >
                      {bi("全部审计记录", "Full Audit Log")} →
                    </button>
                  )}
                </div>
                {!act ? (
                  <Skeleton animation text={{ rows: 5 }} />
                ) : act.events.length === 0 ? (
                  <p className="iam-inline-empty">
                    {bi("近 30 天内暂无操作记录。", "No activity recorded in the last 30 days.")}
                  </p>
                ) : (
                  <ol className="me-tl iam-flat-tl">
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
              </section>
            </>
          )}
        </div>
      )}

      <Modal
        visible={!!password}
        title={bi(`${u.username} 的新密码`, `New Password · ${u.username}`)}
        onCancel={() => setPassword("")}
        footer={null}
      >
        <p className="muted small">
          {bi(
            "新密码仅在此展示一次，关闭后无法再次查看，请通过安全渠道发送给本人。",
            "Shown only once—please share securely with the user.",
          )}
        </p>
        <div className="acc-pw">
          <code>{password}</code>
          <Button
            type="primary"
            icon={<IconCopy />}
            onClick={() =>
              void copy(
                bi(
                  `平台地址：${location.origin}\n用户名：${u.username}\n新密码：${password}`,
                  `Platform URL: ${location.origin}\nUsername: ${u.username}\nNew Password: ${password}`,
                ),
                bi("已复制登录凭据", "Credentials copied"),
              )
            }
          >
            {bi("复制凭据", "Copy Credentials")}
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
              "删除后该用户名将归档锁定不可复用，以保证审计链完整可追溯。",
              "The username will be permanently retired to preserve audit integrity.",
            )}
          </p>
          <div className="st-field">
            <span>
              {u.deliveries
                ? bi(
                    `名下 ${u.deliveries} 份交付与集群的归属处理`,
                    `Reassign ${u.deliveries} deliveries`,
                  )
                : bi("该账户名下暂无交付记录", "No deliveries under this account")}
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
                      "暂不转交（后续仍可在「已归档账户」中转交）",
                      "Keep unassigned for now (can reassign later)",
                    ),
                  },
                  ...users
                    .filter((x) => x.username !== u.username && !x.disabled)
                    .map((x) => ({
                      value: x.username,
                      label: bi(`转交给 ${x.username}`, `Transfer to ${x.username}`),
                    })),
                ]}
                aria-label={bi("转交目标成员", "Transfer to")}
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
          "小写字母开头，仅支持小写字母、数字和连字符 -",
          "Must start with a lowercase letter and contain only a–z, 0–9, and -",
        )
      : taken(name)
        ? bi("该用户名已存在", "This username already exists")
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
      <article className="iam-page acc-detail iam-stage">
        <div className="iam-crumb-bar">
          <button
            type="button"
            className="iam-crumb-back"
            onClick={() => go({ name: "accounts" })}
          >
            <IconArrowLeft />
            <span>{bi("用户账户", "Users")}</span>
          </button>
        </div>
        <header className="acc-hero">
          <span className="acc-done" aria-hidden>
            <IconCheck />
          </span>
          <div>
            <h1>{bi(`账户 ${created.name} 已创建`, `Created ${created.name}`)}</h1>
            <span className="iam-chip is-role">{created.role}</span>
          </div>
        </header>
        <section className="iam-cont-sec" style={{ maxWidth: 640 }}>
          <div className="iam-cont-sec-h">
            <h2>{bi("一次性初始登录凭据", "One-Time Initial Credentials")}</h2>
          </div>
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
              onClick={() =>
                void copy(text, bi("已复制登录凭据", "Credentials copied"))
              }
            >
              {bi("复制登录信息", "Copy Credentials")}
            </Button>
          </div>
          <p className="warn small" style={{ marginTop: 10 }}>
            {bi(
              "离开此页面后将无法再次查看初始密码，请立即复制并通过安全渠道发送。",
              "This password will not be shown again after leaving this page.",
            )}
          </p>
        </section>
        <div className="row-gap" style={{ marginTop: 20 }}>
          <Button type="primary" onClick={() => done(created.name)}>
            {bi("查看成员详情", "Open Profile")}
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
            {bi("继续添加下一位", "Add Another")}
          </Button>
        </div>
      </article>
    );
  }

  return (
    <article className="iam-page acc-detail iam-stage">
      <div className="iam-crumb-bar">
        <button
          type="button"
          className="iam-crumb-back"
          onClick={() => go({ name: "accounts" })}
        >
          <IconArrowLeft />
          <span>{bi("用户账户", "Users")}</span>
        </button>
        <span className="iam-crumb-sep" aria-hidden>
          /
        </span>
        <span className="iam-crumb-cur">
          {bi("添加用户", "Add User")}
        </span>
      </div>

      <header className="iam-h">
        <div className="iam-h-main">
          <h1>{bi("添加用户账户", "Add User Account")}</h1>
          <p>
            {bi(
              "设定登录用户名、角色与初始集群授权；创建完成后将生成一次性初始密码。",
              "Configure username, roles, and initial cluster access; a one-time password is generated on creation.",
            )}
          </p>
        </div>
      </header>

      <form
        className="iam-new-user-split"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="iam-form-col">
          <div className="iam-cont-sec">
            <div className="iam-cont-sec-h">
              <h2>{bi("身份与角色", "Identity & Roles")}</h2>
            </div>

            <div className="iam-form-stack">
              <div className="frow">
                <label className="frow-label" htmlFor="acc-name">
                  {bi("用户名", "Username")}
                </label>
                <Input
                  id="acc-name"
                  value={name}
                  onChange={(v) => setName(v.trim())}
                  placeholder={bi("例如：zhang-san", "e.g., jane-doe")}
                  autoComplete="off"
                  autoFocus
                  status={nameError ? "error" : undefined}
                  aria-label={bi("用户名", "Username")}
                  className="mono-in"
                />
                <span className={`frow-hint ${nameError ? "bad" : ""}`}>
                  {nameError ||
                    bi(
                      "小写字母开头，仅含 a–z、0–9 和连字符 -",
                      "Lowercase letter start; a–z, 0–9, and - only",
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
                    {bi("重新生成", "Regenerate")}
                  </Button>
                </div>
                <span className={`frow-hint ${pwShort ? "bad" : ""}`}>
                  {pwShort
                    ? bi(
                        `至少 12 位（当前 ${password.length} 位）`,
                        `Minimum 12 characters (currently ${password.length})`,
                      )
                    : bi(
                        `${password.length} 位随机强口令，创建后仅展示一次`,
                        `${password.length}-char strong password; shown once`,
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
                    {bi("加入协作团队（可选）", "Teams (Optional)")}
                  </span>
                  <Select
                    mode="multiple"
                    value={teams}
                    onChange={setTeams}
                    triggerProps={{ autoFitPosition: true }}
                    placeholder={bi("选择所属团队，自动继承团队授权集群…", "Select teams…")}
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

              <div className="iam-form-actions">
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
          </div>
        </div>

        <div className="iam-form-side">
          <div className="iam-cont-sec">
            <div className="iam-cont-sec-h">
              <h2>{bi("初始集群授权（可选）", "Initial Cluster Access (Optional)")}</h2>
            </div>
            {effScope === "all" ? (
              <div className="iam-cl-all-note">
                <IconCheck />
                <span>
                  {bi(
                    "所选角色具备全平台视野，创建后自动可查看全部集群，无需单独分配。",
                    "Selected role grants global visibility across all clusters automatically.",
                  )}
                </span>
              </div>
            ) : iam ? (
              <ClusterGrantPicker
                clusters={iam.clusters || []}
                value={clusters}
                onChange={setClusters}
                summaryMode
              />
            ) : (
              <Skeleton animation text={{ rows: 4 }} />
            )}
          </div>
        </div>
      </form>
    </article>
  );
}

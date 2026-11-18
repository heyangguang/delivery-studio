import React, { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Message,
  Modal,
  Radio,
  Select,
  Skeleton,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheck,
  IconCopy,
  IconDelete,
  IconLock,
  IconPlus,
  IconUserGroup,
} from "@arco-design/web-react/icon";
import { api, can, err, fullTime } from "./shared";
import { go } from "./router";
import { UnderlineTabs } from "./ui";
import "./iam.css";

const normPermDesc = (s?: string) =>
  s ? s.replace(/首次部署/g, "集群部署") : "";

const IAMIcons = {
  roleEdit: (
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
  roleMatrix: (
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
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M2.5 6.3h11M6.3 2.5v11" />
    </svg>
  ),
  teamAll: (
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
  teamActive: (
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
      <circle cx="6.5" cy="5.5" r="2.3" />
      <path d="M2.5 13c0-2.1 1.8-3.5 4-3.5 1.1 0 2.1.4 2.8 1" />
      <path d="M10.3 11.4l1.3 1.3 2.4-2.5" />
    </svg>
  ),
  teamEmpty: (
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
      <circle cx="8" cy="8" r="5.5" strokeDasharray="2.4 2.2" />
      <path d="M8 5.5v5M5.5 8h5" />
    </svg>
  ),
};

/* IAM: roles (sets of permissions with a reach over deliveries), teams, and what each person holds. The server checks
   the same permissions on every request; these pages only decide what to show. */

export type Perm = { id: string; module: string; title: string; desc: string };
export type Role = {
  id: string;
  name: string;
  desc?: string;
  perms: string[];
  scope: string;
  builtin?: boolean;
  holders: number;
};
export type Team = {
  id: string;
  name: string;
  desc?: string;
  members: string[];
};
export type Deleted = {
  username: string;
  at: string;
  by: string;
  jobs: number;
  moved?: string;
  moved_n?: number;
  roles?: string[];
};
export type IAM = {
  perms: Perm[];
  roles: Role[];
  teams: Team[];
  grants: Record<string, { roles: string[]; teams: string[] }>;
  deleted?: Deleted[];
};

export const SCOPES: { id: string; title: string; hint: string }[] = [
  { id: "own", title: "仅自己", hint: "只看得到自己建的交付和集群" },
  { id: "team", title: "所在团队", hint: "自己的，加上同一团队里其他人的" },
  { id: "all", title: "全部", hint: "平台上所有人的" },
];
export const scopeName = (s: string) =>
  SCOPES.find((x) => x.id === s)?.title || s;

let memo: IAM | null = null;
/** The IAM catalogue and state, shared by the pages that need it. */
export function useIAM() {
  const [d, setD] = useState<IAM | null>(memo);
  const load = () =>
    api<IAM>("/api/iam")
      .then((x) => {
        memo = x;
        setD(x);
      })
      .catch(err);
  useEffect(() => {
    load();
  }, []);
  return { iam: d, reload: load, set: (x: IAM) => ((memo = x), setD(x)) };
}

const modules = (perms: Perm[]) => {
  const m: [string, Perm[]][] = [];
  perms.forEach((p) => {
    const g = m.find(([k]) => k === p.module);
    if (g) g[1].push(p);
    else m.push([p.module, [p]]);
  });
  return m;
};

/** What a set of roles adds up to: the permissions, by module, and the widest scope. */
export function effective(iam: IAM, roleIds: string[]) {
  const ps = new Set<string>();
  let scope = "own";
  const rank: Record<string, number> = { own: 0, team: 1, all: 2 };
  roleIds.forEach((id) => {
    const r = iam.roles.find((x) => x.id === id);
    r?.perms.forEach((p) => ps.add(p));
    if (r && rank[r.scope] > rank[scope]) scope = r.scope;
  });
  return { perms: ps, scope };
}

/** A list of what someone can do, grouped by module; what they cannot do is left out. */
export function EffectivePerms({
  iam,
  perms,
  scope,
}: {
  iam: IAM;
  perms: Set<string>;
  scope: string;
}) {
  const groups = modules(iam.perms)
    .map(
      ([m, ps]) => [m, ps.filter((p) => perms.has(p.id))] as [string, Perm[]],
    )
    .filter(([, ps]) => ps.length);
  if (!groups.length)
    return <p className="faint small">没有任何权限：只能管理自己的账户。</p>;
  return (
    <div className="iam-eff">
      {perms.has("delivery.view") && (
        <p className="iam-eff-scope">
          能看到{" "}
          <b>
            {scope === "all"
              ? "所有人"
              : scope === "team"
                ? "自己和同团队"
                : "自己"}
          </b>{" "}
          的交付和集群
        </p>
      )}
      {groups.map(([m, ps]) => (
        <div key={m} className="iam-eff-g">
          <span>{m}</span>
          <span className="iam-eff-ps">
            {ps.map((p) => (
              <em key={p.id} title={normPermDesc(p.desc)}>
                {p.title}
              </em>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Choosing roles: each with what it is for and how many hold it. */
export function RolePicker({
  iam,
  value,
  onChange,
}: {
  iam: IAM;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className="iam-picks" role="group" aria-label="角色">
      {iam.roles.map((r) => {
        const on = value.includes(r.id);
        return (
          <label key={r.id} className={`iam-pick ${on ? "on" : ""}`}>
            <Checkbox
              checked={on}
              onChange={(v) =>
                onChange(v ? [...value, r.id] : value.filter((x) => x !== r.id))
              }
            />
            <span>
              <b>
                {r.name}
                {r.builtin && <small className="iam-tag">内置</small>}
                <small className="iam-scope">{scopeName(r.scope)}</small>
              </b>
              {r.desc && <small>{normPermDesc(r.desc)}</small>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Roles and teams of one person, changed in place. */
export function GrantEditor({
  user,
  iam,
  onSaved,
}: {
  user: string;
  iam: IAM;
  onSaved: () => void;
}) {
  const g = iam.grants[user] || { roles: [], teams: [] };
  const [roles, setRoles] = useState(g.roles);
  const [teams, setTeams] = useState(g.teams);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRoles(g.roles);
    setTeams(g.teams);
  }, [user, iam]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty =
    JSON.stringify([...roles].sort()) !== JSON.stringify([...g.roles].sort()) ||
    JSON.stringify([...teams].sort()) !== JSON.stringify([...g.teams].sort());
  const eff = effective(iam, roles);
  const editable = can("iam.user");
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/users/${user}/grant`, {
        method: "PUT",
        body: JSON.stringify({ roles, teams }),
      });
      Message.success("已保存，对方的下一次操作就按新权限执行");
      onSaved();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="iam-grant">
      <div className="iam-grant-cols">
        <section>
          <h3>角色</h3>
          {editable ? (
            <RolePicker iam={iam} value={roles} onChange={setRoles} />
          ) : (
            <p>
              {roles
                .map((id) => iam.roles.find((r) => r.id === id)?.name || id)
                .join("、")}
            </p>
          )}
          <h3 className="iam-gap">团队</h3>
          {editable ? (
            <Select
              mode="multiple"
              value={teams}
              onChange={setTeams}
              triggerProps={{ autoFitPosition: true }}
              placeholder={iam.teams.length ? "选择团队" : "还没有团队"}
              options={iam.teams.map((t) => ({ value: t.id, label: t.name }))}
              allowClear
              aria-label="团队"
            />
          ) : (
            <p>
              {teams
                .map((id) => iam.teams.find((t) => t.id === id)?.name || id)
                .join("、") || "不在任何团队"}
            </p>
          )}
          {editable && (
            <div className="iam-grant-foot">
              <Button
                type="primary"
                loading={busy}
                disabled={!dirty || roles.length === 0}
                onClick={save}
              >
                保存角色和团队
              </Button>
              {dirty && (
                <Button
                  type="text"
                  onClick={() => (setRoles(g.roles), setTeams(g.teams))}
                >
                  还原
                </Button>
              )}
              {roles.length === 0 && (
                <span className="bad small">至少给一个角色</span>
              )}
            </div>
          )}
        </section>
        <section>
          <h3>{dirty ? "保存后能做什么" : "能做什么"}</h3>
          <EffectivePerms iam={iam} perms={eff.perms} scope={eff.scope} />
        </section>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- roles */

type Draft = {
  id?: string;
  name: string;
  desc: string;
  perms: string[];
  scope: string;
};

export function RolesPane({ narrow }: { narrow: boolean }) {
  const { iam, set } = useIAM();
  const [sel, setSel] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState(false);
  const editable = can("iam.role");
  const role = iam?.roles.find((r) => r.id === sel) || iam?.roles[0];
  if (!iam) return <Skeleton animation text={{ rows: 8 }} />;
  const cur: Draft | null =
    draft ||
    (role
      ? {
          id: role.id,
          name: role.name,
          desc: role.desc || "",
          perms: role.perms,
          scope: role.scope,
        }
      : null);
  const locked =
    !editable ||
    (!draft && !!role?.builtin) ||
    (!!draft?.id && !!iam.roles.find((r) => r.id === draft.id)?.builtin);
  const dirty = !!draft;
  const toggle = (ids: string[], on: boolean) => {
    if (!cur) return;
    const next = new Set(cur.perms);
    ids.forEach((i) => (on ? next.add(i) : next.delete(i)));
    setDraft({
      ...cur,
      perms: iam.perms.map((p) => p.id).filter((p) => next.has(p)),
    });
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const body = JSON.stringify({
        name: draft.name,
        desc: draft.desc,
        perms: draft.perms,
        scope: draft.scope,
      });
      const next = await api<IAM>(
        draft.id ? `/api/iam/roles/${draft.id}` : "/api/iam/roles",
        { method: draft.id ? "PUT" : "POST", body },
      );
      set(next);
      const made = next.roles.find((r) => r.name === draft.name);
      setDraft(null);
      if (made) setSel(made.id);
      Message.success("已保存，有这个角色的人下一次操作就按新权限执行");
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = (r: Role) =>
    Modal.confirm({
      title: `删除角色「${r.name}」？`,
      content: r.holders
        ? `有 ${r.holders} 个人有这个角色，删除后他们会失去它带来的权限。`
        : "没有人有这个角色。",
      okText: "删除",
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          set(await api<IAM>(`/api/iam/roles/${r.id}`, { method: "DELETE" }));
          setSel("");
          setDraft(null);
        } catch (e) {
          err(e);
        }
      },
    });

  return (
    <article className="detail iam-page enter">
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
      <header className="iam-h">
        <div>
          <h1>角色</h1>
          <p>
            角色是一组权限，加上它能看到谁的交付。一个人可以有多个角色，权限合在一起算。内置角色不能改，可以复制一份再改。
          </p>
        </div>
        {editable && (
          <span className="row-gap">
            <Button
              type="primary"
              icon={<IconPlus />}
              onClick={() => (
                setCompare(false),
                setSel(""),
                setDraft({
                  name: "",
                  desc: "",
                  perms: ["delivery.view"],
                  scope: "own",
                })
              )}
            >
              新建角色
            </Button>
          </span>
        )}
      </header>
      <UnderlineTabs
        className="iam-subtabs"
        label="角色管理视图"
        value={compare ? "compare" : "edit"}
        onChange={(v) => setCompare(v === "compare")}
        items={[
          {
            value: "edit",
            label: "角色配置",
            count: iam.roles.length,
            icon: IAMIcons.roleEdit,
          },
          {
            value: "compare",
            label: "权限对比矩阵",
            count: iam.perms.length,
            icon: IAMIcons.roleMatrix,
          },
        ]}
      />
      {compare ? (
        <div className="iam-cmp-wrap">
          <table className="iam-cmp">
            <thead>
              <tr>
                <th>权限</th>
                {iam.roles.map((r) => (
                  <th key={r.id}>
                    {r.name}
                    <small>{scopeName(r.scope)}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modules(iam.perms).map(([m, ps]) => (
                <React.Fragment key={m}>
                  <tr className="iam-cmp-m">
                    <td colSpan={iam.roles.length + 1}>{m}</td>
                  </tr>
                  {ps.map((p) => (
                    <tr key={p.id}>
                      <td title={normPermDesc(p.desc)}>{p.title}</td>
                      {iam.roles.map((r) => (
                        <td
                          key={r.id}
                          className={r.perms.includes(p.id) ? "yes" : "no"}
                        >
                          {r.perms.includes(p.id) ? (
                            <IconCheck aria-label="有" />
                          ) : (
                            <span aria-label="没有">·</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="iam-split">
          <ul className="iam-roles" role="listbox" aria-label="角色">
            {iam.roles.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={draft ? draft.id === r.id : role?.id === r.id}
                  className={
                    (draft ? draft.id === r.id : role?.id === r.id) ? "on" : ""
                  }
                  onClick={() => (setDraft(null), setSel(r.id))}
                >
                  <span className="iam-role-ic">
                    {r.builtin ? <IconLock /> : <IconUserGroup />}
                  </span>
                  <span>
                    <b>{r.name}</b>
                    <small>
                      {r.perms.length} 项权限 · {scopeName(r.scope)} ·{" "}
                      {r.holders} 人
                    </small>
                  </span>
                </button>
              </li>
            ))}
            {draft && !draft.id && (
              <li>
                <button type="button" className="on">
                  <span className="iam-role-ic">
                    <IconPlus />
                  </span>
                  <span>
                    <b>{draft.name || "新角色"}</b>
                    <small>还没保存</small>
                  </span>
                </button>
              </li>
            )}
          </ul>
          {cur && (
            <section className="iam-role-ed" key={cur.id || "new"}>
              <div className="iam-role-top">
                {locked ? (
                  <div>
                    <h2>
                      {cur.name}
                      {role?.builtin && <small className="iam-tag">内置</small>}
                    </h2>
                    {cur.desc && (
                      <p className="muted">{normPermDesc(cur.desc)}</p>
                    )}
                  </div>
                ) : (
                  <div className="iam-role-names">
                    <Input
                      value={cur.name}
                      onChange={(v) => setDraft({ ...cur, name: v })}
                      placeholder="角色名，例如：一组交付工程师"
                      maxLength={30}
                      aria-label="角色名"
                    />
                    <Input
                      value={cur.desc}
                      onChange={(v) => setDraft({ ...cur, desc: v })}
                      placeholder="一句话说明这个角色是做什么的"
                      maxLength={200}
                      aria-label="说明"
                    />
                  </div>
                )}
                <span className="row-gap">
                  {editable && role && !draft && (
                    <Button
                      icon={<IconCopy />}
                      onClick={() =>
                        setDraft({
                          name: `${role.name}（副本）`,
                          desc: role.desc || "",
                          perms: role.perms,
                          scope: role.scope,
                        })
                      }
                    >
                      复制为新角色
                    </Button>
                  )}
                  {editable && role && !role.builtin && !draft && (
                    <Button
                      status="danger"
                      icon={<IconDelete />}
                      onClick={() => remove(role)}
                      aria-label="删除角色"
                    />
                  )}
                </span>
              </div>
              {locked && (
                <p className="iam-ro-hint" role="status">
                  {!editable
                    ? "当前账户无角色管理权限，仅可查看角色配置。"
                    : "内置角色不可直接修改；可点击右上角「复制为新角色」后按需调整权限。"}
                </p>
              )}
              <div className="iam-sec">
                <h3>能看到谁的交付和集群</h3>
                <Radio.Group
                  type="button"
                  value={cur.scope}
                  disabled={locked}
                  onChange={(v) => setDraft({ ...cur, scope: v })}
                >
                  {SCOPES.map((s) => (
                    <Radio key={s.id} value={s.id}>
                      {s.title}
                    </Radio>
                  ))}
                </Radio.Group>
                <p className="faint small">
                  {SCOPES.find((s) => s.id === cur.scope)?.hint}
                  ；只对有「查看交付和集群」的人生效。
                </p>
              </div>
              <div className="iam-sec">
                <h3>
                  权限 <em className="num">{cur.perms.length}</em>
                </h3>
                <div className="iam-tree">
                  {modules(iam.perms).map(([m, ps]) => {
                    const n = ps.filter((p) => cur.perms.includes(p.id)).length;
                    return (
                      <div key={m} className="iam-mod">
                        <label className="iam-mod-h">
                          <Checkbox
                            checked={n === ps.length}
                            indeterminate={n > 0 && n < ps.length}
                            disabled={locked}
                            onChange={(v) =>
                              toggle(
                                ps.map((p) => p.id),
                                v,
                              )
                            }
                          />
                          <b>{m}</b>
                          <small>
                            {n} / {ps.length}
                          </small>
                        </label>
                        <div className="iam-perms">
                          {ps.map((p) => (
                            <label
                              key={p.id}
                              className={`iam-perm ${cur.perms.includes(p.id) ? "on" : ""}`}
                            >
                                <Checkbox
                                  checked={cur.perms.includes(p.id)}
                                  disabled={locked}
                                  onChange={(v) => toggle([p.id], v)}
                                />
                                <span>
                                  <b>{p.title}</b>
                                  <small>{normPermDesc(p.desc)}</small>
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {dirty && (
                  <div className="iam-save">
                    <span className="faint small">你只能授出自己有的权限。</span>
                    <Button onClick={() => setDraft(null)}>取消</Button>
                    <Button
                      type="primary"
                      loading={busy}
                      disabled={!draft!.name.trim()}
                      onClick={save}
                    >
                      {draft!.id ? "保存" : "创建角色"}
                    </Button>
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </article>
    );
  }

  /* ---------------------------------------------------------------- teams */

  export function TeamsPane({
    narrow,
    users,
  }: {
    narrow: boolean;
    users: string[];
  }) {
    const { iam, set } = useIAM();
    const [edit, setEdit] = useState<{
      id?: string;
      name: string;
      desc: string;
      members: string[];
    } | null>(null);
    const [tab, setTab] = useState<"all" | "active" | "empty">("all");
    const [busy, setBusy] = useState(false);
    const editable = can("iam.team");
    const sorted = useMemo(() => [...users].sort(), [users]);
    if (!iam) return <Skeleton animation text={{ rows: 6 }} />;
    const activeCount = iam.teams.filter((t) => t.members.length > 0).length;
    const emptyCount = iam.teams.length - activeCount;
    const shownTeams = iam.teams.filter((t) =>
      tab === "active"
        ? t.members.length > 0
        : tab === "empty"
          ? t.members.length === 0
          : true,
    );
    const save = async () => {
      if (!edit) return;
      setBusy(true);
      try {
        set(
          await api<IAM>(
            edit.id ? `/api/iam/teams/${edit.id}` : "/api/iam/teams",
            { method: edit.id ? "PUT" : "POST", body: JSON.stringify(edit) },
          ),
        );
        setEdit(null);
        Message.success("已保存");
      } catch (e) {
        err(e);
      } finally {
        setBusy(false);
      }
    };
    return (
      <article className="detail iam-page enter">
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
        <header className="iam-h">
          <div>
            <h1>团队</h1>
            <p>
              同一团队的人，如果角色的数据范围是「所在团队」，就能看到彼此的交付和集群，一起执行和处理。
            </p>
          </div>
          {editable && (
            <Button
              type="primary"
              icon={<IconPlus />}
              onClick={() => setEdit({ name: "", desc: "", members: [] })}
            >
              新建团队
            </Button>
          )}
        </header>
        {iam.teams.length > 0 && (
          <UnderlineTabs
            className="iam-subtabs"
            label="团队筛选"
            value={tab}
            onChange={(v) => setTab(v as "all" | "active" | "empty")}
            items={[
              {
                value: "all",
                label: "全部团队",
                count: iam.teams.length,
                icon: IAMIcons.teamAll,
              },
              {
                value: "active",
                label: "已有成员",
                count: activeCount,
                icon: IAMIcons.teamActive,
              },
              ...(emptyCount > 0
                ? [
                    {
                      value: "empty",
                      label: "待添加成员",
                      count: emptyCount,
                      icon: IAMIcons.teamEmpty,
                    },
                  ]
                : []),
            ]}
          />
        )}
        {iam.teams.length === 0 ? (
          <div className="iam-empty">
            <IconUserGroup />
            <b>还没有团队</b>
            <span>按负责的项目或现场分组，组内的交付就能一起看、一起做。</span>
          </div>
        ) : shownTeams.length === 0 ? (
          <div className="iam-empty">
            <IconUserGroup />
            <b>当前筛选下没有团队</b>
            <Button size="small" onClick={() => setTab("all")}>
              查看全部团队
            </Button>
          </div>
        ) : (
          <ul className="iam-teams">
            {shownTeams.map((t) => (
            <li key={t.id}>
              <div className="iam-team-h">
                <span className="iam-role-ic">
                  <IconUserGroup />
                </span>
                <span>
                  <b>{t.name}</b>
                  <small>{t.desc || `${t.members.length} 人`}</small>
                </span>
                {editable && (
                  <span className="row-gap">
                    <Button
                      size="small"
                      onClick={() =>
                        setEdit({
                          id: t.id,
                          name: t.name,
                          desc: t.desc || "",
                          members: t.members,
                        })
                      }
                    >
                      编辑
                    </Button>
                    <Button
                      size="small"
                      status="danger"
                      icon={<IconDelete />}
                      aria-label="删除团队"
                      onClick={() =>
                        Modal.confirm({
                          title: `删除团队「${t.name}」？`,
                          content: "成员不会被删除，只是不再同属这个团队。",
                          okText: "删除",
                          okButtonProps: { status: "danger" },
                          onOk: async () => {
                            try {
                              set(
                                await api<IAM>(`/api/iam/teams/${t.id}`, {
                                  method: "DELETE",
                                }),
                              );
                            } catch (e) {
                              err(e);
                            }
                          },
                        })
                      }
                    />
                  </span>
                )}
              </div>
              <div className="iam-members">
                {t.members.length ? (
                  t.members.map((m) => (
                    <a
                      key={m}
                      href={`#/iam/${m}`}
                      onClick={(e) => {
                        e.preventDefault();
                        go({ name: "accounts", id: m }, { replace: true });
                      }}
                    >
                      {m}
                    </a>
                  ))
                ) : (
                  <span className="faint small">还没有成员</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal
        visible={!!edit}
        title={edit?.id ? "编辑团队" : "新建团队"}
        onCancel={() => setEdit(null)}
        okText="保存"
        confirmLoading={busy}
        okButtonProps={{ disabled: !edit?.name.trim() }}
        onOk={save}
      >
        {edit && (
          <div className="st-form">
            <div className="st-field">
              <span>团队名</span>
              <Input
                value={edit.name}
                onChange={(v) => setEdit({ ...edit, name: v })}
                placeholder="华东交付一组"
                maxLength={30}
                aria-label="团队名"
              />
            </div>
            <div className="st-field">
              <span>说明（可选）</span>
              <Input
                value={edit.desc}
                onChange={(v) => setEdit({ ...edit, desc: v })}
                maxLength={200}
                aria-label="说明"
              />
            </div>
            <div className="st-field">
              <span>成员</span>
              <Select
                mode="multiple"
                value={edit.members}
                onChange={(v) => setEdit({ ...edit, members: v })}
                triggerProps={{ autoFitPosition: true }}
                options={sorted.map((u) => ({ value: u, label: u }))}
                placeholder="选择成员"
                allowClear
                aria-label="成员"
              />
            </div>
          </div>
        )}
      </Modal>
    </article>
  );
}

/* ---------------------------------------------------------------- removed accounts */

export function DeletedPane({
  users,
  narrow,
}: {
  users: { username: string; disabled?: boolean }[];
  narrow: boolean;
}) {
  const { iam, reload } = useIAM();
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  if (!iam) return <Skeleton animation text={{ rows: 5 }} />;
  const move = async (d: Deleted) => {
    const to = pick[d.username];
    if (!to) return;
    setBusy(d.username);
    try {
      const r = await api<{ moved: number }>(
        `/api/iam/deleted/${d.username}/move`,
        { method: "POST", body: JSON.stringify({ move_to: to }) },
      );
      Message.success(`${r.moved} 份交付已交给 ${to}`);
      reload();
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };
  return (
    <article className="detail iam-page enter">
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
      <header className="iam-h">
        <div>
          <h1>已删除的账户</h1>
          <p>
            这些用户名不会再分配给别人。他们名下还留着的交付，能看全部交付的人仍然看得到，也可以交给现在的同事接手。
          </p>
        </div>
      </header>
      <ul className="iam-dels">
        {(iam.deleted || [])
          .slice()
          .reverse()
          .map((d) => (
            <li key={d.username}>
              <span className="iam-del-name">
                <b className="mono">{d.username}</b>
                <small>
                  {d.by} 在 {fullTime(d.at)} 删除
                  {d.moved
                    ? ` · ${d.moved_n || 0} 份交付已交给 ${d.moved}`
                    : ""}
                </small>
              </span>
              <span className="iam-del-jobs">
                {d.jobs ? `名下还有 ${d.jobs} 份交付` : "名下没有交付"}
              </span>
              {d.jobs > 0 && can("iam.user") && (
                <span className="row-gap">
                  <Select
                    style={{ minWidth: 200 }}
                    placeholder="交给谁"
                    value={pick[d.username]}
                    onChange={(v) => setPick({ ...pick, [d.username]: v })}
                    triggerProps={{
                      autoFitPosition: true,
                      autoAlignPopupWidth: false,
                      autoAlignPopupMinWidth: true,
                      position: "br",
                    }}
                    options={users
                      .filter((u) => !u.disabled)
                      .map((u) => ({ value: u.username, label: u.username }))}
                    aria-label="交给谁"
                  />
                  <Button
                    type="primary"
                    loading={busy === d.username}
                    disabled={!pick[d.username]}
                    onClick={() => move(d)}
                  >
                    转交
                  </Button>
                </span>
              )}
            </li>
          ))}
      </ul>
    </article>
  );
}

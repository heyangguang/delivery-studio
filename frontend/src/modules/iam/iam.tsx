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
  IconClose,
  IconCopy,
  IconDelete,
  IconLock,
  IconPlus,
  IconRight,
  IconSearch,
  IconStorage,
  IconUser,
  IconUserGroup,
} from "@arco-design/web-react/icon";
import { api, can, err, fullTime, refreshAIStatus } from "../../shared/shared";
import type { Account, ClusterAccessLevel } from "../../shared/shared";
import { go } from "../../app/router";
import { UnderlineTabs } from "../../design/ui";
import { bi, biv, useLang } from "../../app/i18n";
import "./iam.css";

const normPermDesc = (s?: string) =>
  s ? s.replace(/首次部署/g, "集群部署") : "";

const MODULE_EN: Record<string, string> = {
  交付: "Delivery",
  组件: "Components",
  软件库: "Software Library",
  安全: "Security",
  AI: "AI",
  知识库: "Knowledge Base",
  IAM: "IAM",
  设置: "Settings",
};

const PERM_EN: Record<string, [string, string]> = {
  "delivery.view": [
    "View deliveries & clusters",
    "View delivery list, details, runbooks, and execution logs; visibility follows role data scope",
  ],
  "delivery.create": [
    "Create deliveries",
    "Fill specs and generate cluster deployment or config delivery packages",
  ],
  "delivery.download": [
    "Download delivery bundles",
    "Download full delivery archives and individual files",
  ],
  "delivery.run": [
    "Execute & log steps",
    "Record step results, mark deployment outcome, and accept AI runbook amendments",
  ],
  "delivery.delete": [
    "Delete deliveries",
    "Delete deliveries and their generated materials",
  ],
  "report.edit": [
    "Edit documents",
    "Edit and confirm delivery reports, handover docs, change plans, and RCA docs; run AI draft & check",
  ],
  "report.export": [
    "Export documents",
    "Export cluster documents to Word, individually or combined",
  ],
  "component.edit": [
    "Edit components",
    "Create and edit drafts, fork components, and use Component AI in Workbench",
  ],
  "component.publish": [
    "Publish components",
    "Publish drafts, restore revisions, revert built-in versions, and delete components",
  ],
  "component.import": ["Import components", "Import component packages"],
  "library.manage": [
    "Manage software library",
    "Download, import, and delete packages; update, import, and export repo indexes",
  ],
  "library.runtime": [
    "Manage runtimes",
    "Build, import, and set default Ansible runtimes; upload Python packages",
  ],
  "security.view": [
    "View Security Center",
    "Browse platform-wide CVE findings, affected clusters/components, and export reports & SBOM",
  ],
  "security.scan": [
    "Run scans & sync advisory DB",
    "Trigger offline scans, sync OSV advisories online, and import/export offline advisory bundles",
  ],
  "security.manage": [
    "Manage VEX triage & gates",
    "Record vulnerability triage/waivers and configure release/delivery security policy gates",
  ],
  "ai.use": [
    "Use AI (master gate)",
    "Required before any individual AI sub-feature below can be enabled for this role",
  ],
  "ai.feat.assistant": [
    "AI Assistant",
    "Top-bar AI chat workspace and general Q&A",
  ],
  "ai.feat.kb": [
    "Knowledge Base & RAG",
    "Top-bar Knowledge Base tab and AI knowledge retrieval",
  ],
  "ai.feat.skills": [
    "AI Skills",
    "Top-bar Skills tab and invoking platform/personal skills in chat",
  ],
  "ai.feat.mcp": [
    "MCP Servers",
    "Top-bar MCP tab and calling external MCP tools in chat",
  ],
  "ai.feat.component": [
    "Component AI",
    "Component Workbench chat, AI draft proposals, AI revision notes, and reviews",
  ],
  "ai.feat.form": [
    "Smart Form Fill",
    "Chat with AI to auto-fill specs when creating deliveries",
  ],
  "ai.feat.review": [
    "Delivery Review",
    "Ask AI to review delivery plans and risks on delivery details",
  ],
  "ai.feat.troubleshoot": [
    "Troubleshooting",
    "Diagnose runbook and execution monitor errors/screenshots with AI",
  ],
  "ai.feat.change_rehearsal": [
    "Change Rehearsal",
    "Run read-only probes and staging rehearsals on delivered clusters to generate SOPs",
  ],
  "ai.feat.docs": [
    "Doc Drafting",
    "Draft and verify delivery, handover, and RCA documents with AI",
  ],
  "ai.feat.library": [
    "Software Library AI",
    "Analyze Ansible runtime dependencies and upgrades from Software Library",
  ],
  "ai.feat.security": [
    "Security AI",
    "On-demand CVE impact analysis, exploitability review, and mitigation guidance in Security Center",
  ],
  "ai.settings": [
    "AI settings",
    "Global AI switch, per-module AI switches, model providers, web search, skills, and MCP servers",
  ],
  "ai.usage": [
    "View AI usage",
    "View all users' AI invocation logs, usage, and cost",
  ],
  "kb.view": [
    "Use team knowledge base",
    "Browse team KB articles; AI queries it during responses",
  ],
  "kb.submit": [
    "Submit to team KB",
    "Submit docs or troubleshooting notes to the team KB for review",
  ],
  "kb.manage": [
    "Manage team KB",
    "Approve or reject submissions, and edit or delete team KB entries",
  ],
  "iam.user": [
    "Manage users",
    "Add users, reset passwords, disable/enable accounts, and assign roles and teams",
  ],
  "iam.role": [
    "Manage roles",
    "Create and edit role permissions and data scopes",
  ],
  "iam.team": ["Manage teams", "Create teams and update membership"],
  "audit.view": [
    "View audit log",
    "View platform-wide activity and session audit logs",
  ],
  "execution.manage": [
    "Manage execution nodes",
    "Enroll execution nodes, scope clusters/hosts, and pause or resume nodes",
  ],
  "delivery.execute": [
    "Start automated execution",
    "Authorize execution after host/step checks, pause, resume, and close runs",
  ],
  "settings.notify": [
    "Notification settings",
    "Configure notification channels, rules, and templates",
  ],
  "settings.report": [
    "Report templates",
    "Configure organization name, classification, headers/footers, and cover notes for Word exports",
  ],
  "settings.storage": [
    "Storage settings",
    "Configure default per-user storage quota and max file upload size",
  ],
  "settings.sandbox": [
    "Code sandbox settings",
    "Enable/disable AI code sandbox, set time/memory limits, and run self-checks",
  ],
};

const BUILTIN_ROLE_EN: Record<string, [string, string]> = {
  sysadmin: [
    "System Admin",
    "Full platform administration: users, roles, settings, components, and library across all deliveries",
  ],
  engineer: [
    "Delivery Engineer",
    "Create, download, and execute own deliveries, and use Change Rehearsal & troubleshooting AI when enabled",
  ],
  maintainer: [
    "Component Maintainer",
    "Maintain components and software library: edit/publish components, prepare packages and runtimes",
  ],
  auditor: [
    "Read-Only Auditor",
    "Read-only visibility across all deliveries, audit logs, and AI usage",
  ],
  系统管理员: [
    "System Admin",
    "Full platform administration: users, roles, settings, components, and library across all deliveries",
  ],
  交付工程师: [
    "Delivery Engineer",
    "Create, download, and execute own deliveries, and use Change Rehearsal & troubleshooting AI when enabled",
  ],
  组件维护者: [
    "Component Maintainer",
    "Maintain components and software library: edit/publish components, prepare packages and runtimes",
  ],
  只读审计员: [
    "Read-Only Auditor",
    "Read-only visibility across all deliveries, audit logs, and AI usage",
  ],
};

export const permModule = (m: string) => bi(m, MODULE_EN[m] || m);
export const permTitle = (p: { id: string; title: string }) =>
  bi(p.title, PERM_EN[p.id]?.[0] || p.title);
export const permDesc = (p: { id: string; desc?: string }) =>
  bi(normPermDesc(p.desc), PERM_EN[p.id]?.[1] || normPermDesc(p.desc));
export const roleTitle = (r: { id?: string; name: string }) =>
  bi(
    r.name,
    (r.id && BUILTIN_ROLE_EN[r.id]?.[0]) ||
      BUILTIN_ROLE_EN[r.name]?.[0] ||
      r.name,
  );
export const roleDesc = (r: { id?: string; desc?: string }) =>
  bi(
    normPermDesc(r.desc),
    (r.id && BUILTIN_ROLE_EN[r.id]?.[1]) || normPermDesc(r.desc),
  );

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

export type { ClusterAccessLevel };
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
  clusters?: Record<string, ClusterAccessLevel>;
};
export type IAMCluster = {
  id: string;
  app_id: string;
  app_name: string;
  version: string;
  owner: string;
  delivery_mode?: string;
  created: string;
  users: Record<string, ClusterAccessLevel>;
  teams: Record<string, ClusterAccessLevel>;
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
  grants: Record<
    string,
    {
      roles: string[];
      teams: string[];
      clusters?: Record<string, ClusterAccessLevel>;
    }
  >;
  clusters?: IAMCluster[];
  deleted?: Deleted[];
};

const LEVEL_RANK: Record<string, number> = { "": 0, view: 1, operate: 2 };

export const clusterLevelLabel = (lvl: ClusterAccessLevel) =>
  lvl === "operate"
    ? bi("运维管理", "Operate")
    : bi("只读查看", "Read-only");

const stableClusterEntries = (m?: Record<string, ClusterAccessLevel>) =>
  Object.entries(m || {})
    .filter(([, v]) => v === "view" || v === "operate")
    .sort(([a], [b]) => a.localeCompare(b));

const sameClusterMap = (
  a?: Record<string, ClusterAccessLevel>,
  b?: Record<string, ClusterAccessLevel>,
) =>
  JSON.stringify(stableClusterEntries(a)) ===
  JSON.stringify(stableClusterEntries(b));

function LevelToggle({
  value,
  onChange,
  disabled,
}: {
  value: ClusterAccessLevel;
  onChange: (v: ClusterAccessLevel) => void;
  disabled?: boolean;
}) {
  useLang();
  return (
    <span
      className={`iam-lvl-toggle ${disabled ? "is-disabled" : ""}`}
      role="radiogroup"
      aria-label={bi("集群访问级别", "Cluster access level")}
    >
      <button
        type="button"
        role="radio"
        aria-checked={value === "operate"}
        disabled={disabled}
        className={value === "operate" ? "on is-op" : ""}
        onClick={() => onChange("operate")}
      >
        {bi("运维管理", "Operate")}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "view"}
        disabled={disabled}
        className={value === "view" ? "on is-view" : ""}
        onClick={() => onChange("view")}
      >
        {bi("只读查看", "Read-only")}
      </button>
    </span>
  );
}

/** Searchable cluster grant picker shared by User Grant, New User, and Team editors. */
export function ClusterGrantPicker({
  clusters,
  value,
  onChange,
  disabled,
  ownedBy,
  inherited,
}: {
  clusters: IAMCluster[];
  value: Record<string, ClusterAccessLevel>;
  onChange: (next: Record<string, ClusterAccessLevel>) => void;
  disabled?: boolean;
  ownedBy?: string;
  inherited?: Record<string, { level: ClusterAccessLevel; from: string[] }>;
}) {
  useLang();
  const byId = useMemo(
    () => new Map(clusters.map((c) => [c.id, c])),
    [clusters],
  );
  const entries = useMemo(() => stableClusterEntries(value), [value]);
  const addable = useMemo(
    () =>
      clusters.filter(
        (c) => !value[c.id] && (!ownedBy || c.owner !== ownedBy),
      ),
    [clusters, value, ownedBy],
  );
  const inheritedOnly = useMemo(() => {
    if (!inherited) return [];
    return Object.entries(inherited)
      .filter(([cid]) => !ownedBy || byId.get(cid)?.owner !== ownedBy)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [inherited, ownedBy, byId]);

  const addCluster = (cid: string) => {
    if (!cid || value[cid]) return;
    onChange({ ...value, [cid]: "operate" });
  };
  const setLevel = (cid: string, lvl: ClusterAccessLevel) => {
    onChange({ ...value, [cid]: lvl });
  };
  const removeCluster = (cid: string) => {
    const next = { ...value };
    delete next[cid];
    onChange(next);
  };

  return (
    <div className="iam-cl-picker">
      {!disabled && (
        <Select
          value={undefined}
          showSearch
          allowClear
          placeholder={
            addable.length
              ? bi("搜索并添加授权集群...", "Search and add a cluster...")
              : clusters.length
                ? bi("所有可分配集群均已添加", "All assignable clusters added")
                : bi("暂无可分配的集群", "No clusters available")
          }
          disabled={addable.length === 0}
          onChange={(v) => {
            if (typeof v === "string" && v) addCluster(v);
          }}
          filterOption={(input, opt) => {
            const q = input.trim().toLowerCase();
            if (!q) return true;
            const cid = String(opt?.props?.value || "");
            const cl = byId.get(cid);
            return (
              cid.toLowerCase().includes(q) ||
              (cl?.app_name || "").toLowerCase().includes(q) ||
              (cl?.owner || "").toLowerCase().includes(q)
            );
          }}
          triggerProps={{ autoFitPosition: true }}
          aria-label={bi("添加授权集群", "Add authorized cluster")}
        >
          {addable.map((c) => (
            <Select.Option key={c.id} value={c.id}>
              <span className="iam-cl-opt">
                <b className="mono">{c.id}</b>
                <small>
                  {c.app_name} {c.version}
                  {c.owner ? ` · ${c.owner}` : ""}
                </small>
              </span>
            </Select.Option>
          ))}
        </Select>
      )}

      {entries.length > 0 ? (
        <ul className="iam-cl-rows">
          {entries.map(([cid, lvl]) => {
            const meta = byId.get(cid);
            return (
              <li key={cid} className="iam-cl-row">
                <div className="iam-cl-row-info">
                  <b className="mono">{cid}</b>
                  {meta && (
                    <small>
                      {meta.app_name} {meta.version}
                      {meta.owner
                        ? bi(` · 创建者 ${meta.owner}`, ` · owner ${meta.owner}`)
                        : ""}
                    </small>
                  )}
                </div>
                <div className="iam-cl-row-act">
                  <LevelToggle
                    value={lvl}
                    disabled={disabled}
                    onChange={(next) => setLevel(cid, next)}
                  />
                  {!disabled && (
                    <button
                      type="button"
                      className="iam-cl-rm"
                      aria-label={bi(`移除 ${cid}`, `Remove ${cid}`)}
                      onClick={() => removeCluster(cid)}
                    >
                      <IconClose />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="faint small iam-cl-empty-note">
          {ownedBy
            ? bi(
                "未额外分配其他集群（自己创建的集群默认归本人可见并可管理）。",
                "No extra clusters assigned (clusters created by this user are automatically accessible).",
              )
            : bi(
                "尚未分配集群；添加后该团队成员将自动获得所选集群的对应权限。",
                "No clusters assigned yet; members will automatically inherit permissions on assigned clusters.",
              )}
        </p>
      )}

      {inheritedOnly.length > 0 && (
        <div className="iam-cl-inherited">
          <div className="iam-cl-inherited-h">
            {bi("通过所在团队自动继承的集群", "Inherited via team membership")}
          </div>
          <div className="iam-cl-inherited-list">
            {inheritedOnly.map(([cid, info]) => (
              <span key={cid} className="iam-cl-inh-pill">
                <b className="mono">{cid}</b>
                <em className={`iam-lvl-tag is-${info.level}`}>
                  {clusterLevelLabel(info.level)}
                </em>
                <small>{info.from.join(" / ")}</small>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const SCOPES: {
  id: string;
  readonly title: string;
  readonly hint: string;
}[] = [
  {
    id: "own",
    get title() {
      return bi("仅自己", "Own Only");
    },
    get hint() {
      return bi(
        "只看得到自己建的交付和集群",
        "Can view only deliveries and clusters they created",
      );
    },
  },
  {
    id: "team",
    get title() {
      return bi("所在团队", "Team");
    },
    get hint() {
      return bi(
        "自己的，加上同一团队里其他人的",
        "Can view own deliveries plus those of teammates",
      );
    },
  },
  {
    id: "all",
    get title() {
      return bi("全部", "All");
    },
    get hint() {
      return bi(
        "平台上所有人的",
        "Can view all deliveries across the platform",
      );
    },
  },
];
export const scopeName = (s: string) =>
  SCOPES.find((x) => x.id === s)?.title || s;

let memo: IAM | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("mh-lang-change", () => {
    memo = null;
  });
}
/** The IAM catalogue and state, shared by the pages that need it. */
export function useIAM() {
  const lang = useLang();
  const [d, setD] = useState<IAM | null>(memo);
  const load = () =>
    api<IAM>("/api/iam")
      .then((x) => {
        memo = x;
        setD(x);
      })
      .catch(err);
  useEffect(() => {
    let alive = true;
    api<IAM>("/api/iam")
      .then((x) => {
        memo = x;
        if (alive) setD(x);
      })
      .catch((e) => {
        if (alive) err(e);
      });
    return () => {
      alive = false;
    };
  }, [lang]);
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
  clusters,
}: {
  iam: IAM;
  perms: Set<string>;
  scope: string;
  clusters?: Record<string, ClusterAccessLevel>;
}) {
  useLang();
  const groups = useMemo(
    () =>
      modules(iam.perms)
        .map(
          ([m, ps]) => [m, ps.filter((p) => perms.has(p.id))] as [string, Perm[]],
        )
        .filter(([, ps]) => ps.length),
    [iam.perms, perms],
  );
  const clusterEntries = useMemo(
    () => stableClusterEntries(clusters),
    [clusters],
  );
  if (!groups.length)
    return (
      <p className="faint small">
        {bi(
          "没有任何权限：只能管理自己的账户。",
          "No permissions granted: can only manage own account.",
        )}
      </p>
    );
  return (
    <div className="iam-eff">
      {perms.has("delivery.view") && (
        <div className="iam-eff-scope-box">
          <p className="iam-eff-scope">
            {biv(
              <>
                默认可见{" "}
                <b>
                  {scope === "all"
                    ? "全平台所有"
                    : scope === "team"
                      ? "自己创建与同团队"
                      : "自己创建"}
                </b>{" "}
                的集群和交付
                {scope !== "all" && clusterEntries.length > 0
                  ? `，另已单独授权 ${clusterEntries.length} 个集群`
                  : ""}
              </>,
              <>
                Default visibility:{" "}
                <b>
                  {scope === "all"
                    ? "all platform clusters"
                    : scope === "team"
                      ? "own & team clusters"
                      : "own clusters"}
                </b>
                {scope !== "all" && clusterEntries.length > 0
                  ? ` + ${clusterEntries.length} assigned`
                  : ""}
              </>,
            )}
          </p>
          {scope !== "all" && clusterEntries.length > 0 && (
            <div className="iam-eff-clusters">
              {clusterEntries.map(([cid, lvl]) => (
                <a
                  key={cid}
                  href={`#/d/${encodeURIComponent(cid)}`}
                  className="iam-eff-cl-chip"
                  onClick={(e) => {
                    e.preventDefault();
                    go({ name: "deliveries", id: cid });
                  }}
                >
                  <span className="mono">{cid}</span>
                  <em className={`iam-lvl-tag is-${lvl}`}>
                    {lvl === "operate"
                      ? bi("运维", "Operate")
                      : bi("只读", "View")}
                  </em>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
      {groups.map(([m, ps]) => (
        <div key={m} className="iam-eff-g">
          <span>{permModule(m)}</span>
          <span className="iam-eff-ps">
            {ps.map((p) => (
              <em key={p.id} title={permDesc(p)}>
                {permTitle(p)}
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
  useLang();
  return (
    <div className="iam-picks" role="group" aria-label={bi("角色", "Roles")}>
      {iam.roles.map((r) => {
        const on = value.includes(r.id);
        const toggleRole = (v: boolean) =>
          onChange(v ? [...value, r.id] : value.filter((x) => x !== r.id));
        return (
          <div
            key={r.id}
            className={`iam-pick ${on ? "on" : ""}`}
            onClick={() => toggleRole(!on)}
          >
            <Checkbox
              checked={on}
              onClick={(e) => e.stopPropagation()}
              onChange={toggleRole}
            />
            <span>
              <b>
                {roleTitle(r)}
                {r.builtin && (
                  <small className="iam-tag">{bi("内置", "Built-in")}</small>
                )}
                <small className="iam-scope">{scopeName(r.scope)}</small>
              </b>
              {r.desc && <small>{roleDesc(r)}</small>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Roles, teams, and per-cluster grants of one person, changed in place. */
export function GrantEditor({
  user,
  iam,
  onSaved,
}: {
  user: string;
  iam: IAM;
  onSaved: () => void;
}) {
  useLang();
  const g = iam.grants[user] || { roles: [], teams: [], clusters: {} };
  const [roles, setRoles] = useState(g.roles);
  const [teams, setTeams] = useState(g.teams);
  const [clusters, setClusters] = useState<Record<string, ClusterAccessLevel>>(
    () => ({ ...(g.clusters || {}) }),
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRoles(g.roles);
    setTeams(g.teams);
    setClusters({ ...(g.clusters || {}) });
  }, [user, iam]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty =
    JSON.stringify([...roles].sort()) !== JSON.stringify([...g.roles].sort()) ||
    JSON.stringify([...teams].sort()) !== JSON.stringify([...g.teams].sort()) ||
    !sameClusterMap(clusters, g.clusters);
  const eff = effective(iam, roles);
  const inheritedClusters = useMemo(() => {
    const out: Record<string, { level: ClusterAccessLevel; from: string[] }> =
      {};
    for (const tid of teams) {
      const t = iam.teams.find((x) => x.id === tid);
      if (!t?.clusters) continue;
      for (const [cid, lvl] of Object.entries(t.clusters)) {
        if (lvl !== "view" && lvl !== "operate") continue;
        const cur = out[cid];
        if (!cur) {
          out[cid] = { level: lvl, from: [t.name] };
        } else {
          if (LEVEL_RANK[lvl] > LEVEL_RANK[cur.level]) cur.level = lvl;
          if (!cur.from.includes(t.name)) cur.from.push(t.name);
        }
      }
    }
    return out;
  }, [teams, iam.teams]);
  const mergedClusters = useMemo(() => {
    const out: Record<string, ClusterAccessLevel> = { ...clusters };
    for (const [cid, info] of Object.entries(inheritedClusters)) {
      if (LEVEL_RANK[info.level] > LEVEL_RANK[out[cid] || ""]) {
        out[cid] = info.level;
      }
    }
    return out;
  }, [clusters, inheritedClusters]);
  const editable = can("iam.user");
  const save = async () => {
    if (busy || !dirty || roles.length === 0) return;
    setBusy(true);
    try {
      await api(`/api/users/${user}/grant`, {
        method: "PUT",
        body: JSON.stringify({ roles, teams, clusters }),
      });
      Message.success(
        bi(
          "已保存，对方的下一次操作就按新权限执行",
          "Saved; new permissions apply on the user's next action",
        ),
      );
      void refreshAIStatus();
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
          <h3>{bi("角色", "Roles")}</h3>
          {editable ? (
            <RolePicker iam={iam} value={roles} onChange={setRoles} />
          ) : (
            <p>
              {roles
                .map((id) => {
                  const found = iam.roles.find((r) => r.id === id);
                  return found ? roleTitle(found) : id;
                })
                .join(bi("、", ", "))}
            </p>
          )}
          <h3 className="iam-gap">{bi("团队", "Teams")}</h3>
          {editable ? (
            <Select
              mode="multiple"
              value={teams}
              onChange={setTeams}
              triggerProps={{ autoFitPosition: true }}
              placeholder={
                iam.teams.length
                  ? bi("选择团队", "Select teams")
                  : bi("还没有团队", "No teams yet")
              }
              options={iam.teams.map((t) => ({ value: t.id, label: t.name }))}
              allowClear
              aria-label={bi("团队", "Teams")}
            />
          ) : (
            <p>
              {teams
                .map((id) => iam.teams.find((t) => t.id === id)?.name || id)
                .join(bi("、", ", ")) || bi("不在任何团队", "No team memberships")}
            </p>
          )}
          <h3 className="iam-gap">{bi("集群访问权限", "Cluster Access")}</h3>
          {eff.scope === "all" ? (
            <div className="iam-cl-all-note">
              <IconCheck />
              <span>
                {bi(
                  "当前角色数据范围为「全部」，该用户自动拥有全平台所有集群的访问权限，无需逐个分配。",
                  "Selected role scope is “All”, granting automatic visibility across every cluster on the platform.",
                )}
              </span>
            </div>
          ) : (
            <>
              <p className="faint small iam-cl-subhint">
                {bi(
                  "自己创建的集群默认本人可见并可运维；这里可按集群额外分配协作访问权限。",
                  "Clusters created by this user are accessible by default; assign additional clusters below.",
                )}
              </p>
              <ClusterGrantPicker
                clusters={iam.clusters || []}
                value={clusters}
                onChange={setClusters}
                disabled={!editable}
                ownedBy={user}
                inherited={inheritedClusters}
              />
            </>
          )}
          {editable && (
            <div className="iam-grant-foot">
              <Button
                type="primary"
                loading={busy}
                disabled={!dirty || roles.length === 0}
                onClick={save}
              >
                {bi("保存权限配置", "Save Access")}
              </Button>
              {dirty && (
                <Button
                  type="text"
                  onClick={() => {
                    setRoles(g.roles);
                    setTeams(g.teams);
                    setClusters({ ...(g.clusters || {}) });
                  }}
                >
                  {bi("还原", "Reset")}
                </Button>
              )}
              {roles.length === 0 && (
                <span className="bad small">
                  {bi("至少给一个角色", "Select at least one role")}
                </span>
              )}
            </div>
          )}
        </section>
        <section>
          <h3>
            {dirty
              ? bi("保存后能做什么", "Effective Permissions After Save")
              : bi("能做什么", "Effective Permissions")}
          </h3>
          <EffectivePerms
            iam={iam}
            perms={eff.perms}
            scope={eff.scope}
            clusters={mergedClusters}
          />
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
  useLang();
  const { iam, set } = useIAM();
  const [sel, setSel] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState(false);
  const editable = can("iam.role");
  const role = iam?.roles.find((r) => r.id === sel) || iam?.roles[0];
  const permModules = useMemo(
    () => (iam ? modules(iam.perms) : []),
    [iam],
  );
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
  const aiFeatIds = iam.perms
    .filter((p) => p.id.startsWith("ai.feat."))
    .map((p) => p.id);
  const toggle = (ids: string[], on: boolean) => {
    if (!cur) return;
    const next = new Set(cur.perms);
    ids.forEach((i) => (on ? next.add(i) : next.delete(i)));
    // Parent-child rule: enabling ai.use from off selects all AI sub-features by default;
    // disabling ai.use automatically clears all ai.feat.* sub-permissions.
    if (ids.length === 1 && ids[0] === "ai.use") {
      if (on) {
        if (!aiFeatIds.some((id) => next.has(id))) {
          aiFeatIds.forEach((id) => next.add(id));
        }
      } else {
        aiFeatIds.forEach((id) => next.delete(id));
      }
    }
    if (!next.has("ai.use")) {
      aiFeatIds.forEach((id) => next.delete(id));
    }
    setDraft({
      ...cur,
      perms: iam.perms.map((p) => p.id).filter((p) => next.has(p)),
    });
  };
  const save = async () => {
    if (busy || !draft || !draft.name.trim()) return;
    setBusy(true);
    try {
      const body = JSON.stringify({
        name: draft.name,
        desc: draft.desc,
        perms: draft.perms,
        scope: draft.scope,
        granular_ai: true,
      });
      const next = await api<IAM>(
        draft.id ? `/api/iam/roles/${draft.id}` : "/api/iam/roles",
        { method: draft.id ? "PUT" : "POST", body },
      );
      set(next);
      void refreshAIStatus();
      const made = next.roles.find((r) => r.name === draft.name);
      setDraft(null);
      if (made) setSel(made.id);
      Message.success(
        bi(
          "已保存，有这个角色的人下一次操作就按新权限执行",
          "Saved; updated permissions take effect on holders' next actions",
        ),
      );
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = (r: Role) => {
    let deleting = false;
    Modal.confirm({
      title: bi(`删除角色「${r.name}」？`, `Delete role “${r.name}”?`),
      content: r.holders
        ? bi(
            `有 ${r.holders} 个人有这个角色，删除后他们会失去它带来的权限。`,
            `${r.holders} user(s) hold this role and will lose its permissions.`,
          )
        : bi("没有人有这个角色。", "No users currently hold this role."),
      okText: bi("删除", "Delete"),
      cancelText: bi("取消", "Cancel"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (deleting) return;
        deleting = true;
        try {
          set(await api<IAM>(`/api/iam/roles/${r.id}`, { method: "DELETE" }));
          setSel("");
          setDraft(null);
        } catch (e) {
          err(e);
        } finally {
          deleting = false;
        }
      },
    });
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
          <h1>{bi("角色", "Roles")}</h1>
          <p>
            {bi(
              "角色是一组权限，加上它能看到谁的交付。一个人可以有多个角色，权限合在一起算。内置角色不能改，可以复制一份再改。",
              "A role bundles permissions with a delivery visibility scope. Users can hold multiple roles (permissions combine). Built-in roles are read-only—duplicate one to customize.",
            )}
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
              {bi("新建角色", "New Role")}
            </Button>
          </span>
        )}
      </header>
      <UnderlineTabs
        className="iam-subtabs"
        label={bi("角色管理视图", "Role views")}
        value={compare ? "compare" : "edit"}
        onChange={(v) => setCompare(v === "compare")}
        items={[
          {
            value: "edit",
            label: bi("角色配置", "Role Configuration"),
            count: iam.roles.length,
            icon: IAMIcons.roleEdit,
          },
          {
            value: "compare",
            label: bi("权限对比矩阵", "Permission Matrix"),
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
                <th>{bi("权限", "Permission")}</th>
                {iam.roles.map((r) => (
                  <th key={r.id}>
                    {roleTitle(r)}
                    <small>{scopeName(r.scope)}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permModules.map(([m, ps]) => (
                <React.Fragment key={m}>
                  <tr className="iam-cmp-m">
                    <td colSpan={iam.roles.length + 1}>{permModule(m)}</td>
                  </tr>
                  {ps.map((p) => (
                    <tr key={p.id}>
                      <td title={permDesc(p)}>{permTitle(p)}</td>
                      {iam.roles.map((r) => (
                        <td
                          key={r.id}
                          className={r.perms.includes(p.id) ? "yes" : "no"}
                        >
                          {r.perms.includes(p.id) ? (
                            <IconCheck aria-label={bi("有", "Granted")} />
                          ) : (
                            <span aria-label={bi("没有", "Not granted")}>·</span>
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
          <ul
            className="iam-roles"
            role="listbox"
            aria-label={bi("角色", "Roles")}
          >
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
                    <b>{roleTitle(r)}</b>
                    <small>
                      {bi(
                        `${r.perms.length} 项权限 · ${scopeName(r.scope)} · ${r.holders} 人`,
                        `${r.perms.length} perms · ${scopeName(r.scope)} · ${r.holders} ${r.holders === 1 ? "user" : "users"}`,
                      )}
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
                    <b>{draft.name || bi("新角色", "New Role")}</b>
                    <small>{bi("还没保存", "Unsaved")}</small>
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
                      {role && cur.id === role.id ? roleTitle(role) : cur.name}
                      {role?.builtin && (
                        <small className="iam-tag">
                          {bi("内置", "Built-in")}
                        </small>
                      )}
                    </h2>
                    {cur.desc && (
                      <p className="muted">
                        {role && cur.id === role.id
                          ? roleDesc(role)
                          : normPermDesc(cur.desc)}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="iam-role-names">
                    <Input
                      value={cur.name}
                      onChange={(v) => setDraft({ ...cur, name: v })}
                      placeholder={bi(
                        "角色名，例如：一组交付工程师",
                        "Role name, e.g., Team A Delivery Engineer",
                      )}
                      maxLength={30}
                      aria-label={bi("角色名", "Role name")}
                    />
                    <Input
                      value={cur.desc}
                      onChange={(v) => setDraft({ ...cur, desc: v })}
                      placeholder={bi(
                        "一句话说明这个角色是做什么的",
                        "Brief description of what this role is for",
                      )}
                      maxLength={200}
                      aria-label={bi("说明", "Description")}
                    />
                  </div>
                )}
                <span className="row-gap">
                  {editable && role && !draft && (
                    <Button
                      icon={<IconCopy />}
                      onClick={() =>
                        setDraft({
                          name: bi(
                            `${roleTitle(role)}（副本）`,
                            `${roleTitle(role)} (Copy)`,
                          ),
                          desc: roleDesc(role) || "",
                          perms: role.perms,
                          scope: role.scope,
                        })
                      }
                    >
                      {bi("复制为新角色", "Duplicate")}
                    </Button>
                  )}
                  {editable && role && !role.builtin && !draft && (
                    <Button
                      status="danger"
                      icon={<IconDelete />}
                      onClick={() => remove(role)}
                      aria-label={bi("删除角色", "Delete role")}
                    />
                  )}
                </span>
              </div>
              {locked && (
                <p className="iam-ro-hint" role="status">
                  {!editable
                    ? bi(
                        "当前账户无角色管理权限，仅可查看角色配置。",
                        "Read-only: your account lacks permission to manage roles.",
                      )
                    : bi(
                        "内置角色不可直接修改；可点击右上角「复制为新角色」后按需调整权限。",
                        "Built-in roles cannot be edited directly; click “Duplicate” at top right to create an editable copy.",
                      )}
                </p>
              )}
              <div className="iam-sec">
                <h3>
                  {bi(
                    "能看到谁的交付和集群",
                    "Delivery & Cluster Visibility Scope",
                  )}
                </h3>
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
                  {bi(
                    "；只对有「查看交付和集群」的人生效。",
                    "; applies only to users with “View deliveries & clusters”.",
                  )}
                </p>
              </div>
              <div className="iam-sec">
                <h3>
                  {bi("权限", "Permissions")}{" "}
                  <em className="num">{cur.perms.length}</em>
                </h3>
                <div className="iam-tree">
                  {permModules.map(([m, ps]) => {
                    const n = ps.filter((p) => cur.perms.includes(p.id)).length;
                    const allModChecked = n === ps.length;
                    return (
                      <div key={m} className="iam-mod">
                        <div
                          className="iam-mod-h"
                          onClick={() => {
                            if (!locked) {
                              toggle(
                                ps.map((p) => p.id),
                                !allModChecked,
                              );
                            }
                          }}
                        >
                          <Checkbox
                            checked={allModChecked}
                            indeterminate={n > 0 && n < ps.length}
                            disabled={locked}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(v) =>
                              toggle(
                                ps.map((p) => p.id),
                                v,
                              )
                            }
                          />
                          <b>{permModule(m)}</b>
                          <small className="num">
                            {n} / {ps.length}
                          </small>
                        </div>
                        <div className="iam-perms">
                          {m === "AI" ? (
                            <>
                              {ps
                                .filter((p) => !p.id.startsWith("ai.feat."))
                                .map((p) => {
                                  const isUse = p.id === "ai.use";
                                  const useOn = cur.perms.includes("ai.use");
                                  const checked = cur.perms.includes(p.id);
                                  const subPerms = isUse
                                    ? ps.filter((x) =>
                                        x.id.startsWith("ai.feat."),
                                      )
                                    : [];
                                  return (
                                    <React.Fragment key={p.id}>
                                      <div
                                        className={`iam-perm ${checked ? "on" : ""}`}
                                        onClick={() => {
                                          if (!locked) toggle([p.id], !checked);
                                        }}
                                      >
                                        <Checkbox
                                          checked={checked}
                                          disabled={locked}
                                          onClick={(e) => e.stopPropagation()}
                                          onChange={(v) => toggle([p.id], v)}
                                        />
                                        <span>
                                          <b>{permTitle(p)}</b>
                                          <small>{permDesc(p)}</small>
                                        </span>
                                      </div>
                                      {isUse && subPerms.length > 0 && (
                                        <div
                                          className={`iam-ai-sub ${!useOn ? "is-locked" : ""}`}
                                        >
                                          <div className="iam-ai-sub-h">
                                            <span>
                                              {bi(
                                                "细粒度 AI 模块权限",
                                                "Per-module AI permissions",
                                              )}
                                              <em className="num">
                                                {
                                                  subPerms.filter((x) =>
                                                    cur.perms.includes(x.id),
                                                  ).length
                                                }{" "}
                                                / {subPerms.length}
                                              </em>
                                            </span>
                                            {!useOn && (
                                              <small>
                                                {bi(
                                                  "请先勾选上方「使用 AI（总入口）」后再按需勾选",
                                                  "Check “Use AI (master gate)” above first",
                                                )}
                                              </small>
                                            )}
                                          </div>
                                          <div className="iam-ai-sub-grid">
                                            {subPerms.map((sp) => {
                                              const spOn = cur.perms.includes(
                                                sp.id,
                                              );
                                              return (
                                                <div
                                                  key={sp.id}
                                                  className={`iam-ai-sub-item ${spOn ? "on" : ""}`}
                                                  onClick={() => {
                                                    if (!locked && useOn) {
                                                      toggle([sp.id], !spOn);
                                                    }
                                                  }}
                                                >
                                                  <Checkbox
                                                    checked={spOn}
                                                    disabled={locked || !useOn}
                                                    onClick={(e) =>
                                                      e.stopPropagation()
                                                    }
                                                    onChange={(v) =>
                                                      toggle([sp.id], v)
                                                    }
                                                  />
                                                  <span>
                                                    <b>{permTitle(sp)}</b>
                                                    <small>{permDesc(sp)}</small>
                                                  </span>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      )}
                                    </React.Fragment>
                                  );
                                })}
                            </>
                          ) : (
                            ps.map((p) => {
                              const pOn = cur.perms.includes(p.id);
                              return (
                                <div
                                  key={p.id}
                                  className={`iam-perm ${pOn ? "on" : ""}`}
                                  onClick={() => {
                                    if (!locked) toggle([p.id], !pOn);
                                  }}
                                >
                                  <Checkbox
                                    checked={pOn}
                                    disabled={locked}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(v) => toggle([p.id], v)}
                                  />
                                  <span>
                                    <b>{permTitle(p)}</b>
                                    <small>{permDesc(p)}</small>
                                  </span>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {dirty && (
                <div className="iam-save">
                  <span className="faint small">
                    {bi(
                      "你只能授出自己有的权限。",
                      "You can only grant permissions that you hold yourself.",
                    )}
                  </span>
                  <Button onClick={() => setDraft(null)}>
                    {bi("取消", "Cancel")}
                  </Button>
                  <Button
                    type="primary"
                    loading={busy}
                    disabled={!draft!.name.trim()}
                    onClick={save}
                  >
                    {draft!.id
                      ? bi("保存", "Save")
                      : bi("创建角色", "Create Role")}
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
    useLang();
    const { iam, set } = useIAM();
    const [edit, setEdit] = useState<{
      id?: string;
      name: string;
      desc: string;
      members: string[];
      clusters: Record<string, ClusterAccessLevel>;
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
      if (busy || !edit || !edit.name.trim()) return;
      setBusy(true);
      try {
        set(
          await api<IAM>(
            edit.id ? `/api/iam/teams/${edit.id}` : "/api/iam/teams",
            { method: edit.id ? "PUT" : "POST", body: JSON.stringify(edit) },
          ),
        );
        setEdit(null);
        Message.success(bi("已保存", "Saved"));
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
            <h1>{bi("团队", "Teams")}</h1>
            <p>
              {bi(
                "可将指定集群批量授权给团队（成员自动继承运维管理或只读权限）；若角色范围为「所在团队」，同团队成员也能互相看到彼此创建的集群。",
                "Assign clusters to a team so members automatically inherit operate or read-only access; roles with “Team” scope also share teammate-created clusters.",
              )}
            </p>
          </div>
          {editable && (
            <Button
              type="primary"
              icon={<IconPlus />}
              onClick={() =>
                setEdit({ name: "", desc: "", members: [], clusters: {} })
              }
            >
              {bi("新建团队", "New Team")}
            </Button>
          )}
        </header>
        {iam.teams.length > 0 && (
          <UnderlineTabs
            className="iam-subtabs"
            label={bi("团队筛选", "Team filter")}
            value={tab}
            onChange={(v) => setTab(v as "all" | "active" | "empty")}
            items={[
              {
                value: "all",
                label: bi("全部团队", "All Teams"),
                count: iam.teams.length,
                icon: IAMIcons.teamAll,
              },
              {
                value: "active",
                label: bi("已有成员", "With Members"),
                count: activeCount,
                icon: IAMIcons.teamActive,
              },
              ...(emptyCount > 0
                ? [
                    {
                      value: "empty",
                      label: bi("待添加成员", "Empty"),
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
            <b>{bi("还没有团队", "No teams yet")}</b>
            <span>
              {bi(
                "按负责的项目或现场分组，组内的交付就能一起看、一起做。",
                "Group users by project or site so teammates can share and operate deliveries together.",
              )}
            </span>
          </div>
        ) : shownTeams.length === 0 ? (
          <div className="iam-empty">
            <IconUserGroup />
            <b>{bi("当前筛选下没有团队", "No teams match this filter")}</b>
            <Button size="small" onClick={() => setTab("all")}>
              {bi("查看全部团队", "Show All Teams")}
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
                  <small>
                    {t.desc ||
                      bi(
                        `${t.members.length} 人`,
                        `${t.members.length} ${t.members.length === 1 ? "member" : "members"}`,
                      )}
                  </small>
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
                          clusters: { ...(t.clusters || {}) },
                        })
                      }
                    >
                      {bi("编辑", "Edit")}
                    </Button>
                    <Button
                      size="small"
                      status="danger"
                      icon={<IconDelete />}
                      aria-label={bi("删除团队", "Delete team")}
                      onClick={() => {
                        let deleting = false;
                        Modal.confirm({
                          title: bi(
                            `删除团队「${t.name}」？`,
                            `Delete team “${t.name}”?`,
                          ),
                          content: bi(
                            "成员不会被删除，只是不再同属这个团队。",
                            "User accounts will not be deleted; they will simply no longer belong to this team.",
                          ),
                          okText: bi("删除", "Delete"),
                          cancelText: bi("取消", "Cancel"),
                          okButtonProps: { status: "danger" },
                          onOk: async () => {
                            if (deleting) return;
                            deleting = true;
                            try {
                              set(
                                await api<IAM>(`/api/iam/teams/${t.id}`, {
                                  method: "DELETE",
                                }),
                              );
                            } catch (e) {
                              err(e);
                            } finally {
                              deleting = false;
                            }
                          },
                        });
                      }}
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
                  <span className="faint small">
                    {bi("还没有成员", "No members yet")}
                  </span>
                )}
              </div>
              {stableClusterEntries(t.clusters).length > 0 && (
                <div className="iam-team-clusters">
                  <span className="iam-team-cl-label">
                    {bi("授权集群", "Clusters")}
                  </span>
                  {stableClusterEntries(t.clusters).map(([cid, lvl]) => (
                    <a
                      key={cid}
                      href={`#/d/${encodeURIComponent(cid)}`}
                      className="iam-eff-cl-chip"
                      onClick={(e) => {
                        e.preventDefault();
                        go({ name: "deliveries", id: cid });
                      }}
                    >
                      <span className="mono">{cid}</span>
                      <em className={`iam-lvl-tag is-${lvl}`}>
                        {lvl === "operate"
                          ? bi("运维", "Operate")
                          : bi("只读", "View")}
                      </em>
                    </a>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal
        visible={!!edit}
        title={edit?.id ? bi("编辑团队", "Edit Team") : bi("新建团队", "New Team")}
        onCancel={() => setEdit(null)}
        okText={bi("保存", "Save")}
        cancelText={bi("取消", "Cancel")}
        confirmLoading={busy}
        okButtonProps={{ disabled: !edit?.name.trim() }}
        onOk={save}
      >
        {edit && (
          <div className="st-form">
            <div className="st-field">
              <span>{bi("团队名", "Team Name")}</span>
              <Input
                value={edit.name}
                onChange={(v) => setEdit({ ...edit, name: v })}
                placeholder={bi("华东交付一组", "e.g., Delivery Team East")}
                maxLength={30}
                aria-label={bi("团队名", "Team name")}
              />
            </div>
            <div className="st-field">
              <span>{bi("说明（可选）", "Description (Optional)")}</span>
              <Input
                value={edit.desc}
                onChange={(v) => setEdit({ ...edit, desc: v })}
                maxLength={200}
                aria-label={bi("说明", "Description")}
              />
            </div>
            <div className="st-field">
              <span>{bi("成员", "Members")}</span>
              <Select
                mode="multiple"
                value={edit.members}
                onChange={(v) => setEdit({ ...edit, members: v })}
                triggerProps={{ autoFitPosition: true }}
                options={sorted.map((u) => ({ value: u, label: u }))}
                placeholder={bi("选择成员", "Select members")}
                allowClear
                aria-label={bi("成员", "Members")}
              />
            </div>
            {(iam.clusters?.length || 0) > 0 && (
              <div className="st-field">
                <span>
                  {bi("授权集群（可选）", "Authorized Clusters (Optional)")}
                </span>
                <ClusterGrantPicker
                  clusters={iam.clusters || []}
                  value={edit.clusters}
                  onChange={(next) => setEdit({ ...edit, clusters: next })}
                />
              </div>
            )}
          </div>
        )}
      </Modal>
    </article>
  );
}

/* ---------------------------------------------------------------- clusters access */

export function ClustersAccessPane({
  narrow,
  users,
  onSaved,
}: {
  narrow: boolean;
  users: Account[];
  onSaved?: () => void;
}) {
  useLang();
  const { iam, set } = useIAM();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(() => {
    try {
      const f = sessionStorage.getItem("ds:iam-cluster-focus") || "";
      if (f) sessionStorage.removeItem("ds:iam-cluster-focus");
      return f;
    } catch {
      return "";
    }
  });
  const [draftUsers, setDraftUsers] = useState<
    Record<string, ClusterAccessLevel>
  >({});
  const [draftTeams, setDraftTeams] = useState<
    Record<string, ClusterAccessLevel>
  >({});
  const [busy, setBusy] = useState(false);

  const clusters = useMemo(() => iam?.clusters || [], [iam?.clusters]);
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      clusters.filter(
        (c) =>
          !q ||
          c.id.toLowerCase().includes(q) ||
          c.app_name.toLowerCase().includes(q) ||
          c.owner.toLowerCase().includes(q),
      ),
    [clusters, q],
  );
  const current =
    clusters.find((c) => c.id === sel) || filtered[0] || clusters[0] || null;

  useEffect(() => {
    if (!current) {
      setDraftUsers({});
      setDraftTeams({});
      return;
    }
    setDraftUsers({ ...(current.users || {}) });
    setDraftTeams({ ...(current.teams || {}) });
  }, [current?.id, iam]); // eslint-disable-line react-hooks/exhaustive-deps

  const globalRoles = useMemo(
    () => (iam?.roles || []).filter((r) => r.scope === "all"),
    [iam?.roles],
  );
  const globalRoleIds = useMemo(
    () => new Set(globalRoles.map((r) => r.id)),
    [globalRoles],
  );
  const userMap = useMemo(
    () => new Map(users.map((u) => [u.username, u])),
    [users],
  );
  const roleMap = useMemo(
    () => new Map((iam?.roles || []).map((r) => [r.id, r])),
    [iam?.roles],
  );
  const teamMap = useMemo(
    () => new Map((iam?.teams || []).map((t) => [t.id, t])),
    [iam?.teams],
  );

  if (!iam) return <Skeleton animation text={{ rows: 8 }} />;

  const canUsers = can("iam.user");
  const canTeams = can("iam.team");
  const editable = canUsers || canTeams;
  const dirty =
    !!current &&
    (!sameClusterMap(draftUsers, current.users) ||
      !sameClusterMap(draftTeams, current.teams));

  const userEntries = stableClusterEntries(draftUsers);
  const teamEntries = stableClusterEntries(draftTeams);

  const userHasGlobalScope = (uname: string) => {
    const rids = iam.grants[uname]?.roles || userMap.get(uname)?.roles || [];
    return rids.some((id) => globalRoleIds.has(id));
  };
  const userRolesText = (uname: string) => {
    const rids = iam.grants[uname]?.roles || userMap.get(uname)?.roles || [];
    return rids
      .map((id) => {
        const r = roleMap.get(id);
        return r ? roleTitle(r) : id;
      })
      .join(bi("、", ", "));
  };

  const addableUsers = users
    .filter(
      (u) =>
        !u.disabled &&
        (!current || u.username !== current.owner) &&
        !draftUsers[u.username],
    )
    .sort((a, b) => {
      const ag = userHasGlobalScope(a.username) ? 1 : 0;
      const bg = userHasGlobalScope(b.username) ? 1 : 0;
      return ag !== bg ? ag - bg : a.username.localeCompare(b.username);
    });
  const addableTeams = iam.teams
    .filter((t) => !draftTeams[t.id])
    .sort((a, b) => a.name.localeCompare(b.name));

  const save = async () => {
    if (!current || busy || !dirty) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      if (canUsers) payload.users = draftUsers;
      if (canTeams) payload.teams = draftTeams;
      const next = await api<IAM>(
        `/api/iam/clusters/${encodeURIComponent(current.id)}`,
        { method: "PUT", body: JSON.stringify(payload) },
      );
      set(next);
      onSaved?.();
      Message.success(
        bi(
          `已更新集群「${current.id}」的访问权限`,
          `Updated access permissions for ${current.id}`,
        ),
      );
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
          <h1>{bi("集群权限", "Cluster Access")}</h1>
          <p>
            {bi(
              "每个集群默认归创建者自己可见并管理，管理员及全局范围角色自动可见全部集群；在这里可以按集群精细分配其他成员或团队的「运维管理」或「只读查看」权限。",
              "Creators automatically own and operate clusters they create, and global-scope roles see all clusters. Assign additional users or teams with Operate or Read-only access per cluster here.",
            )}
          </p>
        </div>
      </header>

      {clusters.length === 0 ? (
        <div className="iam-empty">
          <IconStorage />
          <b>{bi("还没有可分配权限的集群", "No clusters yet")}</b>
          <span>
            {bi(
              "创建或纳管集群后，可以在这里按集群分配协作成员与团队权限。",
              "Once clusters are created or imported, assign per-cluster user and team permissions here.",
            )}
          </span>
        </div>
      ) : (
        <div className="iam-split iam-cl-split">
          <div className="iam-cl-rail">
            <Input
              prefix={<IconSearch />}
              allowClear
              size="small"
              value={query}
              onChange={setQuery}
              placeholder={bi("筛选集群、组件或创建者", "Filter cluster, app, or owner")}
              aria-label={bi("筛选集群", "Filter clusters")}
            />
            <ul
              className="iam-roles iam-cl-list"
              role="listbox"
              aria-label={bi("集群列表", "Clusters")}
            >
              {filtered.length === 0 ? (
                <li className="faint small iam-cl-list-empty">
                  {bi("没有匹配的集群", "No matching clusters")}
                </li>
              ) : (
                filtered.map((c) => {
                  const grantCount =
                    Object.keys(c.users || {}).length +
                    Object.keys(c.teams || {}).length;
                  const active = current?.id === c.id;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={active ? "on" : ""}
                        onClick={() => setSel(c.id)}
                      >
                        <span className="iam-role-ic">
                          <IconStorage />
                        </span>
                        <span className="iam-cl-item-txt">
                          <b className="mono">{c.id}</b>
                          <small>
                            {c.app_name} {c.version} · {c.owner}
                          </small>
                        </span>
                        <span
                          className={`iam-cl-cnt ${grantCount > 0 ? "has" : ""}`}
                        >
                          {grantCount > 0
                            ? bi(`${grantCount} 授权`, `${grantCount}`)
                            : bi("仅创建者", "Owner")}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          {current && (
            <section className="iam-role-ed iam-cl-ed">
              <div className="iam-role-top">
                <div className="iam-cl-head-meta">
                  <h2 className="mono">{current.id}</h2>
                  <p className="muted">
                    {current.app_name} {current.version} ·{" "}
                    {bi(`创建者：${current.owner}`, `Owner: ${current.owner}`)}
                  </p>
                </div>
                <Button
                  size="small"
                  onClick={() => go({ name: "deliveries", id: current.id })}
                >
                  {bi("打开集群", "Open Cluster")} <IconRight />
                </Button>
              </div>

              <div className="iam-cl-defaults">
                <div className="iam-cl-def-item">
                  <span className="iam-cl-def-k">
                    {bi("创建者（默认运维管理）", "Owner (Default Operate)")}
                  </span>
                  <div className="iam-cl-def-v">
                    <a
                      href={`#/iam/${encodeURIComponent(current.owner)}`}
                      className="iam-cl-owner-pill"
                      onClick={(e) => {
                        e.preventDefault();
                        go(
                          { name: "accounts", id: current.owner },
                          { replace: true },
                        );
                      }}
                    >
                      <IconUser />
                      <span>{current.owner}</span>
                    </a>
                  </div>
                </div>
                <div className="iam-cl-def-item">
                  <span className="iam-cl-def-k">
                    {bi("全局角色（自动可见全部集群）", "Global Roles (See All)")}
                  </span>
                  <div className="iam-cl-def-v">
                    {globalRoles.map((r) => (
                      <span key={r.id} className="iam-cl-global-pill">
                        {roleTitle(r)}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="iam-sec">
                <div className="iam-cl-sec-head">
                  <h3>
                    {bi("授权用户", "Authorized Users")}{" "}
                    <em className="num">{userEntries.length}</em>
                  </h3>
                  {canUsers && (
                    <Select
                      style={{ width: 260, maxWidth: "100%" }}
                      value={undefined}
                      showSearch
                      allowClear
                      placeholder={
                        addableUsers.length
                          ? bi("添加授权用户...", "Add user...")
                          : bi("暂无其他可添加用户", "No more users")
                      }
                      disabled={addableUsers.length === 0}
                      onChange={(v) => {
                        if (typeof v === "string" && v) {
                          setDraftUsers((prev) => ({
                            ...prev,
                            [v]: "operate",
                          }));
                        }
                      }}
                      triggerProps={{ autoFitPosition: true }}
                      aria-label={bi("添加授权用户", "Add authorized user")}
                    >
                      {addableUsers.map((u) => {
                        const isGlobal = userHasGlobalScope(u.username);
                        return (
                          <Select.Option key={u.username} value={u.username}>
                            <span className="iam-cl-opt">
                              <b>{u.username}</b>
                              <small>
                                {isGlobal
                                  ? bi("已享全局可见", "Global scope")
                                  : userRolesText(u.username)}
                              </small>
                            </span>
                          </Select.Option>
                        );
                      })}
                    </Select>
                  )}
                </div>
                {userEntries.length === 0 ? (
                  <p className="faint small iam-cl-empty-note">
                    {bi(
                      "尚未单独授权其他用户；默认仅创建者和管理员可访问此集群。",
                      "No direct user grants yet; only the creator and admins have access by default.",
                    )}
                  </p>
                ) : (
                  <ul className="iam-cl-rows">
                    {userEntries.map(([uname, lvl]) => (
                      <li key={uname} className="iam-cl-row">
                        <div className="iam-cl-row-info">
                          <a
                            href={`#/iam/${encodeURIComponent(uname)}`}
                            className="iam-cl-user-link"
                            onClick={(e) => {
                              e.preventDefault();
                              go(
                                { name: "accounts", id: uname },
                                { replace: true },
                              );
                            }}
                          >
                            <b>{uname}</b>
                          </a>
                          <small>
                            {userRolesText(uname) || bi("用户", "User")}
                            {userHasGlobalScope(uname)
                              ? bi(" · 已享全局可见", " · global scope")
                              : ""}
                          </small>
                        </div>
                        <div className="iam-cl-row-act">
                          <LevelToggle
                            value={lvl}
                            disabled={!canUsers}
                            onChange={(next) =>
                              setDraftUsers((prev) => ({
                                ...prev,
                                [uname]: next,
                              }))
                            }
                          />
                          {canUsers && (
                            <button
                              type="button"
                              className="iam-cl-rm"
                              aria-label={bi(
                                `撤销 ${uname} 的权限`,
                                `Revoke ${uname}`,
                              )}
                              onClick={() =>
                                setDraftUsers((prev) => {
                                  const next = { ...prev };
                                  delete next[uname];
                                  return next;
                                })
                              }
                            >
                              <IconClose />
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="iam-sec">
                <div className="iam-cl-sec-head">
                  <h3>
                    {bi("授权团队", "Authorized Teams")}{" "}
                    <em className="num">{teamEntries.length}</em>
                  </h3>
                  {canTeams && (
                    <Select
                      style={{ width: 260, maxWidth: "100%" }}
                      value={undefined}
                      showSearch
                      allowClear
                      placeholder={
                        addableTeams.length
                          ? bi("添加授权团队...", "Add team...")
                          : iam.teams.length === 0
                            ? bi("请先在「团队」中创建团队", "Create a team first")
                            : bi("所有团队均已添加", "All teams added")
                      }
                      disabled={addableTeams.length === 0}
                      onChange={(v) => {
                        if (typeof v === "string" && v) {
                          setDraftTeams((prev) => ({
                            ...prev,
                            [v]: "operate",
                          }));
                        }
                      }}
                      triggerProps={{ autoFitPosition: true }}
                      aria-label={bi("添加授权团队", "Add authorized team")}
                    >
                      {addableTeams.map((t) => (
                        <Select.Option key={t.id} value={t.id}>
                          <span className="iam-cl-opt">
                            <b>{t.name}</b>
                            <small>
                              {bi(
                                `${t.members.length} 名成员`,
                                `${t.members.length} members`,
                              )}
                            </small>
                          </span>
                        </Select.Option>
                      ))}
                    </Select>
                  )}
                </div>
                {teamEntries.length === 0 ? (
                  <p className="faint small iam-cl-empty-note">
                    {bi(
                      "尚未授权给任何团队；把团队加入后，团队内所有成员自动继承对应权限。",
                      "No team grants yet; adding a team grants its members access automatically.",
                    )}
                  </p>
                ) : (
                  <ul className="iam-cl-rows">
                    {teamEntries.map(([tid, lvl]) => {
                      const t = teamMap.get(tid);
                      return (
                        <li key={tid} className="iam-cl-row">
                          <div className="iam-cl-row-info">
                            <b>{t?.name || tid}</b>
                            <small>
                              {t && t.members.length > 0
                                ? bi(
                                    `${t.members.length} 人：${t.members.slice(0, 5).join("、")}${t.members.length > 5 ? " 等" : ""}`,
                                    `${t.members.length}: ${t.members.slice(0, 5).join(", ")}${t.members.length > 5 ? "…" : ""}`,
                                  )
                                : bi("暂无成员", "No members")}
                            </small>
                          </div>
                          <div className="iam-cl-row-act">
                            <LevelToggle
                              value={lvl}
                              disabled={!canTeams}
                              onChange={(next) =>
                                setDraftTeams((prev) => ({
                                  ...prev,
                                  [tid]: next,
                                }))
                              }
                            />
                            {canTeams && (
                              <button
                                type="button"
                                className="iam-cl-rm"
                                aria-label={bi(
                                  `撤销团队 ${t?.name || tid}`,
                                  `Revoke team ${t?.name || tid}`,
                                )}
                                onClick={() =>
                                  setDraftTeams((prev) => {
                                    const next = { ...prev };
                                    delete next[tid];
                                    return next;
                                  })
                                }
                              >
                                <IconClose />
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {editable && dirty && (
                <div className="iam-save">
                  <span className="faint small">
                    {bi(
                      "权限保存后立即生效，无需对方重新登录。",
                      "Changes take effect immediately without requiring sign-out.",
                    )}
                  </span>
                  <Button
                    onClick={() => {
                      setDraftUsers({ ...(current.users || {}) });
                      setDraftTeams({ ...(current.teams || {}) });
                    }}
                  >
                    {bi("还原", "Reset")}
                  </Button>
                  <Button type="primary" loading={busy} onClick={save}>
                    {bi("保存集群权限", "Save Cluster Access")}
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

/* ---------------------------------------------------------------- removed accounts */

export function DeletedPane({
  users,
  narrow,
}: {
  users: { username: string; disabled?: boolean }[];
  narrow: boolean;
}) {
  useLang();
  const { iam, reload } = useIAM();
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  if (!iam) return <Skeleton animation text={{ rows: 5 }} />;
  const move = async (d: Deleted) => {
    const to = pick[d.username];
    if (!to || busy) return;
    setBusy(d.username);
    try {
      const r = await api<{ moved: number }>(
        `/api/iam/deleted/${d.username}/move`,
        { method: "POST", body: JSON.stringify({ move_to: to }) },
      );
      Message.success(
        bi(
          `${r.moved} 份交付已交给 ${to}`,
          `Transferred ${r.moved} ${r.moved === 1 ? "delivery" : "deliveries"} to ${to}`,
        ),
      );
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
          <h1>{bi("已删除的账户", "Deleted Accounts")}</h1>
          <p>
            {bi(
              "这些用户名不会再分配给别人。他们名下还留着的交付，能看全部交付的人仍然看得到，也可以交给现在的同事接手。",
              "These usernames cannot be reused. Remaining deliveries are still visible to users with global scope and can be reassigned to an active user.",
            )}
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
                  {bi(
                    `${d.by} 在 ${fullTime(d.at)} 删除`,
                    `Deleted by ${d.by} on ${fullTime(d.at)}`,
                  )}
                  {d.moved
                    ? bi(
                        ` · ${d.moved_n || 0} 份交付已交给 ${d.moved}`,
                        ` · ${d.moved_n || 0} transferred to ${d.moved}`,
                      )
                    : ""}
                </small>
              </span>
              <span className="iam-del-jobs">
                {d.jobs
                  ? bi(
                      `名下还有 ${d.jobs} 份交付`,
                      `${d.jobs} ${d.jobs === 1 ? "delivery" : "deliveries"} remaining`,
                    )
                  : bi("名下没有交付", "No deliveries")}
              </span>
              {d.jobs > 0 && can("iam.user") && (
                <span className="row-gap">
                  <Select
                    style={{ minWidth: 200 }}
                    placeholder={bi("交给谁", "Transfer to")}
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
                    aria-label={bi("交给谁", "Transfer to")}
                  />
                  <Button
                    type="primary"
                    loading={busy === d.username}
                    disabled={!pick[d.username] || (Boolean(busy) && busy !== d.username)}
                    onClick={() => move(d)}
                  >
                    {bi("转交", "Transfer")}
                  </Button>
                </span>
              )}
            </li>
          ))}
      </ul>
    </article>
  );
}

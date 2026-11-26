import React, { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Input,
  Message,
  Modal,
  Select,
  Skeleton,
  Tooltip,
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
    "Add users, reset passwords, disable/enable accounts, and assign roles, teams, and clusters",
  ],
  "iam.role": [
    "Manage roles",
    "Create and edit role permissions and data scopes",
  ],
  "iam.team": [
    "Manage teams",
    "Create teams, manage members, and assign team cluster access",
  ],
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

export const SCOPES: {
  id: string;
  readonly title: string;
  readonly hint: string;
}[] = [
  {
    id: "own",
    get title() {
      return bi("仅自己创建", "Own Only");
    },
    get hint() {
      return bi(
        "默认只看得到自己创建的集群和交付；其他集群通过「集群授权」按需分配",
        "Sees own clusters by default; extra clusters can be granted individually",
      );
    },
  },
  {
    id: "team",
    get title() {
      return bi("所在团队共享", "Team Shared");
    },
    get hint() {
      return bi(
        "自动可见本人及同一团队成员创建的全部集群和交付",
        "Sees own clusters plus clusters created by teammates",
      );
    },
  },
  {
    id: "all",
    get title() {
      return bi("全平台全部", "All Clusters");
    },
    get hint() {
      return bi(
        "自动可见平台上所有人创建和纳管的全部集群",
        "Automatically sees every cluster across the platform",
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

/** Crisp 3-state inline access switch: None / Read-only / Operate */
function TriAccessSwitch({
  value,
  onChange,
  disabled,
}: {
  value: "" | ClusterAccessLevel;
  onChange: (next: "" | ClusterAccessLevel) => void;
  disabled?: boolean;
}) {
  useLang();
  return (
    <span
      className={`iam-tri-switch ${disabled ? "is-disabled" : ""}`}
      role="radiogroup"
      aria-label={bi("集群访问权限", "Cluster access")}
    >
      <button
        type="button"
        role="radio"
        aria-checked={value === ""}
        disabled={disabled}
        className={value === "" ? "on is-none" : ""}
        onClick={() => onChange("")}
      >
        {bi("未授权", "None")}
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
    </span>
  );
}

/** Interactive cluster grant table shared by User GrantEditor, AddAccount, and Team Drawer. */
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
  const [q, setQ] = useState("");
  const [onlyGranted, setOnlyGranted] = useState(false);

  const ownedClusters = useMemo(
    () => (ownedBy ? clusters.filter((c) => c.owner === ownedBy) : []),
    [clusters, ownedBy],
  );
  const assignable = useMemo(
    () => (ownedBy ? clusters.filter((c) => c.owner !== ownedBy) : clusters),
    [clusters, ownedBy],
  );
  const grantedCount = useMemo(
    () => assignable.filter((c) => value[c.id] || inherited?.[c.id]).length,
    [assignable, value, inherited],
  );

  const kw = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      assignable.filter((c) => {
        const hasAny = Boolean(value[c.id] || inherited?.[c.id]);
        if (onlyGranted && !hasAny) return false;
        if (!kw) return true;
        return (
          c.id.toLowerCase().includes(kw) ||
          c.app_name.toLowerCase().includes(kw) ||
          c.owner.toLowerCase().includes(kw)
        );
      }),
    [assignable, value, inherited, onlyGranted, kw],
  );

  const setOne = (cid: string, nextLvl: "" | ClusterAccessLevel) => {
    const next = { ...value };
    if (!nextLvl) delete next[cid];
    else next[cid] = nextLvl;
    onChange(next);
  };

  const batchShown = (lvl: "" | ClusterAccessLevel) => {
    const next = { ...value };
    for (const c of shown) {
      if (!lvl) delete next[c.id];
      else next[c.id] = lvl;
    }
    onChange(next);
  };

  if (clusters.length === 0) {
    return (
      <p className="faint small">
        {bi("平台上还没有已创建或纳管的集群。", "No clusters created yet.")}
      </p>
    );
  }

  return (
    <div className="iam-cl-picker">
      {ownedClusters.length > 0 && (
        <div className="iam-cl-owned-banner">
          <span>
            {bi(
              `本人创建的 ${ownedClusters.length} 个集群已默认拥有运维管理权限`,
              `${ownedClusters.length} cluster(s) created by this user have Operate access by default`,
            )}
          </span>
          <span className="iam-cl-owned-samples mono">
            {ownedClusters
              .slice(0, 3)
              .map((c) => c.id)
              .join("、")}
            {ownedClusters.length > 3 ? " …" : ""}
          </span>
        </div>
      )}

      {assignable.length === 0 ? (
        <p className="faint small">
          {bi(
            "当前全部集群均由该成员本人创建，已默认具备完整运维权限。",
            "All existing clusters were created by this user and are accessible by default.",
          )}
        </p>
      ) : (
        <>
          <div className="iam-cl-picker-bar">
            <Input
              size="small"
              prefix={<IconSearch />}
              allowClear
              value={q}
              onChange={setQ}
              placeholder={bi(
                "筛选集群、中间件或创建者...",
                "Filter cluster, middleware, or owner...",
              )}
              className="iam-cl-picker-search"
            />
            <div className="iam-pills">
              <button
                type="button"
                className={`iam-pill ${!onlyGranted ? "on" : ""}`}
                onClick={() => setOnlyGranted(false)}
              >
                {bi("全部可分配", "Assignable")} <em>{assignable.length}</em>
              </button>
              <button
                type="button"
                className={`iam-pill ${onlyGranted ? "on" : ""}`}
                onClick={() => setOnlyGranted(true)}
              >
                {bi("已获授权", "Granted")} <em>{grantedCount}</em>
              </button>
            </div>
            {!disabled && shown.length > 1 && (
              <span className="iam-cl-quick-batch">
                <button
                  type="button"
                  className="iam-text-act"
                  onClick={() => batchShown("operate")}
                >
                  {bi("全设为运维", "All Operate")}
                </button>
                <button
                  type="button"
                  className="iam-text-act"
                  onClick={() => batchShown("view")}
                >
                  {bi("全设为只读", "All Read-only")}
                </button>
                {Object.keys(value).length > 0 && (
                  <button
                    type="button"
                    className="iam-text-act is-danger"
                    onClick={() => batchShown("")}
                  >
                    {bi("清空", "Clear")}
                  </button>
                )}
              </span>
            )}
          </div>

          <div className="iam-cl-picker-list">
            {shown.length === 0 ? (
              <div className="iam-cl-picker-empty faint small">
                {bi("没有匹配的集群", "No matching clusters")}
              </div>
            ) : (
              shown.map((c) => {
                const direct = value[c.id] || "";
                const inh = inherited?.[c.id];
                return (
                  <div
                    key={c.id}
                    className={`iam-cl-picker-row ${direct ? "is-on" : ""}`}
                  >
                    <div className="iam-cl-picker-meta">
                      <span className="iam-cl-picker-title">
                        <b className="mono">{c.id}</b>
                        <span className="iam-app-pill">
                          {c.app_name} {c.version}
                        </span>
                        {inh && (
                          <span className="iam-inh-badge">
                            {bi(
                              `团队继承 · ${clusterLevelLabel(inh.level)}（${inh.from.join("/")}）`,
                              `Via ${inh.from.join("/")}: ${clusterLevelLabel(inh.level)}`,
                            )}
                          </span>
                        )}
                      </span>
                      <small>
                        {bi(`创建者：${c.owner}`, `Owner: ${c.owner}`)}
                      </small>
                    </div>
                    <TriAccessSwitch
                      value={direct}
                      disabled={disabled}
                      onChange={(next) => setOne(c.id, next)}
                    />
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
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
          ([m, ps]) =>
            [m, ps.filter((p) => perms.has(p.id))] as [string, Perm[]],
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
          "没有任何功能权限：只能登录并管理自己的账户。",
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
                  ? `，另已授权 ${clusterEntries.length} 个协作集群`
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

/** Choosing roles: compact 2-column porcelain card grid. */
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
    <div
      className="iam-picks iam-picks-grid"
      role="group"
      aria-label={bi("角色", "Roles")}
    >
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

/** Roles, teams, and per-cluster grants of one person, in a crisp 2-column card workspace. */
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
          "权限配置已保存并立即生效",
          "Permissions saved and applied immediately",
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
        <div className="iam-grant-main">
          <section className="iam-card-box">
            <h3 className="iam-card-box-title">{bi("角色分配", "Assigned Roles")}</h3>
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

            <h3 className="iam-card-box-title iam-gap">
              {bi("所属协作团队", "Team Memberships")}
            </h3>
            {editable ? (
              <Select
                mode="multiple"
                value={teams}
                onChange={setTeams}
                triggerProps={{ autoFitPosition: true }}
                placeholder={
                  iam.teams.length
                    ? bi("选择所属团队（自动继承团队的集群授权）", "Select teams")
                    : bi("尚未创建团队", "No teams yet")
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
          </section>

          <section className="iam-card-box">
            <h3 className="iam-card-box-title">
              {bi("按集群分配权限", "Per-Cluster Access")}
            </h3>
            {eff.scope === "all" ? (
              <div className="iam-cl-all-note">
                <IconCheck />
                <span>
                  {bi(
                    "当前角色数据范围为「全平台全部」，该成员自动拥有所有集群的可见权限，无需逐个分配。",
                    "Selected role scope is “All Clusters”, granting automatic access across every cluster.",
                  )}
                </span>
              </div>
            ) : (
              <ClusterGrantPicker
                clusters={iam.clusters || []}
                value={clusters}
                onChange={setClusters}
                disabled={!editable}
                ownedBy={user}
                inherited={inheritedClusters}
              />
            )}
          </section>
        </div>

        <aside className="iam-grant-side">
          <div className="iam-card-box iam-grant-summary-card">
            <h3 className="iam-card-box-title">
              {dirty
                ? bi("保存后生效的权限预览", "Effective Access Preview")
                : bi("当前生效权限总览", "Current Effective Access")}
            </h3>
            <EffectivePerms
              iam={iam}
              perms={eff.perms}
              scope={eff.scope}
              clusters={mergedClusters}
            />
            {editable && (
              <div className="iam-grant-foot">
                <Button
                  type="primary"
                  long={false}
                  loading={busy}
                  disabled={!dirty || roles.length === 0}
                  onClick={save}
                >
                  {bi("保存权限配置", "Save Changes")}
                </Button>
                {dirty && (
                  <Button
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
                    {bi("至少选择一个角色", "Select at least one role")}
                  </span>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- roles & full-width matrix */

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
  const [matrixMod, setMatrixMod] = useState<string>("all");
  const [onlyDiff, setOnlyDiff] = useState(false);
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
          "已保存，持有该角色的成员立即按新权限生效",
          "Role saved; updated permissions apply immediately",
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
            `当前有 ${r.holders} 位成员持有该角色，删除后他们将失去对应权限。`,
            `${r.holders} user(s) hold this role and will lose its permissions.`,
          )
        : bi("当前没有成员持有该角色。", "No users currently hold this role."),
      okText: bi("确认删除", "Delete"),
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

  const filteredMatrixModules = permModules
    .filter(([m]) => matrixMod === "all" || m === matrixMod)
    .map(([m, ps]) => {
      const rows = onlyDiff
        ? ps.filter((p) => {
            const firstHas = iam.roles[0]?.perms.includes(p.id);
            return iam.roles.some((r) => r.perms.includes(p.id) !== firstHas);
          })
        : ps;
      return [m, rows] as [string, Perm[]];
    })
    .filter(([, rows]) => rows.length > 0);

  return (
    <article className="iam-page enter">
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
          <h1>{bi("角色与权限矩阵", "Roles & Permission Matrix")}</h1>
          <p>
            {bi(
              "角色定义成员可执行的功能动作与默认数据视野（仅本人 / 所在团队 / 全平台）。内置角色锁定保护，一键复制即可自定义裁剪。",
              "Roles bundle functional permissions with default data visibility. Built-in roles are protected—duplicate any role to customize.",
            )}
          </p>
        </div>
        {editable && (
          <Button
            type="primary"
            icon={<IconPlus />}
            onClick={() => {
              setCompare(false);
              setSel("");
              setDraft({
                name: "",
                desc: "",
                perms: ["delivery.view"],
                scope: "own",
              });
            }}
          >
            {bi("新建角色", "New Role")}
          </Button>
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
        <div className="iam-matrix-sec">
          <div className="iam-toolbar">
            <div className="iam-pills" role="tablist">
              <button
                type="button"
                className={`iam-pill ${matrixMod === "all" ? "on" : ""}`}
                onClick={() => setMatrixMod("all")}
              >
                {bi("全部模块", "All Modules")} <em>{iam.perms.length}</em>
              </button>
              {permModules.map(([m, ps]) => (
                <button
                  key={m}
                  type="button"
                  className={`iam-pill ${matrixMod === m ? "on" : ""}`}
                  onClick={() => setMatrixMod(m)}
                >
                  {permModule(m)} <em>{ps.length}</em>
                </button>
              ))}
            </div>
            <Checkbox checked={onlyDiff} onChange={setOnlyDiff}>
              {bi("仅看角色间差异项", "Differences only")}
            </Checkbox>
          </div>

          <div className="iam-matrix-card">
            <div className="iam-cmp-wrap">
              <table className="iam-cmp">
                <thead>
                  <tr>
                    <th className="iam-cmp-perm-col">
                      {bi("功能权限项", "Permission")}
                    </th>
                    {iam.roles.map((r) => (
                      <th key={r.id}>
                        <div className="iam-cmp-rhead">
                          <b>{roleTitle(r)}</b>
                          <div className="iam-cmp-rmeta">
                            <span className="iam-cmp-scope">
                              {scopeName(r.scope)}
                            </span>
                            <small className="num">
                              {bi(`${r.holders} 人`, `${r.holders}`)}
                            </small>
                          </div>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredMatrixModules.map(([m, ps]) => (
                    <React.Fragment key={m}>
                      <tr className="iam-cmp-m">
                        <td colSpan={iam.roles.length + 1}>
                          <span>{permModule(m)}</span>
                          <em className="num">{ps.length}</em>
                        </td>
                      </tr>
                      {ps.map((p) => (
                        <tr key={p.id}>
                          <td className="iam-cmp-perm-cell">
                            <b>{permTitle(p)}</b>
                            <small>{permDesc(p)}</small>
                          </td>
                          {iam.roles.map((r) => {
                            const has = r.perms.includes(p.id);
                            return (
                              <td
                                key={r.id}
                                className={has ? "yes" : "no"}
                              >
                                {has ? (
                                  <span
                                    className="iam-cmp-yes"
                                    aria-label={bi("已开启", "Granted")}
                                  >
                                    <IconCheck />
                                  </span>
                                ) : (
                                  <span
                                    className="iam-cmp-no"
                                    aria-label={bi("未开启", "Not granted")}
                                  >
                                    —
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="iam-roles-full">
          <div
            className="iam-role-cards"
            role="listbox"
            aria-label={bi("选择角色", "Select role")}
          >
            {iam.roles.map((r) => {
              const active = draft ? draft.id === r.id : role?.id === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`iam-role-card ${active ? "on" : ""}`}
                  onClick={() => (setDraft(null), setSel(r.id))}
                >
                  <div className="iam-role-card-top">
                    <span className="iam-role-ic">
                      {r.builtin ? <IconLock /> : <IconUserGroup />}
                    </span>
                    <div className="iam-role-card-t">
                      <b>
                        {roleTitle(r)}
                        {r.builtin && (
                          <small className="iam-tag">
                            {bi("内置", "Built-in")}
                          </small>
                        )}
                      </b>
                    </div>
                  </div>
                  <p className="iam-role-card-desc">{roleDesc(r)}</p>
                  <div className="iam-role-card-foot num">
                    <span className="iam-cmp-scope">{scopeName(r.scope)}</span>
                    <span>
                      {bi(
                        `${r.perms.length} 项权限 · ${r.holders} 人`,
                        `${r.perms.length} perms · ${r.holders} users`,
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
            {draft && !draft.id && (
              <button type="button" className="iam-role-card on is-draft">
                <div className="iam-role-card-top">
                  <span className="iam-role-ic">
                    <IconPlus />
                  </span>
                  <div className="iam-role-card-t">
                    <b>{draft.name || bi("新建自定义角色", "New Custom Role")}</b>
                  </div>
                </div>
                <p className="iam-role-card-desc">
                  {draft.desc || bi("正在编辑新角色权限配置…", "Configuring new role…")}
                </p>
                <div className="iam-role-card-foot">
                  <span className="iam-cmp-scope">{scopeName(draft.scope)}</span>
                  <span>{bi("未保存草稿", "Unsaved draft")}</span>
                </div>
              </button>
            )}
          </div>

          {cur && (
            <section className="iam-role-workspace" key={cur.id || "new"}>
              <div className="iam-role-ws-head">
                {locked ? (
                  <div className="iam-role-ws-title">
                    <div className="iam-role-ws-hrow">
                      <h2>
                        {role && cur.id === role.id ? roleTitle(role) : cur.name}
                      </h2>
                      {role?.builtin && (
                        <span className="iam-ro-pill">
                          <IconLock />{" "}
                          {bi(
                            "内置角色只读 · 可复制为新角色修改",
                            "Built-in read-only · Duplicate to customize",
                          )}
                        </span>
                      )}
                    </div>
                    {cur.desc && (
                      <p className="muted">
                        {role && cur.id === role.id
                          ? roleDesc(role)
                          : normPermDesc(cur.desc)}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="iam-role-inputs">
                    <div className="iam-role-in-col">
                      <label>{bi("角色名称", "Role Name")}</label>
                      <Input
                        value={cur.name}
                        onChange={(v) => setDraft({ ...cur, name: v })}
                        placeholder={bi(
                          "例如：华东生产运维工程师",
                          "e.g., Production DBA",
                        )}
                        maxLength={30}
                      />
                    </div>
                    <div className="iam-role-in-col is-wide">
                      <label>{bi("角色职责说明", "Description")}</label>
                      <Input
                        value={cur.desc}
                        onChange={(v) => setDraft({ ...cur, desc: v })}
                        placeholder={bi(
                          "简述该角色适用的岗位职责与权限边界",
                          "Brief summary of responsibilities",
                        )}
                        maxLength={200}
                      />
                    </div>
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
                      {bi("复制为新角色", "Duplicate Role")}
                    </Button>
                  )}
                  {editable && role && !role.builtin && !draft && (
                    <Button
                      status="danger"
                      icon={<IconDelete />}
                      onClick={() => remove(role)}
                    >
                      {bi("删除", "Delete")}
                    </Button>
                  )}
                </span>
              </div>

              <div className="iam-sec">
                <h3>
                  {bi(
                    "默认集群与交付可见范围",
                    "Default Cluster & Delivery Visibility",
                  )}
                </h3>
                <div className="iam-scope-cards" role="radiogroup">
                  {SCOPES.map((s) => {
                    const active = cur.scope === s.id;
                    const disabledScope =
                      locked || !cur.perms.includes("delivery.view");
                    return (
                      <button
                        key={s.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={disabledScope}
                        className={`iam-scope-card ${active ? "on" : ""}`}
                        onClick={() => {
                          if (!disabledScope)
                            setDraft({ ...cur, scope: s.id });
                        }}
                      >
                        <div className="iam-scope-card-top">
                          <span className="iam-scope-dot" aria-hidden />
                          <b>{s.title}</b>
                        </div>
                        <small>{s.hint}</small>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="iam-sec">
                <h3>
                  {bi("功能模块权限", "Module Permissions")}{" "}
                  <em className="num">
                    {cur.perms.length} / {iam.perms.length}
                  </em>
                </h3>
                <div className="iam-tree">
                  {permModules.map(([m, ps]) => {
                    const n = ps.filter((p) => cur.perms.includes(p.id)).length;
                    const allModChecked = n === ps.length;
                    return (
                      <div
                        className={`iam-mod ${m === "AI" ? "is-ai-mod" : ""}`}
                        key={m}
                      >
                        <div
                          className="iam-mod-h"
                          onClick={() => {
                            if (!locked)
                              toggle(
                                ps.map((p) => p.id),
                                !allModChecked,
                              );
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
                                          if (!locked)
                                            toggle([p.id], !checked);
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
                                                "细粒度 AI 子模块开关",
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
                                                  "请先勾选上方「使用 AI（总入口）」",
                                                  "Enable “Use AI (master gate)” first",
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
                                                    <small>
                                                      {permDesc(sp)}
                                                    </small>
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
                      "仅可授出你自己已持有的权限与数据范围。",
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
                      ? bi("保存角色", "Save Role")
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
  onSaved,
}: {
  narrow: boolean;
  users: string[];
  onSaved?: () => void;
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
  const teamsWithClusters = iam.teams.filter(
    (t) => Object.keys(t.clusters || {}).length > 0,
  ).length;
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
      onSaved?.();
      setEdit(null);
      Message.success(bi("团队配置已保存", "Team saved"));
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="iam-page enter">
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
          <h1>{bi("协作团队", "Collaboration Teams")}</h1>
          <p>
            {bi(
              "按项目组或运维班组管理成员，支持将一批集群统一授权给团队，团队内成员自动继承对应的运维或只读权限。",
              "Organize users by project or squad and grant cluster access at the team level so members inherit it automatically.",
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
        <>
          <div className="au-strip iam-kpi-strip">
            <div className="au-stat">
              <span className="au-stat-k">{bi("团队总数", "Total Teams")}</span>
              <strong>{iam.teams.length}</strong>
              <small>{bi("按项目或业务线划分", "Grouped by project or site")}</small>
            </div>
            <div className="au-stat">
              <span className="au-stat-k">
                {bi("已有成员团队", "Active Teams")}
              </span>
              <strong>{activeCount}</strong>
              <small>{bi("成员自动共享团队授权", "Members inherit team grants")}</small>
            </div>
            <div className="au-stat">
              <span className="au-stat-k">
                {bi("已绑定集群的团队", "With Cluster Grants")}
              </span>
              <strong>{teamsWithClusters}</strong>
              <small>{bi("已配置集群运维或只读权限", "Assigned per-cluster access")}</small>
            </div>
            <div className="au-stat">
              <span className="au-stat-k">
                {bi("平台可选成员", "Available Users")}
              </span>
              <strong>{sorted.length}</strong>
              <small>{bi("支持一人同时加入多个团队", "Multi-team membership supported")}</small>
            </div>
          </div>

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
        </>
      )}

      {iam.teams.length === 0 ? (
        <div className="iam-empty iam-empty-card">
          <IconUserGroup />
          <b>{bi("还没有创建协作团队", "No collaboration teams yet")}</b>
          <span>
            {bi(
              "当多个集群需要同时开放给同一批工程师时，建一个团队即可批量授权、统一维护。",
              "Create a team to grant multiple clusters to a group of engineers in one place.",
            )}
          </span>
          {editable && (
            <Button
              type="primary"
              icon={<IconPlus />}
              style={{ marginTop: 8 }}
              onClick={() =>
                setEdit({ name: "", desc: "", members: [], clusters: {} })
              }
            >
              {bi("新建第一个团队", "Create First Team")}
            </Button>
          )}
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
          {shownTeams.map((t) => {
            const clEntries = stableClusterEntries(t.clusters);
            return (
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
                          `${t.members.length} 名成员 · ${clEntries.length} 个授权集群`,
                          `${t.members.length} members · ${clEntries.length} clusters`,
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
                        {bi("管理成员与集群", "Edit")}
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
                              "成员账户不会被删除，仅解除该团队关系及团队级集群授权。",
                              "User accounts are kept; team membership and team cluster grants will be removed.",
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
                                onSaved?.();
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
                  <span className="iam-team-cl-label">
                    {bi("成员", "Members")}
                  </span>
                  {t.members.length ? (
                    t.members.map((m) => (
                      <a
                        key={m}
                        href={`#/iam/${m}`}
                        onClick={(e) => {
                          e.preventDefault();
                          go({ name: "accounts", id: m });
                        }}
                      >
                        {m}
                      </a>
                    ))
                  ) : (
                    <span className="faint small">
                      {bi("暂未添加成员", "No members yet")}
                    </span>
                  )}
                </div>
                <div className="iam-team-clusters">
                  <span className="iam-team-cl-label">
                    {bi("授权集群", "Clusters")}
                  </span>
                  {clEntries.length > 0 ? (
                    clEntries.map(([cid, lvl]) => (
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
                    ))
                  ) : (
                    <span className="faint small">
                      {bi("未绑定额外集群", "No clusters assigned")}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Drawer
        width={620}
        style={{ maxWidth: "100vw" }}
        visible={!!edit}
        title={
          edit?.id
            ? bi(`管理团队 · ${edit.name}`, `Edit Team · ${edit.name}`)
            : bi("新建协作团队", "New Collaboration Team")
        }
        onCancel={() => setEdit(null)}
        footer={
          edit ? (
            <div className="iam-drawer-foot">
              <Button onClick={() => setEdit(null)}>
                {bi("取消", "Cancel")}
              </Button>
              <Button
                type="primary"
                loading={busy}
                disabled={!edit.name.trim()}
                onClick={save}
              >
                {bi("保存团队配置", "Save Team")}
              </Button>
            </div>
          ) : null
        }
      >
        {edit && (
          <div className="st-form">
            <div className="st-field">
              <span>{bi("团队名称", "Team Name")}</span>
              <Input
                value={edit.name}
                onChange={(v) => setEdit({ ...edit, name: v })}
                placeholder={bi("例如：数据库核心运维组", "e.g., Core DBA Squad")}
                maxLength={30}
              />
            </div>
            <div className="st-field">
              <span>{bi("职责备注（可选）", "Description (Optional)")}</span>
              <Input
                value={edit.desc}
                onChange={(v) => setEdit({ ...edit, desc: v })}
                placeholder={bi("简要说明该团队负责的环境或项目", "Optional notes")}
                maxLength={200}
              />
            </div>
            <div className="st-field">
              <span>{bi("团队成员", "Team Members")}</span>
              <Select
                mode="multiple"
                value={edit.members}
                onChange={(v) => setEdit({ ...edit, members: v })}
                triggerProps={{ autoFitPosition: true }}
                options={sorted.map((u) => ({ value: u, label: u }))}
                placeholder={bi("选择加入该团队的成员...", "Select members...")}
                allowClear
              />
            </div>
            {(iam.clusters?.length || 0) > 0 && (
              <div className="st-field">
                <span>
                  {bi(
                    "团队集群授权（成员自动继承）",
                    "Team Cluster Access (Inherited by Members)",
                  )}
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
      </Drawer>
    </article>
  );
}

/* ---------------------------------------------------------------- full-width cluster access ledger */

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
  const [appFilter, setAppFilter] = useState<string>("all");
  const [shareFilter, setShareFilter] = useState<"all" | "shared" | "private">(
    "all",
  );
  const [memberFilter, setMemberFilter] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [batchTargets, setBatchTargets] = useState<string[]>([]);
  const [batchAction, setBatchAction] = useState<
    "operate" | "view" | "revoke"
  >("operate");
  const [batchBusy, setBatchBusy] = useState(false);

  // Focused cluster Drawer (also auto-opened when jumping from Cluster Detail -> 集群权限设置)
  const [drawerClusterId, setDrawerClusterId] = useState<string>(() => {
    try {
      const f = sessionStorage.getItem("ds:iam-cluster-focus") || "";
      if (f) sessionStorage.removeItem("ds:iam-cluster-focus");
      return f;
    } catch {
      return "";
    }
  });
  const [drawerQuery, setDrawerQuery] = useState("");
  const [savingKey, setSavingKey] = useState<string>("");

  const clusters = useMemo(() => iam?.clusters || [], [iam?.clusters]);
  const globalRoles = useMemo(
    () => (iam?.roles || []).filter((r) => r.scope === "all"),
    [iam?.roles],
  );
  const globalRoleIds = useMemo(
    () => new Set(globalRoles.map((r) => r.id)),
    [globalRoles],
  );
  const roleMap = useMemo(
    () => new Map((iam?.roles || []).map((r) => [r.id, r])),
    [iam?.roles],
  );
  const teamMap = useMemo(
    () => new Map((iam?.teams || []).map((t) => [t.id, t])),
    [iam?.teams],
  );

  const userHasGlobalScope = (uname: string) => {
    const rids =
      iam?.grants[uname]?.roles ||
      users.find((u) => u.username === uname)?.roles ||
      [];
    return rids.some((id) => globalRoleIds.has(id));
  };

  const userRolesText = (uname: string) => {
    const rids =
      iam?.grants[uname]?.roles ||
      users.find((u) => u.username === uname)?.roles ||
      [];
    return rids
      .map((id) => {
        const r = roleMap.get(id);
        return r ? roleTitle(r) : id;
      })
      .join(bi("、", ", "));
  };

  const appOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of clusters) {
      counts.set(c.app_name, (counts.get(c.app_name) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [clusters]);

  const sharedCount = useMemo(
    () =>
      clusters.filter(
        (c) =>
          Object.keys(c.users || {}).length +
            Object.keys(c.teams || {}).length >
          0,
      ).length,
    [clusters],
  );

  const globalUsersCount = useMemo(
    () => users.filter((u) => !u.disabled && userHasGlobalScope(u.username)).length,
    [users, iam, globalRoleIds], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Effective access level of a specific member on a cluster (for memberFilter perspective)
  const memberEffectiveOnCluster = (uname: string, c: IAMCluster): string => {
    if (!uname) return "";
    if (userHasGlobalScope(uname)) return "operate";
    if (c.owner === uname) return "operate";
    const g = iam?.grants[uname];
    let best = g?.clusters?.[c.id] || "";
    for (const tid of g?.teams || []) {
      const tlvl = c.teams?.[tid] || "";
      if (LEVEL_RANK[tlvl] > LEVEL_RANK[best]) best = tlvl;
    }
    return best;
  };

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      clusters.filter((c) => {
        const grantTotal =
          Object.keys(c.users || {}).length + Object.keys(c.teams || {}).length;
        if (shareFilter === "shared" && grantTotal === 0) return false;
        if (shareFilter === "private" && grantTotal > 0) return false;
        if (appFilter !== "all" && c.app_name !== appFilter) return false;
        if (memberFilter && !memberEffectiveOnCluster(memberFilter, c))
          return false;
        if (!q) return true;
        if (
          c.id.toLowerCase().includes(q) ||
          c.app_name.toLowerCase().includes(q) ||
          c.owner.toLowerCase().includes(q)
        )
          return true;
        if (Object.keys(c.users || {}).some((u) => u.toLowerCase().includes(q)))
          return true;
        if (
          Object.keys(c.teams || {}).some((tid) =>
            (teamMap.get(tid)?.name || "").toLowerCase().includes(q),
          )
        )
          return true;
        return false;
      }),
    [clusters, shareFilter, appFilter, memberFilter, q, teamMap, iam], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (!iam) return <Skeleton animation text={{ rows: 8 }} />;

  const canUsers = can("iam.user");
  const canTeams = can("iam.team");
  const editable = canUsers || canTeams;

  // Instant single-cluster mutation (no bottom save bar needed!)
  const updateClusterAccess = async (
    c: IAMCluster,
    nextUsers: Record<string, ClusterAccessLevel>,
    nextTeams: Record<string, ClusterAccessLevel>,
    keyHint: string,
  ) => {
    if (savingKey) return;
    setSavingKey(keyHint);
    try {
      const payload: Record<string, unknown> = {};
      if (canUsers) payload.users = nextUsers;
      if (canTeams) payload.teams = nextTeams;
      const next = await api<IAM>(
        `/api/iam/clusters/${encodeURIComponent(c.id)}`,
        { method: "PUT", body: JSON.stringify(payload) },
      );
      set(next);
      onSaved?.();
    } catch (e) {
      err(e);
    } finally {
      setSavingKey("");
    }
  };

  // Batch apply to all checked clusters
  const applyBatch = async () => {
    if (batchBusy || selectedIds.size === 0 || batchTargets.length === 0)
      return;
    setBatchBusy(true);
    try {
      let latest: IAM | null = null;
      const byId = new Map(clusters.map((c) => [c.id, c]));
      let count = 0;
      for (const cid of selectedIds) {
        const c = byId.get(cid);
        if (!c) continue;
        const nextU: Record<string, ClusterAccessLevel> = {
          ...(c.users || {}),
        };
        const nextT: Record<string, ClusterAccessLevel> = {
          ...(c.teams || {}),
        };
        for (const target of batchTargets) {
          if (target.startsWith("u:") && canUsers) {
            const uname = target.slice(2);
            if (uname === c.owner) continue;
            if (batchAction === "revoke") delete nextU[uname];
            else nextU[uname] = batchAction;
          } else if (target.startsWith("t:") && canTeams) {
            const tid = target.slice(2);
            if (batchAction === "revoke") delete nextT[tid];
            else nextT[tid] = batchAction;
          }
        }
        const payload: Record<string, unknown> = {};
        if (canUsers) payload.users = nextU;
        if (canTeams) payload.teams = nextT;
        latest = await api<IAM>(
          `/api/iam/clusters/${encodeURIComponent(cid)}`,
          { method: "PUT", body: JSON.stringify(payload) },
        );
        count++;
      }
      if (latest) set(latest);
      onSaved?.();
      setSelectedIds(new Set());
      Message.success(
        bi(
          `已批量更新 ${count} 个集群的访问权限`,
          `Updated permissions across ${count} clusters`,
        ),
      );
    } catch (e) {
      err(e);
    } finally {
      setBatchBusy(false);
    }
  };

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id));
  const someFilteredSelected =
    filtered.some((c) => selectedIds.has(c.id)) && !allFilteredSelected;

  const toggleSelectAllFiltered = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const c of filtered) {
        if (checked) next.add(c.id);
        else next.delete(c.id);
      }
      return next;
    });
  };

  const toggleRowSelect = (cid: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(cid);
      else next.delete(cid);
      return next;
    });
  };

  const drawerCluster = drawerClusterId
    ? clusters.find((c) => c.id === drawerClusterId) || null
    : null;
  const dq = drawerQuery.trim().toLowerCase();
  const eligibleDrawerUsers = useMemo(
    () =>
      users
        .filter(
          (u) =>
            !u.disabled &&
            (!drawerCluster || u.username !== drawerCluster.owner) &&
            (!dq || u.username.toLowerCase().includes(dq)),
        )
        .sort((a, b) => {
          const ag = userHasGlobalScope(a.username) ? 1 : 0;
          const bg = userHasGlobalScope(b.username) ? 1 : 0;
          return ag !== bg ? ag - bg : a.username.localeCompare(b.username);
        }),
    [users, drawerCluster, dq, iam], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const eligibleDrawerTeams = useMemo(
    () =>
      (iam.teams || []).filter(
        (t) => !dq || t.name.toLowerCase().includes(dq),
      ),
    [iam.teams, dq],
  );

  // Options for batch target selector
  const batchTargetOptions = useMemo(() => {
    const opts: { label: string; value: string }[] = [];
    if (canUsers) {
      for (const u of users) {
        if (u.disabled || userHasGlobalScope(u.username)) continue;
        opts.push({
          value: `u:${u.username}`,
          label: bi(`成员 · ${u.username}`, `User · ${u.username}`),
        });
      }
    }
    if (canTeams) {
      for (const t of iam.teams) {
        opts.push({
          value: `t:${t.id}`,
          label: bi(
            `团队 · ${t.name} (${t.members.length}人)`,
            `Team · ${t.name} (${t.members.length})`,
          ),
        });
      }
    }
    return opts;
  }, [users, iam.teams, canUsers, canTeams, iam]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <article className="iam-page enter">
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
          <h1>{bi("集群授权", "Cluster Access Control")}</h1>
          <p>
            {bi(
              "每个集群默认归创建者本人运维，管理员与全局角色自动可见全部集群；勾选多行可一键批量授权，或点击单行直接切换「运维管理 / 只读查看」。",
              "Creators own their clusters by default and global roles see all. Toggle per-cluster access inline or select rows to grant in bulk.",
            )}
          </p>
        </div>
      </header>

      <div className="au-strip iam-kpi-strip">
        <div className="au-stat">
          <span className="au-stat-k">
            {bi("可管理集群总数", "Total Clusters")}
          </span>
          <strong>{clusters.length}</strong>
          <small>{bi("含平台部署与存量纳管集群", "Deployed & onboarded clusters")}</small>
        </div>
        <div className="au-stat">
          <span className="au-stat-k">
            {bi("已共享协作集群", "Shared Clusters")}
          </span>
          <strong>{sharedCount}</strong>
          <small>
            {bi("已额外分配成员或团队权限", "With explicit user or team grants")}
          </small>
        </div>
        <div className="au-stat">
          <span className="au-stat-k">
            {bi("默认创建者私有", "Creator-Only")}
          </span>
          <strong>{clusters.length - sharedCount}</strong>
          <small>
            {bi("仅创建者与全局角色可见", "Visible to creator & global roles")}
          </small>
        </div>
        <div className="au-stat">
          <span className="au-stat-k">
            {bi("全局视野成员", "Global Viewers")}
          </span>
          <strong>{globalUsersCount}</strong>
          <small>
            {globalRoles.map((r) => roleTitle(r)).join(" / ") || "—"}
          </small>
        </div>
      </div>

      {clusters.length === 0 ? (
        <div className="iam-empty iam-empty-card">
          <IconStorage />
          <b>{bi("还没有可分配权限的集群", "No clusters yet")}</b>
          <span>
            {bi(
              "新建交付或纳管存量集群后，即可在此统一配置协作访问权限。",
              "Create or onboard clusters first to configure per-cluster access.",
            )}
          </span>
        </div>
      ) : (
        <>
          <div className="iam-toolbar">
            <Input
              className="iam-search-in"
              prefix={<IconSearch />}
              allowClear
              value={query}
              onChange={setQuery}
              placeholder={bi(
                "搜索集群标识、组件、创建者或已授权成员...",
                "Search cluster, middleware, owner, or member...",
              )}
              aria-label={bi("搜索集群", "Search clusters")}
            />
            {appOptions.length > 1 && (
              <Select
                style={{ width: 176 }}
                value={appFilter}
                onChange={setAppFilter}
                triggerProps={{ autoFitPosition: true }}
                options={[
                  {
                    value: "all",
                    label: bi(
                      `全部组件 (${clusters.length})`,
                      `All Middleware (${clusters.length})`,
                    ),
                  },
                  ...appOptions.map(([app, n]) => ({
                    value: app,
                    label: `${app} (${n})`,
                  })),
                ]}
              />
            )}
            {users.length > 0 && (
              <Select
                style={{ width: 200 }}
                value={memberFilter || undefined}
                allowClear
                placeholder={bi("按成员视角查看...", "View as member...")}
                onChange={(v) => setMemberFilter(v || "")}
                triggerProps={{ autoFitPosition: true }}
                options={users
                  .filter((u) => !u.disabled)
                  .map((u) => ({
                    value: u.username,
                    label: bi(
                      `视角：${u.username}`,
                      `Member: ${u.username}`,
                    ),
                  }))}
              />
            )}
            <div className="iam-pills" role="tablist">
              <button
                type="button"
                className={`iam-pill ${shareFilter === "all" ? "on" : ""}`}
                onClick={() => setShareFilter("all")}
              >
                {bi("全部", "All")} <em>{clusters.length}</em>
              </button>
              <button
                type="button"
                className={`iam-pill ${shareFilter === "shared" ? "on" : ""}`}
                onClick={() => setShareFilter("shared")}
              >
                {bi("已共享", "Shared")} <em>{sharedCount}</em>
              </button>
              <button
                type="button"
                className={`iam-pill ${shareFilter === "private" ? "on" : ""}`}
                onClick={() => setShareFilter("private")}
              >
                {bi("仅创建者", "Creator Only")}{" "}
                <em>{clusters.length - sharedCount}</em>
              </button>
            </div>
          </div>

          {editable && selectedIds.size > 0 && (
            <div className="iam-batch-bar">
              <div className="iam-batch-left">
                <span className="iam-batch-cnt num">
                  {bi(
                    `已选 ${selectedIds.size} 个集群`,
                    `${selectedIds.size} selected`,
                  )}
                </span>
                {!allFilteredSelected && filtered.length > 1 && (
                  <button
                    type="button"
                    className="iam-text-act"
                    onClick={() => toggleSelectAllFiltered(true)}
                  >
                    {bi(
                      `全选当前筛选 (${filtered.length})`,
                      `Select all ${filtered.length}`,
                    )}
                  </button>
                )}
                <button
                  type="button"
                  className="iam-text-act"
                  onClick={() => setSelectedIds(new Set())}
                >
                  {bi("取消选择", "Clear")}
                </button>
              </div>
              <div className="iam-batch-right">
                <Select
                  mode="multiple"
                  style={{ minWidth: 240, maxWidth: 380 }}
                  value={batchTargets}
                  onChange={setBatchTargets}
                  options={batchTargetOptions}
                  placeholder={
                    batchTargetOptions.length
                      ? bi(
                          "选择要批量授权的成员或团队...",
                          "Select users or teams...",
                        )
                      : bi("暂无可授权普通成员或团队", "No target users/teams")
                  }
                  allowClear
                  triggerProps={{ autoFitPosition: true }}
                />
                <span className="iam-tri-switch">
                  <button
                    type="button"
                    className={batchAction === "operate" ? "on is-op" : ""}
                    onClick={() => setBatchAction("operate")}
                  >
                    {bi("运维管理", "Operate")}
                  </button>
                  <button
                    type="button"
                    className={batchAction === "view" ? "on is-view" : ""}
                    onClick={() => setBatchAction("view")}
                  >
                    {bi("只读查看", "Read-only")}
                  </button>
                  <button
                    type="button"
                    className={batchAction === "revoke" ? "on is-none" : ""}
                    onClick={() => setBatchAction("revoke")}
                  >
                    {bi("撤销权限", "Revoke")}
                  </button>
                </span>
                <Button
                  type="primary"
                  loading={batchBusy}
                  disabled={batchTargets.length === 0}
                  onClick={applyBatch}
                >
                  {bi(
                    `批量应用 (${selectedIds.size})`,
                    `Apply (${selectedIds.size})`,
                  )}
                </Button>
              </div>
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="iam-empty">
              <b>{bi("没有符合筛选条件的集群", "No clusters match filters")}</b>
              <Button
                size="small"
                onClick={() => {
                  setQuery("");
                  setAppFilter("all");
                  setShareFilter("all");
                  setMemberFilter("");
                }}
              >
                {bi("重置筛选", "Reset Filters")}
              </Button>
            </div>
          ) : (
            <div className="iam-ledger-card">
              <div className="iam-cl-lhead">
                <span className="iam-cl-chk-col">
                  {editable && (
                    <Checkbox
                      checked={allFilteredSelected}
                      indeterminate={someFilteredSelected}
                      onChange={toggleSelectAllFiltered}
                      aria-label={bi("全选当前集群", "Select all")}
                    />
                  )}
                </span>
                <span>{bi("集群标识与中间件", "Cluster & Middleware")}</span>
                <span>{bi("创建者（默认运维）", "Creator (Default Operate)")}</span>
                <span>
                  {bi(
                    "已授权协作成员与团队（点击标签可切换只读/运维）",
                    "Authorized Users & Teams (Click badge to toggle)",
                  )}
                </span>
                <span className="is-right">{bi("操作", "Actions")}</span>
              </div>

              <div className="iam-cl-lbody">
                {filtered.map((c) => {
                  const uEntries = stableClusterEntries(c.users);
                  const tEntries = stableClusterEntries(c.teams);
                  const checked = selectedIds.has(c.id);
                  const isDrawerOpen = drawerClusterId === c.id;
                  return (
                    <div
                      key={c.id}
                      className={`iam-cl-lrow ${checked ? "is-checked" : ""} ${isDrawerOpen ? "is-focused" : ""}`}
                    >
                      <div className="iam-cl-chk-col">
                        {editable && (
                          <Checkbox
                            checked={checked}
                            onChange={(v) => toggleRowSelect(c.id, v)}
                            aria-label={c.id}
                          />
                        )}
                      </div>

                      <div className="iam-cl-lmain">
                        <a
                          href={`#/d/${encodeURIComponent(c.id)}`}
                          className="iam-cl-id mono"
                          onClick={(e) => {
                            e.preventDefault();
                            go({ name: "deliveries", id: c.id });
                          }}
                        >
                          {c.id}
                        </a>
                        <span className="iam-app-pill">
                          {c.app_name} {c.version}
                        </span>
                      </div>

                      <div className="iam-cl-lowner">
                        <a
                          href={`#/iam/${encodeURIComponent(c.owner)}`}
                          className="iam-owner-link"
                          onClick={(e) => {
                            e.preventDefault();
                            go({ name: "accounts", id: c.owner });
                          }}
                        >
                          <IconUser />
                          <span>{c.owner}</span>
                        </a>
                      </div>

                      <div className="iam-cl-lgrants">
                        {uEntries.length === 0 && tEntries.length === 0 ? (
                          <span className="faint small">
                            {bi(
                              "仅创建者与全局角色可见",
                              "Creator & global roles only",
                            )}
                          </span>
                        ) : (
                          <>
                            {uEntries.map(([uname, lvl]) => {
                              const nextLvl: ClusterAccessLevel =
                                lvl === "operate" ? "view" : "operate";
                              const busyThis =
                                savingKey === `${c.id}:u:${uname}`;
                              return (
                                <span
                                  key={`u:${uname}`}
                                  className={`iam-grant-pill ${busyThis ? "is-busy" : ""}`}
                                >
                                  <IconUser className="iam-gp-ic" />
                                  <b className="iam-gp-name">{uname}</b>
                                  <Tooltip
                                    mini
                                    content={
                                      canUsers
                                        ? bi(
                                            `点击切换为「${clusterLevelLabel(nextLvl)}」`,
                                            `Click to switch to ${clusterLevelLabel(nextLvl)}`,
                                          )
                                        : undefined
                                    }
                                  >
                                    <button
                                      type="button"
                                      disabled={!canUsers || !!savingKey}
                                      className={`iam-lvl-tag is-${lvl} is-btn`}
                                      onClick={() =>
                                        void updateClusterAccess(
                                          c,
                                          { ...(c.users || {}), [uname]: nextLvl },
                                          c.teams || {},
                                          `${c.id}:u:${uname}`,
                                        )
                                      }
                                    >
                                      {lvl === "operate"
                                        ? bi("运维", "Operate")
                                        : bi("只读", "View")}
                                    </button>
                                  </Tooltip>
                                  {canUsers && (
                                    <button
                                      type="button"
                                      disabled={!!savingKey}
                                      className="iam-gp-rm"
                                      aria-label={bi(
                                        `移除 ${uname}`,
                                        `Remove ${uname}`,
                                      )}
                                      onClick={() => {
                                        const nextU = { ...(c.users || {}) };
                                        delete nextU[uname];
                                        void updateClusterAccess(
                                          c,
                                          nextU,
                                          c.teams || {},
                                          `${c.id}:u:${uname}`,
                                        );
                                      }}
                                    >
                                      <IconClose />
                                    </button>
                                  )}
                                </span>
                              );
                            })}
                            {tEntries.map(([tid, lvl]) => {
                              const t = teamMap.get(tid);
                              const nextLvl: ClusterAccessLevel =
                                lvl === "operate" ? "view" : "operate";
                              const busyThis = savingKey === `${c.id}:t:${tid}`;
                              return (
                                <span
                                  key={`t:${tid}`}
                                  className={`iam-grant-pill is-team ${busyThis ? "is-busy" : ""}`}
                                >
                                  <IconUserGroup className="iam-gp-ic" />
                                  <b className="iam-gp-name">
                                    {t?.name || tid}
                                  </b>
                                  <Tooltip
                                    mini
                                    content={
                                      canTeams
                                        ? bi(
                                            `点击切换团队为「${clusterLevelLabel(nextLvl)}」`,
                                            `Switch team to ${clusterLevelLabel(nextLvl)}`,
                                          )
                                        : undefined
                                    }
                                  >
                                    <button
                                      type="button"
                                      disabled={!canTeams || !!savingKey}
                                      className={`iam-lvl-tag is-${lvl} is-btn`}
                                      onClick={() =>
                                        void updateClusterAccess(
                                          c,
                                          c.users || {},
                                          { ...(c.teams || {}), [tid]: nextLvl },
                                          `${c.id}:t:${tid}`,
                                        )
                                      }
                                    >
                                      {lvl === "operate"
                                        ? bi("运维", "Operate")
                                        : bi("只读", "View")}
                                    </button>
                                  </Tooltip>
                                  {canTeams && (
                                    <button
                                      type="button"
                                      disabled={!!savingKey}
                                      className="iam-gp-rm"
                                      aria-label={bi(
                                        `移除团队 ${t?.name || tid}`,
                                        `Remove ${t?.name || tid}`,
                                      )}
                                      onClick={() => {
                                        const nextT = { ...(c.teams || {}) };
                                        delete nextT[tid];
                                        void updateClusterAccess(
                                          c,
                                          c.users || {},
                                          nextT,
                                          `${c.id}:t:${tid}`,
                                        );
                                      }}
                                    >
                                      <IconClose />
                                    </button>
                                  )}
                                </span>
                              );
                            })}
                          </>
                        )}
                      </div>

                      <div className="iam-cl-lact">
                        {editable && (
                          <Button
                            size="small"
                            onClick={() => {
                              setDrawerQuery("");
                              setDrawerClusterId(c.id);
                            }}
                          >
                            {bi("分配权限", "Assign")}
                          </Button>
                        )}
                        <Button
                          size="small"
                          type="text"
                          onClick={() => go({ name: "deliveries", id: c.id })}
                        >
                          {bi("打开", "Open")} <IconRight />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      <Drawer
        width={520}
        style={{ maxWidth: "100vw" }}
        visible={!!drawerCluster}
        onCancel={() => setDrawerClusterId("")}
        footer={null}
        title={
          drawerCluster ? (
            <span className="iam-drawer-title">
              <span>{bi("集群访问权限", "Cluster Access")}</span>
              <code className="mono">{drawerCluster.id}</code>
            </span>
          ) : (
            ""
          )
        }
      >
        {drawerCluster && (
          <div className="iam-cl-drawer">
            <div className="iam-cl-drawer-meta">
              <div>
                <span className="iam-app-pill">
                  {drawerCluster.app_name} {drawerCluster.version}
                </span>
                <span className="faint small" style={{ marginLeft: 8 }}>
                  {bi(
                    `创建者 ${drawerCluster.owner} 默认具备运维权限；点击下方开关立即生效`,
                    `Owner ${drawerCluster.owner} has Operate access by default; switches apply instantly`,
                  )}
                </span>
              </div>
            </div>

            {users.length + iam.teams.length > 5 && (
              <Input
                size="small"
                prefix={<IconSearch />}
                allowClear
                value={drawerQuery}
                onChange={setDrawerQuery}
                placeholder={bi(
                  "搜索成员或团队...",
                  "Filter users or teams...",
                )}
              />
            )}

            <div className="iam-cl-drawer-sec">
              <h4>
                {bi("平台成员", "Users")}{" "}
                <em className="num">{eligibleDrawerUsers.length}</em>
              </h4>
              {eligibleDrawerUsers.length === 0 ? (
                <p className="faint small">
                  {bi(
                    "除创建者外暂无其他启用的成员账户。",
                    "No other active user accounts besides the creator.",
                  )}
                </p>
              ) : (
                <div className="iam-cl-drawer-list">
                  {eligibleDrawerUsers.map((u) => {
                    const isGlobal = userHasGlobalScope(u.username);
                    const curLvl = drawerCluster.users?.[u.username] || "";
                    const rowBusy =
                      savingKey === `${drawerCluster.id}:u:${u.username}`;
                    return (
                      <div
                        key={u.username}
                        className={`iam-cl-drawer-row ${rowBusy ? "is-busy" : ""}`}
                      >
                        <div className="iam-cl-drawer-who">
                          <b>{u.username}</b>
                          <small>{userRolesText(u.username)}</small>
                        </div>
                        {isGlobal ? (
                          <span className="iam-scope-badge is-all">
                            {bi("全局角色 · 自动可见", "Global Role · Auto")}
                          </span>
                        ) : (
                          <TriAccessSwitch
                            value={curLvl}
                            disabled={!canUsers || !!savingKey}
                            onChange={(nextLvl) => {
                              const nextU = { ...(drawerCluster.users || {}) };
                              if (!nextLvl) delete nextU[u.username];
                              else nextU[u.username] = nextLvl;
                              void updateClusterAccess(
                                drawerCluster,
                                nextU,
                                drawerCluster.teams || {},
                                `${drawerCluster.id}:u:${u.username}`,
                              );
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="iam-cl-drawer-sec">
              <div className="iam-cl-drawer-sec-h">
                <h4>
                  {bi("协作团队", "Teams")}{" "}
                  <em className="num">{eligibleDrawerTeams.length}</em>
                </h4>
                {iam.teams.length === 0 && canTeams && (
                  <button
                    type="button"
                    className="iam-text-act"
                    onClick={() => {
                      setDrawerClusterId("");
                      go({ name: "accounts", id: "~teams" });
                    }}
                  >
                    {bi("去创建团队 →", "Create a team →")}
                  </button>
                )}
              </div>
              {eligibleDrawerTeams.length === 0 ? (
                <p className="faint small">
                  {bi(
                    "尚未创建团队；创建团队后可将集群一键授权给整组成员。",
                    "No teams created yet.",
                  )}
                </p>
              ) : (
                <div className="iam-cl-drawer-list">
                  {eligibleDrawerTeams.map((t) => {
                    const curLvl = drawerCluster.teams?.[t.id] || "";
                    const rowBusy =
                      savingKey === `${drawerCluster.id}:t:${t.id}`;
                    return (
                      <div
                        key={t.id}
                        className={`iam-cl-drawer-row ${rowBusy ? "is-busy" : ""}`}
                      >
                        <div className="iam-cl-drawer-who">
                          <b>{t.name}</b>
                          <small>
                            {t.members.length > 0
                              ? bi(
                                  `${t.members.length} 人：${t.members.slice(0, 4).join("、")}${t.members.length > 4 ? "…" : ""}`,
                                  `${t.members.length}: ${t.members.slice(0, 4).join(", ")}${t.members.length > 4 ? "…" : ""}`,
                                )
                              : bi("暂无成员", "No members")}
                          </small>
                        </div>
                        <TriAccessSwitch
                          value={curLvl}
                          disabled={!canTeams || !!savingKey}
                          onChange={(nextLvl) => {
                            const nextT = { ...(drawerCluster.teams || {}) };
                            if (!nextLvl) delete nextT[t.id];
                            else nextT[t.id] = nextLvl;
                            void updateClusterAccess(
                              drawerCluster,
                              drawerCluster.users || {},
                              nextT,
                              `${drawerCluster.id}:t:${t.id}`,
                            );
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>
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
    <article className="iam-page enter">
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
          <h1>{bi("已归档账户", "Archived Accounts")}</h1>
          <p>
            {bi(
              "已删除账户的用户名永久锁定不可复用，以保证历史审计可追溯；其名下留存的集群与交付可一键转交给在职同事。",
              "Deleted usernames remain retired for audit traceability; remaining deliveries can be reassigned to active users.",
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
                    placeholder={bi("选择接手成员", "Transfer to")}
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
                  />
                  <Button
                    type="primary"
                    loading={busy === d.username}
                    disabled={
                      !pick[d.username] ||
                      (Boolean(busy) && busy !== d.username)
                    }
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

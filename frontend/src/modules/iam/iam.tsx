import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Input,
  Message,
  Modal,
  Popover,
  Select,
  Skeleton,
  Switch,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheck,
  IconClose,
  IconCopy,
  IconDelete,
  IconExclamationCircle,
  IconLock,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSearch,
  IconStorage,
  IconThunderbolt,
  IconUser,
  IconUserGroup,
} from "@arco-design/web-react/icon";
import {
  api,
  can,
  err,
  fullTime,
  refreshAIStatus,
  typing,
} from "../../shared/shared";
import type { Account, ClusterAccessLevel } from "../../shared/shared";
import { go } from "../../app/router";
import { Kbd, UnderlineTabs } from "../../design/ui";
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
export type IAMAgentMode = "readonly" | "readwrite";
export type IAMAgentBrief = {
  id: string;
  backing: string;
  name: string;
  ip: string;
  online: boolean;
  disabled: boolean;
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
  agents?: Record<string, IAMAgentMode>;
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
  agents?: IAMAgentBrief[];
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

const stableAgentEntries = (m?: Record<string, IAMAgentMode>) =>
  Object.entries(m || {})
    .filter(([, v]) => v === "readonly" || v === "readwrite")
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
        "默认只看得到本人创建的集群；协作集群通过「集群授权」按需分配",
        "Sees own clusters by default; extra clusters granted per cluster",
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
        "自动可见本人及同一团队成员创建的全部集群",
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
        "自动可见平台上所有成员创建与纳管的全部集群",
        "Automatically sees every cluster across the platform",
      );
    },
  },
];
export const scopeName = (s: string) =>
  SCOPES.find((x) => x.id === s)?.title || s;

let memo: IAM | null = null;
export function invalidateIAMCache() {
  memo = null;
}
if (typeof window !== "undefined") {
  window.addEventListener("mh-lang-change", () => {
    memo = null;
  });
}

export function useIAM() {
  const lang = useLang();
  const [d, setD] = useState<IAM | null>(memo);
  const [error, setError] = useState<string>("");
  const load = () => {
    setError("");
    return api<IAM>("/api/iam")
      .then((x) => {
        memo = x;
        setD(x);
      })
      .catch((e) => {
        setError((e as Error).message || bi("权限数据加载失败", "Failed to load IAM data"));
      });
  };
  useEffect(() => {
    let alive = true;
    setError("");
    api<IAM>("/api/iam")
      .then((x) => {
        memo = x;
        if (alive) setD(x);
      })
      .catch((e) => {
        if (alive) {
          setError((e as Error).message || bi("权限数据加载失败", "Failed to load IAM data"));
        }
      });
    return () => {
      alive = false;
    };
  }, [lang]);
  return {
    iam: d,
    error,
    reload: load,
    set: (x: IAM) => ((memo = x), setD(x)),
  };
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

/** Apple-inspired gliding 3-state inline access switch: None / Read-only / Operate */
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
  const idx = value === "operate" ? 2 : value === "view" ? 1 : 0;
  return (
    <span
      className={`iam-tri-switch ${disabled ? "is-disabled" : ""} idx-${idx}`}
      style={{ "--tri-idx": idx } as React.CSSProperties}
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
        {bi("只读", "View")}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "operate"}
        disabled={disabled}
        className={value === "operate" ? "on is-op" : ""}
        onClick={() => onChange("operate")}
      >
        {bi("运维", "Operate")}
      </button>
    </span>
  );
}

/** Apple-inspired gliding 3-state inline access switch for Cluster Agents: Disabled / Read-only / Read-write */
function TriAgentSwitch({
  value,
  onChange,
  disabled,
}: {
  value: "" | IAMAgentMode;
  onChange: (next: "" | IAMAgentMode) => void;
  disabled?: boolean;
}) {
  useLang();
  const idx = value === "readwrite" ? 2 : value === "readonly" ? 1 : 0;
  return (
    <span
      className={`iam-tri-switch ${disabled ? "is-disabled" : ""} idx-${idx}`}
      style={{ "--tri-idx": idx } as React.CSSProperties}
      role="radiogroup"
      aria-label={bi("Agent 集群权限", "Agent cluster access")}
    >
      <button
        type="button"
        role="radio"
        aria-checked={value === ""}
        disabled={disabled}
        className={value === "" ? "on is-none" : ""}
        onClick={() => onChange("")}
      >
        {bi("禁用", "Off")}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "readonly"}
        disabled={disabled}
        className={value === "readonly" ? "on is-view" : ""}
        onClick={() => onChange("readonly")}
      >
        {bi("只读", "RO")}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "readwrite"}
        disabled={disabled}
        className={value === "readwrite" ? "on is-op" : ""}
        onClick={() => onChange("readwrite")}
      >
        {bi("读写", "RW")}
      </button>
    </span>
  );
}

/** Interactive cluster grant list shared by User GrantEditor, AddAccount, and Team Drawer. */
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
      <p className="iam-inline-empty">
        {bi("平台上暂无已创建或纳管的集群。", "No clusters created yet.")}
      </p>
    );
  }

  return (
    <div className="iam-cl-picker">
      {ownedClusters.length > 0 && (
        <div className="iam-cl-owned-banner">
          <span>
            {bi(
              `本人创建的 ${ownedClusters.length} 个集群已默认具备运维权限`,
              `${ownedClusters.length} own cluster(s) have Operate access by default`,
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
        <p className="iam-inline-empty">
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
                "搜索集群、中间件或创建者…",
                "Search cluster, middleware, or owner…",
              )}
              className="iam-cl-picker-search"
            />
            <div className="iam-pills">
              <button
                type="button"
                className={`iam-pill sm ${!onlyGranted ? "on" : ""}`}
                onClick={() => setOnlyGranted(false)}
              >
                {bi("全部可分配", "All")} <em>{assignable.length}</em>
              </button>
              <button
                type="button"
                className={`iam-pill sm ${onlyGranted ? "on" : ""}`}
                onClick={() => setOnlyGranted(true)}
              >
                {bi("已授权", "Granted")} <em>{grantedCount}</em>
              </button>
            </div>
            {!disabled && shown.length > 1 && (
              <span className="iam-cl-quick-batch">
                <button
                  type="button"
                  className="iam-text-act"
                  onClick={() => batchShown("operate")}
                >
                  {bi("全设运维", "All Operate")}
                </button>
                <button
                  type="button"
                  className="iam-text-act"
                  onClick={() => batchShown("view")}
                >
                  {bi("全设只读", "All Read-only")}
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

/** Grouped effective permissions summary. */
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
      <p className="iam-inline-empty">
        {bi(
          "暂无功能权限：仅可登录并管理个人账户设置。",
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
                      ? "本人及同团队"
                      : "本人创建"}
                </b>{" "}
                集群
                {scope !== "all" && clusterEntries.length > 0
                  ? `，另含 ${clusterEntries.length} 个授权集群`
                  : ""}
              </>,
              <>
                Default:{" "}
                <b>
                  {scope === "all"
                    ? "all platform clusters"
                    : scope === "team"
                      ? "own & team clusters"
                      : "own clusters"}
                </b>
                {scope !== "all" && clusterEntries.length > 0
                  ? ` + ${clusterEntries.length} granted`
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
      <div className="iam-eff-list">
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
    </div>
  );
}

/** Clean hairline role selector list/grid (zero nested heavy card shadows). */
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
      className="iam-picks-grid"
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

/** Continuous section GrantEditor for User Profile or Quick Slide-Over Drawer. */
export function GrantEditor({
  user,
  iam,
  onSaved,
  compact = false,
}: {
  user: string;
  iam: IAM;
  onSaved: () => void;
  compact?: boolean;
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
    <div className={`iam-grant ${compact ? "is-compact" : ""}`}>
      <div className={compact ? "iam-grant-single" : "iam-grant-cols"}>
        <div className="iam-grant-main">
          <section className="iam-cont-sec">
            <div className="iam-cont-sec-h">
              <h2>{bi("角色分配", "Assigned Roles")}</h2>
              {roles.length === 0 && (
                <span className="bad small">
                  {bi("请至少勾选 1 个角色", "Select at least 1 role")}
                </span>
              )}
            </div>
            {editable ? (
              <RolePicker iam={iam} value={roles} onChange={setRoles} />
            ) : (
              <p className="iam-readonly-line">
                {roles
                  .map((id) => {
                    const found = iam.roles.find((r) => r.id === id);
                    return found ? roleTitle(found) : id;
                  })
                  .join(bi("、", ", "))}
              </p>
            )}
          </section>

          <section className="iam-cont-sec">
            <div className="iam-cont-sec-h">
              <h2>{bi("所属协作团队", "Team Memberships")}</h2>
            </div>
            {editable ? (
              <Select
                mode="multiple"
                value={teams}
                onChange={setTeams}
                triggerProps={{ autoFitPosition: true }}
                placeholder={
                  iam.teams.length
                    ? bi("选择所属团队（自动继承团队的集群权限）…", "Select teams…")
                    : bi("尚未创建协作团队", "No teams created yet")
                }
                options={iam.teams.map((t) => ({ value: t.id, label: t.name }))}
                allowClear
                aria-label={bi("团队", "Teams")}
              />
            ) : (
              <p className="iam-readonly-line">
                {teams
                  .map((id) => iam.teams.find((t) => t.id === id)?.name || id)
                  .join(bi("、", ", ")) || bi("未加入任何团队", "No team memberships")}
              </p>
            )}
          </section>

          <section className="iam-cont-sec">
            <div className="iam-cont-sec-h">
              <h2>{bi("跨集群附加授权", "Per-Cluster Access")}</h2>
            </div>
            {eff.scope === "all" ? (
              <div className="iam-cl-all-note">
                <IconCheck />
                <span>
                  {bi(
                    "所选角色具备「全平台全部」数据视野，自动可见所有集群，无需单独分配。",
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

        {!compact && (
          <aside className="iam-grant-side">
            <div className="iam-cont-sec">
              <div className="iam-cont-sec-h">
                <h2>
                  {dirty
                    ? bi("变更后生效预览", "Preview After Save")
                    : bi("生效权限速览", "Effective Access")}
                </h2>
              </div>
              <EffectivePerms
                iam={iam}
                perms={eff.perms}
                scope={eff.scope}
                clusters={mergedClusters}
              />
            </div>
          </aside>
        )}
      </div>

      {editable && (dirty || compact) && (
        <div className={`iam-float-save ${dirty ? "is-dirty" : ""}`}>
          <span className="iam-float-note">
            {roles.length === 0
              ? bi("请至少保留一个角色后再保存", "Select at least one role to save")
              : dirty
                ? bi("有未保存的权限变更，保存后立即生效", "Unsaved permission changes")
                : bi("当前未做修改", "No unsaved changes")}
          </span>
          <div className="iam-float-acts">
            {dirty && (
              <Button
                size="small"
                onClick={() => {
                  setRoles(g.roles);
                  setTeams(g.teams);
                  setClusters({ ...(g.clusters || {}) });
                }}
              >
                {bi("还原", "Reset")}
              </Button>
            )}
            <Button
              size="small"
              type="primary"
              loading={busy}
              disabled={!dirty || roles.length === 0}
              onClick={save}
            >
              {bi("保存权限配置", "Save Changes")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- roles & matrix */

type Draft = {
  id?: string;
  name: string;
  desc: string;
  perms: string[];
  scope: string;
};

export function RolesPane({
  narrow,
  iamError,
}: {
  narrow: boolean;
  iamError?: string;
}) {
  useLang();
  const { iam, reload, set } = useIAM();
  const [sel, setSel] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [compare, setCompare] = useState(false);
  const [matrixMod, setMatrixMod] = useState<string>("all");
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const roleBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const editable = can("iam.role");
  const role = iam?.roles.find((r) => r.id === sel) || iam?.roles[0];
  const permModules = useMemo(
    () => (iam ? modules(iam.perms) : []),
    [iam],
  );

  if (iamError && !iam) {
    return (
      <article className="iam-page iam-stage">
        <div className="iam-empty iam-empty-line">
          <IconExclamationCircle className="bad" />
          <b>{iamError}</b>
          <Button size="small" icon={<IconRefresh />} onClick={reload}>
            {bi("重试", "Retry")}
          </Button>
        </div>
      </article>
    );
  }
  if (!iam) {
    return (
      <article className="iam-page">
        <Skeleton animation text={{ rows: 8 }} />
      </article>
    );
  }

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
          "角色已保存，持有该角色的成员立即按新权限生效",
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
    <article className="iam-page iam-stage">
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
        <div className="iam-h-main">
          <div className="iam-h-title-row">
            <h1>{bi("角色权限", "Roles")}</h1>
            <span className="iam-h-meta num">
              {bi(
                `${iam.roles.length} 个角色 · ${iam.perms.length} 项权限`,
                `${iam.roles.length} roles · ${iam.perms.length} permissions`,
              )}
            </span>
          </div>
          <p>
            {bi(
              "按岗位定义功能动作开关与默认数据视野；内置角色只读保护，一键复制即可派生自定义角色。",
              "Define functional permissions and default visibility per role. Duplicate any built-in role to customize.",
            )}
          </p>
        </div>
        <div className="iam-h-acts">
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
        </div>
      </header>

      <UnderlineTabs
        className="iam-subtabs"
        label={bi("角色视图", "Role views")}
        value={compare ? "compare" : "edit"}
        onChange={(v) => setCompare(v === "compare")}
        items={[
          {
            value: "edit",
            label: bi("角色配置", "Configuration"),
            count: iam.roles.length,
            icon: IAMIcons.roleEdit,
          },
          {
            value: "compare",
            label: bi("权限对比矩阵", "Comparison Matrix"),
            count: iam.perms.length,
            icon: IAMIcons.roleMatrix,
          },
        ]}
      />

      {compare ? (
        <div className="iam-matrix-sec iam-stage" key="matrix">
          <div className="iam-toolbar">
            <div className="iam-pills" role="tablist">
              <button
                type="button"
                className={`iam-pill ${matrixMod === "all" ? "on" : ""}`}
                onClick={() => setMatrixMod("all")}
              >
                {bi("全部模块", "All")} <em>{iam.perms.length}</em>
              </button>
              {permModules.map(([m, ps]) => (
                <button
                  key={m}
                  type="button"
                  className={`iam-pill ${matrixMod === m ? "on" : ""}`}
                  onClick={() => setMatrixMod(matrixMod === m ? "all" : m)}
                >
                  {permModule(m)} <em>{ps.length}</em>
                </button>
              ))}
            </div>
            <label className="iam-inline-switch">
              <Switch size="small" checked={onlyDiff} onChange={setOnlyDiff} />
              <span>{bi("仅显示角色间差异项", "Differences only")}</span>
            </label>
          </div>

          <div className="iam-ledger iam-matrix-wrap">
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
        <div className="iam-role-split iam-stage" key="edit">
          <aside
            className="iam-role-list"
            role="listbox"
            aria-label={bi("角色列表", "Role list")}
          >
            {iam.roles.map((r, idx) => {
              const active = draft ? draft.id === r.id : role?.id === r.id;
              return (
                <button
                  key={r.id}
                  ref={(el) => {
                    roleBtnRefs.current[idx] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`iam-role-item ${active ? "on" : ""}`}
                  onClick={() => {
                    setDraft(null);
                    setSel(r.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      const next = Math.min(iam.roles.length - 1, idx + 1);
                      setDraft(null);
                      setSel(iam.roles[next].id);
                      roleBtnRefs.current[next]?.focus();
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      const prev = Math.max(0, idx - 1);
                      setDraft(null);
                      setSel(iam.roles[prev].id);
                      roleBtnRefs.current[prev]?.focus();
                    }
                  }}
                >
                  <div className="iam-role-item-top">
                    <b>{roleTitle(r)}</b>
                    {r.builtin && (
                      <span className="iam-tag">{bi("内置", "Built-in")}</span>
                    )}
                  </div>
                  <div className="iam-role-item-meta num">
                    <span>{scopeName(r.scope)}</span>
                    <span>
                      {bi(
                        `${r.holders} 人 · ${r.perms.length} 项`,
                        `${r.holders} u · ${r.perms.length} p`,
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
            {draft && !draft.id && (
              <button
                type="button"
                role="option"
                aria-selected
                className="iam-role-item on is-draft"
              >
                <div className="iam-role-item-top">
                  <b>{draft.name || bi("新建自定义角色", "New Custom Role")}</b>
                  <span className="iam-tag">{bi("草稿", "Draft")}</span>
                </div>
                <div className="iam-role-item-meta">
                  <span>{scopeName(draft.scope)}</span>
                  <span>{bi("尚未保存", "Unsaved")}</span>
                </div>
              </button>
            )}
          </aside>

          {cur && (
            <section className="iam-role-detail iam-stage" key={cur.id || "new"}>
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
                            "内置只读 · 可复制为新角色裁剪",
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
                          "例如：生产数据库运维",
                          "e.g., Production DBA",
                        )}
                        maxLength={30}
                      />
                    </div>
                    <div className="iam-role-in-col is-wide">
                      <label>{bi("职责描述", "Description")}</label>
                      <Input
                        value={cur.desc}
                        onChange={(v) => setDraft({ ...cur, desc: v })}
                        placeholder={bi(
                          "简述适用人群与权限边界",
                          "Brief summary of responsibilities",
                        )}
                        maxLength={200}
                      />
                    </div>
                  </div>
                )}

                <div className="iam-role-ws-acts">
                  {editable && role && !draft && (
                    <Button
                      size="small"
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
                      size="small"
                      status="danger"
                      icon={<IconDelete />}
                      onClick={() => remove(role)}
                    >
                      {bi("删除", "Delete")}
                    </Button>
                  )}
                </div>
              </div>

              <div className="iam-cont-sec">
                <div className="iam-cont-sec-h">
                  <h2>{bi("默认数据可见范围", "Default Data Visibility")}</h2>
                </div>
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
                          if (!disabledScope) setDraft({ ...cur, scope: s.id });
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

              <div className="iam-cont-sec">
                <div className="iam-cont-sec-h">
                  <h2>{bi("功能模块权限", "Module Permissions")}</h2>
                  <span className="num">
                    {cur.perms.length} / {iam.perms.length}
                  </span>
                </div>

                <div className="iam-perm-sections">
                  {permModules.map(([m, ps]) => {
                    const n = ps.filter((p) => cur.perms.includes(p.id)).length;
                    const allModChecked = n === ps.length;
                    return (
                      <div className="iam-perm-group" key={m}>
                        <div
                          className={`iam-perm-group-h ${locked ? "is-locked" : ""}`}
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

                        {m === "AI" ? (
                          <div className="iam-perm-ai-body">
                            <div className="iam-perm-grid">
                              {ps
                                .filter((p) => !p.id.startsWith("ai.feat."))
                                .map((p) => {
                                  const checked = cur.perms.includes(p.id);
                                  return (
                                    <div
                                      key={p.id}
                                      className={`iam-perm-row ${checked ? "on" : ""} ${locked ? "is-locked" : ""}`}
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
                                  );
                                })}
                            </div>

                            {(() => {
                              const subPerms = ps.filter((x) =>
                                x.id.startsWith("ai.feat."),
                              );
                              const useOn = cur.perms.includes("ai.use");
                              if (!subPerms.length) return null;
                              return (
                                <div
                                  className={`iam-ai-sub-block ${!useOn ? "is-locked" : ""}`}
                                >
                                  <div className="iam-ai-sub-bar">
                                    <span>
                                      {bi(
                                        "细粒度 AI 场景权限",
                                        "Granular AI Capabilities",
                                      )}{" "}
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
                                          "Enable “Use AI (master gate)” above first",
                                        )}
                                      </small>
                                    )}
                                  </div>
                                  <div className="iam-perm-grid">
                                    {subPerms.map((sp) => {
                                      const spOn = cur.perms.includes(sp.id);
                                      return (
                                        <div
                                          key={sp.id}
                                          className={`iam-perm-row ${spOn ? "on" : ""} ${locked || !useOn ? "is-locked" : ""}`}
                                          onClick={() => {
                                            if (!locked && useOn) {
                                              toggle([sp.id], !spOn);
                                            }
                                          }}
                                        >
                                          <Checkbox
                                            checked={spOn}
                                            disabled={locked || !useOn}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(v) => toggle([sp.id], v)}
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
                              );
                            })()}
                          </div>
                        ) : (
                          <div className="iam-perm-grid">
                            {ps.map((p) => {
                              const pOn = cur.perms.includes(p.id);
                              return (
                                <div
                                  key={p.id}
                                  className={`iam-perm-row ${pOn ? "on" : ""} ${locked ? "is-locked" : ""}`}
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
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {dirty && (
                <div className="iam-float-save is-dirty">
                  <span className="iam-float-note">
                    {bi(
                      "仅可授出你自己已持有的功能权限与数据范围",
                      "You can only grant permissions that you hold yourself",
                    )}
                  </span>
                  <div className="iam-float-acts">
                    <Button size="small" onClick={() => setDraft(null)}>
                      {bi("取消", "Cancel")}
                    </Button>
                    <Button
                      size="small"
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
  iamError,
  onSaved,
}: {
  narrow: boolean;
  users: string[];
  iamError?: string;
  onSaved?: () => void;
}) {
  useLang();
  const { iam, reload, set } = useIAM();
  const [edit, setEdit] = useState<{
    id?: string;
    name: string;
    desc: string;
    members: string[];
    clusters: Record<string, ClusterAccessLevel>;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "active" | "empty">("all");
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const editable = can("iam.team");
  const sorted = useMemo(() => [...users].sort(), [users]);

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

  if (iamError && !iam) {
    return (
      <article className="iam-page iam-stage">
        <div className="iam-empty iam-empty-line">
          <IconExclamationCircle className="bad" />
          <b>{iamError}</b>
          <Button size="small" icon={<IconRefresh />} onClick={reload}>
            {bi("重试", "Retry")}
          </Button>
        </div>
      </article>
    );
  }
  if (!iam) {
    return (
      <article className="iam-page">
        <Skeleton animation text={{ rows: 6 }} />
      </article>
    );
  }

  const activeCount = iam.teams.filter((t) => t.members.length > 0).length;
  const emptyCount = iam.teams.length - activeCount;
  const q = query.trim().toLowerCase();
  const shownTeams = iam.teams.filter((t) => {
    if (tab === "active" && t.members.length === 0) return false;
    if (tab === "empty" && t.members.length > 0) return false;
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      (t.desc || "").toLowerCase().includes(q) ||
      t.members.some((m) => m.toLowerCase().includes(q)) ||
      Object.keys(t.clusters || {}).some((cid) => cid.toLowerCase().includes(q))
    );
  });

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
    <article className="iam-page iam-stage">
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
        <div className="iam-h-main">
          <div className="iam-h-title-row">
            <h1>{bi("协作团队", "Teams")}</h1>
            {iam.teams.length > 0 && (
              <span className="iam-h-meta num">
                {bi(
                  `${iam.teams.length} 个团队 · ${activeCount} 个有成员`,
                  `${iam.teams.length} teams · ${activeCount} active`,
                )}
              </span>
            )}
          </div>
          <p>
            {bi(
              "按项目或运维班组归拢成员并集中分配集群权限，加入团队的成员自动继承对应的运维或只读权限。",
              "Group members by project or squad and assign shared cluster access inherited automatically by all members.",
            )}
          </p>
        </div>
        <div className="iam-h-acts">
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
        </div>
      </header>

      {iam.teams.length === 0 ? (
        <div className="iam-empty iam-empty-line">
          <IconUserGroup />
          <b>{bi("尚未创建协作团队", "No collaboration teams yet")}</b>
          <span>
            {bi(
              "当多套集群需要开放给同一批工程师协同维护时，创建一个团队即可批量授权、统一管理。",
              "Create a team to grant multiple clusters to a group of engineers in one place.",
            )}
          </span>
          {editable && (
            <Button
              type="primary"
              icon={<IconPlus />}
              style={{ marginTop: 6 }}
              onClick={() =>
                setEdit({ name: "", desc: "", members: [], clusters: {} })
              }
            >
              {bi("新建第一个团队", "Create First Team")}
            </Button>
          )}
        </div>
      ) : (
        <>
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
                "搜索团队名称、成员或集群…",
                "Search team, member, or cluster…",
              )}
              aria-label={bi("搜索团队", "Search teams")}
            />
            <div className="iam-pills" role="tablist">
              <button
                type="button"
                className={`iam-pill ${tab === "all" ? "on" : ""}`}
                onClick={() => setTab("all")}
              >
                {bi("全部", "All")} <em>{iam.teams.length}</em>
              </button>
              <button
                type="button"
                className={`iam-pill ${tab === "active" ? "on" : ""}`}
                onClick={() => setTab(tab === "active" ? "all" : "active")}
              >
                {bi("已有成员", "With Members")} <em>{activeCount}</em>
              </button>
              {emptyCount > 0 && (
                <button
                  type="button"
                  className={`iam-pill ${tab === "empty" ? "on" : ""}`}
                  onClick={() => setTab(tab === "empty" ? "all" : "empty")}
                >
                  {bi("待加成员", "Empty")} <em>{emptyCount}</em>
                </button>
              )}
            </div>
          </div>

          {shownTeams.length === 0 ? (
            <div className="iam-empty iam-empty-line">
              <b>{bi("没有匹配的团队", "No matching teams")}</b>
              <Button
                size="small"
                onClick={() => {
                  setQuery("");
                  setTab("all");
                }}
              >
                {bi("清除筛选", "Clear Filters")}
              </Button>
            </div>
          ) : (
            <div className="iam-ledger" role="table" aria-label={bi("团队列表", "Teams list")}>
              <div className="iam-t-head" role="row">
                <span>{bi("团队", "Team")}</span>
                <span>{bi("团队成员", "Members")}</span>
                <span>{bi("授权集群（成员自动继承）", "Shared Clusters")}</span>
                <span className="is-right">{bi("操作", "Actions")}</span>
              </div>
              <div className="iam-t-body">
                {shownTeams.map((t) => {
                  const clEntries = stableClusterEntries(t.clusters);
                  return (
                    <div key={t.id} className="iam-t-row" role="row">
                      <div className="iam-t-info">
                        <span className="iam-role-ic">
                          <IconUserGroup />
                        </span>
                        <div className="iam-t-txt">
                          <b>{t.name}</b>
                          <small>
                            {t.desc ||
                              bi(
                                `${t.members.length} 名成员 · ${clEntries.length} 个集群`,
                                `${t.members.length} members · ${clEntries.length} clusters`,
                              )}
                          </small>
                        </div>
                      </div>

                      <div className="iam-t-members">
                        {t.members.length ? (
                          t.members.map((m) => (
                            <a
                              key={m}
                              href={`#/iam/${encodeURIComponent(m)}`}
                              className="iam-member-link"
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
                            {bi("暂未添加成员", "No members")}
                          </span>
                        )}
                      </div>

                      <div className="iam-t-clusters">
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
                            {bi("未分配额外集群", "No clusters assigned")}
                          </span>
                        )}
                      </div>

                      <div className="iam-t-acts">
                        {editable && (
                          <>
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
                              {bi("配置", "Configure")}
                            </Button>
                            <Button
                              size="small"
                              status="danger"
                              type="text"
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
                                    "成员账户不会被删除，仅解除团队关系及团队级集群授权。",
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
                          </>
                        )}
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
        width={620}
        style={{ maxWidth: "100vw" }}
        visible={!!edit}
        title={
          edit?.id
            ? bi(`配置团队 · ${edit.name}`, `Configure Team · ${edit.name}`)
            : bi("新建协作团队", "New Team")
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
                placeholder={bi("例如：核心数据库运维组", "e.g., Core DBA Squad")}
                maxLength={30}
              />
            </div>
            <div className="st-field">
              <span>{bi("职责说明（可选）", "Description (Optional)")}</span>
              <Input
                value={edit.desc}
                onChange={(v) => setEdit({ ...edit, desc: v })}
                placeholder={bi("简要说明负责的环境或业务线", "Optional notes")}
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
                placeholder={bi("选择加入该团队的成员…", "Select members…")}
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

/* ---------------------------------------------------------------- cluster access ledger */

function QuickClusterGrantPopover({
  cluster,
  users,
  teams,
  agents,
  canUsers,
  canTeams,
  canAgents,
  userHasGlobalScope,
  busy,
  onGrant,
}: {
  cluster: IAMCluster;
  users: Account[];
  teams: Team[];
  agents: IAMAgentBrief[];
  canUsers: boolean;
  canTeams: boolean;
  canAgents: boolean;
  userHasGlobalScope: (uname: string) => boolean;
  busy: boolean;
  onGrant: (
    kind: "u" | "t" | "a",
    id: string,
    lvl: string,
    close: () => void,
  ) => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState("");
  const q = kw.trim().toLowerCase();

  const candAgents = canAgents
    ? agents.filter(
        (a) =>
          !cluster.agents?.[a.id] &&
          (!q ||
            a.name.toLowerCase().includes(q) ||
            a.ip.toLowerCase().includes(q)),
      )
    : [];
  const candUsers = canUsers
    ? users.filter(
        (u) =>
          !u.disabled &&
          u.username !== cluster.owner &&
          !userHasGlobalScope(u.username) &&
          !cluster.users?.[u.username] &&
          (!q || u.username.toLowerCase().includes(q)),
      )
    : [];
  const candTeams = canTeams
    ? teams.filter(
        (t) =>
          !cluster.teams?.[t.id] && (!q || t.name.toLowerCase().includes(q)),
      )
    : [];

  return (
    <Popover
      trigger="click"
      position="br"
      popupVisible={open}
      onVisibleChange={(v) => {
        setOpen(v);
        if (!v) setKw("");
      }}
      unmountOnExit
      content={
        <div
          className="iam-quick-pop"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="iam-quick-pop-head">
            <b>{bi(`授权 ${cluster.id}`, `Grant on ${cluster.id}`)}</b>
          </div>
          {users.length + teams.length + agents.length > 4 && (
            <Input
              size="small"
              prefix={<IconSearch />}
              allowClear
              value={kw}
              onChange={setKw}
              placeholder={bi("搜索 Agent、成员或团队…", "Filter Agent, user, or team…")}
            />
          )}
          <div className="iam-quick-pop-list">
            {candAgents.length === 0 &&
            candUsers.length === 0 &&
            candTeams.length === 0 ? (
              <p className="faint small" style={{ margin: "10px 4px", textAlign: "center" }}>
                {bi(
                  "无可新增的 Agent、普通成员或团队",
                  "No unassigned Agents, users, or teams",
                )}
              </p>
            ) : (
              <>
                {candAgents.map((a) => (
                  <div key={`a:${a.id}`} className="iam-quick-pop-row">
                    <span className="iam-quick-pop-who">
                      <IconThunderbolt />
                      <b>{a.name}</b>
                      <small className="mono faint">{a.ip}</small>
                    </span>
                    <span className="iam-quick-pop-btns">
                      <button
                        type="button"
                        disabled={busy}
                        className="iam-lvl-tag is-view is-btn"
                        onClick={() =>
                          onGrant("a", a.id, "readonly", () => setOpen(false))
                        }
                      >
                        {bi("+ 只读", "+ RO")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className="iam-lvl-tag is-operate is-btn"
                        onClick={() =>
                          onGrant("a", a.id, "readwrite", () => setOpen(false))
                        }
                      >
                        {bi("+ 读写", "+ RW")}
                      </button>
                    </span>
                  </div>
                ))}
                {candUsers.map((u) => (
                  <div key={`u:${u.username}`} className="iam-quick-pop-row">
                    <span className="iam-quick-pop-who">
                      <IconUser />
                      <b>{u.username}</b>
                    </span>
                    <span className="iam-quick-pop-btns">
                      <button
                        type="button"
                        disabled={busy}
                        className="iam-lvl-tag is-view is-btn"
                        onClick={() =>
                          onGrant("u", u.username, "view", () => setOpen(false))
                        }
                      >
                        {bi("+ 只读", "+ View")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className="iam-lvl-tag is-operate is-btn"
                        onClick={() =>
                          onGrant("u", u.username, "operate", () =>
                            setOpen(false),
                          )
                        }
                      >
                        {bi("+ 运维", "+ Operate")}
                      </button>
                    </span>
                  </div>
                ))}
                {candTeams.map((t) => (
                  <div key={`t:${t.id}`} className="iam-quick-pop-row">
                    <span className="iam-quick-pop-who">
                      <IconUserGroup />
                      <b>{t.name}</b>
                    </span>
                    <span className="iam-quick-pop-btns">
                      <button
                        type="button"
                        disabled={busy}
                        className="iam-lvl-tag is-view is-btn"
                        onClick={() =>
                          onGrant("t", t.id, "view", () => setOpen(false))
                        }
                      >
                        {bi("+ 只读", "+ View")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className="iam-lvl-tag is-operate is-btn"
                        onClick={() =>
                          onGrant("t", t.id, "operate", () => setOpen(false))
                        }
                      >
                        {bi("+ 运维", "+ Operate")}
                      </button>
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      }
    >
      <button
        type="button"
        className="iam-add-grant-chip"
        onClick={(e) => e.stopPropagation()}
      >
        <IconPlus />
        <span>{bi("授权", "Grant")}</span>
      </button>
    </Popover>
  );
}

export function ClustersAccessPane({
  narrow,
  users,
  iamError,
  onSaved,
}: {
  narrow: boolean;
  users: Account[];
  iamError?: string;
  onSaved?: () => void;
}) {
  useLang();
  const { iam, reload, set } = useIAM();
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
  const searchRef = useRef<HTMLInputElement | null>(null);

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
  const agentMap = useMemo(
    () => new Map((iam?.agents || []).map((a) => [a.id, a])),
    [iam?.agents],
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
            Object.keys(c.teams || {}).length +
            Object.keys(c.agents || {}).length >
          0,
      ).length,
    [clusters],
  );

  const memberEffectiveDetail = (
    uname: string,
    c: IAMCluster,
  ): { level: "" | ClusterAccessLevel; via: string } => {
    if (!uname) return { level: "", via: "" };
    if (c.owner === uname) {
      return { level: "operate", via: bi("创建者", "Owner") };
    }
    if (userHasGlobalScope(uname)) {
      return { level: "operate", via: bi("全局角色", "Global") };
    }
    const g = iam?.grants[uname];
    let best: "" | ClusterAccessLevel = g?.clusters?.[c.id] || "";
    let via = best ? bi("个人授权", "Direct") : "";
    for (const tid of g?.teams || []) {
      const tlvl = c.teams?.[tid] || "";
      if (LEVEL_RANK[tlvl] > LEVEL_RANK[best]) {
        best = tlvl as ClusterAccessLevel;
        via = teamMap.get(tid)?.name || bi("团队继承", "Team");
      }
    }
    return { level: best, via };
  };

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      clusters.filter((c) => {
        const grantTotal =
          Object.keys(c.users || {}).length +
          Object.keys(c.teams || {}).length +
          Object.keys(c.agents || {}).length;
        if (shareFilter === "shared" && grantTotal === 0) return false;
        if (shareFilter === "private" && grantTotal > 0) return false;
        if (appFilter !== "all" && c.app_name !== appFilter) return false;
        if (memberFilter && !memberEffectiveDetail(memberFilter, c).level)
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
        if (
          Object.keys(c.agents || {}).some((aid) => {
            const ag = agentMap.get(aid);
            return (
              (ag?.name || "").toLowerCase().includes(q) ||
              (ag?.ip || "").toLowerCase().includes(q)
            );
          })
        )
          return true;
        return false;
      }),
    [clusters, shareFilter, appFilter, memberFilter, q, teamMap, agentMap, iam], // eslint-disable-line react-hooks/exhaustive-deps
  );

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
      (iam?.teams || []).filter(
        (t) => !dq || t.name.toLowerCase().includes(dq),
      ),
    [iam?.teams, dq],
  );
  const eligibleDrawerAgents = useMemo(
    () =>
      (iam?.agents || []).filter(
        (a) =>
          !dq ||
          a.name.toLowerCase().includes(dq) ||
          a.ip.toLowerCase().includes(dq),
      ),
    [iam?.agents, dq],
  );

  const canUsers = can("iam.user");
  const canTeams = can("iam.team");
  const canAgents = can("execution.manage|iam.user|iam.team");
  const editable = canUsers || canTeams || canAgents;

  const batchTargetOptions = useMemo(() => {
    const opts: { label: string; value: string }[] = [];
    if (!iam) return opts;
    if (canAgents) {
      for (const a of iam.agents || []) {
        opts.push({
          value: `a:${a.id}`,
          label: bi(
            `Agent · ${a.name} (${a.ip})`,
            `Agent · ${a.name} (${a.ip})`,
          ),
        });
      }
    }
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
  }, [users, iam, canUsers, canTeams, canAgents]); // eslint-disable-line react-hooks/exhaustive-deps

  if (iamError && !iam) {
    return (
      <article className="iam-page iam-stage">
        <div className="iam-empty iam-empty-line">
          <IconExclamationCircle className="bad" />
          <b>{iamError}</b>
          <Button size="small" icon={<IconRefresh />} onClick={reload}>
            {bi("重试", "Retry")}
          </Button>
        </div>
      </article>
    );
  }
  if (!iam) {
    return (
      <article className="iam-page">
        <Skeleton animation text={{ rows: 8 }} />
      </article>
    );
  }

  const updateClusterAccess = async (
    c: IAMCluster,
    nextUsers: Record<string, ClusterAccessLevel>,
    nextTeams: Record<string, ClusterAccessLevel>,
    keyHint: string,
    nextAgents?: Record<string, IAMAgentMode>,
  ) => {
    if (savingKey) return;
    setSavingKey(keyHint);
    try {
      const payload: Record<string, unknown> = {};
      if (canUsers) payload.users = nextUsers;
      if (canTeams) payload.teams = nextTeams;
      if (canAgents && nextAgents !== undefined) payload.agents = nextAgents;
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
        const nextA: Record<string, IAMAgentMode> = {
          ...(c.agents || {}),
        };
        let touchedAgents = false;
        for (const target of batchTargets) {
          if (target.startsWith("a:") && canAgents) {
            const aid = target.slice(2);
            touchedAgents = true;
            if (batchAction === "revoke") delete nextA[aid];
            else nextA[aid] = batchAction === "operate" ? "readwrite" : "readonly";
          } else if (target.startsWith("u:") && canUsers) {
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
        if (canAgents && touchedAgents) payload.agents = nextA;
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

  const batchIdx = batchAction === "revoke" ? 0 : batchAction === "view" ? 1 : 2;

  return (
    <article className="iam-page iam-stage">
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
        <div className="iam-h-main">
          <div className="iam-h-title-row">
            <h1>{bi("集群授权", "Cluster Access")}</h1>
            {clusters.length > 0 && (
              <span className="iam-h-meta num">
                {bi(
                  `${clusters.length} 个集群 · ${sharedCount} 已共享协作`,
                  `${clusters.length} clusters · ${sharedCount} shared`,
                )}
              </span>
            )}
          </div>
          <p>
            {bi(
              "集中管理每个集群的执行 Agent（启用/禁用 · 只读/读写）以及协作成员与团队权限；点击标签可就地切换级别，勾选多行可批量分配。",
              "Manage each cluster's execution Agents (Enable/Disable · Read-only/Read-write) alongside user & team access.",
            )}
          </p>
        </div>
      </header>

      {clusters.length === 0 ? (
        <div className="iam-empty iam-empty-line">
          <IconStorage />
          <b>{bi("暂无可分配权限的集群", "No clusters yet")}</b>
          <span>
            {bi(
              "新建交付或纳管存量集群后，即可在此按集群精细分配协作成员与团队权限。",
              "Create or onboard clusters first to configure per-cluster access.",
            )}
          </span>
        </div>
      ) : (
        <>
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
                }
              }}
              placeholder={bi(
                "搜索集群标识、组件、创建者或协作成员…",
                "Search cluster, middleware, owner, or member…",
              )}
              aria-label={bi("搜索集群", "Search clusters")}
            />
            {appOptions.length > 1 && (
              <Select
                className="iam-filter-sel"
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
                className="iam-filter-sel is-member"
                value={memberFilter || undefined}
                allowClear
                placeholder={bi("按成员视角核查…", "Audit as member…")}
                onChange={(v) => setMemberFilter(v || "")}
                triggerProps={{ autoFitPosition: true }}
                options={users
                  .filter((u) => !u.disabled)
                  .map((u) => ({
                    value: u.username,
                    label: bi(`视角：${u.username}`, `View as: ${u.username}`),
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
                onClick={() =>
                  setShareFilter(shareFilter === "shared" ? "all" : "shared")
                }
              >
                {bi("已共享", "Shared")} <em>{sharedCount}</em>
              </button>
              <button
                type="button"
                className={`iam-pill ${shareFilter === "private" ? "on" : ""}`}
                onClick={() =>
                  setShareFilter(shareFilter === "private" ? "all" : "private")
                }
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
                      `全选筛选结果 (${filtered.length})`,
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
                  style={{ minWidth: 230, maxWidth: 360 }}
                  value={batchTargets}
                  onChange={setBatchTargets}
                  options={batchTargetOptions}
                  placeholder={
                    batchTargetOptions.length
                      ? bi(
                          "选择要批量授权的成员或团队…",
                          "Select users or teams…",
                        )
                      : bi("暂无可授权普通成员或团队", "No target users/teams")
                  }
                  allowClear
                  triggerProps={{ autoFitPosition: true }}
                />
                <span
                  className={`iam-tri-switch idx-${batchIdx}`}
                  style={{ "--tri-idx": batchIdx } as React.CSSProperties}
                >
                  <button
                    type="button"
                    className={batchAction === "revoke" ? "on is-none" : ""}
                    onClick={() => setBatchAction("revoke")}
                  >
                    {bi("撤销", "Revoke")}
                  </button>
                  <button
                    type="button"
                    className={batchAction === "view" ? "on is-view" : ""}
                    onClick={() => setBatchAction("view")}
                  >
                    {bi("只读", "View")}
                  </button>
                  <button
                    type="button"
                    className={batchAction === "operate" ? "on is-op" : ""}
                    onClick={() => setBatchAction("operate")}
                  >
                    {bi("运维", "Operate")}
                  </button>
                </span>
                <Button
                  size="small"
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
            <div className="iam-empty iam-empty-line">
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
            <div className="iam-ledger" role="table" aria-label={bi("集群授权台账", "Cluster access ledger")}>
              <div className="iam-cl-lhead" role="row">
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
                <span>{bi("集群与中间件", "Cluster & Middleware")}</span>
                <span>{bi("创建者", "Creator")}</span>
                <span>
                  {memberFilter
                    ? bi(
                        `${memberFilter} 的生效权限与协作成员`,
                        `${memberFilter}'s Access & Collaborators`,
                      )
                    : bi(
                        "执行 Agent、协作成员与团队（点击标签可切换）",
                        "Agents, Collaborators & Teams",
                      )}
                </span>
                <span className="is-right">{bi("操作", "Actions")}</span>
              </div>

              <div className="iam-cl-lbody">
                {filtered.map((c) => {
                  const aEntries = stableAgentEntries(c.agents);
                  const uEntries = stableClusterEntries(c.users);
                  const tEntries = stableClusterEntries(c.teams);
                  const checked = selectedIds.has(c.id);
                  const isDrawerOpen = drawerClusterId === c.id;
                  const effView = memberFilter
                    ? memberEffectiveDetail(memberFilter, c)
                    : null;
                  return (
                    <div
                      key={c.id}
                      role="row"
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
                        {effView && effView.level && (
                          <span className="iam-eff-perspective">
                            <em className={`iam-lvl-tag is-${effView.level}`}>
                              {effView.level === "operate"
                                ? bi("可运维", "Operate")
                                : bi("仅只读", "View")}
                            </em>
                            <small>{effView.via}</small>
                          </span>
                        )}

                        {aEntries.length === 0 &&
                        uEntries.length === 0 &&
                        tEntries.length === 0 ? (
                          !effView && (
                            <span className="faint small">
                              {bi("仅创建者与全局角色 · 未关联 Agent", "Creator & global roles · No Agent")}
                            </span>
                          )
                        ) : (
                          <>
                            {aEntries.map(([aid, mode]) => {
                              const ag = agentMap.get(aid);
                              const nextMode: IAMAgentMode =
                                mode === "readwrite" ? "readonly" : "readwrite";
                              const busyThis = savingKey === `${c.id}:a:${aid}`;
                              const dotCls = ag?.disabled
                                ? "is-disabled"
                                : ag?.online
                                  ? "is-online"
                                  : "is-offline";
                              return (
                                <span
                                  key={`a:${aid}`}
                                  className={`iam-grant-pill is-agent ${busyThis ? "is-busy" : ""}`}
                                >
                                  <span className={`iam-ag-dot ${dotCls}`} />
                                  <IconThunderbolt className="iam-gp-ic" />
                                  <b className="iam-gp-name">{ag?.name || aid}</b>
                                  <Tooltip
                                    mini
                                    content={
                                      canAgents
                                        ? bi(
                                            `点击切换 Agent 为「${nextMode === "readwrite" ? "读写" : "只读"}」`,
                                            `Switch Agent to ${nextMode === "readwrite" ? "Read-write" : "Read-only"}`,
                                          )
                                        : undefined
                                    }
                                  >
                                    <button
                                      type="button"
                                      disabled={!canAgents || !!savingKey}
                                      className={`iam-lvl-tag is-${mode === "readwrite" ? "operate" : "view"} is-btn`}
                                      onClick={() =>
                                        void updateClusterAccess(
                                          c,
                                          c.users || {},
                                          c.teams || {},
                                          `${c.id}:a:${aid}`,
                                          { ...(c.agents || {}), [aid]: nextMode },
                                        )
                                      }
                                    >
                                      {mode === "readwrite"
                                        ? bi("读写", "RW")
                                        : bi("只读", "RO")}
                                    </button>
                                  </Tooltip>
                                  {canAgents && (
                                    <button
                                      type="button"
                                      disabled={!!savingKey}
                                      className="iam-gp-rm"
                                      aria-label={bi(
                                        `禁用移除 Agent ${ag?.name || aid}`,
                                        `Disable Agent ${ag?.name || aid}`,
                                      )}
                                      onClick={() => {
                                        const nextA = { ...(c.agents || {}) };
                                        delete nextA[aid];
                                        void updateClusterAccess(
                                          c,
                                          c.users || {},
                                          c.teams || {},
                                          `${c.id}:a:${aid}`,
                                          nextA,
                                        );
                                      }}
                                    >
                                      <IconClose />
                                    </button>
                                  )}
                                </span>
                              );
                            })}
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
                                            `Switch to ${clusterLevelLabel(nextLvl)}`,
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

                        {editable && (
                          <QuickClusterGrantPopover
                            cluster={c}
                            users={users}
                            teams={iam.teams || []}
                            agents={iam.agents || []}
                            canUsers={canUsers}
                            canTeams={canTeams}
                            canAgents={canAgents}
                            userHasGlobalScope={userHasGlobalScope}
                            busy={Boolean(savingKey)}
                            onGrant={(kind, id, lvl, close) => {
                              close();
                              if (kind === "a") {
                                void updateClusterAccess(
                                  c,
                                  c.users || {},
                                  c.teams || {},
                                  `${c.id}:a:${id}`,
                                  {
                                    ...(c.agents || {}),
                                    [id]: lvl as IAMAgentMode,
                                  },
                                );
                              } else if (kind === "u") {
                                void updateClusterAccess(
                                  c,
                                  {
                                    ...(c.users || {}),
                                    [id]: lvl as ClusterAccessLevel,
                                  },
                                  c.teams || {},
                                  `${c.id}:u:${id}`,
                                );
                              } else {
                                void updateClusterAccess(
                                  c,
                                  c.users || {},
                                  {
                                    ...(c.teams || {}),
                                    [id]: lvl as ClusterAccessLevel,
                                  },
                                  `${c.id}:t:${id}`,
                                );
                              }
                            }}
                          />
                        )}
                      </div>

                      <div className="iam-cl-lact">
                        {editable && (
                          <Button
                            size="small"
                            type="secondary"
                            onClick={() => {
                              setDrawerQuery("");
                              setDrawerClusterId(c.id);
                            }}
                          >
                            {bi("管理权限", "Manage")}
                          </Button>
                        )}
                        <button
                          type="button"
                          className="iam-row-go"
                          aria-label={bi(
                            `打开集群 ${c.id}`,
                            `Open cluster ${c.id}`,
                          )}
                          onClick={() => go({ name: "deliveries", id: c.id })}
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
              <span>{bi("集群权限明细", "Cluster Access")}</span>
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
              <span className="iam-app-pill">
                {drawerCluster.app_name} {drawerCluster.version}
              </span>
              <span className="faint small">
                {bi(
                  `创建者 ${drawerCluster.owner} 默认拥有运维权限；下方切换实时保存生效`,
                  `Owner ${drawerCluster.owner} has Operate access by default; changes apply immediately`,
                )}
              </span>
            </div>

            {users.length + iam.teams.length > 5 && (
              <Input
                size="small"
                prefix={<IconSearch />}
                allowClear
                value={drawerQuery}
                onChange={setDrawerQuery}
                placeholder={bi(
                  "搜索成员或团队…",
                  "Filter users or teams…",
                )}
              />
            )}

            <div className="iam-cl-drawer-sec">
              <div className="iam-cl-drawer-sec-h">
                <h4>
                  {bi("执行 Agent（启用/禁用 · 只读/读写）", "Execution Agents")}{" "}
                  <em className="num">{eligibleDrawerAgents.length}</em>
                </h4>
                <button
                  type="button"
                  className="iam-text-act"
                  onClick={() => {
                    setDrawerClusterId("");
                    go({ name: "executions", view: "nodes" });
                  }}
                >
                  {bi("管理 / 接入 Agent →", "Manage Agents →")}
                </button>
              </div>
              {eligibleDrawerAgents.length === 0 ? (
                <p className="iam-inline-empty">
                  {bi(
                    "尚未接入任何执行 Agent；前往「执行中心 → Agent」部署后即可在此按集群设置启用与只读/读写权限。",
                    "No Agents enrolled yet. Add one in Execution Center → Agent first.",
                  )}
                </p>
              ) : (
                <div className="iam-cl-drawer-list">
                  {eligibleDrawerAgents.map((a) => {
                    const curMode = drawerCluster.agents?.[a.id] || "";
                    const rowBusy = savingKey === `${drawerCluster.id}:a:${a.id}`;
                    const statusTxt = a.disabled
                      ? bi("全局已禁用", "Globally Disabled")
                      : a.online
                        ? bi("在线", "Online")
                        : bi("离线", "Offline");
                    return (
                      <div
                        key={a.id}
                        className={`iam-cl-drawer-row ${rowBusy ? "is-busy" : ""}`}
                      >
                        <div className="iam-cl-drawer-who">
                          <b>
                            <span
                              className={`iam-ag-dot ${
                                a.disabled
                                  ? "is-disabled"
                                  : a.online
                                    ? "is-online"
                                    : "is-offline"
                              }`}
                            />{" "}
                            {a.name}
                          </b>
                          <small className="mono">
                            {a.ip} · {statusTxt}
                          </small>
                        </div>
                        <TriAgentSwitch
                          value={curMode}
                          disabled={!canAgents || !!savingKey}
                          onChange={(nextMode) => {
                            const nextA = { ...(drawerCluster.agents || {}) };
                            if (!nextMode) delete nextA[a.id];
                            else nextA[a.id] = nextMode;
                            void updateClusterAccess(
                              drawerCluster,
                              drawerCluster.users || {},
                              drawerCluster.teams || {},
                              `${drawerCluster.id}:a:${a.id}`,
                              nextA,
                            );
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="iam-cl-drawer-sec">
              <h4>
                {bi("平台成员", "Users")}{" "}
                <em className="num">{eligibleDrawerUsers.length}</em>
              </h4>
              {eligibleDrawerUsers.length === 0 ? (
                <p className="iam-inline-empty">
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
                <p className="iam-inline-empty">
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

/* ---------------------------------------------------------------- archived accounts */

export function DeletedPane({
  users,
  narrow,
  iamError,
}: {
  users: { username: string; disabled?: boolean }[];
  narrow: boolean;
  iamError?: string;
}) {
  useLang();
  const { iam, reload } = useIAM();
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");

  if (iamError && !iam) {
    return (
      <article className="iam-page iam-stage">
        <div className="iam-empty iam-empty-line">
          <IconExclamationCircle className="bad" />
          <b>{iamError}</b>
          <Button size="small" icon={<IconRefresh />} onClick={reload}>
            {bi("重试", "Retry")}
          </Button>
        </div>
      </article>
    );
  }
  if (!iam) {
    return (
      <article className="iam-page">
        <Skeleton animation text={{ rows: 5 }} />
      </article>
    );
  }

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
          `${r.moved} 份交付已转交给 ${to}`,
          `Transferred ${r.moved} ${r.moved === 1 ? "delivery" : "deliveries"} to ${to}`,
        ),
      );
      void reload();
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };

  return (
    <article className="iam-page iam-stage">
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
        <div className="iam-h-main">
          <div className="iam-h-title-row">
            <h1>{bi("已归档账户", "Archived Users")}</h1>
            <span className="iam-h-meta num">
              {bi(`${iam.deleted?.length || 0} 个`, `${iam.deleted?.length || 0}`)}
            </span>
          </div>
          <p>
            {bi(
              "已删除账户的用户名永久锁定不可复用，以保证审计链完整；其名下剩余集群与交付可转交给在职成员。",
              "Deleted usernames remain retired for audit traceability; remaining deliveries can be reassigned to active users.",
            )}
          </p>
        </div>
      </header>

      <div className="iam-ledger">
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
                      `${d.by} 于 ${fullTime(d.at)} 删除`,
                      `Deleted by ${d.by} on ${fullTime(d.at)}`,
                    )}
                    {d.moved
                      ? bi(
                          ` · ${d.moved_n || 0} 份交付已转交 ${d.moved}`,
                          ` · ${d.moved_n || 0} transferred to ${d.moved}`,
                        )
                      : ""}
                  </small>
                </span>
                <span className="iam-del-jobs">
                  {d.jobs
                    ? bi(
                        `待转交 ${d.jobs} 份交付`,
                        `${d.jobs} ${d.jobs === 1 ? "delivery" : "deliveries"} remaining`,
                      )
                    : bi("无待转交交付", "No deliveries")}
                </span>
                {d.jobs > 0 && can("iam.user") ? (
                  <span className="row-gap">
                    <Select
                      style={{ minWidth: 190 }}
                      size="small"
                      placeholder={bi("选择接手成员…", "Transfer to…")}
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
                      size="small"
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
                ) : (
                  <span />
                )}
              </li>
            ))}
        </ul>
      </div>
    </article>
  );
}

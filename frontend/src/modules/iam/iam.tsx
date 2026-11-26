import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Input,
  Message,
  Modal,
  Select,
  Skeleton,
  Switch,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheck,
  IconClose,
  IconCopy,
  IconDelete,
  IconExclamationCircle,
  IconLeft,
  IconLock,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSearch,
  IconStorage,
  IconUser,
  IconUserGroup,
} from "@arco-design/web-react/icon";
import {
  api,
  can,
  err,
  fullTime,
  platformShort,
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
export type IAMCluster = {
  id: string;
  app_id: string;
  app_name: string;
  version: string;
  platform?: string;
  host_ips?: string[];
  host_names?: string[];
  owner: string;
  delivery_mode?: string;
  created: string;
  users: Record<string, ClusterAccessLevel>;
  teams: Record<string, ClusterAccessLevel>;
};

function matchIAMClusterSearch(c: IAMCluster, kw: string): boolean {
  if (!kw) return true;
  if (
    c.id.toLowerCase().includes(kw) ||
    c.app_name.toLowerCase().includes(kw) ||
    c.version.toLowerCase().includes(kw) ||
    c.owner.toLowerCase().includes(kw) ||
    (c.platform || "").toLowerCase().includes(kw) ||
    platformShort(c.platform).toLowerCase().includes(kw)
  ) {
    return true;
  }
  if (c.host_ips?.some((ip) => ip.toLowerCase().includes(kw))) return true;
  if (c.host_names?.some((h) => h.toLowerCase().includes(kw))) return true;
  return false;
}
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

/** Dual-pane cluster transfer box shared by User GrantEditor, AddAccount, QuickGrantDrawer, and Team Drawer. */
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
  const [leftQ, setLeftQ] = useState("");
  const [rightQ, setRightQ] = useState("");
  const [appFilter, setAppFilter] = useState("all");
  const [leftSel, setLeftSel] = useState<Set<string>>(() => new Set());
  const [rightSel, setRightSel] = useState<Set<string>>(() => new Set());

  const ownedClusters = useMemo(
    () => (ownedBy ? clusters.filter((c) => c.owner === ownedBy) : []),
    [clusters, ownedBy],
  );
  const assignable = useMemo(
    () => (ownedBy ? clusters.filter((c) => c.owner !== ownedBy) : clusters),
    [clusters, ownedBy],
  );

  const lkw = leftQ.trim().toLowerCase();
  const rkw = rightQ.trim().toLowerCase();

  const unassigned = useMemo(
    () => assignable.filter((c) => !value[c.id]),
    [assignable, value],
  );
  const granted = useMemo(
    () => assignable.filter((c) => Boolean(value[c.id])),
    [assignable, value],
  );

  const appOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of unassigned) {
      counts.set(c.app_name, (counts.get(c.app_name) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [unassigned]);

  const filteredLeft = useMemo(
    () =>
      unassigned.filter(
        (c) =>
          (appFilter === "all" || c.app_name === appFilter) &&
          matchIAMClusterSearch(c, lkw),
      ),
    [unassigned, appFilter, lkw],
  );
  const filteredRight = useMemo(
    () => granted.filter((c) => matchIAMClusterSearch(c, rkw)),
    [granted, rkw],
  );

  const validLeftSel = filteredLeft.filter((c) => leftSel.has(c.id));
  const validRightSel = filteredRight.filter((c) => rightSel.has(c.id));

  const setOne = (cid: string, nextLvl: "" | ClusterAccessLevel) => {
    const next = { ...value };
    if (!nextLvl) delete next[cid];
    else next[cid] = nextLvl;
    onChange(next);
  };

  const batchGrantLeft = (lvl: ClusterAccessLevel) => {
    if (validLeftSel.length === 0) return;
    const next = { ...value };
    for (const c of validLeftSel) next[c.id] = lvl;
    setLeftSel(new Set());
    onChange(next);
  };

  const batchRevokeRight = () => {
    if (validRightSel.length === 0) return;
    const next = { ...value };
    for (const c of validRightSel) delete next[c.id];
    setRightSel(new Set());
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
      ) : disabled ? (
        <div className="iam-cl-picker-list">
          {assignable.filter((c) => value[c.id] || inherited?.[c.id]).length === 0 ? (
            <div className="iam-cl-picker-empty faint small">
              {bi("暂未额外授权其他集群", "No extra clusters granted")}
            </div>
          ) : (
            assignable
              .filter((c) => value[c.id] || inherited?.[c.id])
              .map((c) => {
                const direct = value[c.id] || "";
                const inh = inherited?.[c.id];
                return (
                  <div key={c.id} className="iam-cl-picker-row">
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
                    </div>
                    {direct && (
                      <em className={`iam-lvl-tag is-${direct}`}>
                        {clusterLevelLabel(direct)}
                      </em>
                    )}
                  </div>
                );
              })
          )}
        </div>
      ) : (
        <div className="iam-transfer">
          <div className="iam-tf-pane">
            <div className="iam-tf-head">
              <label className="iam-tf-head-chk">
                <Checkbox
                  checked={
                    filteredLeft.length > 0 &&
                    validLeftSel.length === filteredLeft.length
                  }
                  indeterminate={
                    validLeftSel.length > 0 &&
                    validLeftSel.length < filteredLeft.length
                  }
                  disabled={filteredLeft.length === 0}
                  onChange={(chk) => {
                    const next = new Set(leftSel);
                    for (const c of filteredLeft) {
                      if (chk) next.add(c.id);
                      else next.delete(c.id);
                    }
                    setLeftSel(next);
                  }}
                />
                <b>{bi("未授权集群", "Available Clusters")}</b>
              </label>
              <span className="iam-tf-cnt num">
                {validLeftSel.length > 0
                  ? `${validLeftSel.length} / ${unassigned.length}`
                  : unassigned.length}
              </span>
            </div>
            <div className="iam-tf-search">
              <Input
                size="small"
                prefix={<IconSearch />}
                allowClear
                value={leftQ}
                onChange={setLeftQ}
                placeholder={bi(
                  "搜索集群、节点 IP、系统或创建者…",
                  "Search cluster, IP, OS, or owner…",
                )}
              />
              {appOptions.length > 1 && (
                <Select
                  size="small"
                  style={{ width: 132, flexShrink: 0 }}
                  value={appFilter}
                  onChange={setAppFilter}
                  getPopupContainer={() => document.body}
                  triggerProps={{ autoFitPosition: true }}
                  options={[
                    { value: "all", label: bi("全部组件", "All Apps") },
                    ...appOptions.map(([app, n]) => ({
                      value: app,
                      label: `${app} (${n})`,
                    })),
                  ]}
                />
              )}
            </div>
            <div className="iam-tf-list">
              {filteredLeft.length === 0 ? (
                <div className="iam-tf-empty">
                  {unassigned.length === 0
                    ? bi("全部可分配集群均已授权", "All assignable clusters are granted")
                    : bi("没有匹配的未授权集群", "No matching clusters")}
                </div>
              ) : (
                filteredLeft.map((c) => {
                  const checked = leftSel.has(c.id);
                  const inh = inherited?.[c.id];
                  const ips = c.host_ips || [];
                  return (
                    <div
                      key={c.id}
                      className={`iam-tf-row ${checked ? "is-checked" : ""}`}
                      onClick={() => {
                        const next = new Set(leftSel);
                        if (checked) next.delete(c.id);
                        else next.add(c.id);
                        setLeftSel(next);
                      }}
                    >
                      <Checkbox checked={checked} />
                      <div className="iam-tf-main">
                        <div className="iam-tf-line1">
                          <b className="iam-tf-id mono" title={c.id}>
                            {c.id}
                          </b>
                          <span className="iam-app-pill">{c.app_name}</span>
                        </div>
                        <small className="iam-tf-sub">
                          {ips.length > 0
                            ? `IP: ${ips.slice(0, 2).join(", ")}${
                                ips.length > 2 ? ` +${ips.length - 2}` : ""
                              } · `
                            : ""}
                          {c.platform ? `${platformShort(c.platform)} · ` : ""}
                          {bi(`创建者 ${c.owner}`, `Owner ${c.owner}`)}
                          {inh
                            ? bi(
                                ` · 团队继承 ${clusterLevelLabel(inh.level)}`,
                                ` · Team ${clusterLevelLabel(inh.level)}`,
                              )
                            : ""}
                        </small>
                      </div>
                      <span
                        className="iam-tf-quick-grp"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="iam-tf-qbtn"
                          title={bi("设为只读", "Grant Read-only")}
                          onClick={() => setOne(c.id, "view")}
                        >
                          +{bi("只读", "View")}
                        </button>
                        <button
                          type="button"
                          className="iam-tf-qbtn is-op"
                          title={bi("设为运维", "Grant Operate")}
                          onClick={() => setOne(c.id, "operate")}
                        >
                          +{bi("运维", "Op")}
                        </button>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="iam-tf-mid">
            <Button
              type="primary"
              size="small"
              disabled={validLeftSel.length === 0}
              onClick={() => batchGrantLeft("operate")}
            >
              {bi("设为运维", "Operate")} <IconRight />
            </Button>
            <Button
              type="secondary"
              size="small"
              disabled={validLeftSel.length === 0}
              onClick={() => batchGrantLeft("view")}
            >
              {bi("设为只读", "Read-only")} <IconRight />
            </Button>
            <Button
              size="small"
              status="danger"
              disabled={validRightSel.length === 0}
              onClick={batchRevokeRight}
            >
              <IconLeft /> {bi("移除", "Remove")}
            </Button>
          </div>

          <div className="iam-tf-pane is-target">
            <div className="iam-tf-head">
              <label className="iam-tf-head-chk">
                <Checkbox
                  checked={
                    filteredRight.length > 0 &&
                    validRightSel.length === filteredRight.length
                  }
                  indeterminate={
                    validRightSel.length > 0 &&
                    validRightSel.length < filteredRight.length
                  }
                  disabled={filteredRight.length === 0}
                  onChange={(chk) => {
                    const next = new Set(rightSel);
                    for (const c of filteredRight) {
                      if (chk) next.add(c.id);
                      else next.delete(c.id);
                    }
                    setRightSel(next);
                  }}
                />
                <b>{bi("已授权集群", "Granted Clusters")}</b>
              </label>
              <span className="iam-tf-cnt is-brand num">
                {validRightSel.length > 0
                  ? `${validRightSel.length} / ${granted.length}`
                  : granted.length}
              </span>
            </div>
            <div className="iam-tf-search">
              <Input
                size="small"
                prefix={<IconSearch />}
                allowClear
                value={rightQ}
                onChange={setRightQ}
                placeholder={bi("筛选已授权集群…", "Filter granted clusters…")}
              />
            </div>
            <div className="iam-tf-list">
              {filteredRight.length === 0 ? (
                <div className="iam-tf-empty">
                  {granted.length === 0
                    ? bi("从左侧勾选集群并分配「只读」或「运维」", "Select clusters from the left pane")
                    : bi("没有匹配的已授权集群", "No matching clusters")}
                </div>
              ) : (
                filteredRight.map((c) => {
                  const checked = rightSel.has(c.id);
                  const lvl = value[c.id] || "view";
                  return (
                    <div
                      key={c.id}
                      className={`iam-tf-row ${checked ? "is-checked" : ""}`}
                      onClick={() => {
                        const next = new Set(rightSel);
                        if (checked) next.delete(c.id);
                        else next.add(c.id);
                        setRightSel(next);
                      }}
                    >
                      <Checkbox checked={checked} />
                      <div className="iam-tf-main">
                        <div className="iam-tf-line1">
                          <b className="iam-tf-id mono" title={c.id}>
                            {c.id}
                          </b>
                          <span className="iam-app-pill">{c.app_name}</span>
                        </div>
                        <small className="iam-tf-sub">
                          {bi(`创建者 ${c.owner}`, `Owner ${c.owner}`)}
                        </small>
                      </div>
                      <span
                        className="iam-lvl-seg"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className={lvl === "view" ? "on is-view" : ""}
                          onClick={() => setOne(c.id, "view")}
                        >
                          {bi("只读", "View")}
                        </button>
                        <button
                          type="button"
                          className={lvl === "operate" ? "on is-op" : ""}
                          onClick={() => setOne(c.id, "operate")}
                        >
                          {bi("运维", "Op")}
                        </button>
                      </span>
                      <button
                        type="button"
                        className="iam-tf-rm"
                        title={bi("移除授权", "Revoke")}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOne(c.id, "");
                        }}
                      >
                        <IconClose />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
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
                getPopupContainer={() => document.body}
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
        <div className="iam-matrix-sec">
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
                      <div className="iam-cmp-phead">
                        <b>{bi("功能权限项", "Permission")}</b>
                        <small>
                          {bi(
                            "点击角色表头可切换至该角色详情进行编辑或复制",
                            "Click any role header to inspect or duplicate",
                          )}
                        </small>
                      </div>
                    </th>
                    {iam.roles.map((r) => (
                      <th key={r.id} className="iam-cmp-role-col">
                        <button
                          type="button"
                          className="iam-cmp-rhead-btn"
                          onClick={() => {
                            setDraft(null);
                            setSel(r.id);
                            setCompare(false);
                          }}
                          title={bi(
                            `查看「${roleTitle(r)}」配置`,
                            `Inspect "${roleTitle(r)}"`,
                          )}
                        >
                          <b>{roleTitle(r)}</b>
                          <span className="iam-cmp-rmeta">
                            <span className="iam-cmp-scope">
                              {scopeName(r.scope)}
                            </span>
                            <small className="num">
                              {bi(`${r.holders} 人`, `${r.holders}`)}
                            </small>
                          </span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredMatrixModules.length === 0 ? (
                    <tr>
                      <td
                        colSpan={iam.roles.length + 1}
                        className="iam-cmp-empty"
                      >
                        {bi(
                          "当前模块下所有角色权限一致，无差异项",
                          "All roles share identical permissions in this view",
                        )}
                      </td>
                    </tr>
                  ) : (
                    filteredMatrixModules.map(([m, ps]) => (
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
                                  className={`iam-cmp-val-cell ${has ? "yes" : "no"}`}
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
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="iam-role-split">
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
            <section className="iam-role-detail">
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
        width={760}
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
              <TeamMemberTransfer
                users={sorted}
                value={edit.members}
                onChange={(v) => setEdit({ ...edit, members: v })}
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

function TeamMemberTransfer({
  users,
  value,
  onChange,
}: {
  users: string[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  useLang();
  const [lq, setLq] = useState("");
  const [rq, setRq] = useState("");
  const [lSel, setLSel] = useState<Set<string>>(() => new Set());
  const [rSel, setRSel] = useState<Set<string>>(() => new Set());

  const valSet = useMemo(() => new Set(value), [value]);
  const avail = useMemo(() => users.filter((u) => !valSet.has(u)), [users, valSet]);

  const lkw = lq.trim().toLowerCase();
  const rkw = rq.trim().toLowerCase();
  const fLeft = useMemo(
    () => avail.filter((u) => !lkw || u.toLowerCase().includes(lkw)),
    [avail, lkw],
  );
  const fRight = useMemo(
    () => value.filter((u) => !rkw || u.toLowerCase().includes(rkw)),
    [value, rkw],
  );

  const vLeft = fLeft.filter((u) => lSel.has(u));
  const vRight = fRight.filter((u) => rSel.has(u));

  const addMembers = (us: string[]) => {
    if (!us.length) return;
    onChange(Array.from(new Set([...value, ...us])));
    setLSel(new Set());
  };

  const rmMembers = (us: string[]) => {
    if (!us.length) return;
    const s = new Set(us);
    onChange(value.filter((u) => !s.has(u)));
    setRSel(new Set());
  };

  return (
    <div className="iam-cl-picker">
      <div className="iam-transfer">
        <div className="iam-tf-pane">
          <div className="iam-tf-head">
            <label className="iam-tf-head-chk">
              <Checkbox
                checked={fLeft.length > 0 && vLeft.length === fLeft.length}
                indeterminate={vLeft.length > 0 && vLeft.length < fLeft.length}
                disabled={fLeft.length === 0}
                onChange={(chk) => {
                  const next = new Set(lSel);
                  for (const u of fLeft) {
                    if (chk) next.add(u);
                    else next.delete(u);
                  }
                  setLSel(next);
                }}
              />
              <b>{bi("可添加成员", "Available Users")}</b>
            </label>
            <span className="iam-tf-cnt num">{fLeft.length}</span>
          </div>
          <div className="iam-tf-search">
            <Input
              size="small"
              prefix={<IconSearch />}
              allowClear
              value={lq}
              onChange={setLq}
              placeholder={bi("搜索账户名…", "Search user…")}
            />
          </div>
          <div className="iam-tf-list" style={{ height: 190 }}>
            {fLeft.length === 0 ? (
              <div className="iam-tf-empty">
                {avail.length === 0
                  ? bi("全部成员已加入团队", "All users added")
                  : bi("无匹配成员", "No match")}
              </div>
            ) : (
              fLeft.map((u) => {
                const checked = lSel.has(u);
                return (
                  <div
                    key={u}
                    className={`iam-tf-row ${checked ? "is-checked" : ""}`}
                    onClick={() => {
                      const next = new Set(lSel);
                      if (checked) next.delete(u);
                      else next.add(u);
                      setLSel(next);
                    }}
                  >
                    <Checkbox checked={checked} />
                    <span className="iam-mini-ava" aria-hidden>
                      {u.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="iam-tf-main">
                      <b className="iam-tf-id">{u}</b>
                    </div>
                    <button
                      type="button"
                      className="iam-tf-rm"
                      title={bi("加入团队", "Add")}
                      onClick={(e) => {
                        e.stopPropagation();
                        addMembers([u]);
                      }}
                    >
                      <IconPlus />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="iam-tf-mid">
          <Button
            type="primary"
            size="small"
            disabled={vLeft.length === 0}
            onClick={() => addMembers(vLeft)}
          >
            {bi("加入", "Add")} <IconRight />
          </Button>
          <Button
            size="small"
            disabled={vRight.length === 0}
            onClick={() => rmMembers(vRight)}
          >
            <IconLeft /> {bi("移除", "Remove")}
          </Button>
        </div>

        <div className="iam-tf-pane is-target">
          <div className="iam-tf-head">
            <label className="iam-tf-head-chk">
              <Checkbox
                checked={fRight.length > 0 && vRight.length === fRight.length}
                indeterminate={vRight.length > 0 && vRight.length < fRight.length}
                disabled={fRight.length === 0}
                onChange={(chk) => {
                  const next = new Set(rSel);
                  for (const u of fRight) {
                    if (chk) next.add(u);
                    else next.delete(u);
                  }
                  setRSel(next);
                }}
              />
              <b>{bi("团队成员", "Team Members")}</b>
            </label>
            <span className="iam-tf-cnt is-brand num">{value.length}</span>
          </div>
          <div className="iam-tf-search">
            <Input
              size="small"
              prefix={<IconSearch />}
              allowClear
              value={rq}
              onChange={setRq}
              placeholder={bi("筛选已加入成员…", "Filter members…")}
            />
          </div>
          <div className="iam-tf-list" style={{ height: 190 }}>
            {fRight.length === 0 ? (
              <div className="iam-tf-empty">
                {value.length === 0
                  ? bi("从左侧勾选成员加入团队", "Select users from the left pane")
                  : bi("无匹配成员", "No match")}
              </div>
            ) : (
              fRight.map((u) => {
                const checked = rSel.has(u);
                return (
                  <div
                    key={u}
                    className={`iam-tf-row ${checked ? "is-checked" : ""}`}
                    onClick={() => {
                      const next = new Set(rSel);
                      if (checked) next.delete(u);
                      else next.add(u);
                      setRSel(next);
                    }}
                  >
                    <Checkbox checked={checked} />
                    <span className="iam-mini-ava" aria-hidden>
                      {u.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="iam-tf-main">
                      <b className="iam-tf-id">{u}</b>
                    </div>
                    <button
                      type="button"
                      className="iam-tf-rm"
                      title={bi("移出团队", "Remove")}
                      onClick={(e) => {
                        e.stopPropagation();
                        rmMembers([u]);
                      }}
                    >
                      <IconClose />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const ClusterAccessLedgerRow = React.memo(function ClusterAccessLedgerRow({
  cluster: c,
  checked,
  focused,
  editable,
  canUsers,
  canTeams,
  effLevel,
  effVia,
  savingKey,
  teamMap,
  onToggleCheck,
  onOpenDrawer,
  onUpdateAccess,
}: {
  cluster: IAMCluster;
  checked: boolean;
  focused: boolean;
  editable: boolean;
  canUsers: boolean;
  canTeams: boolean;
  effLevel: "" | ClusterAccessLevel;
  effVia: string;
  savingKey: string;
  teamMap: Map<string, Team>;
  onToggleCheck: (cid: string, v: boolean) => void;
  onOpenDrawer: (cid: string) => void;
  onUpdateAccess: (
    c: IAMCluster,
    nextUsers: Record<string, ClusterAccessLevel>,
    nextTeams: Record<string, ClusterAccessLevel>,
    keyHint: string,
  ) => void;
}) {
  useLang();
  const uEntries = useMemo(() => stableClusterEntries(c.users), [c.users]);
  const tEntries = useMemo(() => stableClusterEntries(c.teams), [c.teams]);
  const hasAnyGrant = uEntries.length > 0 || tEntries.length > 0;

  return (
    <div
      role="row"
      className={`iam-cl-lrow ${checked ? "is-checked" : ""} ${focused ? "is-focused" : ""} ${editable ? "is-clickable" : ""}`}
      onClick={() => {
        if (editable) onOpenDrawer(c.id);
      }}
    >
      <div
        className="iam-cl-chk-col"
        onClick={(e) => e.stopPropagation()}
      >
        {editable && (
          <Checkbox
            checked={checked}
            onChange={(v) => onToggleCheck(c.id, v)}
            aria-label={c.id}
          />
        )}
      </div>

      <div className="iam-cl-col-id">
        <a
          href={`#/d/${encodeURIComponent(c.id)}`}
          className="iam-cl-id mono"
          title={c.id}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            go({ name: "deliveries", id: c.id });
          }}
        >
          {c.id}
        </a>
      </div>

      <div className="iam-cl-col-app">
        <span className="iam-app-pill" title={`${c.app_name} ${c.version}`}>
          {c.app_name} {c.version}
        </span>
      </div>

      <div className="iam-cl-lowner">
        <a
          href={`#/iam/${encodeURIComponent(c.owner)}`}
          className="iam-owner-inline"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            go({ name: "accounts", id: c.owner });
          }}
        >
          <span className="iam-mini-ava" aria-hidden>
            {c.owner.slice(0, 1).toUpperCase()}
          </span>
          <span>{c.owner}</span>
        </a>
      </div>

      <div
        className="iam-cl-lgrants"
        onClick={(e) => {
          if (hasAnyGrant) e.stopPropagation();
        }}
      >
        {effLevel && (
          <span className="iam-eff-perspective">
            <em className={`iam-lvl-tag is-${effLevel}`}>
              {effLevel === "operate"
                ? bi("可运维", "Operate")
                : bi("仅只读", "View")}
            </em>
            <small>{effVia}</small>
          </span>
        )}

        {!hasAnyGrant ? (
          !effLevel && (
            <span className="iam-cl-default-tag">
              {bi("仅创建者与管理员可见", "Creator & Admins Only")}
            </span>
          )
        ) : (
          <>
            {uEntries.map(([uname, lvl]) => {
              const nextLvl: ClusterAccessLevel =
                lvl === "operate" ? "view" : "operate";
              const busyThis = savingKey === `${c.id}:u:${uname}`;
              return (
                <span
                  key={`u:${uname}`}
                  className={`iam-grant-pill ${busyThis ? "is-busy" : ""}`}
                >
                  <span className="iam-mini-ava is-sm" aria-hidden>
                    {uname.slice(0, 1).toUpperCase()}
                  </span>
                  <b className="iam-gp-name">{uname}</b>
                  <button
                    type="button"
                    disabled={!canUsers || !!savingKey}
                    title={
                      canUsers
                        ? bi(
                            `点击切换为「${clusterLevelLabel(nextLvl)}」`,
                            `Switch to ${clusterLevelLabel(nextLvl)}`,
                          )
                        : undefined
                    }
                    className={`iam-lvl-tag is-${lvl} is-btn`}
                    onClick={() =>
                      onUpdateAccess(
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
                  {canUsers && (
                    <button
                      type="button"
                      disabled={!!savingKey}
                      className="iam-gp-rm"
                      title={bi(`移除 ${uname}`, `Remove ${uname}`)}
                      aria-label={bi(`移除 ${uname}`, `Remove ${uname}`)}
                      onClick={() => {
                        const nextU = { ...(c.users || {}) };
                        delete nextU[uname];
                        onUpdateAccess(
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
                  <b className="iam-gp-name">{t?.name || tid}</b>
                  <button
                    type="button"
                    disabled={!canTeams || !!savingKey}
                    title={
                      canTeams
                        ? bi(
                            `点击切换团队为「${clusterLevelLabel(nextLvl)}」`,
                            `Switch team to ${clusterLevelLabel(nextLvl)}`,
                          )
                        : undefined
                    }
                    className={`iam-lvl-tag is-${lvl} is-btn`}
                    onClick={() =>
                      onUpdateAccess(
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
                  {canTeams && (
                    <button
                      type="button"
                      disabled={!!savingKey}
                      className="iam-gp-rm"
                      title={bi(
                        `移除团队 ${t?.name || tid}`,
                        `Remove ${t?.name || tid}`,
                      )}
                      aria-label={bi(
                        `移除团队 ${t?.name || tid}`,
                        `Remove ${t?.name || tid}`,
                      )}
                      onClick={() => {
                        const nextT = { ...(c.teams || {}) };
                        delete nextT[tid];
                        onUpdateAccess(
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

      <div
        className="iam-cl-lact"
        onClick={(e) => e.stopPropagation()}
      >
        {editable ? (
          <Button
            size="small"
            type="secondary"
            onClick={() => onOpenDrawer(c.id)}
          >
            {bi("分配成员", "Assign")}
          </Button>
        ) : (
          <Button
            size="small"
            type="text"
            onClick={() => go({ name: "deliveries", id: c.id })}
          >
            {bi("打开", "Open")} <IconRight />
          </Button>
        )}
      </div>
    </div>
  );
});

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
  const [drawerLeftQ, setDrawerLeftQ] = useState("");
  const [drawerRightQ, setDrawerRightQ] = useState("");
  const [drawerKind, setDrawerKind] = useState<"all" | "users" | "teams">("all");
  const [drawerLeftSel, setDrawerLeftSel] = useState<Set<string>>(() => new Set());
  const [drawerRightSel, setDrawerRightSel] = useState<Set<string>>(() => new Set());
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
          Object.keys(c.teams || {}).length;
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
        return false;
      }),
    [clusters, shareFilter, appFilter, memberFilter, q, teamMap, iam], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const drawerCluster = drawerClusterId
    ? clusters.find((c) => c.id === drawerClusterId) || null
    : null;
  const dlq = drawerLeftQ.trim().toLowerCase();
  const drq = drawerRightQ.trim().toLowerCase();

  type DrawerSubjectItem = {
    key: string;
    kind: "user" | "team";
    id: string;
    title: string;
    sub: string;
    level?: ClusterAccessLevel;
  };

  const drawerUnassigned = useMemo<DrawerSubjectItem[]>(() => {
    if (!drawerCluster) return [];
    const items: DrawerSubjectItem[] = [];
    if (drawerKind !== "teams") {
      const sortedU = users
        .filter(
          (u) =>
            !u.disabled &&
            u.username !== drawerCluster.owner &&
            !userHasGlobalScope(u.username) &&
            !drawerCluster.users?.[u.username],
        )
        .sort((a, b) => a.username.localeCompare(b.username));
      for (const u of sortedU) {
        items.push({
          key: `u:${u.username}`,
          kind: "user",
          id: u.username,
          title: u.username,
          sub: userRolesText(u.username) || bi("普通成员", "Member"),
        });
      }
    }
    if (drawerKind !== "users") {
      for (const t of iam?.teams || []) {
        if (drawerCluster.teams?.[t.id]) continue;
        items.push({
          key: `t:${t.id}`,
          kind: "team",
          id: t.id,
          title: t.name,
          sub:
            t.members.length > 0
              ? bi(`${t.members.length} 名成员`, `${t.members.length} members`)
              : bi("暂无成员", "No members"),
        });
      }
    }
    return items;
  }, [users, drawerCluster, drawerKind, iam]); // eslint-disable-line react-hooks/exhaustive-deps

  const drawerGranted = useMemo<DrawerSubjectItem[]>(() => {
    if (!drawerCluster) return [];
    const items: DrawerSubjectItem[] = [];
    if (drawerKind !== "teams") {
      for (const [uname, lvl] of stableClusterEntries(drawerCluster.users)) {
        items.push({
          key: `u:${uname}`,
          kind: "user",
          id: uname,
          title: uname,
          sub: userRolesText(uname) || bi("协作成员", "Collaborator"),
          level: lvl,
        });
      }
    }
    if (drawerKind !== "users") {
      for (const [tid, lvl] of stableClusterEntries(drawerCluster.teams)) {
        const t = teamMap.get(tid);
        items.push({
          key: `t:${tid}`,
          kind: "team",
          id: tid,
          title: t?.name || tid,
          sub: t
            ? bi(`${t.members.length} 名成员`, `${t.members.length} members`)
            : bi("协作团队", "Team"),
          level: lvl,
        });
      }
    }
    return items;
  }, [drawerCluster, drawerKind, teamMap, iam]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredDrawerLeft = useMemo(
    () =>
      drawerUnassigned.filter(
        (it) =>
          !dlq ||
          it.title.toLowerCase().includes(dlq) ||
          it.sub.toLowerCase().includes(dlq),
      ),
    [drawerUnassigned, dlq],
  );

  const filteredDrawerRight = useMemo(
    () =>
      drawerGranted.filter(
        (it) =>
          !drq ||
          it.title.toLowerCase().includes(drq) ||
          it.sub.toLowerCase().includes(drq),
      ),
    [drawerGranted, drq],
  );

  const globalViewerNames = useMemo(
    () =>
      drawerCluster
        ? users
            .filter(
              (u) =>
                !u.disabled &&
                u.username !== drawerCluster.owner &&
                userHasGlobalScope(u.username),
            )
            .map((u) => u.username)
        : [],
    [users, drawerCluster, iam], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const canUsers = can("iam.user");
  const canTeams = can("iam.team");
  const editable = canUsers || canTeams;

  const batchTargetOptions = useMemo(() => {
    const opts: { label: string; value: string }[] = [];
    if (!iam) return opts;
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
  }, [users, iam, canUsers, canTeams]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const updateClusterAccess = useCallback(
    async (
      c: IAMCluster,
      nextUsers: Record<string, ClusterAccessLevel>,
      nextTeams: Record<string, ClusterAccessLevel>,
      keyHint: string,
    ) => {
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
    },
    [canUsers, canTeams, set, onSaved],
  );

  const openClusterDrawer = useCallback((cid: string) => {
    setDrawerLeftQ("");
    setDrawerRightQ("");
    setDrawerKind("all");
    setDrawerLeftSel(new Set());
    setDrawerRightSel(new Set());
    setDrawerClusterId(cid);
  }, []);

  const applyDrawerTargets = async (
    c: IAMCluster,
    keys: string[],
    nextLevel: "" | ClusterAccessLevel,
  ) => {
    if (!keys.length || savingKey) return;
    const nextU: Record<string, ClusterAccessLevel> = { ...(c.users || {}) };
    const nextT: Record<string, ClusterAccessLevel> = { ...(c.teams || {}) };
    for (const k of keys) {
      if (k.startsWith("u:") && canUsers) {
        const u = k.slice(2);
        if (!nextLevel) delete nextU[u];
        else nextU[u] = nextLevel;
      } else if (k.startsWith("t:") && canTeams) {
        const t = k.slice(2);
        if (!nextLevel) delete nextT[t];
        else nextT[t] = nextLevel;
      }
    }
    await updateClusterAccess(c, nextU, nextT, `${c.id}:drawer`);
    if (nextLevel) setDrawerLeftSel(new Set());
    else setDrawerRightSel(new Set());
  };

  const toggleRowSelect = useCallback((cid: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(cid);
      else next.delete(cid);
      return next;
    });
  }, []);

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
            <h1>{bi("集群权限", "Cluster Access")}</h1>
            {clusters.length > 0 && (
              <span className="iam-h-meta num">
                {bi(
                  `${clusters.length} 个集群 · ${sharedCount} 已共享`,
                  `${clusters.length} clusters · ${sharedCount} shared`,
                )}
              </span>
            )}
          </div>
          <p>
            {bi(
              "集群默认归创建者自己可见并管理，管理员与全局角色自动可见全部集群；可按集群精细分配其他成员或协作团队的「只读」与「运维」权限。",
              "Clusters are visible to their creator and global admins by default. Grant Read-only or Operate access to collaborators or teams per cluster.",
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
          <UnderlineTabs
            className="iam-subtabs"
            label={bi("集群共享范围", "Cluster sharing filter")}
            value={shareFilter}
            onChange={(v) => setShareFilter(v as "all" | "shared" | "private")}
            items={[
              {
                value: "all",
                label: bi("全部集群", "All Clusters"),
                count: clusters.length,
              },
              {
                value: "shared",
                label: bi("已共享协作", "Shared"),
                count: sharedCount,
              },
              {
                value: "private",
                label: bi("仅创建者可见", "Creator Only"),
                count: clusters.length - sharedCount,
              },
            ]}
          />

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
            {(q || appFilter !== "all" || memberFilter) && (
              <span className="iam-toolbar-count num">
                {bi(
                  `显示 ${filtered.length} / ${clusters.length}`,
                  `${filtered.length} of ${clusters.length}`,
                )}
              </span>
            )}
          </div>

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
                <span>{bi("集群标识", "Cluster ID")}</span>
                <span>{bi("中间件", "Middleware")}</span>
                <span>{bi("创建者", "Creator")}</span>
                <span>
                  {memberFilter
                    ? bi(
                        `${memberFilter} 的生效权限与协作成员`,
                        `${memberFilter}'s Access & Collaborators`,
                      )
                    : bi(
                        "授权成员与团队",
                        "Authorized Users & Teams",
                      )}
                </span>
                <span className="is-right">{bi("操作", "Action")}</span>
              </div>

              <div className="iam-cl-lbody">
                {filtered.map((c) => {
                  const effView = memberFilter
                    ? memberEffectiveDetail(memberFilter, c)
                    : { level: "" as const, via: "" };
                  return (
                    <ClusterAccessLedgerRow
                      key={c.id}
                      cluster={c}
                      checked={selectedIds.has(c.id)}
                      focused={drawerClusterId === c.id}
                      editable={editable}
                      canUsers={canUsers}
                      canTeams={canTeams}
                      effLevel={effView.level}
                      effVia={effView.via}
                      savingKey={savingKey}
                      teamMap={teamMap}
                      onToggleCheck={toggleRowSelect}
                      onOpenDrawer={openClusterDrawer}
                      onUpdateAccess={updateClusterAccess}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {editable && selectedIds.size > 0 && (
            <div className="iam-batch-dock">
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
                      `全选 (${filtered.length})`,
                      `Select all (${filtered.length})`,
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
                  size="small"
                  mode="multiple"
                  maxTagCount={2}
                  className="iam-batch-sel"
                  value={batchTargets}
                  onChange={setBatchTargets}
                  options={batchTargetOptions}
                  getPopupContainer={() => document.body}
                  placeholder={
                    batchTargetOptions.length
                      ? bi(
                          "选择要授权的成员或团队…",
                          "Select users or teams…",
                        )
                      : bi("暂无可分配的普通成员或团队", "No target users/teams")
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
        </>
      )}

      <Modal
        style={{ width: 820, maxWidth: "96vw" }}
        visible={!!drawerCluster}
        onCancel={() => setDrawerClusterId("")}
        footer={null}
        title={
          drawerCluster ? (
            <span className="iam-drawer-title">
              <span>{bi("集群权限分配", "Cluster Access")}</span>
              <code className="mono">{drawerCluster.id}</code>
              <Button
                size="mini"
                type="text"
                onClick={() => {
                  const cid = drawerCluster.id;
                  setDrawerClusterId("");
                  go({ name: "deliveries", id: cid });
                }}
              >
                {bi("打开集群", "Open")} <IconRight />
              </Button>
            </span>
          ) : (
            ""
          )
        }
      >
        {drawerCluster && (() => {
          const canPickItem = (it: DrawerSubjectItem) =>
            it.kind === "user" ? canUsers : canTeams;
          const selectableLeft = filteredDrawerLeft.filter(canPickItem);
          const selectableRight = filteredDrawerRight.filter(canPickItem);
          const validDL = selectableLeft.filter((it) => drawerLeftSel.has(it.key));
          const validDR = selectableRight.filter((it) => drawerRightSel.has(it.key));
          const drawerBusy = savingKey.startsWith(`${drawerCluster.id}:`);

          return (
            <div className="iam-cl-drawer">
              <div className="iam-cl-drawer-meta">
                <div className="iam-cl-drawer-meta-main">
                  <span className="iam-app-pill">
                    {drawerCluster.app_name} {drawerCluster.version}
                  </span>
                  <span className="small">
                    {bi(
                      `创建者 ${drawerCluster.owner} 默认拥有完整运维权限`,
                      `Owner ${drawerCluster.owner} has full Operate access by default`,
                    )}
                    {globalViewerNames.length > 0
                      ? bi(
                          ` · 全局角色（${globalViewerNames.slice(0, 3).join("、")}）自动可见`,
                          ` · Global roles (${globalViewerNames.slice(0, 3).join(", ")}) auto-enabled`,
                        )
                      : ""}
                  </span>
                </div>
                {iam.teams.length === 0 && canTeams && (
                  <button
                    type="button"
                    className="iam-text-act"
                    onClick={() => {
                      setDrawerClusterId("");
                      go({ name: "accounts", id: "~teams" });
                    }}
                  >
                    {bi("去创建协作团队 →", "Create a team →")}
                  </button>
                )}
              </div>

              <div className="iam-drawer-kind-bar">
                <div className="iam-kind-seg" role="tablist">
                  {(
                    [
                      ["all", bi("全部对象", "All")],
                      ["users", bi("平台成员", "Users")],
                      ["teams", bi("协作团队", "Teams")],
                    ] as const
                  ).map(([k, lbl]) => (
                    <button
                      key={k}
                      type="button"
                      role="tab"
                      aria-selected={drawerKind === k}
                      className={drawerKind === k ? "on" : ""}
                      onClick={() => setDrawerKind(k)}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
                <span className="faint small">
                  {bi("穿梭或切换后实时保存生效", "Changes save automatically")}
                </span>
              </div>

              <div className="iam-transfer">
                <div className="iam-tf-pane">
                  <div className="iam-tf-head">
                    <label className="iam-tf-head-chk">
                      <Checkbox
                        checked={
                          selectableLeft.length > 0 &&
                          validDL.length === selectableLeft.length
                        }
                        indeterminate={
                          validDL.length > 0 &&
                          validDL.length < selectableLeft.length
                        }
                        disabled={drawerBusy || selectableLeft.length === 0}
                        onChange={(chk) => {
                          const next = new Set(drawerLeftSel);
                          for (const it of selectableLeft) {
                            if (chk) next.add(it.key);
                            else next.delete(it.key);
                          }
                          setDrawerLeftSel(next);
                        }}
                      />
                      <b>{bi("未授权成员与团队", "Unassigned")}</b>
                    </label>
                    <span className="iam-tf-cnt num">
                      {validDL.length > 0
                        ? `${validDL.length} / ${drawerUnassigned.length}`
                        : drawerUnassigned.length}
                    </span>
                  </div>
                  <div className="iam-tf-search">
                    <Input
                      size="small"
                      prefix={<IconSearch />}
                      allowClear
                      value={drawerLeftQ}
                      onChange={setDrawerLeftQ}
                      placeholder={bi("搜索成员姓名、角色或团队…", "Search user or team…")}
                    />
                  </div>
                  <div className="iam-tf-list">
                    {filteredDrawerLeft.length === 0 ? (
                      <div className="iam-tf-empty">
                        {drawerUnassigned.length === 0
                          ? bi("暂无更多可分配的普通成员或团队", "No unassigned users or teams")
                          : bi("没有匹配的未授权对象", "No matching items")}
                      </div>
                    ) : (
                      filteredDrawerLeft.map((it) => {
                        const allowed = canPickItem(it);
                        const checked = drawerLeftSel.has(it.key);
                        return (
                          <div
                            key={it.key}
                            className={`iam-tf-row ${checked ? "is-checked" : ""}`}
                            onClick={() => {
                              if (!allowed || drawerBusy) return;
                              const next = new Set(drawerLeftSel);
                              if (checked) next.delete(it.key);
                              else next.add(it.key);
                              setDrawerLeftSel(next);
                            }}
                          >
                            <Checkbox
                              checked={checked}
                              disabled={!allowed || drawerBusy}
                            />
                            <span
                              className={`iam-mini-ava ${it.kind === "team" ? "is-team" : ""}`}
                              aria-hidden
                            >
                              {it.kind === "team" ? (
                                <IconUserGroup />
                              ) : (
                                it.title.slice(0, 1).toUpperCase()
                              )}
                            </span>
                            <div className="iam-tf-main">
                              <div className="iam-tf-line1">
                                <b className="iam-tf-id">{it.title}</b>
                                {it.kind === "team" && (
                                  <span className="iam-chip is-team" style={{ height: 18, fontSize: 10.5, padding: "0 5px" }}>
                                    {bi("团队", "Team")}
                                  </span>
                                )}
                              </div>
                              <small className="iam-tf-sub">{it.sub}</small>
                            </div>
                            {allowed && (
                              <span
                                className="iam-tf-quick-grp"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  className="iam-tf-qbtn"
                                  disabled={drawerBusy}
                                  onClick={() =>
                                    void applyDrawerTargets(
                                      drawerCluster,
                                      [it.key],
                                      "view",
                                    )
                                  }
                                >
                                  +{bi("只读", "View")}
                                </button>
                                <button
                                  type="button"
                                  className="iam-tf-qbtn is-op"
                                  disabled={drawerBusy}
                                  onClick={() =>
                                    void applyDrawerTargets(
                                      drawerCluster,
                                      [it.key],
                                      "operate",
                                    )
                                  }
                                >
                                  +{bi("运维", "Op")}
                                </button>
                              </span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="iam-tf-mid">
                  <Button
                    type="primary"
                    size="small"
                    disabled={drawerBusy || validDL.length === 0}
                    loading={drawerBusy && validDL.length > 0}
                    onClick={() =>
                      void applyDrawerTargets(
                        drawerCluster,
                        validDL.map((x) => x.key),
                        "operate",
                      )
                    }
                  >
                    {bi("设为运维", "Operate")} <IconRight />
                  </Button>
                  <Button
                    type="secondary"
                    size="small"
                    disabled={drawerBusy || validDL.length === 0}
                    loading={drawerBusy && validDL.length > 0}
                    onClick={() =>
                      void applyDrawerTargets(
                        drawerCluster,
                        validDL.map((x) => x.key),
                        "view",
                      )
                    }
                  >
                    {bi("设为只读", "Read-only")} <IconRight />
                  </Button>
                  <Button
                    size="small"
                    status="danger"
                    disabled={drawerBusy || validDR.length === 0}
                    loading={drawerBusy && validDR.length > 0}
                    onClick={() =>
                      void applyDrawerTargets(
                        drawerCluster,
                        validDR.map((x) => x.key),
                        "",
                      )
                    }
                  >
                    <IconLeft /> {bi("移除授权", "Revoke")}
                  </Button>
                </div>

                <div className="iam-tf-pane is-target">
                  <div className="iam-tf-head">
                    <label className="iam-tf-head-chk">
                      <Checkbox
                        checked={
                          selectableRight.length > 0 &&
                          validDR.length === selectableRight.length
                        }
                        indeterminate={
                          validDR.length > 0 &&
                          validDR.length < selectableRight.length
                        }
                        disabled={drawerBusy || selectableRight.length === 0}
                        onChange={(chk) => {
                          const next = new Set(drawerRightSel);
                          for (const it of selectableRight) {
                            if (chk) next.add(it.key);
                            else next.delete(it.key);
                          }
                          setDrawerRightSel(next);
                        }}
                      />
                      <b>{bi("已授权协作成员与团队", "Authorized")}</b>
                    </label>
                    <span className="iam-tf-cnt is-brand num">
                      {validDR.length > 0
                        ? `${validDR.length} / ${drawerGranted.length}`
                        : drawerGranted.length}
                    </span>
                  </div>
                  <div className="iam-tf-search">
                    <Input
                      size="small"
                      prefix={<IconSearch />}
                      allowClear
                      value={drawerRightQ}
                      onChange={setDrawerRightQ}
                      placeholder={bi("筛选已授权成员或团队…", "Filter authorized…")}
                    />
                  </div>
                  <div className="iam-tf-list">
                    {filteredDrawerRight.length === 0 ? (
                      <div className="iam-tf-empty">
                        {drawerGranted.length === 0
                          ? bi("从左侧勾选成员或团队，一键授予「只读」或「运维」", "Select users or teams from the left pane")
                          : bi("没有匹配的已授权对象", "No matching items")}
                      </div>
                    ) : (
                      filteredDrawerRight.map((it) => {
                        const allowed = canPickItem(it);
                        const checked = drawerRightSel.has(it.key);
                        const lvl = it.level || "view";
                        return (
                          <div
                            key={it.key}
                            className={`iam-tf-row ${checked ? "is-checked" : ""}`}
                            onClick={() => {
                              if (!allowed || drawerBusy) return;
                              const next = new Set(drawerRightSel);
                              if (checked) next.delete(it.key);
                              else next.add(it.key);
                              setDrawerRightSel(next);
                            }}
                          >
                            <Checkbox
                              checked={checked}
                              disabled={!allowed || drawerBusy}
                            />
                            <span
                              className={`iam-mini-ava ${it.kind === "team" ? "is-team" : ""}`}
                              aria-hidden
                            >
                              {it.kind === "team" ? (
                                <IconUserGroup />
                              ) : (
                                it.title.slice(0, 1).toUpperCase()
                              )}
                            </span>
                            <div className="iam-tf-main">
                              <div className="iam-tf-line1">
                                <b className="iam-tf-id">{it.title}</b>
                                {it.kind === "team" && (
                                  <span className="iam-chip is-team" style={{ height: 18, fontSize: 10.5, padding: "0 5px" }}>
                                    {bi("团队", "Team")}
                                  </span>
                                )}
                              </div>
                              <small className="iam-tf-sub">{it.sub}</small>
                            </div>
                            <span
                              className="iam-lvl-seg"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                disabled={!allowed || drawerBusy}
                                className={lvl === "view" ? "on is-view" : ""}
                                onClick={() =>
                                  void applyDrawerTargets(
                                    drawerCluster,
                                    [it.key],
                                    "view",
                                  )
                                }
                              >
                                {bi("只读", "View")}
                              </button>
                              <button
                                type="button"
                                disabled={!allowed || drawerBusy}
                                className={lvl === "operate" ? "on is-op" : ""}
                                onClick={() =>
                                  void applyDrawerTargets(
                                    drawerCluster,
                                    [it.key],
                                    "operate",
                                  )
                                }
                              >
                                {bi("运维", "Op")}
                              </button>
                            </span>
                            {allowed && (
                              <button
                                type="button"
                                className="iam-tf-rm"
                                disabled={drawerBusy}
                                title={bi("移除授权", "Revoke")}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void applyDrawerTargets(
                                    drawerCluster,
                                    [it.key],
                                    "",
                                  );
                                }}
                              >
                                <IconClose />
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>

              <div className="iam-tf-modal-foot">
                <span className="faint small">
                  {bi(
                    "只读：浏览集群配置、文档与记录 · 运维：可执行探针、变更演练与关联执行 Agent",
                    "Read-only: view config & docs · Operate: run probes, rehearsals & associate Agents",
                  )}
                </span>
                <Button type="primary" onClick={() => setDrawerClusterId("")}>
                  {bi("完成", "Done")}
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>
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

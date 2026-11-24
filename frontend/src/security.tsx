import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Dropdown,
  Input,
  Menu,
  Message,
  Modal,
  Select,
  Skeleton,
  Switch,
} from "@arco-design/web-react";
import {
  IconCheckCircleFill,
  IconCloudDownload,
  IconDown,
  IconDownload,
  IconExclamationCircleFill,
  IconRefresh,
  IconRight,
  IconSearch,
  IconSettings,
  IconSync,
  IconUpload,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  cached,
  can,
  err,
  fullTime,
  platformShort,
  putCached,
  useAIStatus,
} from "./shared";
import { go } from "./router";
import { OsLogo } from "./oslogo";
import {
  AIDock,
  SECURITY_CHANGED,
  Spark,
  VEX_OPEN_DRAFT,
  useAIDock,
  type VexProposal,
} from "./aichat";
import { UnderlineTabs } from "./ui";
import { launchSecurityRehearsalIntent } from "./rehearsal";
import { VexTriageEditor } from "./vextriage";
import { SecSourcesCard, type SecFeedSource } from "./secsources";
import {
  SecExportModal,
  SecReportTemplatesSection,
  type SecReportTemplate,
} from "./secreport";
import { bi, useLang } from "./i18n";
import "./security.css";

/* ---------- types ---------- */

export type SecDBMeta = {
  updated_at?: string;
  updated_by?: string;
  source_mode?: "online" | "offline-import" | string;
  ecosystems: string[];
  advisory_count: number;
  package_count: number;
  bundle_sha256?: string;
  last_error?: string;
};

export type SecIgnoreRule = {
  id: string;
  kind: string;
  package: string;
  eco_key?: string;
  ecosystem?: string;
  pkg_role?: string;
  note?: string;
  by?: string;
  at?: string;
};

export type SecPolicy = {
  block_publish_critical: boolean;
  warn_publish_high: boolean;
  warn_delivery_critical: boolean;
  notify_on_scan: boolean;
  gate_middleware_only?: boolean;
  hide_os_cves?: boolean;
  hide_runtime_cves?: boolean;
  ignored_packages?: SecIgnoreRule[];
};

export type SecSeverityCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  total: number;
};

export type SecCompRiskBadge = {
  component: string;
  version: string;
  platform: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
  middleware_critical?: number;
  middleware_high?: number;
  middleware_total?: number;
  os_critical?: number;
  os_high?: number;
  os_total?: number;
};

export type SecSummaryPayload = {
  has_scan: boolean;
  scanned_at?: string;
  advisory_count: number;
  policy: SecPolicy;
  active_counts: SecSeverityCounts;
  middleware_counts?: SecSeverityCounts;
  os_counts?: SecSeverityCounts;
  runtime_counts?: SecSeverityCounts;
  affected_clusters?: number;
  middleware_affected_clusters?: number;
  os_affected_clusters?: number;
  component_risks: Record<string, SecCompRiskBadge>;
};

type SecClusterImpact = {
  cluster_id: string;
  app_id?: string;
  app_name: string;
  version?: string;
  platform: string;
  owner: string;
  delivery_mode?: string;
  hosts: string[];
};

type SecCompImpact = {
  component: string;
  title: string;
  version: string;
  platform: string;
};

type SecTriageEvent = {
  status: string;
  note?: string;
  expires_at?: string;
  by: string;
  at: string;
};

type SecFinding = {
  key: string;
  id: string;
  cve: string;
  aliases?: string[];
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN" | string;
  cvss_score?: number;
  cvss_vector?: string;
  summary?: string;
  details?: string;
  url?: string;
  published?: string;
  ecosystem: string;
  eco_key: string;
  platform?: string;
  platform_title?: string;
  asset_type: "os_package" | "python_runtime" | "component_declared" | string;
  pkg_role?: "primary" | "dependency" | "runtime" | string;
  package: string;
  installed_version: string;
  fixed_in?: string[];
  repo_fix_version?: string;
  closures?: string[];
  runtimes?: string[];
  components?: SecCompImpact[];
  clusters?: SecClusterImpact[];
  triage_status:
    | "open"
    | "planned"
    | "mitigated"
    | "not_affected"
    | "accepted"
    | "expired"
    | string;
  triage_note?: string;
  triage_justification?: string;
  triage_expires?: string;
  triage_by?: string;
  triage_at?: string;
  triage_history?: SecTriageEvent[];
  linked_cluster_id?: string;
  linked_rehearsal_id?: string;
  linked_sop_doc_id?: string;
  waived?: boolean;
  globally_ignored?: boolean;
  ignore_rule_id?: string;
  ignore_reason?: string;
};

type SecPackageGroup = {
  group_key: string;
  package: string;
  ecosystem: string;
  eco_key: string;
  platform?: string;
  platform_title?: string;
  asset_type: string;
  pkg_role: string;
  installed_version: string;
  recommended_fix?: string;
  repo_fix_version?: string;
  fixable_count: number;
  active_count: number;
  total_count: number;
  waived_count: number;
  ignored_count?: number;
  globally_ignored?: boolean;
  ignore_rule_id?: string;
  ignore_reason?: string;
  max_severity: string;
  max_cvss?: number;
  active_counts: SecSeverityCounts;
  components?: SecCompImpact[];
  clusters?: SecClusterImpact[];
  finding_keys: string[];
  cves: string[];
  findings: SecFinding[];
};

type SecScanDiff = {
  prev_scanned_at?: string;
  added_count: number;
  resolved_count: number;
  added_critical_high?: string[];
  resolved_sample?: string[];
};

type SecScanHistoryEntry = {
  scanned_at: string;
  scanned_by?: string;
  db_advisory_count: number;
  sbom_package_count: number;
  affected_clusters: number;
  active_counts: SecSeverityCounts;
  waived_count: number;
  added_count: number;
  resolved_count: number;
};

type SecSupplyPlatform = {
  platform: string;
  title: string;
  sources_total: number;
  sources_signed: number;
  unsigned_source_ids?: string[];
  index_updated?: string;
  index_packages: number;
  signed_releases: number;
  closures_total: number;
  files_total: number;
  files_missing: number;
  files_hash_mismatch: number;
  missing_samples?: string[];
  healthy: boolean;
};

type SecSupplyChainReport = {
  checked_at: string;
  deep_verified: boolean;
  overall_healthy: boolean;
  platforms: SecSupplyPlatform[];
  runtime_count: number;
  wheel_count: number;
  wheel_sha256_count: number;
  default_platforms: number;
  total_issues: number;
};

type SecClusterSummary = {
  cluster_id: string;
  app_id?: string;
  app_name: string;
  version?: string;
  platform: string;
  owner: string;
  delivery_mode?: string;
  hosts: string[];
  active: SecSeverityCounts;
  total: SecSeverityCounts;
  middleware_active?: SecSeverityCounts;
  os_active?: SecSeverityCounts;
  top_cves?: string[];
  middleware_top_cves?: string[];
  os_top_cves?: string[];
};

type SecRuntimeSummary = {
  id: string;
  ansible: string;
  python: string;
  defaults?: string[];
  wheel_count: number;
  active: SecSeverityCounts;
};

type SecScanReport = {
  scanned_at: string;
  scanned_by?: string;
  duration_ms: number;
  db_updated_at?: string;
  db_advisory_count: number;
  sbom_package_count: number;
  closure_count: number;
  runtime_count: number;
  cluster_count: number;
  affected_clusters: number;
  middleware_affected_clusters?: number;
  os_affected_clusters?: number;
  active_counts: SecSeverityCounts;
  total_counts: SecSeverityCounts;
  middleware_counts?: SecSeverityCounts;
  os_counts?: SecSeverityCounts;
  runtime_counts?: SecSeverityCounts;
  raw_os_counts?: SecSeverityCounts;
  raw_runtime_counts?: SecSeverityCounts;
  waived_count: number;
  suppressed_count?: number;
  suppressed_os_count?: number;
  suppressed_runtime_count?: number;
  suppressed_pkg_count?: number;
  diff?: SecScanDiff;
  findings: SecFinding[];
  package_groups?: SecPackageGroup[];
  clusters: SecClusterSummary[];
  runtimes: SecRuntimeSummary[];
  component_risks: Record<string, SecCompRiskBadge>;
};

type SecOverviewPayload = {
  meta: SecDBMeta;
  policy: SecPolicy;
  sources?: SecFeedSource[];
  report_templates?: SecReportTemplate[];
  sync?: {
    running: boolean;
    mode?: string;
    progress?: string;
    error?: string;
  };
  report: SecScanReport | null;
};

/* ---------- helpers ---------- */

const secTabIco = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  style: { display: "block", flex: "none" } as React.CSSProperties,
  "aria-hidden": true,
};

const SecIcons = {
  overview: (
    <svg {...secTabIco}>
      <path d="M8 2.1L13 4v3.8c0 3.1-2.1 5.2-5 6.1-2.9-.9-5-3-5-6.1V4l5-1.9Z" />
      <path d="M5.8 8.1l1.5 1.5 3-3" />
    </svg>
  ),
  vulns: (
    <svg {...secTabIco}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.2v3.3M8 10.9h.01" />
    </svg>
  ),
  clusters: (
    <svg {...secTabIco}>
      <rect x="2.4" y="2.8" width="11.2" height="4" rx="1.2" />
      <rect x="2.4" y="9.2" width="11.2" height="4" rx="1.2" />
      <circle cx="4.8" cy="4.8" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="4.8" cy="11.2" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  ),
  reports: (
    <svg {...secTabIco}>
      <path d="M4 2.2h5.2l2.8 2.8v8.8H4V2.2Z" />
      <path d="M9.2 2.2V5h2.8M6 8h4M6 10.6h4" />
    </svg>
  ),
  db: (
    <svg {...secTabIco}>
      <ellipse cx="8" cy="4.2" rx="5" ry="2" />
      <path d="M3 4.2v7.6c0 1.1 2.2 2 5 2s5-.9 5-2V4.2" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </svg>
  ),
};

const sevLabel = (s: string) => {
  switch (s.toUpperCase()) {
    case "CRITICAL":
      return bi("严重", "Critical");
    case "HIGH":
      return bi("高危", "High");
    case "MEDIUM":
      return bi("中危", "Medium");
    case "LOW":
      return bi("低危", "Low");
    default:
      return bi("未知", "Unknown");
  }
};

const sevClass = (s: string) => {
  switch (s.toUpperCase()) {
    case "CRITICAL":
      return "crit";
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "med";
    case "LOW":
      return "low";
    default:
      return "unk";
  }
};

const triageLabel = (s: string) => {
  switch (s) {
    case "open":
      return bi("待评估", "Open");
    case "planned":
      return bi("计划修复", "Planned");
    case "mitigated":
      return bi("已缓解", "Mitigated");
    case "not_affected":
      return bi("不适用", "Not Affected");
    case "accepted":
      return bi("风险接受", "Accepted");
    case "expired":
      return bi("豁免已过期", "Expired");
    default:
      return s;
  }
};

const assetTypeLabel = (t: string) => {
  switch (t) {
    case "os_package":
      return bi("软件库包", "OS Package");
    case "python_runtime":
      return bi("运行环境", "Python Runtime");
    case "component_declared":
      return bi("组件声明", "Component");
    default:
      return t;
  }
};

const pkgRoleLabel = (r?: string) => {
  switch (r) {
    case "primary":
      return bi("中间件本体", "Middleware");
    case "runtime":
      return bi("运行环境", "Runtime");
    default:
      return bi("OS 底层包", "OS Base");
  }
};

const sevRank = (s: string) => {
  switch (s.toUpperCase()) {
    case "CRITICAL":
      return 4;
    case "HIGH":
      return 3;
    case "MEDIUM":
      return 2;
    case "LOW":
      return 1;
    default:
      return 0;
  }
};

function groupFindingsByPackage(
  findings: SecFinding[],
  backendGroups?: SecPackageGroup[],
): SecPackageGroup[] {
  const recFixByKey = new Map<string, string>();
  const repoFixByKey = new Map<string, string>();
  for (const bg of backendGroups || []) {
    if (bg.recommended_fix) recFixByKey.set(bg.group_key, bg.recommended_fix);
    if (bg.repo_fix_version) repoFixByKey.set(bg.group_key, bg.repo_fix_version);
  }
  const map = new Map<string, SecPackageGroup>();
  for (const f of findings) {
    const gk = `${f.eco_key}|${f.package.toLowerCase()}|${f.installed_version}|${f.platform || ""}`;
    let g = map.get(gk);
    if (!g) {
      g = {
        group_key: gk,
        package: f.package,
        ecosystem: f.ecosystem,
        eco_key: f.eco_key,
        platform: f.platform,
        platform_title: f.platform_title,
        asset_type: f.asset_type,
        pkg_role:
          f.pkg_role ||
          (f.asset_type === "python_runtime"
            ? "runtime"
            : f.asset_type === "component_declared"
              ? "primary"
              : "dependency"),
        installed_version: f.installed_version,
        recommended_fix: recFixByKey.get(gk) || "",
        repo_fix_version: repoFixByKey.get(gk) || "",
        fixable_count: 0,
        active_count: 0,
        total_count: 0,
        waived_count: 0,
        ignored_count: 0,
        globally_ignored: false,
        ignore_rule_id: "",
        ignore_reason: "",
        max_severity: "UNKNOWN",
        max_cvss: 0,
        active_counts: {
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          unknown: 0,
          total: 0,
        },
        components: [],
        clusters: [],
        finding_keys: [],
        cves: [],
        findings: [],
      };
      map.set(gk, g);
    }
    if (f.pkg_role === "primary") g.pkg_role = "primary";
    g.total_count++;
    g.findings.push(f);
    if (!g.finding_keys.includes(f.key)) g.finding_keys.push(f.key);
    if (!g.cves.includes(f.cve)) g.cves.push(f.cve);
    if (f.waived) {
      g.waived_count++;
    } else if (f.globally_ignored) {
      g.ignored_count = (g.ignored_count || 0) + 1;
      if (!g.ignore_rule_id && f.ignore_rule_id) g.ignore_rule_id = f.ignore_rule_id;
      if (!g.ignore_reason && f.ignore_reason) g.ignore_reason = f.ignore_reason;
    } else {
      g.active_count++;
      g.active_counts.total++;
      const su = f.severity.toUpperCase();
      if (su === "CRITICAL") g.active_counts.critical++;
      else if (su === "HIGH") g.active_counts.high++;
      else if (su === "MEDIUM") g.active_counts.medium++;
      else if (su === "LOW") g.active_counts.low++;
      else g.active_counts.unknown++;
      if (sevRank(f.severity) > sevRank(g.max_severity)) {
        g.max_severity = f.severity;
      }
      if ((f.cvss_score || 0) > (g.max_cvss || 0)) {
        g.max_cvss = f.cvss_score || 0;
      }
      if (f.fixed_in && f.fixed_in.length > 0) {
        g.fixable_count++;
        if (!g.recommended_fix) {
          g.recommended_fix = f.fixed_in[0];
        }
      }
      if (f.repo_fix_version && !g.repo_fix_version) {
        g.repo_fix_version = f.repo_fix_version;
      }
    }
    for (const c of f.components || []) {
      if (
        !g.components!.some(
          (x) =>
            x.component === c.component &&
            x.version === c.version &&
            x.platform === c.platform,
        )
      ) {
        g.components!.push(c);
      }
    }
    for (const cl of f.clusters || []) {
      if (!g.clusters!.some((x) => x.cluster_id === cl.cluster_id)) {
        g.clusters!.push(cl);
      }
    }
  }
  const out = Array.from(map.values());
  for (const g of out) {
    if (
      g.total_count > 0 &&
      (g.ignored_count || 0) > 0 &&
      g.active_count === 0 &&
      (g.ignored_count || 0) + g.waived_count >= g.total_count
    ) {
      g.globally_ignored = true;
    }
    if (g.max_severity === "UNKNOWN") {
      for (const f of g.findings) {
        if (sevRank(f.severity) > sevRank(g.max_severity)) {
          g.max_severity = f.severity;
        }
        if ((f.cvss_score || 0) > (g.max_cvss || 0)) {
          g.max_cvss = f.cvss_score || 0;
        }
      }
    }
  }
  out.sort((a, b) => {
    if ((a.active_count > 0) !== (b.active_count > 0)) {
      return a.active_count > 0 ? -1 : 1;
    }
    const ca = a.clusters?.length || 0;
    const cb = b.clusters?.length || 0;
    if ((ca > 0) !== (cb > 0)) return ca > 0 ? -1 : 1;
    const sr = sevRank(b.max_severity) - sevRank(a.max_severity);
    if (sr !== 0) return sr;
    if ((a.pkg_role === "primary") !== (b.pkg_role === "primary")) {
      return a.pkg_role === "primary" ? -1 : 1;
    }
    if ((b.max_cvss || 0) !== (a.max_cvss || 0)) {
      return (b.max_cvss || 0) - (a.max_cvss || 0);
    }
    if (b.active_count !== a.active_count) return b.active_count - a.active_count;
    return a.package.localeCompare(b.package);
  });
  return out;
}

function launchRehearsalForGroup(g: SecPackageGroup, cl: SecClusterImpact) {
  const targetVer = g.repo_fix_version || g.recommended_fix || "";
  const cveList = g.cves.slice(0, 6).join(", ");
  const title = targetVer
    ? bi(
        `安全修复：升级 ${g.package} 修复 ${g.active_count || g.total_count} 个 CVE`,
        `Security Patch: Upgrade ${g.package} (${g.active_count || g.total_count} CVEs)`,
      )
    : bi(
        `安全缓解：排查与加固 ${g.package} 漏洞`,
        `Security Mitigation: Harden ${g.package}`,
      );
  const goal = targetVer
    ? bi(
        `针对集群 ${cl.cluster_id}（${cl.app_name} ${cl.version || ""}），将软件包 ${g.package} 从 ${g.installed_version} 滚动升级至修复版本 ${targetVer}，一次性解决 ${g.active_count || g.total_count} 个漏洞（${cveList}${g.cves.length > 6 ? " 等" : ""}）。请先通过只读探针核实现网真实安装版本及受影响模块启用状态，再在测试环境演练无中断升级与回退方案。`,
        `Rolling upgrade ${g.package} from ${g.installed_version} to ${targetVer} on ${cl.cluster_id} (${cl.app_name} ${cl.version || ""}) to fix ${g.active_count || g.total_count} CVE(s) (${cveList}). Probe installed version and active config first, then rehearse zero-downtime upgrade and rollback.`,
      )
    : bi(
        `针对集群 ${cl.cluster_id}（${cl.app_name} ${cl.version || ""}）中 ${g.package} ${g.installed_version} 的 ${g.active_count || g.total_count} 个漏洞（${cveList}，暂无上游修复版），请先通过只读探针核实脆弱功能是否启用，再演练配置规避/访问控制缓解步骤。`,
        `Investigate and mitigate ${g.active_count || g.total_count} CVE(s) (${cveList}) on ${g.package} ${g.installed_version} in ${cl.cluster_id}. Probe vulnerable modules first, then rehearse config mitigation.`,
      );
  launchSecurityRehearsalIntent(cl.cluster_id, {
    title,
    goal,
    securityContext: {
      kind: targetVer ? "cve_patch" : "config_hardening",
      finding_keys: g.finding_keys,
      cves: g.cves,
      package: g.package,
      ecosystem: g.ecosystem,
      current_version: g.installed_version,
      target_version: targetVer,
      repo_fix_ready: Boolean(g.repo_fix_version),
    },
  });
}

function launchRehearsalForFinding(f: SecFinding, cl: SecClusterImpact) {
  const targetVer = f.repo_fix_version || (f.fixed_in && f.fixed_in[0]) || "";
  launchSecurityRehearsalIntent(cl.cluster_id, {
    title: targetVer
      ? bi(`安全修复：${f.cve}（升级 ${f.package}）`, `Security Patch: ${f.cve} (${f.package})`)
      : bi(`安全缓解：${f.cve}（${f.package}）`, `Security Mitigation: ${f.cve} (${f.package})`),
    goal: targetVer
      ? bi(
          `修复集群 ${cl.cluster_id}（${cl.app_name} ${cl.version || ""}）命中的 ${f.cve}（${f.severity}），将 ${f.package} 从 ${f.installed_version} 滚动升级至 ${targetVer}。先通过只读探针核实现网版本与模块状态，再在测试环境演练升级与回退方案。`,
          `Remediate ${f.cve} (${f.severity}) on ${cl.cluster_id} by upgrading ${f.package} from ${f.installed_version} to ${targetVer}.`,
        )
      : bi(
          `针对集群 ${cl.cluster_id} 命中的 ${f.cve}（${f.package} ${f.installed_version}，暂无上游补丁），先生成只读探针核查脆弱模块是否实际启用，并制定配置规避缓解演练方案。`,
          `Assess and mitigate ${f.cve} on ${f.package} ${f.installed_version} in ${cl.cluster_id} via read-only probe and config hardening.`,
        ),
    securityContext: {
      kind: targetVer ? "cve_patch" : "config_hardening",
      finding_keys: [f.key],
      cves: [f.cve],
      package: f.package,
      ecosystem: f.ecosystem,
      current_version: f.installed_version,
      target_version: targetVer,
      repo_fix_ready: Boolean(f.repo_fix_version),
    },
  });
}

/* ---------- Detail & VEX Triage Drawer ---------- */

function FindingDrawer({
  finding,
  draftOverride,
  canManage,
  onClose,
  onTriaged,
}: {
  finding: SecFinding | null;
  draftOverride?: VexProposal | null;
  canManage: boolean;
  onClose: () => void;
  onTriaged: (nextReport: SecScanReport | null) => void;
}) {
  useLang();
  const aiStatus = useAIStatus();
  const dock = useAIDock();
  const canSecurityAI =
    aiStatus.enabled &&
    !!aiStatus.features?.security &&
    can("ai.use") &&
    !!dock?.available("sec:x");
  const canRehearsalAI =
    aiStatus.enabled && !!aiStatus.features?.change_rehearsal && can("ai.use");
  const [status, setStatus] = useState("open");
  const [just, setJust] = useState("");
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [globalScope, setGlobalScope] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!finding) return;
    if (draftOverride) {
      setStatus(draftOverride.status || "mitigated");
      setJust(draftOverride.justification || "");
      setNote(draftOverride.note || "");
      setExpires(draftOverride.expires_at || "");
      setGlobalScope(Boolean(draftOverride.global));
      return;
    }
    setStatus(
      finding.triage_status === "expired"
        ? "accepted"
        : finding.triage_status || "open",
    );
    setJust(finding.triage_justification || "");
    setNote(finding.triage_note || "");
    setExpires(finding.triage_expires || "");
    setGlobalScope(false);
  }, [finding?.key, finding?.installed_version, draftOverride]);

  const needNote =
    status === "mitigated" || status === "not_affected" || status === "accepted";

  const openInAIDock = () => {
    if (!dock || !finding) return;
    const roleLabel =
      finding.pkg_role === "primary"
        ? bi("中间件本体", "Middleware")
        : finding.pkg_role === "runtime"
          ? bi("控制机运行环境", "Controller Runtime")
          : bi("OS 底层包", "OS Base");
    const fixText =
      finding.repo_fix_version ||
      finding.fixed_in?.[0] ||
      bi("暂无上游修复版", "no upstream fix yet");
    const clCount = finding.clusters?.length || 0;
    const slug = `${finding.cve}_${finding.package}`
      .replace(/[^a-zA-Z0-9._:-]/g, "_")
      .slice(0, 96);
    onClose();
    dock.open({
      key: `sec:${slug}`,
      title: bi(`安全研判：${finding.cve}`, `Security: ${finding.cve}`),
      context: `${finding.package} ${finding.installed_version}`,
      step: {
        kind: "security_cve",
        title: `${finding.cve}（${finding.package}）`,
        cve: finding.cve,
        finding_key: finding.key,
        package: finding.package,
        ecosystem: finding.ecosystem,
        installed_version: finding.installed_version,
        fixed_in: finding.fixed_in,
        repo_fix_version: finding.repo_fix_version,
        severity: finding.severity,
        score: finding.cvss_score,
        pkg_role: finding.pkg_role,
        triage_status: finding.triage_status,
        clusters: (finding.clusters || []).map((x) => x.cluster_id),
        summary: finding.summary,
      },
      prefill: bi(
        `请研判漏洞 ${finding.cve}（软件包 ${finding.package} ${finding.installed_version}，${roleLabel}，严重等级 ${finding.severity}，影响 ${clCount} 个生产集群，修复版 ${fixText}）：\n1. 说明漏洞原理与实际风险；\n2. 结合受影响资产给出短期缓解、升级或排查建议；\n3. 如结论明确，请在下方直接生成可一键采纳的 VEX 处置提案卡片（或安全演练建议卡片）。`,
        `Assess ${finding.cve} (${finding.package} ${finding.installed_version}, ${roleLabel}, ${finding.severity}, ${clCount} cluster(s), fix: ${fixText}): explain impact, suggest mitigation/upgrade, and emit a one-click VEX triage or rehearsal card if clear.`,
      ),
      prefillIfEmpty: true,
    });
  };

  const saveTriage = async () => {
    if (!finding) return;
    if (needNote && !note.trim() && !just.trim()) {
      Message.warning(
        bi("请填写评估依据或说明", "Please enter a justification or note"),
      );
      return;
    }
    setSaving(true);
    try {
      const res = await api<{ report: SecScanReport | null }>(
        "/api/security/triage",
        {
          method: "POST",
          body: JSON.stringify({
            vuln_id: finding.cve,
            package: finding.package,
            ecosystem: finding.ecosystem,
            global: globalScope,
            status,
            justification: just,
            note: note.trim(),
            expires_at: status === "accepted" ? expires.trim() : "",
          }),
        },
      );
      Message.success(bi("已保存漏洞处置结论", "Vulnerability triage saved"));
      onTriaged(res.report);
    } catch (e) {
      err(e);
    } finally {
      setSaving(false);
    }
  };

  const summaryText = finding?.summary?.trim() || "";
  const detailsText = finding?.details?.trim() || "";
  const showDetails = Boolean(detailsText && detailsText !== summaryText);
  const showSummary = Boolean(
    summaryText &&
      !(showDetails && detailsText.startsWith(summaryText.slice(0, 40))),
  );

  return (
    <Drawer
      visible={!!finding}
      onCancel={onClose}
      footer={null}
      width={620}
      style={{ maxWidth: "100vw" }}
      unmountOnExit
      className="sec-drawer"
      title={
        finding ? (
          <div className="sec-dr-title">
            <span className={`sec-sev ${sevClass(finding.severity)}`}>
              {sevLabel(finding.severity)}
              {finding.cvss_score ? ` ${finding.cvss_score.toFixed(1)}` : ""}
            </span>
            <b className="mono">{finding.cve}</b>
            {finding.id !== finding.cve && (
              <span className="faint small mono">{finding.id}</span>
            )}
          </div>
        ) : null
      }
    >
      {finding && (
      <div className="sec-dr-body">
        <div className="sec-dr-head-meta">
          <span>
            {bi("生态", "Ecosystem")}: <b>{finding.ecosystem}</b>
          </span>
          {finding.published && (
            <span>
              {bi("披露时间", "Published")}:{" "}
              <b className="num">{finding.published.slice(0, 10)}</b>
            </span>
          )}
          {finding.url && (
            <a
              href={finding.url}
              target="_blank"
              rel="noopener noreferrer"
              className="sec-ext-link"
            >
              {bi("官方公告详情", "Official Advisory")} ↗
            </a>
          )}
        </div>

        {(showSummary || showDetails) && (
          <div className="sec-dr-card">
            <h4>{bi("漏洞说明", "Summary")}</h4>
            {showSummary && <p className="sec-dr-sum">{finding.summary}</p>}
            {showDetails && <p className="sec-dr-det">{finding.details}</p>}
            {finding.cvss_vector && (
              <code className="sec-cvss-vec mono">{finding.cvss_vector}</code>
            )}
          </div>
        )}

        <div className="sec-dr-card">
          <h4>{bi("版本对照与修复建议", "Version & Remediation")}</h4>
          <div className="sec-ver-grid">
            <div>
              <span>{bi("命中软件包", "Package")}</span>
              <b className="mono">{finding.package}</b>
            </div>
            <div>
              <span>{bi("当前版本", "Installed")}</span>
              <b className="mono bad">{finding.installed_version}</b>
            </div>
            <div>
              <span>{bi("官方修复版本", "Fixed In")}</span>
              <b className="mono ok">
                {finding.fixed_in?.length
                  ? finding.fixed_in.join(", ")
                  : bi("暂未发布修复版", "No fix yet")}
              </b>
            </div>
            <div>
              <span>{bi("平台软件源状态", "Repo Index")}</span>
              {finding.repo_fix_version ? (
                <b className="mono ok">
                  {bi("已有修复版 ", "Available ")}
                  {finding.repo_fix_version}
                </b>
              ) : (
                <span className="faint small">
                  {finding.asset_type === "python_runtime"
                    ? bi("可在「软件库 → 运行环境」升级 Wheel", "Upgrade wheel in Library → Runtimes")
                    : bi("尚未发现新版本（请先更新软件源索引）", "Update OS repo index to check")}
                </span>
              )}
            </div>
          </div>
          {canSecurityAI && (
            <div className="sec-dr-ai-row">
              <Button
                size="small"
                shape="round"
                className="ai-pill"
                icon={<Spark size={13} rainbow />}
                onClick={openInAIDock}
              >
                {bi("在 AI 助手中研判与对话", "Analyze & Chat in AI Assistant")}
              </Button>
            </div>
          )}
        </div>

        <div className="sec-dr-card">
          <h4>
            {bi("受影响资产与生产集群影响面", "Blast Radius & Affected Assets")}
          </h4>
          {finding.clusters && finding.clusters.length > 0 ? (
            <div className="sec-br-block">
              <div className="sec-br-lbl">
                {bi(
                  `受影响生产集群 (${finding.clusters.length})`,
                  `Affected Clusters (${finding.clusters.length})`,
                )}
              </div>
              <ul className="sec-br-list">
                {finding.clusters.map((cl) => (
                  <li key={cl.cluster_id}>
                    <div className="sec-br-cl-row">
                      <div>
                        <a
                          href={`#/d/${encodeURIComponent(cl.cluster_id)}/security`}
                          onClick={onClose}
                          className="mono"
                        >
                          {cl.cluster_id}
                        </a>
                        <span>
                          {cl.app_name} {cl.version}
                        </span>
                        <span className="sec-mini-tag">
                          <OsLogo id={cl.platform} size={12} />
                          {platformShort(cl.platform)}
                        </span>
                      </div>
                      {canRehearsalAI && cl.delivery_mode !== "configuration" && (
                        <Button
                          size="mini"
                          type="outline"
                          onClick={() => {
                            onClose();
                            launchRehearsalForFinding(finding, cl);
                          }}
                        >
                          <Spark size={11} /> {bi("发起修复演练", "Rehearse Fix")}
                        </Button>
                      )}
                    </div>
                    <div className="faint small">
                      {cl.owner} · {cl.hosts.join(", ") || bi("无主机记录", "No hosts")}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="faint small" style={{ margin: "0 0 8px" }}>
              {bi(
                "当前未命中任何已交付生产集群（仅影响软件库 / 运行环境 / 组件基线）。",
                "No delivered production clusters affected (library/runtime/component baseline only).",
              )}
            </p>
          )}

          {finding.components && finding.components.length > 0 && (
            <div className="sec-br-block">
              <div className="sec-br-lbl">
                {bi("关联组件版本", "Linked Component Versions")}
              </div>
              <div className="sec-chip-row">
                {finding.components.map((c) => (
                  <a
                    key={`${c.component}@${c.version}@${c.platform}`}
                    href={`#/components/${encodeURIComponent(c.component)}`}
                    onClick={onClose}
                    className="sec-link-chip"
                  >
                    {c.title} <span className="mono">{c.version}</span> ·{" "}
                    {platformShort(c.platform)}
                  </a>
                ))}
              </div>
            </div>
          )}

          {finding.closures && finding.closures.length > 0 && (
            <div className="sec-br-block">
              <div className="sec-br-lbl">
                {bi("来源软件库闭包", "Library Closures")}
              </div>
              <div className="sec-chip-row">
                {finding.closures.map((cl) => (
                  <span key={cl} className="sec-plain-chip mono">
                    {cl}
                  </span>
                ))}
              </div>
            </div>
          )}

          {finding.runtimes && finding.runtimes.length > 0 && (
            <div className="sec-br-block">
              <div className="sec-br-lbl">
                {bi("所属 Ansible 运行环境", "Ansible Runtimes")}
              </div>
              <div className="sec-chip-row">
                {finding.runtimes.map((rt) => (
                  <span key={rt} className="sec-plain-chip mono">
                    {rt}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="sec-dr-card">
          <h4>
            {bi("漏洞处置与风险豁免 (VEX)", "Vulnerability Triage & Waiver (VEX)")}
          </h4>
          {finding.linked_cluster_id && finding.linked_rehearsal_id && (
            <div className="sec-vex-link-box">
              <span>
                {bi("关联安全修复演练：", "Linked Security Rehearsal: ")}
                <a
                  href={`#/d/${encodeURIComponent(finding.linked_cluster_id)}/rehearsal/${encodeURIComponent(finding.linked_rehearsal_id)}`}
                  onClick={onClose}
                  className="mono"
                >
                  {finding.linked_cluster_id} / {finding.linked_rehearsal_id}
                </a>
              </span>
              {finding.linked_sop_doc_id && (
                <a
                  href={`#/d/${encodeURIComponent(finding.linked_cluster_id)}/docs/${encodeURIComponent(finding.linked_sop_doc_id)}`}
                  onClick={onClose}
                  className="mono"
                >
                  {bi("查看固化 SOP", "View SOP")} ({finding.linked_sop_doc_id}) ↗
                </a>
              )}
            </div>
          )}
          {canManage ? (
            <div className="sec-triage-form">
              <VexTriageEditor
                context={{
                  kind: "vex",
                  cve: finding.cve,
                  package: finding.package,
                  ecosystem: finding.ecosystem,
                  installed_version: finding.installed_version,
                  fixed_in: finding.fixed_in,
                  pkg_role: finding.pkg_role,
                  severity: finding.severity,
                  cvss_score: finding.cvss_score,
                  summary: finding.summary,
                  cluster_id: finding.clusters?.[0]?.cluster_id,
                }}
                status={status}
                onStatusChange={setStatus}
                justification={just}
                onJustificationChange={setJust}
                expires={expires}
                onExpiresChange={setExpires}
                note={note}
                onNoteChange={setNote}
                globalScope={globalScope}
                onGlobalScopeChange={setGlobalScope}
                showContextCard={false}
              />
              <div className="sec-triage-foot" style={{ justifyContent: "flex-end" }}>
                <Button
                  type="primary"
                  size="small"
                  loading={saving}
                  onClick={saveTriage}
                >
                  {bi("保存处置结论", "Save Triage")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="sec-triage-ro">
              <span className={`sec-tr-badge st-${finding.triage_status}`}>
                {triageLabel(finding.triage_status)}
              </span>
              {finding.triage_note && <p>{finding.triage_note}</p>}
              {finding.triage_by && (
                <small className="faint">
                  {finding.triage_by} · {fullTime(finding.triage_at || "")}
                </small>
              )}
            </div>
          )}

          {finding.triage_history && finding.triage_history.length > 0 && (
            <div className="sec-tr-hist">
              <div className="sec-br-lbl">{bi("处置审计记录", "Audit Trail")}</div>
              <ul>
                {finding.triage_history.map((h, i) => (
                  <li key={i}>
                    <span className={`sec-tr-badge st-${h.status}`}>
                      {triageLabel(h.status)}
                    </span>
                    <span className="sec-tr-hn">{h.note || "—"}</span>
                    <span className="faint small num">
                      {h.by} · {ago(h.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      )}
    </Drawer>
  );
}

/* ---------- Main Security Center Page ---------- */

export function SecurityPage({
  tab: initTab,
  query: initQuery,
}: {
  tab?: "overview" | "vulns" | "clusters" | "reports" | "db";
  query?: string;
}) {
  useLang();
  const aiStatus = useAIStatus();
  const canScan = can("security.scan");
  const canManage = can("security.manage");
  const [data, setData] = useState<SecOverviewPayload | null>(
    () => cached<SecOverviewPayload>("/api/security/overview") ?? null,
  );
  const [loading, setLoading] = useState(!data);
  const [tab, setTab] = useState<
    "overview" | "vulns" | "clusters" | "reports" | "db"
  >(initTab || "overview");
  const [exportOpen, setExportOpen] = useState(false);
  const [q, setQ] = useState(initQuery || "");
  const [viewMode, setViewMode] = useState<"grouped" | "list">("grouped");
  const [sevFilter, setSevFilter] = useState("ALL");
  const [stateFilter, setStateFilter] = useState<
    "active" | "all" | "waived" | "ignored"
  >("active");
  const [ignoreTarget, setIgnoreTarget] = useState<{
    pkg: string;
    ecoKey: string;
    ecosystem: string;
    pkgRole: string;
    activeCount: number;
    clusterCount: number;
  } | null>(null);
  const [ignoreAllEco, setIgnoreAllEco] = useState(true);
  const [ignoreNote, setIgnoreNote] = useState("");
  const [ignoreBusy, setIgnoreBusy] = useState(false);
  const [compFilter, setCompFilter] = useState("all");
  const [compVerFilter, setCompVerFilter] = useState("all");
  const [osFilter, setOsFilter] = useState("all");
  const [roleFilter, setRoleFilterState] = useState<
    "all" | "primary" | "dependency" | "runtime"
  >(() => {
    try {
      const saved = localStorage.getItem("mh_sec_layer_scope");
      if (saved === "primary" || saved === "dependency" || saved === "runtime")
        return saved;
    } catch {
      /* ignore */
    }
    return "all";
  });
  const setRoleFilter = (next: "all" | "primary" | "dependency" | "runtime") => {
    setRoleFilterState(next);
    try {
      localStorage.setItem("mh_sec_layer_scope", next);
    } catch {
      /* ignore */
    }
  };
  const [fixFilter, setFixFilter] = useState<
    "all" | "repo_ready" | "cluster_only"
  >("all");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );
  const [selectedMap, setSelectedMap] = useState<Record<string, SecFinding>>(
    {},
  );
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchStatus, setBatchStatus] = useState("mitigated");
  const [batchNote, setBatchNote] = useState("");
  const [batchExpires, setBatchExpires] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);

  const [supplyChain, setSupplyChain] = useState<SecSupplyChainReport | null>(
    null,
  );
  const [supplyBusy, setSupplyBusy] = useState(false);
  const [history, setHistory] = useState<SecScanHistoryEntry[]>([]);

  const [scanning, setScanning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [replaceImport, setReplaceImport] = useState(false);
  const [ecoExpanded, setEcoExpanded] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [activeFinding, setActiveFinding] = useState<SecFinding | null>(null);
  const [draftOverride, setDraftOverride] = useState<VexProposal | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const canRehearsalAI =
    aiStatus.enabled && !!aiStatus.features?.change_rehearsal && can("ai.use");

  useEffect(() => {
    if (initTab) setTab(initTab);
  }, [initTab]);
  useEffect(() => {
    if (initQuery !== undefined) setQ(initQuery);
  }, [initQuery]);

  const load = async () => {
    try {
      const r = await api<SecOverviewPayload>("/api/security/overview");
      putCached("/api/security/overview", r);
      setData(r);
    } catch (e) {
      err(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // Auto-reload when a VEX proposal card is accepted inside the bottom-right Security AI Assistant.
  useEffect(() => {
    const onSecChanged = () => void load();
    window.addEventListener(SECURITY_CHANGED, onSecChanged);
    return () => window.removeEventListener(SECURITY_CHANGED, onSecChanged);
  }, []);

  // Allow "Edit in Modal" on an AI VEX proposal card to open FindingDrawer prefilled.
  useEffect(() => {
    const onOpenDraft = (e: Event) => {
      const v = (e as CustomEvent<VexProposal>).detail;
      const list = data?.report?.findings || [];
      if (!v || list.length === 0) return;
      const targetCVE = (v.cve || v.cves?.[0] || "").toUpperCase();
      const hit =
        list.find(
          (f) =>
            (f.cve.toUpperCase() === targetCVE || f.id.toUpperCase() === targetCVE) &&
            (!v.package || f.package.toLowerCase() === v.package.toLowerCase()),
        ) ||
        list.find(
          (f) => f.cve.toUpperCase() === targetCVE || f.id.toUpperCase() === targetCVE,
        );
      if (!hit) return;
      setDraftOverride(v);
      setActiveFinding(hit);
    };
    window.addEventListener(VEX_OPEN_DRAFT, onOpenDraft);
    return () => window.removeEventListener(VEX_OPEN_DRAFT, onOpenDraft);
  }, [data]);

  const loadSupplyChain = async (verify = false) => {
    setSupplyBusy(true);
    try {
      const res = await api<SecSupplyChainReport>(
        `/api/security/supply-chain${verify ? "?verify=1" : ""}`,
      );
      setSupplyChain(res);
      if (verify) {
        Message.success(
          res.overall_healthy
            ? bi("深度 SHA256 完整性校验全部通过", "Deep SHA256 verification passed")
            : bi(
                `完整性校验发现 ${res.total_issues} 项异常，请检查下方详情`,
                `Integrity check found ${res.total_issues} issue(s)`,
              ),
        );
      }
    } catch (e) {
      err(e);
    } finally {
      setSupplyBusy(false);
    }
  };

  const loadHistory = async () => {
    try {
      const list = await api<SecScanHistoryEntry[]>("/api/security/history");
      setHistory(list || []);
    } catch {
      /* optional */
    }
  };

  useEffect(() => {
    if (tab === "db") {
      if (!supplyChain) void loadSupplyChain(false);
      void loadHistory();
    }
  }, [tab]);

  const submitBatchTriage = async () => {
    const picked = Object.values(selectedMap);
    if (picked.length === 0) return;
    const needNote =
      batchStatus === "mitigated" ||
      batchStatus === "not_affected" ||
      batchStatus === "accepted";
    if (needNote && !batchNote.trim()) {
      Message.warning(bi("请填写批量处置说明或依据", "Please enter justification note"));
      return;
    }
    setBatchBusy(true);
    try {
      const res = await api<{ updated: number; report: SecScanReport | null }>(
        "/api/security/triage/batch",
        {
          method: "POST",
          body: JSON.stringify({
            items: picked.map((f) => ({
              vuln_id: f.cve,
              package: f.package,
              ecosystem: f.ecosystem,
            })),
            status: batchStatus,
            note: batchNote.trim(),
            expires_at: batchStatus === "accepted" ? batchExpires.trim() : "",
          }),
        },
      );
      if (res.report) {
        setData((cur) => {
          if (!cur) return cur;
          const updated = { ...cur, report: res.report };
          putCached("/api/security/overview", updated);
          return updated;
        });
      }
      setSelectedMap({});
      setBatchOpen(false);
      setBatchNote("");
      Message.success(
        bi(`已批量更新 ${res.updated} 条 CVE 的 VEX 状态`, `Batch updated ${res.updated} CVE(s)`),
      );
    } catch (e) {
      err(e);
    } finally {
      setBatchBusy(false);
    }
  };

  const switchTab = (
    next: "overview" | "vulns" | "clusters" | "reports" | "db",
    nextQ?: string,
  ) => {
    setTab(next);
    if (nextQ !== undefined) setQ(nextQ);
    go(
      {
        name: "security",
        tab: next === "overview" ? undefined : next,
        q: nextQ !== undefined ? nextQ || undefined : q || undefined,
      },
      { replace: true },
    );
  };

  const runScan = async () => {
    setScanning(true);
    try {
      const res = await api<SecOverviewPayload>("/api/security/scan", {
        method: "POST",
      });
      setData((cur) => {
        const merged = { ...res, sources: res.sources ?? cur?.sources };
        putCached("/api/security/overview", merged);
        return merged;
      });
      Message.success(
        bi(
          `离线扫描完成（耗时 ${res.report?.duration_ms ?? 0}ms）：活跃风险 ${res.report?.active_counts.total ?? 0} 项`,
          `Scan completed in ${res.report?.duration_ms ?? 0}ms: ${res.report?.active_counts.total ?? 0} active findings`,
        ),
      );
    } catch (e) {
      err(e);
    } finally {
      setScanning(false);
    }
  };

  const runOnlineSync = async (sourceId?: unknown) => {
    const sid = typeof sourceId === "string" ? sourceId : undefined;
    setSyncing(true);
    try {
      const res = await api<SecOverviewPayload>("/api/security/db/sync", {
        method: "POST",
        body: sid ? JSON.stringify({ source_id: sid }) : undefined,
      });
      setData((cur) => {
        const merged = {
          ...res,
          sources: res.sources ?? cur?.sources,
        };
        putCached("/api/security/overview", merged);
        return merged;
      });
      Message.success(
        bi(
          `已在线同步 ${res.meta.advisory_count} 条安全公告并完成全平台扫描`,
          `Synced ${res.meta.advisory_count} advisories and completed scan`,
        ),
      );
    } catch (e) {
      err(e);
    } finally {
      setSyncing(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (replaceImport) fd.append("replace", "1");
      const res = await api<SecOverviewPayload & { imported: number }>(
        `/api/security/db/import${replaceImport ? "?replace=1" : ""}`,
        { method: "POST", body: fd },
      );
      setData((cur) => {
        const merged = { ...res, sources: res.sources ?? cur?.sources };
        putCached("/api/security/overview", merged);
        return merged;
      });
      Message.success(
        bi(
          `离线漏洞库导入成功（新增/更新 ${res.imported} 条，库内共 ${res.meta.advisory_count} 条），已完成本地扫描`,
          `Imported ${res.imported} advisories (${res.meta.advisory_count} total) and completed offline scan`,
        ),
      );
    } catch (e2) {
      err(e2);
    } finally {
      setImporting(false);
    }
  };

  const savePolicy = async (next: SecPolicy, toastMsg?: string) => {
    if (!data || !canManage) return;
    const prev = data.policy;
    setPolicyBusy(true);
    setData({ ...data, policy: next });
    try {
      const saved = await api<SecPolicy>("/api/security/policy", {
        method: "PUT",
        body: JSON.stringify(next),
      });
      setData((cur) => (cur ? { ...cur, policy: saved } : cur));
      await load();
      window.dispatchEvent(new Event(SECURITY_CHANGED));
      Message.success(toastMsg || bi("已更新安全视角与门禁策略", "Security perspective & policy updated"));
    } catch (e) {
      setData((cur) => (cur ? { ...cur, policy: prev } : cur));
      err(e);
    } finally {
      setPolicyBusy(false);
    }
  };

  const submitGlobalIgnore = async () => {
    if (!ignoreTarget || !canManage) return;
    setIgnoreBusy(true);
    try {
      const res = await api<{
        rule: SecIgnoreRule;
        policy: SecPolicy;
        report: SecScanReport | null;
      }>("/api/security/ignores", {
        method: "POST",
        body: JSON.stringify({
          package: ignoreTarget.pkg,
          eco_key: ignoreAllEco ? "*" : ignoreTarget.ecoKey,
          ecosystem: ignoreAllEco ? "" : ignoreTarget.ecosystem,
          all_ecosystems: ignoreAllEco,
          pkg_role: ignoreTarget.pkgRole,
          note: ignoreNote.trim(),
        }),
      });
      setData((cur) => {
        if (!cur) return cur;
        const updated = {
          ...cur,
          policy: res.policy,
          report: res.report ?? cur.report,
        };
        putCached("/api/security/overview", updated);
        return updated;
      });
      window.dispatchEvent(new Event(SECURITY_CHANGED));
      Message.success(
        bi(
          `已全局忽略 ${ignoreTarget.pkg}：默认隐藏且不再计入集群打分与门禁`,
          `Globally ignored ${ignoreTarget.pkg} (hidden & excluded from scoring)`,
        ),
      );
      setIgnoreTarget(null);
      setIgnoreNote("");
    } catch (e) {
      err(e);
    } finally {
      setIgnoreBusy(false);
    }
  };

  const removeGlobalIgnore = async (ruleId: string, label?: string) => {
    if (!canManage || !ruleId) return;
    setPolicyBusy(true);
    try {
      const res = await api<{
        policy: SecPolicy;
        report: SecScanReport | null;
      }>(`/api/security/ignores/${encodeURIComponent(ruleId)}`, {
        method: "DELETE",
      });
      setData((cur) => {
        if (!cur) return cur;
        const updated = {
          ...cur,
          policy: res.policy,
          report: res.report ?? cur.report,
        };
        putCached("/api/security/overview", updated);
        return updated;
      });
      window.dispatchEvent(new Event(SECURITY_CHANGED));
      Message.success(
        bi(
          `已恢复显示${label ? ` ${label}` : ""}`,
          `Restored${label ? ` ${label}` : ""}`,
        ),
      );
    } catch (e) {
      err(e);
    } finally {
      setPolicyBusy(false);
    }
  };

  const restoreIgnoredRule = (ruleId: string | undefined, pkgLabel?: string) => {
    if (!ruleId) return;
    if (ruleId === "layer:os") {
      void savePolicy(
        { ...policy, hide_os_cves: false },
        bi("已取消全局屏蔽 OS 底层包漏洞", "OS base library CVEs restored"),
      );
      return;
    }
    if (ruleId === "layer:runtime") {
      void savePolicy(
        { ...policy, hide_runtime_cves: false },
        bi("已取消全局屏蔽运行环境漏洞", "Runtime CVEs restored"),
      );
      return;
    }
    void removeGlobalIgnore(ruleId, pkgLabel);
  };

  const rep = data?.report || null;
  const sources = data?.sources || [];
  const reportTemplates = data?.report_templates || [];
  const meta = data?.meta || {
    ecosystems: [],
    advisory_count: 0,
    package_count: 0,
  };
  const policy = data?.policy || {
    block_publish_critical: false,
    warn_publish_high: true,
    warn_delivery_critical: true,
    notify_on_scan: false,
    gate_middleware_only: false,
    hide_os_cves: false,
    hide_runtime_cves: false,
    ignored_packages: [],
  };
  const ignoredRules = policy.ignored_packages || [];
  const suppressedCount = rep?.suppressed_count ?? 0;

  const emptyCounts: SecSeverityCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    total: 0,
  };
  const mwCounts = rep?.middleware_counts || emptyCounts;
  const osCounts = rep?.os_counts || emptyCounts;
  const rtCounts = rep?.runtime_counts || emptyCounts;
  const rawOSCounts = rep?.raw_os_counts || osCounts;
  const rawRTCounts = rep?.raw_runtime_counts || rtCounts;
  const scopedActiveCounts =
    roleFilter === "primary"
      ? mwCounts
      : roleFilter === "dependency"
        ? osCounts
        : roleFilter === "runtime"
          ? rtCounts
          : rep?.active_counts || emptyCounts;
  const scopedAffectedClusters =
    roleFilter === "primary"
      ? (rep?.middleware_affected_clusters ?? 0)
      : roleFilter === "dependency"
        ? (rep?.os_affected_clusters ?? 0)
        : roleFilter === "runtime"
          ? 0
          : (rep?.affected_clusters ?? 0);

  // Dynamic cascading facet options derived from current scan findings.
  const componentOptions = useMemo(() => {
    const map = new Map<string, { id: string; title: string; count: number }>();
    let runtimeCount = 0;
    for (const f of rep?.findings || []) {
      if (stateFilter === "ignored") {
        if (!f.globally_ignored) continue;
      } else {
        if (f.globally_ignored) continue;
        if (stateFilter === "active" && f.waived) continue;
        if (stateFilter === "waived" && !f.waived) continue;
      }
      if (f.asset_type === "python_runtime") {
        runtimeCount++;
      }
      const seenComp = new Set<string>();
      for (const c of f.components || []) {
        if (seenComp.has(c.component)) continue;
        seenComp.add(c.component);
        const cur = map.get(c.component);
        if (cur) cur.count++;
        else map.set(c.component, { id: c.component, title: c.title, count: 1 });
      }
    }
    const list = Array.from(map.values()).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
    const opts = [{ value: "all", label: bi("全部组件", "All Components") }];
    for (const item of list) {
      opts.push({ value: item.id, label: `${item.title} (${item.count})` });
    }
    if (runtimeCount > 0) {
      opts.push({
        value: "__runtime__",
        label: bi(`Ansible 运行环境 (${runtimeCount})`, `Ansible Runtime (${runtimeCount})`),
      });
    }
    return opts;
  }, [rep?.findings, stateFilter]);

  const compVersionOptions = useMemo(() => {
    if (compFilter === "all" || compFilter === "__runtime__") return [];
    const map = new Map<string, number>();
    for (const f of rep?.findings || []) {
      if (stateFilter === "ignored") {
        if (!f.globally_ignored) continue;
      } else {
        if (f.globally_ignored) continue;
        if (stateFilter === "active" && f.waived) continue;
        if (stateFilter === "waived" && !f.waived) continue;
      }
      const seenV = new Set<string>();
      for (const c of f.components || []) {
        if (c.component !== compFilter || seenV.has(c.version)) continue;
        seenV.add(c.version);
        map.set(c.version, (map.get(c.version) || 0) + 1);
      }
    }
    const list = Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
    return [
      { value: "all", label: bi("全部版本", "All Versions") },
      ...list.map(([v, cnt]) => ({ value: v, label: `${v} (${cnt})` })),
    ];
  }, [rep?.findings, compFilter, stateFilter]);

  const osOptions = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const f of rep?.findings || []) {
      if (stateFilter !== "ignored" && f.globally_ignored) continue;
      const pid = f.platform || f.eco_key;
      if (!pid) continue;
      const lbl =
        pid === "python"
          ? bi("PyPI (Python)", "PyPI (Python)")
          : platformShort(pid) || f.platform_title || f.ecosystem;
      const cur = map.get(pid);
      if (cur) cur.count++;
      else map.set(pid, { label: lbl, count: 1 });
    }
    return [
      { value: "all", label: bi("全部系统", "All OS") },
      ...Array.from(map.entries()).map(([id, info]) => ({
        value: id,
        label: `${info.label} (${info.count})`,
      })),
    ];
  }, [rep?.findings, stateFilter]);

  const filteredFindings = useMemo(() => {
    const list = rep?.findings || [];
    const needle = q.trim().toLowerCase();
    return list.filter((f) => {
      if (stateFilter === "ignored") {
        if (!f.globally_ignored) return false;
      } else {
        if (f.globally_ignored) return false;
        if (stateFilter === "active" && f.waived) return false;
        if (stateFilter === "waived" && !f.waived) return false;
      }
      if (sevFilter !== "ALL" && f.severity !== sevFilter) return false;
      if (compFilter === "__runtime__") {
        if (f.asset_type !== "python_runtime") return false;
      } else if (compFilter !== "all") {
        const hitComp = (f.components || []).some(
          (c) =>
            c.component === compFilter &&
            (compVerFilter === "all" || c.version === compVerFilter),
        );
        if (!hitComp) return false;
      }
      if (osFilter !== "all" && (f.platform || f.eco_key) !== osFilter) {
        return false;
      }
      if (roleFilter !== "all") {
        const effRole =
          f.pkg_role ||
          (f.asset_type === "python_runtime"
            ? "runtime"
            : f.asset_type === "component_declared"
              ? "primary"
              : "dependency");
        if (effRole !== roleFilter) return false;
      }
      if (fixFilter === "repo_ready" && !f.repo_fix_version) return false;
      if (fixFilter === "cluster_only" && !(f.clusters && f.clusters.length > 0))
        return false;
      if (needle) {
        const hay = [
          f.cve,
          f.id,
          f.package,
          f.installed_version,
          f.ecosystem,
          f.summary,
          ...(f.components || []).map((c) => `${c.component} ${c.title} ${c.version}`),
          ...(f.clusters || []).map((c) => `${c.cluster_id} ${c.app_name}`),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [
    rep?.findings,
    q,
    sevFilter,
    stateFilter,
    compFilter,
    compVerFilter,
    osFilter,
    roleFilter,
    fixFilter,
  ]);

  const filteredGroups = useMemo(
    () => groupFindingsByPackage(filteredFindings, rep?.package_groups),
    [filteredFindings, rep?.package_groups],
  );

  const scopedActiveGroups = useMemo(
    () =>
      groupFindingsByPackage(
        (rep?.findings || []).filter((f) => {
          if (f.waived || f.globally_ignored) return false;
          if (roleFilter !== "all") {
            const effRole =
              f.pkg_role ||
              (f.asset_type === "python_runtime"
                ? "runtime"
                : f.asset_type === "component_declared"
                  ? "primary"
                  : "dependency");
            if (effRole !== roleFilter) return false;
          }
          return true;
        }),
        rep?.package_groups,
      ),
    [rep?.findings, rep?.package_groups, roleFilter],
  );

  const priorityGroups = useMemo(
    () => scopedActiveGroups.slice(0, 8),
    [scopedActiveGroups],
  );

  const hasAnyVulnFilter =
    Boolean(q.trim()) ||
    sevFilter !== "ALL" ||
    stateFilter !== "active" ||
    compFilter !== "all" ||
    osFilter !== "all" ||
    roleFilter !== "all" ||
    fixFilter !== "all";

  const resetVulnFilters = () => {
    setQ("");
    setSevFilter("ALL");
    setStateFilter("active");
    setCompFilter("all");
    setCompVerFilter("all");
    setOsFilter("all");
    setRoleFilter("all");
    setFixFilter("all");
  };

  const selectedCount = Object.keys(selectedMap).length;
  const toggleFindingSelect = (f: SecFinding, checked: boolean) => {
    const id = `${f.key}|${f.installed_version}`;
    setSelectedMap((prev) => {
      const next = { ...prev };
      if (checked) next[id] = f;
      else delete next[id];
      return next;
    });
  };
  const toggleGroupSelect = (g: SecPackageGroup, checked: boolean) => {
    setSelectedMap((prev) => {
      const next = { ...prev };
      for (const f of g.findings) {
        const id = `${f.key}|${f.installed_version}`;
        if (checked) next[id] = f;
        else delete next[id];
      }
      return next;
    });
  };

  const navGroups: {
    id: string;
    label: string;
    items: {
      value: typeof tab;
      label: string;
      hint: string;
      icon: React.ReactNode;
      count?: number;
    }[];
  }[] = [
    {
      id: "posture",
      label: bi("态势与排查", "Posture & Triage"),
      items: [
        {
          value: "overview",
          label: bi("安全概览", "Overview"),
          hint: bi("分层风险与优先修复队列", "Risk layers & fix queue"),
          icon: SecIcons.overview,
        },
        {
          value: "vulns",
          label: bi("漏洞清单", "Vulnerabilities"),
          hint: bi("按包聚合、检索与 VEX 处置", "Packages, CVEs & VEX triage"),
          icon: SecIcons.vulns,
          count: scopedActiveCounts.total,
        },
        {
          value: "clusters",
          label: bi("集群风险", "Cluster Risk"),
          hint: bi("已交付集群受影响范围", "Delivered cluster exposure"),
          icon: SecIcons.clusters,
          count: scopedAffectedClusters,
        },
      ],
    },
    {
      id: "governance",
      label: bi("合规与策略", "Governance & Policy"),
      items: [
        {
          value: "reports",
          label: bi("报告模板", "Report Templates"),
          hint: bi("合规导出格式与字段定制", "Audit & compliance exports"),
          icon: SecIcons.reports,
          count: reportTemplates.length || undefined,
        },
        {
          value: "db",
          label: bi("漏洞源与门禁", "Sources & Gates"),
          hint: bi("在线/离线库与发布门禁", "Advisory feeds & gates"),
          icon: SecIcons.db,
        },
      ],
    },
  ];
  const flatNavItems = navGroups.flatMap((g) => g.items);
  const viewHeaderMap: Record<
    typeof tab,
    { title: string; desc: string }
  > = {
    overview: {
      title: bi("安全概览", "Security Overview"),
      desc: bi(
        "按中间件本体、OS 底层包与运行环境分层呈现离线 CVE 扫描态势与优先修复队列。",
        "Deterministic offline CVE posture across middleware, OS base libraries, and runtimes.",
      ),
    },
    vulns: {
      title: bi("漏洞清单", "Vulnerabilities"),
      desc: bi(
        "支持按升级包聚合或按 CVE 明细检索，快速批量 VEX 处置并一键发起修复演练。",
        "Inspect findings grouped by upgradeable package or individual CVE with batch VEX triage.",
      ),
    },
    clusters: {
      title: bi("集群风险", "Cluster Risk"),
      desc: bi(
        "基于已交付集群 SBOM 追踪受影响生产集群，联动集群安全详情与修复演练。",
        "Track delivered production cluster exposure from SBOMs and jump straight to remediation.",
      ),
    },
    reports: {
      title: bi("报告模板", "Report Templates"),
      desc: bi(
        "定制安全合规导出模板，全局安全中心与单集群安全页导出时均可直接选用。",
        "Manage reusable security report templates for global and cluster-level exports.",
      ),
    },
    db: {
      title: bi("漏洞源与门禁", "Sources & Gates"),
      desc: bi(
        "管理在线 OSV / 离线漏洞库同步源，配置全局风险视角屏蔽与交付发布门禁。",
        "Configure online OSV or offline advisory bundles, global visibility rules, and release gates.",
      ),
    },
  };
  const currentHead = viewHeaderMap[tab];

  if (loading && !data) {
    return (
      <div className="sec-shell">
        <aside className="sec-rail" aria-label={bi("安全中心", "Security Center")}>
          <div className="sec-rail-head">
            <h1>{bi("安全中心", "Security Center")}</h1>
            <p>
              {bi(
                "基于平台软件库闭包、运行环境与集群 SBOM 的离线 CVE 风险治理。",
                "Offline CVE scanning across Software Library closures, runtimes, and cluster SBOMs.",
              )}
            </p>
          </div>
          <div className="sec-rail-nav">
            <Skeleton animation text={{ rows: 5 }} />
          </div>
        </aside>
        <div className="sec-main">
          <div className="sec-main-inner">
            <Skeleton animation text={{ rows: 8 }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <AIDock
      scope={{ kind: "security" }}
      start={{
        key: "sec",
        title: bi("安全 AI 助手", "Security AI Assistant"),
        context: bi("全局安全与漏洞中心", "Global Security Center"),
      }}
      onChanged={() => void load()}
    >
    <div className="sec-shell enter">
      <input
        ref={fileRef}
        type="file"
        accept=".tar.gz,.tgz,.json"
        style={{ display: "none" }}
        onChange={handleImportFile}
      />

      <aside className="sec-rail" aria-label={bi("安全中心导航", "Security center navigation")}>
        <div className="sec-rail-head">
          <div className="sec-rail-title-row">
            <h1>{bi("安全中心", "Security Center")}</h1>
            {canScan && (
              <Button
                size="small"
                icon={<IconSettings />}
                onClick={() => switchTab("db")}
                title={bi("管理漏洞源与门禁策略", "Manage advisory sources & gates")}
              >
                {bi("漏洞源", "Sources")}
              </Button>
            )}
          </div>
          <p>
            {bi(
              "基于软件库闭包、运行环境与已交付集群 SBOM 的确定性离线 CVE 扫描，不依赖 AI 即可独立运行。",
              "Deterministic offline CVE scanning across library closures, runtimes, and delivered cluster SBOMs.",
            )}
          </p>
        </div>

        <nav className="sec-rail-nav" aria-label={bi("安全中心分区", "Security center views")}>
          {navGroups.map((grp) => (
            <div key={grp.id} className="sec-rail-grp">
              <div className="st-nav-g">{grp.label}</div>
              {grp.items.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`sx-nav-i sec-nav-i ${tab === item.value ? "on" : ""}`}
                  aria-current={tab === item.value ? "page" : undefined}
                  onClick={() => switchTab(item.value)}
                >
                  <span className="sx-nav-ic">{item.icon}</span>
                  <span className="sx-nav-t">
                    <b>{item.label}</b>
                    <small>{item.hint}</small>
                  </span>
                  {item.count !== undefined && (
                    <em
                      className={`sec-nav-cnt num${item.value === "vulns" && item.count > 0 ? " is-warn" : ""}`}
                    >
                      {item.count}
                    </em>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sec-rail-foot">
          <div className="sec-rail-db">
            <div className="sec-rail-db-top">
              <span className="sec-rail-db-label">
                <i
                  className={`sec-rail-db-dot ${meta.advisory_count > 0 ? "ok" : "empty"}`}
                  aria-hidden
                />
                <b>{bi("本地漏洞库", "Local Advisory DB")}</b>
              </span>
              {meta.updated_at && (
                <span className="sec-rail-db-time num">
                  {ago(meta.updated_at)}
                </span>
              )}
            </div>
            <div className="sec-rail-db-meta num">
              {meta.advisory_count > 0
                ? bi(
                    `${meta.advisory_count} 条公告 · ${meta.source_mode === "offline-import" ? "离线包导入" : "在线同步"}`,
                    `${meta.advisory_count} advisories · ${meta.source_mode === "offline-import" ? "Offline bundle" : "Online sync"}`,
                  )
                : bi("尚未同步漏洞库", "Advisory DB empty")}
            </div>
            {canScan && (
              <div className="sec-rail-db-acts">
                <Button
                  size="mini"
                  icon={<IconSync />}
                  loading={syncing}
                  onClick={() => void runOnlineSync()}
                >
                  {bi("在线同步", "Sync")}
                </Button>
                <Button
                  size="mini"
                  icon={<IconUpload />}
                  loading={importing}
                  onClick={() => fileRef.current?.click()}
                >
                  {bi("导入离线库", "Import")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <div className="sec-main">
        <div className="sec-mobile-bar">
          <UnderlineTabs
            className="sec-tabs"
            label={bi("安全中心分区", "Security center views")}
            value={tab}
            onChange={(v) => switchTab(v as typeof tab)}
            items={flatNavItems.map((i) => ({
              value: i.value,
              label: i.label,
              count: i.count,
              icon: i.icon,
            }))}
          />
        </div>

        <div className="sec-main-inner">
          <header className="sec-main-head">
            <div className="sec-main-head-l">
              <div className="sec-main-title-row">
                <h1>{currentHead.title}</h1>
                <span
                  className={`sec-db-pill sec-mobile-pill ${meta.advisory_count > 0 ? "ok" : "empty"}`}
                >
                  {meta.advisory_count > 0
                    ? bi(
                        `本地库 ${meta.advisory_count} 条公告${meta.updated_at ? ` · ${ago(meta.updated_at)}` : ""}`,
                        `${meta.advisory_count} advisories${meta.updated_at ? ` · ${ago(meta.updated_at)}` : ""}`,
                      )
                    : bi("尚未同步漏洞库", "DB empty")}
                </span>
              </div>
              <p>{currentHead.desc}</p>
            </div>
            <div className="sec-main-head-r">
              {canScan && (
                <Button
                  type="primary"
                  icon={<IconRefresh />}
                  loading={scanning}
                  onClick={runScan}
                >
                  {bi("立即扫描", "Scan Now")}
                </Button>
              )}
              <Button icon={<IconDownload />} onClick={() => setExportOpen(true)}>
                {bi("导出报告", "Export Report")}
              </Button>
            </div>
          </header>

      {tab !== "db" && tab !== "reports" && rep && (
        <div className="sec-scope-bar">
          <div className="sec-scope-left">
            <span className="sec-scope-lbl">{bi("漏洞视角", "Risk Layer")}</span>
            <div className="sec-seg sec-scope-seg">
              {(
                [
                  ["all", bi("全部可见", "Visible"), rep.active_counts.total, false],
                  ["primary", bi("中间件本体", "Middleware"), mwCounts.total, false],
                  ["dependency", bi("OS 底层包", "OS Base"), osCounts.total, Boolean(policy.hide_os_cves)],
                  ["runtime", bi("运行环境", "Runtime"), rtCounts.total, Boolean(policy.hide_runtime_cves)],
                ] as const
              ).map(([v, lbl, cnt, shielded]) => (
                <button
                  key={v}
                  type="button"
                  className={`${roleFilter === v ? "on" : ""} scope-${v} ${shielded ? "is-shielded" : ""}`}
                  onClick={() => {
                    if (shielded && stateFilter !== "ignored") {
                      setRoleFilter("all");
                      setStateFilter("ignored");
                      if (tab !== "vulns") switchTab("vulns");
                    } else {
                      setRoleFilter(v);
                    }
                  }}
                  title={
                    shielded
                      ? bi("已按全局视角屏蔽且不计入打分，点击查看已屏蔽明细", "Globally hidden & excluded from scoring; click to inspect")
                      : undefined
                  }
                >
                  <span>{lbl}</span>
                  <em className="num">
                    {shielded ? bi("已屏蔽", "Hidden") : cnt}
                  </em>
                </button>
              ))}
            </div>
          </div>
          <div className="sec-scope-right">
            {canManage ? (
              <label
                className={`sec-shield-toggle ${policy.hide_os_cves ? "on" : ""}`}
                title={bi(
                  "开启后全平台隐藏 OS 底层系统库漏洞（openssl / python3 / systemd 等），且不计入集群打分与发布门禁",
                  "Globally hide OS base library CVEs across all views and exclude them from cluster scores & publish gates",
                )}
              >
                <Switch
                  size="small"
                  checked={Boolean(policy.hide_os_cves)}
                  disabled={policyBusy}
                  onChange={(v) => {
                    if (v && roleFilter === "dependency") setRoleFilter("all");
                    void savePolicy(
                      { ...policy, hide_os_cves: v },
                      v
                        ? bi("已全局屏蔽 OS 底层包漏洞（隐藏且不计入打分与门禁）", "OS base CVEs globally hidden & excluded from scoring")
                        : bi("已取消全局屏蔽 OS 底层包漏洞", "OS base CVEs restored"),
                    );
                  }}
                />
                <span>{bi("全局屏蔽 OS 漏洞", "Hide OS CVEs")}</span>
              </label>
            ) : (
              policy.hide_os_cves && (
                <span className="sec-shield-pill">
                  {bi("全局仅看中间件（OS 已屏蔽不计分）", "Global: Middleware only")}
                </span>
              )
            )}
            {suppressedCount > 0 && (
              <button
                type="button"
                className="sec-suppressed-pill num"
                onClick={() => {
                  setRoleFilter("all");
                  setStateFilter("ignored");
                  if (tab !== "vulns") switchTab("vulns");
                }}
              >
                {bi(
                  `已全局屏蔽 ${suppressedCount} 条（不计分）· 查看`,
                  `${suppressedCount} ignored (unscored) · View`,
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {tab === "overview" && (
        <div className="sec-content">
          {meta.advisory_count === 0 && (
            <div className="sec-onboard">
              <div className="sec-onboard-head">
                <IconExclamationCircleFill className="warn-ic" />
                <div>
                  <b>
                    {bi(
                      "首次使用：请先初始化本地 CVE 漏洞库（支持在线 / 纯离线双模式）",
                      "First-time setup: initialize the local CVE advisory database (Online or Air-gapped Offline)",
                    )}
                  </b>
                  <p>
                    {bi(
                      "漏洞库初始化后，所有扫描均在平台本地毫秒级完成（dpkg / rpm / PEP440 原生版本精准比对），无需每次联网。",
                      "Once initialized, all scans run deterministically offline in milliseconds with native dpkg/rpm/PEP440 version comparison.",
                    )}
                  </p>
                </div>
              </div>
              {canScan && (
                <div className="sec-onboard-cards">
                  <div className="sec-mode-card">
                    <b>{bi("模式一：在线一键同步 (OSV.dev)", "Mode 1: Online Sync (OSV.dev)")}</b>
                    <p>
                      {bi(
                        "联网环境直接按平台当前软件库与运行环境 SBOM 精准拉取 Ubuntu / Rocky / PyPI 安全公告并自动扫描。",
                        "Fetches official Ubuntu, Rocky, and PyPI advisories matching your platform SBOM and scans immediately.",
                      )}
                    </p>
                    <Button
                      type="primary"
                      size="small"
                      icon={<IconSync />}
                      loading={syncing}
                      onClick={runOnlineSync}
                    >
                      {bi("立即在线同步", "Sync Now")}
                    </Button>
                  </div>
                  <div className="sec-mode-card">
                    <b>{bi("模式二：离线漏洞库包导入（纯内网）", "Mode 2: Air-gapped Offline Bundle")}</b>
                    <p>
                      {bi(
                        "从有网环境导出带 SHA256SUMS 校验的 .tar.gz 离线漏洞库包（或 OSV JSON 文件），在此上传导入即可离线扫描。",
                        "Upload a SHA256-verified .tar.gz bundle exported from a connected instance, or standard OSV JSON files.",
                      )}
                    </p>
                    <Button
                      size="small"
                      icon={<IconUpload />}
                      loading={importing}
                      onClick={() => fileRef.current?.click()}
                    >
                      {bi("上传离线漏洞库包", "Upload Offline Bundle")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="sec-kpis">
            <button
              type="button"
              className="sec-kpi is-crit"
              onClick={() => {
                setSevFilter("CRITICAL");
                setStateFilter("active");
                switchTab("vulns");
              }}
            >
              <span>
                {roleFilter === "primary"
                  ? bi("中间件严重 (Critical)", "Middleware Critical")
                  : roleFilter === "dependency"
                    ? bi("OS 底层严重 (Critical)", "OS Base Critical")
                    : bi("未豁免严重 (Critical)", "Active Critical")}
              </span>
              <b className="num">{scopedActiveCounts.critical}</b>
              <small>
                {roleFilter === "all"
                  ? bi(
                      `中间件 ${mwCounts.critical} · OS 底层 ${osCounts.critical}${rtCounts.critical > 0 ? ` · 运行 ${rtCounts.critical}` : ""}`,
                      `MW ${mwCounts.critical} · OS ${osCounts.critical}`,
                    )
                  : bi(
                      `该分层活跃共 ${scopedActiveCounts.total} 条`,
                      `${scopedActiveCounts.total} active in layer`,
                    )}
              </small>
            </button>
            <button
              type="button"
              className="sec-kpi is-high"
              onClick={() => {
                setSevFilter("HIGH");
                setStateFilter("active");
                switchTab("vulns");
              }}
            >
              <span>
                {roleFilter === "primary"
                  ? bi("中间件高危 (High)", "Middleware High")
                  : roleFilter === "dependency"
                    ? bi("OS 底层高危 (High)", "OS Base High")
                    : bi("未豁免高危 (High)", "Active High")}
              </span>
              <b className="num">{scopedActiveCounts.high}</b>
              <small>
                {roleFilter === "all"
                  ? bi(
                      `中间件 ${mwCounts.high} · OS 底层 ${osCounts.high} · 运行 ${rtCounts.high}`,
                      `MW ${mwCounts.high} · OS ${osCounts.high} · RT ${rtCounts.high}`,
                    )
                  : bi(
                      `中危 ${scopedActiveCounts.medium} · 低危 ${scopedActiveCounts.low}`,
                      `Med ${scopedActiveCounts.medium} · Low ${scopedActiveCounts.low}`,
                    )}
              </small>
            </button>
            <button
              type="button"
              className="sec-kpi is-warn"
              onClick={() => switchTab("clusters")}
            >
              <span>
                {roleFilter === "primary"
                  ? bi("受影响集群（中间件）", "Clusters (Middleware)")
                  : roleFilter === "dependency"
                    ? bi("受影响集群（OS 底层）", "Clusters (OS Base)")
                    : bi("受影响生产集群", "Affected Clusters")}
              </span>
              <b className="num">
                {scopedAffectedClusters}
                <em> / {rep?.cluster_count ?? 0}</em>
              </b>
              <small>
                {roleFilter === "all" ? (
                  <span className="sec-kpi-meta">
                    <span>
                      {bi(
                        `中间件命中 ${rep?.middleware_affected_clusters ?? 0} 个`,
                        `MW ${rep?.middleware_affected_clusters ?? 0}`,
                      )}
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {bi(
                        `OS 底层命中 ${rep?.os_affected_clusters ?? 0} 个`,
                        `OS ${rep?.os_affected_clusters ?? 0} clusters`,
                      )}
                    </span>
                  </span>
                ) : (
                  bi("点击查看集群分层风险明细", "Click for cluster layer breakdown")
                )}
              </small>
            </button>
            <div className="sec-kpi">
              <span>{bi("已盘点资产包 (SBOM)", "Inventoried Packages")}</span>
              <b className="num">{rep?.sbom_package_count ?? 0}</b>
              <small>
                <span className="sec-kpi-meta">
                  <span>
                    {bi(
                      `闭包 ${rep?.closure_count ?? 0}`,
                      `Closures ${rep?.closure_count ?? 0}`,
                    )}
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    {bi(
                      `运行环境 ${rep?.runtime_count ?? 0}`,
                      `Runtimes ${rep?.runtime_count ?? 0}`,
                    )}
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    {bi(
                      `已缓解/豁免 ${rep?.waived_count ?? 0}`,
                      `Waived ${rep?.waived_count ?? 0}`,
                    )}
                  </span>
                </span>
              </small>
            </div>
          </div>

          {rep && (
            <div className="sec-layer-strip">
              <button
                type="button"
                className={`sec-layer-card is-mw ${roleFilter === "primary" ? "on" : ""}`}
                onClick={() =>
                  setRoleFilter(roleFilter === "primary" ? "all" : "primary")
                }
              >
                <div className="sec-layer-head">
                  <span className="sec-role-pill role-primary">
                    {bi("中间件本体", "Middleware")}
                  </span>
                  <b className="num">
                    {mwCounts.total} {bi("条活跃", "active")}
                  </b>
                </div>
                <div className="sec-layer-counts num">
                  <span className="sec-sev crit">C {mwCounts.critical}</span>
                  <span className="sec-sev high">H {mwCounts.high}</span>
                  <span className="sec-sev med">M {mwCounts.medium}</span>
                  <span className="faint small">
                    {bi(
                      `涉及 ${rep.middleware_affected_clusters ?? 0} 个集群`,
                      `${rep.middleware_affected_clusters ?? 0} clusters`,
                    )}
                  </span>
                </div>
                <small className="faint">
                  {bi(
                    "Nginx / Keepalived / HAProxy / PostgreSQL / Redis 等中间件自身，建议优先修复",
                    "Core middleware packages managed directly by the platform",
                  )}
                </small>
              </button>

              <div
                role="button"
                tabIndex={0}
                className={`sec-layer-card is-os ${roleFilter === "dependency" ? "on" : ""} ${policy.hide_os_cves ? "is-shielded" : ""}`}
                onClick={() => {
                  if (policy.hide_os_cves) {
                    setRoleFilter("all");
                    setStateFilter("ignored");
                    switchTab("vulns");
                  } else {
                    setRoleFilter(
                      roleFilter === "dependency" ? "all" : "dependency",
                    );
                  }
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (policy.hide_os_cves) {
                      setRoleFilter("all");
                      setStateFilter("ignored");
                      switchTab("vulns");
                    } else {
                      setRoleFilter(
                        roleFilter === "dependency" ? "all" : "dependency",
                      );
                    }
                  }
                }}
              >
                <div className="sec-layer-head">
                  <span className="sec-role-pill role-dependency">
                    {bi("OS 底层包", "OS Base")}
                  </span>
                  <div className="sec-layer-head-r">
                    {policy.hide_os_cves ? (
                      <span className="sec-shield-tag">
                        {bi("已全局屏蔽 · 不计分", "Shielded · Unscored")}
                      </span>
                    ) : (
                      <b className="num">
                        {osCounts.total} {bi("条活跃", "active")}
                      </b>
                    )}
                    {canManage && (
                      <button
                        type="button"
                        className="sec-layer-act"
                        disabled={policyBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          const nextHide = !policy.hide_os_cves;
                          if (nextHide && roleFilter === "dependency") setRoleFilter("all");
                          void savePolicy(
                            { ...policy, hide_os_cves: nextHide },
                            nextHide
                              ? bi("已全局屏蔽 OS 底层包漏洞（隐藏且不计入打分）", "OS base CVEs globally hidden")
                              : bi("已恢复显示 OS 底层包漏洞", "OS base CVEs restored"),
                          );
                        }}
                      >
                        {policy.hide_os_cves
                          ? bi("恢复显示", "Restore")
                          : bi("全局屏蔽", "Hide All")}
                      </button>
                    )}
                  </div>
                </div>
                {policy.hide_os_cves ? (
                  <div className="sec-layer-counts num">
                    <span className="faint small">
                      {bi(
                        `已隐藏 ${rawOSCounts.total} 条 OS 底层漏洞（不计入活跃统计、集群扣分与门禁）`,
                        `${rawOSCounts.total} OS base CVE(s) hidden & excluded from scoring/gates`,
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="sec-layer-counts num">
                    <span className="sec-sev crit">C {osCounts.critical}</span>
                    <span className="sec-sev high">H {osCounts.high}</span>
                    <span className="sec-sev med">M {osCounts.medium}</span>
                    <span className="faint small">
                      {bi(
                        `涉及 ${rep.os_affected_clusters ?? 0} 个集群`,
                        `${rep.os_affected_clusters ?? 0} clusters`,
                      )}
                    </span>
                  </div>
                )}
                <small className="faint">
                  {bi(
                    "OpenSSL / Python / Systemd / Libxml2 等操作系统公共库，可一键全局屏蔽或按单包忽略",
                    "OS shared libraries from closures; hide globally or ignore individual packages",
                  )}
                </small>
              </div>

              <div
                role="button"
                tabIndex={0}
                className={`sec-layer-card is-rt ${roleFilter === "runtime" ? "on" : ""} ${policy.hide_runtime_cves ? "is-shielded" : ""}`}
                onClick={() => {
                  if (policy.hide_runtime_cves) {
                    setRoleFilter("all");
                    setStateFilter("ignored");
                    switchTab("vulns");
                  } else {
                    setRoleFilter(roleFilter === "runtime" ? "all" : "runtime");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (policy.hide_runtime_cves) {
                      setRoleFilter("all");
                      setStateFilter("ignored");
                      switchTab("vulns");
                    } else {
                      setRoleFilter(roleFilter === "runtime" ? "all" : "runtime");
                    }
                  }
                }}
              >
                <div className="sec-layer-head">
                  <span className="sec-role-pill role-runtime">
                    {bi("运行环境", "Runtime")}
                  </span>
                  <div className="sec-layer-head-r">
                    {policy.hide_runtime_cves ? (
                      <span className="sec-shield-tag">
                        {bi("已全局屏蔽 · 不计分", "Shielded · Unscored")}
                      </span>
                    ) : (
                      <b className="num">
                        {rtCounts.total} {bi("条活跃", "active")}
                      </b>
                    )}
                    {canManage && (
                      <button
                        type="button"
                        className="sec-layer-act"
                        disabled={policyBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          const nextHide = !policy.hide_runtime_cves;
                          if (nextHide && roleFilter === "runtime") setRoleFilter("all");
                          void savePolicy(
                            { ...policy, hide_runtime_cves: nextHide },
                            nextHide
                              ? bi("已全局屏蔽运行环境依赖漏洞", "Runtime CVEs globally hidden")
                              : bi("已恢复显示运行环境漏洞", "Runtime CVEs restored"),
                          );
                        }}
                      >
                        {policy.hide_runtime_cves
                          ? bi("恢复显示", "Restore")
                          : bi("全局屏蔽", "Hide All")}
                      </button>
                    )}
                  </div>
                </div>
                {policy.hide_runtime_cves ? (
                  <div className="sec-layer-counts num">
                    <span className="faint small">
                      {bi(
                        `已隐藏 ${rawRTCounts.total} 条控制机运行环境漏洞（不计入活跃统计）`,
                        `${rawRTCounts.total} controller runtime CVE(s) hidden`,
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="sec-layer-counts num">
                    <span className="sec-sev crit">C {rtCounts.critical}</span>
                    <span className="sec-sev high">H {rtCounts.high}</span>
                    <span className="sec-sev med">M {rtCounts.medium}</span>
                    <span className="faint small">
                      {bi(`${rep.runtime_count} 套环境`, `${rep.runtime_count} runtimes`)}
                    </span>
                  </div>
                )}
                <small className="faint">
                  {bi(
                    "仅运行在部署控制机 / 执行节点的 Ansible 与 Python 依赖，不进入目标中间件主机",
                    "Controller-side Ansible/Python wheels; never deployed onto target nodes",
                  )}
                </small>
              </div>
            </div>
          )}

          {rep?.diff && (rep.diff.added_count > 0 || rep.diff.resolved_count > 0) && (
            <div className="sec-diff-bar">
              <b>{bi("较上次扫描变化：", "Since last scan: ")}</b>
              {rep.diff.added_count > 0 && (
                <span className="sec-diff-pill add">
                  +{rep.diff.added_count} {bi("新增活跃漏洞", "added")}
                </span>
              )}
              {rep.diff.resolved_count > 0 && (
                <span className="sec-diff-pill ok">
                  -{rep.diff.resolved_count} {bi("已修复或核销", "resolved")}
                </span>
              )}
              {rep.diff.added_critical_high && rep.diff.added_critical_high.length > 0 && (
                <span className="faint small mono">
                  {bi("新增严/高危：", "New C/H: ")}
                  {rep.diff.added_critical_high.slice(0, 4).join(" · ")}
                </span>
              )}
            </div>
          )}

          <section className="sec-card">
            <div className="sec-card-h">
              <div>
                <h2>{bi("优先修复包队列（按升级目标聚合）", "Priority Package Upgrade Queue")}</h2>
                <small className="faint">
                  {bi(
                    "已将同一软件包的多个 CVE 聚合为可执行升级项；点击「发起修复演练」可一键带入集群变更演练生成生产 SOP",
                    "Multiple CVEs on the same package are grouped into actionable upgrades; launch AI rehearsals directly to generate production SOPs",
                  )}
                </small>
              </div>
              {(rep?.findings?.length ?? 0) > 0 && (
                <Button size="small" onClick={() => switchTab("vulns")}>
                  {bi(
                    `查看全部 (${scopedActiveCounts.total} 条 / ${scopedActiveGroups.length} 个包)`,
                    `View All (${scopedActiveCounts.total})`,
                  )}
                </Button>
              )}
            </div>
            {!rep ? (
              <div className="sec-empty">
                <p>
                  {bi(
                    "尚未执行扫描，请先点击右上角「立即扫描」或「在线同步」。",
                    "No scan report yet. Click Scan Now or Online Sync above.",
                  )}
                </p>
              </div>
            ) : priorityGroups.length === 0 ? (
              <div className="sec-empty ok">
                <IconCheckCircleFill />
                <div>
                  <b>{bi("未发现未豁免的活跃 CVE 风险", "No active unwaived CVEs found")}</b>
                  <p>
                    {bi(
                      `上次扫描于 ${fullTime(rep.scanned_at)}（共盘点 ${rep.sbom_package_count} 个软件包，耗时 ${rep.duration_ms}ms）。`,
                      `Last scanned ${fullTime(rep.scanned_at)} (${rep.sbom_package_count} packages in ${rep.duration_ms}ms).`,
                    )}
                  </p>
                </div>
              </div>
            ) : (
              <div className="sec-pkg-table">
                <div className="sec-pkg-thead">
                  <span>{bi("软件包与层级", "Package & Layer")}</span>
                  <span>{bi("版本对照与修复", "Version & Fix")}</span>
                  <span>{bi("影响范围", "Impact")}</span>
                  <span style={{ textAlign: "right" }}>{bi("操作", "Actions")}</span>
                </div>
                {priorityGroups.map((g) => {
                  const targetFix = g.repo_fix_version || g.recommended_fix || "";
                  const eligibleClusters = (g.clusters || []).filter(
                    (cl) => cl.delivery_mode !== "configuration",
                  );
                  const isPrimaryEmph = g.pkg_role === "primary" && Boolean(targetFix);
                  return (
                    <div key={g.group_key} className="sec-pkg-tr">
                      {/* Col 1: Severity + Package + Layer + OS */}
                      <div className="sec-pkg-c1">
                        <div className="sec-pkg-title-line">
                          <span className={`sec-sev sec-sev-fixed ${sevClass(g.max_severity)}`}>
                            {sevLabel(g.max_severity)}
                            {g.max_cvss ? ` ${g.max_cvss.toFixed(1)}` : ""}
                          </span>
                          <b className="mono sec-grp-pkg" title={g.package}>{g.package}</b>
                        </div>
                        <div className="sec-pkg-sub-line">
                          <span className={`sec-role-pill role-${g.pkg_role}`}>
                            {pkgRoleLabel(g.pkg_role)}
                          </span>
                          {g.platform && g.platform !== "python" ? (
                            <span className="sec-mini-tag">
                              <OsLogo id={g.platform} size={12} />
                              <span>{platformShort(g.platform)}</span>
                            </span>
                          ) : (
                            <span className="sec-eco-tag">{g.ecosystem}</span>
                          )}
                        </div>
                      </div>

                      {/* Col 2: Version diff + Fix status + CVE gain */}
                      <div className="sec-pkg-c2">
                        {(() => {
                          const longVer =
                            (g.installed_version || "").length > 22 ||
                            (targetFix || "").length > 22;
                          return (
                            <div
                              className={`sec-ver-line mono${longVer ? " is-stack" : ""}`}
                            >
                              <span className="bad">{g.installed_version}</span>
                              {targetFix ? (
                                <span className="sec-ver-to">
                                  <span className="sec-ver-arrow">→</span>
                                  <span className="ok">{targetFix}</span>
                                </span>
                              ) : (
                                <span className="faint small">
                                  {bi("暂无上游修复版", "No upstream fix")}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                        <div className="sec-pkg-sub-line">
                          {targetFix && g.repo_fix_version && (
                            <span className="sec-repo-fix">
                              {bi("源已有修复版", "Fix in repo")}
                            </span>
                          )}
                          <span className="sec-grp-gain num">
                            {targetFix
                              ? bi(
                                  `一次升级可修 ${g.active_count} 个漏洞`,
                                  `1 upgrade resolves ${g.active_count} CVE(s)`,
                                )
                              : bi(`${g.active_count} 个活跃漏洞`, `${g.active_count} active CVE(s)`)}
                          </span>
                        </div>
                      </div>

                      {/* Col 3: Impact (clusters + components) */}
                      <div className="sec-pkg-c3">
                        <div className="sec-pkg-sub-line">
                          {(g.clusters || []).length > 0 ? (
                            <span className="sec-cl-pill bad num">
                              {bi(
                                `${g.clusters!.length} 个生产集群`,
                                `${g.clusters!.length} cluster(s)`,
                              )}
                            </span>
                          ) : (
                            <span className="faint small">{bi("仅软件库 / 运行环境", "Library / Runtime")}</span>
                          )}
                        </div>
                        {(g.components || []).length > 0 && (
                          <div className="sec-pkg-sub-line">
                            {(g.components || []).slice(0, 2).map((c) => (
                              <span
                                key={`${c.component}@${c.version}@${c.platform}`}
                                className="sec-mini-tag"
                              >
                                {c.title} {c.version}
                              </span>
                            ))}
                            {(g.components || []).length > 2 && (
                              <span className="faint small">+{g.components!.length - 2}</span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Col 4: Fixed 2-slot right-aligned actions */}
                      <div className="sec-pkg-acts">
                        {canRehearsalAI && eligibleClusters.length === 1 ? (
                          <Button
                            size="mini"
                            type={isPrimaryEmph ? "primary" : "secondary"}
                            className="sec-act-rehearse"
                            onClick={() =>
                              launchRehearsalForGroup(g, eligibleClusters[0])
                            }
                          >
                            <Spark size={11} />{" "}
                            {targetFix
                              ? bi("发起修复演练", "Rehearse Fix")
                              : bi("发起缓解演练", "Mitigate")}
                          </Button>
                        ) : canRehearsalAI && eligibleClusters.length > 1 ? (
                          <Dropdown
                            trigger="click"
                            position="br"
                            droplist={
                              <Menu
                                onClickMenuItem={(cid) => {
                                  const hit = eligibleClusters.find(
                                    (x) => x.cluster_id === cid,
                                  );
                                  if (hit) launchRehearsalForGroup(g, hit);
                                }}
                              >
                                {eligibleClusters.slice(0, 12).map((cl) => (
                                  <Menu.Item key={cl.cluster_id}>
                                    <span className="mono">{cl.cluster_id}</span>{" "}
                                    <span className="faint small">
                                      ({cl.app_name} {cl.version})
                                    </span>
                                  </Menu.Item>
                                ))}
                              </Menu>
                            }
                          >
                            <Button
                              size="mini"
                              type={isPrimaryEmph ? "primary" : "secondary"}
                              className="sec-act-rehearse"
                            >
                              <Spark size={11} /> {bi("选集群演练", "Pick Cluster")}
                            </Button>
                          </Dropdown>
                        ) : (
                          <span />
                        )}
                        <Button
                          size="mini"
                          type="text"
                          className="sec-act-link"
                          onClick={() => {
                            setQ(g.package);
                            setViewMode("grouped");
                            setExpandedGroups((p) => ({ ...p, [g.group_key]: true }));
                            switchTab("vulns", g.package);
                          }}
                        >
                          {bi("查看明细", "Inspect")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {tab === "vulns" && (
        <div className="sec-content">
          <div className="sec-filter-panel">
            <div className="sec-toolbar">
              <div className="sec-seg">
                <button
                  type="button"
                  className={viewMode === "grouped" ? "on" : ""}
                  onClick={() => setViewMode("grouped")}
                >
                  {bi(`按修复包聚合 (${filteredGroups.length})`, `By Package (${filteredGroups.length})`)}
                </button>
                <button
                  type="button"
                  className={viewMode === "list" ? "on" : ""}
                  onClick={() => setViewMode("list")}
                >
                  {bi(`按 CVE 明细 (${filteredFindings.length})`, `By CVE (${filteredFindings.length})`)}
                </button>
              </div>
              <Input
                allowClear
                prefix={<IconSearch />}
                style={{ width: 250 }}
                value={q}
                onChange={setQ}
                placeholder={bi(
                  "搜索 CVE、软件包、组件或集群...",
                  "Search CVE, package, component, cluster...",
                )}
              />
              <div className="sec-seg">
                {(
                  [
                    ["ALL", bi("全部等级", "All")],
                    ["CRITICAL", bi("严重", "Critical")],
                    ["HIGH", bi("高危", "High")],
                    ["MEDIUM", bi("中危", "Medium")],
                    ["LOW", bi("低危", "Low")],
                  ] as const
                ).map(([v, lbl]) => (
                  <button
                    key={v}
                    type="button"
                    className={sevFilter === v ? "on" : ""}
                    onClick={() => setSevFilter(v)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <div className="sec-seg">
                {(
                  [
                    ["active", bi("活跃未处置", "Active")],
                    ["all", bi("全部可见", "Visible")],
                    ["waived", bi("已缓解 / 豁免", "Waived")],
                    ...(suppressedCount > 0 || stateFilter === "ignored"
                      ? ([["ignored", bi(`已全局屏蔽 (${suppressedCount})`, `Ignored (${suppressedCount})`)]] as const)
                      : []),
                  ] as readonly (readonly ["active" | "all" | "waived" | "ignored", string])[]
                ).map(([v, lbl]) => (
                  <button
                    key={v}
                    type="button"
                    className={stateFilter === v ? "on" : ""}
                    onClick={() => setStateFilter(v)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            <div className="sec-toolbar sec-toolbar-facets">
              <Select
                size="small"
                style={{ width: 175 }}
                value={compFilter}
                onChange={(v) => {
                  setCompFilter(v);
                  setCompVerFilter("all");
                }}
                options={componentOptions}
              />
              {compVersionOptions.length > 0 && (
                <Select
                  size="small"
                  style={{ width: 135 }}
                  value={compVerFilter}
                  onChange={setCompVerFilter}
                  options={compVersionOptions}
                />
              )}
              <Select
                size="small"
                style={{ width: 155 }}
                value={osFilter}
                onChange={setOsFilter}
                options={osOptions}
              />
              <Select
                size="small"
                style={{ width: 145 }}
                value={fixFilter}
                onChange={(v) => setFixFilter(v)}
                options={[
                  { value: "all", label: bi("全部修复状态", "All Fix States") },
                  { value: "repo_ready", label: bi("源已有修复版", "Fix in Repo") },
                  { value: "cluster_only", label: bi("仅命中生产集群", "Production Clusters") },
                ]}
              />
              {hasAnyVulnFilter && (
                <Button size="mini" type="text" onClick={resetVulnFilters}>
                  {bi("重置筛选", "Reset")}
                </Button>
              )}
            </div>
          </div>

          {canManage && selectedCount > 0 && (
            <div className="sec-batch-bar">
              <span>
                {bi(
                  `已选择 ${selectedCount} 条漏洞记录`,
                  `${selectedCount} vulnerability record(s) selected`,
                )}
              </span>
              <div className="sec-batch-acts">
                <Button
                  size="small"
                  type="primary"
                  onClick={() => setBatchOpen(true)}
                >
                  {bi("批量 VEX 处置", "Batch VEX Triage")}
                </Button>
                <Button
                  size="small"
                  type="text"
                  onClick={() => setSelectedMap({})}
                >
                  {bi("清空选择", "Clear")}
                </Button>
              </div>
            </div>
          )}

          <section className="sec-card">
            {filteredFindings.length === 0 ? (
              <div className="sec-empty">
                <p>
                  {bi(
                    "没有符合当前筛选条件的 CVE 记录。",
                    "No CVE findings match the current filters.",
                  )}
                </p>
              </div>
            ) : viewMode === "grouped" ? (
              <div className="sec-pkg-table sec-vulns-table">
                <div className={`sec-pkg-thead ${canManage ? "has-chk" : ""}`}>
                  {canManage && (
                    <Checkbox
                      checked={
                        filteredFindings.length > 0 &&
                        filteredFindings.every((f) =>
                          Boolean(selectedMap[`${f.key}|${f.installed_version}`]),
                        )
                      }
                      indeterminate={
                        selectedCount > 0 &&
                        filteredFindings.some(
                          (f) => !selectedMap[`${f.key}|${f.installed_version}`],
                        )
                      }
                      onChange={(checked) => {
                        if (!checked) {
                          setSelectedMap({});
                          return;
                        }
                        const next: Record<string, SecFinding> = {};
                        for (const f of filteredFindings) {
                          next[`${f.key}|${f.installed_version}`] = f;
                        }
                        setSelectedMap(next);
                      }}
                    />
                  )}
                  <span>{bi("软件包与层级", "Package & Layer")}</span>
                  <span>{bi("版本对照与修复", "Version & Fix")}</span>
                  <span>{bi("受影响集群与组件", "Affected Clusters & Components")}</span>
                  <span style={{ textAlign: "right" }}>{bi("操作", "Actions")}</span>
                </div>
                {filteredGroups.map((g) => {
                  const expanded = Boolean(expandedGroups[g.group_key]);
                  const targetFix = g.repo_fix_version || g.recommended_fix || "";
                  const allSelected =
                    g.findings.length > 0 &&
                    g.findings.every(
                      (f) => Boolean(selectedMap[`${f.key}|${f.installed_version}`]),
                    );
                  const someSelected =
                    !allSelected &&
                    g.findings.some(
                      (f) => Boolean(selectedMap[`${f.key}|${f.installed_version}`]),
                    );
                  const eligibleClusters = (g.clusters || []).filter(
                    (cl) => cl.delivery_mode !== "configuration",
                  );
                  const isPrimaryEmph =
                    g.pkg_role === "primary" && g.active_count > 0 && Boolean(targetFix);
                  const isResolved = !g.globally_ignored && g.active_count === 0;
                  return (
                    <div
                      key={g.group_key}
                      className={`sec-grp-card ${isResolved ? "is-waived is-resolved" : g.active_count === 0 ? "is-waived" : ""}`}
                    >
                      <div className={`sec-pkg-tr ${canManage ? "has-chk" : ""}`}>
                        {canManage && (
                          <div className="sec-pkg-chk">
                            <Checkbox
                              checked={allSelected}
                              indeterminate={someSelected}
                              onChange={(checked) => toggleGroupSelect(g, checked)}
                            />
                          </div>
                        )}

                        {/* Col 1: Severity + Package + Layer + OS */}
                        <div className="sec-pkg-c1">
                          <div className="sec-pkg-title-line">
                            <span className={`sec-sev sec-sev-fixed ${isResolved ? "is-resolved" : sevClass(g.max_severity)}`}>
                              {sevLabel(g.max_severity)}
                              {g.max_cvss ? ` ${g.max_cvss.toFixed(1)}` : ""}
                            </span>
                            <b className="mono sec-grp-pkg" title={g.package}>{g.package}</b>
                          </div>
                          <div className="sec-pkg-sub-line">
                            <span className={`sec-role-pill role-${g.pkg_role}`}>
                              {pkgRoleLabel(g.pkg_role)}
                            </span>
                            {g.platform && g.platform !== "python" ? (
                              <span className="sec-mini-tag">
                                <OsLogo id={g.platform} size={12} />
                                <span>{platformShort(g.platform)}</span>
                              </span>
                            ) : (
                              <span className="sec-eco-tag">{g.ecosystem}</span>
                            )}
                          </div>
                        </div>

                        {/* Col 2: Version diff + Fix status + inline Library shortcut + CVE count */}
                        <div className="sec-pkg-c2">
                          {(() => {
                            const longVer =
                              (g.installed_version || "").length > 22 ||
                              (targetFix || "").length > 22;
                            return (
                              <div
                                className={`sec-ver-line mono${longVer ? " is-stack" : ""}`}
                              >
                                <span className={isResolved ? "muted-ver" : "bad"}>
                                  {g.installed_version}
                                </span>
                                {targetFix ? (
                                  <span className="sec-ver-to">
                                    <span className="sec-ver-arrow">→</span>
                                    <span className="ok">{targetFix}</span>
                                  </span>
                                ) : (
                                  <span className="faint small">
                                    {bi("暂无上游修复版（建议排查或缓解）", "No upstream fix yet")}
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                          {targetFix && g.repo_fix_version && (
                            <div className="sec-ver-badges">
                              <span className="sec-repo-fix">
                                {bi("源已有修复版", "Fix in repo")}
                              </span>
                              {g.platform &&
                                g.platform !== "python" &&
                                can("library.manage") && (
                                  <button
                                    type="button"
                                    className="sec-inline-lib-link"
                                    onClick={() => go({ name: "library", id: g.platform })}
                                  >
                                    {bi("软件库备包 ↗", "Library ↗")}
                                  </button>
                                )}
                            </div>
                          )}
                          <div className="sec-pkg-sub-line">
                            {g.globally_ignored ? (
                              <span className="sec-shield-tag" title={g.ignore_reason}>
                                {g.ignore_reason || bi("已全局屏蔽（不计入打分）", "Globally ignored (unscored)")}
                              </span>
                            ) : isResolved ? (
                              <span className="sec-resolved-tag">
                                <IconCheckCircleFill style={{ fontSize: 12 }} />
                                {bi(
                                  `全部 ${g.total_count} 条已处置 / 豁免`,
                                  `All ${g.total_count} triaged`,
                                )}
                              </span>
                            ) : (
                              <span className="sec-grp-gain num">
                                {targetFix
                                  ? bi(
                                      `一次升级可修 ${g.active_count} 个活跃漏洞`,
                                      `1 upgrade resolves ${g.active_count} active CVE(s)`,
                                    )
                                  : bi(
                                      `命中 ${g.active_count} 个活跃漏洞`,
                                      `${g.active_count} active CVE(s)`,
                                    )}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Col 3: Impacted clusters + components */}
                        <div className="sec-pkg-c3">
                          {(g.clusters || []).length > 0 ? (
                            <div className="sec-pkg-sub-line">
                              <span className={`sec-cl-pill ${isResolved ? "" : "bad"} num`}>
                                {bi(`${g.clusters!.length} 个集群`, `${g.clusters!.length} cluster(s)`)}
                              </span>
                              {g.clusters!.slice(0, 2).map((cl) => (
                                <a
                                  key={cl.cluster_id}
                                  href={`#/d/${encodeURIComponent(cl.cluster_id)}/security`}
                                  className="sec-link-chip mono"
                                >
                                  {cl.cluster_id}
                                </a>
                              ))}
                              {g.clusters!.length > 2 && (
                                <span className="faint small">+{g.clusters!.length - 2}</span>
                              )}
                            </div>
                          ) : (
                            <div className="sec-pkg-sub-line">
                              <span className="faint small">{bi("仅软件库 / 运行环境", "Library / Runtime")}</span>
                            </div>
                          )}
                          {(g.components || []).length > 0 && (
                            <div className="sec-pkg-sub-line">
                              {(g.components || []).slice(0, 2).map((c) => (
                                <span
                                  key={`${c.component}@${c.version}@${c.platform}`}
                                  className="sec-mini-tag"
                                >
                                  {c.title} {c.version}
                                </span>
                              ))}
                              {(g.components || []).length > 2 && (
                                <span className="faint small">+{g.components!.length - 2}</span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Col 4: Fixed right-aligned action slots */}
                        <div className={`sec-pkg-acts is-vulns ${canManage ? "can-ignore" : ""}`}>
                          {g.globally_ignored ? (
                            canManage &&
                            g.ignore_rule_id !== "layer:os" &&
                            g.ignore_rule_id !== "layer:runtime" ? (
                              <Button
                                size="mini"
                                type="outline"
                                className="sec-act-rehearse"
                                loading={policyBusy}
                                onClick={() => restoreIgnoredRule(g.ignore_rule_id, g.package)}
                              >
                                {bi("恢复显示", "Restore")}
                              </Button>
                            ) : (
                              <span />
                            )
                          ) : canRehearsalAI &&
                            g.active_count > 0 &&
                            eligibleClusters.length === 1 ? (
                            <Button
                              size="mini"
                              type={isPrimaryEmph ? "primary" : "secondary"}
                              className="sec-act-rehearse"
                              onClick={() =>
                                launchRehearsalForGroup(g, eligibleClusters[0])
                              }
                            >
                              <Spark size={11} />{" "}
                              {targetFix
                                ? bi("发起修复演练", "Rehearse Fix")
                                : bi("发起缓解演练", "Mitigate")}
                            </Button>
                          ) : canRehearsalAI &&
                            g.active_count > 0 &&
                            eligibleClusters.length > 1 ? (
                            <Dropdown
                              trigger="click"
                              position="br"
                              droplist={
                                <Menu
                                  onClickMenuItem={(cid) => {
                                    const hit = eligibleClusters.find(
                                      (x) => x.cluster_id === cid,
                                    );
                                    if (hit) launchRehearsalForGroup(g, hit);
                                  }}
                                >
                                  {eligibleClusters.slice(0, 15).map((cl) => (
                                    <Menu.Item key={cl.cluster_id}>
                                      <span className="mono">{cl.cluster_id}</span>{" "}
                                      <span className="faint small">
                                        ({cl.app_name} {cl.version})
                                      </span>
                                    </Menu.Item>
                                  ))}
                                </Menu>
                              }
                            >
                              <Button
                                size="mini"
                                type={isPrimaryEmph ? "primary" : "secondary"}
                                className="sec-act-rehearse"
                              >
                                <Spark size={11} /> {bi("选集群演练", "Pick Cluster")}
                              </Button>
                            </Dropdown>
                          ) : (
                            <span />
                          )}
                          {canManage &&
                            (!g.globally_ignored && g.active_count > 0 ? (
                              <Button
                                size="mini"
                                type="text"
                                className="sec-act-ignore"
                                title={bi(
                                  "全局忽略此软件包：隐藏所有 CVE 且不计入集群打分与门禁",
                                  "Globally ignore package: hide CVEs & exclude from scoring/gates",
                                )}
                                onClick={() => {
                                  setIgnoreTarget({
                                    pkg: g.package,
                                    ecoKey: g.eco_key,
                                    ecosystem: g.ecosystem,
                                    pkgRole: g.pkg_role,
                                    activeCount: g.active_count,
                                    clusterCount: g.clusters?.length || 0,
                                  });
                                  setIgnoreAllEco(true);
                                  setIgnoreNote(
                                    g.pkg_role === "dependency"
                                      ? bi("由操作系统补丁渠道统一维护，中间件视角忽略", "Managed via OS patching channel")
                                      : "",
                                  );
                                }}
                              >
                                {bi("忽略", "Ignore")}
                              </Button>
                            ) : (
                              <span />
                            ))}
                          <Button
                            size="mini"
                            type="text"
                            className="sec-act-expand num"
                            onClick={() =>
                              setExpandedGroups((p) => ({
                                ...p,
                                [g.group_key]: !p[g.group_key],
                              }))
                            }
                          >
                            <span>
                              {expanded
                                ? bi("收起明细", "Collapse")
                                : bi(`展开 ${g.total_count} 条`, `${g.total_count} CVE(s)`)}
                            </span>
                            {expanded ? (
                              <IconDown style={{ marginLeft: 3 }} />
                            ) : (
                              <IconRight style={{ marginLeft: 3 }} />
                            )}
                          </Button>
                        </div>
                      </div>

                      {expanded && (
                        <div className="sec-grp-sub">
                          <table className="sec-table sec-sub-table">
                            <tbody>
                              {g.findings.map((f) => {
                                const sid = `${f.key}|${f.installed_version}`;
                                return (
                                  <tr
                                    key={sid}
                                    className={f.waived ? "is-waived" : ""}
                                    onClick={() => setActiveFinding(f)}
                                  >
                                    {canManage && (
                                      <td
                                        style={{ width: 34 }}
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <Checkbox
                                          checked={Boolean(selectedMap[sid])}
                                          onChange={(checked) =>
                                            toggleFindingSelect(f, checked)
                                          }
                                        />
                                      </td>
                                    )}
                                    <td style={{ whiteSpace: "nowrap" }}>
                                      <div className="sec-cve-cell">
                                        <span className={`sec-sev ${sevClass(f.severity)}`}>
                                          {sevLabel(f.severity)}
                                          {f.cvss_score
                                            ? ` ${f.cvss_score.toFixed(1)}`
                                            : ""}
                                        </span>
                                        <b className="mono">{f.cve}</b>
                                      </div>
                                      {f.id !== f.cve && (
                                        <div className="faint small mono">{f.id}</div>
                                      )}
                                    </td>
                                    <td className="sec-sub-sum-cell">
                                      <div className="sec-cve-sub" title={f.summary || ""}>
                                        {f.summary || "—"}
                                      </div>
                                    </td>
                                    <td className="mono small sec-sub-fix-cell">
                                      {f.fixed_in?.length ? (
                                        <span className="ok">
                                          → {f.fixed_in[0]}
                                        </span>
                                      ) : (
                                        <span className="faint">
                                          {bi("待修复", "No fix")}
                                        </span>
                                      )}
                                    </td>
                                    <td style={{ whiteSpace: "nowrap" }}>
                                      <span
                                        className={`sec-tr-badge st-${f.triage_status}`}
                                      >
                                        {triageLabel(f.triage_status)}
                                      </span>
                                    </td>
                                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                                      <Button size="mini" type="text">
                                        {bi("详情与处置", "Inspect")}
                                      </Button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="sec-table-scroll">
                <table className="sec-table">
                  <thead>
                    <tr>
                      {canManage && <th style={{ width: 36 }} />}
                      <th>{bi("CVE / 等级", "CVE / Severity")}</th>
                      <th>{bi("软件包与修复对照", "Package & Fix")}</th>
                      <th>{bi("影响面", "Blast Radius")}</th>
                      <th>{bi("VEX 状态", "VEX Status")}</th>
                      <th style={{ textAlign: "right" }}>{bi("操作", "Action")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFindings.map((f) => {
                      const sid = `${f.key}|${f.installed_version}`;
                      return (
                        <tr
                          key={sid}
                          className={f.waived ? "is-waived" : ""}
                          onClick={() => setActiveFinding(f)}
                        >
                          {canManage && (
                            <td onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={Boolean(selectedMap[sid])}
                                onChange={(checked) =>
                                  toggleFindingSelect(f, checked)
                                }
                              />
                            </td>
                          )}
                          <td>
                            <div className="sec-cve-cell">
                              <span className={`sec-sev ${sevClass(f.severity)}`}>
                                {sevLabel(f.severity)}
                                {f.cvss_score ? ` ${f.cvss_score.toFixed(1)}` : ""}
                              </span>
                              <b className="mono">{f.cve}</b>
                            </div>
                            {f.summary && (
                              <div className="sec-cve-sub">{f.summary}</div>
                            )}
                          </td>
                          <td>
                            <div className="sec-pkg-cell">
                              <b className="mono">{f.package}</b>
                              <span className={`sec-role-pill role-${f.pkg_role || "dependency"}`}>
                                {pkgRoleLabel(f.pkg_role)}
                              </span>
                              <span className="sec-eco-tag">{f.ecosystem}</span>
                            </div>
                            <div className="sec-ver-line mono">
                              <span className="bad">{f.installed_version}</span>
                              {f.fixed_in?.length ? (
                                <>
                                  <span>→</span>
                                  <span className="ok">{f.fixed_in[0]}</span>
                                </>
                              ) : null}
                              {f.repo_fix_version && (
                                <span className="sec-repo-fix">
                                  {bi("源已有修复版", "Fix in repo")}
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            <div className="sec-br-inline">
                              {f.clusters && f.clusters.length > 0 ? (
                                <span className="sec-cl-pill bad">
                                  {bi(
                                    `${f.clusters.length} 个生产集群`,
                                    `${f.clusters.length} cluster(s)`,
                                  )}
                                </span>
                              ) : (
                                <span className="sec-cl-pill">
                                  {assetTypeLabel(f.asset_type)}
                                </span>
                              )}
                              {(f.components || []).slice(0, 2).map((c) => (
                                <span
                                  key={`${c.component}@${c.version}@${c.platform}`}
                                  className="sec-mini-tag"
                                >
                                  {c.title} {c.version}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td>
                            <span className={`sec-tr-badge st-${f.triage_status}`}>
                              {triageLabel(f.triage_status)}
                            </span>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <Button size="mini" type="text">
                              {bi("详情与处置", "Inspect")}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {tab === "clusters" && (
        <div className="sec-content">
          <section className="sec-card">
            <div className="sec-card-h">
              <div>
                <h2>{bi("已交付集群安全态势", "Delivered Cluster Security Posture")}</h2>
                <small className="faint">
                  {bi(
                    "严格遵循 IAM 数据范围，仅展示当前账号可见的已交付集群及其未豁免风险统计",
                    "Scoped to clusters visible to your IAM role with unwaived risk counts",
                  )}
                </small>
              </div>
            </div>
            {!rep || rep.clusters.length === 0 ? (
              <div className="sec-empty">
                <p>
                  {bi(
                    "暂无已交付集群记录，或尚未执行安全扫描。",
                    "No delivered clusters found or scan not run yet.",
                  )}
                </p>
              </div>
            ) : (
              <div className="sec-table-scroll">
              <table className="sec-table sec-table-clusters">
                <colgroup>
                  <col style={{ width: "21%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "19%" }} />
                  <col style={{ width: "17%" }} />
                  <col style={{ width: "27%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>{bi("集群", "Cluster")}</th>
                    <th>{bi("应用 / 系统", "App & OS")}</th>
                    <th>{bi("分层风险（中间件 / OS 底层）", "Risk by Layer (MW / OS)")}</th>
                    <th>{bi("主要高危 CVE", "Top CVEs")}</th>
                    <th style={{ textAlign: "right" }}>{bi("操作", "Actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rep.clusters.map((cl) => {
                    const mw = cl.middleware_active || emptyCounts;
                    const os = cl.os_active || emptyCounts;
                    const displayTop =
                      roleFilter === "primary"
                        ? cl.middleware_top_cves || []
                        : roleFilter === "dependency"
                          ? cl.os_top_cves || []
                          : cl.top_cves || [];
                    return (
                    <tr
                      key={cl.cluster_id}
                      className={
                        roleFilter === "primary" && mw.total === 0
                          ? "sec-cl-muted"
                          : roleFilter === "dependency" && os.total === 0
                            ? "sec-cl-muted"
                            : ""
                      }
                    >
                      <td className="sec-nowrap-col">
                        <div className="sec-cell-stack">
                          <b className="mono" title={cl.cluster_id}>{cl.cluster_id}</b>
                          <span className="faint small">
                            {cl.owner} · {cl.hosts.length} {bi("台主机", "host(s)")}
                          </span>
                        </div>
                      </td>
                      <td className="sec-nowrap-col">
                        <div className="sec-cell-stack">
                          <div className="sec-app-line">
                            <span>{cl.app_name}</span>
                            {cl.version && <span className="mono">{cl.version}</span>}
                          </div>
                          <span className="sec-mini-tag">
                            <OsLogo id={cl.platform} size={13} />
                            <span>{platformShort(cl.platform)}</span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="sec-cl-layers">
                          <div className={`sec-cl-layer-row ${roleFilter === "dependency" ? "is-dim" : ""}`}>
                            <span className="sec-role-pill role-primary sec-role-xs">
                              {bi("中间件", "MW")}
                            </span>
                            {mw.total === 0 ? (
                              <span className="sec-clean-pill small">
                                <IconCheckCircleFill />
                                {bi("无漏洞", "Clean")}
                              </span>
                            ) : (
                              <div className="sec-counts-row num">
                                {mw.critical > 0 && (
                                  <span className="sec-sev crit">C {mw.critical}</span>
                                )}
                                {mw.high > 0 && (
                                  <span className="sec-sev high">H {mw.high}</span>
                                )}
                                {mw.medium > 0 && (
                                  <span className="sec-sev med">M {mw.medium}</span>
                                )}
                                {mw.low > 0 && (
                                  <span className="sec-sev low">L {mw.low}</span>
                                )}
                                {mw.unknown > 0 && mw.critical === 0 && mw.high === 0 && mw.medium === 0 && mw.low === 0 && (
                                  <span className="sec-sev unk">? {mw.unknown}</span>
                                )}
                              </div>
                            )}
                          </div>
                          <div className={`sec-cl-layer-row ${roleFilter === "primary" || policy.hide_os_cves ? "is-dim" : ""}`}>
                            <span className="sec-role-pill role-dependency sec-role-xs">
                              {bi("OS 底层", "OS")}
                            </span>
                            {policy.hide_os_cves ? (
                              <span className="faint small">
                                {bi("已全局屏蔽", "Shielded")}
                              </span>
                            ) : os.total === 0 ? (
                              <span className="faint small">{bi("无", "None")}</span>
                            ) : (
                              <div className="sec-counts-row num">
                                {os.critical > 0 && (
                                  <span className="sec-sev crit">C {os.critical}</span>
                                )}
                                {os.high > 0 && (
                                  <span className="sec-sev high">H {os.high}</span>
                                )}
                                {os.medium > 0 && (
                                  <span className="sec-sev med">M {os.medium}</span>
                                )}
                                {os.low > 0 && (
                                  <span className="sec-sev low">L {os.low}</span>
                                )}
                                {os.unknown > 0 && (
                                  <span className="sec-sev unk">? {os.unknown}</span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="sec-chip-row sec-cl-cves">
                          {displayTop.slice(0, 2).map((id) => (
                            <span key={id} className="sec-plain-chip mono">
                              {id}
                            </span>
                          ))}
                          {displayTop.length > 2 && (
                            <span className="faint small">
                              +{displayTop.length - 2}
                            </span>
                          )}
                          {displayTop.length === 0 && (
                            <span className="faint small">—</span>
                          )}
                        </div>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <div className="sec-cl-acts">
                          {canRehearsalAI && cl.active.total > 0 && (
                            <button
                              type="button"
                              className="sec-cl-act-rh"
                              onClick={() =>
                                go({
                                  name: "deliveries",
                                  id: cl.cluster_id,
                                  tab: "rehearsal",
                                })
                              }
                            >
                              <Spark size={11} />
                              <span>{bi("修复演练", "Rehearse")}</span>
                            </button>
                          )}
                          <span className="sec-cl-act-links">
                            {cl.active.total > 0 && (
                              <>
                                <button
                                  type="button"
                                  className="sec-cl-act-link is-sub"
                                  onClick={() => {
                                    setSevFilter("ALL");
                                    setStateFilter("active");
                                    setCompFilter("all");
                                    setCompVerFilter("all");
                                    setFixFilter("cluster_only");
                                    switchTab("vulns", cl.cluster_id);
                                  }}
                                >
                                  {bi("筛选漏洞", "CVEs")}
                                </button>
                                <i className="sec-cl-act-sep" aria-hidden />
                              </>
                            )}
                            <button
                              type="button"
                              className="sec-cl-act-link is-main"
                              onClick={() =>
                                go({
                                  name: "deliveries",
                                  id: cl.cluster_id,
                                  tab: "security",
                                })
                              }
                            >
                              {bi("集群安全页", "Security")}
                            </button>
                          </span>
                        </div>
                      </td>
                    </tr>
                  );})}
                </tbody>
              </table>
              </div>
            )}
          </section>
        </div>
      )}

      {tab === "reports" && (
        <div className="sec-content">
          <SecReportTemplatesSection
            templates={reportTemplates}
            canManage={canManage}
            embeddedInCard={false}
            hideHeader
            onTemplatesChange={(next) =>
              setData((cur) => {
                if (!cur) return cur;
                const updated = { ...cur, report_templates: next };
                putCached("/api/security/overview", updated);
                return updated;
              })
            }
          />
        </div>
      )}

      {tab === "db" && (
        <div className="sec-content">
          <SecSourcesCard
            sources={sources}
            canScan={canScan}
            canManage={canManage}
            syncing={syncing}
            scanning={scanning}
            onSyncAll={() => void runOnlineSync()}
            onSyncOne={(sid) => runOnlineSync(sid)}
            onScanOnly={() => void runScan()}
            onSourcesChange={(next) =>
              setData((cur) => {
                if (!cur) return cur;
                const updated = { ...cur, sources: next };
                putCached("/api/security/overview", updated);
                return updated;
              })
            }
          />

          <div className="sec-db-grid">
            <section className="sec-card">
              <div className="sec-card-h">
                <div>
                  <h2>{bi("本地漏洞库缓存状态", "Local Advisory Cache")}</h2>
                  <small className="faint">
                    {bi(
                      "所有在线源同步与离线包导入的公告均去重合并至本地索引，日常漏洞扫描与发布门禁 100% 本地确定性运行。",
                      "All online feeds and offline imports merge into this local index; scans and publish gates run 100% locally.",
                    )}
                  </small>
                </div>
              </div>
              <div className="sec-db-meta-list">
                <div>
                  <span>{bi("库内公告总数", "Total Advisories")}</span>
                  <b className="num">{meta.advisory_count}</b>
                </div>
                <div>
                  <span>{bi("覆盖软件包数", "Packages Covered")}</span>
                  <b className="num">{meta.package_count}</b>
                </div>
                <div>
                  <span>{bi("最近更新", "Last Updated")}</span>
                  <b>
                    {meta.updated_at
                      ? `${fullTime(meta.updated_at)} (${meta.updated_by || "system"})`
                      : bi("尚未同步", "Never")}
                  </b>
                </div>
                <div className="sec-db-eco-row">
                  <div className="sec-db-eco-head">
                    <span>
                      {bi(
                        `已覆盖生态 (${meta.ecosystems.length})`,
                        `Ecosystems (${meta.ecosystems.length})`,
                      )}
                    </span>
                    {meta.ecosystems.length > 6 && (
                      <button
                        type="button"
                        className="sec-eco-toggle"
                        onClick={() => setEcoExpanded((v) => !v)}
                      >
                        {ecoExpanded
                          ? bi("收起", "Collapse")
                          : bi(`展开全部 (${meta.ecosystems.length})`, `Show all (${meta.ecosystems.length})`)}
                      </button>
                    )}
                  </div>
                  {meta.ecosystems.length > 0 ? (
                    <div className="sec-eco-chips">
                      {(ecoExpanded
                        ? meta.ecosystems
                        : meta.ecosystems.slice(0, 6)
                      ).map((eco) => (
                        <span key={eco} className="sec-eco-chip mono">
                          {eco}
                        </span>
                      ))}
                      {!ecoExpanded && meta.ecosystems.length > 6 && (
                        <button
                          type="button"
                          className="sec-eco-chip is-more num"
                          onClick={() => setEcoExpanded(true)}
                        >
                          +{meta.ecosystems.length - 6}
                        </button>
                      )}
                    </div>
                  ) : (
                    <b>—</b>
                  )}
                </div>
              </div>
            </section>

            <section className="sec-card">
              <div className="sec-card-h">
                <div>
                  <h2>
                    {bi("空气隔离 / 纯内网离线包", "Air-gapped Offline Bundle")}
                  </h2>
                  <small className="faint">
                    {bi(
                      "有网实例导出带 SHA256SUMS 完整性校验的 .tar.gz 离线包；内网实例上传导入（也支持标准 OSV JSON 文件）即可完成离线更新。",
                      "Export a SHA256-verified .tar.gz bundle from a connected node and import it into air-gapped networks (also accepts OSV JSON).",
                    )}
                  </small>
                </div>
              </div>
              {meta.bundle_sha256 && (
                <div className="sec-sha-box">
                  <span>{bi("最近导入包 SHA256：", "Last Imported SHA256: ")}</span>
                  <code className="mono">{meta.bundle_sha256.slice(0, 24)}…</code>
                </div>
              )}
              {canScan ? (
                <div className="sec-offline-box">
                  <label className="sec-scope-chk">
                    <Switch
                      size="small"
                      checked={replaceImport}
                      onChange={setReplaceImport}
                    />
                    <span>
                      {bi(
                        "导入时全量替换本地漏洞库（默认增量合并）",
                        "Replace existing local DB on import (default: incremental merge)",
                      )}
                    </span>
                  </label>
                  <div className="sec-db-acts">
                    <Button
                      icon={<IconUpload />}
                      type="primary"
                      loading={importing}
                      onClick={() => fileRef.current?.click()}
                    >
                      {bi("上传并导入离线漏洞库", "Import Offline Bundle")}
                    </Button>
                    <Button
                      icon={<IconCloudDownload />}
                      disabled={meta.advisory_count === 0}
                      onClick={() => {
                        window.location.href = "/api/security/db/export";
                      }}
                    >
                      {bi("导出离线漏洞库 (.tar.gz)", "Export Offline Bundle")}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="faint small">
                  {bi(
                    "需要「漏洞扫描与库同步」权限才能同步或导入漏洞库。",
                    "Requires Security Scan permission to sync or import advisory bundles.",
                  )}
                </p>
              )}
            </section>
          </div>

          <section className="sec-card">
            <div className="sec-card-h">
              <div>
                <h2>{bi("全局 CVE 视角与屏蔽 / 忽略规则", "Global CVE Perspective & Ignore Rules")}</h2>
                <small className="faint">
                  {bi(
                    "被全局屏蔽的层级或软件包将在安全中心、集群安全页与组件角标中默认隐藏，且不再计入集群安全打分与发布门禁；随时可一键恢复。",
                    "Globally shielded layers or packages are hidden by default across all pages and excluded from cluster scoring & publish gates.",
                  )}
                </small>
              </div>
              {suppressedCount > 0 && (
                <Button
                  size="small"
                  onClick={() => {
                    setRoleFilter("all");
                    setStateFilter("ignored");
                    switchTab("vulns");
                  }}
                >
                  {bi(`查看已屏蔽明细 (${suppressedCount})`, `Inspect Ignored (${suppressedCount})`)}
                </Button>
              )}
            </div>

            <div className="sec-pres-grid">
              {[
                {
                  id: "all",
                  active: !policy.hide_os_cves && !policy.hide_runtime_cves,
                  title: bi("全量视角", "Full Visibility"),
                  desc: bi(
                    "同时展示中间件本体、OS 底层系统库与控制机运行环境漏洞",
                    "Show Middleware, OS base libraries, and Controller runtime CVEs",
                  ),
                  apply: () =>
                    savePolicy(
                      { ...policy, hide_os_cves: false, hide_runtime_cves: false },
                      bi("已切换为全量视角", "Switched to Full Visibility"),
                    ),
                },
                {
                  id: "mw_no_os",
                  active: Boolean(policy.hide_os_cves) && !policy.hide_runtime_cves,
                  title: bi("聚焦中间件（屏蔽 OS 底层包）", "Middleware Focus (Hide OS)"),
                  desc: bi(
                    "全局隐藏 OpenSSL / Python / Systemd 等 OS 公共库漏洞且免扣分，仅关注中间件本体与运行环境",
                    "Hide OS base library CVEs globally and exclude from scoring & gates",
                  ),
                  apply: () =>
                    savePolicy(
                      { ...policy, hide_os_cves: true, hide_runtime_cves: false },
                      bi("已切换为聚焦中间件视角（OS 底层包全局屏蔽且不扣分）", "Switched to Middleware Focus (OS hidden)"),
                    ),
                },
                {
                  id: "mw_only",
                  active: Boolean(policy.hide_os_cves) && Boolean(policy.hide_runtime_cves),
                  title: bi("极简中间件视角（仅看中间件本体）", "Strict Middleware Only"),
                  desc: bi(
                    "同时屏蔽 OS 底层包与控制机运行环境依赖，全平台只呈现并计分中间件本体漏洞",
                    "Hide both OS base libs and controller runtime; show & score middleware only",
                  ),
                  apply: () =>
                    savePolicy(
                      { ...policy, hide_os_cves: true, hide_runtime_cves: true },
                      bi("已切换为极简中间件视角（仅看并计分中间件本体）", "Switched to Strict Middleware Only"),
                    ),
                },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={!canManage || policyBusy}
                  className={`sec-pres-card ${p.active ? "on" : ""}`}
                  onClick={() => void p.apply()}
                >
                  <div className="sec-pres-head">
                    <b>{p.title}</b>
                    {p.active && (
                      <span className="sec-pres-badge">
                        {bi("当前生效", "Active")}
                      </span>
                    )}
                  </div>
                  <small>{p.desc}</small>
                </button>
              ))}
            </div>

            <div className="sec-ignore-list-wrap">
              <div className="sec-ignore-subh">
                <b>
                  {bi(
                    `已全局忽略的软件包 (${ignoredRules.length})`,
                    `Globally Ignored Packages (${ignoredRules.length})`,
                  )}
                </b>
                <span className="faint small">
                  {bi(
                    "可在「漏洞清单」或「集群安全页」任意软件包行点击「忽略」添加",
                    "Click Ignore on any package row in Vulnerabilities or Cluster Security to add",
                  )}
                </span>
              </div>
              {ignoredRules.length === 0 ? (
                <div className="sec-ignore-empty">
                  {bi(
                    "暂未配置单包全局忽略规则。",
                    "No individual package ignore rules configured yet.",
                  )}
                </div>
              ) : (
                <div className="sec-table-scroll">
                  <table className="sec-table">
                    <thead>
                      <tr>
                        <th>{bi("软件包", "Package")}</th>
                        <th>{bi("生效生态", "Scope")}</th>
                        <th>{bi("忽略原因", "Reason")}</th>
                        <th>{bi("操作记录", "By / Time")}</th>
                        <th style={{ textAlign: "right" }}>{bi("操作", "Action")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ignoredRules.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <div className="sec-pkg-cell">
                              <b className="mono">{r.package}</b>
                              {r.pkg_role && (
                                <span className={`sec-role-pill role-${r.pkg_role}`}>
                                  {pkgRoleLabel(r.pkg_role)}
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            <span className="sec-eco-tag">
                              {!r.eco_key || r.eco_key === "*"
                                ? bi("全部系统生态", "All Ecosystems")
                                : r.ecosystem || r.eco_key}
                            </span>
                          </td>
                          <td className="faint small">{r.note || "—"}</td>
                          <td className="faint small num">
                            {r.by || "admin"} · {r.at ? ago(r.at) : "—"}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {canManage && (
                              <Button
                                size="mini"
                                type="outline"
                                loading={policyBusy}
                                onClick={() => void removeGlobalIgnore(r.id, r.package)}
                              >
                                {bi("恢复显示", "Restore")}
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="sec-card">
            <div className="sec-card-h">
              <div>
                <h2>{bi("安全门禁与告警策略", "Policy Gates & Alerting")}</h2>
                <small className="faint">
                  {bi(
                    "控制组件发布与交付环节的风险门禁及扫描告警行为；仅管理员 / 安全负责人可调整。",
                    "Controls release/delivery risk gates and scan alert notifications.",
                  )}
                </small>
              </div>
            </div>
            <div className="sec-policy-list">
              <div className="sec-policy-row">
                <div>
                  <b>
                    {bi(
                      "门禁、集群评分与告警仅统计中间件本体（忽略 OS 底层包）",
                      "Scope gates, cluster scoring & alerts to Middleware only (ignore OS base libs)",
                    )}
                  </b>
                  <small>
                    {bi(
                      "开启后，组件发布阻断门禁、集群安全扣分、组件风险角标及扫描通知仅针对中间件本体（如 Nginx / PostgreSQL / Redis / Keepalived / HAProxy），OS 底层依赖包（如 openssl / python3 / systemd）仍保留可见但不再触发阻断或扣分。",
                      "When enabled, publish blocks, cluster score deductions, badges, and alerts apply only to middleware packages; OS base library CVEs remain visible for reference without blocking.",
                    )}
                  </small>
                </div>
                <Switch
                  checked={Boolean(policy.gate_middleware_only)}
                  disabled={!canManage || policyBusy}
                  onChange={(v) =>
                    savePolicy({ ...policy, gate_middleware_only: v })
                  }
                />
              </div>
              <div className="sec-policy-row">
                <div>
                  <b>
                    {bi(
                      "组件发布时阻断未豁免的严重 (Critical) CVE",
                      "Block component publishing on unwaived Critical CVEs",
                    )}
                  </b>
                  <small>
                    {bi(
                      "开启后，若目标「版本 × 操作系统」命中未豁免的 Critical 漏洞，将拦截发布直至升级修复或在安全中心完成 VEX 评估豁免。",
                      "Blocks publishing a Version × OS if unwaived Critical CVEs exist until fixed or waived via VEX.",
                    )}
                  </small>
                </div>
                <Switch
                  checked={policy.block_publish_critical}
                  disabled={!canManage || policyBusy}
                  onChange={(v) =>
                    savePolicy({ ...policy, block_publish_critical: v })
                  }
                />
              </div>
              <div className="sec-policy-row">
                <div>
                  <b>
                    {bi(
                      "在组件详情页展示高危 / 严重安全风险角标",
                      "Show High/Critical risk badges on Component pages",
                    )}
                  </b>
                  <small>
                    {bi(
                      "在组件各版本与操作系统行直接透出当前活跃的严重/高危漏洞数量，点击直达安全中心筛选视图。",
                      "Displays clickable Critical/High CVE badges directly on each Version × OS row.",
                    )}
                  </small>
                </div>
                <Switch
                  checked={policy.warn_publish_high}
                  disabled={!canManage || policyBusy}
                  onChange={(v) =>
                    savePolicy({ ...policy, warn_publish_high: v })
                  }
                />
              </div>
              <div className="sec-policy-row">
                <div>
                  <b>
                    {bi(
                      "扫描发现影响生产集群的严重/高危漏洞时发送通知",
                      "Send alerts when scans find Critical/High CVEs on production clusters",
                    )}
                  </b>
                  <small>
                    {bi(
                      "通过「设置 → 通知渠道」中已启用的企微 / 钉钉 / 飞书 / Webhook 通道推送受影响集群清单。",
                      "Dispatches cluster impact alerts via enabled notification channels in Settings.",
                    )}
                  </small>
                </div>
                <Switch
                  checked={policy.notify_on_scan}
                  disabled={!canManage || policyBusy}
                  onChange={(v) => savePolicy({ ...policy, notify_on_scan: v })}
                />
              </div>
              <div className="sec-policy-row">
                <div>
                  <b>
                    {bi(
                      "新建正式交付确认时展示高危 / 严重漏洞风险提醒",
                      "Show Critical/High CVE warning during formal delivery creation",
                    )}
                  </b>
                  <small>
                    {bi(
                      "在交付向导提交前提示所选组件版本的未豁免严重/高危 CVE，不阻断紧急交付。",
                      "Displays non-blocking risk reminder for selected component versions before delivery generation.",
                    )}
                  </small>
                </div>
                <Switch
                  checked={policy.warn_delivery_critical}
                  disabled={!canManage || policyBusy}
                  onChange={(v) =>
                    savePolicy({ ...policy, warn_delivery_critical: v })
                  }
                />
              </div>
            </div>
          </section>

          {/* Supply-Chain Integrity Self-Check */}
          <section className="sec-card">
            <div className="sec-card-h">
              <div>
                <h2>
                  {bi("软件库与运行环境供应链完整性自检", "Software Library Supply-Chain Integrity")}
                </h2>
                <small className="faint">
                  {bi(
                    "校验各系统软件源 GPG 签名配置、已签名的软件源索引、离线包闭包文件完整性与 Ansible Wheel 校验覆盖率",
                    "Verifies OS repo GPG keys, signed index releases, offline closure file integrity, and Python wheel SHA256 coverage",
                  )}
                </small>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  size="small"
                  loading={supplyBusy}
                  onClick={() => void loadSupplyChain(false)}
                >
                  {bi("快速核查", "Quick Check")}
                </Button>
                <Button
                  size="small"
                  type="primary"
                  loading={supplyBusy}
                  onClick={() => void loadSupplyChain(true)}
                >
                  {bi("深度校验 SHA256", "Deep Verify SHA256")}
                </Button>
              </div>
            </div>
            {supplyChain ? (
              <div className="sec-supply-body">
                <div className="sec-supply-summary">
                  <span
                    className={`sec-clean-pill ${
                      supplyChain.overall_healthy ? "" : "is-bad"
                    }`}
                  >
                    {supplyChain.overall_healthy
                      ? bi("供应链完整性良好", "Supply Chain Healthy")
                      : bi(
                          `发现 ${supplyChain.total_issues} 项完整性异常`,
                          `${supplyChain.total_issues} Integrity Issue(s)`,
                        )}
                  </span>
                  <span className="faint small">
                    {bi(
                      `Ansible 运行环境 ${supplyChain.runtime_count} 个 · Wheel ${supplyChain.wheel_count} 个（SHA256 覆盖 ${supplyChain.wheel_sha256_count}/${supplyChain.wheel_count}）· 已设为默认平台 ${supplyChain.default_platforms} 个`,
                      `Ansible Runtimes: ${supplyChain.runtime_count} · Wheels: ${supplyChain.wheel_count} (SHA256 ${supplyChain.wheel_sha256_count}/${supplyChain.wheel_count})`,
                    )}
                  </span>
                </div>
                <div className="sec-table-scroll">
                  <table className="sec-table">
                    <thead>
                      <tr>
                        <th>{bi("操作系统平台", "OS Platform")}</th>
                        <th>{bi("GPG 签名源", "GPG Signed Sources")}</th>
                        <th>{bi("已签名索引 / 包数", "Signed Index")}</th>
                        <th>{bi("离线闭包文件完整性", "Closure Files")}</th>
                        <th>{bi("状态", "Status")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {supplyChain.platforms.map((sp) => (
                        <tr key={sp.platform}>
                          <td>
                            <span className="sec-mini-tag">
                              <OsLogo id={sp.platform} size={13} />
                              <span>{platformShort(sp.platform) || sp.title}</span>
                            </span>
                          </td>
                          <td className="num">
                            {sp.sources_signed}/{sp.sources_total}
                            {sp.unsigned_source_ids && sp.unsigned_source_ids.length > 0 && (
                              <div className="faint small">
                                {bi("未配置 GPG：", "Unsigned: ")}
                                {sp.unsigned_source_ids.join(", ")}
                              </div>
                            )}
                          </td>
                          <td className="num">
                            {sp.signed_releases} {bi("份签名", "signed")} · {sp.index_packages}{" "}
                            {bi("包", "pkgs")}
                            {sp.index_updated && (
                              <div className="faint small">{ago(sp.index_updated)}</div>
                            )}
                          </td>
                          <td className="num">
                            {sp.closures_total} {bi("闭包", "closures")} · {sp.files_total}{" "}
                            {bi("文件", "files")}
                            {(sp.files_missing > 0 || sp.files_hash_mismatch > 0) && (
                              <div className="bad small">
                                {bi(
                                  `缺失 ${sp.files_missing} / 校验异常 ${sp.files_hash_mismatch}`,
                                  `Missing ${sp.files_missing} / Mismatch ${sp.files_hash_mismatch}`,
                                )}
                              </div>
                            )}
                          </td>
                          <td>
                            <span
                              className={`sec-clean-pill ${sp.healthy ? "" : "is-bad"}`}
                            >
                              {sp.healthy
                                ? bi("正常", "Healthy")
                                : bi("需检查", "Needs Attention")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="sec-empty">
                <p>{bi("正在加载供应链自检状态…", "Loading supply-chain status...")}</p>
              </div>
            )}
          </section>

          {/* Scan History Trend (always rendered; falls back to current scan baseline if history not yet recorded) */}
          <section className="sec-card">
            <div className="sec-card-h">
              <div>
                <h2>{bi("扫描历史与变化趋势", "Scan History & Trend")}</h2>
                <small className="faint">
                  {bi("最近扫描快照记录，便于追踪漏洞新增与修复核销进度", "Recent scan snapshots tracking added vs resolved CVEs")}
                </small>
              </div>
            </div>
            {(() => {
              const rows: SecScanHistoryEntry[] =
                history.length > 0
                  ? history
                  : rep
                    ? [
                        {
                          scanned_at: rep.scanned_at,
                          scanned_by: rep.scanned_by,
                          db_advisory_count: rep.db_advisory_count,
                          sbom_package_count: rep.sbom_package_count,
                          affected_clusters: rep.affected_clusters,
                          active_counts: rep.active_counts,
                          waived_count: rep.waived_count,
                          added_count: rep.diff?.added_count ?? 0,
                          resolved_count: rep.diff?.resolved_count ?? 0,
                        },
                      ]
                    : [];
              if (rows.length === 0) {
                return (
                  <div className="sec-empty">
                    <p>
                      {bi(
                        "尚无扫描历史记录，点击右上角「立即扫描」后将自动记录每次扫描快照与增量变化。",
                        "No scan history yet. Run Scan Now to start tracking snapshots and diffs.",
                      )}
                    </p>
                  </div>
                );
              }
              return (
                <div className="sec-table-scroll">
                  <table className="sec-table">
                    <thead>
                      <tr>
                        <th>{bi("扫描时间", "Scanned At")}</th>
                        <th>{bi("触发人", "By")}</th>
                        <th>{bi("活跃风险 (严/高/中/低)", "Active (C/H/M/L)")}</th>
                        <th>{bi("较上次变化", "Diff")}</th>
                        <th>{bi("受影响集群", "Clusters")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 12).map((h, idx) => (
                        <tr key={`${h.scanned_at}-${idx}`}>
                          <td className="num">{fullTime(h.scanned_at)}</td>
                          <td>{h.scanned_by || "system"}</td>
                          <td className="num">
                            <div className="sec-counts-row">
                              <span className="sec-sev crit">C {h.active_counts.critical}</span>
                              <span className="sec-sev high">H {h.active_counts.high}</span>
                              <span className="sec-sev med">M {h.active_counts.medium}</span>
                              <span className="sec-sev low">L {h.active_counts.low}</span>
                            </div>
                          </td>
                          <td className="num">
                            {h.added_count === 0 && h.resolved_count === 0 ? (
                              <span className="faint">{bi("基线 / 无变化", "Baseline / No change")}</span>
                            ) : (
                              <div style={{ display: "flex", gap: 6 }}>
                                {h.added_count > 0 && (
                                  <span className="sec-diff-pill add">+{h.added_count}</span>
                                )}
                                {h.resolved_count > 0 && (
                                  <span className="sec-diff-pill ok">-{h.resolved_count}</span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="num">{h.affected_clusters}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </section>
        </div>
      )}

      <Modal
        visible={Boolean(ignoreTarget)}
        title={bi(
          `全局忽略软件包：${ignoreTarget?.pkg || ""}`,
          `Globally Ignore Package: ${ignoreTarget?.pkg || ""}`,
        )}
        onCancel={() => !ignoreBusy && setIgnoreTarget(null)}
        onOk={() => void submitGlobalIgnore()}
        confirmLoading={ignoreBusy}
        okText={bi("确认全局忽略", "Confirm Ignore")}
        cancelText={bi("取消", "Cancel")}
        style={{ width: 520, maxWidth: "94vw" }}
      >
        {ignoreTarget && (
          <div className="sec-ign-modal">
            <div className="sec-ign-ctx">
              <b className="mono">{ignoreTarget.pkg}</b>
              <span className={`sec-role-pill role-${ignoreTarget.pkgRole || "dependency"}`}>
                {pkgRoleLabel(ignoreTarget.pkgRole)}
              </span>
              <span className="faint small num">
                {bi(
                  `当前 ${ignoreTarget.activeCount} 条活跃 CVE · 涉及 ${ignoreTarget.clusterCount} 个集群`,
                  `${ignoreTarget.activeCount} active CVE(s) · ${ignoreTarget.clusterCount} cluster(s)`,
                )}
              </span>
            </div>
            <p className="sec-ign-tip">
              {bi(
                "忽略后，该软件包的所有 CVE 将在安全中心、集群安全页和组件风险角标中默认隐藏，且不再计入集群安全扣分与发布阻断门禁；随时可在「已全局屏蔽」或「漏洞源与门禁」中一键恢复。",
                "All CVEs for this package will be hidden by default across Security Center, Cluster Security, and Component badges, and excluded from cluster scores and publish gates. Restorable anytime.",
              )}
            </p>
            <div className="sec-ign-field">
              <label>{bi("生效范围", "Scope")}</label>
              <div className="sec-seg">
                <button
                  type="button"
                  className={ignoreAllEco ? "on" : ""}
                  onClick={() => setIgnoreAllEco(true)}
                >
                  {bi("全平台所有系统生态", "All Ecosystems")}
                </button>
                <button
                  type="button"
                  className={!ignoreAllEco ? "on" : ""}
                  onClick={() => setIgnoreAllEco(false)}
                >
                  {bi(`仅当前生态 (${ignoreTarget.ecosystem || ignoreTarget.ecoKey})`, `Only ${ignoreTarget.ecosystem || ignoreTarget.ecoKey}`)}
                </button>
              </div>
            </div>
            <div className="sec-ign-field">
              <label>{bi("忽略原因（可选，记入审计日志）", "Reason (optional, recorded in audit log)")}</label>
              <Input
                value={ignoreNote}
                onChange={setIgnoreNote}
                placeholder={bi(
                  "例如：由操作系统补丁渠道统一维护，中间件团队不重复追踪",
                  "e.g. Managed by OS patching team",
                )}
              />
              <div className="sec-ign-chips">
                {[
                  bi("由操作系统补丁渠道统一维护", "Managed by OS patching channel"),
                  bi("纯内网隔离环境不可触发", "Unreachable in air-gapped network"),
                  bi("仅依赖库打包未实际启用受影响模块", "Vulnerable module unused"),
                ].map((txt) => (
                  <button
                    key={txt}
                    type="button"
                    className="sec-ign-chip"
                    onClick={() => setIgnoreNote(txt)}
                  >
                    {txt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        visible={batchOpen}
        title={bi(`批量 VEX 处置（已选 ${selectedCount} 条）`, `Batch VEX Triage (${selectedCount})`)}
        onCancel={() => !batchBusy && setBatchOpen(false)}
        onOk={() => void submitBatchTriage()}
        confirmLoading={batchBusy}
        okText={bi("确认批量更新", "Apply Batch Triage")}
        cancelText={bi("取消", "Cancel")}
        style={{ width: 580, maxWidth: "94vw" }}
      >
        <VexTriageEditor
          context={{
            kind: "vex",
            cves: Object.values(selectedMap).map((f) => f.cve),
            package: Object.values(selectedMap)[0]?.package,
            ecosystem: Object.values(selectedMap)[0]?.ecosystem,
            pkg_role: Object.values(selectedMap)[0]?.pkg_role,
          }}
          status={batchStatus}
          onStatusChange={setBatchStatus}
          expires={batchExpires}
          onExpiresChange={setBatchExpires}
          note={batchNote}
          onNoteChange={setBatchNote}
          showContextCard={false}
          showJustification={false}
        />
      </Modal>

      <FindingDrawer
        finding={activeFinding}
        draftOverride={draftOverride}
        canManage={canManage}
        onClose={() => {
          setActiveFinding(null);
          setDraftOverride(null);
        }}
        onTriaged={(nextRep) => {
          setDraftOverride(null);
          if (nextRep) {
            setData((cur) => {
              if (!cur) return cur;
              const updated = { ...cur, report: nextRep };
              putCached("/api/security/overview", updated);
              return updated;
            });
            const refreshed = nextRep.findings.find(
              (x) =>
                activeFinding &&
                x.key === activeFinding.key &&
                x.installed_version === activeFinding.installed_version,
            );
            setActiveFinding(refreshed || null);
          }
        }}
      />
      <SecExportModal
        visible={exportOpen}
        onClose={() => setExportOpen(false)}
        templates={reportTemplates}
        defaultScope={roleFilter !== "all" ? roleFilter : undefined}
        onManageTemplates={() => switchTab("reports")}
      />
        </div>
      </div>
    </div>
    </AIDock>
  );
}

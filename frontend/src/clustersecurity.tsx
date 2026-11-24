import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Input,
  Message,
  Modal,
  Skeleton,
} from "@arco-design/web-react";
import {
  IconCheckCircleFill,
  IconDown,
  IconDownload,
  IconExclamationCircleFill,
  IconRefresh,
  IconRight,
  IconUp,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  can,
  err,
  platformShort,
  useAIStatus,
} from "./shared";
import type { ClusterView } from "./shared";
import { go } from "./router";
import { OsLogo } from "./oslogo";
import {
  SECURITY_CHANGED,
  Spark,
  VEX_OPEN_DRAFT,
  useAIDock,
  type VexProposal,
} from "./aichat";
import { launchSecurityRehearsalIntent } from "./rehearsal";
import { BaselineWaiveEditor, VexTriageEditor } from "./vextriage";
import { SecExportModal } from "./secreport";
import { bi, useLang } from "./i18n";
import "./security.css";
import "./clustersecurity.css";

/* ---------- types ---------- */

type SecSeverityCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  total: number;
};

type SecFinding = {
  key: string;
  id: string;
  cve: string;
  severity: string;
  cvss_score?: number;
  summary?: string;
  url?: string;
  ecosystem: string;
  eco_key: string;
  platform?: string;
  platform_title?: string;
  asset_type: string;
  pkg_role?: string;
  package: string;
  installed_version: string;
  fixed_in?: string[];
  repo_fix_version?: string;
  triage_status: string;
  triage_note?: string;
  triage_justification?: string;
  triage_expires?: string;
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
  finding_keys: string[];
  cves: string[];
};

type SecBaselineCheck = {
  id: string;
  category: string;
  title: string;
  severity: string;
  status: "pass" | "fail" | "warn" | "waived" | string;
  detail: string;
  recommendation?: string;
  target?: string;
  rehearsal_kind?: string;
  rehearsal_goal?: string;
  waived?: boolean;
  waive_note?: string;
  waive_by?: string;
  waive_at?: string;
};

type SecCertCheck = {
  instance: string;
  bundle: string;
  role: "server" | "ca" | string;
  subject: string;
  issuer: string;
  sans?: string[];
  not_before: string;
  not_after: string;
  days_left: number;
  key_algo: string;
  key_bits: number;
  sig_algo: string;
  is_self_signed?: boolean;
  status: "ok" | "expiring" | "critical" | "expired" | string;
};

type SecLinkedRehearsal = {
  id: string;
  title: string;
  stage: string;
  owner: string;
  doc_id?: string;
  updated_at: string;
  security_context?: {
    kind: string;
    cves?: string[];
    package?: string;
    current_version?: string;
    target_version?: string;
    vex_synced?: boolean;
    vex_status?: string;
  };
};

export type ClusterSecurityReport = {
  cluster_id: string;
  app_id: string;
  app_name: string;
  version: string;
  platform: string;
  delivery_mode: string;
  hosts: string[];
  scanned_at?: string;
  has_scan: boolean;
  score: number;
  grade: "A" | "B" | "C" | "D" | string;
  deductions: { reason: string; points: number }[];
  active_counts: SecSeverityCounts;
  total_counts: SecSeverityCounts;
  middleware_counts?: SecSeverityCounts;
  os_counts?: SecSeverityCounts;
  gate_middleware_only?: boolean;
  hide_os_cves?: boolean;
  hide_runtime_cves?: boolean;
  ignored_package_count?: number;
  suppressed_count?: number;
  suppressed_os_count?: number;
  suppressed_pkg_count?: number;
  primary_active: number;
  dependency_active: number;
  repo_fix_ready_count: number;
  findings: SecFinding[];
  package_groups: SecPackageGroup[];
  baseline_checks: SecBaselineCheck[];
  baseline_passed: number;
  baseline_total: number;
  certs: SecCertCheck[];
  cert_expiring: number;
  rehearsals: SecLinkedRehearsal[];
};

const SEV_LABEL: Record<string, () => string> = {
  CRITICAL: () => bi("严重", "Critical"),
  HIGH: () => bi("高危", "High"),
  MEDIUM: () => bi("中危", "Medium"),
  LOW: () => bi("低危", "Low"),
  UNKNOWN: () => bi("未知", "Unknown"),
};

const TRIAGE_LABEL: Record<string, () => string> = {
  open: () => bi("待评估", "Open"),
  planned: () => bi("计划修复", "Planned"),
  mitigated: () => bi("已缓解", "Mitigated"),
  not_affected: () => bi("不受影响", "Not affected"),
  accepted: () => bi("风险豁免", "Accepted"),
  expired: () => bi("豁免已过期", "Expired"),
};

const STAGE_LABEL: Record<string, () => string> = {
  scoping: () => bi("边界对齐", "Scoping"),
  probing: () => bi("现网探针", "Probing"),
  rehearsing: () => bi("测试演练", "Rehearsing"),
  finalized: () => bi("已定稿 SOP", "Finalized SOP"),
};

const secKeySlug = (raw: string) =>
  raw.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 96);

export function ClusterSecurityTab({
  c,
  canRehearse,
}: {
  c: ClusterView;
  canRehearse: boolean;
}) {
  useLang();
  const ai = useAIStatus();
  const dock = useAIDock();
  const canSecurityAI = Boolean(
    ai.enabled && ai.features?.security && dock?.available("sec:x"),
  );

  const [data, setData] = useState<ClusterSecurityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "primary" | "dependency">("all");
  const [stateFilter, setStateFilter] = useState<"active" | "waived" | "ignored" | "all">("active");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Global ignore package modal
  const [ignoreTarget, setIgnoreTarget] = useState<SecPackageGroup | null>(null);
  const [ignoreAllEco, setIgnoreAllEco] = useState(true);
  const [ignoreNote, setIgnoreNote] = useState("");
  const [ignoreBusy, setIgnoreBusy] = useState(false);

  // Baseline waive modal
  const [waiveTarget, setWaiveTarget] = useState<SecBaselineCheck | null>(null);
  const [waiveNote, setWaiveNote] = useState("");
  const [waiveBusy, setWaiveBusy] = useState(false);

  // Quick VEX modal
  const [vexFinding, setVexFinding] = useState<SecFinding | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [vexStatus, setVexStatus] = useState("mitigated");
  const [vexJust, setVexJust] = useState("");
  const [vexExpires, setVexExpires] = useState("");
  const [vexNote, setVexNote] = useState("");
  const [vexGlobal, setVexGlobal] = useState(false);
  const [vexBusy, setVexBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadErr("");
    try {
      const res = await api<ClusterSecurityReport>(
        `/api/clusters/${encodeURIComponent(c.id)}/security`,
      );
      setData(res);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [c.id]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Auto-reload when a VEX / baseline proposal card is accepted inside the bottom-right AI Assistant.
  useEffect(() => {
    const onSecChanged = () => void load();
    window.addEventListener(SECURITY_CHANGED, onSecChanged);
    return () => window.removeEventListener(SECURITY_CHANGED, onSecChanged);
  }, [load]);

  // Allow "Edit in Modal" on an AI VEX proposal card to prefill our VEX Triage modal.
  useEffect(() => {
    const onOpenDraft = (e: Event) => {
      const v = (e as CustomEvent<VexProposal>).detail;
      if (!v || !data) return;
      const targetCVE = (v.cve || v.cves?.[0] || "").toUpperCase();
      const hit =
        data.findings.find(
          (f) =>
            (f.cve.toUpperCase() === targetCVE || f.id.toUpperCase() === targetCVE) &&
            (!v.package || f.package.toLowerCase() === v.package.toLowerCase()),
        ) ||
        data.findings.find(
          (f) => f.cve.toUpperCase() === targetCVE || f.id.toUpperCase() === targetCVE,
        );
      if (!hit) return;
      setVexFinding(hit);
      setVexStatus(v.status || "mitigated");
      setVexJust(v.justification || "");
      setVexExpires(v.expires_at || "");
      setVexNote(v.note || "");
      setVexGlobal(Boolean(v.global));
    };
    window.addEventListener(VEX_OPEN_DRAFT, onOpenDraft);
    return () => window.removeEventListener(VEX_OPEN_DRAFT, onOpenDraft);
  }, [data]);

  const triggerScan = async () => {
    setScanning(true);
    try {
      await api("/api/security/scan", { method: "POST" });
      await load();
      Message.success(bi("安全扫描与集群审计已更新", "Security scan & cluster audit updated"));
    } catch (e) {
      err(e);
    } finally {
      setScanning(false);
    }
  };

  const launchPkgRehearsal = (g: SecPackageGroup) => {
    const targetVer = g.repo_fix_version || g.recommended_fix || "";
    const cveList = g.cves.slice(0, 6).join(", ");
    const title = targetVer
      ? bi(
          `安全修复：升级 ${g.package} 修复 ${g.active_count} 个 CVE`,
          `Security Patch: Upgrade ${g.package} (${g.active_count} CVEs)`,
        )
      : bi(
          `安全缓解：排查与加固 ${g.package} 漏洞`,
          `Security Mitigation: Harden ${g.package}`,
        );
    const goal = targetVer
      ? bi(
          `针对集群 ${c.id}（${c.app_name} ${c.version}），将软件包 ${g.package} 从 ${g.installed_version} 滚动升级至修复版本 ${targetVer}，一次性修复 ${g.active_count} 个活跃漏洞（${cveList}${g.cves.length > 6 ? " 等" : ""}）。请先通过只读探针核实现网真实已安装版本与受影响模块启用情况，再在测试环境演练无中断升级与回退方案。`,
          `Rolling upgrade ${g.package} from ${g.installed_version} to ${targetVer} on cluster ${c.id} (${c.app_name} ${c.version}) to resolve ${g.active_count} active CVE(s) (${cveList}). Probe actual installed versions and active modules first, then rehearse zero-downtime upgrade & rollback in staging.`,
        )
      : bi(
          `针对集群 ${c.id}（${c.app_name} ${c.version}）中软件包 ${g.package} ${g.installed_version} 的 ${g.active_count} 个活跃漏洞（${cveList}，暂无上游修复版本），先通过只读探针核实脆弱功能模块是否启用，并演练临时配置加固/网络隔离缓解方案。`,
          `Assess and mitigate ${g.active_count} active CVE(s) (${cveList}) on ${g.package} ${g.installed_version} for cluster ${c.id}. Probe whether vulnerable modules are enabled and rehearse config mitigation steps.`,
        );
    launchSecurityRehearsalIntent(c.id, {
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
  };

  const launchBaselineRehearsal = (ck: SecBaselineCheck) => {
    launchSecurityRehearsalIntent(c.id, {
      title: bi(`安全加固：${ck.title}`, `Security Hardening: ${ck.title}`),
      goal:
        ck.rehearsal_goal ||
        bi(
          `针对集群 ${c.id} 的配置安全基线不合规项「${ck.title}」（${ck.detail}）制定只读核查与测试环境加固演练方案。`,
          `Harden cluster ${c.id} for baseline check "${ck.title}": ${ck.detail}`,
        ),
      securityContext: {
        kind:
          ck.rehearsal_kind === "cert_rotation"
            ? "cert_rotation"
            : "config_hardening",
        baseline_check_ids: [ck.id],
      },
    });
  };

  const launchCertRehearsal = (cert: SecCertCheck) => {
    launchSecurityRehearsalIntent(c.id, {
      title: bi(
        `TLS 证书轮换：${cert.instance} (${cert.subject})`,
        `TLS Cert Rotation: ${cert.instance} (${cert.subject})`,
      ),
      goal: bi(
        `为集群 ${c.id} 的实例 ${cert.instance} 滚动轮换 TLS 服务器证书（主题：${cert.subject}，到期日：${cert.not_after}，剩余 ${cert.days_left} 天）。请先通过只读探针核实现网证书路径、到期时间与当前主从拓扑，再在测试环境演练无中断替换证书与热加载验证。`,
        `Zero-downtime TLS certificate rotation for ${cert.instance} on cluster ${c.id} (CN=${cert.subject}, expires ${cert.not_after}, ${cert.days_left} days left). Probe live cert paths and topology first, then rehearse hot reload in staging.`,
      ),
      securityContext: {
        kind: "cert_rotation",
        cert_target: `${cert.instance}/${cert.bundle} (${cert.subject}, 到期 ${cert.not_after})`,
      },
    });
  };

  const submitBaselineWaive = async (ck: SecBaselineCheck, waived: boolean, note: string) => {
    setWaiveBusy(true);
    try {
      const next = await api<ClusterSecurityReport>(
        `/api/clusters/${encodeURIComponent(c.id)}/security/baseline-waive`,
        {
          method: "POST",
          body: JSON.stringify({ check_id: ck.id, waived, note }),
        },
      );
      setData(next);
      setWaiveTarget(null);
      setWaiveNote("");
      Message.success(waived ? bi("已记录基线豁免", "Baseline check waived") : bi("已撤销豁免", "Waiver removed"));
    } catch (e) {
      err(e);
    } finally {
      setWaiveBusy(false);
    }
  };

  const submitQuickVex = async () => {
    if (!vexFinding) return;
    const needNote =
      vexStatus === "mitigated" ||
      vexStatus === "not_affected" ||
      vexStatus === "accepted";
    if (needNote && !vexNote.trim() && !vexJust) {
      Message.warning(
        bi(
          "标记已缓解、不受影响或风险豁免时请填写处置依据",
          "Please provide justification for mitigated/not_affected/accepted",
        ),
      );
      return;
    }
    setVexBusy(true);
    try {
      await api("/api/security/triage", {
        method: "POST",
        body: JSON.stringify({
          vuln_id: vexFinding.cve,
          package: vexFinding.package,
          ecosystem: vexFinding.ecosystem,
          global: vexGlobal,
          status: vexStatus,
          justification:
            vexStatus === "mitigated" || vexStatus === "not_affected"
              ? vexJust
              : "",
          expires_at: vexStatus === "accepted" ? vexExpires.trim() : "",
          note: vexNote.trim(),
        }),
      });
      Message.success(bi("已更新 VEX 状态", "VEX status updated"));
      setVexFinding(null);
      await load();
    } catch (e) {
      err(e);
    } finally {
      setVexBusy(false);
    }
  };

  const openAICVE = (f: SecFinding) => {
    if (!dock) return;
    const roleLabel =
      f.pkg_role === "primary"
        ? bi("中间件本体", "Middleware")
        : bi("OS 底层包", "OS Base");
    const fixText =
      f.repo_fix_version || f.fixed_in?.[0] || bi("暂无上游修复版", "no upstream fix yet");
    dock.open({
      key: `sec:${secKeySlug(`${f.cve}_${f.package}`)}`,
      title: bi(`安全研判：${f.cve}`, `Security: ${f.cve}`),
      context: `${c.id} · ${f.package} ${f.installed_version}`,
      step: {
        kind: "security_cve",
        title: `${f.cve}（${f.package}）`,
        cve: f.cve,
        finding_key: f.key,
        package: f.package,
        ecosystem: f.ecosystem,
        installed_version: f.installed_version,
        fixed_in: f.fixed_in,
        repo_fix_version: f.repo_fix_version,
        severity: f.severity,
        score: f.cvss_score,
        pkg_role: f.pkg_role,
        triage_status: f.triage_status,
        summary: f.summary,
        cluster_id: c.id,
      },
      prefill: bi(
        `请结合本集群（${c.id}）的真实配置与交付文件，研判漏洞 ${f.cve}（软件包 ${f.package} ${f.installed_version}，${roleLabel}，严重等级 ${f.severity}，修复版 ${fixText}）：\n1. 说明漏洞原理与触发条件；\n2. 核对本集群真实配置判断实际可利用性；\n3. 给出短期缓解/只读排查或升级建议；\n4. 如结论明确，请在下方直接输出可一键采纳的 VEX 处置提案卡片（或修复演练建议卡片）。`,
        `Assess ${f.cve} (${f.package} ${f.installed_version}, ${roleLabel}, ${f.severity}, fix: ${fixText}) against cluster ${c.id}'s real configs: explain the vulnerability, check real exploitability, suggest mitigation/upgrade, and propose a one-click VEX triage or rehearsal card if clear.`,
      ),
      prefillIfEmpty: true,
    });
  };

  const openAIPackage = (g: SecPackageGroup) => {
    if (!dock) return;
    const fixTarget = g.repo_fix_version || g.recommended_fix || bi("暂无修复版", "none");
    const roleLabel =
      g.pkg_role === "primary"
        ? bi("中间件本体", "Middleware")
        : bi("OS 底层包", "OS Base");
    dock.open({
      key: `sec:${secKeySlug(`pkg_${g.package}`)}`,
      title: bi(`包风险评估：${g.package}`, `Package Risk: ${g.package}`),
      context: `${c.id} · ${g.package} ${g.installed_version}`,
      step: {
        kind: "security_pkg",
        title: `${g.package}（${g.active_count} 活跃漏洞）`,
        package: g.package,
        ecosystem: g.ecosystem,
        installed_version: g.installed_version,
        fixed_in: fixTarget ? [fixTarget] : [],
        severity: g.max_severity,
        pkg_role: g.pkg_role,
        cves: g.cves,
        cluster_id: c.id,
      },
      prefill: bi(
        `请综合评估本集群（${c.id}）中的软件包 ${g.package}（${roleLabel}，当前版本 ${g.installed_version}，修复版本 ${fixTarget}，涉及 ${g.active_count} 条活跃 CVE：${g.cves.slice(0, 6).join(", ")}），判断应当安排补丁升级演练还是批量 VEX 处置，并在下方给出对应提案卡片。`,
        `Evaluate package ${g.package} (${roleLabel}, ${g.installed_version}, fix: ${fixTarget}, ${g.active_count} active CVEs) on cluster ${c.id}: recommend patch upgrade rehearsal vs batch VEX triage and emit an actionable proposal card.`,
      ),
      prefillIfEmpty: true,
    });
  };

  const openAIBaseline = (ck: SecBaselineCheck) => {
    if (!dock) return;
    dock.open({
      key: `sec:${secKeySlug(`base_${ck.id}`)}`,
      title: bi(`基线研判：${ck.title}`, `Baseline: ${ck.title}`),
      context: `${c.id} · ${bi("配置安全基线", "Config Baseline")}`,
      step: {
        kind: "security_baseline",
        title: ck.title,
        check_id: ck.id,
        severity: ck.severity,
        status: ck.status,
        detail: ck.detail,
        recommendation: ck.recommendation,
        cluster_id: c.id,
      },
      prefill: bi(
        `请研判本集群（${c.id}）未通过的配置安全基线「${ck.title}」（${ck.detail}）：结合本集群交付配置，评估实际安全影响，给出加固建议或（如适合内网隔离豁免）直接生成配置基线豁免提案卡片。`,
        `Assess failed config baseline "${ck.title}" (${ck.detail}) on cluster ${c.id}: evaluate real impact against cluster configs and suggest hardening or a baseline waiver card if appropriate.`,
      ),
      prefillIfEmpty: true,
    });
  };

  const openAIOverview = () => {
    if (!dock) return;
    dock.open({
      key: "sec:overview",
      title: bi("集群安全 AI 助手", "Cluster Security AI"),
      context: `${c.id} · ${data?.app_name || c.app_name}`,
    });
  };

  const findingsByGroup = useMemo(() => {
    const m: Record<string, SecFinding[]> = {};
    if (!data) return m;
    for (const f of data.findings) {
      const gk = `${f.eco_key}|${f.package.toLowerCase()}|${f.installed_version}|${f.platform || ""}`;
      if (!m[gk]) m[gk] = [];
      m[gk].push(f);
    }
    return m;
  }, [data]);

  const submitGlobalIgnore = async () => {
    if (!ignoreTarget) return;
    setIgnoreBusy(true);
    try {
      await api("/api/security/ignores", {
        method: "POST",
        body: JSON.stringify({
          package: ignoreTarget.package,
          eco_key: ignoreAllEco ? "*" : ignoreTarget.eco_key,
          ecosystem: ignoreAllEco ? "" : ignoreTarget.ecosystem,
          all_ecosystems: ignoreAllEco,
          pkg_role: ignoreTarget.pkg_role,
          note: ignoreNote.trim(),
        }),
      });
      await load();
      window.dispatchEvent(new Event(SECURITY_CHANGED));
      Message.success(
        bi(
          `已全局忽略 ${ignoreTarget.package}：不再展示且已免除集群扣分`,
          `Globally ignored ${ignoreTarget.package} (hidden & unscored)`,
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

  const restoreIgnoredGroup = async (g: SecPackageGroup) => {
    const rid = g.ignore_rule_id;
    if (!rid) return;
    setIgnoreBusy(true);
    try {
      if (rid === "layer:os" || rid === "layer:runtime") {
        const ov = await api<{ policy: Record<string, unknown> }>("/api/security/overview");
        const nextPol = {
          ...ov.policy,
          ...(rid === "layer:os" ? { hide_os_cves: false } : { hide_runtime_cves: false }),
        };
        await api("/api/security/policy", {
          method: "PUT",
          body: JSON.stringify(nextPol),
        });
      } else {
        await api(`/api/security/ignores/${encodeURIComponent(rid)}`, {
          method: "DELETE",
        });
      }
      await load();
      window.dispatchEvent(new Event(SECURITY_CHANGED));
      Message.success(bi(`已恢复显示 ${g.package}`, `Restored ${g.package}`));
    } catch (e) {
      err(e);
    } finally {
      setIgnoreBusy(false);
    }
  };

  const isHiddenGroup = useCallback(
    (g: SecPackageGroup) =>
      Boolean(g.globally_ignored || (data?.hide_os_cves && g.pkg_role !== "primary")),
    [data?.hide_os_cves],
  );

  const statusCounts = useMemo(() => {
    const out = { active: 0, waived: 0, ignored: 0, all: 0 };
    if (!data) return out;
    for (const g of data.package_groups) {
      if (roleFilter === "primary" && g.pkg_role !== "primary") continue;
      if (roleFilter === "dependency" && g.pkg_role === "primary") continue;
      if (isHiddenGroup(g)) {
        out.ignored += g.total_count;
      } else {
        out.active += g.active_count;
        out.waived += g.waived_count;
      }
    }
    if (roleFilter === "all") {
      out.ignored = Math.max(out.ignored, data.suppressed_count || 0);
    }
    out.all = out.active + out.waived + out.ignored;
    return out;
  }, [data, roleFilter, isHiddenGroup]);

  const filteredGroups = useMemo(() => {
    if (!data) return [];
    const list = data.package_groups.filter((g) => {
      if (roleFilter === "primary" && g.pkg_role !== "primary") return false;
      if (roleFilter === "dependency" && g.pkg_role === "primary") return false;
      const hidden = isHiddenGroup(g);
      switch (stateFilter) {
        case "ignored":
          return hidden;
        case "active":
          return !hidden && g.active_count > 0;
        case "waived":
          return !hidden && g.waived_count > 0;
        default:
          return true;
      }
    });
    if (stateFilter === "all") {
      return [...list].sort(
        (a, b) => Number(isHiddenGroup(a)) - Number(isHiddenGroup(b)),
      );
    }
    return list;
  }, [data, roleFilter, stateFilter, isHiddenGroup]);

  if (loading && !data) {
    return (
      <div className="csec">
        <Skeleton text={{ rows: 6 }} animation />
      </div>
    );
  }

  if (loadErr && !data) {
    return (
      <div className="csec">
        <div className="csec-section">
          <div className="csec-empty">
            {loadErr}{" "}
            <Button size="mini" onClick={() => void load()}>
              {bi("重试", "Retry")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const baseFailCount = data.baseline_checks.filter(
    (x) => x.status === "fail" || x.status === "warn",
  ).length;

  return (
    <div className="csec">
      {/* Top Security Posture Hero */}
      <div className="csec-hero">
        <div className="csec-hero-top">
          <div className="csec-hero-left">
            <div className={`csec-score-ring g-${data.grade}`}>
              <span className="csec-score-num">{data.score}</span>
              <span className="csec-score-grade">
                {bi(`${data.grade} 级`, `Grade ${data.grade}`)}
              </span>
            </div>
            <div className="csec-hero-info">
              <div className="csec-hero-title">
                <h3>{bi("集群安全态势评估", "Cluster Security Posture")}</h3>
                {data.hide_os_cves ? (
                  <span className="sec-shield-tag">
                    {bi("全局视角：已屏蔽 OS 底层包（隐藏且不扣分）", "Global: OS CVEs hidden & unscored")}
                  </span>
                ) : (
                  data.gate_middleware_only && (
                    <span className="sec-mini-tag">
                      {bi("计分口径：仅中间件本体（OS 底层包不扣分）", "Scoring: Middleware only")}
                    </span>
                  )
                )}
                {(data.suppressed_count || 0) > 0 && (
                  <span className="sec-mini-tag num">
                    {bi(
                      `已屏蔽 ${data.suppressed_count} 条（不计分）`,
                      `${data.suppressed_count} ignored (unscored)`,
                    )}
                  </span>
                )}
                {data.scanned_at ? (
                  <span className="faint small">
                    {bi(
                      `最近扫描 ${ago(data.scanned_at)}`,
                      `Last scanned ${ago(data.scanned_at)}`,
                    )}
                  </span>
                ) : (
                  <span className="faint small">
                    {bi("尚未执行 CVE 漏洞扫描", "No CVE scan yet")}
                  </span>
                )}
              </div>
              <span className="faint small">
                {bi(
                  `${data.app_name} ${data.version} · ${data.hosts.length} 台节点 · 综合 CVE 漏洞、配置基线与证书健康度评估`,
                  `${data.app_name} ${data.version} · ${data.hosts.length} host(s) · Composite CVE, baseline & cert score`,
                )}
              </span>
            </div>
          </div>
          <div className="csec-hero-actions">
            {canSecurityAI && (
              <Button
                size="small"
                shape="round"
                className="ai-pill"
                icon={<Spark size={13} rainbow />}
                onClick={openAIOverview}
              >
                {bi("AI 安全顾问", "Security AI")}
              </Button>
            )}
            {can("security.scan") && (
              <Button
                size="small"
                icon={<IconRefresh />}
                loading={scanning}
                onClick={() => void triggerScan()}
              >
                {bi("重新扫描", "Rescan")}
              </Button>
            )}
            {can("security.view") && (
              <Button
                size="small"
                icon={<IconDownload />}
                onClick={() => setExportOpen(true)}
              >
                {bi("导出安全报告", "Export Report")}
              </Button>
            )}
            {can("security.view") && (
              <Button
                size="small"
                type="text"
                onClick={() => go({ name: "security", tab: "vulns", q: c.id })}
              >
                {bi("全局安全中心", "Security Center")} <IconRight />
              </Button>
            )}
          </div>
        </div>
        <div className="csec-deducts">
          {data.deductions.length === 0 ? (
            <span className="csec-deduct-ok">
              <IconCheckCircleFill style={{ marginRight: 4 }} />
              {baseFailCount > 0
                ? bi(
                    `无扣分项：未发现活跃中高危漏洞或证书到期风险（另有 ${baseFailCount} 项基线加固建议不扣分，详见下方基线审计）`,
                    `No deductions: no active critical/high CVEs or expiring certs (${baseFailCount} non-deducting baseline advisory item(s) below)`,
                  )
                : bi(
                    "无扣分项：未发现活跃中高危漏洞、配置基线违规或证书到期风险",
                    "All clear: no active critical/high CVEs, baseline failures, or expiring certs",
                  )}
            </span>
          ) : (
            data.deductions.map((d, i) => (
              <span key={i} className="csec-deduct-pill">
                -{d.points} · {d.reason}
              </span>
            ))
          )}
        </div>
      </div>

      {/* 4 KPI Summary Tiles */}
      <div className="csec-kpis">
        <div className="csec-kpi">
          <span className="csec-kpi-lbl">{bi("活跃软件漏洞", "Active CVEs")}</span>
          <span
            className={`csec-kpi-val ${
              data.active_counts.critical > 0
                ? "danger"
                : data.active_counts.high > 0
                  ? "warn"
                  : "ok"
            }`}
          >
            {data.active_counts.total}
          </span>
          <span className="csec-kpi-sub">
            <span className="csec-kpi-seg">
              {bi(`中间件本体 ${data.primary_active}`, `Middleware ${data.primary_active}`)}
            </span>
            {" · "}
            <span className="csec-kpi-seg">
              {bi(`OS 底层包 ${data.dependency_active}`, `OS Base ${data.dependency_active}`)}
            </span>
            {(data.suppressed_count || 0) > 0 && (
              <>
                {" · "}
                <span className="csec-kpi-seg">
                  {bi(`已屏蔽 ${data.suppressed_count} 条`, `${data.suppressed_count} ignored`)}
                </span>
              </>
            )}
            {data.repo_fix_ready_count > 0 && (
              <>
                {" · "}
                <span className="csec-kpi-seg">
                  {bi(
                    `${data.repo_fix_ready_count} 个包源已有修复`,
                    `${data.repo_fix_ready_count} fix(es) in repo`,
                  )}
                </span>
              </>
            )}
          </span>
        </div>

        <div className="csec-kpi">
          <span className="csec-kpi-lbl">{bi("配置安全基线", "Config Baseline")}</span>
          <span
            className={`csec-kpi-val ${
              baseFailCount > 0 ? "warn" : "ok"
            }`}
          >
            {data.baseline_passed}/{data.baseline_total}
          </span>
          <span className="csec-kpi-sub">
            {baseFailCount > 0
              ? bi(`${baseFailCount} 项待加固或豁免`, `${baseFailCount} need hardening/waiver`)
              : bi("全部通过基线审计", "All baseline checks passed")}
          </span>
        </div>

        <div className="csec-kpi">
          <span className="csec-kpi-lbl">{bi("TLS 证书巡检", "TLS Certificates")}</span>
          <span
            className={`csec-kpi-val ${
              data.cert_expiring > 0 ? "danger" : data.certs.length > 0 ? "ok" : ""
            }`}
          >
            {data.certs.length > 0
              ? data.cert_expiring > 0
                ? bi(`${data.cert_expiring} 份预警`, `${data.cert_expiring} Expiring`)
                : bi(`${data.certs.length} 份正常`, `${data.certs.length} Healthy`)
              : bi("未配置", "None")}
          </span>
          <span className="csec-kpi-sub">
            {data.certs.length > 0
              ? bi("基于交付包内嵌 X.509 实时解析", "Parsed from embedded X.509 bundle")
              : bi("当前集群未启用 TLS 证书包", "No TLS bundle embedded")}
          </span>
        </div>

        <div className="csec-kpi">
          <span className="csec-kpi-lbl">{bi("安全修复演练", "Security Rehearsals")}</span>
          <span className="csec-kpi-val">{data.rehearsals.length}</span>
          <span className="csec-kpi-sub">
            {bi(
              `${data.rehearsals.filter((x) => x.stage === "finalized").length} 份已固化生产 SOP`,
              `${data.rehearsals.filter((x) => x.stage === "finalized").length} finalized SOP(s)`,
            )}
          </span>
        </div>
      </div>

      {/* Section 1: Cluster Software CVEs (Grouped by Package Upgrade Target) */}
      <section className="csec-section">
        <div className="csec-sec-head">
          <h4>
            {bi("1. 本集群软件漏洞（按修复包聚合）", "1. Cluster CVEs (Grouped by Package Upgrade)")}
          </h4>
          <div className="csec-sec-tools">
            <div className="sec-seg" role="tablist" aria-label={bi("处置状态筛选", "Disposition filter")}>
              {[
                {
                  id: "active" as const,
                  label: bi(`待处理 (${statusCounts.active})`, `Active (${statusCounts.active})`),
                },
                {
                  id: "waived" as const,
                  label: bi(`已处置 (${statusCounts.waived})`, `Triaged (${statusCounts.waived})`),
                },
                ...(statusCounts.ignored > 0 || (data.suppressed_count || 0) > 0
                  ? [
                      {
                        id: "ignored" as const,
                        label: bi(
                          `已屏蔽 (${statusCounts.ignored})`,
                          `Ignored (${statusCounts.ignored})`,
                        ),
                      },
                    ]
                  : []),
                {
                  id: "all" as const,
                  label: bi(`全部 (${statusCounts.all})`, `All (${statusCounts.all})`),
                },
              ].map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={stateFilter === s.id ? "on" : ""}
                  onClick={() => {
                    if (s.id === "ignored" && statusCounts.ignored === 0 && (data.suppressed_count || 0) > 0) {
                      setRoleFilter("all");
                    }
                    setStateFilter(s.id);
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="sec-seg" role="tablist" aria-label={bi("层级来源筛选", "Layer filter")}>
              {[
                { id: "all", label: bi("全部层级", "All Layers") },
                { id: "primary", label: bi(`中间件本体 (${data.primary_active})`, `Middleware (${data.primary_active})`) },
                {
                  id: "dependency",
                  label: data.hide_os_cves
                    ? bi("OS 底层包 (已屏蔽)", "OS Base (Hidden)")
                    : bi(`OS 底层包 (${data.dependency_active})`, `OS Base (${data.dependency_active})`),
                },
              ].map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={roleFilter === o.id ? "on" : ""}
                  onClick={() => {
                    if (o.id === "dependency" && data.hide_os_cves) {
                      setStateFilter("ignored");
                    } else if (stateFilter === "ignored" && o.id === "primary") {
                      setStateFilter("active");
                    }
                    setRoleFilter(o.id as "all" | "primary" | "dependency");
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!data.has_scan ? (
          <div className="csec-empty">
            {bi(
              "平台尚未执行过漏洞扫描，请先点击右上角「重新扫描」或前往安全中心同步漏洞库。",
              "No vulnerability scan yet. Run Rescan above or sync the vulnerability DB in Security Center.",
            )}
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="csec-empty">
            <IconCheckCircleFill style={{ color: "var(--ok)", marginRight: 6 }} />
            {stateFilter === "active" ? (
              <>
                {bi("当前视角下暂无待处理软件漏洞", "No active unhandled CVEs in this view")}
                {statusCounts.waived > 0 && (
                  <>
                    {" · "}
                    <Button size="mini" type="text" onClick={() => setStateFilter("waived")}>
                      {bi(`查看已处置 (${statusCounts.waived})`, `View Triaged (${statusCounts.waived})`)}
                    </Button>
                  </>
                )}
                {(statusCounts.ignored > 0 || (data.suppressed_count || 0) > 0) && (
                  <>
                    {" · "}
                    <Button
                      size="mini"
                      type="text"
                      onClick={() => {
                        if (statusCounts.ignored === 0 && (data.suppressed_count || 0) > 0) {
                          setRoleFilter("all");
                        }
                        setStateFilter("ignored");
                      }}
                    >
                      {bi(
                        `查看已屏蔽 (${statusCounts.ignored || data.suppressed_count || 0})`,
                        `View Ignored (${statusCounts.ignored || data.suppressed_count || 0})`,
                      )}
                    </Button>
                  </>
                )}
              </>
            ) : stateFilter === "waived" ? (
              bi("当前筛选范围内暂无已处置 / 豁免的软件漏洞。", "No triaged or waived CVEs in this view.")
            ) : stateFilter === "ignored" ? (
              bi("当前筛选范围内暂无已全局屏蔽的软件漏洞。", "No globally ignored CVEs in this view.")
            ) : (
              bi("当前筛选范围内未命中已知软件 CVE 漏洞。", "No known CVEs matched in this view.")
            )}
          </div>
        ) : (
          <div className="csec-pkg-list">
            {filteredGroups.map((g) => {
              const expanded = Boolean(expandedGroups[g.group_key]);
              const subFindings = findingsByGroup[g.group_key] || [];
              const fixTarget = g.repo_fix_version || g.recommended_fix || "";
              const canManageSec = can("security.manage");
              const isResolved = !g.globally_ignored && g.active_count === 0;
              return (
                <div
                  key={g.group_key}
                  className={`csec-pkg-card ${g.globally_ignored ? "is-ignored" : isResolved ? "is-resolved" : ""}`}
                >
                  <div className="csec-pkg-top">
                    <div className="csec-pkg-meta">
                      <div className="csec-pkg-row">
                        <span className={`sec-sev-pill ${isResolved ? "sev-resolved" : `sev-${g.max_severity}`}`}>
                          {SEV_LABEL[g.max_severity]?.() || g.max_severity}
                          {g.max_cvss ? ` ${g.max_cvss.toFixed(1)}` : ""}
                        </span>
                        <span className="mono csec-pkg-name">{g.package}</span>
                        <span className={`csec-role-tag ${g.pkg_role === "primary" ? "primary" : "dependency"}`}>
                          {g.pkg_role === "primary"
                            ? bi("中间件本体", "Middleware")
                            : bi("OS 底层包", "OS Base")}
                        </span>
                        {g.platform && (
                          <span className="sec-mini-tag">
                            <OsLogo id={g.platform} size={13} />
                            {platformShort(g.platform)}
                          </span>
                        )}
                        {g.globally_ignored ? (
                          <span className="sec-shield-tag" title={g.ignore_reason}>
                            {g.ignore_reason || bi("已全局屏蔽（不计分）", "Globally ignored (unscored)")}
                          </span>
                        ) : isResolved ? (
                          <span className="csec-resolved-tag">
                            <IconCheckCircleFill style={{ fontSize: 12 }} />
                            {bi(`全部 ${g.total_count} 条已处置`, `All ${g.total_count} triaged`)}
                          </span>
                        ) : (
                          <span className="faint small">
                            {bi(
                              `一次升级可修 ${g.active_count} 个活跃漏洞`,
                              `${g.active_count} active CVE(s) resolved in 1 upgrade`,
                            )}
                          </span>
                        )}
                      </div>
                      <div className="csec-pkg-upgrade">
                        <span className={`mono ${isResolved ? "csec-ver-muted" : "sec-ver-bad"}`}>
                          {g.installed_version}
                        </span>
                        {fixTarget ? (
                          <>
                            <span className="faint">→</span>
                            <span className="mono sec-ver-fix">{fixTarget}</span>
                            {g.repo_fix_version && (
                              <span className="sec-repo-ready">
                                {bi("源已有修复版", "Fix in repo")}
                              </span>
                            )}
                            {g.repo_fix_version && can("library.manage") && (
                              <button
                                type="button"
                                className="sec-inline-lib-link"
                                onClick={() => go({ name: "library", id: g.platform })}
                              >
                                {bi("软件库备包 ↗", "Library ↗")}
                              </button>
                            )}
                          </>
                        ) : (
                          <span className="faint small">
                            {isResolved
                              ? bi("已完成 VEX 处置（无活跃扣分，可展开查看或修改记录）", "Triaged via VEX (expand to inspect or update)")
                              : bi("暂无上游修复版（可演练配置规避或探针核验）", "No upstream fix yet (mitigation / probe recommended)")}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="csec-pkg-actions">
                      {!g.globally_ignored && canSecurityAI && g.active_count > 0 && (
                        <Button
                          size="small"
                          type="secondary"
                          className="csec-act-ai"
                          onClick={() => openAIPackage(g)}
                        >
                          <Spark size={12} /> {bi("AI 评估", "AI Assess")}
                        </Button>
                      )}
                      {g.globally_ignored ? (
                        canManageSec &&
                        g.ignore_rule_id !== "layer:os" &&
                        g.ignore_rule_id !== "layer:runtime" ? (
                          <Button
                            size="small"
                            type="outline"
                            className="csec-act-rh"
                            loading={ignoreBusy}
                            onClick={() => void restoreIgnoredGroup(g)}
                          >
                            {bi("恢复显示", "Restore")}
                          </Button>
                        ) : null
                      ) : canRehearse && g.active_count > 0 ? (
                        <Button
                          size="small"
                          type={g.pkg_role === "primary" && fixTarget ? "primary" : "secondary"}
                          className="csec-act-rh"
                          onClick={() => launchPkgRehearsal(g)}
                        >
                          <Spark size={12} />{" "}
                          {fixTarget
                            ? bi("补丁升级演练", "Upgrade Rehearsal")
                            : bi("缓解排查演练", "Mitigation Rehearsal")}
                        </Button>
                      ) : null}
                      {canManageSec && !g.globally_ignored && g.active_count > 0 && (
                        <Button
                          size="small"
                          type="text"
                          className="csec-act-ign"
                          title={bi(
                            "全局忽略此软件包：隐藏且不再计入集群打分",
                            "Globally ignore package: hide & exclude from scoring",
                          )}
                          onClick={() => {
                            setIgnoreTarget(g);
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
                      )}
                      <Button
                        size="small"
                        type="text"
                        className="csec-act-exp num"
                        onClick={() =>
                          setExpandedGroups((prev) => ({
                            ...prev,
                            [g.group_key]: !prev[g.group_key],
                          }))
                        }
                      >
                        <span>
                          {expanded
                            ? bi("收起明细", "Collapse")
                            : bi(`展开 ${g.total_count} 条`, `${g.total_count} CVE(s)`)}
                        </span>
                        {expanded ? <IconUp style={{ marginLeft: 3 }} /> : <IconDown style={{ marginLeft: 3 }} />}
                      </Button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="csec-sub-cves">
                      {subFindings.map((f) => (
                        <div key={f.key} className="csec-sub-cve-row">
                          <div className="csec-sub-cve-left">
                            <span className={`sec-sev-pill sev-${f.severity}`}>
                              {SEV_LABEL[f.severity]?.() || f.severity}
                              {f.cvss_score ? ` ${f.cvss_score.toFixed(1)}` : ""}
                            </span>
                            <b className="mono">{f.cve}</b>
                            <span className={`sec-triage-pill st-${f.triage_status}`}>
                              {TRIAGE_LABEL[f.triage_status]?.() || f.triage_status}
                            </span>
                            {f.summary && (
                              <span className="csec-sub-cve-summary" title={f.summary}>
                                {f.summary}
                              </span>
                            )}
                          </div>
                          <div className="csec-pkg-actions">
                            {canSecurityAI && (
                              <Button
                                size="mini"
                                type="secondary"
                                onClick={() => openAICVE(f)}
                              >
                                <Spark size={12} /> {bi("AI 研判", "AI Analyze")}
                              </Button>
                            )}
                            {can("security.manage") && (
                              <Button
                                size="mini"
                                type="outline"
                                onClick={() => {
                                  setVexFinding(f);
                                  setVexStatus(f.triage_status === "open" ? "mitigated" : f.triage_status);
                                  setVexJust(f.triage_justification || "");
                                  setVexExpires(f.triage_expires || "");
                                  setVexNote(f.triage_note || "");
                                  setVexGlobal(false);
                                }}
                              >
                                {bi("VEX 处置", "Triage")}
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Section 2: Config Security Baseline Audit */}
      <section className="csec-section">
        <div className="csec-sec-head">
          <h4>
            {bi("2. 配置安全基线审计（确定性静态核查）", "2. Config Security Baseline Audit")}
          </h4>
          <span className="faint small">
            {bi(
              "直接基于本集群 deployment.yml 与拓扑方案零侵入审计，不依赖 Agent 或 AI",
              "Deterministic zero-agent audit directly on cluster deployment.yml & plan",
            )}
          </span>
        </div>
        <div className="csec-base-list">
          {data.baseline_checks.map((ck) => (
            <div key={ck.id} className="csec-base-row">
              <div className="csec-base-main">
                <div className="csec-base-title">
                  <span className={`csec-st-pill ${ck.status}`}>
                    {ck.status === "pass"
                      ? bi("通过", "Pass")
                      : ck.status === "fail"
                        ? bi("未通过", "Fail")
                        : ck.status === "waived"
                          ? bi("已豁免", "Waived")
                          : bi("建议加固", "Advisory")}
                  </span>
                  <span>{ck.title}</span>
                  {ck.status !== "pass" && (
                    <span className={`sec-sev-pill sev-${ck.severity}`}>
                      {SEV_LABEL[ck.severity]?.() || ck.severity}
                    </span>
                  )}
                  {ck.target && <span className="mono faint small">{ck.target}</span>}
                </div>
                <div className="csec-base-detail">{ck.detail}</div>
                {ck.status !== "pass" && ck.recommendation && !ck.waived && (
                  <div className="csec-base-rec">
                    {bi("整改建议：", "Recommendation: ")}
                    {ck.recommendation}
                  </div>
                )}
                {ck.waived && ck.waive_note && (
                  <div className="faint small">
                    {bi(
                      `豁免说明（${ck.waive_by} · ${ago(ck.waive_at || "")}）：${ck.waive_note}`,
                      `Waived by ${ck.waive_by}: ${ck.waive_note}`,
                    )}
                  </div>
                )}
              </div>
              <div className="csec-base-actions">
                {ck.status !== "pass" && !ck.waived && canSecurityAI && (
                  <Button
                    size="small"
                    type="secondary"
                    onClick={() => openAIBaseline(ck)}
                  >
                    <Spark size={12} /> {bi("AI 研判", "AI Analyze")}
                  </Button>
                )}
                {ck.status !== "pass" && !ck.waived && ck.rehearsal_kind && canRehearse && (
                  <Button
                    size="small"
                    type="outline"
                    onClick={() => launchBaselineRehearsal(ck)}
                  >
                    <Spark size={12} /> {bi("发起加固演练", "Rehearse Fix")}
                  </Button>
                )}
                {ck.status !== "pass" && can("security.manage") && (
                  ck.waived ? (
                    <Button
                      size="small"
                      type="text"
                      loading={waiveBusy}
                      onClick={() => void submitBaselineWaive(ck, false, "")}
                    >
                      {bi("撤销豁免", "Unwaive")}
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      type="text"
                      onClick={() => {
                        setWaiveTarget(ck);
                        setWaiveNote("");
                      }}
                    >
                      {bi("记录豁免", "Waive")}
                    </Button>
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Section 3: TLS Certificate Lifecycle Watch */}
      <section className="csec-section">
        <div className="csec-sec-head">
          <h4>
            {bi("3. TLS 证书生命周期巡检", "3. TLS Certificate Lifecycle Watch")}
          </h4>
          <span className="faint small">
            {bi(
              "自动解析集群交付包内嵌的 server.crt / ca.crt 到期时间与密钥强度",
              "Parses embedded server.crt / ca.crt expiry & key strength",
            )}
          </span>
        </div>
        {data.certs.length === 0 ? (
          <div className="csec-empty">
            {data.baseline_checks.some(
              (ck) => ck.id === "tls_enabled" && ck.status === "pass",
            )
              ? bi(
                  "本集群已开启 TLS，但交付包内未静态嵌入证书文件（可能由目标主机现场自动签发或外部挂载）。",
                  "TLS is enabled on this cluster, but certificates were not statically embedded in the delivery bundle (host-generated or externally mounted).",
                )
              : bi(
                  "本集群交付包未嵌入 TLS 证书（未开启 TLS 或由外部网关终止加密）。",
                  "No TLS certificates embedded in this cluster delivery.",
                )}
          </div>
        ) : (
          <div className="csec-cert-grid">
            {data.certs.map((cert, i) => (
              <div key={`${cert.instance}-${cert.role}-${i}`} className="csec-cert-card">
                <div className="csec-cert-head">
                  <div className="csec-pkg-row">
                    <b className="mono">{cert.instance}</b>
                    <span className="csec-role-tag dependency">
                      {cert.role === "ca" ? "CA" : bi("服务器证书", "Server Cert")}
                    </span>
                  </div>
                  <span
                    className={`csec-st-pill ${
                      cert.status === "ok"
                        ? "pass"
                        : cert.status === "expiring"
                          ? "warn"
                          : "fail"
                    }`}
                  >
                    {cert.status === "expired"
                      ? bi("已过期", "Expired")
                      : cert.status === "critical" || cert.status === "expiring"
                        ? bi(`剩余 ${cert.days_left} 天`, `${cert.days_left}d left`)
                        : bi(`有效 · 剩余 ${cert.days_left} 天`, `Valid · ${cert.days_left}d`)}
                  </span>
                </div>
                <dl className="csec-cert-kv">
                  <dt>{bi("主题 CN", "Subject")}</dt>
                  <dd className="mono">{cert.subject}</dd>
                  <dt>{bi("签发机构", "Issuer")}</dt>
                  <dd>{cert.issuer}{cert.is_self_signed ? bi("（自签）", " (Self-signed)") : ""}</dd>
                  <dt>{bi("有效期", "Validity")}</dt>
                  <dd className="mono">{cert.not_before} ~ {cert.not_after}</dd>
                  <dt>{bi("密钥算法", "Key / Sig")}</dt>
                  <dd className="mono">{cert.key_algo} {cert.key_bits}-bit · {cert.sig_algo}</dd>
                  {cert.sans && cert.sans.length > 0 && (
                    <>
                      <dt>SANs</dt>
                      <dd className="mono">{cert.sans.slice(0, 4).join(", ")}</dd>
                    </>
                  )}
                </dl>
                {cert.role === "server" && canRehearse && (
                  <div style={{ marginTop: 4 }}>
                    <Button
                      size="mini"
                      type={cert.status !== "ok" ? "primary" : "secondary"}
                      onClick={() => launchCertRehearsal(cert)}
                    >
                      <Spark size={12} /> {bi("发起滚动换证演练", "Rehearse Cert Rotation")}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Section 4: Linked Security Remediation Rehearsals & SOPs */}
      <section className="csec-section">
        <div className="csec-sec-head">
          <h4>
            {bi("4. 安全修复演练与生产 SOP 追踪", "4. Security Rehearsals & Verified SOPs")}
          </h4>
        </div>
        {data.rehearsals.length === 0 ? (
          <div className="csec-empty">
            {bi(
              "暂未在本集群发起过安全修复演练。可从上方漏洞包、配置基线或证书卡片一键发起 AI 安全修复演练，自动生成只读探针与生产 SOP。",
              "No security remediation rehearsals yet. Launch one from any CVE package, baseline check, or cert card above.",
            )}
          </div>
        ) : (
          <div className="csec-rh-list">
            {data.rehearsals.map((rh) => (
              <div key={rh.id} className="csec-rh-row">
                <div className="csec-pkg-meta">
                  <div className="csec-pkg-row">
                    <b>{rh.title}</b>
                    <span className={`csec-st-pill ${rh.stage === "finalized" ? "pass" : "warn"}`}>
                      {STAGE_LABEL[rh.stage]?.() || rh.stage}
                    </span>
                    {rh.security_context?.vex_synced && (
                      <span className="csec-st-pill pass">
                        {bi("已回写 VEX", "VEX Synced")}
                      </span>
                    )}
                  </div>
                  <div className="faint small">
                    {rh.owner} · {ago(rh.updated_at)}
                    {rh.security_context?.cves && rh.security_context.cves.length > 0 && (
                      <> · {rh.security_context.cves.slice(0, 4).join(", ")}</>
                    )}
                  </div>
                </div>
                <div className="csec-pkg-actions">
                  {rh.doc_id && (
                    <Button
                      size="mini"
                      type="secondary"
                      onClick={() =>
                        go({ name: "deliveries", id: c.id, tab: "docs", doc: rh.doc_id })
                      }
                    >
                      {bi("查看生产 SOP", "View SOP")}
                    </Button>
                  )}
                  {canRehearse && (
                    <Button
                      size="mini"
                      type="outline"
                      onClick={() =>
                        go({ name: "deliveries", id: c.id, tab: "rehearsal", rehearsal: rh.id })
                      }
                    >
                      {bi("打开演练", "Open Rehearsal")} <IconRight />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Global Ignore Package Modal */}
      <Modal
        visible={Boolean(ignoreTarget)}
        title={bi(
          `全局忽略软件包：${ignoreTarget?.package || ""}`,
          `Globally Ignore Package: ${ignoreTarget?.package || ""}`,
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
              <b className="mono">{ignoreTarget.package}</b>
              <span className={`csec-role-tag ${ignoreTarget.pkg_role === "primary" ? "primary" : "dependency"}`}>
                {ignoreTarget.pkg_role === "primary"
                  ? bi("中间件本体", "Middleware")
                  : bi("OS 底层包", "OS Base")}
              </span>
              <span className="faint small num">
                {bi(
                  `本集群命中 ${ignoreTarget.active_count} 条活跃 CVE`,
                  `${ignoreTarget.active_count} active CVE(s) on this cluster`,
                )}
              </span>
            </div>
            <p className="sec-ign-tip">
              {bi(
                "全局忽略后，该软件包的所有 CVE 将在本集群与安全中心默认隐藏，且立即免除集群打分扣分与发布门禁；随时可点击「查看已屏蔽」一键恢复。",
                "All CVEs for this package will be hidden by default and excluded from cluster score deductions and publish gates. Restorable anytime.",
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
                  {bi(
                    `仅当前生态 (${ignoreTarget.ecosystem || ignoreTarget.eco_key})`,
                    `Only ${ignoreTarget.ecosystem || ignoreTarget.eco_key}`,
                  )}
                </button>
              </div>
            </div>
            <div className="sec-ign-field">
              <label>{bi("忽略原因（可选）", "Reason (optional)")}</label>
              <Input
                value={ignoreNote}
                onChange={setIgnoreNote}
                placeholder={bi(
                  "例如：由操作系统补丁渠道统一维护",
                  "e.g. Managed by OS patching team",
                )}
              />
              <div className="sec-ign-chips">
                {[
                  bi("由操作系统补丁渠道统一维护", "Managed by OS patching channel"),
                  bi("纯内网隔离环境不可触发", "Unreachable in air-gapped network"),
                  bi("受影响模块未启用", "Vulnerable module unused"),
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

      {/* Baseline Waive Modal */}
      <Modal
        visible={Boolean(waiveTarget)}
        title={bi(`豁免配置基线：${waiveTarget?.title || ""}`, `Waive Baseline: ${waiveTarget?.title || ""}`)}
        onCancel={() => !waiveBusy && setWaiveTarget(null)}
        onOk={() => {
          if (waiveTarget) void submitBaselineWaive(waiveTarget, true, waiveNote);
        }}
        confirmLoading={waiveBusy}
        okText={bi("确认豁免", "Confirm Waiver")}
        cancelText={bi("取消", "Cancel")}
        style={{ width: 560, maxWidth: "94vw" }}
      >
        {waiveTarget && (
          <BaselineWaiveEditor
            clusterId={c.id}
            title={waiveTarget.title}
            detail={waiveTarget.detail}
            note={waiveNote}
            onNoteChange={setWaiveNote}
          />
        )}
      </Modal>

      {/* Quick VEX Triage Modal */}
      <Modal
        visible={Boolean(vexFinding)}
        title={bi(`VEX 漏洞处置：${vexFinding?.cve || ""}`, `VEX Triage: ${vexFinding?.cve || ""}`)}
        onCancel={() => !vexBusy && setVexFinding(null)}
        onOk={() => void submitQuickVex()}
        confirmLoading={vexBusy}
        okText={bi("保存处置", "Save Triage")}
        cancelText={bi("取消", "Cancel")}
        style={{ width: 580, maxWidth: "94vw" }}
      >
        {vexFinding && (
          <VexTriageEditor
            context={{
              kind: "vex",
              cve: vexFinding.cve,
              package: vexFinding.package,
              ecosystem: vexFinding.ecosystem,
              installed_version: vexFinding.installed_version,
              fixed_in: vexFinding.fixed_in,
              pkg_role: vexFinding.pkg_role,
              severity: vexFinding.severity,
              cvss_score: vexFinding.cvss_score,
              summary: vexFinding.summary,
              cluster_id: c.id,
            }}
            status={vexStatus}
            onStatusChange={setVexStatus}
            justification={vexJust}
            onJustificationChange={setVexJust}
            expires={vexExpires}
            onExpiresChange={setVexExpires}
            note={vexNote}
            onNoteChange={setVexNote}
            globalScope={vexGlobal}
            onGlobalScopeChange={setVexGlobal}
          />
        )}
      </Modal>

      <SecExportModal
        visible={exportOpen}
        onClose={() => setExportOpen(false)}
        clusterId={c.id}
        clusterTitle={`${c.id} (${data.app_name} ${data.version})`}
        defaultScope={roleFilter !== "all" ? roleFilter : undefined}
        onManageTemplates={() => go({ name: "security", tab: "reports" })}
      />
    </div>
  );
}

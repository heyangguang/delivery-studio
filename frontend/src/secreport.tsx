import React, { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Message,
  Modal,
  Select,
  Switch,
} from "@arco-design/web-react";
import {
  IconDownload,
  IconEye,
  IconPlus,
} from "@arco-design/web-react/icon";
import { api, can, err } from "./shared";
import { go } from "./router";
import { bi, useLang } from "./i18n";
import "./secreport.css";

/* ---------- types ---------- */

export type SecReportSections = {
  executive_summary: boolean;
  affected_clusters: boolean;
  package_groups: boolean;
  cve_details: boolean;
  baseline_checks: boolean;
  tls_certs: boolean;
  remediation_plan: boolean;
  signoff: boolean;
};

export type SecReportTemplate = {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  is_default?: boolean;
  default_format: "docx" | "xlsx" | "html" | "markdown" | "csv" | string;
  theme: "teal" | "navy" | "indigo" | "slate" | string;
  org_name?: string;
  title?: string;
  subtitle?: string;
  confidential?: string;
  header_text?: string;
  footer_text?: string;
  conclusion_note?: string;
  scope: "active" | "all" | "primary" | "dependency" | string;
  min_severity: "ALL" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | string;
  include_waived: boolean;
  include_ignored: boolean;
  sections: SecReportSections;
  updated_at?: string;
  updated_by?: string;
};

export const SEC_REPORT_THEMES = [
  { id: "teal", color: "#115248", zh: "深青标准", en: "Teal" },
  { id: "navy", color: "#1E3A5F", zh: "经典藏蓝", en: "Navy" },
  { id: "indigo", color: "#3730A3", zh: "科技靛紫", en: "Indigo" },
  { id: "slate", color: "#27272A", zh: "石墨深灰", en: "Slate" },
] as const;

export const SEC_REPORT_SECTION_META: {
  key: keyof SecReportSections;
  zh: string;
  en: string;
  descZh: string;
  descEn: string;
}[] = [
  {
    key: "executive_summary",
    zh: "综合态势概览",
    en: "Executive Summary",
    descZh: "评分、等级分布 KPI、分层汇总与风险提示",
    descEn: "Score, severity KPIs, layer breakdown & callouts",
  },
  {
    key: "affected_clusters",
    zh: "受影响生产集群",
    en: "Affected Clusters",
    descZh: "集群风险矩阵或单集群节点资产详情",
    descEn: "Cluster risk matrix or target node inventory",
  },
  {
    key: "package_groups",
    zh: "修复包升级清单",
    en: "Package Upgrade Plan",
    descZh: "按软件包聚合的推荐修复版与软件源就绪状态",
    descEn: "Aggregated package targets & repo fix readiness",
  },
  {
    key: "cve_details",
    zh: "CVE 漏洞明细表",
    en: "CVE Details",
    descZh: "逐条 CVE 编号、CVSS、修复版本与 VEX 处置说明",
    descEn: "Full CVE list with CVSS, fixed version & VEX",
  },
  {
    key: "baseline_checks",
    zh: "配置安全基线",
    en: "Config Baseline",
    descZh: "单集群加密、网络隔离与架构安全基线核查",
    descEn: "Cluster encryption, network & HA baseline checks",
  },
  {
    key: "tls_certs",
    zh: "TLS 证书巡检",
    en: "TLS Certificates",
    descZh: "单集群托管证书到期日期与剩余天数预警",
    descEn: "Cluster X.509 certificate expiry & key checks",
  },
  {
    key: "remediation_plan",
    zh: "优先修复与演练指引",
    en: "Remediation Plan",
    descZh: "按 P0/P1/P2 自动排期的升级与配置加固建议",
    descEn: "Prioritized P0/P1/P2 upgrade & hardening actions",
  },
  {
    key: "signoff",
    zh: "报告声明与审批签字",
    en: "Sign-off Block",
    descZh: "底部声明结语及编制/复核/审批三栏签字区",
    descEn: "Disclaimer note and formal approval sign-off table",
  },
];

export function themeColorOf(theme?: string): string {
  return (
    SEC_REPORT_THEMES.find((t) => t.id === theme)?.color ??
    SEC_REPORT_THEMES[0].color
  );
}

export function formatLabelOf(fmt?: string): string {
  switch ((fmt || "").toLowerCase()) {
    case "docx":
      return "Word (.docx)";
    case "xlsx":
      return "Excel (.xlsx)";
    case "html":
      return "HTML (.html)";
    case "markdown":
      return "Markdown (.md)";
    case "csv":
      return "CSV (.csv)";
    case "cyclonedx":
      return "CycloneDX SBOM";
    default:
      return "Word (.docx)";
  }
}

export function scopeLabelOf(scope?: string): string {
  switch (scope) {
    case "primary":
      return bi("仅中间件本体", "Middleware Only");
    case "dependency":
      return bi("仅 OS 底层包", "OS Base Only");
    case "all":
      return bi("全量（含全局屏蔽）", "All (incl. Ignored)");
    default:
      return bi("沿用当前视角", "Active Perspective");
  }
}

export function minSevLabelOf(sev?: string): string {
  switch ((sev || "").toUpperCase()) {
    case "CRITICAL":
      return bi("仅严重 (Critical)", "Critical Only");
    case "HIGH":
      return bi("高危及以上 (High+)", "High & Critical");
    case "MEDIUM":
      return bi("中危及以上 (Medium+)", "Medium+");
    case "LOW":
      return bi("低危及以上 (Low+)", "Low+");
    default:
      return bi("全部等级", "All Severities");
  }
}

export function buildSecExportUrl(opts: {
  format: string;
  templateId?: string;
  clusterId?: string;
  scope?: string;
  inline?: boolean;
}): string {
  const qs = new URLSearchParams();
  qs.set("format", opts.format);
  if (opts.templateId) qs.set("template", opts.templateId);
  if (opts.clusterId) qs.set("cluster", opts.clusterId);
  if (opts.scope && opts.scope !== "template") qs.set("scope", opts.scope);
  if (opts.inline) qs.set("inline", "1");
  return `/api/security/export?${qs.toString()}`;
}

function emptyCustomTemplate(): SecReportTemplate {
  return {
    id: "",
    name: "",
    description: "",
    builtin: false,
    is_default: false,
    default_format: "docx",
    theme: "teal",
    org_name: "Kyndryl Delivery Studio 安全运营中心",
    title: "{scope}安全态势评估报告",
    subtitle: "SBOM 漏洞评估与合规审计报告",
    confidential: "内部受控 / Internal",
    header_text: "{org} · {scope}安全评估报告",
    footer_text: "由 Kyndryl Delivery Studio 生成 · {date}",
    conclusion_note:
      "本报告基于平台本地漏洞库与资产快照生成，用于安全审计与修复排期。",
    scope: "active",
    min_severity: "ALL",
    include_waived: true,
    include_ignored: false,
    sections: {
      executive_summary: true,
      affected_clusters: true,
      package_groups: true,
      cve_details: true,
      baseline_checks: true,
      tls_certs: true,
      remediation_plan: true,
      signoff: true,
    },
  };
}

function enabledSectionLabels(sec: SecReportSections): string[] {
  return SEC_REPORT_SECTION_META.filter((m) => Boolean(sec?.[m.key])).map((m) =>
    bi(m.zh, m.en),
  );
}

/* =========================================================================
   SecReportTemplatesSection — Reusable Template Manager Card / Page
   ========================================================================= */

export function SecReportTemplatesSection({
  templates: controlledTemplates,
  onTemplatesChange,
  canManage: canManageProp,
  clusterId,
  embeddedInCard = true,
  hideHeader = false,
}: {
  templates?: SecReportTemplate[];
  onTemplatesChange?: (next: SecReportTemplate[]) => void;
  canManage?: boolean;
  clusterId?: string;
  embeddedInCard?: boolean;
  hideHeader?: boolean;
}) {
  useLang();
  const canManage = canManageProp ?? can("security.manage");
  const [localList, setLocalList] = useState<SecReportTemplate[]>(
    controlledTemplates ?? [],
  );
  const [loading, setLoading] = useState(!controlledTemplates);
  const [busyId, setBusyId] = useState("");

  // Modal editor state
  const [editing, setEditing] = useState<SecReportTemplate | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);

  const list = controlledTemplates ?? localList;

  const setList = (next: SecReportTemplate[]) => {
    setLocalList(next);
    onTemplatesChange?.(next);
  };

  useEffect(() => {
    if (controlledTemplates) {
      setLocalList(controlledTemplates);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api<{ templates: SecReportTemplate[] }>("/api/security/report-templates")
      .then((r) => {
        if (alive) setLocalList(r.templates ?? []);
      })
      .catch(err)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [controlledTemplates]);

  const openCreate = () => {
    setIsNew(true);
    setEditing(emptyCustomTemplate());
  };

  const openEdit = (tpl: SecReportTemplate) => {
    setIsNew(false);
    setEditing({
      ...tpl,
      sections: { ...tpl.sections },
    });
  };

  const openDuplicate = (tpl: SecReportTemplate) => {
    setIsNew(true);
    setEditing({
      ...tpl,
      id: "",
      builtin: false,
      is_default: false,
      name: `${tpl.name} (${bi("副本", "Copy")})`,
      sections: { ...tpl.sections },
    });
  };

  const saveEditor = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      Message.warning(bi("请填写模板名称", "Please enter a template name"));
      return;
    }
    setSaving(true);
    try {
      const resp = isNew
        ? await api<{ template: SecReportTemplate; templates: SecReportTemplate[] }>(
            "/api/security/report-templates",
            {
              method: "POST",
              body: JSON.stringify(editing),
            },
          )
        : await api<{ template: SecReportTemplate; templates: SecReportTemplate[] }>(
            `/api/security/report-templates/${encodeURIComponent(editing.id)}`,
            {
              method: "PUT",
              body: JSON.stringify(editing),
            },
          );
      setList(resp.templates ?? []);
      setEditing(null);
      Message.success(
        isNew
          ? bi("已创建安全报告模板", "Report template created")
          : bi("已保存报告模板配置", "Report template updated"),
      );
    } catch (e) {
      err(e);
    } finally {
      setSaving(false);
    }
  };

  const setDefault = async (tpl: SecReportTemplate) => {
    setBusyId(tpl.id);
    try {
      const resp = await api<{ templates: SecReportTemplate[] }>(
        `/api/security/report-templates/${encodeURIComponent(tpl.id)}/default`,
        { method: "POST" },
      );
      setList(resp.templates ?? []);
      Message.success(
        bi(`已将「${tpl.name}」设为默认模板`, `"${tpl.name}" set as default`),
      );
    } catch (e) {
      err(e);
    } finally {
      setBusyId("");
    }
  };

  const resetBuiltin = async (tpl: SecReportTemplate) => {
    setBusyId(tpl.id);
    try {
      const resp = await api<{ templates: SecReportTemplate[] }>(
        `/api/security/report-templates/${encodeURIComponent(tpl.id)}/reset`,
        { method: "POST" },
      );
      setList(resp.templates ?? []);
      Message.success(
        bi(`已重置内置模板「${tpl.name}」`, `Reset built-in template "${tpl.name}"`),
      );
    } catch (e) {
      err(e);
    } finally {
      setBusyId("");
    }
  };

  const removeTemplate = (tpl: SecReportTemplate) => {
    Modal.confirm({
      title: bi("删除安全报告模板", "Delete Report Template"),
      content: bi(
        `确定删除自定义模板「${tpl.name}」？此操作不可撤销。`,
        `Delete custom template "${tpl.name}"? This cannot be undone.`,
      ),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        setBusyId(tpl.id);
        try {
          const resp = await api<{ templates: SecReportTemplate[] }>(
            `/api/security/report-templates/${encodeURIComponent(tpl.id)}`,
            { method: "DELETE" },
          );
          setList(resp.templates ?? []);
          Message.success(bi("已删除模板", "Template deleted"));
        } catch (e) {
          err(e);
        } finally {
          setBusyId("");
        }
      },
    });
  };

  const inner = (
    <div className="srt-wrap">
      {hideHeader ? (
        <div className="srt-subbar">
          <div className="srt-subbar-l">
            <b>{bi(`共 ${list.length} 套导出模板`, `${list.length} Export Templates`)}</b>
            <span className="faint small">
              {bi(
                "支持 Word (.docx)、Excel (.xlsx) 与单文件离线 HTML；可按需定制封面配色、筛选口径与包含章节。",
                "Supports Word (.docx), Excel (.xlsx), and standalone HTML with custom branding, filters, and sections.",
              )}
            </span>
          </div>
          {canManage && (
            <Button size="small" type="primary" icon={<IconPlus />} onClick={openCreate}>
              {bi("新建模板", "New Template")}
            </Button>
          )}
        </div>
      ) : (
        <div className="srt-head">
          <div>
            <h2>{bi("安全报告模板配置", "Security Report Templates")}</h2>
            <p>
              {bi(
                "统一管理 Word（.docx）、Excel（.xlsx）与单文件离线 HTML（.html）安全报告模板，按需配置封面配色、页眉页脚、漏洞筛选口径与包含章节；全平台安全中心与单集群安全页导出时均可直接选用。",
                "Configure reusable Word (.docx), Excel (.xlsx), and standalone HTML (.html) templates with custom branding, scope filters, and sections for both global and cluster security exports.",
              )}
            </p>
          </div>
          {canManage && (
            <Button size="small" type="primary" icon={<IconPlus />} onClick={openCreate}>
              {bi("新建模板", "New Template")}
            </Button>
          )}
        </div>
      )}

      {loading ? (
        <div className="faint small">{bi("正在加载报告模板…", "Loading templates…")}</div>
      ) : (
        <div className="srt-grid">
          {list.map((tpl) => {
            const secLabels = enabledSectionLabels(tpl.sections);
            const fmtCls = `srt-fmt-${(tpl.default_format || "docx").toLowerCase()}`;
            const metaParts = [
              scopeLabelOf(tpl.scope),
              minSevLabelOf(tpl.min_severity),
              ...(!tpl.include_waived ? [bi("不含已豁免", "Active only")] : []),
              ...(tpl.include_ignored ? [bi("含全局屏蔽", "Incl. Ignored")] : []),
            ];
            return (
              <div
                key={tpl.id}
                className={`srt-card ${tpl.is_default ? "is-default" : ""}`}
                data-template-id={tpl.id}
              >
                <div className="srt-card-top">
                  <div className="srt-card-title">
                    <span
                      className="srt-swatch"
                      style={{ background: themeColorOf(tpl.theme) }}
                    />
                    <b>{tpl.name}</b>
                    {tpl.is_default && (
                      <span className="srt-badge srt-badge-def">
                        {bi("默认", "Default")}
                      </span>
                    )}
                    <span
                      className={`srt-badge ${
                        tpl.builtin ? "srt-badge-builtin" : "srt-badge-custom"
                      }`}
                    >
                      {tpl.builtin ? bi("内置", "Built-in") : bi("自定义", "Custom")}
                    </span>
                  </div>
                  <span className={`srt-fmt-pill ${fmtCls}`}>
                    {formatLabelOf(tpl.default_format)}
                  </span>
                </div>

                <p className="srt-desc">
                  {tpl.description ||
                    bi("自定义安全评估报告模板", "Custom security report template")}
                </p>

                <div className="srt-meta-line">
                  {metaParts.join(" · ")}
                </div>

                <div className="srt-secs">
                  {secLabels.map((lbl) => (
                    <span key={lbl} className="srt-sec-tag">
                      {lbl}
                    </span>
                  ))}
                </div>

                <div className="srt-card-foot">
                  <div className="srt-quick-exports">
                    <button
                      type="button"
                      className="srt-exp-btn"
                      onClick={() => {
                        window.location.href = buildSecExportUrl({
                          format: "docx",
                          templateId: tpl.id,
                          clusterId,
                        });
                      }}
                      title={bi("导出 Word (.docx)", "Export Word (.docx)")}
                    >
                      <IconDownload />
                      <span>Word</span>
                    </button>
                    <button
                      type="button"
                      className="srt-exp-btn"
                      onClick={() => {
                        window.location.href = buildSecExportUrl({
                          format: "xlsx",
                          templateId: tpl.id,
                          clusterId,
                        });
                      }}
                      title={bi("导出 Excel (.xlsx)", "Export Excel (.xlsx)")}
                    >
                      <IconDownload />
                      <span>Excel</span>
                    </button>
                    <button
                      type="button"
                      className="srt-exp-btn"
                      onClick={() => {
                        window.open(
                          buildSecExportUrl({
                            format: "html",
                            templateId: tpl.id,
                            clusterId,
                            inline: true,
                          }),
                          "_blank",
                          "noopener,noreferrer",
                        );
                      }}
                      title={bi("在新标签页预览 HTML 简报", "Preview HTML report in new tab")}
                    >
                      <IconEye />
                      <span>{bi("预览", "Preview")}</span>
                    </button>
                  </div>

                  {canManage && (
                    <div className="srt-manage-acts">
                      {!tpl.is_default && (
                        <>
                          <button
                            type="button"
                            className="srt-act-link is-sub"
                            disabled={busyId === tpl.id}
                            onClick={() => void setDefault(tpl)}
                          >
                            {bi("设为默认", "Default")}
                          </button>
                          <i className="srt-act-sep" aria-hidden />
                        </>
                      )}
                      <button
                        type="button"
                        className="srt-act-link"
                        onClick={() => openEdit(tpl)}
                      >
                        {bi("编辑", "Edit")}
                      </button>
                      <button
                        type="button"
                        className="srt-act-link"
                        onClick={() => openDuplicate(tpl)}
                      >
                        {bi("复制", "Copy")}
                      </button>
                      {tpl.builtin ? (
                        <button
                          type="button"
                          className="srt-act-link is-sub"
                          disabled={busyId === tpl.id}
                          onClick={() => void resetBuiltin(tpl)}
                        >
                          {bi("重置", "Reset")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="srt-act-link is-danger"
                          disabled={busyId === tpl.id}
                          onClick={() => removeTemplate(tpl)}
                        >
                          {bi("删除", "Delete")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Template Editor Modal */}
      <Modal
        title={
          isNew
            ? bi("新建安全报告模板", "Create Security Report Template")
            : bi(`编辑安全报告模板：${editing?.name || ""}`, `Edit Template: ${editing?.name || ""}`)
        }
        visible={Boolean(editing)}
        onCancel={() => !saving && setEditing(null)}
        onOk={() => void saveEditor()}
        confirmLoading={saving}
        okText={isNew ? bi("创建模板", "Create") : bi("保存修改", "Save Changes")}
        cancelText={bi("取消", "Cancel")}
        style={{ width: 720, maxWidth: "94vw" }}
        unmountOnExit
      >
        {editing && (
          <div className="srt-editor">
            <div className="srt-ed-group">
              <div className="srt-ed-group-h">
                <span>{bi("1. 基本信息与视觉版式", "1. Basics & Visual Style")}</span>
              </div>
              <div className="srt-form-2col">
                <div className="srt-field">
                  <label>{bi("模板名称 *", "Template Name *")}</label>
                  <Input
                    value={editing.name}
                    placeholder={bi("例如：等保三级合规月报", "e.g. Monthly Compliance Audit")}
                    onChange={(v) => setEditing({ ...editing, name: v })}
                  />
                </div>
                <div className="srt-field">
                  <label>{bi("组织 / 部门抬头", "Organization Header")}</label>
                  <Input
                    value={editing.org_name || ""}
                    placeholder="Kyndryl Delivery Studio 安全运营中心"
                    onChange={(v) => setEditing({ ...editing, org_name: v })}
                  />
                </div>
              </div>
              <div className="srt-field">
                <label>{bi("模板用途说明", "Description")}</label>
                <Input
                  value={editing.description || ""}
                  placeholder={bi("简要描述此模板适用的汇报场景或受众", "Describe the target audience or purpose")}
                  onChange={(v) => setEditing({ ...editing, description: v })}
                />
              </div>

              <div className="srt-field">
                <label>{bi("默认推荐导出格式", "Default Export Format")}</label>
                <div className="srt-fmt-grid">
                  {(
                    [
                      {
                        id: "docx",
                        title: "Word (.docx)",
                        desc: bi("封面目录、表格与签字栏", "Cover, TOC, tables & sign-off"),
                      },
                      {
                        id: "xlsx",
                        title: "Excel (.xlsx)",
                        desc: bi("多 Sheet 台账、等级着色与筛选", "Multi-sheet tracker & filters"),
                      },
                      {
                        id: "html",
                        title: "HTML (.html)",
                        desc: bi("离线交互检索、可打印 PDF", "Offline interactive & print-PDF"),
                      },
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`srt-fmt-card ${
                        editing.default_format === f.id ? "on" : ""
                      }`}
                      onClick={() =>
                        setEditing({ ...editing, default_format: f.id })
                      }
                    >
                      <div className="srt-fmt-card-h">
                        <b>{f.title}</b>
                      </div>
                      <small>{f.desc}</small>
                    </button>
                  ))}
                </div>
              </div>

              <div className="srt-field">
                <label>{bi("主题配色（同步应用于 Word / Excel / HTML）", "Color Theme (Word / Excel / HTML)")}</label>
                <div className="srt-theme-row">
                  {SEC_REPORT_THEMES.map((th) => (
                    <button
                      key={th.id}
                      type="button"
                      className={`srt-theme-btn ${
                        editing.theme === th.id ? "on" : ""
                      }`}
                      onClick={() => setEditing({ ...editing, theme: th.id })}
                    >
                      <span
                        className="srt-swatch"
                        style={{ background: th.color }}
                      />
                      <span>{bi(th.zh, th.en)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="srt-ed-group">
              <div className="srt-ed-group-h">
                <span>{bi("2. 封面文案、页眉页脚与声明", "2. Cover, Headers & Disclaimer")}</span>
                <small>
                  {bi(
                    "支持占位符：{org} {scope} {cluster} {date} {template}",
                    "Placeholders: {org} {scope} {cluster} {date} {template}",
                  )}
                </small>
              </div>
              <div className="srt-form-2col">
                <div className="srt-field">
                  <label>{bi("报告主标题", "Report Title")}</label>
                  <Input
                    value={editing.title || ""}
                    onChange={(v) => setEditing({ ...editing, title: v })}
                  />
                </div>
                <div className="srt-field">
                  <label>{bi("密级标识", "Confidentiality Label")}</label>
                  <Input
                    value={editing.confidential || ""}
                    onChange={(v) => setEditing({ ...editing, confidential: v })}
                  />
                </div>
              </div>
              <div className="srt-field">
                <label>{bi("副标题", "Subtitle")}</label>
                <Input
                  value={editing.subtitle || ""}
                  onChange={(v) => setEditing({ ...editing, subtitle: v })}
                />
              </div>
              <div className="srt-form-2col">
                <div className="srt-field">
                  <label>{bi("页眉文本", "Header Text")}</label>
                  <Input
                    value={editing.header_text || ""}
                    onChange={(v) => setEditing({ ...editing, header_text: v })}
                  />
                </div>
                <div className="srt-field">
                  <label>{bi("页脚文本", "Footer Text")}</label>
                  <Input
                    value={editing.footer_text || ""}
                    onChange={(v) => setEditing({ ...editing, footer_text: v })}
                  />
                </div>
              </div>
              <div className="srt-field">
                <label>{bi("报告声明 / 结语备注", "Conclusion / Disclaimer Note")}</label>
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 4 }}
                  value={editing.conclusion_note || ""}
                  onChange={(v) =>
                    setEditing({ ...editing, conclusion_note: v })
                  }
                />
              </div>
            </div>

            <div className="srt-ed-group">
              <div className="srt-ed-group-h">
                <span>{bi("3. 数据筛选口径与包含章节", "3. Data Scope & Report Sections")}</span>
              </div>
              <div className="srt-form-2col">
                <div className="srt-field">
                  <label>{bi("默认漏洞分层范围", "Default Layer Scope")}</label>
                  <Select
                    value={editing.scope}
                    onChange={(v) => setEditing({ ...editing, scope: v })}
                  >
                    <Select.Option value="active">
                      {bi("沿用平台全局视角（推荐）", "Follow Global Perspective (Recommended)")}
                    </Select.Option>
                    <Select.Option value="primary">
                      {bi("仅中间件本体", "Middleware Only")}
                    </Select.Option>
                    <Select.Option value="dependency">
                      {bi("仅 OS 底层包", "OS Base Libraries Only")}
                    </Select.Option>
                    <Select.Option value="all">
                      {bi("全量（含所有层级与全局屏蔽）", "All Layers (incl. Ignored)")}
                    </Select.Option>
                  </Select>
                </div>
                <div className="srt-field">
                  <label>{bi("最低收录风险等级", "Minimum Severity")}</label>
                  <Select
                    value={editing.min_severity}
                    onChange={(v) => setEditing({ ...editing, min_severity: v })}
                  >
                    <Select.Option value="ALL">
                      {bi("全部等级", "All Severities")}
                    </Select.Option>
                    <Select.Option value="CRITICAL">
                      {bi("仅严重 (Critical)", "Critical Only")}
                    </Select.Option>
                    <Select.Option value="HIGH">
                      {bi("高危及以上 (High+)", "High & Critical")}
                    </Select.Option>
                    <Select.Option value="MEDIUM">
                      {bi("中危及以上 (Medium+)", "Medium+")}
                    </Select.Option>
                    <Select.Option value="LOW">
                      {bi("低危及以上 (Low+)", "Low+")}
                    </Select.Option>
                  </Select>
                </div>
              </div>

              <div className="srt-switches">
                <label className="srt-sw">
                  <Switch
                    size="small"
                    checked={editing.include_waived}
                    onChange={(v) =>
                      setEditing({ ...editing, include_waived: v })
                    }
                  />
                  <span>
                    {bi("包含已缓解 / 已豁免（VEX）条目", "Include Waived / Mitigated (VEX)")}
                  </span>
                </label>
                <label className="srt-sw">
                  <Switch
                    size="small"
                    checked={editing.include_ignored}
                    onChange={(v) =>
                      setEditing({ ...editing, include_ignored: v })
                    }
                  />
                  <span>
                    {bi("包含全局屏蔽条目", "Include Globally Ignored")}
                  </span>
                </label>
                <label className="srt-sw">
                  <Switch
                    size="small"
                    checked={Boolean(editing.is_default)}
                    onChange={(v) => setEditing({ ...editing, is_default: v })}
                  />
                  <span>{bi("设为默认导出模板", "Set as Default Template")}</span>
                </label>
              </div>

              <div className="srt-sec-grid">
                {SEC_REPORT_SECTION_META.map((m) => {
                  const checked = Boolean(editing.sections[m.key]);
                  return (
                    <label
                      key={m.key}
                      className={`srt-sec-opt ${checked ? "on" : ""}`}
                    >
                      <Checkbox
                        checked={checked}
                        onChange={(v) =>
                          setEditing({
                            ...editing,
                            sections: { ...editing.sections, [m.key]: v },
                          })
                        }
                      />
                      <span className="srt-sec-opt-txt">
                        <b>{bi(m.zh, m.en)}</b>
                        <small>{bi(m.descZh, m.descEn)}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );

  if (!embeddedInCard) return inner;
  return <section className="sec-card">{inner}</section>;
}

/* =========================================================================
   SecExportModal — Unified Template + Format Export Dialog
   Used in both Global Security Center & Single Cluster Security Tab
   ========================================================================= */

export function SecExportModal({
  visible,
  onClose,
  templates: providedTemplates,
  clusterId,
  clusterTitle,
  defaultScope,
  onManageTemplates,
}: {
  visible: boolean;
  onClose: () => void;
  templates?: SecReportTemplate[];
  clusterId?: string;
  clusterTitle?: string;
  defaultScope?: string;
  onManageTemplates?: () => void;
}) {
  useLang();
  const [loaded, setLoaded] = useState<SecReportTemplate[]>(
    providedTemplates ?? [],
  );
  const [selectedId, setSelectedId] = useState<string>("");
  const [format, setFormat] = useState<string>("docx");
  const [scopeOverride, setScopeOverride] = useState<string>("template");

  const list =
    providedTemplates && providedTemplates.length > 0
      ? providedTemplates
      : loaded;

  useEffect(() => {
    if (!visible) return;
    if (providedTemplates && providedTemplates.length > 0) {
      setLoaded(providedTemplates);
      return;
    }
    let alive = true;
    api<{ templates: SecReportTemplate[] }>("/api/security/report-templates")
      .then((r) => {
        if (alive) setLoaded(r.templates ?? []);
      })
      .catch(err);
    return () => {
      alive = false;
    };
  }, [visible, providedTemplates]);

  useEffect(() => {
    if (!visible || list.length === 0) return;
    const def = list.find((t) => t.is_default) ?? list[0];
    setSelectedId(def.id);
    setFormat(def.default_format || "docx");
    setScopeOverride(
      defaultScope && defaultScope !== "all" ? defaultScope : "template",
    );
  }, [visible, list.length]);

  const activeTpl = useMemo(
    () => list.find((t) => t.id === selectedId) ?? list[0],
    [list, selectedId],
  );

  const pickTemplate = (t: SecReportTemplate) => {
    setSelectedId(t.id);
    if (t.default_format) {
      setFormat(t.default_format);
    }
  };

  const triggerDownload = () => {
    const url = buildSecExportUrl({
      format,
      templateId: activeTpl?.id,
      clusterId,
      scope: scopeOverride,
    });
    window.location.href = url;
    Message.success(
      bi(
        `正在导出 ${formatLabelOf(format)} 安全报告…`,
        `Exporting ${formatLabelOf(format)} security report…`,
      ),
    );
    onClose();
  };

  const triggerPreviewHTML = () => {
    const url = buildSecExportUrl({
      format: "html",
      templateId: activeTpl?.id,
      clusterId,
      scope: scopeOverride,
      inline: true,
    });
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <Modal
      title={bi("导出安全评估报告", "Export Security Report")}
      visible={visible}
      onCancel={onClose}
      style={{ width: 660, maxWidth: "94vw" }}
      unmountOnExit
      footer={
        <div className="sexp-foot">
          <Button
            type="secondary"
            icon={<IconEye />}
            onClick={triggerPreviewHTML}
          >
            {bi("浏览器预览 HTML", "Preview HTML")}
          </Button>
          <div className="sexp-foot-r">
            <Button onClick={onClose}>{bi("取消", "Cancel")}</Button>
            <Button
              type="primary"
              icon={<IconDownload />}
              onClick={triggerDownload}
            >
              {bi(`导出 ${formatLabelOf(format)}`, `Export ${formatLabelOf(format)}`)}
            </Button>
          </div>
        </div>
      }
    >
      <div className="sexp-body">
        <div className="sexp-ctx">
          <span>
            {clusterId
              ? bi(
                  `导出范围：单集群安全报告 · ${clusterTitle || clusterId}`,
                  `Scope: Cluster Security Report · ${clusterTitle || clusterId}`,
                )
              : bi(
                  "导出范围：全平台安全中心综合报告",
                  "Scope: Global Security Center Report",
                )}
          </span>
          {activeTpl && (
            <span className="faint small">
              {bi(
                `含 ${enabledSectionLabels(activeTpl.sections).length} 个章节`,
                `${enabledSectionLabels(activeTpl.sections).length} sections`,
              )}
            </span>
          )}
        </div>

        <div>
          <div className="sexp-sec-h">
            <b>{bi("1. 选择报告模板", "1. Choose Report Template")}</b>
            <Button
              size="mini"
              type="text"
              onClick={() => {
                onClose();
                if (onManageTemplates) {
                  onManageTemplates();
                } else {
                  go({ name: "security", tab: "reports" });
                }
              }}
            >
              {bi("配置 / 管理报告模板 →", "Manage Templates →")}
            </Button>
          </div>
          <div className="sexp-tpl-grid">
            {list.map((t) => {
              const on = t.id === activeTpl?.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`sexp-tpl-item ${on ? "on" : ""}`}
                  onClick={() => pickTemplate(t)}
                >
                  <div className="sexp-tpl-item-h">
                    <span className="sexp-tpl-item-name">
                      <span
                        className="srt-swatch"
                        style={{ background: themeColorOf(t.theme) }}
                      />
                      <b>{t.name}</b>
                    </span>
                    {t.is_default && (
                      <span className="srt-badge srt-badge-def">
                        {bi("默认", "Default")}
                      </span>
                    )}
                  </div>
                  <div className="sexp-tpl-item-sub">
                    <span>{formatLabelOf(t.default_format)}</span>
                    <span>·</span>
                    <span>{minSevLabelOf(t.min_severity)}</span>
                    <span>·</span>
                    <span>
                      {bi(
                        `${enabledSectionLabels(t.sections).length} 章节`,
                        `${enabledSectionLabels(t.sections).length} sections`,
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="sexp-sec-h">
            <b>{bi("2. 选择导出格式", "2. Choose Export Format")}</b>
          </div>
          <div className="srt-fmt-grid">
            {(
              [
                {
                  id: "docx",
                  title: "Word (.docx)",
                  tag: bi("正式文档", "Document"),
                  desc: bi(
                    "品牌封面、自动目录、结构化表格与审批签字栏",
                    "Cover, TOC, styled tables & sign-off",
                  ),
                },
                {
                  id: "xlsx",
                  title: "Excel (.xlsx)",
                  tag: bi("多表台账", "Workbook"),
                  desc: bi(
                    "分 Sheet 汇总集群/修复包/CVE，带颜色标识与筛选",
                    "Multi-sheet tracker with colors & filters",
                  ),
                },
                {
                  id: "html",
                  title: "HTML (.html)",
                  tag: bi("交互网页", "Interactive"),
                  desc: bi(
                    "离线单文件可检索过滤，支持一键打印归档 PDF",
                    "Offline searchable report, print-to-PDF ready",
                  ),
                },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                className={`srt-fmt-card ${format === f.id ? "on" : ""}`}
                onClick={() => setFormat(f.id)}
              >
                <div className="srt-fmt-card-h">
                  <b>{f.title}</b>
                  <span className={`srt-fmt-pill srt-fmt-${f.id}`}>
                    {f.tag}
                  </span>
                </div>
                <small>{f.desc}</small>
              </button>
            ))}
          </div>

          <div className="sexp-other-fmts">
            <span className="sexp-other-lbl">
              {bi("其他标准格式：", "Other formats:")}
            </span>
            {(
              [
                ["markdown", "Markdown (.md)"],
                ["csv", "CSV 明细 (.csv)"],
                ...(clusterId
                  ? []
                  : ([["cyclonedx", "CycloneDX 1.5 SBOM + VEX"]] as const)),
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                className={`sexp-mini-fmt ${format === k ? "on" : ""}`}
                onClick={() => setFormat(k)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="sexp-scope-row">
          <span style={{ fontSize: 12.5, color: "#334155", fontWeight: 500 }}>
            {bi("漏洞分层口径覆盖", "Layer Scope Override")}
          </span>
          <Select
            size="small"
            style={{ width: 240 }}
            value={scopeOverride}
            onChange={setScopeOverride}
          >
            <Select.Option value="template">
              {bi(
                `按模板配置 (${scopeLabelOf(activeTpl?.scope)})`,
                `Use Template (${scopeLabelOf(activeTpl?.scope)})`,
              )}
            </Select.Option>
            <Select.Option value="active">
              {bi("沿用当前全局视角", "Active Global Perspective")}
            </Select.Option>
            <Select.Option value="primary">
              {bi("仅中间件本体", "Middleware Only")}
            </Select.Option>
            <Select.Option value="dependency">
              {bi("仅 OS 底层包", "OS Base Libraries Only")}
            </Select.Option>
            <Select.Option value="all">
              {bi("全量（含全局屏蔽）", "All (incl. Ignored)")}
            </Select.Option>
          </Select>
        </div>
      </div>
    </Modal>
  );
}

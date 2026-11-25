import React, { useEffect, useState } from "react";
import { Button, Input, Message, Select, Switch } from "@arco-design/web-react";
import { IconUndo } from "@arco-design/web-react/icon";
import { Spark } from "../ai/aichat";
import { api, can, err, useAIStatus } from "../../shared/shared";
import { bi, useLang } from "../../app/i18n";
import "./vextriage.css";

export type VexPolishContext = {
  kind?: "vex" | "baseline";
  cve?: string;
  cves?: string[];
  package?: string;
  ecosystem?: string;
  installed_version?: string;
  fixed_in?: string[];
  pkg_role?: string;
  severity?: string;
  cvss_score?: number;
  summary?: string;
  cluster_id?: string;
  baseline_title?: string;
  baseline_detail?: string;
};

type PolishResp = {
  polished_note: string;
  suggested_justification?: string;
  status_hint?: string;
  model?: string;
  ms?: number;
};

export const VEX_STATUS_META = (includeOpen = true) => {
  const all = [
    {
      id: "open",
      label: bi("待评估", "Open"),
      waives: false,
      desc: bi(
        "尚未完成安全评估，保持活跃漏洞计数与风险提示。",
        "Not yet assessed; remains counted as an active vulnerability.",
      ),
    },
    {
      id: "planned",
      label: bi("计划修复", "Planned"),
      waives: false,
      desc: bi(
        "已纳入升级或变更排期窗口，保持活跃追踪直至版本升级完成。",
        "Scheduled for a maintenance window; stays active until upgraded.",
      ),
    },
    {
      id: "mitigated",
      label: bi("已缓解", "Mitigated"),
      waives: true,
      desc: bi(
        "已通过配置加固、网络隔离或探针验证完成风险缓解（计为已处置，不再计入活跃风险）。",
        "Risk mitigated via config hardening or network isolation (waived from active counts).",
      ),
    },
    {
      id: "not_affected",
      label: bi("不受影响", "Not Affected"),
      waives: true,
      desc: bi(
        "受影响模块未启用或当前集群架构不满足漏洞触发条件（计为已处置，不再计入活跃风险）。",
        "Vulnerable code path or module is not enabled in this environment (waived).",
      ),
    },
    {
      id: "accepted",
      label: bi("风险豁免", "Accepted"),
      waives: true,
      desc: bi(
        "经综合评估风险可控并接受剩余风险，可设置到期复审日（到期前计为已处置）。",
        "Residual risk formally accepted; optionally set an expiry date for re-review.",
      ),
    },
  ];
  return includeOpen ? all : all.filter((x) => x.id !== "open");
};

export const VEX_JUSTIFICATION_OPTIONS = () => [
  {
    value: "vulnerable_code_not_in_execute_path",
    label: bi(
      "受影响模块/功能未启用（不在执行路径）",
      "Vulnerable code not in execute path",
    ),
  },
  {
    value: "inline_mitigations_already_exist",
    label: bi(
      "已通过配置加固、网络隔离或防火墙完成缓解",
      "Inline mitigations already exist",
    ),
  },
  {
    value: "component_not_present",
    label: bi(
      "目标运行环境不含触发条件",
      "Component/condition not present",
    ),
  },
];

function addDaysISO(days: number): string {
  const d = new Date(Date.now() + days * 86400000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const VEX_QUICK_PHRASES = () => [
  bi("仅内网隔离访问，不暴露公网", "Intranet-only access; not exposed externally"),
  bi("受影响模块未启用，无触发条件", "Vulnerable module disabled; not exploitable"),
  bi("已纳入下个变更窗口滚动升级", "Scheduled for rolling upgrade in next window"),
  bi("OS 底层公共库漏洞，由系统补丁统一修复", "OS base library; patched via OS updates"),
];

export function VexTriageEditor({
  context,
  status,
  onStatusChange,
  justification,
  onJustificationChange,
  expires,
  onExpiresChange,
  note,
  onNoteChange,
  globalScope,
  onGlobalScopeChange,
  includeOpen = true,
  showContextCard = true,
  showJustification = true,
  showExpires = true,
}: {
  context?: VexPolishContext;
  status: string;
  onStatusChange: (s: string) => void;
  justification?: string;
  onJustificationChange?: (j: string) => void;
  expires?: string;
  onExpiresChange?: (e: string) => void;
  note: string;
  onNoteChange: (n: string) => void;
  globalScope?: boolean;
  onGlobalScopeChange?: (v: boolean) => void;
  includeOpen?: boolean;
  showContextCard?: boolean;
  showJustification?: boolean;
  showExpires?: boolean;
}) {
  useLang();
  const ai = useAIStatus();
  const canSecurityAI = Boolean(
    ai.enabled && ai.features?.security && can("ai.use"),
  );

  const [polishing, setPolishing] = useState(false);
  const [rawBackup, setRawBackup] = useState<string | null>(null);
  const [aiHint, setAiHint] = useState("");

  useEffect(() => {
    setRawBackup(null);
    setAiHint("");
  }, [context?.cve, context?.package]);

  const statuses = VEX_STATUS_META(includeOpen);
  const activeMeta = statuses.find((s) => s.id === status) || statuses[0];
  const needNote =
    status === "mitigated" || status === "not_affected" || status === "accepted";

  const appendQuick = (phrase: string) => {
    const cur = note.trim();
    if (!cur) {
      onNoteChange(phrase);
    } else if (!cur.includes(phrase)) {
      const sep = /[。；;!！.]$/.test(cur) ? "" : "；";
      onNoteChange(`${cur}${sep}${phrase}`);
    }
  };

  const handleAIPolish = async () => {
    if (polishing) return;
    setPolishing(true);
    setAiHint("");
    const before = note;
    try {
      const res = await api<PolishResp>("/api/security/ai-polish", {
        method: "POST",
        body: JSON.stringify({
          kind: "vex",
          cve: context?.cve || "",
          cves: context?.cves || [],
          package: context?.package || "",
          ecosystem: context?.ecosystem || "",
          installed_version: context?.installed_version || "",
          fixed_in: context?.fixed_in || [],
          pkg_role: context?.pkg_role || "",
          summary: context?.summary || "",
          cluster_id: context?.cluster_id || "",
          status,
          justification: justification || "",
          draft_note: note.trim(),
        }),
      });
      if (res.polished_note) {
        setRawBackup(before);
        onNoteChange(res.polished_note);
        if (
          res.suggested_justification &&
          onJustificationChange &&
          !justification &&
          (status === "mitigated" || status === "not_affected")
        ) {
          onJustificationChange(res.suggested_justification);
        }
        if (res.status_hint) {
          setAiHint(res.status_hint);
        }
        Message.success(
          before.trim()
            ? bi("已由 AI 润色优化为规范审计说明", "Polished into audit-ready note")
            : bi("已由 AI 起草说明模板，请核实后保存", "Drafted template — verify before saving"),
        );
      }
    } catch (e) {
      err(e);
    } finally {
      setPolishing(false);
    }
  };

  const sevLabelMap: Record<string, string> = {
    CRITICAL: bi("严重", "Critical"),
    HIGH: bi("高危", "High"),
    MEDIUM: bi("中危", "Medium"),
    LOW: bi("低危", "Low"),
  };

  return (
    <div className="vex-ed">
      {showContextCard && context && (context.package || context.summary) && (
        <div className="vex-ctx-card">
          <div className="vex-ctx-top">
            {context.severity && (
              <span className={`sec-sev-pill num sev-${context.severity}`}>
                {sevLabelMap[context.severity.toUpperCase()] || context.severity}
                {context.cvss_score ? ` ${context.cvss_score.toFixed(1)}` : ""}
              </span>
            )}
            {context.package && (
              <span className="vex-ctx-pkg mono">{context.package}</span>
            )}
            {context.installed_version && (
              <span className="vex-ctx-ver mono">{context.installed_version}</span>
            )}
            {context.pkg_role && (
              <span
                className={`sec-role-pill role-${context.pkg_role}`}
              >
                {context.pkg_role === "primary"
                  ? bi("中间件本体", "Middleware")
                  : context.pkg_role === "runtime"
                    ? bi("运行环境", "Runtime")
                    : bi("OS 底层包", "OS Base")}
              </span>
            )}
          </div>
          {context.summary && <p className="vex-ctx-sum">{context.summary}</p>}
        </div>
      )}

      {/* Balanced 5-status horizontal selector */}
      <div className="vex-field">
        <div className="vex-field-lbl">{bi("处置结论 (VEX 状态)", "VEX Status")}</div>
        <div className="vex-status-bar" role="radiogroup">
          {statuses.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={status === s.id}
              className={`vex-st-btn st-${s.id} ${status === s.id ? "on" : ""}`}
              onClick={() => onStatusChange(s.id)}
            >
              <i className="vex-st-dot" aria-hidden />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <div className={`vex-st-desc ${activeMeta.waives ? "waives" : ""}`}>
          {activeMeta.desc}
        </div>
      </div>

      {/* Conditional Standard VEX Justification */}
      {showJustification &&
        onJustificationChange &&
        (status === "mitigated" || status === "not_affected") && (
          <div className="vex-field">
            <span className="vex-field-lbl">
              {bi("标准判定依据", "VEX Justification")}
              <span className="vex-opt-tag">{bi("可选", "Optional")}</span>
            </span>
            <Select
              size="small"
              value={justification || undefined}
              onChange={(v) => onJustificationChange(v || "")}
              allowClear
              placeholder={bi(
                "选择 CycloneDX 标准判定依据（AI 优化时也会自动匹配）",
                "Select CycloneDX justification (auto-suggested by AI)",
              )}
              options={VEX_JUSTIFICATION_OPTIONS()}
            />
          </div>
        )}

      {/* Conditional Waiver Expiry */}
      {showExpires && onExpiresChange && status === "accepted" && (
        <div className="vex-field">
          <span className="vex-field-lbl">
            {bi("豁免复审到期日", "Waiver Review Expiry")}
            <span className="vex-opt-tag">{bi("可选，YYYY-MM-DD", "Optional")}</span>
          </span>
          <div className="vex-exp-row">
            <Input
              size="small"
              value={expires || ""}
              onChange={onExpiresChange}
              placeholder="2027-03-31"
            />
            {[
              { d: 30, lbl: bi("+30 天", "+30d") },
              { d: 90, lbl: bi("+90 天", "+90d") },
              { d: 180, lbl: bi("+180 天", "+180d") },
            ].map((p) => (
              <button
                key={p.d}
                type="button"
                className="vex-quick-chip num"
                onClick={() => onExpiresChange(addDaysISO(p.d))}
              >
                {p.lbl}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Justification TextArea with AI Polish & Quick Phrases */}
      <div className="vex-field">
        <div className="vex-field-head">
          <span className="vex-field-lbl">
            {bi("处置依据 / 缓解措施说明", "Justification / Remediation Note")}
            {needNote ? (
              <span className="vex-req-tag">{bi("必填", "Required")}</span>
            ) : (
              <span className="vex-opt-tag">{bi("可选", "Optional")}</span>
            )}
          </span>
          {canSecurityAI && (
            <div className="vex-ai-acts">
              {rawBackup !== null && (
                <Button
                  size="mini"
                  type="text"
                  icon={<IconUndo />}
                  onClick={() => {
                    onNoteChange(rawBackup);
                    setRawBackup(null);
                    setAiHint("");
                  }}
                >
                  {bi("还原原稿", "Undo AI")}
                </Button>
              )}
              <Button
                size="mini"
                className="vex-ai-btn"
                loading={polishing}
                onClick={() => void handleAIPolish()}
              >
                <Spark size={12} rainbow />
                <span>
                  {note.trim()
                    ? bi("AI 优化润色", "AI Polish")
                    : bi("AI 辅助起草", "AI Draft")}
                </span>
              </Button>
            </div>
          )}
        </div>

        <div className="vex-quick-row">
          {VEX_QUICK_PHRASES().map((ph) => (
            <button
              key={ph}
              type="button"
              className="vex-quick-chip"
              onClick={() => appendQuick(ph)}
            >
              + {ph}
            </button>
          ))}
        </div>

        <Input.TextArea
          value={note}
          onChange={onNoteChange}
          maxLength={500}
          showWordLimit
          autoSize={{ minRows: 3, maxRows: 5 }}
          placeholder={
            canSecurityAI
              ? bi(
                  "可直接点击右上角「AI 辅助起草」生成初稿，或先写几句要点（如“内网不对外、没开 HTTP/3、下月升级”）再点「AI 优化润色」自动整理成规范审计文案…",
                  "Click AI Draft above for a template, or jot down brief facts (e.g. intranet-only, module disabled) and click AI Polish for formal audit wording…",
                )
              : bi(
                  "填写处置依据、补偿控制措施或排期说明…",
                  "Enter justification, compensating controls, or upgrade schedule…",
                )
          }
        />

        {aiHint && <div className="vex-ai-hint">💡 {aiHint}</div>}
      </div>

      {onGlobalScopeChange && context?.cve && (
        <label className="vex-scope-row">
          <Switch
            size="small"
            checked={Boolean(globalScope)}
            onChange={onGlobalScopeChange}
          />
          <span>
            {bi(
              `全局应用于所有命中 ${context.cve} 的软件包`,
              `Apply globally to all packages matching ${context.cve}`,
            )}
          </span>
        </label>
      )}
    </div>
  );
}

/** Compact AI Polish + Quick Phrase bar for Config Security Baseline Waivers. */
export function BaselineWaiveEditor({
  clusterId,
  title,
  detail,
  note,
  onNoteChange,
}: {
  clusterId: string;
  title: string;
  detail?: string;
  note: string;
  onNoteChange: (n: string) => void;
}) {
  useLang();
  const ai = useAIStatus();
  const canSecurityAI = Boolean(
    ai.enabled && ai.features?.security && can("ai.use"),
  );
  const [polishing, setPolishing] = useState(false);
  const [rawBackup, setRawBackup] = useState<string | null>(null);

  useEffect(() => {
    setRawBackup(null);
  }, [title]);

  const quickItems = [
    bi("前置硬件防火墙已收敛来源 IP", "Upstream firewall restricts source IPs"),
    bi("底层块存储已开启静态加密", "Underlying block storage provides encryption"),
    bi("仅内网隔离测试环境使用", "Isolated intranet staging environment only"),
  ];

  const handlePolish = async () => {
    if (polishing) return;
    setPolishing(true);
    const before = note;
    try {
      const res = await api<PolishResp>("/api/security/ai-polish", {
        method: "POST",
        body: JSON.stringify({
          kind: "baseline",
          cluster_id: clusterId,
          baseline_title: title,
          baseline_detail: detail || "",
          draft_note: note.trim(),
        }),
      });
      if (res.polished_note) {
        setRawBackup(before);
        onNoteChange(res.polished_note);
        Message.success(
          before.trim()
            ? bi("已由 AI 润色优化为规范豁免说明", "Polished waiver note")
            : bi("已由 AI 起草豁免说明模板，请核实后保存", "Drafted waiver template"),
        );
      }
    } catch (e) {
      err(e);
    } finally {
      setPolishing(false);
    }
  };

  return (
    <div className="vex-ed">
      <div className="vex-field">
        <div className="vex-field-head">
          <span className="vex-field-lbl">
            {bi("豁免合规说明 / 补偿控制措施", "Compliance Justification / Compensating Control")}
            <span className="vex-req-tag">{bi("必填", "Required")}</span>
          </span>
          {canSecurityAI && (
            <div className="vex-ai-acts">
              {rawBackup !== null && (
                <Button
                  size="mini"
                  type="text"
                  icon={<IconUndo />}
                  onClick={() => {
                    onNoteChange(rawBackup);
                    setRawBackup(null);
                  }}
                >
                  {bi("还原原稿", "Undo AI")}
                </Button>
              )}
              <Button
                size="mini"
                className="vex-ai-btn"
                loading={polishing}
                onClick={() => void handlePolish()}
              >
                <Spark size={12} rainbow />
                <span>
                  {note.trim()
                    ? bi("AI 优化润色", "AI Polish")
                    : bi("AI 辅助起草", "AI Draft")}
                </span>
              </Button>
            </div>
          )}
        </div>
        <div className="vex-quick-row">
          {quickItems.map((ph) => (
            <button
              key={ph}
              type="button"
              className="vex-quick-chip"
              onClick={() => {
                const cur = note.trim();
                if (!cur) onNoteChange(ph);
                else if (!cur.includes(ph)) onNoteChange(`${cur}；${ph}`);
              }}
            >
              + {ph}
            </button>
          ))}
        </div>
        <Input.TextArea
          autoSize={{ minRows: 3, maxRows: 5 }}
          maxLength={300}
          showWordLimit
          value={note}
          onChange={onNoteChange}
          placeholder={
            canSecurityAI
              ? bi(
                  "可直接点击右上角「AI 辅助起草」生成模板，或简单写明补偿控制（如“前置防火墙限流白名单”）后点「AI 优化润色」自动整理成审计文案…",
                  "Click AI Draft above for a template, or jot down compensating controls and click AI Polish…",
                )
              : bi("填写合规说明或补偿控制措施…", "Enter compensating control or justification...")
          }
        />
      </div>
    </div>
  );
}

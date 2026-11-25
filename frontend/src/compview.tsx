import { memo, useEffect, useMemo, useRef, useState } from "react";
import { OsLogo } from "./oslogo";
import { parse } from "yaml";
import {
  Button,
  Dropdown,
  Input,
  Menu,
  Message,
  Modal,
  Radio,
  Skeleton,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconCheck,
  IconCheckCircleFill,
  IconCode,
  IconDelete,
  IconDown,
  IconEdit,
  IconExclamationCircle,
  IconFile,
  IconMore,
  IconPlayArrow,
  IconRefresh,
  IconRight,
} from "@arco-design/web-react/icon";
import {
  api,
  ago,
  cached,
  can,
  err,
  formatDuration,
  fullTime,
  isVersionPlatformReleased,
  platformShort,
  putCached,
  useAIStatus,
  versionVerifiedPlatforms,
} from "./shared";
import type {
  AppInfo,
  CompVerification,
  CompVerificationsPayload,
  VersionInfo,
} from "./shared";
import { go } from "./router";
import { StatusBadge, UnderlineTabs } from "./ui";
import type { SecSummaryPayload } from "./security";
import { styleOf } from "./glyphs";
import { TopoArt } from "./topoart";
import { Terminal } from "./runbook";
import { bi, useLang } from "./i18n";

const CvIcons: Record<string, React.ReactNode> = {
  versions: (
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
      <path d="M8 2.2L13.5 5 8 7.8 2.5 5 8 2.2Z" />
      <path d="M2.5 8.2L8 11l5.5-2.8" />
      <path d="M2.5 11.2L8 14l5.5-2.8" />
    </svg>
  ),
  flow: (
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
      <circle cx="3.8" cy="4.2" r="1.8" />
      <circle cx="12.2" cy="4.2" r="1.8" />
      <circle cx="8" cy="12" r="1.8" />
      <path d="M5.6 4.2h4.8M4.8 5.8l2.2 4.6M11.2 5.8L9 10.4" />
    </svg>
  ),
  params: (
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
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      <circle cx="5.8" cy="4.5" r="1.5" fill="var(--surface)" />
      <circle cx="10.5" cy="8" r="1.5" fill="var(--surface)" />
      <circle cx="6.8" cy="11.5" r="1.5" fill="var(--surface)" />
    </svg>
  ),
  tests: (
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
      <path d="M5.8 8.1l1.5 1.5 2.9-3" />
    </svg>
  ),
  links: (
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
      <path d="M6.6 9.4l2.8-2.8" />
      <path d="M9.2 10.6l-1.3 1.3a2.4 2.4 0 0 1-3.4-3.4l1.3-1.3" />
      <path d="M6.8 5.4l1.3-1.3a2.4 2.4 0 0 1 3.4 3.4l-1.3 1.3" />
    </svg>
  ),
  about: (
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
      <circle cx="8" cy="8" r="5.5" />
      <path d="M9.8 6.2L8.7 8.7 6.2 9.8l1.1-2.5 2.5-1.1Z" />
    </svg>
  ),
  ops: (
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
      <path d="M2 8.2h2.6l1.7-3.6 2.8 6.8 1.8-3.2H14" />
    </svg>
  ),
  revs: (
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
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2.2 1.4" />
    </svg>
  ),
  source: (
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
      <path d="M5.4 5.2L2.5 8l2.9 2.8M10.6 5.2L13.5 8l-2.9 2.8M9 3.6L7 12.4" />
    </svg>
  ),
};

/* A published component read as one page. Everything a person needs before using or changing it is on the page —
   how it is deployed, what can be tuned, how it is checked, what it connects to — in that order, each part short.
   A rail on the right keeps the shape of the component and a table of contents in view. */

type Any = Record<string, any>;
const getPhases = (): [string, string][] => [
  ["preflight", bi("预检", "Preflight")],
  ["install", bi("安装", "Install")],
  ["configure", bi("配置", "Configure")],
  ["start", bi("启动", "Start")],
  ["provision", bi("初始化", "Provision")],
  ["verify", bi("复核", "Verify")],
];
const effectInfo = (eff?: string): [string, string] => {
  switch (eff || "change") {
    case "read-only":
      return [bi("只读", "Read-only"), "ok"];
    case "change":
      return [bi("修改", "Modify"), ""];
    case "disruptive":
      return [bi("中断服务", "Disruptive"), "bad"];
    case "destructive":
      return [bi("删除数据", "Destructive"), "bad"];
    default:
      return [eff || "", ""];
  }
};
const versionState = (s: string): [string, string] =>
  s === "published"
    ? ["done", bi("已发布", "Published")]
    : ["idle", bi("未发布", "Unpublished")];
const show = (v: unknown) =>
  v === undefined || v === null || v === "" ? "—" : String(v);
type Rev = {
  rev: number;
  time: string;
  user: string;
  note?: string;
  added: number;
  removed: number;
  changed: number;
};

const Steps = memo(function Steps({
  steps,
  start = 1,
}: {
  steps: Any[];
  start?: number;
}) {
  useLang();
  return (
    <ol className="cv-steps">
      {steps.map((s, i) => {
        const [label, tone] = effectInfo(s.effect);
        return (
          <li key={i}>
            <span className="cv-n">{start + i}</span>
            <div>
              <div className="cv-step-top">
                <b>{s.title || s.id}</b>
                <span
                  className={`flag ${tone === "ok" ? "cv-ok" : tone === "bad" ? "bad" : "cv-mute"}`}
                >
                  {label}
                </span>
                {s.run ? (
                  <span className="mono faint small">
                    {s.run.role}/{s.run.tasks}
                  </span>
                ) : s.tasks ? (
                  <span className="faint small">
                    {bi(`${s.tasks.length} 个内联任务`, `${s.tasks.length} inline task(s)`)}
                  </span>
                ) : null}
              </div>
              {s.desc && <p>{s.desc}</p>}
              {s.expect && (
                <p className="cv-expect">
                  {bi("成功的样子：", "Expected: ")}
                  {s.expect}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
});

const statusChoices = (): { v: string; label: string; hint: string }[] => [
  {
    v: "draft",
    label: bi("未发布", "Unpublished"),
    hint: bi("正式交付不可选，仅维护者调试使用", "Blocked from formal deliveries; maintainer use only"),
  },
  {
    v: "published",
    label: bi("已发布", "Published"),
    hint: bi("已测试确认，可用于正式生产交付", "Tested and available for formal production deliveries"),
  },
];

const reportPhaseLabel = (p?: string) => {
  switch (p) {
    case "deploy":
      return bi("部署", "Deploy");
    case "tests":
      return bi("服务验证", "Service Verify");
    case "endpoint":
      return bi("入口检查", "Endpoint Check");
    default:
      return bi("步骤", "Step");
  }
};

/** Simple 2-state modal for external components (which have no OS deployment). */
function ExternalVersionStatus({
  name,
  v,
  onDone,
}: {
  name: string;
  v: VersionInfo;
  onDone?: () => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const current = v.status === "published" ? "published" : "draft";
  const [status, setStatus] = useState(current);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const busyLockRef = useRef(false);
  const choices = statusChoices();
  const save = async () => {
    if (busyLockRef.current) return;
    busyLockRef.current = true;
    setBusy(true);
    try {
      await api(
        `/api/components/${encodeURIComponent(name)}/versions/${encodeURIComponent(v.id)}/status`,
        {
          method: "POST",
          body: JSON.stringify({
            status,
            test_mode: status === "published" ? "manual" : undefined,
            note: note.trim() || undefined,
          }),
        },
      );
      Message.success(
        bi(
          `版本 ${v.id} 已改为「${choices.find((c) => c.v === status)?.label}」`,
          `Version ${v.id} updated to "${choices.find((c) => c.v === status)?.label}"`,
        ),
      );
      setOpen(false);
      window.dispatchEvent(new Event("mh-apps-changed"));
      onDone?.();
    } catch (e) {
      err(e);
    } finally {
      busyLockRef.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      {can("component.publish") && (
        <Button
          size="mini"
          icon={<IconEdit />}
          onClick={() => {
            setStatus(current);
            setNote("");
            setOpen(true);
          }}
        >
          {bi("改状态", "Set status")}
        </Button>
      )}
      <Modal
        visible={open}
        title={bi(`版本 ${v.id} 发布状态`, `Version ${v.id} Status`)}
        okText={bi("保存", "Save")}
        confirmLoading={busy}
        onOk={save}
        onCancel={() => !busy && setOpen(false)}
        okButtonProps={{ disabled: status === current }}
      >
        <Radio.Group
          direction="vertical"
          value={status}
          onChange={setStatus}
          className="cv-vradio"
        >
          {choices.map((c) => (
            <Radio key={c.v} value={c.v}>
              <b>{c.label}</b>
              <span className="faint small"> {c.hint}</span>
            </Radio>
          ))}
        </Radio.Group>
        <label className="cv-vnote">
          <span>{bi("说明（可选）", "Notes (optional)")}</span>
          <Input.TextArea
            value={note}
            onChange={setNote}
            maxLength={200}
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
        </label>
      </Modal>
    </>
  );
}

/** Self-contained automated test report viewer, completely decoupled from temporary test deliveries. */
function AutoTestReportModal({
  rec,
  compId,
  compName,
  canDelete,
  onClose,
  onDeleted,
}: {
  rec: CompVerification | null;
  compId: string;
  compName: string;
  canDelete: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  useLang();
  const [deleting, setDeleting] = useState(false);
  const deletingLockRef = useRef(false);
  if (!rec) return null;
  const steps = rec.steps || [];

  const confirmDelete = () => {
    Modal.confirm({
      title: bi("删除这份自动化测试报告？", "Delete this automated test report?"),
      content: bi(
        `仅移除 ${rec.version} · ${platformShort(rec.platform)} 的自动化测试报告，不影响当前已发布状态。`,
        `Removes only the saved automated test report for ${rec.version} · ${platformShort(rec.platform)}; release status is unaffected.`,
      ),
      okText: bi("删除报告", "Delete"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (deletingLockRef.current) return;
        deletingLockRef.current = true;
        setDeleting(true);
        try {
          await api(
            `/api/components/${encodeURIComponent(compId)}/verifications/${encodeURIComponent(rec.id)}`,
            { method: "DELETE" },
          );
          Message.success(bi("已删除测试报告", "Test report deleted"));
          onClose();
          onDeleted();
        } catch (e) {
          err(e);
        } finally {
          deletingLockRef.current = false;
          setDeleting(false);
        }
      },
    });
  };

  return (
    <Modal
      visible={!!rec}
      onCancel={onClose}
      className="cv-report-modal"
      style={{ width: 720, maxWidth: "calc(100vw - 32px)" }}
      title={
        <div className="cv-rep-title">
          <OsLogo id={rec.platform} size={16} />
          <span>
            {bi("自动化测试报告", "Automated Test Report")} · {compName}{" "}
            <span className="mono">{rec.version}</span> ·{" "}
            {platformShort(rec.platform)}
          </span>
        </div>
      }
      footer={
        <div className="cv-pm-foot">
          <div className="cv-pm-foot-l">
            {canDelete && (
              <Button
                type="text"
                status="danger"
                size="small"
                icon={<IconDelete />}
                loading={deleting}
                onClick={confirmDelete}
              >
                {bi("删除报告", "Delete Report")}
              </Button>
            )}
          </div>
          <div className="cv-pm-foot-r">
            <Button type="primary" onClick={onClose}>
              {bi("关闭", "Close")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="cv-rep-body">
        <div className="cv-rep-banner">
          <div className="cv-rep-banner-l">
            <span className="cv-rep-pass">
              <IconCheckCircleFill />
              {bi("全步通过", "All Steps Passed")}
            </span>
            {rec.stale && (
              <span className="cv-os-pill stale">
                {bi("剧本有变更 · 建议复测", "Changed · Retest advised")}
              </span>
            )}
          </div>
          <div className="cv-rep-banner-r faint small">
            <span>{rec.verified_by}</span>
            <span>·</span>
            <span className="num">{fullTime(rec.verified_at)}</span>
          </div>
        </div>

        <div className="cv-rep-kpis">
          <div className="cv-rep-kpi">
            <span>{bi("通过步骤", "Passed Steps")}</span>
            <b
              className="num ok"
              title={`${rec.passed_steps ?? 0} / ${rec.total_steps ?? 0}`}
            >
              {rec.passed_steps ?? 0} / {rec.total_steps ?? 0}
            </b>
          </div>
          <div className="cv-rep-kpi">
            <span>{bi("总耗时", "Duration")}</span>
            <b
              className="num"
              title={rec.duration_sec ? formatDuration(rec.duration_sec) : "—"}
            >
              {rec.duration_sec ? formatDuration(rec.duration_sec) : "—"}
            </b>
          </div>
          <div className="cv-rep-kpi">
            <span>{bi("拓扑方案", "Topology")}</span>
            <b
              title={`${rec.scheme_name || rec.topology || bi("标准方案", "Standard")}${
                rec.hosts
                  ? bi(` · ${rec.hosts} 台主机`, ` · ${rec.hosts} hosts`)
                  : ""
              }`}
            >
              {rec.scheme_name || rec.topology || bi("标准方案", "Standard")}
              {rec.hosts
                ? bi(` · ${rec.hosts} 台主机`, ` · ${rec.hosts} hosts`)
                : ""}
            </b>
          </div>
          <div className="cv-rep-kpi">
            <span>{bi("执行环境", "Runner")}</span>
            <b
              className="mono"
              title={rec.executor || bi("平台自动执行", "Automated")}
            >
              {rec.executor || bi("平台自动执行", "Automated")}
            </b>
          </div>
        </div>

        {rec.note && (
          <div className="cv-rep-note">
            <span>{bi("说明：", "Note: ")}</span>
            {rec.note}
          </div>
        )}

        <div className="cv-rep-steps-wrap">
          <div className="cv-rep-steps-head">
            <b>{bi("分步测试明细", "Step-by-Step Results")}</b>
            <span className="faint small">
              {bi(
                "已独立归档于组件库，与临时测试交付解耦",
                "Archived independently on this component",
              )}
            </span>
          </div>
          {steps.length > 0 ? (
            <div className="cv-rep-table-scroll">
              <table className="cv-rep-table">
                <thead>
                  <tr>
                    <th style={{ width: 42 }}>#</th>
                    <th style={{ width: 92 }}>{bi("阶段", "Phase")}</th>
                    <th>{bi("测试步骤", "Step")}</th>
                    <th style={{ width: 76 }}>{bi("结果", "Result")}</th>
                    <th style={{ width: 84, textAlign: "right" }}>
                      {bi("耗时", "Time")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((st, idx) => (
                    <tr key={st.key || idx}>
                      <td className="num faint">{idx + 1}</td>
                      <td>
                        <span className={`cv-rep-phase ph-${st.phase || "deploy"}`}>
                          {reportPhaseLabel(st.phase)}
                        </span>
                      </td>
                      <td className="cv-rep-step-title">{st.title || st.key}</td>
                      <td>
                        <span className="cv-rep-st-ok">
                          <IconCheckCircleFill />
                          {st.state === "resolved"
                            ? bi("已处理", "Resolved")
                            : bi("通过", "Pass")}
                        </span>
                      </td>
                      <td className="num faint" style={{ textAlign: "right" }}>
                        {st.duration_sec
                          ? formatDuration(st.duration_sec)
                          : "< 1s"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="cv-rep-empty faint small">
              {bi(
                `该历史自动化测试已记录汇总结果（${rec.passed_steps ?? 0}/${rec.total_steps ?? 0} 步全步通过${rec.duration_sec ? ` · 耗时 ${formatDuration(rec.duration_sec)}` : ""}）；重新运行一次自动化测试后即可展示完整分步明细。`,
                `Summary recorded (${rec.passed_steps ?? 0}/${rec.total_steps ?? 0} steps passed); run an automated test again to capture per-step breakdown.`,
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Clean decoupled OS release modal supporting 2 explicit test modes:
 *  - automatic: backed by a self-contained automated test report (with full step breakdown)
 *  - manual   : human sign-off after manual/offline testing (no automated report) */
function PublishVersionModal({
  open,
  onClose,
  compId,
  compName,
  verifyAppId,
  version,
  initialPlatform,
  records,
  onInspectReport,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  compId: string;
  compName: string;
  verifyAppId: string;
  version: VersionInfo | null;
  initialPlatform?: string;
  records: CompVerification[];
  onInspectReport: (rec: CompVerification) => void;
  onSuccess: () => void;
}) {
  useLang();
  const platforms = version?.platforms || [];
  const verifiedSet = useMemo(
    () => new Set(version ? versionVerifiedPlatforms(version) : []),
    [version],
  );
  const recByPl = useMemo(() => {
    const m = new Map<string, CompVerification>();
    if (!version) return m;
    for (const r of records) {
      if (r.version === version.id && !m.has(r.platform)) {
        m.set(r.platform, r);
      }
    }
    return m;
  }, [records, version]);

  const [selectedPls, setSelectedPls] = useState<string[]>([]);
  const [testMode, setTestMode] = useState<"automatic" | "manual">("automatic");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const busyLockRef = useRef(false);

  useEffect(() => {
    if (!open || !version) return;
    let initPls: string[] = [];
    if (initialPlatform && platforms.includes(initialPlatform)) {
      initPls = [initialPlatform];
    } else {
      const unpub = platforms.filter((p) => !verifiedSet.has(p));
      initPls = unpub.length > 0 ? unpub : platforms.slice(0, 1);
    }
    setSelectedPls(initPls);
    const allHaveAuto =
      initPls.length > 0 && initPls.every((p) => recByPl.get(p)?.has_report);
    setTestMode(allHaveAuto ? "automatic" : "manual");
    setNote("");
  }, [open, version?.id, initialPlatform]);

  if (!version) return null;

  const togglePl = (p: string) => {
    setSelectedPls((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  };

  const missingAutoPls = selectedPls.filter((p) => !recByPl.get(p)?.has_report);
  const canSubmit =
    selectedPls.length > 0 &&
    (testMode === "manual" || missingAutoPls.length === 0);

  const launchVerify = (pl: string) => {
    onClose();
    go({
      name: "new",
      app: verifyAppId,
      verify: "1",
      ver: verifyAppId === compId ? version.id : undefined,
      platform: pl,
    });
  };

  const submit = async () => {
    if (!canSubmit || busyLockRef.current) return;
    busyLockRef.current = true;
    setBusy(true);
    try {
      await api(
        `/api/components/${encodeURIComponent(compId)}/versions/${encodeURIComponent(version.id)}/status`,
        {
          method: "POST",
          body: JSON.stringify({
            status: "published",
            platforms: selectedPls,
            test_mode: testMode,
            note: note.trim() || undefined,
          }),
        },
      );
      Message.success(
        bi(
          `已发布 ${compName} ${version.id}（${selectedPls.map(platformShort).join("、")} · ${testMode === "automatic" ? "自动化测试" : "手动测试"}）`,
          `Published ${compName} ${version.id} (${selectedPls.map(platformShort).join(", ")} · ${testMode === "automatic" ? "Auto Test" : "Manual Test"})`,
        ),
      );
      onClose();
      window.dispatchEvent(new Event("mh-apps-changed"));
      onSuccess();
    } catch (e) {
      err(e);
    } finally {
      busyLockRef.current = false;
      setBusy(false);
    }
  };

  const singleSelected = selectedPls.length === 1 ? selectedPls[0] : "";
  const canRevokeSingle = Boolean(
    singleSelected &&
      version.status === "published" &&
      verifiedSet.has(singleSelected),
  );

  const revokeOS = (pl: string) => {
    Modal.confirm({
      title: bi(
        `下线 ${platformShort(pl)} 的发布状态？`,
        `Unpublish ${platformShort(pl)}?`,
      ),
      content: bi(
        `下线后，正式交付将无法为 ${compName} ${version.id} 选择 ${platformShort(pl)}；维护者仍可随时发起测试部署，历史交付不受影响。`,
        `Formal deliveries will no longer allow ${platformShort(pl)} for ${compName} ${version.id}. Existing deliveries are unaffected.`,
      ),
      okText: bi("确认下线", "Unpublish"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (busyLockRef.current) return;
        busyLockRef.current = true;
        setBusy(true);
        try {
          await api(
            `/api/components/${encodeURIComponent(compId)}/versions/${encodeURIComponent(version.id)}/status`,
            {
              method: "POST",
              body: JSON.stringify({ revoke_platform: pl }),
            },
          );
          Message.success(
            bi(
              `已下线 ${platformShort(pl)}`,
              `Unpublished ${platformShort(pl)}`,
            ),
          );
          onClose();
          window.dispatchEvent(new Event("mh-apps-changed"));
          onSuccess();
        } catch (e) {
          err(e);
        } finally {
          busyLockRef.current = false;
          setBusy(false);
        }
      },
    });
  };

  return (
    <Modal
      visible={open}
      className="cv-promote-modal"
      style={{ width: 600, maxWidth: "calc(100vw - 32px)" }}
      title={bi(
        `发布版本 · ${compName} ${version.id}`,
        `Publish Version · ${compName} ${version.id}`,
      )}
      onCancel={() => !busy && onClose()}
      footer={
        <div className="cv-pm-foot">
          <div className="cv-pm-foot-l">
            {canRevokeSingle && (
              <Button
                type="text"
                status="danger"
                size="small"
                disabled={busy}
                onClick={() => revokeOS(singleSelected)}
              >
                {bi(
                  `下线 ${platformShort(singleSelected)}`,
                  `Unpublish ${platformShort(singleSelected)}`,
                )}
              </Button>
            )}
          </div>
          <div className="cv-pm-foot-r">
            <Button disabled={busy} onClick={onClose}>
              {bi("取消", "Cancel")}
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={!canSubmit}
              onClick={submit}
            >
              {bi("确认发布", "Publish")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="cv-pm-body">
        <div className="cv-pm-sec">
          <div className="cv-pm-label">
            {bi("1. 选择要发布的操作系统", "1. Target Operating System(s)")}
            <span className="faint small" style={{ fontWeight: 400, marginLeft: 6 }}>
              {bi("可多选", "Multi-select")}
            </span>
          </div>
          <div className="cv-pm-os-pills">
            {platforms.map((p) => {
              const checked = selectedPls.includes(p);
              const pub = version.status === "published" && verifiedSet.has(p);
              const rec = recByPl.get(p);
              return (
                <button
                  key={p}
                  type="button"
                  className={`cv-pm-os-pill ${checked ? "on" : ""}`}
                  onClick={() => togglePl(p)}
                >
                  <span className={`cv-pm-chk ${checked ? "on" : ""}`} aria-hidden>
                    {checked && <IconCheck />}
                  </span>
                  <OsLogo id={p} size={14} />
                  <span>{platformShort(p)}</span>
                  {rec?.has_report ? (
                    <span className="cv-os-pill auto">
                      {bi("有自动报告", "Auto report")}
                    </span>
                  ) : pub ? (
                    <span className="cv-os-pill ok">
                      {bi("已发布", "Published")}
                    </span>
                  ) : (
                    <span className="cv-os-pill draft">
                      {bi("未发布", "Unpublished")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="cv-pm-sec">
          <div className="cv-pm-label">
            {bi("2. 选择测试方式", "2. Testing Mode")}
          </div>
          <div className="cv-pm-modes" role="radiogroup">
            <button
              type="button"
              role="radio"
              aria-checked={testMode === "automatic"}
              className={`cv-pm-mode ${testMode === "automatic" ? "on" : ""}`}
              onClick={() => setTestMode("automatic")}
            >
              <div className="cv-pm-mode-top">
                <span className="cv-pm-radio" aria-hidden />
                <b>{bi("自动化测试", "Automated Test")}</b>
                <span className="cv-mode-chip auto">
                  {bi("含完整报告", "Full Report")}
                </span>
              </div>
              <p>
                {bi(
                  "结合平台自动执行部署与验证步骤，自动归档分步状态与耗时报告，与交付记录解耦。",
                  "Uses automated test runs and archives a self-contained step-by-step report.",
                )}
              </p>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={testMode === "manual"}
              className={`cv-pm-mode ${testMode === "manual" ? "on" : ""}`}
              onClick={() => setTestMode("manual")}
            >
              <div className="cv-pm-mode-top">
                <span className="cv-pm-radio" aria-hidden />
                <b>{bi("手动测试", "Manual Test")}</b>
                <span className="cv-mode-chip manual">
                  {bi("无完整报告", "No Report")}
                </span>
              </div>
              <p>
                {bi(
                  "已在线下或外部环境人工验证，直接人工签核发布，仅记录发布人与备注。",
                  "Signed off manually after offline/external testing without an automated report.",
                )}
              </p>
            </button>
          </div>

          {testMode === "automatic" ? (
            <div className="cv-pm-auto-box">
              {selectedPls.length === 0 ? (
                <p className="faint small" style={{ margin: 0 }}>
                  {bi("请先在上方勾选至少一个操作系统。", "Select at least one OS above.")}
                </p>
              ) : (
                selectedPls.map((p) => {
                  const rec = recByPl.get(p);
                  if (rec?.has_report) {
                    return (
                      <div key={p} className="cv-pm-auto-row ok">
                        <div className="cv-pm-auto-l">
                          <IconCheckCircleFill className="ok-ic" />
                          <OsLogo id={p} size={14} />
                          <b>{platformShort(p)}</b>
                          <span className="num">
                            {rec.passed_steps}/{rec.total_steps}
                            {bi(" 步通过", " passed")}
                            {rec.duration_sec
                              ? ` · ${formatDuration(rec.duration_sec)}`
                              : ""}
                          </span>
                          <span className="faint small">
                            · {ago(rec.verified_at)}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="cv-report-btn"
                          onClick={() => onInspectReport(rec)}
                        >
                          <IconFile />
                          {bi("查看报告", "Report")}
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div key={p} className="cv-pm-auto-row miss">
                      <div className="cv-pm-auto-l">
                        <IconExclamationCircle className="warn-ic" />
                        <OsLogo id={p} size={14} />
                        <b>{platformShort(p)}</b>
                        <span className="faint small">
                          {bi(
                            "暂无自动化测试报告，可发起测试部署或改用手动测试",
                            "No automated test report yet",
                          )}
                        </span>
                      </div>
                      {can("component.edit|component.publish") && (
                        <Button
                          size="mini"
                          type="outline"
                          icon={<IconPlayArrow />}
                          onClick={() => launchVerify(p)}
                        >
                          {bi("去测试部署", "Test Deploy")}
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <div className="cv-pm-manual-hint">
              {bi(
                "手动测试为人工签核发布，不关联交付记录、不生成分步报告；后续如运行自动化测试，系统会自动补充完整测试报告。",
                "Manual test records human sign-off with no delivery coupling or step report. Running an automated test later will automatically attach a full report.",
              )}
            </div>
          )}
        </div>

        <label className="cv-vnote">
          <span>{bi("3. 发布说明（可选）", "3. Release note (optional)")}</span>
          <Input
            value={note}
            onChange={setNote}
            maxLength={160}
            placeholder={
              testMode === "automatic"
                ? bi(
                    "例如：三节点高可用与故障转移自动化测试通过",
                    "e.g. 3-node HA & failover passed automated testing",
                  )
                : bi(
                    "例如：已在测试环境手动验证安装与主从切换",
                    "e.g. Manually verified install & failover on staging VMs",
                  )
            }
          />
        </label>
      </div>
    </Modal>
  );
}

export function ComponentPanes({
  entry,
  yaml,
  admin,
  error,
  onRetry,
}: {
  entry: AppInfo & { source: string; broken?: boolean; problem?: string };
  yaml: string | null;
  admin: boolean;
  error: string;
  onRetry?: () => void;
}) {
  const lang = useLang();
  const revsUrl = `/api/components/${encodeURIComponent(entry.id)}/revisions`;
  const verifUrl = `/api/components/${encodeURIComponent(entry.id)}/verifications`;
  const [revs, setRevs] = useState<Rev[] | null>(
    () => cached<Rev[]>(revsUrl) ?? null,
  );
  const [verif, setVerif] = useState<CompVerificationsPayload | null>(
    () => cached<CompVerificationsPayload>(verifUrl) ?? null,
  );
  const [secSummary, setSecSummary] = useState<SecSummaryPayload | null>(
    () => cached<SecSummaryPayload>("/api/security/summary") ?? null,
  );
  const [verifTick, setVerifTick] = useState(0);
  const [publishTarget, setPublishTarget] = useState<{
    v: VersionInfo;
    platform?: string;
  } | null>(null);
  const [reportRec, setReportRec] = useState<CompVerification | null>(null);
  const [active, setActive] = useState("versions");
  const box = useRef<HTMLDivElement>(null);
  const lock = useRef(0); // while a click is scrolling the page, the table of contents keeps the clicked entry
  const [srcOpen, setSrcOpen] = useState(false);
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null); // the part the reader just asked for, briefly lit
  const [phase, setPhase] = useState("");
  const tocRef = useRef<HTMLElement>(null);
  const flashTimerRef = useRef<number>(0);
  const scrollRafRef = useRef<number>(0);
  const revokeLockRef = useRef(false);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
      if (scrollRafRef.current) window.cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);
  const manifest = useMemo(() => {
    if (yaml === null) return {value:null as Any | null,error:""};
    try {
      const value=parse(yaml);
      if(!value || typeof value!=="object" || Array.isArray(value))throw new Error(bi("清单应为一个对象", "Manifest must be a mapping object"));
      const checkReferences=(v:any):void=>{
        if(!v || typeof v!=="object")return;
        if(Object.prototype.hasOwnProperty.call(v,"$file"))throw new Error(bi("清单引用尚未展开，请刷新页面；如仍有问题，请在组件编辑器检查引用文件", "Manifest references are not expanded; refresh the page or inspect referenced files in the editor"));
        Object.values(v).forEach(checkReferences);
      };
      checkReferences(value);
      for(const key of ["requires","params","roles","versions","tests","cleanup","endpoints","ports","secrets","inputs","flows","groups"]){
        if(value[key]!=null && !Array.isArray(value[key]))throw new Error(key+bi(" 应为列表，请在组件编辑器修正", " must be a list; fix in the component editor"));
      }
      for(const key of ["lifecycle"]){
        if(value[key]!=null && (typeof value[key]!=="object" || Array.isArray(value[key])))throw new Error(key+bi(" 应为阶段映射", " must be a phase map"));
        for(const steps of Object.values(value[key] || {}))if(!Array.isArray(steps))throw new Error(key+bi(" 的阶段应为步骤列表", " phases must be step lists"));
      }
      return {value:value as Any,error:""};
    } catch(e) {return {value:null as Any | null,error:String(e instanceof Error?e.message:e)};}
  }, [yaml, lang]);
  const c=manifest.value;
  const draftOnly = entry.source === "draft";
  useEffect(() => {
    if (!admin || draftOnly) return;
    const hit = cached<Rev[]>(revsUrl);
    if (hit !== undefined) setRevs(hit);
    api<Rev[]>(revsUrl)
      .then((r) => {
        const revList = [...r].reverse();
        putCached(revsUrl, revList);
        setRevs(revList);
      })
      .catch(() => setRevs((prev) => prev ?? []));
  }, [admin, draftOnly, entry.id, entry.source, revsUrl, lang, verifTick]);

  useEffect(() => {
    if (draftOnly) return;
    const hit = cached<CompVerificationsPayload>(verifUrl);
    if (hit !== undefined) setVerif(hit);
    api<CompVerificationsPayload>(verifUrl)
      .then((r) => {
        putCached(verifUrl, r);
        setVerif(r);
      })
      .catch(() => setVerif((prev) => prev ?? { current_manifest: "", records: [], candidates: [] }));
  }, [draftOnly, entry.id, entry.source, verifUrl, lang, verifTick]);

  useEffect(() => {
    if (draftOnly || !can("security.view")) return;
    api<SecSummaryPayload>("/api/security/summary")
      .then((r) => {
        putCached("/api/security/summary", r);
        setSecSummary(r);
      })
      .catch(() => {});
  }, [draftOnly, entry.id]);

  useEffect(() => {
    const bump = () => setVerifTick((n) => n + 1);
    window.addEventListener("mh-apps-changed", bump);
    return () => window.removeEventListener("mh-apps-changed", bump);
  }, []);

  const lifecycle: Record<string, Any[]> = c?.lifecycle || {};
  const params: Any[] = c?.params || [];
  const stepCount = Object.values(lifecycle).reduce((n, l) => n + l.length, 0);
  const external = entry.kind === "external" || c?.kind === "external";
  const sections: [string, string, number | undefined][] = [
    ["versions", bi("版本", "Versions"), entry.versions.length],
    ...(external
      ? []
      : ([["flow", bi("部署流程", "Deploy Flow"), stepCount]] as [string, string, number][])),
    ["params", bi("参数", "Parameters"), params.length],
    [
      "tests",
      bi("验证与清理", "Tests & Cleanup"),
      (c?.tests?.length || 0) + (c?.cleanup?.length || 0),
    ],
    [
      "links",
      bi("入口与关系", "Endpoints & Relations"),
      (c?.endpoints?.length || 0) +
        (c?.requires?.length || 0) +
        (c?.ports?.length || 0),
    ],
    [
      "about",
      bi("能力与限制", "Capabilities & Limits"),
      (c?.detail?.capabilities?.length || 0) +
        (c?.detail?.limits?.length || 0) || undefined,
    ],
    ...(external
      ? []
      : ([
          [
            "ops",
            bi("运维知识", "Operations"),
            (entry.operations?.checks?.length || 0) +
              (entry.operations?.faults?.length || 0) || undefined,
          ],
        ] as [string, string, number | undefined][])),
    ...(admin
      ? ([["revs", bi("修订", "Revisions"), revs?.length]] as [
          string,
          string,
          number | undefined,
        ][])
      : []),
    ["source", bi("清单源码", "Manifest Source"), yaml ? yaml.split("\n").length : undefined],
  ];

  // the table of contents follows the reader
  useEffect(() => {
    const root = box.current;
    if (!root || !c) return;
    let raf = 0;

    const findScrollParent = (el: HTMLElement): HTMLElement | null => {
      let p = el.parentElement;
      while (
        p &&
        !(
          /(auto|scroll)/.test(getComputedStyle(p).overflowY) &&
          p.scrollHeight > p.clientHeight + 1
        )
      ) {
        p = p.parentElement;
      }
      return p || (document.scrollingElement as HTMLElement | null);
    };

    const compute = () => {
      if (Date.now() < lock.current) return;
      const secs = Array.from(
        root.querySelectorAll<HTMLElement>("section[id^='cv-']"),
      );
      if (!secs.length) return;

      const sc = findScrollParent(secs[0]);
      const isDoc =
        !sc ||
        sc === document.scrollingElement ||
        sc === document.documentElement ||
        sc === document.body;
      const viewTop = isDoc ? 0 : sc.getBoundingClientRect().top;
      const viewH = isDoc ? window.innerHeight : sc.clientHeight;
      const scrollTop = isDoc ? window.scrollY : sc.scrollTop;
      const maxScroll = sc ? Math.max(0, sc.scrollHeight - viewH) : 0;
      const remaining = Math.max(0, maxScroll - scrollTop);

      if (maxScroll > 2 && remaining <= 6) {
        setActive(secs[secs.length - 1].id.replace(/^cv-/, ""));
        return;
      }

      const baseOffset = Math.min(104, viewH * 0.2);
      const bottomOffset = Math.max(baseOffset, viewH - 24);
      const tailSpan =
        maxScroll > 2 ? Math.min(maxScroll, Math.max(180, viewH * 0.6)) : 0;
      const tailProgress =
        tailSpan > 0 ? Math.max(0, Math.min(1, 1 - remaining / tailSpan)) : 0;
      const anchorY =
        viewTop + baseOffset + tailProgress * (bottomOffset - baseOffset);

      let chosen = secs[0];
      for (const sec of secs) {
        if (sec.getBoundingClientRect().top <= anchorY) chosen = sec;
      }
      setActive(chosen.id.replace(/^cv-/, ""));
    };

    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        compute();
      });
    };

    compute();
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [c]);

  if (draftOnly) return null;
  const loadErr = error || manifest.error;
  if (loadErr) {
    if (entry.broken && !c) return null;
    const missingShared =
      /\$file|common|shared|reference|missing|公共|引用|not found|no such file|不存在/i.test(
        loadErr,
      );
    return (
      <div className="cv-err-panel" role="alert">
        <div className="cv-err-head">
          <IconExclamationCircle className="cv-err-ic" />
          <div>
            <b>{bi("组件清单暂时无法载入", "Component manifest failed to load")}</b>
            <p>
              {missingShared
                ? bi(
                    "检测到清单引用或共享流程文件缺失，请确认平台公共流程（platform-shared）或组件内的被引用文件是否存在。",
                    "Missing manifest reference or shared flow file; verify platform-shared and referenced files in this component.",
                  )
                : bi(
                    "清单语法或字段结构未通过校验，请在组件编辑器中检查修正后重新载入。",
                    "Manifest syntax or schema validation failed; fix it in the component editor and reload.",
                  )}
            </p>
          </div>
        </div>
        <pre className="cv-err-detail mono">{loadErr}</pre>
        <div className="cv-err-acts">
          {onRetry && (
            <Button size="small" icon={<IconRefresh />} onClick={onRetry}>
              {bi("重新载入", "Reload")}
            </Button>
          )}
          {admin && (
            <Button
              size="small"
              type="primary"
              icon={<IconEdit />}
              onClick={() =>
                go({ name: "components", id: entry.id, edit: "overview" })
              }
            >
              {bi("打开编辑器排障", "Open Editor")}
            </Button>
          )}
          {admin && (
            <Button
              size="small"
              icon={<IconCode />}
              onClick={() =>
                go({
                  name: "components",
                  id: "platform-shared",
                  edit: "files",
                })
              }
            >
              {bi("检查平台公共流程", "Check Platform Shared Flows")}
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (c === null) return <Skeleton animation text={{ rows: 8 }} />;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lightUp = (id: string) => {
    setFlash({ id, n: Date.now() });
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(
      () => setFlash((f) => (f && f.id === id ? null : f)),
      2000,
    );
  };
  // The browser's own smooth scrolling takes longer the further it goes; this always takes about a third of a second,
  // so jumping across the whole page is as quick as jumping to the next part.
  const scrollTo = (id: string, where: "start" | "center") => {
    const el = document.getElementById(id);
    if (!el) return;
    // the page may scroll in the window or in a pane around it; find whichever really scrolls
    let sc: HTMLElement | null = el.parentElement;
    while (
      sc &&
      !(
        /(auto|scroll)/.test(getComputedStyle(sc).overflowY) &&
        sc.scrollHeight > sc.clientHeight + 1
      )
    )
      sc = sc.parentElement;
    const top = (sc ? sc.getBoundingClientRect().top : 0) + 76;
    const viewH = sc ? sc.clientHeight : window.innerHeight;
    const cur = () => (sc ? sc.scrollTop : window.scrollY);
    const set = (y: number) =>
      sc ? (sc.scrollTop = y) : window.scrollTo(0, y);
    const r = el.getBoundingClientRect();
    const target = Math.max(
      0,
      cur() +
        r.top -
        (where === "start"
          ? top
          : (viewH - r.height) / 2 + (sc ? sc.getBoundingClientRect().top : 0)),
    );
    if (scrollRafRef.current) {
      window.cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = 0;
    }
    if (reduced) return set(target);
    const from = cur();
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 360);
      set(from + (target - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) scrollRafRef.current = window.requestAnimationFrame(step);
      else scrollRafRef.current = 0;
    };
    scrollRafRef.current = window.requestAnimationFrame(step);
  };
  const jump = (id: string) => {
    lock.current = Date.now() + 700;
    setActive(id);
    setPhase("");
    scrollTo(`cv-${id}`, "start");
    lightUp(`cv-${id}`);
  };
  const jumpPhase = (id: string) => {
    lock.current = Date.now() + 700;
    setActive("flow");
    setPhase(id);
    scrollTo(`cv-ph-${id}`, "center");
    lightUp(`cv-ph-${id}`);
  };
  const lit = (id: string) => (flash?.id === id ? "lit" : "");
  const st = styleOf(entry.id, entry.category, entry.icon, entry.color);
  const phases = getPhases();
  const verifyAppId = entry.context || c?.context || entry.id;
  const canVerify = can("component.edit|component.publish");
  const canPublish = can("component.publish");
  const verifRecords = verif?.records || [];

  const confirmUnpublishAll = (verId: string) => {
    Modal.confirm({
      title: bi(`下线版本 ${verId} 的全部系统？`, `Unpublish all OSes for version ${verId}?`),
      content: bi(
        "下线后，该版本所有操作系统将暂停正式交付；维护者仍可随时发起测试部署或重新发布，已生成的历史交付不受影响。",
        "Formal deliveries will be paused for all OSes of this version. Maintainers can still test or republish anytime; existing deliveries are unaffected.",
      ),
      okText: bi("确认下线", "Unpublish"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (revokeLockRef.current) return;
        revokeLockRef.current = true;
        try {
          await api(
            `/api/components/${encodeURIComponent(entry.id)}/versions/${encodeURIComponent(verId)}/status`,
            { method: "POST", body: JSON.stringify({ status: "draft" }) },
          );
          Message.success(
            bi(
              `版本 ${verId} 已全部下线（未发布）`,
              `Version ${verId} unpublished`,
            ),
          );
          window.dispatchEvent(new Event("mh-apps-changed"));
          setVerifTick((n) => n + 1);
        } catch (e) {
          err(e);
        } finally {
          revokeLockRef.current = false;
        }
      },
    });
  };

  const confirmRevokeOS = (verId: string, pl: string) => {
    Modal.confirm({
      title: bi(
        `下线 ${platformShort(pl)} 的发布状态？`,
        `Unpublish ${platformShort(pl)}?`,
      ),
      content: bi(
        `下线后，正式交付将无法为 ${entry.name} ${verId} 选择 ${platformShort(pl)}；维护者仍可随时测试或重新发布，历史交付不受影响。`,
        `Formal deliveries will no longer allow ${platformShort(pl)} for ${entry.name} ${verId}. Existing deliveries are unaffected.`,
      ),
      okText: bi("确认下线", "Unpublish"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (revokeLockRef.current) return;
        revokeLockRef.current = true;
        try {
          await api(
            `/api/components/${encodeURIComponent(entry.id)}/versions/${encodeURIComponent(verId)}/status`,
            { method: "POST", body: JSON.stringify({ revoke_platform: pl }) },
          );
          Message.success(
            bi(
              `已下线 ${verId} · ${platformShort(pl)}`,
              `Unpublished ${verId} · ${platformShort(pl)}`,
            ),
          );
          window.dispatchEvent(new Event("mh-apps-changed"));
          setVerifTick((n) => n + 1);
        } catch (e) {
          err(e);
        } finally {
          revokeLockRef.current = false;
        }
      },
    });
  };

  return (
    <div className="cv-wrap" ref={box}>
      <UnderlineTabs
        className="cv-utabs"
        label={bi("组件详情分区", "Component detail sections")}
        value={active}
        onChange={jump}
        items={sections.map(([id, label, count]) => ({
          value: id,
          label,
          count,
          icon: CvIcons[id],
        }))}
      />
      <div className="cv2">
        <div className="cv2-main">
          <section id="cv-versions" className={`cv-sec ${lit("cv-versions")}`}>
          <div className="cv-sec-head-row">
            <h2>
              {bi("版本与系统发布状态", "Versions & OS Release Status")}
              <span className="cv-sub">
                {bi(
                  "正式交付按「版本 × 操作系统」放行；未发布版本可随时由维护者发起测试部署，支持「自动化测试（自动生成完整报告）」与「手动测试（人工签核）」两种发布方式",
                  "Formal deliveries require a published Version × OS. Maintainers can test unpublished versions anytime and publish via Automated Test (with full report) or Manual Test.",
                )}
              </span>
            </h2>
          </div>
          <div className="cv-ver-cards">
            {entry.versions.map((v) => {
              const [tone, label] = versionState(v.status);
              const pls = v.platforms || [];
              const verifiedSet = new Set(versionVerifiedPlatforms(v));
              const verifiedCount = pls.filter((p) => verifiedSet.has(p)).length;
              const allPublished =
                v.status === "published" &&
                pls.length > 0 &&
                verifiedCount === pls.length;
              return (
                <div key={v.id} className="cv-ver-card">
                  <div className="cv-ver-head">
                    <div className="cv-ver-head-l">
                      <b className="mono cv-ver-id">{v.id}</b>
                      <StatusBadge state={tone} label={label} />
                      {!external && pls.length > 0 && (
                        <span className="cv-ver-sum num">
                          {v.status === "published"
                            ? allPublished
                              ? bi(
                                  `全部 ${pls.length} 个系统已发布`,
                                  `All ${pls.length} OSes published`,
                                )
                              : bi(
                                  `已发布 ${verifiedCount}/${pls.length} 个系统`,
                                  `${verifiedCount}/${pls.length} OSes published`,
                                )
                            : bi(
                                "正式交付已拦截 · 维护者可随时测试部署",
                                "Blocked from formal delivery · Maintainers can test anytime",
                              )}
                        </span>
                      )}
                    </div>
                    <div className="cv-ver-head-r">
                      {external || !pls.length ? (
                        <ExternalVersionStatus
                          name={entry.id}
                          v={v}
                          onDone={() => setVerifTick((n) => n + 1)}
                        />
                      ) : (
                        <>
                          {canPublish && (
                            <Button
                              size="mini"
                              type={allPublished ? "secondary" : "primary"}
                              onClick={() => setPublishTarget({ v })}
                            >
                              {allPublished
                                ? bi("管理发布", "Manage Release")
                                : bi("发布版本", "Publish")}
                            </Button>
                          )}
                          {canPublish && v.status === "published" && (
                            <Dropdown
                              trigger="click"
                              position="br"
                              droplist={
                                <Menu
                                  onClickMenuItem={(k) => {
                                    if (k === "unpublish")
                                      confirmUnpublishAll(v.id);
                                  }}
                                >
                                  <Menu.Item key="unpublish">
                                    {bi("全部下线（退回未发布）", "Unpublish All OSes")}
                                  </Menu.Item>
                                </Menu>
                              }
                            >
                              <Button
                                size="mini"
                                icon={<IconMore />}
                                aria-label={bi("更多状态操作", "More actions")}
                              />
                            </Dropdown>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {pls.length > 0 ? (
                    <ul className="cv-os-list">
                      {pls.map((p) => {
                        const k = v.coverage?.[p];
                        const released = isVersionPlatformReleased(v, p);
                        const latestRec = verifRecords.find(
                          (r) => r.version === v.id && r.platform === p,
                        );
                        const secRisk =
                          secSummary?.policy?.warn_publish_high !== false
                            ? secSummary?.component_risks?.[
                                `${entry.id}@${v.id}@${p}`
                              ]
                            : undefined;
                        return (
                          <li key={p} className="cv-os-row">
                            <div className="cv-os-main">
                            <div className="cv-os-id">
                              <OsLogo id={p} size={15} />
                              <b>{platformShort(p)}</b>
                              <span
                                className={`cv-os-pill ${released ? "ok" : "draft"}`}
                              >
                                {released
                                  ? bi("已发布", "Published")
                                  : bi("未发布", "Unpublished")}
                              </span>
                              {secRisk && (() => {
                                const mwOnly = Boolean(
                                  secSummary?.policy?.gate_middleware_only ||
                                    secSummary?.policy?.hide_os_cves,
                                );
                                const mwC = secRisk.middleware_critical ?? 0;
                                const mwH = secRisk.middleware_high ?? 0;
                                const osC = secRisk.os_critical ?? 0;
                                const osH = secRisk.os_high ?? 0;
                                const crit = mwOnly ? mwC : secRisk.critical;
                                const high = mwOnly ? mwH : secRisk.high;
                                if (crit <= 0 && high <= 0) return null;
                                const isOSOnly = !mwOnly && mwC === 0 && mwH === 0 && (osC > 0 || osH > 0);
                                return (
                                  <Tooltip
                                    mini
                                    content={bi(
                                      `中间件本体：严重 ${mwC} / 高危 ${mwH}；OS 底层包：严重 ${osC} / 高危 ${osH}（点击前往安全中心查看）`,
                                      `Middleware: ${mwC} Crit / ${mwH} High; OS Base: ${osC} Crit / ${osH} High. Click to inspect.`,
                                    )}
                                  >
                                    <a
                                      href={`#/security/vulns?q=${encodeURIComponent(entry.id)}`}
                                      className={`cv-sec-chip ${crit > 0 ? "crit" : "high"}`}
                                    >
                                      {crit > 0
                                        ? isOSOnly
                                          ? bi(`${crit} OS 严重 CVE`, `${crit} OS Crit`)
                                          : bi(`${crit} 严重 CVE`, `${crit} Crit CVE`)
                                        : isOSOnly
                                          ? bi(`${high} OS 高危 CVE`, `${high} OS High`)
                                          : bi(`${high} 高危 CVE`, `${high} High CVE`)}
                                    </a>
                                  </Tooltip>
                                );
                              })()}
                              {released && latestRec?.stale && (
                                <Tooltip
                                  mini
                                  content={bi(
                                    "组件剧本或清单在上次测试后发生变更；正式交付仍可使用，建议复测刷新报告",
                                    "Component files changed after last test; formal deliveries remain allowed, retest recommended",
                                  )}
                                >
                                  <span className="cv-os-pill stale">
                                    {bi("有变更", "Changed")}
                                  </span>
                                </Tooltip>
                              )}
                            </div>

                            <div className="cv-os-ev">
                              {k && (
                                <a
                                  href={`#/library/${p}`}
                                  className={`cv-lib-chip ${k.deployable ? "ok" : "warn"}`}
                                >
                                  {k.deployable
                                    ? bi("软件库就绪", "Library ready")
                                    : k.ready
                                      ? bi("缺运行环境", "No runtime")
                                      : bi(
                                          `缺 ${k.missing?.length ?? 0} 个包`,
                                          `Missing ${k.missing?.length ?? 0} pkg(s)`,
                                        )}
                                </a>
                              )}
                              {latestRec?.has_report ? (
                                <>
                                  <span className="cv-mode-chip auto">
                                    {bi("自动化测试", "Auto Test")}
                                  </span>
                                  <span className="cv-ev-inline num">
                                    <span>
                                      {latestRec.passed_steps}/{latestRec.total_steps}
                                      {bi(" 步", " steps")}
                                    </span>
                                    {latestRec.duration_sec ? (
                                      <span>· {formatDuration(latestRec.duration_sec)}</span>
                                    ) : null}
                                  </span>
                                  <button
                                    type="button"
                                    className="cv-report-btn"
                                    onClick={() => setReportRec(latestRec)}
                                  >
                                    <IconFile />
                                    {bi("查看报告", "Report")}
                                  </button>
                                </>
                              ) : latestRec ? (
                                <>
                                  <span className="cv-mode-chip manual">
                                    {bi("手动测试", "Manual Test")}
                                  </span>
                                  <Tooltip
                                    mini
                                    content={[
                                      latestRec.verified_by
                                        ? `${bi("签核人", "By")}: ${latestRec.verified_by}`
                                        : "",
                                      fullTime(latestRec.verified_at),
                                      latestRec.note || "",
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  >
                                    <span className="cv-ev-inline faint">
                                      <span>
                                        {latestRec.verified_by} ·{" "}
                                        {ago(latestRec.verified_at)}
                                      </span>
                                      {latestRec.note ? (
                                        <span>· {latestRec.note}</span>
                                      ) : null}
                                    </span>
                                  </Tooltip>
                                </>
                              ) : released ? (
                                <span className="faint small">
                                  {bi("平台内置已发布", "Built-in")}
                                </span>
                              ) : (
                                <span className="faint small">
                                  {bi("未测试", "Not tested")}
                                </span>
                              )}
                            </div>
                            </div>

                            <div className="cv-os-acts">
                              {canVerify && (
                                <Button
                                  size="mini"
                                  icon={<IconPlayArrow />}
                                  onClick={() =>
                                    go({
                                      name: "new",
                                      app: verifyAppId,
                                      verify: "1",
                                      ver:
                                        verifyAppId === entry.id
                                          ? v.id
                                          : undefined,
                                      platform: p,
                                    })
                                  }
                                >
                                  {bi("测试部署", "Test Deploy")}
                                </Button>
                              )}
                              {canPublish && !released && (
                                <Button
                                  size="mini"
                                  type={latestRec?.has_report ? "primary" : "secondary"}
                                  onClick={() =>
                                    setPublishTarget({ v, platform: p })
                                  }
                                >
                                  {bi("发布", "Publish")}
                                </Button>
                              )}
                              {canPublish && released && (
                                <Button
                                  size="mini"
                                  type="text"
                                  status="danger"
                                  onClick={() => confirmRevokeOS(v.id, p)}
                                >
                                  {bi("下线", "Unpublish")}
                                </Button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="cv-os-empty faint small">
                      {external
                        ? bi("外部组件，不安装到目标机器上", "External component; not installed on hosts")
                        : bi("没有声明支持的操作系统", "No supported OS declared")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <PublishVersionModal
            open={!!publishTarget}
            onClose={() => setPublishTarget(null)}
            compId={entry.id}
            compName={entry.name}
            verifyAppId={verifyAppId}
            version={publishTarget?.v || null}
            initialPlatform={publishTarget?.platform}
            records={verifRecords}
            onInspectReport={(rec) => setReportRec(rec)}
            onSuccess={() => setVerifTick((n) => n + 1)}
          />

          <AutoTestReportModal
            rec={reportRec}
            compId={entry.id}
            compName={entry.name}
            canDelete={canPublish}
            onClose={() => setReportRec(null)}
            onDeleted={() => setVerifTick((n) => n + 1)}
          />
        </section>

        {!external && (
          <section id="cv-flow" className={`cv-sec ${lit("cv-flow")}`}>
            <h2>
              {bi("部署流程", "Deployment Flow")}
              <span className="cv-sub">
                {bi(
                  "平台按这些步骤生成 Ansible 脚本和部署手册，每一步都会出现在交付的手册里",
                  "The platform generates Ansible playbooks and runbooks from these steps; every step appears in the delivery handbook",
                )}
              </span>
            </h2>
            <ol className="cv-pipe" aria-label={bi("部署阶段", "Deployment phases")}>
              {phases.map(([id, label]) => {
                const n = lifecycle[id]?.length || 0;
                return (
                  <li
                    key={id}
                    className={`${n ? "" : "empty"} ${phase === id ? "on" : ""}`}
                  >
                    <button
                      type="button"
                      disabled={!n}
                      onClick={() => jumpPhase(id)}
                    >
                      <b>{label}</b>
                      <span>{n ? bi(`${n} 步`, `${n} step(s)`) : "—"}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            {stepCount === 0 && (
              <p className="muted">
                {bi("这个组件没有声明部署步骤。", "No deployment steps declared for this component.")}
              </p>
            )}
            {phases.filter(([id]) => lifecycle[id]?.length).map(
              ([id, label]) => (
                <div
                  className={`cv-phase ${lit(`cv-ph-${id}`)}`}
                  key={id}
                  id={`cv-ph-${id}`}
                >
                  <h3>
                    {label}
                    <span className="mono faint small">{id}</span>
                  </h3>
                  <Steps steps={lifecycle[id]} />
                </div>
              ),
            )}
          </section>
        )}

        <section id="cv-params" className={`cv-sec ${lit("cv-params")}`}>
          <h2>
            {bi("参数", "Parameters")}
            <span className="cv-sub">
              {bi(
                "新建集群时可以调整；超出范围或不满足规则会被拦下",
                "Configurable when creating a cluster; out-of-range or rule violations are blocked",
              )}
            </span>
          </h2>
          <Params c={c} />
        </section>

        <section id="cv-tests" className={`cv-sec ${lit("cv-tests")}`}>
          <h2>
            {bi("验证与清理", "Tests & Cleanup")}
            <span className="cv-sub">
              {bi(
                "部署完成后交给人执行的验收，以及拆除时的步骤",
                "Post-deploy acceptance checks for operators and teardown cleanup steps",
              )}
            </span>
          </h2>
          {c.tests?.length > 0 && (
            <div className="cv-phase">
              <h3>{bi("功能测试", "Functional Tests")}</h3>
              <Steps steps={c.tests} />
            </div>
          )}
          {c.cleanup?.length > 0 && (
            <div className="cv-phase">
              <h3>{bi("清理", "Cleanup")}</h3>
              <Steps steps={c.cleanup} />
            </div>
          )}
          {!c.tests?.length && !c.cleanup?.length && (
            <p className="muted">
              {bi("这个组件没有声明验收测试和清理步骤。", "No verification tests or cleanup steps declared.")}
            </p>
          )}
        </section>

        <section id="cv-links" className={`cv-sec ${lit("cv-links")}`}>
          <h2>{bi("入口与关系", "Endpoints & Relations")}</h2>
          <Links c={c} />
        </section>

        <section id="cv-about" className={`cv-sec ${lit("cv-about")}`}>
          <h2>{bi("能力与限制", "Capabilities & Limits")}</h2>
          <About c={c} />
        </section>

        {!external && (
          <section id="cv-ops" className={`cv-sec ${lit("cv-ops")}`}>
            <h2>
              {bi("运维知识", "Operations")}
              <span className="cv-sub">
                {bi(
                  "写进每个集群的运维交接文档，按实际拓扑和参数展开",
                  "Included in each cluster's handover runbook, rendered with actual topology and parameters",
                )}
              </span>
            </h2>
            <Ops o={entry.operations} />
          </section>
        )}

        {admin && (
          <section id="cv-revs" className={`cv-sec ${lit("cv-revs")}`}>
            <h2>{bi("修订", "Revisions")}</h2>
            {revs === null ? (
              <Skeleton animation text={{ rows: 3 }} />
            ) : revs.length === 0 ? (
              <p className="muted">
                {bi(
                  "还没有修订。通过工作台发布或导入组件包后，每一次都会留下一条。",
                  "No revisions yet. Publishing from the workbench or importing a component pack records one.",
                )}
              </p>
            ) : (
              <ol className="cv-revs">
                {revs.slice(0, 6).map((r) => (
                  <li key={r.rev}>
                    <b>{bi(`修订 ${r.rev}`, `Rev ${r.rev}`)}</b>
                    <span>{r.note || bi("（无说明）", "(No note)")}</span>
                    <small className="faint">
                      {r.user} · {ago(r.time)} ·{" "}
                      {[
                        r.added && bi(`新增 ${r.added}`, `Added ${r.added}`),
                        r.changed && bi(`修改 ${r.changed}`, `Modified ${r.changed}`),
                        r.removed && bi(`删除 ${r.removed}`, `Deleted ${r.removed}`),
                      ]
                        .filter(Boolean)
                        .join(bi("，", ", ")) || bi("无文件变化", "No file changes")}
                    </small>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        <section id="cv-source" className={`cv-sec ${lit("cv-source")}`}>
          <h2>
            {bi("清单源码", "Manifest Source")}
            <span className="cv-sub">
              {bi(
                "component.yaml · 平台代码里没有任何应用特例",
                "component.yaml · Zero app-specific hardcoding in platform code",
              )}
            </span>
            <button
              type="button"
              className="cv-src-toggle"
              aria-expanded={srcOpen}
              onClick={() => setSrcOpen((o) => !o)}
            >
              {srcOpen ? bi("收起", "Collapse") : bi("展开查看", "Expand")}
            </button>
          </h2>
          {srcOpen &&
            (error ? (
              <p className="bad">{error}</p>
            ) : (
              yaml !== null && (
                <Terminal code={yaml} host="component.yaml" plain />
              )
            ))}
        </section>
      </div>

      <aside className="cv2-rail">
        {!external && (entry.plans?.[1] || entry.plans?.[0]) && (
          <div className="cv-rail-cap">
            {bi("典型部署：", "Typical topology: ")}
            {(entry.plans?.[1] || entry.plans?.[0])!.name}
            {(entry.plans?.[1] || entry.plans?.[0])!.spec
              ? ` · ${(entry.plans?.[1] || entry.plans?.[0])!.spec}`
              : ""}
          </div>
        )}
        <div
          className="cv-topo"
          style={
            {
              "--h0": st.color.hero[0],
              "--h1": st.color.hero[1],
            } as React.CSSProperties
          }
        >
          {external ? (
            <ExternalArt />
          ) : (
            <TopoArt
              compact
              app={entry}
              plan={entry.plans?.[1] || entry.plans?.[0]}
            />
          )}
        </div>
        <dl className="cv-facts">
          {!external && (
            <div>
              <dt>{bi("角色", "Roles")}</dt>
              <dd>
                {entry.roles.map((r) => (
                  <span key={r.name}>
                    {r.title || r.name}{" "}
                    <em>
                      {r.max && r.min === r.max
                        ? bi(`固定 ${r.min} 台`, `Fixed ${r.min}`)
                        : bi(
                            `${r.min} 台起，常用 ${r.default ?? r.min} 台`,
                            `≥ ${r.min}, default ${r.default ?? r.min}`,
                          )}
                      {r.odd ? bi("，建议奇数", ", odd advised") : ""}
                    </em>
                  </span>
                ))}
              </dd>
            </div>
          )}
          {(c.flows || []).length > 0 && (
            <div>
              <dt>{bi("数据流", "Data Flows")}</dt>
              <dd>
                {(c.flows as Any[]).map((f) => (
                  <span key={f.id}>{f.title || f.id}</span>
                ))}
              </dd>
            </div>
          )}
          {(entry.provides || []).length > 0 && (
            <div>
              <dt>{bi("提供", "Provides")}</dt>
              <dd className="mono">{entry.provides!.join(", ")}</dd>
            </div>
          )}
          {(c.requires || []).length > 0 && (
            <div>
              <dt>{bi("依赖", "Requires")}</dt>
              <dd>
                {(c.requires as Any[]).map((r) => (
                  <span key={r.capability}>
                    <span className="mono">{r.capability}</span>
                    {r.default_impl && (
                      <em>
                        {bi(`默认 ${r.default_impl}`, `default ${r.default_impl}`)}
                      </em>
                    )}
                  </span>
                ))}
              </dd>
            </div>
          )}
          {(c.ports || []).length > 0 && (
            <div>
              <dt>{bi("端口", "Ports")}</dt>
              <dd className="mono">
                {(c.ports as Any[])
                  .map((p) => show(p.value).replace(/^=params\./, ""))
                  .join(", ")}
              </dd>
            </div>
          )}
        </dl>
        <nav
          className="cv-toc"
          aria-label={bi("本页内容", "On this page")}
          ref={tocRef as React.RefObject<HTMLElement>}
          style={
            {
              "--ty": `${
                Math.max(
                  0,
                  sections.findIndex(([id]) => id === active),
                ) * 34
              }px`,
            } as React.CSSProperties
          }
        >
          <span className="cv-toc-mark" aria-hidden />
          {sections.map(([id, label, n]) => (
            <button
              type="button"
              key={id}
              className={active === id ? "on" : ""}
              onClick={() => jump(id)}
            >
              <span className="cv-toc-label">
                {CvIcons[id]}
                <span>{label}</span>
              </span>
              <i>{n ?? ""}</i>
            </button>
          ))}
        </nav>
      </aside>
      </div>
    </div>
  );
}

/** A component the customer operates: the platform only produces its configuration sheet. */
function ExternalArt() {
  useLang();
  return (
    <div className="cv-ext">
      <svg viewBox="0 0 300 120" aria-hidden>
        <rect
          x="8"
          y="44"
          width="62"
          height="32"
          rx="8"
          className="ext-box dim"
        />
        <text x="39" y="64" textAnchor="middle" className="ext-t">
          {bi("客户端", "Client")}
        </text>
        <path d="M72 60h44" className="ext-wire" />
        <rect
          x="118"
          y="34"
          width="84"
          height="52"
          rx="10"
          className="ext-box lead"
        />
        <text x="160" y="58" textAnchor="middle" className="ext-t b">
          {bi("负载均衡", "Load Balancer")}
        </text>
        <text x="160" y="74" textAnchor="middle" className="ext-t">
          {bi("客户运维", "Customer Ops")}
        </text>
        <path
          d="M204 60c22 0 22-34 44-34M204 60h44M204 60c22 0 22 34 44 34"
          className="ext-wire"
        />
        <rect
          x="248"
          y="14"
          width="44"
          height="24"
          rx="6"
          className="ext-box"
        />
        <rect
          x="248"
          y="48"
          width="44"
          height="24"
          rx="6"
          className="ext-box"
        />
        <rect
          x="248"
          y="82"
          width="44"
          height="24"
          rx="6"
          className="ext-box"
        />
      </svg>
      <p>
        {bi(
          "平台不在机器上安装它，只生成一份要在它上面配置的监听、后端和健康检查清单。",
          "Not installed by the platform; generates listener, backend, and health-check configuration sheets instead.",
        )}
      </p>
    </div>
  );
}

const Params = memo(function Params({ c }: { c: Any }) {
  useLang();
  const groups: Any[] = c.groups || [];
  const params: Any[] = c.params || [];
  const sets = groups
    .map((g) => ({ g, list: params.filter((p) => p.group === g.id) }))
    .filter((x) => x.list.length);
  const loose = params.filter((p) => !groups.some((g) => g.id === p.group));
  if (loose.length)
    sets.push({ g: { id: "_", label: bi("其他", "Other") }, list: loose });
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sets.slice(0, 2).map(({ g }) => [g.id, true])),
  );
  if (!params.length)
    return (
      <p className="muted">
        {bi("这个组件没有可调的参数。", "This component has no configurable parameters.")}
      </p>
    );
  const allOpen = sets.every(({ g }) => open[g.id]);
  return (
    <>
      <div className="cv-bar">
        <span className="faint small">
          {bi(
            `${params.length} 项，分 ${sets.length} 组`,
            `${params.length} param(s) in ${sets.length} group(s)`,
          )}
        </span>
        <button
          type="button"
          className="link quiet"
          onClick={() =>
            setOpen(
              allOpen
                ? {}
                : Object.fromEntries(sets.map(({ g }) => [g.id, true])),
            )
          }
        >
          {allOpen ? bi("全部收起", "Collapse all") : bi("全部展开", "Expand all")}
        </button>
      </div>
      <div className="cv-groups">
        {sets.map(({ g, list }) => {
          const on = !!open[g.id];
          return (
            <div className={`cv-group ${on ? "on" : ""}`} key={g.id}>
              <button
                type="button"
                className="cv-group-head"
                aria-expanded={on}
                onClick={() => setOpen((o) => ({ ...o, [g.id]: !on }))}
              >
                {on ? <IconDown /> : <IconRight />}
                <b>{g.label || g.id}</b>
                <i>{list.length}</i>
                {!on && (
                  <span className="cv-peek">
                    {list.map((p) => p.label || p.key).join(bi("、", ", "))}
                  </span>
                )}
              </button>
              {on && (
                <div className="cv-params" role="table">
                  {list.map((p) => (
                    <div className="cv-prow" role="row" key={p.key}>
                      <span className="cv-pname">
                        <b>{p.label || p.key}</b>
                        <span className="mono faint small">{p.key}</span>
                        {p.hint && <small>{p.hint}</small>}
                      </span>
                      <span className="mono faint">{p.type}</span>
                      <span className="mono">
                        {show(p.default)}
                        {p.unit ? ` ${p.unit}` : ""}
                      </span>
                      <span className="cv-prange">
                        {p.options
                          ? p.options.join(" / ")
                          : p.min !== undefined || p.max !== undefined
                            ? `${show(p.min)} – ${show(p.max)}`
                            : p.pattern
                              ? bi("有格式要求", "Pattern constrained")
                              : ""}
                        <span className="cv-flags">
                          {p.required && <span className="flag">{bi("必填", "Required")}</span>}
                          {p.restart && (
                            <span className="flag cv-mute">{bi("改后重启", "Restart")}</span>
                          )}
                          {p.advanced && (
                            <span className="flag cv-mute">{bi("高级", "Advanced")}</span>
                          )}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
});

const Links = memo(function Links({ c }: { c: Any }) {
  useLang();
  const rows: [string, string, string, string][] = [
    ...((c.endpoints || []) as Any[]).map(
      (e): [string, string, string, string] => [
        bi("对外入口", "Endpoint"),
        e.title || e.name,
        `${e.protocol} · ${bi("端口", "port")} ${show(e.port).replace(/^=params\./, "")}`,
        e.note || "",
      ],
    ),
    ...((c.requires || []) as Any[]).map(
      (r): [string, string, string, string] => [
        bi("依赖", "Requires"),
        r.capability,
        r.default_impl
          ? bi(`没指定时自动加入 ${r.default_impl}`, `Defaults to ${r.default_impl} if unset`)
          : bi("部署时要指定由谁来提供", "Provider must be selected at deploy"),
        r.when ? bi(`当 ${r.when} 时需要`, `Required when ${r.when}`) : "",
      ],
    ),
    ...((c.ports || []) as Any[]).map((p): [string, string, string, string] => [
      bi("占用端口", "Port"),
      p.name,
      show(p.value).replace(/^=params\./, bi("参数 ", "param ")),
      "",
    ]),
    ...((c.secrets || []) as Any[]).map(
      (x): [string, string, string, string] => [
        bi("自动生成的密钥", "Generated Secret"),
        x.name,
        x.length ? bi(`${x.length} 位`, `${x.length} chars`) : "",
        "",
      ],
    ),
    ...((c.inputs || []) as Any[]).map(
      (x): [string, string, string, string] => [
        bi("需要上传", "Required Upload"),
        x.label || x.name,
        x.kind === "tls-bundle" ? bi("TLS 证书包", "TLS Bundle") : x.kind,
        "",
      ],
    ),
  ];
  if (!rows.length)
    return (
      <p className="muted">
        {bi("这个组件没有声明入口、依赖或端口。", "No endpoints, dependencies, or ports declared.")}
      </p>
    );
  return (
    <ul className="cv-links">
      {rows.map(([k, name, v, note], i) => (
        <li key={i}>
          <span className="cv-kind">{k}</span>
          <b>{name}</b>
          <span className="small">{v}</span>
          {note && <small className="faint">{note}</small>}
        </li>
      ))}
    </ul>
  );
});

/** The author's operations knowledge: what to check every day, routine tasks, typical problems, where the logs are. */
function Ops({ o }: { o?: Any }) {
  useLang();
  const aiStatus = useAIStatus();
  if (!o || !(o.checks?.length || o.tasks?.length || o.faults?.length))
    return (
      <p className="muted">
        {bi(
          "这个组件还没有写运维知识。在工作台的清单里补上 operations（巡检、常见操作、典型问题、日志位置），交接文档就会带上",
          "No operations knowledge written yet. Add operations (checks, tasks, faults, log locations) to the manifest in the workbench to include it in handover docs",
        )}
        {aiStatus.enabled && !!aiStatus.features?.component && can("ai.use")
          ? bi("；也可以让组件 AI 起草。", "; or ask Component AI to draft it.")
          : "."}
      </p>
    );
  const when = (w?: string) =>
    w ? (
      <span className="cv-when" title={bi("只在这个条件成立的集群里出现", "Shown only in clusters matching this condition")}>
        {w}
      </span>
    ) : null;
  return (
    <div className="cv-ops">
      {o.overview && <p className="cv-ops-lead">{o.overview}</p>}
      {(
        [
          ["checks", bi("日常巡检", "Routine Checks"), o.checks],
          ["tasks", bi("常见操作", "Common Tasks"), o.tasks],
        ] as [string, string, Any[]][]
      )
        .filter(([, , l]) => l?.length)
        .map(([k, h, l]) => (
          <div key={k} className="cv-ops-g">
            <h3>
              {h} <em className="num">{l.length}</em>
            </h3>
            <ul>
              {l.map((x: Any) => (
                <li key={x.title}>
                  <b>{x.title}</b>
                  {when(x.when)}
                  {x.hosts && (
                    <span className="faint small">
                      {bi(`在 ${x.hosts}`, `on ${x.hosts}`)}
                    </span>
                  )}
                  {x.cmd && <code className="cv-ops-cmd">{x.cmd}</code>}
                  {(x.expect || x.note) && (
                    <small>
                      {x.expect ? `${bi("正常：", "Expected: ")}${x.expect}` : x.note}
                    </small>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {o.faults?.length > 0 && (
        <div className="cv-ops-g">
          <h3>
            {bi("典型问题", "Typical Faults")} <em className="num">{o.faults.length}</em>
          </h3>
          <ul>
            {o.faults.map((x: Any) => (
              <li key={x.title}>
                <b>{x.title}</b>
                {when(x.when)}
                {x.symptom && (
                  <small>
                    {bi("现象：", "Symptom: ")}
                    {x.symptom}
                  </small>
                )}
                <ol>
                  {(x.steps || []).map((st: string, i: number) => (
                    <li key={i}>{st}</li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        </div>
      )}
      {o.logs?.length > 0 && (
        <p className="faint small">
          {bi("日志与文件：", "Logs & files: ")}
          {o.logs.map((l: Any) => `${l.name} ${l.text}`).join("; ")}
        </p>
      )}
    </div>
  );
}

function About({ c }: { c: Any }) {
  useLang();
  const caps: Any[] = c.detail?.capabilities || [];
  const limits: string[] = c.detail?.limits || [];
  if (!caps.length && !limits.length)
    return (
      <p className="muted">
        {bi("没有填写能力与限制的说明。", "No capabilities or limitations documented.")}
      </p>
    );
  return (
    <dl className="cv-caps">
      {caps.map((x, i) => (
        <div key={`c${i}`}>
          <dt>{x.name}</dt>
          <dd>{x.text}</dd>
        </div>
      ))}
      {limits.map((x, i) => (
        <div key={`l${i}`} className="limit">
          <dt>{bi("限制", "Limit")}</dt>
          <dd>{x}</dd>
        </div>
      ))}
    </dl>
  );
}

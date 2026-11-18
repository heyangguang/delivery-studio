import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Message, Modal, Tooltip } from "@arco-design/web-react";
import {
  IconCheck,
  IconCopy,
  IconEye,
  IconEyeInvisible,
} from "@arco-design/web-react/icon";
import {
  api,
  can,
  copy,
  err,
  planPhase,
} from "./shared";
import type { DeliveryPlan, Deployment, Job, Outcome } from "./shared";

/* The engineer's report on a plan: done, done with deviations, failed or void. The platform never connects to the
   cluster, so this report is what moves the cluster on (see store_cluster.go). */

type Amendment = {
  kind: string;
  after_title?: string;
  step: { title: string; command: string };
  reason: string;
};

type AccessItem = { key: string; label: string; value: string };

const SENSITIVE_KEY_RE =
  /(password|passwd|pwd|secret|token|requirepass|access_key|secret_key|auth_key|private_key|admin_pass|repl_pass|superuser_pass)/i;

function extractAccessInfo(
  plan?: DeliveryPlan | null,
  spec?: Deployment | null,
): { endpoints: AccessItem[]; credentials: AccessItem[] } {
  const endpoints: AccessItem[] = [];
  const seenEp = new Set<string>();
  const hostIpMap = new Map<string, string>();
  for (const h of plan?.hosts || spec?.hosts || []) {
    if (h.name && h.ip) hostIpMap.set(h.name, h.ip);
  }
  const defaultIp = (plan?.hosts || spec?.hosts || [])[0]?.ip || "";

  for (const inst of plan?.instances || []) {
    if (inst.external) continue;
    for (const f of Object.values(inst.fronts || {})) {
      const addr = f.address
        ? `${f.address}:${f.listen}`
        : defaultIp
          ? `${defaultIp}:${f.listen}`
          : `:${f.listen}`;
      if (seenEp.has(addr)) continue;
      seenEp.add(addr);
      endpoints.push({
        key: `front-${inst.id}-${f.name}-${addr}`,
        label: f.external ? `${inst.title} 外部入口` : `${inst.title} 入口`,
        value: addr,
      });
    }
    for (const ep of inst.endpoints || []) {
      const b0 = ep.backends?.[0];
      const ip =
        b0?.ip ||
        (inst.hosts?.[0] ? hostIpMap.get(inst.hosts[0]) : "") ||
        defaultIp;
      const port = b0?.port || ep.port;
      if (!ip || !port) continue;
      const proto = (ep.protocol || "").toLowerCase();
      const raw = `${ip}:${port}`;
      const connVal =
        proto === "postgres" || proto === "postgresql"
          ? `postgresql://${ip}:${port}`
          : proto === "redis"
            ? `redis://${ip}:${port}`
            : proto === "mysql"
              ? `mysql://${ip}:${port}`
              : proto === "http" || proto === "https"
                ? `${proto}://${ip}:${port}`
                : raw;
      if (seenEp.has(connVal) || seenEp.has(raw)) continue;
      seenEp.add(connVal);
      endpoints.push({
        key: `ep-${inst.id}-${ep.name}`,
        label: ep.title || `${inst.title} ${ep.name}`,
        value: connVal,
      });
    }
    if (endpoints.length === 0) {
      for (const pt of (inst.ports || []).slice(0, 2)) {
        const ip =
          (pt.Hosts?.[0] ? hostIpMap.get(pt.Hosts[0]) : "") || defaultIp;
        if (!ip || !pt.Port) continue;
        const addr = `${ip}:${pt.Port}`;
        if (seenEp.has(addr)) continue;
        seenEp.add(addr);
        endpoints.push({
          key: `pt-${inst.id}-${pt.Name}-${pt.Port}`,
          label: `${inst.title} ${pt.Name}`,
          value: addr,
        });
      }
    }
  }

  const credentials: AccessItem[] = [];
  const seenCred = new Set<string>();
  const collectParams = (
    prefix: string,
    title: string,
    params?: Record<string, unknown>,
  ) => {
    if (!params) return;
    for (const [k, v] of Object.entries(params)) {
      if (!SENSITIVE_KEY_RE.test(k)) continue;
      if (typeof v !== "string" || !v.trim()) continue;
      const id = `${prefix}.${k}`;
      if (seenCred.has(id)) continue;
      seenCred.add(id);
      credentials.push({
        key: id,
        label: title ? `${title} · ${k}` : k,
        value: v,
      });
    }
  };

  for (const inst of plan?.instances || []) {
    collectParams(inst.id, inst.title || inst.id, inst.params);
  }
  for (const inst of spec?.instances || []) {
    const pInst = plan?.instances?.find((x) => x.id === inst.id);
    collectParams(inst.id, pInst?.title || inst.id, inst.params);
    for (const ad of inst.addons || []) {
      collectParams(
        `${inst.id}.${ad.id}`,
        `${pInst?.title || inst.id} (${ad.id})`,
        ad.params,
      );
    }
  }
  for (const h of spec?.hosts || []) {
    collectParams(`host.${h.name}`, h.name, h.params);
  }

  return {
    endpoints: endpoints.slice(0, 4),
    credentials: credentials.slice(0, 6),
  };
}

const ASK: Record<
  "deviated" | "failed" | "void",
  { title: string; lead: string; hint: string; ok: string; need: boolean }
> = {
  deviated: {
    title: "完成，但和交付有出入",
    lead: "写明实际做法和原交付有什么不同。它会记入集群档案，供后续变更演练参考。",
    hint: "例如：node-03 的数据盘换成了 /dev/vdc；第 5 步的命令改为……",
    ok: "确认「有偏差」",
    need: true,
  },
  failed: {
    title: "执行失败",
    lead: "说明停在哪一步、集群现在是什么样子。失败的交付仍然占着这个集群，处理好以后确认完成，或者作废。",
    hint: "例如：第 3 步升级 node-02 时服务没有起来，已回退到原版本",
    ok: "确认「失败」",
    need: false,
  },
  void: {
    title: "作废这份交付",
    lead: "作废表示没有执行，或者已经完全回退，目标机器保持原样。作废后不能恢复。",
    hint: "例如：部署窗口取消，没有执行任何步骤",
    ok: "作废",
    need: true,
  },
};

/** Turns the step changes accepted during execution into a first draft of the deviation note. */
function draftFrom(ams: Amendment[]): string {
  return ams
    .map(
      (a) =>
        (a.kind === "replace"
          ? `「${a.after_title || a.step.title}」改为：${a.step.command.split("\n")[0]}`
          : `在「${a.after_title || "开头"}」之后加了一步「${a.step.title}」`) +
        (a.reason ? `（${a.reason}）` : ""),
    )
    .join("\n");
}

export function OutcomeBar({
  job,
  later,
  onSaved,
  plan,
  spec,
}: {
  job: Job;
  later: boolean;
  onSaved: (j: Job) => void;
  plan?: DeliveryPlan | null;
  spec?: Deployment | null;
}) {
  const [ask, setAsk] = useState<"deviated" | "failed" | "void" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  const ph = planPhase(job);
  const may = can("delivery.run");

  const access = useMemo(() => extractAccessInfo(plan, spec), [plan, spec]);
  const hasAccess =
    access.endpoints.length > 0 || access.credentials.length > 0;

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const triggerCopy = (key: string, value: string) => {
    copy(value);
    setCopiedKey(key);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedKey(null), 1500);
  };

  const toggleReveal = (key: string) =>
    setRevealed((prev) => ({ ...prev, [key]: !prev[key] }));

  const send = async (outcome: Outcome | "", text = "") => {
    setBusy(true);
    try {
      const j = await api<Job>(`/api/jobs/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({ outcome, note: text }),
      });
      onSaved(j);
      setAsk(null);
      Message.success(
        outcome === ""
          ? "已改回待执行"
          : outcome === "void"
            ? "已作废"
            : outcome === "failed"
              ? "已记为失败"
              : "已确认部署完成",
      );
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const open = async (k: "deviated" | "failed" | "void") => {
    setNote(k === job.outcome ? job.outcome_note || "" : "");
    setAsk(k);
    if (k === "deviated" && !job.outcome_note) {
      try {
        const p = await api<{ amendments?: Amendment[] }>(
          `/api/jobs/${job.id}/progress`,
        );
        const d = draftFrom(p.amendments || []);
        if (d) setNote((n) => n || d);
      } catch {
        /* the note can be written by hand */
      }
    }
  };

  const allDone =
    (job.run_total || 0) > 0 &&
    (job.run_done || 0) >= (job.run_total || 0) &&
    !job.run_failed;
  const settled = ph === "done" || ph === "deviated";
  const a = ask ? ASK[ask] : null;
  const showActionRow = !settled && ph !== "void";
  const showNote = Boolean(job.outcome_note);
  const showArchiveHint = settled && later;
  const showAccess = hasAccess && ph !== "void";

  if (!showActionRow && !showNote && !showArchiveHint && !showAccess && !a) {
    return null;
  }

  return (
    <div className={`oc oc-${ph}`}>
      {showActionRow && (
        <div className="oc-main">
          <div className="oc-state">
            <span
              className={`oc-dot is-${
                ph === "failed"
                  ? "bad"
                  : allDone
                    ? "ok"
                    : ph === "running"
                      ? "run"
                      : "idle"
              }`}
              aria-hidden
            />
            <span className="oc-who num">
              {ph === "failed"
                ? "上次登记为执行失败，处理后可继续执行或确认完成"
                : allDone
                  ? `现场 ${job.run_done}/${job.run_total} 步已全部完成，请确认部署结果`
                  : ph === "running"
                    ? `现场已执行 ${job.run_done || 0}${job.run_total ? ` / ${job.run_total}` : ""} 步${job.run_failed ? `（${job.run_failed} 步失败）` : ""}${may ? " · 完成后在此登记结果" : ""}`
                    : may
                      ? "现场步骤执行完成后，在此登记部署结果"
                      : "待现场执行"}
            </span>
          </div>
          {may && (
            <div className="oc-acts">
              <Button
                size="small"
                type={allDone ? "primary" : "secondary"}
                loading={busy}
                onClick={() => send("done")}
              >
                确认完成
              </Button>
              <Button size="small" onClick={() => open("deviated")}>
                有偏差…
              </Button>
              {ph !== "failed" ? (
                <Button size="small" onClick={() => open("failed")}>
                  失败…
                </Button>
              ) : (
                <Button size="small" loading={busy} onClick={() => send("")}>
                  继续执行
                </Button>
              )}
              <Button size="small" status="danger" onClick={() => open("void")}>
                作废…
              </Button>
            </div>
          )}
        </div>
      )}
      {showNote && (
        <div className="oc-note-row">
          <span className="oc-note-tag">
            {ph === "deviated"
              ? "偏差记录"
              : ph === "failed"
                ? "失败说明"
                : ph === "void"
                  ? "作废说明"
                  : "备注"}
          </span>
          <p className="oc-note">{job.outcome_note}</p>
        </div>
      )}
      {showArchiveHint && (
        <p className="oc-hint">
          集群后续已有更新记录，当前结果已归档留存。
        </p>
      )}
      {showAccess && (
        <div className="oc-access" role="region" aria-label="连接地址与凭据">
          <span className="oc-access-lbl">连接与凭据</span>
          {access.endpoints.map((ep) => {
            const isCopied = copiedKey === ep.key;
            return (
              <span key={ep.key} className="oc-cred-pill">
                <span className="oc-cred-label">{ep.label}</span>
                <code className="oc-cred-val mono">{ep.value}</code>
                <Tooltip content={isCopied ? "已复制" : "复制连接串"} mini>
                  <button
                    type="button"
                    className={`oc-cred-btn ${isCopied ? "copied" : ""}`}
                    aria-label={`复制 ${ep.label}`}
                    onClick={() => triggerCopy(ep.key, ep.value)}
                  >
                    {isCopied ? <IconCheck /> : <IconCopy />}
                  </button>
                </Tooltip>
              </span>
            );
          })}
          {access.credentials.map((cr) => {
            const isShown = !!revealed[cr.key];
            const isCopied = copiedKey === cr.key;
            return (
              <span key={cr.key} className="oc-cred-pill is-secret">
                <span className="oc-cred-label">{cr.label}</span>
                <code className="oc-cred-val mono">
                  {isShown ? cr.value : "••••••••"}
                </code>
                <Tooltip content={isShown ? "隐藏凭据" : "显示凭据"} mini>
                  <button
                    type="button"
                    className="oc-cred-btn"
                    aria-label={`${isShown ? "隐藏" : "显示"} ${cr.label}`}
                    aria-pressed={isShown}
                    onClick={() => toggleReveal(cr.key)}
                  >
                    {isShown ? <IconEyeInvisible /> : <IconEye />}
                  </button>
                </Tooltip>
                <Tooltip content={isCopied ? "已复制" : "复制凭据"} mini>
                  <button
                    type="button"
                    className={`oc-cred-btn ${isCopied ? "copied" : ""}`}
                    aria-label={`复制 ${cr.label}`}
                    onClick={() => triggerCopy(cr.key, cr.value)}
                  >
                    {isCopied ? <IconCheck /> : <IconCopy />}
                  </button>
                </Tooltip>
              </span>
            );
          })}
        </div>
      )}
      <Modal
        visible={!!a}
        title={a?.title}
        onCancel={() => setAsk(null)}
        okText={a?.ok}
        okButtonProps={{
          status: ask === "void" ? "danger" : undefined,
          disabled: !!a?.need && note.trim().length < 2,
          loading: busy,
        }}
        onOk={() => {
          if (ask) send(ask, note);
        }}
        className="oc-modal"
      >
        <p className="oc-lead">{a?.lead}</p>
        <Input.TextArea
          value={note}
          onChange={setNote}
          placeholder={a?.hint}
          autoSize={{ minRows: 4, maxRows: 12 }}
          maxLength={2000}
          showWordLimit
          aria-label="说明"
        />
        {ask === "deviated" && note && !job.outcome_note && (
          <p className="oc-hint">
            已按执行中采纳的步骤修改起了个头，请核对补充。
          </p>
        )}
      </Modal>
    </div>
  );
}

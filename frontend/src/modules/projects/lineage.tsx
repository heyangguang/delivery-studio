import React, { useState } from "react";
import { IconBranch, IconRight } from "@arco-design/web-react/icon";
import { ago, planTitle } from "../../shared/shared";
import type { Change, JobRef, Lineage } from "../../shared/shared";
import { go } from "../../app/router";
import { bi, useLang } from "../../app/i18n";
import "./lineage.css";

const AREAS: Record<string, string> = {
  get host() { return bi("机器", "Hosts"); },
  get instance() { return bi("实例", "Instances"); },
  get version() { return bi("版本", "Version"); },
  get placement() { return bi("角色位置", "Placement"); },
  get param() { return bi("参数", "Parameters"); },
  get package() { return bi("软件包", "Packages"); },
};
const OPS: Record<string, string> = {
  get add() { return bi("新增", "Add"); },
  get remove() { return bi("移除", "Remove"); },
  get change() { return bi("变更", "Change"); },
};

function Ref({ r }: { r: JobRef }) {
  useLang();
  const done = r.outcome === "done" || r.outcome === "deviated";
  return (
    <a
      className="dv-ref"
      href={`#/d/${encodeURIComponent(r.cluster_id)}/plans/${r.id}`}
      onClick={(e) => {
        e.preventDefault();
        go({ name: "deliveries", id: r.cluster_id, tab: "plans", plan: r.id });
      }}
    >
      <b>{planTitle(r)}</b>
      <span className="faint">{bi(`${ago(r.created)}生成`, `Built ${ago(r.created)}`)}</span>
      {r.state !== "succeeded" && (
        <span className="dv-state">
          {r.state === "failed" ? bi("生成失败", "Build failed") : bi("生成中", "Building")}
        </span>
      )}
      {r.outcome && (
        <span className="dv-state">
          {done ? bi("已完成", "Completed") : r.outcome === "void" ? bi("已作废", "Void") : bi("失败", "Failed")}
        </span>
      )}
      <IconRight />
    </a>
  );
}

function ChangeRow({ c }: { c: Change }) {
  useLang();
  return (
    <li className={`dv-ch ${c.op}`}>
      <span className="dv-op">{OPS[c.op]}</span>
      <span className="dv-label">{c.label}</span>
      <span className="dv-val">
        {c.op === "change" && (
          <>
            <s>{c.from || "—"}</s>
            <i>→</i>
            <b>{c.to || "—"}</b>
          </>
        )}
        {c.op === "add" && <b>{c.to}</b>}
        {c.op === "remove" && <s>{c.from}</s>}
      </span>
    </li>
  );
}

/** Where a revised first deployment came from, and how it differs from the one it replaced. */
export function LineagePanel({ lineage }: { lineage?: Lineage | null }) {
  useLang();
  const [all, setAll] = useState(false);
  if (!lineage) return null;
  const {
    source,
    children = [],
    changes = [],
    source_gone,
    revision,
  } = lineage;
  const groups = Object.keys(AREAS).filter((a) =>
    changes.some((c) => c.area === a),
  );
  const shown = all ? changes : changes.slice(0, 12);
  return (
    <section className="dv">
      <h3>
        <IconBranch />
        {revision ? bi("这次修改了什么", "What changed") : bi("修订记录", "Revision history")}
      </h3>
      {source && (
        <div className="dv-row">
          <span className="dv-k">{revision ? bi("取代了", "Replaced") : bi("来源", "Source")}</span>
          <Ref r={source} />
        </div>
      )}
      {source_gone && <p className="dv-note is-muted">{bi("它取代的那一份已被删除。", "The replaced delivery has been deleted.")}</p>}
      {children.length > 0 && (
        <div className="dv-row top">
          <span className="dv-k">{bi("后续修订", "Subsequent revisions")}</span>
          <div className="dv-list">
            {children.map((c) => (
              <Ref key={c.id} r={c} />
            ))}
          </div>
        </div>
      )}
      {source && (
        <>
          <div className="dv-line">
            {bi("与被取代的那份相比：", "Changes from replaced delivery: ")}
            {changes.length === 0
              ? bi("没有差异", "No differences")
              : groups
                  .map(
                    (g) =>
                      `${AREAS[g]} ${changes.filter((c) => c.area === g).length}`,
                  )
                  .join(" · ")}
          </div>
          {changes.length > 0 && (
            <ul className="dv-changes">
              {shown.map((c, i) => (
                <ChangeRow key={i} c={c} />
              ))}
            </ul>
          )}
          {changes.length > 12 && (
            <button type="button" className="link" onClick={() => setAll(!all)}>
              {all ? bi("收起", "Show less") : bi(`显示全部 ${changes.length} 项`, `Show all ${changes.length}`)}
            </button>
          )}
          <p className="dv-note">
            {bi(
              "被取代的那份已经作废，不再执行；按这一份的手册部署。如果现场已经按旧的做过一部分，请先按这一份的手册核对再继续。",
              "The replaced delivery is void and should not be executed; deploy using this runbook. If partial steps were run from the old delivery, verify against this runbook before continuing.",
            )}
          </p>
        </>
      )}
    </section>
  );
}

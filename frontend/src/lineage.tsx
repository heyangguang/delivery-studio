import React, { useState } from "react";
import { IconBranch, IconRight } from "@arco-design/web-react/icon";
import { ago, planTitle } from "./shared";
import type { Change, JobRef, Lineage } from "./shared";
import { go } from "./router";
import "./lineage.css";

const AREAS: Record<string, string> = {
  host: "机器",
  instance: "实例",
  version: "版本",
  placement: "角色位置",
  param: "参数",
  package: "软件包",
};
const OPS: Record<string, string> = {
  add: "新增",
  remove: "移除",
  change: "变更",
};

function Ref({ r }: { r: JobRef }) {
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
      <span className="faint">{ago(r.created)}生成</span>
      {r.state !== "succeeded" && (
        <span className="dv-state">
          {r.state === "failed" ? "生成失败" : "生成中"}
        </span>
      )}
      {r.outcome && (
        <span className="dv-state">
          {done ? "已完成" : r.outcome === "void" ? "已作废" : "失败"}
        </span>
      )}
      <IconRight />
    </a>
  );
}

function ChangeRow({ c }: { c: Change }) {
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
        {revision ? "这次修改了什么" : "修订记录"}
      </h3>
      {source && (
        <div className="dv-row">
          <span className="dv-k">{revision ? "取代了" : "来源"}</span>
          <Ref r={source} />
        </div>
      )}
      {source_gone && <p className="dv-note">它取代的那一份已被删除。</p>}
      {children.length > 0 && (
        <div className="dv-row top">
          <span className="dv-k">后续修订</span>
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
            与被取代的那份相比：
            {changes.length === 0
              ? "没有差异"
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
            <button className="link" onClick={() => setAll(!all)}>
              {all ? "收起" : `显示全部 ${changes.length} 项`}
            </button>
          )}
          <p className="dv-note">
            被取代的那份已经作废，不再执行；按这一份的手册部署。如果现场已经按旧的做过一部分，请先按这一份的手册核对再继续。
          </p>
        </>
      )}
    </section>
  );
}

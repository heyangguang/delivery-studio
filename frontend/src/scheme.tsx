import React from "react";
import type {DeploymentScheme} from "./shared";

export function schemeName(scheme?: DeploymentScheme) {return scheme?.name || "历史方案待核对";}
export function sameScheme(a?: DeploymentScheme, b?: DeploymentScheme): boolean {
 if(!a || !b)return !a && !b;
 if(a===b)return true;
 const ca=a.contract, cb=b.contract;
 return a.name===b.name && a.topology===b.topology && a.nodes===b.nodes &&
  ca.mechanism===cb.mechanism && ca.failover===cb.failover && ca.read_access===cb.read_access &&
  ca.limitations.length===cb.limitations.length && ca.limitations.every((v,i)=>v===cb.limitations[i]);
}
export function SchemeInfo({scheme, detail=false, label="部署方案"}:{scheme?: DeploymentScheme;detail?: boolean;label?: string}) {
 if(!scheme)return <section className="scheme-summary is-empty" aria-label={label}><div className="scheme-head"><span className="scheme-dot" aria-hidden /><strong>部署架构待核对</strong></div><div className="scheme-limit">旧交付未保存方案信息，请在下方节点拓扑或“配置”中查看原始部署记录。</div></section>;
 const contract=scheme.contract;
 const failover=({none:"不提供故障切换",manual:"人工切换",automatic:"自动故障切换"} as Record<string,string>)[contract.failover] || contract.failover;
 const summary=[scheme.topology,contract.mechanism,failover].filter(Boolean).join("；");
 if(!detail)return <span title={summary}>{label}：<strong>{scheme.name}</strong>{scheme.nodes>0 ? " · "+scheme.nodes+" 个应用节点" : ""}</span>;
 const facets=[contract.mechanism,failover,contract.read_access].filter(Boolean);
 const hasEvidence=scheme.source==="delivery-evidence" && Boolean(scheme.evidence?.length);
 const hasLimits=contract.limitations?.length>0;
 return <section className="scheme-summary" aria-label={label}>
  <div className="scheme-head"><span className="scheme-dot" aria-hidden /><strong>{label.includes("目标") ? "目标部署架构" : label.includes("当前") ? "当前部署架构" : label.includes("此配置") ? "此配置对应部署架构" : "部署架构"}：{scheme.name}</strong>{scheme.nodes>0 && <span className="scheme-node-pill num">{scheme.nodes} 个应用节点</span>}</div>
  {(scheme.topology || facets.length>0) && (
   <div className="scheme-pills">
    {scheme.topology && <span className="scheme-pill is-topo">{scheme.topology}</span>}
    {facets.map((f,i)=><span key={i} className="scheme-pill">{f}</span>)}
   </div>
  )}
  {(hasEvidence || hasLimits) && (
   <div className="scheme-foot">
    {hasEvidence && <div className="scheme-limit">根据历史交付识别 · {scheme.evidence?.join("；")}</div>}
    {hasLimits && <div className="scheme-limit">适用限制：{contract.limitations.join("；")}</div>}
   </div>
  )}
 </section>;
}

import React from "react";
import type {DeploymentScheme} from "../shared/shared";
import { bi, useLang } from "../app/i18n";

export function schemeName(scheme?: DeploymentScheme) {return scheme?.name || bi("历史方案待核对", "Legacy scheme (unverified)");}
export function sameScheme(a?: DeploymentScheme, b?: DeploymentScheme): boolean {
 if(!a || !b)return !a && !b;
 if(a===b)return true;
 const ca=a.contract, cb=b.contract;
 if(!ca || !cb)return !ca && !cb && a.name===b.name && a.topology===b.topology && a.nodes===b.nodes;
 const la=ca.limitations || [], lb=cb.limitations || [];
 return a.name===b.name && a.topology===b.topology && a.nodes===b.nodes &&
  ca.mechanism===cb.mechanism && ca.failover===cb.failover && ca.read_access===cb.read_access &&
  la.length===lb.length && la.every((v,i)=>v===lb[i]);
}
export function SchemeInfo({scheme, detail=false, label}:{scheme?: DeploymentScheme;detail?: boolean;label?: string}) {
 useLang();
 const resolvedLabel = label ?? bi("部署方案", "Deployment scheme");
 if(!scheme)return <section className="scheme-summary is-empty" aria-label={resolvedLabel}><div className="scheme-head"><span className="scheme-head-title"><span className="scheme-dot" aria-hidden /><strong>{bi("部署架构待核对", "Architecture unverified")}</strong></span></div><div className="scheme-limit">{bi("旧交付未保存方案信息，请在下方节点拓扑或“配置”中查看原始部署记录。", "Legacy delivery has no saved scheme metadata; inspect the topology below or the Config tab for raw records.")}</div></section>;
 const contract=scheme.contract || {when:"",series:"",failover:"",mechanism:"",read_access:"",sharding:false,limitations:[],acceptance:[],operations:[]};
 const failover=({
  none: bi("不提供故障切换", "No failover"),
  manual: bi("人工切换", "Manual failover"),
  automatic: bi("自动故障切换", "Automatic failover"),
 } as Record<string,string>)[contract.failover] || contract.failover;
 const summary=[scheme.topology,contract.mechanism,failover].filter(Boolean).join(bi("；", "; "));
 const nodeText = scheme.nodes === 1 ? bi("1 个应用节点", "1 app node") : bi(`${scheme.nodes} 个应用节点`, `${scheme.nodes} app nodes`);
 if(!detail)return <span title={summary}>{resolvedLabel}{bi("：", ": ")}<strong>{scheme.name}</strong>{scheme.nodes>0 ? <>{" · "}<span className="num">{nodeText}</span></> : ""}</span>;
 const facets=[contract.mechanism,failover,contract.read_access].filter(Boolean);
 const hasEvidence=scheme.source==="delivery-evidence" && Boolean(scheme.evidence?.length);
 const limits=contract.limitations || [];
 const hasLimits=limits.length>0;
 const archTitle =
  resolvedLabel.includes("目标") || /\btarget\b/i.test(resolvedLabel)
   ? bi("目标部署架构", "Target architecture")
   : resolvedLabel.includes("当前") || /\bactive\b|\bcurrent\b/i.test(resolvedLabel)
    ? bi("当前部署架构", "Active architecture")
    : resolvedLabel.includes("此配置") || /this config/i.test(resolvedLabel)
     ? bi("此配置对应部署架构", "Config architecture")
     : bi("部署架构", "Architecture");
 return <section className="scheme-summary" aria-label={resolvedLabel}>
  <div className="scheme-head"><span className="scheme-head-title"><span className="scheme-dot" aria-hidden /><strong>{archTitle}{bi("：", ": ")}{scheme.name}</strong></span>{scheme.nodes>0 && <span className="scheme-node-pill num">{nodeText}</span>}</div>
  {(scheme.topology || facets.length>0) && (
   <div className="scheme-pills">
    {scheme.topology && <span className="scheme-pill is-topo">{scheme.topology}</span>}
    {facets.map((f,i)=><span key={i} className="scheme-pill">{f}</span>)}
   </div>
  )}
  {(hasEvidence || hasLimits) && (
   <div className="scheme-foot">
    {hasEvidence && <div className="scheme-limit">{bi("根据历史交付识别 · ", "Inferred from delivery evidence · ")}{scheme.evidence?.join(bi("；", "; "))}</div>}
    {hasLimits && <div className="scheme-limit">{bi("适用限制：", "Limitations: ")}{limits.join(bi("；", "; "))}</div>}
   </div>
  )}
 </section>;
}

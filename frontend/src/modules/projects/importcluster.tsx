import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Drawer,
  Input,
  InputTag,
  Message,
  Select,
  Skeleton,
  Tag,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheck,
  IconCheckCircle,
  IconCode,
  IconCopy,
  IconDelete,
  IconDown,
  IconDownload,
  IconEdit,
  IconFile,
  IconImage,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSearch,
  IconUp,
} from "@arco-design/web-react/icon";
import { api, copy } from "../../shared/shared";
import type {
  ClusterView,
  ImportedCompanion,
  ImportedEndpoint,
  ImportedMeta,
  ImportedPkg,
  InstanceView,
} from "../../shared/shared";
import { go } from "../../app/router";
import { AppGlyph, InstanceGraph } from "../../design/ui";
import { bi, useLang } from "../../app/i18n";
import "./importcluster.css";

type RolePreset = { id: string; title: string; title_en?: string };

export type ImportPresetItem = {
  id: string;
  name: string;
  name_en?: string;
  category: string;
  category_title: string;
  category_title_en?: string;
  icon: string;
  color: string;
  summary: string;
  summary_en?: string;
  in_catalog: boolean;
  default_port?: number;
  versions?: string[];
  roles: RolePreset[];
  service_hints?: string[];
  config_hints?: string[];
  data_hints?: string[];
  log_hints?: string[];
};

export type CompanionCatalogItem = {
  id: string;
  name: string;
  kind: string;
  icon: string;
  color: string;
  default_role: string;
  role_title: string;
  topology: boolean;
  inherit_roles?: boolean;
  default_ports?: { name: string; port: number }[];
  service_hints?: string[];
  config_hints?: string[];
  data_hints?: string[];
};

type PresetsResp = {
  catalog: ImportPresetItem[];
  presets: ImportPresetItem[];
  companions?: CompanionCatalogItem[];
  platforms: { id: string; title: string }[];
  icons: string[];
  ai_enabled: boolean;
};

type HostRow = { name: string; ip: string; role: string; disk?: string };
type ParamRow = { key: string; value: string };

type ImportPayload = {
  id: string;
  component: string;
  display_name?: string;
  category?: string;
  icon?: string;
  color?: string;
  version: string;
  exact_version?: string;
  platform?: string;
  os_detail?: string;
  source_kind?: string;
  deploy_method?: string;
  arch_summary?: string;
  hosts: HostRow[];
  endpoints?: ImportedEndpoint[];
  companions?: ImportedCompanion[];
  suggested_companions?: ImportedCompanion[];
  service_units?: string[];
  config_paths?: string[];
  data_dirs?: string[];
  log_dirs?: string[];
  params?: Record<string, unknown>;
  packages?: ImportedPkg[];
  notes?: string;
  last_probed_at?: string;
};

type ParseResp = {
  draft: {
    suggested_id?: string;
    component?: string;
    display_name?: string;
    version?: string;
    exact_version?: string;
    platform?: string;
    os_detail?: string;
    deploy_method?: string;
    arch_summary?: string;
    hosts: HostRow[];
    endpoints: ImportedEndpoint[];
    companions?: ImportedCompanion[];
    service_units: string[];
    config_paths: string[];
    data_dirs: string[];
    log_dirs: string[];
    params: Record<string, unknown>;
    packages: ImportedPkg[];
    notes?: string;
  };
  parser: "ai" | "deterministic";
  ai_used: boolean;
  warnings: string[];
  missing_fields: string[];
};

const CLUSTER_ID_RE = /^[a-z][a-z0-9-]{0,40}$/;

const DEPLOY_METHODS = () => [
  { value: "systemd", label: bi("systemd 系统服务", "systemd Service") },
  { value: "docker", label: bi("Docker / 容器化", "Docker / Container") },
  { value: "binary", label: bi("二进制手工部署", "Binary / Manual") },
  { value: "k8s", label: "Kubernetes" },
  { value: "other", label: bi("其他形态", "Other") },
];

export const FALLBACK_COMPANIONS: CompanionCatalogItem[] = [
  { id: "patroni", name: "Patroni", kind: "ha_manager", icon: "patroni", color: "blue", default_role: "primary", role_title: "主控", topology: true, inherit_roles: true, default_ports: [{ name: "patroni-rest", port: 8008 }] },
  { id: "etcd", name: "etcd", kind: "dcs", icon: "etcd", color: "teal", default_role: "member", role_title: "成员", topology: true, default_ports: [{ name: "etcd 客户端", port: 2379 }, { name: "etcd 节点通信", port: 2380 }] },
  { id: "haproxy", name: "HAProxy", kind: "proxy", icon: "haproxy", color: "blue", default_role: "node", role_title: "负载均衡", topology: true, default_ports: [{ name: "HAProxy", port: 5000 }] },
  { id: "keepalived", name: "Keepalived", kind: "vip", icon: "keepalived", color: "teal", default_role: "node", role_title: "VRRP 节点", topology: true },
  { id: "nginx", name: "Nginx", kind: "proxy", icon: "nginx", color: "green", default_role: "node", role_title: "代理节点", topology: true, default_ports: [{ name: "Nginx", port: 80 }] },
  { id: "pgbouncer", name: "PgBouncer", kind: "pooler", icon: "postgresql", color: "indigo", default_role: "node", role_title: "连接池", topology: true, default_ports: [{ name: "PgBouncer", port: 6432 }] },
  { id: "pgbackrest", name: "pgBackRest", kind: "backup", icon: "storage", color: "emerald", default_role: "backup", role_title: "物理备份", topology: false },
  { id: "redis-sentinel", name: "Redis Sentinel", kind: "ha_manager", icon: "redis", color: "red", default_role: "sentinel", role_title: "哨兵", topology: true, default_ports: [{ name: "Sentinel", port: 26379 }] },
  { id: "zookeeper", name: "ZooKeeper", kind: "dcs", icon: "zookeeper", color: "amber", default_role: "node", role_title: "集群节点", topology: true, default_ports: [{ name: "ZooKeeper", port: 2181 }] },
  { id: "consul", name: "Consul", kind: "dcs", icon: "consul", color: "pink", default_role: "server", role_title: "Server", topology: true, default_ports: [{ name: "Consul", port: 8500 }] },
  { id: "clickhouse-keeper", name: "ClickHouse Keeper", kind: "dcs", icon: "clickhouse", color: "amber", default_role: "keeper", role_title: "Keeper", topology: true, default_ports: [{ name: "Keeper", port: 9181 }] },
  { id: "proxysql", name: "ProxySQL", kind: "proxy", icon: "mysql", color: "blue", default_role: "router", role_title: "代理路由", topology: true, default_ports: [{ name: "ProxySQL", port: 6033 }] },
  { id: "maxscale", name: "MariaDB MaxScale", kind: "proxy", icon: "mariadb", color: "indigo", default_role: "router", role_title: "代理路由", topology: true, default_ports: [{ name: "MaxScale", port: 4006 }] },
  { id: "obproxy", name: "OBProxy", kind: "proxy", icon: "oceanbase", color: "teal", default_role: "router", role_title: "代理路由", topology: true, default_ports: [{ name: "OBProxy", port: 2883 }] },
  { id: "node-exporter", name: "node_exporter", kind: "monitoring", icon: "prometheus", color: "coral", default_role: "exporter", role_title: "指标采集", topology: false, default_ports: [{ name: "Metrics", port: 9100 }] },
];

export const COMPANION_SUGGESTIONS_BY_PRIMARY: Record<string, string[]> = {
  postgresql: ["patroni", "etcd", "haproxy", "keepalived", "pgbouncer", "pgbackrest"],
  mysql: ["proxysql", "haproxy", "keepalived", "nginx"],
  mariadb: ["maxscale", "haproxy", "keepalived", "proxysql"],
  redis: ["redis-sentinel", "keepalived", "haproxy"],
  valkey: ["redis-sentinel", "keepalived", "haproxy"],
  kafka: ["zookeeper", "node-exporter"],
  clickhouse: ["clickhouse-keeper", "zookeeper", "haproxy"],
  oceanbase: ["obproxy", "keepalived"],
  nginx: ["keepalived", "node-exporter"],
  haproxy: ["keepalived", "node-exporter"],
  apisix: ["etcd", "keepalived"],
};

import {
  companionKindMeta,
  detectMissingCompanionsFromMeta,
  localizeEndpointTitle,
} from "./topology";
export {
  companionKindMeta,
  detectMissingCompanionsFromMeta,
  localizeEndpointTitle,
};

const normalizeTagList = (vals: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of vals || []) {
    for (const part of String(raw).split(/[\n,，]+/)) {
      const t = part.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
};

const readFileAsDataURL = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });

function normalizeEndpointRole(role?: string): string {
  switch ((role || "").trim().toLowerCase()) {
    case "readonly":
    case "ro":
    case "read":
    case "reader":
    case "replica":
    case "standby":
    case "slave":
    case "secondary":
    case "follower":
      return "readonly";
    case "admin":
    case "console":
    case "mgmt":
    case "management":
    case "ui":
    case "dashboard":
    case "metrics":
    case "monitor":
    case "web":
      return "admin";
    default:
      return "readwrite";
  }
}

function docPlaceholderFor(compID: string, displayName: string, defaultPort?: number): string {
  const p = defaultPort || 5432;
  if (compID === "postgresql") {
    return bi(
      "例如：\ndb-node-01  10.20.1.11  primary\ndb-node-02  10.20.1.12  replica\ndb-node-03  10.20.1.13  replica\n组件栈：PostgreSQL 17.11 + Patroni + etcd (3节点) + pgBackRest\n入口 VIP：pg-prod.internal:5432，数据盘 /dev/vdb -> /data/pg",
      "Example:\ndb-node-01  10.20.1.11  primary\ndb-node-02  10.20.1.12  replica\ndb-node-03  10.20.1.13  replica\nStack: PostgreSQL 17.11 + Patroni + etcd (3-node) + pgBackRest\nVIP: pg-prod.internal:5432, data disk /dev/vdb -> /data/pg",
    );
  }
  if (compID === "redis" || compID === "valkey") {
    return bi(
      `例如：\nredis-1  10.20.1.11  primary\nredis-2  10.20.1.12  replica\nredis-3  10.20.1.13  replica\n伴生：Redis Sentinel (:26379)，版本 7.2，配置 /etc/redis/redis.conf`,
      `Example:\nredis-1  10.20.1.11  primary\nredis-2  10.20.1.12  replica\nredis-3  10.20.1.13  replica\nCompanion: Redis Sentinel (:26379), version 7.2`,
    );
  }
  return bi(
    `例如：\n${compID || "node"}-1  10.20.1.11  primary\n${compID || "node"}-2  10.20.1.12  replica\n入口 VIP：10.20.1.100:${p}\n版本：${displayName || "Middleware"}，以及 HAProxy / Keepalived / etcd 等伴生组件说明`,
    `Example:\n${compID || "node"}-1  10.20.1.11  primary\n${compID || "node"}-2  10.20.1.12  replica\nVIP: 10.20.1.100:${p}\nVersion: ${displayName || "Middleware"} and companion components (HAProxy / Keepalived / etcd)`,
  );
}

function buildPreviewInstances(
  compID: string,
  displayName: string,
  version: string,
  hosts: HostRow[],
  rolesMeta: RolePreset[],
  endpoints: ImportedEndpoint[],
  companions: ImportedCompanion[],
  companionCatalog: CompanionCatalogItem[],
  params: Record<string, unknown>,
): InstanceView[] {
  const roles: Record<string, string[]> = {};
  const roleTitles: Record<string, string> = {};
  for (const rm of rolesMeta) roleTitles[rm.id] = rm.title;
  const hostNames: string[] = [];
  for (const h of hosts) {
    const hn = h.name.trim();
    if (!hn) continue;
    hostNames.push(hn);
    const rk = (h.role || rolesMeta[0]?.id || "node").trim();
    if (!roles[rk]) roles[rk] = [];
    roles[rk].push(hn);
    if (!roleTitles[rk]) roleTitles[rk] = rk;
  }

  const syncRepl =
    String(params?.replication || "").toLowerCase() === "quorum" ||
    String(params?.replication || "").toLowerCase() === "sync" ||
    String(params?.synchronous_mode || "").toLowerCase() === "true";

  const flows: InstanceView["flows"] = [];
  if (roles.primary?.length && (roles.replica?.length || roles.secondary?.length || roles.standby?.length)) {
    const target = roles.replica?.length ? "replica" : roles.secondary?.length ? "secondary" : "standby";
    flows.push({
      id: "rep",
      title: compID === "postgresql" ? bi("WAL 流复制", "WAL Replication") : bi("主从同步", "Replication"),
      from: roles.primary,
      to: roles[target],
      from_role: "primary",
      to_role: target,
      kind: "replication",
      sync: syncRepl,
    });
  } else if (roles.member?.length && roles.member.length > 1) {
    flows.push({ id: "mesh", title: bi("集群共识", "Quorum"), from: roles.member, to: roles.member, from_role: "member", to_role: "member", kind: "mesh", sync: true });
  } else if (roles.broker?.length && roles.controller?.length) {
    flows.push({ id: "ctrl", title: bi("元数据协同", "Metadata"), from: roles.broker, to: roles.controller, from_role: "broker", to_role: "controller", kind: "replication", sync: false });
  } else if (roles.master?.length && roles.data?.length) {
    flows.push({ id: "sched", title: bi("分片调度", "Shards"), from: roles.master, to: roles.data, from_role: "master", to_role: "data", kind: "replication", sync: false });
  }

  const fronts: InstanceView["fronts"] = {};
  const eps: InstanceView["endpoints"] = [];
  for (const ep of endpoints) {
    if (!ep.address.trim()) continue;
    const epName = ep.name?.trim() || ep.role || "endpoint";
    const epTitle = localizeEndpointTitle(ep.name, ep.role);
    const [addr, portStr] = ep.address.trim().split(":");
    const listen = parseInt(portStr || "0", 10) || 0;
    eps.push({
      name: epName,
      title: epTitle,
      protocol: "tcp",
      port: listen,
      lb: "",
      backends: hosts
        .filter((h) => h.name.trim())
        .map((h) => ({ host: h.name.trim(), ip: h.ip.trim(), port: listen, role: h.role })),
    });
    fronts[epName] = {
      balancer: "external",
      name: epName,
      listen,
      address: addr,
      external: true,
    };
  }

  const primaryID = compID || "middleware";
  const result: InstanceView[] = [
    {
      id: primaryID,
      component: primaryID,
      title: displayName || primaryID,
      version: version || "",
      status: "published",
      roles,
      role_titles: roleTitles,
      hosts: hostNames,
      params: {},
      visible: {},
      endpoints: eps,
      fronts,
      flows,
    },
  ];

  // Materialize topology companions into the live InstanceGraph preview!
  const catalogByID = new Map(companionCatalog.map((c) => [c.id, c]));
  for (const cm of companions) {
    const cid = (cm.component || "").trim().toLowerCase();
    if (!cid || cid === primaryID) continue;
    const def = catalogByID.get(cid);
    const isTopo = cm.kind !== "backup" && cm.kind !== "monitoring" && (def ? def.topology : true);
    if (!isTopo || hostNames.length === 0) continue;

    let cRoles: Record<string, string[]> = {};
    const cRoleTitles: Record<string, string> = {};
    if (cm.placement && Object.keys(cm.placement).length > 0) {
      for (const [rk, hs] of Object.entries(cm.placement)) {
        const valid = (hs || []).filter((h) => hostNames.includes(h));
        if (valid.length > 0) cRoles[rk] = valid;
      }
    }
    if (Object.keys(cRoles).length === 0) {
      if (def?.inherit_roles && Object.keys(roles).length > 0) {
        cRoles = { ...roles };
        Object.assign(cRoleTitles, roleTitles);
        if (cid === "patroni") {
          cRoleTitles.primary = bi("主控", "Leader");
          cRoleTitles.replica = bi("备控", "Standby");
        }
      } else {
        const target = (cm.hosts || []).filter((h) => hostNames.includes(h));
        const rk = cm.role || def?.default_role || "node";
        cRoles[rk] = target.length > 0 ? target : hostNames;
        cRoleTitles[rk] = def?.role_title || rk;
      }
    } else if (cid === "patroni") {
      cRoleTitles.primary = bi("主控", "Leader");
      cRoleTitles.replica = bi("备控", "Standby");
    }
    const cFlows: InstanceView["flows"] = [];
    const firstRole = Object.keys(cRoles)[0];
    if (firstRole && cRoles[firstRole].length > 1 && ["etcd", "zookeeper", "consul", "redis-sentinel", "clickhouse-keeper", "keepalived"].includes(cid)) {
      const flowTitle =
        cid === "etcd"
          ? bi("Raft 共识", "Raft Quorum")
          : cid === "keepalived"
            ? bi("VRRP 心跳", "VRRP Heartbeat")
            : cid === "zookeeper"
              ? bi("ZAB 共识", "ZAB Quorum")
              : bi("仲裁共识", "Quorum");
      cFlows.push({
        id: `${cid}-mesh`,
        title: flowTitle,
        from: cRoles[firstRole],
        to: cRoles[firstRole],
        from_role: firstRole,
        to_role: firstRole,
        kind: "mesh",
        sync: cid !== "keepalived",
      });
    }
    const cHosts = [...new Set(Object.values(cRoles).flat())];
    result.push({
      id: cid,
      component: cid,
      title: cm.display_name || def?.name || cid,
      version: cm.version || "",
      status: "published",
      managed_context: cid === "patroni" && primaryID === "postgresql" ? primaryID : undefined,
      roles: cRoles,
      role_titles: cRoleTitles,
      hosts: cHosts,
      params: {},
      visible: {},
      flows: cFlows,
    });
  }

  return result;
}

const EMPTY_PLATFORMS: { id: string; title: string }[] = [];

/* ---- Reusable Swiss Sub-Components ---- */

const MiddlewareCard = React.memo(function MiddlewareCard({
  item,
  selected,
  isEn,
  showCatalogBadge,
  onSelect,
}: {
  item: ImportPresetItem;
  selected: boolean;
  isEn: boolean;
  showCatalogBadge: boolean;
  onSelect: (item: ImportPresetItem) => void;
}) {
  return (
    <button
      type="button"
      className={`imp-mw-card ${selected ? "is-selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(item)}
    >
      <AppGlyph id={item.id} icon={item.icon} color={item.color} size={32} />
      <div className="imp-mw-meta">
        <div className="imp-mw-name-row">
          <span className="imp-mw-name">
            {isEn ? item.name_en || item.name : item.name}
          </span>
          {showCatalogBadge && (
            <span className="imp-mw-badge">{bi("目录", "Catalog")}</span>
          )}
        </div>
        <span className="imp-mw-desc">
          {isEn ? item.summary_en || item.summary : item.summary}
        </span>
      </div>
    </button>
  );
});

const Step1PlatformSelects = React.memo(function Step1PlatformSelects({
  platforms,
  platform,
  onPlatformChange,
  deployMethod,
  onDeployMethodChange,
  lang,
}: {
  platforms: { id: string; title: string }[];
  platform: string;
  onPlatformChange: (v: string) => void;
  deployMethod: string;
  onDeployMethodChange: (v: string) => void;
  lang: string;
}) {
  const deployOptions = useMemo(() => DEPLOY_METHODS(), [lang]);
  return (
    <div className="imp-pair-grid">
      <div className="imp-field">
        <label>
          <span className="imp-lbl-left">{bi("操作系统平台", "OS Platform")}</span>
        </label>
        <Select
          allowClear
          showSearch
          placeholder={bi("自动识别或手选", "Auto or select")}
          value={platform || undefined}
          onChange={(v) => onPlatformChange(v || "")}
        >
          {platforms.map((pl) => (
            <Select.Option key={pl.id} value={pl.id}>
              {pl.title}
            </Select.Option>
          ))}
          <Select.Option value="linux-custom">
            {bi("其他 Linux 发行版", "Other Linux")}
          </Select.Option>
        </Select>
      </div>
      <div className="imp-field">
        <label>
          <span className="imp-lbl-left">{bi("部署形态", "Deploy Mode")}</span>
        </label>
        <Select value={deployMethod} onChange={onDeployMethodChange}>
          {deployOptions.map((dm) => (
            <Select.Option key={dm.value} value={dm.value}>
              {dm.label}
            </Select.Option>
          ))}
        </Select>
      </div>
    </div>
  );
});

function ProbeCodeBlock({
  script,
  filename,
  safe = true,
  compact = false,
}: {
  script: string;
  filename: string;
  safe?: boolean;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => (script ? script.split("\n") : []), [script]);
  const previewText = useMemo(
    () => (expanded || lines.length <= 12 ? script : lines.slice(0, 12).join("\n") + `\n# ... (${lines.length - 12} more lines)`),
    [expanded, lines, script],
  );

  const downloadScript = () => {
    const blob = new Blob([script], { type: "text/x-shellscript;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="imp-probe-box">
      <div className="imp-probe-bar">
        <span className="imp-probe-shield">
          <IconCheckCircle />
          <span>
            {safe
              ? bi("100% 静态只读安全校验", "100% Static Read-Only Verified")
              : bi("只读探针脚本", "Read-Only Probe")}
          </span>
          <code>{filename}</code>
          <span className="muted small">({lines.length} {bi("行", "lines")})</span>
        </span>
        <div className="imp-probe-actions">
          {lines.length > 12 && (
            <Button
              size="mini"
              type="text"
              icon={expanded ? <IconUp /> : <IconDown />}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? bi("收起", "Collapse") : bi("展开全部", "Expand")}
            </Button>
          )}
          <Button
            size="mini"
            icon={<IconCopy />}
            onClick={() => {
              copy(script);
              Message.success(bi("已复制只读采集脚本", "Read-only probe script copied"));
            }}
          >
            {bi("复制脚本", "Copy")}
          </Button>
          {!compact && (
            <Button size="mini" icon={<IconDownload />} onClick={downloadScript}>
              {bi("下载 .sh", "Download .sh")}
            </Button>
          )}
        </div>
      </div>
      <pre className={`imp-probe-pre ${expanded ? "is-expanded" : ""}`}>
        {previewText || bi("正在生成只读采集脚本…", "Generating read-only probe script...")}
      </pre>
    </div>
  );
}

function ParsingStagePanel({ active, aiEnabled }: { active: boolean; aiEnabled: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      setElapsed((Date.now() - started) / 1000);
    }, 200);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!active) return null;

  const stages = [
    bi("凭据脱敏与规范化", "Redacting secrets"),
    bi("识别主机、版本与磁盘", "Parsing hosts & OS"),
    bi("识别伴生架构组件栈", "Detecting companions"),
    bi("合成多组件运行拓扑", "Synthesizing topology"),
  ];
  const currentIdx = elapsed < 0.8 ? 0 : elapsed < 2.4 ? 1 : elapsed < 5.5 ? 2 : 3;

  return (
    <div className="imp-ai-stage" role="status" aria-live="polite">
      <div className="imp-ai-stage-head">
        <span className="imp-ai-stage-title">
          <span className="imp-ai-pulse" />
          {aiEnabled
            ? bi("AI 正在解析现场回显并识别多组件架构…", "AI is analyzing input & detecting companion stack...")
            : bi("内置规则引擎正在提取基线与伴生组件…", "Rule engine is extracting baseline & companions...")}
        </span>
        <span className="mono small muted num">{elapsed.toFixed(1)}s</span>
      </div>
      <div className="imp-ai-steps">
        {stages.map((label, idx) => {
          const done = idx < currentIdx;
          const on = idx === currentIdx;
          return (
            <div key={idx} className={`imp-ai-step ${done ? "is-done" : on ? "is-active" : ""}`}>
              <span className="imp-ai-step-dot" />
              <span>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompanionStackEditor({
  primaryCompID,
  primaryDisplayName,
  primaryVersion,
  primaryIcon,
  primaryColor,
  hosts,
  companions,
  suggestedCompanions = [],
  catalog,
  onChange,
  onAdoptSuggested,
}: {
  primaryCompID: string;
  primaryDisplayName: string;
  primaryVersion: string;
  primaryIcon: string;
  primaryColor: string;
  hosts: HostRow[];
  companions: ImportedCompanion[];
  suggestedCompanions?: ImportedCompanion[];
  catalog: CompanionCatalogItem[];
  onChange: (next: ImportedCompanion[]) => void;
  onAdoptSuggested?: () => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customKind, setCustomKind] = useState("companion");
  const [customPort, setCustomPort] = useState("");

  const catalogByID = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const activeIDs = useMemo(
    () => new Set([primaryCompID.toLowerCase(), ...companions.map((c) => c.component.toLowerCase())]),
    [primaryCompID, companions],
  );

  const quickIDs = useMemo(() => {
    const preferred =
      COMPANION_SUGGESTIONS_BY_PRIMARY[primaryCompID.toLowerCase()] || [
        "haproxy",
        "keepalived",
        "nginx",
        "etcd",
        "zookeeper",
      ];
    return preferred.filter((id) => !activeIDs.has(id) && catalogByID.has(id));
  }, [primaryCompID, activeIDs, catalogByID]);

  const validHostNames = useMemo(
    () => hosts.map((h) => h.name.trim()).filter(Boolean),
    [hosts],
  );

  const addCatalogCompanion = (id: string) => {
    const def = catalogByID.get(id);
    if (!def || activeIDs.has(id)) return;
    const ports = (def.default_ports || []).map((p) => p.port).filter((p) => p > 0);
    const nextItem: ImportedCompanion = {
      component: def.id,
      display_name: def.name,
      kind: def.kind,
      role: def.default_role,
      hosts: validHostNames,
      ports,
      service_units: def.service_hints || [],
      config_paths: def.config_hints || [],
      data_dirs: def.data_hints || [],
      evidence: bi("手工添加", "Added manually"),
    };
    onChange([...companions, nextItem]);
  };

  const addCustomCompanion = () => {
    const name = customName.trim();
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "companion";
    if (activeIDs.has(id)) {
      Message.warning(bi("该伴生组件已存在", "Companion already added"));
      return;
    }
    const pn = parseInt(customPort.trim(), 10);
    onChange([
      ...companions,
      {
        component: id,
        display_name: name,
        kind: customKind,
        role: "node",
        hosts: validHostNames,
        ports: Number.isFinite(pn) && pn > 0 ? [pn] : [],
        evidence: bi("手工添加", "Added manually"),
      },
    ]);
    setCustomName("");
    setCustomPort("");
    setCustomOpen(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {suggestedCompanions.length > 0 && onAdoptSuggested && (
        <div className="imp-suggest-bar">
          <div>
            <b>{bi("检测到未纳入拓扑的伴生组件：", "Unmodeled companion components detected: ")}</b>
            {suggestedCompanions.map((s) => s.display_name || s.component).join(" · ")}
          </div>
          <Button size="mini" type="primary" onClick={onAdoptSuggested}>
            {bi("一键全部纳入", "Adopt All")}
          </Button>
        </div>
      )}

      <div className="imp-stack-list">
        {/* Primary component row */}
        <div className="imp-stack-item is-primary">
          <AppGlyph id={primaryCompID} icon={primaryIcon} color={primaryColor} size={30} />
          <div className="imp-stack-main">
            <div className="imp-stack-top">
              <strong>{primaryDisplayName || primaryCompID}</strong>
              <span className="imp-kind-pill t-brand">{bi("主中间件", "Primary")}</span>
              {primaryVersion && <span className="mono small muted">{primaryVersion}</span>}
            </div>
            <div className="imp-stack-meta">
              <span>{bi(`${validHostNames.length} 台节点`, `${validHostNames.length} host(s)`)}</span>
            </div>
          </div>
          <span className="small muted">{bi("核心组件", "Core")}</span>
        </div>

        {/* Companion component rows */}
        {companions.map((cm, idx) => {
          const def = catalogByID.get(cm.component);
          const km = companionKindMeta(cm.kind);
          const hostCount = cm.placement
            ? new Set(Object.values(cm.placement).flat()).size
            : cm.hosts?.length || validHostNames.length;
          return (
            <div key={`${cm.component}-${idx}`} className="imp-stack-item">
              <AppGlyph
                id={cm.component}
                icon={def?.icon || cm.component}
                color={def?.color || "slate"}
                size={28}
              />
              <div className="imp-stack-main">
                <div className="imp-stack-top">
                  <strong>{cm.display_name || def?.name || cm.component}</strong>
                  <span className={`imp-kind-pill ${km.tone}`}>{km.label}</span>
                  {cm.ports && cm.ports.length > 0 && (
                    <span className="mono small muted">:{cm.ports.join(", :")}</span>
                  )}
                </div>
                <div className="imp-stack-meta">
                  <span>{bi(`${hostCount} 台节点`, `${hostCount} host(s)`)}</span>
                  {validHostNames.length > 1 && hostCount < validHostNames.length && cm.kind !== "backup" && cm.kind !== "monitoring" && (
                    <button
                      type="button"
                      className="cl-imp-notes-toggle"
                      onClick={() =>
                        onChange(
                          companions.map((item, i) =>
                            i === idx
                              ? { ...item, hosts: validHostNames, placement: undefined }
                              : item,
                          ),
                        )
                      }
                    >
                      {bi(`展开至全部 ${validHostNames.length} 节点`, `Expand to all ${validHostNames.length} hosts`)}
                    </button>
                  )}
                  {cm.evidence && <span>· {cm.evidence}</span>}
                </div>
              </div>
              <div className="imp-stack-controls">
                <Input
                  size="small"
                  placeholder={bi("版本(选填)", "Version")}
                  value={cm.version || ""}
                  onChange={(v) =>
                    onChange(companions.map((item, i) => (i === idx ? { ...item, version: v } : item)))
                  }
                />
                <Button
                  size="small"
                  type="text"
                  status="danger"
                  icon={<IconDelete />}
                  onClick={() => onChange(companions.filter((_, i) => i !== idx))}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Quick-add companion pills */}
      <div className="imp-quick-add">
        <span className="imp-quick-add-lbl">{bi("补充伴生组件：", "Add companion:")}</span>
        <div className="imp-quick-add-pills">
          {quickIDs.map((id) => {
            const def = catalogByID.get(id)!;
            return (
              <button
                key={id}
                type="button"
                className="imp-quick-chip"
                onClick={() => addCatalogCompanion(id)}
              >
                <IconPlus style={{ fontSize: 10 }} />
                {def.name}
              </button>
            );
          })}
          <button
            type="button"
            className="imp-quick-chip"
            onClick={() => setCustomOpen((v) => !v)}
          >
            <IconPlus style={{ fontSize: 10 }} />
            {bi("其他组件", "Custom")}
          </button>
        </div>
      </div>

      {customOpen && (
        <div className="imp-ep-row" style={{ paddingTop: 4 }}>
          <Input
            size="small"
            placeholder={bi("组件名，如 Keepalived", "Name, e.g. Keepalived")}
            value={customName}
            onChange={setCustomName}
          />
          <Select size="small" value={customKind} onChange={setCustomKind}>
            <Select.Option value="ha_manager">{bi("高可用管理", "HA Manager")}</Select.Option>
            <Select.Option value="dcs">{bi("分布式协调 DCS", "DCS / Quorum")}</Select.Option>
            <Select.Option value="proxy">{bi("代理 / 均衡", "Proxy / LB")}</Select.Option>
            <Select.Option value="vip">{bi("虚拟 IP", "VIP")}</Select.Option>
            <Select.Option value="pooler">{bi("连接池", "Pooler")}</Select.Option>
            <Select.Option value="backup">{bi("备份工具", "Backup")}</Select.Option>
            <Select.Option value="companion">{bi("其他伴生组件", "Companion")}</Select.Option>
          </Select>
          <Input
            size="small"
            placeholder={bi("端口", "Port")}
            value={customPort}
            onChange={setCustomPort}
          />
          <Button size="small" type="primary" onClick={addCustomCompanion}>
            {bi("加", "Add")}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------- Main Import Cluster Workbench Page (#/import) ---------- */

export function ImportClusterPage({
  component,
  onImported,
}: {
  component?: string;
  onImported?: () => Promise<void>;
}) {
  const lang = useLang();
  const isEn = lang === "en-US";
  const [presetsData, setPresetsData] = useState<PresetsResp | null>(null);
  const [loadingPresets, setLoadingPresets] = useState(true);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");

  // Step 1: Middleware & Cluster identity
  const [isCustom, setIsCustom] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<ImportPresetItem | null>(null);
  const [customName, setCustomName] = useState("");
  const [customIcon, setCustomIcon] = useState("server");
  const [customColor, setCustomColor] = useState("blue");
  const [clusterId, setClusterId] = useState("");
  const [version, setVersion] = useState("");
  const [exactVersion, setExactVersion] = useState("");
  const [platform, setPlatform] = useState("ubuntu-24.04-amd64");
  const [osDetail, setOsDetail] = useState("");
  const [deployMethod, setDeployMethod] = useState("systemd");
  const [archSummary, setArchSummary] = useState("");

  // Step 2: Capture method (probe | ai_doc | manual)
  const [inputMode, setInputMode] = useState<"probe" | "ai_doc" | "manual">("probe");
  const [probeScript, setProbeScript] = useState("");
  const [probeFilename, setProbeFilename] = useState("mw-import-probe.sh");
  const [probeSafe, setProbeSafe] = useState(true);
  const [pasteText, setPasteText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);
  const [parseInfo, setParseInfo] = useState<{ parser: string; warnings: string[]; missing: string[]; companionCount: number } | null>(null);

  // Step 2 manual & Step 3 editable baseline
  const [hosts, setHosts] = useState<HostRow[]>([{ name: "node-1", ip: "", role: "primary", disk: "" }]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [endpoints, setEndpoints] = useState<ImportedEndpoint[]>([]);
  const [companions, setCompanions] = useState<ImportedCompanion[]>([]);
  const [serviceUnits, setServiceUnits] = useState<string[]>([]);
  const [configPaths, setConfigPaths] = useState<string[]>([]);
  const [dataDirs, setDataDirs] = useState<string[]>([]);
  const [logDirs, setLogDirs] = useState<string[]>([]);
  const [paramRows, setParamRows] = useState<ParamRow[]>([]);
  const [packages, setPackages] = useState<ImportedPkg[]>([]);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const companionCatalog = useMemo(
    () => (presetsData?.companions?.length ? presetsData.companions : FALLBACK_COMPANIONS),
    [presetsData?.companions],
  );

  // Load catalog + presets
  useEffect(() => {
    let alive = true;
    setLoadingPresets(true);
    api<PresetsResp>("/api/clusters/import/presets")
      .then((res) => {
        if (!alive) return;
        setPresetsData(res);
        const all = [...(res.catalog || []), ...(res.presets || [])];
        if (component) {
          const hit = all.find((x) => x.id === component.toLowerCase());
          if (hit) {
            setSelectedPreset(hit);
            setVersion(hit.versions?.[0] || "");
            if (hit.roles?.length) {
              setHosts([{ name: "node-1", ip: "", role: hit.roles[0].id, disk: "" }]);
            }
          }
        } else if (all.length > 0) {
          const def = all.find((x) => x.id === "postgresql") || all[0];
          setSelectedPreset(def);
          setVersion(def.versions?.[0] || "");
          if (def.roles?.length) {
            setHosts([{ name: "node-1", ip: "", role: def.roles[0].id, disk: "" }]);
          }
        }
      })
      .catch((e: Error) => Message.error(e.message || bi("加载中间件预设失败", "Failed to load presets")))
      .finally(() => alive && setLoadingPresets(false));
    return () => {
      alive = false;
    };
  }, [component]);

  const effectiveCompID = useMemo(() => {
    if (isCustom) {
      return (
        customName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "custom-middleware"
      );
    }
    return selectedPreset?.id || "custom-middleware";
  }, [isCustom, customName, selectedPreset]);

  const effectiveDisplayName = useMemo(() => {
    if (isCustom) return customName.trim() || bi("自定义中间件", "Custom Middleware");
    if (!selectedPreset) return "";
    return isEn ? selectedPreset.name_en || selectedPreset.name : selectedPreset.name;
  }, [isCustom, customName, selectedPreset, isEn]);

  const effectiveRoles = useMemo<RolePreset[]>(() => {
    if (!isCustom && selectedPreset?.roles?.length) return selectedPreset.roles;
    return [
      { id: "primary", title: "主节点", title_en: "Primary" },
      { id: "replica", title: "从节点", title_en: "Replica" },
      { id: "node", title: "节点", title_en: "Node" },
    ];
  }, [isCustom, selectedPreset]);

  // Fetch read-only probe script when entering Step 2 in probe mode
  useEffect(() => {
    if (step !== 2 || inputMode !== "probe") return;
    let alive = true;
    api<{ script: string; filename: string; safe: boolean }>("/api/clusters/import/probe-script", {
      method: "POST",
      body: JSON.stringify({
        component: effectiveCompID,
        display_name: effectiveDisplayName,
        deploy_method: deployMethod,
      }),
    })
      .then((res) => {
        if (!alive) return;
        setProbeScript(res.script);
        setProbeFilename(res.filename);
        setProbeSafe(res.safe);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [step, inputMode, effectiveCompID, effectiveDisplayName, deployMethod]);

  const categories = useMemo(
    () => [
      { id: "all", label: bi("全部", "All") },
      { id: "catalog", label: bi("平台目录", "Catalog") },
      { id: "database", label: bi("数据库", "Database") },
      { id: "cache", label: bi("缓存与协调", "Cache & DCS") },
      { id: "queue", label: bi("消息队列", "Queue") },
      { id: "search", label: bi("搜索", "Search") },
      { id: "storage", label: bi("存储", "Storage") },
      { id: "proxy", label: bi("代理与网关", "Proxy") },
      { id: "observability", label: bi("可观测", "Observability") },
      { id: "runtime", label: bi("运行与制品", "Runtime") },
    ],
    [lang],
  );

  const filterList = (list: ImportPresetItem[]) => {
    const q = search.trim().toLowerCase();
    return list.filter((item) => {
      if (catFilter === "catalog" && !item.in_catalog) return false;
      if (catFilter !== "all" && catFilter !== "catalog" && item.category !== catFilter) return false;
      if (!q) return true;
      return (
        item.id.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        (item.name_en || "").toLowerCase().includes(q) ||
        item.summary.toLowerCase().includes(q)
      );
    });
  };

  const filteredCatalog = useMemo(() => filterList(presetsData?.catalog || []), [presetsData, search, catFilter]);
  const filteredPresets = useMemo(() => filterList(presetsData?.presets || []), [presetsData, search, catFilter]);

  const selectPreset = useCallback((item: ImportPresetItem) => {
    setIsCustom(false);
    setSelectedPreset(item);
    setVersion(item.versions?.[0] || "");
    setExactVersion("");
    if (item.roles?.length) {
      setHosts((prev) =>
        prev.map((h, i) => ({
          ...h,
          role: item.roles[Math.min(i, item.roles.length - 1)]?.id || item.roles[0].id,
        })),
      );
    }
  }, []);

  const handlePlatformChange = useCallback((v: string) => setPlatform(v), []);
  const handleDeployMethodChange = useCallback((v: string) => setDeployMethod(v), []);
  const platformsList = presetsData?.platforms ?? EMPTY_PLATFORMS;

  const canProceedStep1 =
    CLUSTER_ID_RE.test(clusterId.trim()) &&
    (isCustom ? customName.trim().length > 0 : selectedPreset !== null);

  const validHosts = useMemo(() => hosts.filter((h) => h.name.trim() || h.ip.trim()), [hosts]);

  const handlePasteImage = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (!file) continue;
        if (images.length >= 4) {
          Message.warning(bi("最多上传 4 张截图", "Up to 4 screenshots allowed"));
          return;
        }
        try {
          const dataUrl = await readFileAsDataURL(file);
          setImages((prev) => (prev.length < 4 ? [...prev, dataUrl] : prev));
          Message.success(bi("已粘贴截图，解析时将自动识别", "Screenshot pasted for extraction"));
        } catch {
          // ignore
        }
      }
    }
  };

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files) return;
    const room = 4 - images.length;
    const picked = Array.from(files).slice(0, room);
    for (const f of picked) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > 4 * 1024 * 1024) {
        Message.warning(bi(`${f.name} 超过 4MB，已跳过`, `${f.name} exceeds 4MB, skipped`));
        continue;
      }
      try {
        const dataUrl = await readFileAsDataURL(f);
        setImages((prev) => (prev.length < 4 ? [...prev, dataUrl] : prev));
      } catch {
        // ignore
      }
    }
  };

  const runParseAndProceed = async () => {
    if (parsing) return;
    if (!pasteText.trim() && images.length === 0) {
      Message.warning(bi("请先粘贴采集脚本输出或文档文本，或上传截图", "Paste probe output / text or upload screenshots first"));
      return;
    }
    setParsing(true);
    try {
      const res = await api<ParseResp>("/api/clusters/import/parse", {
        method: "POST",
        body: JSON.stringify({
          component: effectiveCompID,
          display_name: effectiveDisplayName,
          source_kind: inputMode === "probe" ? "probe" : "ai_doc",
          text: pasteText,
          images,
          use_ai: true,
        }),
      });
      const d = res.draft;
      if (d.suggested_id && !clusterId.trim() && CLUSTER_ID_RE.test(d.suggested_id)) {
        setClusterId(d.suggested_id);
      }
      if (d.version) setVersion(d.version);
      if (d.exact_version) setExactVersion(d.exact_version);
      if (d.platform) setPlatform(d.platform);
      if (d.os_detail) setOsDetail(d.os_detail);
      if (d.deploy_method) setDeployMethod(d.deploy_method);
      if (d.arch_summary) setArchSummary(d.arch_summary);
      if (d.hosts?.length) setHosts(d.hosts);
      if (d.endpoints?.length) {
        setEndpoints(
          d.endpoints.map((ep) => ({ ...ep, role: normalizeEndpointRole(ep.role) })),
        );
      }
      if (d.companions?.length) setCompanions(d.companions);
      if (d.service_units?.length) setServiceUnits(d.service_units);
      if (d.config_paths?.length) setConfigPaths(d.config_paths);
      if (d.data_dirs?.length) setDataDirs(d.data_dirs);
      if (d.log_dirs?.length) setLogDirs(d.log_dirs);
      if (d.params && Object.keys(d.params).length > 0) {
        setParamRows(
          Object.entries(d.params).map(([k, v]) => ({
            key: k,
            value: typeof v === "string" ? v : (JSON.stringify(v) ?? ""),
          })),
        );
      }
      if (d.packages?.length) setPackages(d.packages);
      if (d.notes) setNotes(d.notes);

      setParseInfo({
        parser: res.parser,
        warnings: res.warnings || [],
        missing: res.missing_fields || [],
        companionCount: d.companions?.length || 0,
      });
      Message.success(
        res.ai_used
          ? bi(
              `AI 已完成基线提取${d.companions?.length ? `（识别到 ${d.companions.length} 个伴生组件）` : ""}，请核对后建档`,
              `AI extracted baseline${d.companions?.length ? ` (${d.companions.length} companion(s) detected)` : ""}`,
            )
          : bi("已按内置规则提取基线草稿，请核对后建档", "Baseline extracted by built-in parser; please review"),
      );
      setStep(3);
    } catch (e) {
      Message.error((e as Error).message || bi("解析失败", "Parse failed"));
    } finally {
      setParsing(false);
    }
  };

  const applyBatchHosts = () => {
    const lines = batchText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const parsed: HostRow[] = [];
    for (const ln of lines) {
      const toks = ln.split(/[\s,;\t|]+/).filter(Boolean);
      if (toks.length === 0) continue;
      let name = "";
      let ip = "";
      let role = "";
      if (/^\d+\.\d+\.\d+\.\d+$/.test(toks[0])) {
        ip = toks[0];
        name = toks[1] || `node-${parsed.length + 1}`;
        role = toks[2] || "";
      } else {
        name = toks[0];
        ip = toks[1] || "";
        role = toks[2] || "";
      }
      if (!role) {
        role =
          parsed.length === 0
            ? effectiveRoles[0]?.id || "primary"
            : effectiveRoles[1]?.id || effectiveRoles[0]?.id || "node";
      }
      parsed.push({ name, ip, role, disk: "" });
    }
    if (parsed.length === 0) {
      Message.warning(bi("未识别到有效主机行", "No valid host lines detected"));
      return;
    }
    setHosts(parsed);
    setBatchOpen(false);
    setBatchText("");
    Message.success(bi(`已导入 ${parsed.length} 台主机`, `Imported ${parsed.length} host(s)`));
  };

  const paramsObject = useMemo(() => {
    const obj: Record<string, unknown> = {};
    for (const r of paramRows) {
      if (r.key.trim()) obj[r.key.trim()] = r.value.trim();
    }
    return obj;
  }, [paramRows]);

  const previewInstances = useMemo(
    () =>
      buildPreviewInstances(
        effectiveCompID,
        effectiveDisplayName,
        exactVersion || version,
        validHosts,
        effectiveRoles,
        endpoints,
        companions,
        companionCatalog,
        paramsObject,
      ),
    [
      effectiveCompID,
      effectiveDisplayName,
      exactVersion,
      version,
      validHosts,
      effectiveRoles,
      endpoints,
      companions,
      companionCatalog,
      paramsObject,
    ],
  );

  const previewHosts = useMemo(
    () =>
      validHosts.map((h, i) => ({
        name: h.name.trim() || `node-${i + 1}`,
        ip: h.ip.trim() || "—",
      })),
    [validHosts],
  );

  const submitImport = async () => {
    if (submitting) return;
    if (!CLUSTER_ID_RE.test(clusterId.trim())) {
      Message.error(bi("集群标识仅支持小写字母开头，含小写字母、数字和连字符", "Invalid cluster ID format"));
      return;
    }
    if (validHosts.length === 0) {
      Message.error(bi("请至少填写 1 台集群节点", "At least one host is required"));
      return;
    }
    const payload: ImportPayload = {
      id: clusterId.trim(),
      component: effectiveCompID,
      display_name: effectiveDisplayName,
      category: isCustom ? "middleware" : selectedPreset?.category,
      icon: isCustom ? customIcon : selectedPreset?.icon,
      color: isCustom ? customColor : selectedPreset?.color,
      version: version.trim() || exactVersion.trim() || "unknown",
      exact_version: exactVersion.trim() || undefined,
      platform: platform.trim() || undefined,
      os_detail: osDetail.trim() || undefined,
      source_kind: inputMode,
      deploy_method: deployMethod,
      arch_summary: archSummary.trim() || undefined,
      hosts: validHosts.map((h, i) => ({
        name: h.name.trim() || `node-${i + 1}`,
        ip: h.ip.trim(),
        role: h.role.trim() || effectiveRoles[0]?.id || "node",
        disk: h.disk?.trim() || undefined,
      })),
      endpoints: endpoints.filter((e) => e.address.trim()),
      companions,
      service_units: normalizeTagList(serviceUnits),
      config_paths: normalizeTagList(configPaths),
      data_dirs: normalizeTagList(dataDirs),
      log_dirs: normalizeTagList(logDirs),
      params: paramsObject,
      packages,
      notes: notes.trim() || undefined,
    };
    setSubmitting(true);
    try {
      const res = await api<{ cluster_id: string }>("/api/clusters/import", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      Message.success(bi(`存量集群 ${res.cluster_id} 已完成纳管建档`, `Cluster ${res.cluster_id} onboarded`));
      window.dispatchEvent(new Event("mh-clusters-changed"));
      if (onImported) await onImported();
      go({ name: "deliveries", id: res.cluster_id });
    } catch (e) {
      Message.error((e as Error).message || bi("纳管提交失败", "Failed to onboard cluster"));
    } finally {
      setSubmitting(false);
    }
  };

  const step1CompanionPreview = useMemo(() => {
    const ids = COMPANION_SUGGESTIONS_BY_PRIMARY[effectiveCompID.toLowerCase()] || ["haproxy", "keepalived", "etcd"];
    const byID = new Map(companionCatalog.map((c) => [c.id, c]));
    return ids.map((id) => byID.get(id)?.name).filter(Boolean) as string[];
  }, [effectiveCompID, companionCatalog]);

  const idValid = CLUSTER_ID_RE.test(clusterId.trim());

  return (
    <div className="imp-page">
      <div className="imp-shell">
        {/* Topbar & 3-Step Horizontal Stepper */}
        <header className="imp-topbar">
          <div className="imp-topbar-left">
            <button
              type="button"
              className="imp-back-pill"
              onClick={() => go({ name: "deliveries" })}
            >
              <IconArrowLeft />
              <span>{bi("返回集群", "Clusters")}</span>
            </button>
            <div className="imp-title-group">
              <h1>{bi("导入存量集群", "Import Brownfield Cluster")}</h1>
              <p>
                {bi(
                  "免首次部署包纳管运行中集群，自动识别主从拓扑与伴生高可用架构，直接解锁变更演练与安全治理。",
                  "Onboard running clusters with automatic HA/DCS stack recognition, unlocking Change Rehearsal and CVE governance.",
                )}
              </p>
            </div>
          </div>

          <nav className="imp-stepper" aria-label={bi("纳管步骤", "Onboarding Steps")}>
            {[
              { n: 1 as const, label: bi("识别中间件", "Middleware") },
              { n: 2 as const, label: bi("采集录入节点", "Capture") },
              { n: 3 as const, label: bi("核对基线拓扑", "Review") },
            ].map((st, i) => (
              <React.Fragment key={st.n}>
                {i > 0 && <IconRight className="imp-step-sep" aria-hidden="true" />}
                <button
                  type="button"
                  className={`imp-step-btn ${step === st.n ? "is-active" : step > st.n ? "is-done" : ""}`}
                  disabled={st.n > step && !(st.n === 2 && canProceedStep1)}
                  onClick={() => {
                    if (st.n <= step || (st.n === 2 && canProceedStep1)) setStep(st.n);
                  }}
                >
                  <span className="imp-step-num">
                    {step > st.n ? <IconCheck /> : st.n}
                  </span>
                  <span>{st.label}</span>
                </button>
              </React.Fragment>
            ))}
          </nav>
        </header>

        {/* ---------------- STEP 1: Split Middleware Picker + Sticky Identity Rail ---------------- */}
        {step === 1 && (
          <div className="imp-step1-grid imp-step-pane">
            <section className="imp-card">
              <div className="imp-card-head">
                <div className="imp-card-head-title">
                  <h2>
                    {bi("选择主中间件类型", "Select Primary Middleware")}
                    <span className="imp-count-badge">
                      {(presetsData?.catalog?.length || 0) + (presetsData?.presets?.length || 0)}
                    </span>
                  </h2>
                  <p>
                    {bi(
                      "仅需选择核心业务中间件；Patroni、etcd、HAProxy、Keepalived、Sentinel 等伴生高可用组件将在下一步自动识别。",
                      "Pick the primary middleware; companions like Patroni, etcd, HAProxy, Keepalived, and Sentinel are auto-detected next.",
                    )}
                  </p>
                </div>
                <Input
                  allowClear
                  size="small"
                  prefix={<IconSearch />}
                  placeholder={bi("搜索组件名称或关键字…", "Search middleware...")}
                  style={{ width: 220 }}
                  value={search}
                  onChange={setSearch}
                />
              </div>

              <div className="imp-picker-toolbar">
                <div className="imp-cat-pills">
                  {categories.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`imp-cat-pill ${catFilter === c.id ? "on" : ""}`}
                      onClick={() => setCatFilter(c.id)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <Button
                  size="small"
                  type={isCustom ? "primary" : "secondary"}
                  icon={<IconPlus />}
                  onClick={() => {
                    setIsCustom(true);
                    setSelectedPreset(null);
                  }}
                >
                  {bi("自定义中间件", "Custom")}
                </Button>
              </div>

              {isCustom && (
                <div className="imp-custom-box">
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">
                        {bi("自定义中间件名称", "Custom Middleware Name")} <span className="req">*</span>
                      </span>
                    </label>
                    <Input
                      placeholder={bi("例如：StarRocks、Doris、Greenplum、InfluxDB", "e.g. StarRocks, Doris, Greenplum")}
                      value={customName}
                      onChange={setCustomName}
                    />
                    <span className="imp-field-hint">
                      {bi("将自动生成标识：", "Component slug: ")}
                      <code>{effectiveCompID}</code>
                    </span>
                  </div>
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">{bi("展示图标", "Icon")}</span>
                    </label>
                    <div className="imp-icon-picker">
                      {(presetsData?.icons || ["server", "database", "cache", "queue", "search", "storage", "gateway"]).map((ic) => (
                        <button
                          key={ic}
                          type="button"
                          className={`imp-icon-opt ${customIcon === ic ? "on" : ""}`}
                          title={ic}
                          onClick={() => setCustomIcon(ic)}
                        >
                          <AppGlyph id={ic} icon={ic} color={customColor} size={20} />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {loadingPresets ? (
                <Skeleton text={{ rows: 6 }} animation />
              ) : (
                <>
                  {filteredCatalog.length > 0 && (
                    <>
                      <div className="imp-group-label">
                        {bi("平台目录已有组件", "Platform Catalog")} <em>{filteredCatalog.length}</em>
                      </div>
                      <div className="imp-mw-grid">
                        {filteredCatalog.map((item) => (
                          <MiddlewareCard
                            key={item.id}
                            item={item}
                            selected={!isCustom && selectedPreset?.id === item.id}
                            isEn={isEn}
                            showCatalogBadge
                            onSelect={selectPreset}
                          />
                        ))}
                      </div>
                    </>
                  )}

                  {filteredPresets.length > 0 && (
                    <>
                      <div className="imp-group-label">
                        {bi("常见企业中间件预设（免部署包）", "Enterprise Presets (Zero-Playbook)")}{" "}
                        <em>{filteredPresets.length}</em>
                      </div>
                      <div className="imp-mw-grid">
                        {filteredPresets.map((item) => (
                          <MiddlewareCard
                            key={item.id}
                            item={item}
                            selected={!isCustom && selectedPreset?.id === item.id}
                            isEn={isEn}
                            showCatalogBadge={false}
                            onSelect={selectPreset}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </section>

            {/* Right Sticky Identity & Action Rail (Always visible above fold!) */}
            <aside className="imp-step1-rail">
              <section className="imp-card">
                <div className="imp-selected-hero">
                  <AppGlyph
                    id={effectiveCompID}
                    icon={isCustom ? customIcon : selectedPreset?.icon}
                    color={isCustom ? customColor : selectedPreset?.color}
                    size={38}
                  />
                  <div className="imp-selected-hero-meta">
                    <strong>{effectiveDisplayName || bi("请选择中间件", "Select middleware")}</strong>
                    <span>
                      {selectedPreset?.default_port
                        ? bi(`默认端口 :${selectedPreset.default_port}`, `Default :${selectedPreset.default_port}`)
                        : bi("自定义存量纳管组件", "Custom brownfield middleware")}
                    </span>
                  </div>
                </div>

                {step1CompanionPreview.length > 0 && (
                  <div className="imp-stack-hint">
                    <span className="imp-stack-hint-lbl">
                      {bi("支持自动识别的伴生架构组件", "Auto-detected companion stack")}
                    </span>
                    <div className="imp-stack-hint-pills">
                      {step1CompanionPreview.map((name) => (
                        <span key={name} className="imp-stack-hint-pill">
                          {name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="imp-field">
                  <label>
                    <span className="imp-lbl-left">
                      {bi("集群标识", "Cluster ID")} <span className="req">*</span>
                    </span>
                    {idValid && (
                      <span className="imp-id-ok">
                        <IconCheck style={{ fontSize: 10 }} /> {bi("合规", "Valid")}
                      </span>
                    )}
                  </label>
                  <Input
                    className="mono"
                    placeholder={`${effectiveCompID || "pg"}-prod-01`}
                    value={clusterId}
                    onChange={(v) => setClusterId(v.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  />
                  <span className="imp-field-hint">
                    {bi("小写字母开头，支持数字与短横线（如 pg-gitlab-prod）", "Lowercase letter start, digits & hyphens")}
                  </span>
                </div>

                <div className="imp-field">
                  <label>
                    <span className="imp-lbl-left">{bi("当前版本（选填，可由探针回填）", "Version (optional)")}</span>
                  </label>
                  <Input
                    className="mono"
                    placeholder={selectedPreset?.versions?.[0] || "17 / 8.0 / 7.2"}
                    value={version}
                    onChange={setVersion}
                  />
                </div>

                <Step1PlatformSelects
                  platforms={platformsList}
                  platform={platform}
                  onPlatformChange={handlePlatformChange}
                  deployMethod={deployMethod}
                  onDeployMethodChange={handleDeployMethodChange}
                  lang={lang}
                />

                <Button
                  type="primary"
                  long
                  size="large"
                  disabled={!canProceedStep1}
                  onClick={() => setStep(2)}
                >
                  {bi("下一步：采集与识别节点", "Next: Capture & Recognize")} <IconRight />
                </Button>
                {!canProceedStep1 && (
                  <span className="imp-cta-hint">
                    {bi("填写合规的集群标识后即可进入下一步", "Enter a valid Cluster ID to continue")}
                  </span>
                )}
              </section>
            </aside>
          </div>
        )}

        {/* ---------------- STEP 2: 3-in-1 Capture / Parse / Manual ---------------- */}
        {step === 2 && (
          <section className="imp-card imp-step-pane">
            <div className="imp-ctx-strip">
              <div className="imp-ctx-left">
                <AppGlyph
                  id={effectiveCompID}
                  icon={isCustom ? customIcon : selectedPreset?.icon}
                  color={isCustom ? customColor : selectedPreset?.color}
                  size={26}
                />
                <strong className="mono">{clusterId}</strong>
                <span className="imp-ctx-chip">{effectiveDisplayName}</span>
                {version && <span className="imp-ctx-chip mono">{version}</span>}
              </div>
              <Button size="mini" type="text" onClick={() => setStep(1)}>
                <IconEdit /> {bi("修改中间件或标识", "Change Middleware / ID")}
              </Button>
            </div>

            <div className="imp-card-head">
              <div className="imp-card-head-title">
                <h2>{bi("选择录入方式（三选一，随时切换）", "Choose Onboarding Input Mode")}</h2>
                <p>
                  {bi(
                    "无需打通 SSH 网络；支持离线只读探针自动识别全栈（主中间件 + Patroni / etcd / LB / 备份）、粘贴文档截图，或手工登记。",
                    "No SSH network needed: run read-only probe for full-stack discovery, paste docs/screenshots, or enter hosts manually.",
                  )}
                </p>
              </div>
            </div>

            <div className="imp-mode-tabs">
              <button
                type="button"
                className={`imp-mode-tab ${inputMode === "probe" ? "on" : ""}`}
                onClick={() => setInputMode("probe")}
              >
                <div className="imp-mode-tab-head">
                  <span className="imp-mode-tab-title">
                    <span className="imp-mode-ic"><IconCode /></span>
                    {bi("一键只读采集脚本", "Read-Only Probe Script")}
                  </span>
                  <span className="imp-rec-tag">{bi("推荐 · 全栈识别", "Full-Stack")}</span>
                </div>
                <span className="imp-mode-desc">
                  {bi(
                    "自动采集主节点/从节点、Patroni/etcd/LB 伴生组件、数据盘、路径与 CVE 软件包清单。",
                    "Auto-collects hosts, Patroni/etcd/LB companions, data disks, paths, and CVE packages.",
                  )}
                </span>
              </button>

              <button
                type="button"
                className={`imp-mode-tab ${inputMode === "ai_doc" ? "on" : ""}`}
                onClick={() => setInputMode("ai_doc")}
              >
                <div className="imp-mode-tab-head">
                  <span className="imp-mode-tab-title">
                    <span className="imp-mode-ic"><IconFile /></span>
                    {bi("粘贴文档 / 配置 / 截图", "Paste Docs / Config / Image")}
                  </span>
                  {presetsData?.ai_enabled && (
                    <span className="imp-rec-tag">{bi("AI 多模态", "AI Vision")}</span>
                  )}
                </div>
                <span className="imp-mode-desc">
                  {bi(
                    "直接粘贴 CMDB 资产表、交接文档、patroni.yml / etcd.conf 或架构拓扑截图（支持 Ctrl+V）。",
                    "Paste CMDB tables, handover docs, patroni.yml / etcd.conf, or architecture screenshots.",
                  )}
                </span>
              </button>

              <button
                type="button"
                className={`imp-mode-tab ${inputMode === "manual" ? "on" : ""}`}
                onClick={() => setInputMode("manual")}
              >
                <div className="imp-mode-tab-head">
                  <span className="imp-mode-tab-title">
                    <span className="imp-mode-ic"><IconEdit /></span>
                    {bi("极简手工建档", "Quick Manual Entry")}
                  </span>
                </div>
                <span className="imp-mode-desc">
                  {bi(
                    "只需填写主机名、IP 与角色（支持批量粘贴），下一步可一键勾选 Patroni / etcd 等伴生组件。",
                    "Enter hostnames, IPs, and roles (batch paste supported); add companions in the next step.",
                  )}
                </span>
              </button>
            </div>

            {inputMode === "probe" && (
              <>
                <ProbeCodeBlock script={probeScript} filename={probeFilename} safe={probeSafe} />

                <div className="imp-field">
                  <label>
                    <span className="imp-lbl-left">
                      {bi("执行 ", "Run ")}
                      <code>bash {probeFilename}</code>
                      {bi(" 后，将终端回显粘贴到下方（多台节点输出可直接拼接）", " and paste terminal output below (multi-node outputs can be concatenated)")}
                    </span>
                  </label>
                  <Input.TextArea
                    className="mono"
                    autoSize={{ minRows: 7, maxRows: 16 }}
                    placeholder={bi(
                      "=== MW_IMPORT_BEGIN ===\nHOSTNAME=...\n支持直接 Ctrl+V 粘贴终端文本或截图",
                      "=== MW_IMPORT_BEGIN ===\nHOSTNAME=...\nPaste terminal output or Ctrl+V screenshots",
                    )}
                    value={pasteText}
                    onChange={setPasteText}
                    onPaste={handlePasteImage}
                  />
                </div>
              </>
            )}

            {inputMode === "ai_doc" && (
              <div className="imp-field">
                <label>
                  <span className="imp-lbl-left">
                    {bi(
                      "粘贴 CMDB 表格、交接文档、配置文件或架构描述（凭据自动脱敏，支持 Ctrl+V 贴图）",
                      "Paste CMDB tables, configs, or handover notes (secrets auto-redacted; Ctrl+V screenshots supported)",
                    )}
                  </span>
                </label>
                <Input.TextArea
                  className="mono"
                  autoSize={{ minRows: 8, maxRows: 16 }}
                  placeholder={docPlaceholderFor(effectiveCompID, effectiveDisplayName, selectedPreset?.default_port)}
                  value={pasteText}
                  onChange={setPasteText}
                  onPaste={handlePasteImage}
                />
              </div>
            )}

            {(inputMode === "probe" || inputMode === "ai_doc") && (
              <>
                <div className="imp-drop-foot">
                  <div className="imp-img-strip">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      style={{ display: "none" }}
                      onChange={(e) => {
                        handleFilesSelected(e.target.files);
                        e.target.value = "";
                      }}
                    />
                    <Button
                      size="small"
                      icon={<IconImage />}
                      disabled={images.length >= 4}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {inputMode === "probe"
                        ? bi(`上传终端截图 (${images.length}/4)`, `Terminal Screenshots (${images.length}/4)`)
                        : bi(`上传架构图 / 文档截图 (${images.length}/4)`, `Diagrams / Screenshots (${images.length}/4)`)}
                    </Button>
                    {images.map((src, idx) => (
                      <div key={idx} className="imp-img-thumb">
                        <img src={src} alt={`capture-${idx + 1}`} />
                        <button
                          type="button"
                          className="imp-img-del"
                          aria-label={bi("删除截图", "Remove screenshot")}
                          onClick={() => setImages((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <span className="small muted">
                    {bi("支持自动识别主从拓扑、Patroni / etcd / HAProxy / Keepalived 等伴生栈", "Auto-detects primary/replica roles + Patroni/etcd/HAProxy/Keepalived companions")}
                  </span>
                </div>

                <ParsingStagePanel active={parsing} aiEnabled={Boolean(presetsData?.ai_enabled)} />

                <div className="imp-footer-bar">
                  <Button onClick={() => setStep(1)} disabled={parsing}>
                    <IconArrowLeft /> {bi("上一步", "Back")}
                  </Button>
                  <Button
                    type="primary"
                    loading={parsing}
                    disabled={!pasteText.trim() && images.length === 0}
                    onClick={runParseAndProceed}
                  >
                    {presetsData?.ai_enabled
                      ? bi("AI 智能识别并核对拓扑", "Extract & Review Topology")
                      : bi("规则引擎解析并核对拓扑", "Parse & Review Topology")}{" "}
                    <IconRight />
                  </Button>
                </div>
              </>
            )}

            {inputMode === "manual" && (
              <>
                <div className="imp-card-head">
                  <div className="imp-card-head-title">
                    <h2>
                      {bi("主机节点与角色", "Hosts & Roles")}
                      <span className="imp-count-badge">{validHosts.length}</span>
                    </h2>
                  </div>
                  <div className="row-gap">
                    <Button size="small" icon={<IconFile />} onClick={() => setBatchOpen((v) => !v)}>
                      {bi("批量粘贴节点", "Batch Paste")}
                    </Button>
                    <Button
                      size="small"
                      icon={<IconPlus />}
                      onClick={() =>
                        setHosts((prev) => [
                          ...prev,
                          {
                            name: `node-${prev.length + 1}`,
                            ip: "",
                            role: effectiveRoles[Math.min(1, effectiveRoles.length - 1)]?.id || "node",
                            disk: "",
                          },
                        ])
                      }
                    >
                      {bi("添加节点", "Add Host")}
                    </Button>
                  </div>
                </div>

                {batchOpen && (
                  <div className="imp-field" style={{ padding: 12, background: "var(--surface-2)", borderRadius: 9, border: "1px solid var(--line)" }}>
                    <label>
                      <span className="imp-lbl-left">
                        {bi("每行一台（支持 hostname IP role 或 IP hostname role）", "One host per line: hostname IP [role]")}
                      </span>
                    </label>
                    <Input.TextArea
                      className="mono"
                      autoSize={{ minRows: 3, maxRows: 8 }}
                      placeholder={"db-node-01 10.20.1.11 primary\ndb-node-02 10.20.1.12 replica\ndb-node-03 10.20.1.13 replica"}
                      value={batchText}
                      onChange={setBatchText}
                    />
                    <div className="row-gap" style={{ justifyContent: "flex-end" }}>
                      <Button size="small" onClick={() => setBatchOpen(false)}>
                        {bi("取消", "Cancel")}
                      </Button>
                      <Button size="small" type="primary" onClick={applyBatchHosts}>
                        {bi("应用主机列表", "Apply Hosts")}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="imp-table-rows">
                  <div className="imp-host-row imp-col-heads">
                    <span>{bi("主机名", "Hostname")}</span>
                    <span>{bi("IP 地址", "IP Address")}</span>
                    <span>{bi("节点角色", "Role")}</span>
                    <span>{bi("数据盘（选填）", "Data Disk (opt)")}</span>
                    <span />
                  </div>
                  {hosts.map((h, idx) => (
                    <div key={idx} className="imp-host-row">
                      <Input
                        placeholder={`node-${idx + 1}`}
                        value={h.name}
                        onChange={(v) =>
                          setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, name: v } : r)))
                        }
                      />
                      <Input
                        className="mono"
                        placeholder="10.20.1.11"
                        value={h.ip}
                        onChange={(v) =>
                          setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, ip: v } : r)))
                        }
                      />
                      <Select
                        allowCreate
                        value={h.role}
                        onChange={(v) =>
                          setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, role: v } : r)))
                        }
                      >
                        {effectiveRoles.map((r) => (
                          <Select.Option key={r.id} value={r.id}>
                            {isEn ? r.title_en || r.title : r.title}
                          </Select.Option>
                        ))}
                      </Select>
                      <Input
                        className="mono"
                        placeholder="/dev/vdb"
                        value={h.disk || ""}
                        onChange={(v) =>
                          setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, disk: v } : r)))
                        }
                      />
                      <Button
                        size="small"
                        type="text"
                        status="danger"
                        disabled={hosts.length <= 1}
                        icon={<IconDelete />}
                        onClick={() => setHosts((prev) => prev.filter((_, i) => i !== idx))}
                      />
                    </div>
                  ))}
                </div>

                <div className="imp-footer-bar">
                  <Button onClick={() => setStep(1)}>
                    <IconArrowLeft /> {bi("上一步", "Back")}
                  </Button>
                  <Button
                    type="primary"
                    disabled={validHosts.length === 0}
                    onClick={() => setStep(3)}
                  >
                    {bi("下一步：核对基线与拓扑预览", "Next: Review & Live Topology")} <IconRight />
                  </Button>
                </div>
              </>
            )}
          </section>
        )}

        {/* ---------------- STEP 3: Multi-Component Baseline Review & Live Topology ---------------- */}
        {step === 3 && (
          <div className="imp-review-grid imp-step-pane">
            <div className="imp-review-main">
              {parseInfo && (
                <div className="imp-parse-banner">
                  <div>
                    <b>
                      {parseInfo.parser === "ai"
                        ? bi("✓ 已由 AI 提取多组件基线草稿", "✓ Multi-component baseline extracted by AI")
                        : bi("✓ 已由内置规则提取多组件基线草稿", "✓ Multi-component baseline extracted by rules")}
                    </b>
                    {parseInfo.companionCount > 0 && (
                      <span className="imp-kind-pill t-brand" style={{ marginLeft: 8 }}>
                        {bi(`已识别 ${parseInfo.companionCount} 个伴生组件`, `${parseInfo.companionCount} companion(s) detected`)}
                      </span>
                    )}
                    {parseInfo.missing.length > 0 && (
                      <div className="muted small" style={{ marginTop: 3 }}>
                        {bi("建议核对补齐：", "Suggested to review: ")}
                        {parseInfo.missing.join(" · ")}
                      </div>
                    )}
                    {parseInfo.warnings.map((w, i) => (
                      <div key={i} className="muted small" style={{ marginTop: 2 }}>
                        {w}
                      </div>
                    ))}
                  </div>
                  <Button size="mini" onClick={() => setStep(2)}>
                    {bi("返回补充采集", "Re-parse")}
                  </Button>
                </div>
              )}

              {/* NEW: First-Class Multi-Component Architecture Stack Editor */}
              <section className="imp-card">
                <div className="imp-card-head">
                  <div className="imp-card-head-title">
                    <h2>
                      {bi("架构组件栈（主中间件 + 伴生组件）", "Architecture Stack (Primary + Companions)")}
                      <span className="imp-count-badge">{1 + companions.length}</span>
                    </h2>
                    <p>
                      {bi(
                        "Patroni、etcd、HAProxy、Keepalived 等高可用/协调/代理组件将作为真实实例建入运行拓扑与端口清单。",
                        "HA, DCS, proxy, and VIP companions are modeled as real topology instances with ports and flows.",
                      )}
                    </p>
                  </div>
                </div>
                <CompanionStackEditor
                  primaryCompID={effectiveCompID}
                  primaryDisplayName={effectiveDisplayName}
                  primaryVersion={exactVersion || version}
                  primaryIcon={isCustom ? customIcon : selectedPreset?.icon || "server"}
                  primaryColor={isCustom ? customColor : selectedPreset?.color || "blue"}
                  hosts={validHosts}
                  companions={companions}
                  catalog={companionCatalog}
                  onChange={setCompanions}
                />
              </section>

              {/* Identity & Version Review (Zero Overflow!) */}
              <section className="imp-card">
                <div className="imp-card-head">
                  <div className="imp-card-head-title">
                    <h2>{bi("集群身份与版本基线", "Identity & Version Baseline")}</h2>
                  </div>
                </div>
                <div className="imp-form-grid-2">
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">{bi("集群标识", "Cluster ID")}</span>
                    </label>
                    <Input
                      className="mono"
                      value={clusterId}
                      onChange={(v) => setClusterId(v.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    />
                  </div>
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">{bi("架构形态摘要", "Architecture Summary")}</span>
                    </label>
                    <Input
                      placeholder={bi("例如：3节点 Patroni + etcd 高可用集群", "e.g. 3-node Patroni + etcd HA cluster")}
                      value={archSummary}
                      onChange={setArchSummary}
                    />
                  </div>
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">{bi("主版本 / 精确版本", "Major / Exact Version")}</span>
                    </label>
                    <div className="imp-pair-grid">
                      <Input
                        className="mono"
                        placeholder={bi("主版本，如 17", "Major, e.g. 17")}
                        value={version}
                        onChange={setVersion}
                      />
                      <Input
                        className="mono"
                        placeholder={bi("精确版本，如 17.11.1", "Exact, e.g. 17.11.1")}
                        value={exactVersion}
                        onChange={setExactVersion}
                      />
                    </div>
                  </div>
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">{bi("操作系统 / 部署形态", "OS / Deploy Mode")}</span>
                    </label>
                    <div className="imp-pair-grid">
                      <Select
                        allowClear
                        value={platform || undefined}
                        onChange={(v) => setPlatform(v || "")}
                      >
                        {(presetsData?.platforms || []).map((pl) => (
                          <Select.Option key={pl.id} value={pl.id}>
                            {pl.title}
                          </Select.Option>
                        ))}
                        <Select.Option value="linux-custom">
                          {bi("其他 Linux", "Other Linux")}
                        </Select.Option>
                      </Select>
                      <Select value={deployMethod} onChange={setDeployMethod}>
                        {DEPLOY_METHODS().map((dm) => (
                          <Select.Option key={dm.value} value={dm.value}>
                            {dm.label}
                          </Select.Option>
                        ))}
                      </Select>
                    </div>
                  </div>
                </div>
              </section>

              {/* Hosts Review with Explicit Column Headers */}
              <section className="imp-card">
                <div className="imp-card-head">
                  <div className="imp-card-head-title">
                    <h2>
                      {bi("主机节点清单", "Cluster Hosts")}
                      <span className="imp-count-badge">{validHosts.length}</span>
                    </h2>
                  </div>
                  <Button
                    size="small"
                    icon={<IconPlus />}
                    onClick={() =>
                      setHosts((prev) => [
                        ...prev,
                        {
                          name: `node-${prev.length + 1}`,
                          ip: "",
                          role: effectiveRoles[Math.min(1, effectiveRoles.length - 1)]?.id || "node",
                          disk: "",
                        },
                      ])
                    }
                  >
                    {bi("添加节点", "Add Host")}
                  </Button>
                </div>
                <div className="imp-table-rows">
                  <div className="imp-host-row imp-col-heads">
                    <span>{bi("主机名", "Hostname")}</span>
                    <span>{bi("IP 地址", "IP Address")}</span>
                    <span>{bi("节点角色", "Role")}</span>
                    <span>{bi("数据盘", "Data Disk")}</span>
                    <span />
                  </div>
                  {hosts.map((h, idx) => (
                    <div key={idx} className="imp-host-row">
                      <Input
                        placeholder="hostname"
                        value={h.name}
                        onChange={(v) =>
                          setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, name: v } : r)))
                        }
                      />
                      <Input
                        className="mono"
                        placeholder="IP"
                        value={h.ip}
                        onChange={(v) =>
                          setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, ip: v } : r)))
                        }
                      />
                      <Select
                        allowCreate
                        value={h.role}
                        onChange={(v) =>
                          setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, role: v } : r)))
                        }
                      >
                        {effectiveRoles.map((r) => (
                          <Select.Option key={r.id} value={r.id}>
                            {isEn ? r.title_en || r.title : r.title}
                          </Select.Option>
                        ))}
                      </Select>
                      <Input
                        className="mono"
                        placeholder="/dev/vdb"
                        value={h.disk || ""}
                        onChange={(v) =>
                          setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, disk: v } : r)))
                        }
                      />
                      <Button
                        size="small"
                        type="text"
                        status="danger"
                        disabled={hosts.length <= 1}
                        icon={<IconDelete />}
                        onClick={() => setHosts((prev) => prev.filter((_, i) => i !== idx))}
                      />
                    </div>
                  ))}
                </div>
              </section>

              {/* Access Endpoints & Runtime Paths (Tag Chips - Never Concatenates!) */}
              <section className="imp-card">
                <div className="imp-card-head">
                  <div className="imp-card-head-title">
                    <h2>{bi("访问入口、运行路径与关键参数（选填）", "Endpoints, Paths & Key Params")}</h2>
                  </div>
                  <Button
                    size="small"
                    icon={<IconPlus />}
                    onClick={() =>
                      setEndpoints((prev) => [
                        ...prev,
                        { name: "writer", address: "", role: "readwrite" },
                      ])
                    }
                  >
                    {bi("添加访问入口", "Add Endpoint")}
                  </Button>
                </div>

                {endpoints.length > 0 && (
                  <div className="imp-table-rows">
                    <div className="imp-ep-row imp-col-heads">
                      <span>{bi("入口标识", "Label")}</span>
                      <span>{bi("访问地址 : 端口", "Address : Port")}</span>
                      <span>{bi("入口用途", "Role")}</span>
                      <span />
                    </div>
                    {endpoints.map((ep, idx) => (
                      <div key={idx} className="imp-ep-row">
                        <Input
                          placeholder="writer"
                          value={ep.name || ""}
                          onChange={(v) =>
                            setEndpoints((prev) => prev.map((r, i) => (i === idx ? { ...r, name: v } : r)))
                          }
                        />
                        <Input
                          className="mono"
                          placeholder={`vip.internal:${selectedPreset?.default_port || 5432}`}
                          value={ep.address}
                          onChange={(v) =>
                            setEndpoints((prev) => prev.map((r, i) => (i === idx ? { ...r, address: v } : r)))
                          }
                        />
                        <Select
                          value={normalizeEndpointRole(ep.role)}
                          onChange={(v) =>
                            setEndpoints((prev) => prev.map((r, i) => (i === idx ? { ...r, role: v } : r)))
                          }
                        >
                          <Select.Option value="readwrite">{bi("读写入口", "Read/Write")}</Select.Option>
                          <Select.Option value="readonly">{bi("只读入口", "Read-Only")}</Select.Option>
                          <Select.Option value="admin">{bi("管理入口", "Admin")}</Select.Option>
                        </Select>
                        <Button
                          size="small"
                          type="text"
                          status="danger"
                          icon={<IconDelete />}
                          onClick={() => setEndpoints((prev) => prev.filter((_, i) => i !== idx))}
                        />
                      </div>
                    ))}
                  </div>
                )}

                <div className="imp-form-grid-2">
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">{bi("系统服务单元", "Service Units")}</span>
                    </label>
                    <InputTag
                      saveOnBlur
                      placeholder={selectedPreset?.service_hints?.join(", ") || "patroni.service"}
                      value={serviceUnits}
                      onChange={(vals) => setServiceUnits(normalizeTagList(vals as string[]))}
                    />
                  </div>
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">{bi("配置文件路径", "Config Paths")}</span>
                    </label>
                    <InputTag
                      saveOnBlur
                      placeholder={selectedPreset?.config_hints?.[0] || "/etc/patroni/patroni.yml"}
                      value={configPaths}
                      onChange={(vals) => setConfigPaths(normalizeTagList(vals as string[]))}
                    />
                  </div>
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">{bi("数据目录", "Data Directories")}</span>
                    </label>
                    <InputTag
                      saveOnBlur
                      placeholder={selectedPreset?.data_hints?.[0] || "/data/pg"}
                      value={dataDirs}
                      onChange={(vals) => setDataDirs(normalizeTagList(vals as string[]))}
                    />
                  </div>
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">{bi("日志目录", "Log Directories")}</span>
                    </label>
                    <InputTag
                      saveOnBlur
                      placeholder={selectedPreset?.log_hints?.[0] || "/var/log/postgresql"}
                      value={logDirs}
                      onChange={(vals) => setLogDirs(normalizeTagList(vals as string[]))}
                    />
                  </div>
                </div>

                <div className="imp-field">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <label>
                      <span className="imp-lbl-left">{bi("关键运行参数（键值对）", "Key Runtime Parameters")}</span>
                    </label>
                    <Button
                      size="mini"
                      icon={<IconPlus />}
                      onClick={() => setParamRows((prev) => [...prev, { key: "", value: "" }])}
                    >
                      {bi("添加参数", "Add Param")}
                    </Button>
                  </div>
                  {paramRows.length > 0 && (
                    <div className="imp-table-rows">
                      {paramRows.map((pr, idx) => (
                        <div key={idx} className="imp-kv-row">
                          <Input
                            className="mono"
                            placeholder="max_connections"
                            value={pr.key}
                            onChange={(v) =>
                              setParamRows((prev) => prev.map((r, i) => (i === idx ? { ...r, key: v } : r)))
                            }
                          />
                          <Input
                            className="mono"
                            placeholder="500"
                            value={pr.value}
                            onChange={(v) =>
                              setParamRows((prev) => prev.map((r, i) => (i === idx ? { ...r, value: v } : r)))
                            }
                          />
                          <Button
                            size="small"
                            type="text"
                            status="danger"
                            icon={<IconDelete />}
                            onClick={() => setParamRows((prev) => prev.filter((_, i) => i !== idx))}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {packages.length > 0 && (
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">
                        {bi(`已采集软件包（${packages.length} 项，纳入安全 CVE 扫描）`, `Collected Packages (${packages.length}, CVE indexed)`)}
                      </span>
                    </label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {packages.slice(0, 12).map((pk, idx) => (
                        <Tag key={idx} size="small" className="mono">
                          {pk.name}={pk.version}
                        </Tag>
                      ))}
                      {packages.length > 12 && (
                        <Tag size="small" color="gray">
                          +{packages.length - 12}
                        </Tag>
                      )}
                    </div>
                  </div>
                )}

                <div className="imp-field">
                  <label>
                    <span className="imp-lbl-left">{bi("现场线索与运维备注", "Field Notes & Maintenance Window")}</span>
                  </label>
                  <Input.TextArea
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    placeholder={bi(
                      "• 承载业务与维护窗口（如周日 02:00-04:00）\n• 特殊注意事项或待人工核对项",
                      "• Workload & maintenance window\n• Special notes or verification items",
                    )}
                    value={notes}
                    onChange={setNotes}
                  />
                </div>
              </section>
            </div>

            {/* Right Sticky Live Multi-Component Topology Preview & Submit */}
            <aside className="imp-review-side">
              <section className="imp-card">
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <AppGlyph
                    id={effectiveCompID}
                    icon={isCustom ? customIcon : selectedPreset?.icon}
                    color={isCustom ? customColor : selectedPreset?.color}
                    size={36}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="mono" style={{ fontSize: 15, fontWeight: 650, color: "var(--ink)" }}>
                      {clusterId || "—"}
                    </div>
                    <div className="small muted">
                      {effectiveDisplayName} {exactVersion || version} · {validHosts.length} {bi("台节点", "hosts")}
                    </div>
                  </div>
                </div>

                {companions.length > 0 && (
                  <div className="cl-imp-stack">
                    <span className="cl-imp-stack-lbl">{bi("架构组件栈", "Stack")}</span>
                    <div className="cl-imp-stack-pills">
                      <span className="cl-imp-comp-pill is-primary">
                        <AppGlyph
                          id={effectiveCompID}
                          icon={isCustom ? customIcon : selectedPreset?.icon}
                          color={isCustom ? customColor : selectedPreset?.color}
                          size={15}
                        />
                        <b>{effectiveDisplayName}</b>
                        {(exactVersion || version) && (
                          <span className="cl-imp-comp-ver">{exactVersion || version}</span>
                        )}
                        <span className="cl-imp-comp-kind">{bi("主组件", "Primary")}</span>
                      </span>
                      {companions.map((cm) => (
                        <span key={cm.component} className="cl-imp-comp-pill">
                          <AppGlyph id={cm.component} icon={cm.component} size={15} />
                          <b>{cm.display_name || cm.component}</b>
                          {cm.version && <span className="cl-imp-comp-ver">{cm.version}</span>}
                          <span className="cl-imp-comp-kind">{companionKindMeta(cm.kind).label}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="imp-topo-wrap">
                  {previewHosts.length > 0 ? (
                    <InstanceGraph
                      hosts={previewHosts}
                      instances={previewInstances}
                      controller={previewHosts[0]?.name}
                      layout="stack"
                    />
                  ) : (
                    <div className="muted small" style={{ textAlign: "center", padding: 20 }}>
                      {bi("添加节点后实时预览多组件拓扑", "Add hosts to preview live topology")}
                    </div>
                  )}
                </div>

                <div className="imp-footer-bar" style={{ paddingTop: 12 }}>
                  <Button onClick={() => setStep(2)}>
                    <IconArrowLeft /> {bi("返回修改", "Back")}
                  </Button>
                  <Button type="primary" loading={submitting} onClick={submitImport}>
                    <IconCheck /> {bi("完成纳管建档", "Complete Onboarding")}
                  </Button>
                </div>
              </section>

              <section className="imp-card">
                <div className="imp-card-head">
                  <h2>{bi("建档后立即解锁", "Unlocked Immediately")}</h2>
                </div>
                <ul className="imp-unlock-list">
                  <li>
                    <span className="imp-unlock-dot" />
                    {bi("多组件运行拓扑与完整纳管基线档案", "Multi-component topology & baseline archive")}
                  </li>
                  <li>
                    <span className="imp-unlock-dot" />
                    {bi("AI 变更演练工作台 & 导出 Word 实施方案", "AI Change Rehearsal & Word SOP export")}
                  </li>
                  <li>
                    <span className="imp-unlock-dot" />
                    {bi("同类中间件跨集群变更推广", "Cross-cluster change rollout")}
                  </li>
                  <li>
                    <span className="imp-unlock-dot" />
                    {bi("安全 CVE 漏洞扫描与升级演练联动", "CVE scanning & upgrade rehearsal")}
                  </li>
                </ul>
              </section>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Redesigned Online Baseline Editor & Re-Probe Drawer (for Cluster Overview & Config) ---------- */

export function ImportedBaselineModal({
  visible,
  mode = "edit",
  cluster,
  onClose,
  onSaved,
}: {
  visible: boolean;
  mode?: "edit" | "probe";
  cluster: ClusterView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const lang = useLang();
  const isEn = lang === "en-US";
  const [tab, setTab] = useState<"edit" | "probe">(mode);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<ImportPayload | null>(null);

  const [hosts, setHosts] = useState<HostRow[]>([]);
  const [endpoints, setEndpoints] = useState<ImportedEndpoint[]>([]);
  const [companions, setCompanions] = useState<ImportedCompanion[]>([]);
  const [suggestedCompanions, setSuggestedCompanions] = useState<ImportedCompanion[]>([]);
  const [version, setVersion] = useState("");
  const [exactVersion, setExactVersion] = useState("");
  const [platform, setPlatform] = useState("");
  const [deployMethod, setDeployMethod] = useState("systemd");
  const [archSummary, setArchSummary] = useState("");
  const [serviceUnits, setServiceUnits] = useState<string[]>([]);
  const [configPaths, setConfigPaths] = useState<string[]>([]);
  const [dataDirs, setDataDirs] = useState<string[]>([]);
  const [logDirs, setLogDirs] = useState<string[]>([]);
  const [paramRows, setParamRows] = useState<ParamRow[]>([]);
  const [packages, setPackages] = useState<ImportedPkg[]>([]);
  const [notes, setNotes] = useState("");

  // Re-probe state
  const [probeScript, setProbeScript] = useState("");
  const [probeFilename, setProbeFilename] = useState("mw-import-probe.sh");
  const [probeSafe, setProbeSafe] = useState(true);
  const [probeOutput, setProbeOutput] = useState("");
  const [parsing, setParsing] = useState(false);

  const roleOptions = useMemo<RolePreset[]>(() => {
    const cid = (cluster.app_id || "").toLowerCase();
    if (["postgresql", "mysql", "mariadb", "kingbase", "dm", "oracle"].includes(cid)) {
      return [
        { id: "primary", title: "主库", title_en: "Primary" },
        { id: "replica", title: "从库", title_en: "Replica" },
        { id: "arbiter", title: "仲裁/DCS", title_en: "Arbiter" },
      ];
    }
    if (cid === "etcd" || cid === "zookeeper" || cid === "consul") {
      return [
        { id: "member", title: "成员节点", title_en: "Member" },
        { id: "node", title: "节点", title_en: "Node" },
      ];
    }
    return [
      { id: "primary", title: "主节点", title_en: "Primary" },
      { id: "replica", title: "从节点", title_en: "Replica" },
      { id: "node", title: "节点", title_en: "Node" },
    ];
  }, [cluster.app_id]);

  useEffect(() => {
    setTab(mode);
  }, [mode, visible]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setLoading(true);
    api<ImportPayload>(`/api/clusters/${encodeURIComponent(cluster.id)}/baseline`)
      .then((res) => {
        if (!alive) return;
        setData(res);
        setHosts(res.hosts || []);
        setEndpoints(
          (res.endpoints || []).map((ep) => ({
            ...ep,
            role: normalizeEndpointRole(ep.role),
          })),
        );
        setCompanions(res.companions || []);
        setSuggestedCompanions(res.suggested_companions || []);
        setVersion(res.version || "");
        setExactVersion(res.exact_version || "");
        setPlatform(res.platform || "");
        setDeployMethod(res.deploy_method || "systemd");
        setArchSummary(res.arch_summary || "");
        setServiceUnits(res.service_units || []);
        setConfigPaths(res.config_paths || []);
        setDataDirs(res.data_dirs || []);
        setLogDirs(res.log_dirs || []);
        setParamRows(
          Object.entries(res.params || {}).map(([k, v]) => ({
            key: k,
            value: typeof v === "string" ? v : (JSON.stringify(v) ?? ""),
          })),
        );
        setPackages(res.packages || []);
        setNotes(res.notes || "");
      })
      .catch((e: Error) => Message.error(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [visible, cluster.id]);

  useEffect(() => {
    if (!visible || tab !== "probe") return;
    let alive = true;
    api<{ script: string; filename: string; safe?: boolean }>("/api/clusters/import/probe-script", {
      method: "POST",
      body: JSON.stringify({
        component: cluster.app_id,
        display_name: cluster.app_name,
        deploy_method: deployMethod,
        service_units: serviceUnits,
        config_paths: configPaths,
      }),
    })
      .then((res) => {
        if (!alive) return;
        setProbeScript(res.script);
        setProbeFilename(res.filename);
        setProbeSafe(res.safe !== false);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, tab, cluster.app_id, cluster.app_name, deployMethod]);

  const adoptAllSuggested = () => {
    if (suggestedCompanions.length === 0) return;
    const existing = new Set(companions.map((c) => c.component.toLowerCase()));
    const merged = [...companions];
    for (const sc of suggestedCompanions) {
      if (!existing.has(sc.component.toLowerCase())) {
        merged.push(sc);
        existing.add(sc.component.toLowerCase());
      }
    }
    setCompanions(merged);
    setSuggestedCompanions([]);
    Message.success(bi("已将伴生组件纳入架构栈，点击保存基线即可刷新拓扑", "Companions added to stack; save to update topology"));
  };

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving && !parsing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, saving, parsing, onClose]);

  const parseAndMergeProbe = async () => {
    if (parsing) return;
    if (!probeOutput.trim()) {
      Message.warning(bi("请先粘贴采集脚本终端输出", "Paste probe terminal output first"));
      return;
    }
    setParsing(true);
    try {
      const res = await api<ParseResp>("/api/clusters/import/parse", {
        method: "POST",
        body: JSON.stringify({
          component: cluster.app_id,
          display_name: cluster.app_name,
          source_kind: "probe",
          text: probeOutput,
        }),
      });
      const d = res.draft;
      if (d.version) setVersion(d.version);
      if (d.exact_version) setExactVersion(d.exact_version);
      if (d.platform) setPlatform(d.platform);
      if (d.deploy_method) setDeployMethod(d.deploy_method);
      if (d.arch_summary) setArchSummary(d.arch_summary);
      if (d.hosts?.length) setHosts(d.hosts);
      if (d.companions?.length) {
        const byID = new Map(companions.map((c) => [c.component.toLowerCase(), c]));
        for (const cm of d.companions) {
          byID.set(cm.component.toLowerCase(), cm);
        }
        setCompanions(Array.from(byID.values()));
        setSuggestedCompanions([]);
      }
      if (d.service_units?.length) setServiceUnits(d.service_units);
      if (d.config_paths?.length) setConfigPaths(d.config_paths);
      if (d.data_dirs?.length) setDataDirs(d.data_dirs);
      if (d.log_dirs?.length) setLogDirs(d.log_dirs);
      if (d.packages?.length) setPackages(d.packages);
      if (d.notes) setNotes(d.notes);
      Message.success(
        bi("采集输出已解析并合并（含伴生组件栈），请核对后保存基线", "Probe parsed and merged (including companions); review and save"),
      );
      setTab("edit");
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
      setParsing(false);
    }
  };

  const saveBaseline = async () => {
    if (saving) return;
    const paramsObj: Record<string, unknown> = {};
    for (const r of paramRows) {
      if (r.key.trim()) paramsObj[r.key.trim()] = r.value.trim();
    }
    setSaving(true);
    try {
      await api(`/api/clusters/${encodeURIComponent(cluster.id)}/baseline`, {
        method: "PUT",
        body: JSON.stringify({
          ...data,
          id: cluster.id,
          component: data?.component || cluster.app_id,
          display_name: data?.display_name || cluster.app_name,
          version: version.trim() || exactVersion.trim() || cluster.version,
          exact_version: exactVersion.trim() || undefined,
          platform: platform.trim() || undefined,
          deploy_method: deployMethod,
          arch_summary: archSummary.trim() || undefined,
          hosts: hosts.filter((h) => h.name.trim() || h.ip.trim()),
          endpoints: endpoints.filter((e) => e.address.trim()),
          companions,
          service_units: normalizeTagList(serviceUnits),
          config_paths: normalizeTagList(configPaths),
          data_dirs: normalizeTagList(dataDirs),
          log_dirs: normalizeTagList(logDirs),
          params: paramsObj,
          packages,
          notes: notes.trim() || undefined,
          last_probed_at: probeOutput.trim() ? new Date().toISOString() : data?.last_probed_at,
        }),
      });
      Message.success(bi("纳管基线与多组件拓扑已更新", "Imported baseline & topology updated"));
      window.dispatchEvent(new Event("mh-clusters-changed"));
      await onSaved();
      onClose();
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      visible={visible}
      width="min(760px, 94vw)"
      unmountOnExit
      title={
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, paddingRight: 20, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AppGlyph id={cluster.app_id} icon={cluster.icon} size={22} />
            <span style={{ fontWeight: 650 }}>
              {bi("存量纳管基线", "Imported Baseline")} · <span className="mono">{cluster.id}</span>
            </span>
          </div>
          <div className="imp-drawer-tabs">
            <button
              type="button"
              className={`imp-drawer-tab ${tab === "edit" ? "on" : ""}`}
              onClick={() => setTab("edit")}
            >
              {bi("基线与组件栈", "Baseline & Stack")}
            </button>
            <button
              type="button"
              className={`imp-drawer-tab ${tab === "probe" ? "on" : ""}`}
              onClick={() => setTab("probe")}
            >
              {bi("只读探针刷新", "Re-Run Probe")}
            </button>
          </div>
        </div>
      }
      onCancel={onClose}
      footer={
        tab === "probe" ? (
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, width: "100%" }}>
            <Button onClick={() => setTab("edit")} disabled={parsing}>
              {bi("返回基线编辑", "Back to Edit")}
            </Button>
            <Button type="primary" loading={parsing} disabled={!probeOutput.trim()} onClick={parseAndMergeProbe}>
              <IconRefresh /> {bi("解析回显并合并基线", "Parse & Merge Baseline")}
            </Button>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, width: "100%" }}>
            <Button onClick={onClose}>{bi("取消", "Cancel")}</Button>
            <Button type="primary" loading={saving} onClick={saveBaseline}>
              <IconCheck /> {bi("保存基线并刷新拓扑", "Save & Rebuild Topology")}
            </Button>
          </div>
        )
      }
    >
      {loading ? (
        <Skeleton text={{ rows: 9 }} animation />
      ) : tab === "probe" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ProbeCodeBlock script={probeScript} filename={probeFilename} safe={probeSafe} compact />
          <div className="imp-field">
            <label>
              <span className="imp-lbl-left">{bi("粘贴最新采集终端回显", "Paste Latest Probe Output")}</span>
            </label>
            <Input.TextArea
              className="mono"
              autoSize={{ minRows: 8, maxRows: 15 }}
              placeholder="=== MW_IMPORT_BEGIN === ..."
              value={probeOutput}
              onChange={setProbeOutput}
            />
          </div>
          <ParsingStagePanel active={parsing} aiEnabled />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Section 1: Companion Architecture Stack */}
          <div className="imp-drawer-sec">
            <div className="imp-drawer-sec-h">
              <h4>{bi("架构组件栈（主中间件 + 伴生组件）", "Architecture Stack (Primary + Companions)")}</h4>
              <span className="imp-count-badge">{1 + companions.length}</span>
            </div>
            <CompanionStackEditor
              primaryCompID={data?.component || cluster.app_id}
              primaryDisplayName={data?.display_name || cluster.app_name}
              primaryVersion={exactVersion || version || cluster.version}
              primaryIcon={data?.icon || cluster.icon || cluster.app_id}
              primaryColor={data?.color || "blue"}
              hosts={hosts}
              companions={companions}
              suggestedCompanions={suggestedCompanions}
              catalog={FALLBACK_COMPANIONS}
              onChange={setCompanions}
              onAdoptSuggested={adoptAllSuggested}
            />
          </div>

          {/* Section 2: Version & Summary */}
          <div className="imp-drawer-sec">
            <div className="imp-drawer-sec-h">
              <h4>{bi("版本与架构摘要", "Version & Architecture Summary")}</h4>
            </div>
            <div className="imp-form-grid-2">
              <div className="imp-field">
                <label>
                  <span className="imp-lbl-left">{bi("主版本 / 精确版本", "Major / Exact Version")}</span>
                </label>
                <div className="imp-pair-grid">
                  <Input className="mono" value={version} onChange={setVersion} placeholder="17" />
                  <Input className="mono" value={exactVersion} onChange={setExactVersion} placeholder="17.11.1" />
                </div>
              </div>
              <div className="imp-field">
                <label>
                  <span className="imp-lbl-left">{bi("部署形态", "Deploy Mode")}</span>
                </label>
                <Select value={deployMethod} onChange={setDeployMethod}>
                  {DEPLOY_METHODS().map((dm) => (
                    <Select.Option key={dm.value} value={dm.value}>
                      {dm.label}
                    </Select.Option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="imp-field">
              <label>
                <span className="imp-lbl-left">{bi("架构形态摘要", "Architecture Summary")}</span>
              </label>
              <Input value={archSummary} onChange={setArchSummary} />
            </div>
          </div>

          {/* Section 3: Hosts */}
          <div className="imp-drawer-sec">
            <div className="imp-drawer-sec-h">
              <h4>{bi("主机节点清单", "Cluster Hosts")}</h4>
              <Button
                size="mini"
                icon={<IconPlus />}
                onClick={() =>
                  setHosts((prev) => [
                    ...prev,
                    { name: `${cluster.app_id}-${prev.length + 1}`, ip: "", role: "replica", disk: "" },
                  ])
                }
              >
                {bi("添加节点", "Add Host")}
              </Button>
            </div>
            <div className="imp-table-rows">
              <div className="imp-host-row imp-col-heads">
                <span>{bi("主机名", "Hostname")}</span>
                <span>{bi("IP 地址", "IP Address")}</span>
                <span>{bi("节点角色", "Role")}</span>
                <span>{bi("数据盘", "Data Disk")}</span>
                <span />
              </div>
              {hosts.map((h, idx) => (
                <div key={idx} className="imp-host-row">
                  <Input
                    value={h.name}
                    placeholder="hostname"
                    onChange={(v) =>
                      setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, name: v } : r)))
                    }
                  />
                  <Input
                    className="mono"
                    value={h.ip}
                    placeholder="IP"
                    onChange={(v) =>
                      setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, ip: v } : r)))
                    }
                  />
                  <Select
                    allowCreate
                    value={h.role}
                    onChange={(v) =>
                      setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, role: v } : r)))
                    }
                  >
                    {roleOptions.map((r) => (
                      <Select.Option key={r.id} value={r.id}>
                        {isEn ? r.title_en || r.title : r.title}
                      </Select.Option>
                    ))}
                  </Select>
                  <Input
                    className="mono"
                    value={h.disk || ""}
                    placeholder="/dev/vdb"
                    onChange={(v) =>
                      setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, disk: v } : r)))
                    }
                  />
                  <Button
                    size="small"
                    type="text"
                    status="danger"
                    disabled={hosts.length <= 1}
                    icon={<IconDelete />}
                    onClick={() => setHosts((prev) => prev.filter((_, i) => i !== idx))}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Section 4: Endpoints */}
          <div className="imp-drawer-sec">
            <div className="imp-drawer-sec-h">
              <h4>{bi("访问入口（VIP / LB / 域名）", "Access Endpoints")}</h4>
              <Button
                size="mini"
                icon={<IconPlus />}
                onClick={() =>
                  setEndpoints((prev) => [...prev, { name: "writer", address: "", role: "readwrite" }])
                }
              >
                {bi("添加入口", "Add Endpoint")}
              </Button>
            </div>
            {endpoints.length > 0 && (
              <div className="imp-table-rows">
                <div className="imp-ep-row imp-col-heads">
                  <span>{bi("入口标识", "Label")}</span>
                  <span>{bi("访问地址 : 端口", "Address : Port")}</span>
                  <span>{bi("用途", "Role")}</span>
                  <span />
                </div>
                {endpoints.map((ep, idx) => (
                  <div key={idx} className="imp-ep-row">
                    <Input
                      value={ep.name || ""}
                      placeholder="writer"
                      onChange={(v) =>
                        setEndpoints((prev) => prev.map((r, i) => (i === idx ? { ...r, name: v } : r)))
                      }
                    />
                    <Input
                      className="mono"
                      value={ep.address}
                      placeholder="10.0.0.100:5432"
                      onChange={(v) =>
                        setEndpoints((prev) => prev.map((r, i) => (i === idx ? { ...r, address: v } : r)))
                      }
                    />
                    <Select
                      value={normalizeEndpointRole(ep.role)}
                      onChange={(v) =>
                        setEndpoints((prev) => prev.map((r, i) => (i === idx ? { ...r, role: v } : r)))
                      }
                    >
                      <Select.Option value="readwrite">{bi("读写入口", "Read/Write")}</Select.Option>
                      <Select.Option value="readonly">{bi("只读入口", "Read-Only")}</Select.Option>
                      <Select.Option value="admin">{bi("管理入口", "Admin")}</Select.Option>
                    </Select>
                    <Button
                      size="small"
                      type="text"
                      status="danger"
                      icon={<IconDelete />}
                      onClick={() => setEndpoints((prev) => prev.filter((_, i) => i !== idx))}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section 5: Paths & Service Units (Tag Chips - ZERO concatenation bug!) */}
          <div className="imp-drawer-sec">
            <div className="imp-drawer-sec-h">
              <h4>{bi("服务单元与运行路径", "Service Units & Paths")}</h4>
            </div>
            <div className="imp-form-grid-2">
              <div className="imp-field">
                <label>
                  <span className="imp-lbl-left">{bi("系统服务单元", "Service Units")}</span>
                </label>
                <InputTag
                  saveOnBlur
                  value={serviceUnits}
                  placeholder="patroni.service, etcd.service"
                  onChange={(vals) => setServiceUnits(normalizeTagList(vals as string[]))}
                />
              </div>
              <div className="imp-field">
                <label>
                  <span className="imp-lbl-left">{bi("配置文件路径", "Config Paths")}</span>
                </label>
                <InputTag
                  saveOnBlur
                  value={configPaths}
                  placeholder="/etc/patroni/patroni.yml"
                  onChange={(vals) => setConfigPaths(normalizeTagList(vals as string[]))}
                />
              </div>
              <div className="imp-field">
                <label>
                  <span className="imp-lbl-left">{bi("数据目录", "Data Dirs")}</span>
                </label>
                <InputTag
                  saveOnBlur
                  value={dataDirs}
                  placeholder="/data/pg, /data/etcd"
                  onChange={(vals) => setDataDirs(normalizeTagList(vals as string[]))}
                />
              </div>
              <div className="imp-field">
                <label>
                  <span className="imp-lbl-left">{bi("日志目录", "Log Dirs")}</span>
                </label>
                <InputTag
                  saveOnBlur
                  value={logDirs}
                  placeholder="/var/log/postgresql"
                  onChange={(vals) => setLogDirs(normalizeTagList(vals as string[]))}
                />
              </div>
            </div>
          </div>

          {/* Section 6: Key Parameters & Notes */}
          <div className="imp-drawer-sec">
            <div className="imp-drawer-sec-h">
              <h4>{bi("关键运行参数", "Key Parameters")}</h4>
              <Button
                size="mini"
                icon={<IconPlus />}
                onClick={() => setParamRows((prev) => [...prev, { key: "", value: "" }])}
              >
                {bi("添加参数", "Add Param")}
              </Button>
            </div>
            {paramRows.length > 0 && (
              <div className="imp-table-rows">
                {paramRows.map((pr, idx) => (
                  <div key={idx} className="imp-kv-row">
                    <Input
                      className="mono"
                      value={pr.key}
                      placeholder="key"
                      onChange={(v) =>
                        setParamRows((prev) => prev.map((r, i) => (i === idx ? { ...r, key: v } : r)))
                      }
                    />
                    <Input
                      className="mono"
                      value={pr.value}
                      placeholder="value"
                      onChange={(v) =>
                        setParamRows((prev) => prev.map((r, i) => (i === idx ? { ...r, value: v } : r)))
                      }
                    />
                    <Button
                      size="small"
                      type="text"
                      status="danger"
                      icon={<IconDelete />}
                      onClick={() => setParamRows((prev) => prev.filter((_, i) => i !== idx))}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="imp-field" style={{ marginTop: 4 }}>
              <label>
                <span className="imp-lbl-left">{bi("现场线索与运维备注", "Operations Notes")}</span>
              </label>
              <Input.TextArea
                autoSize={{ minRows: 2, maxRows: 6 }}
                value={notes}
                onChange={setNotes}
              />
            </div>
          </div>
          {lang ? null : null}
        </div>
      )}
    </Drawer>
  );
}

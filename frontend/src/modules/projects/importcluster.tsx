import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Drawer,
  Input,
  Message,
  Popover,
  Select,
  Skeleton,
  Tag,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconCheckCircle,
  IconClose,
  IconCode,
  IconCopy,
  IconDelete,
  IconDown,
  IconDownload,
  IconEdit,
  IconFile,
  IconFolder,
  IconImage,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSearch,
  IconThunderbolt,
  IconUp,
  IconUpload,
} from "@arco-design/web-react/icon";
import { canonicalCompanionTitle, cleanDisplayVersion } from "./topology";
import { Spark } from "../ai/aichat";
import { ModelPicker, useModelPick } from "../ai/modelpick";
import { ThinkLevel, useAIOptions } from "../ai/aitools";
import { api, can, copy } from "../../shared/shared";
import {
  LiveExecLogCard,
  navigateToClusterAutomation,
  pollRehearsalExecTask,
} from "../automation/rehearsal-automation";
import type {
  ClusterAutomationSummary,
  RehearsalExecTask,
} from "../automation/execution-types";
import type {
  ClusterView,
  ImportedCompanion,
  ImportedEndpoint,
  ImportedMeta,
  ImportedPkg,
  InstanceView,
  RehearsalTrace,
  RehearsalTraceStep,
} from "../../shared/shared";
import {
  AIProcessCard,
  markLiveStateError,
  streamPipelineSSE,
  type LiveAIState,
} from "../../shared/ai-process";
import { go } from "../../app/router";
import { AppGlyph, InstanceGraph } from "../../design/ui";
import { COLORS, isBrandIcon } from "../../design/glyphs";
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

type BaselineGap = {
  id: string;
  severity: "high" | "medium" | "low";
  category: string;
  title: string;
  detail: string;
  probe_action: string;
  selected: boolean;
  source?: "rule" | "ai";
};

type BaselineHealth = {
  score: number;
  passed: number;
  total: number;
  summary: string;
  gaps: BaselineGap[];
};

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
  health?: BaselineHealth;
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
  trace?: RehearsalTrace;
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
  { id: "pgbackrest", name: "pgBackRest", kind: "backup", icon: "storage", color: "green", default_role: "backup", role_title: "物理备份", topology: false },
  { id: "redis-sentinel", name: "Redis Sentinel", kind: "ha_manager", icon: "redis", color: "red", default_role: "sentinel", role_title: "哨兵", topology: true, default_ports: [{ name: "Sentinel", port: 26379 }] },
  { id: "zookeeper", name: "ZooKeeper", kind: "dcs", icon: "zookeeper", color: "amber", default_role: "node", role_title: "集群节点", topology: true, default_ports: [{ name: "ZooKeeper", port: 2181 }] },
  { id: "consul", name: "Consul", kind: "dcs", icon: "consul", color: "pink", default_role: "server", role_title: "Server", topology: true, default_ports: [{ name: "Consul", port: 8500 }] },
  { id: "clickhouse-keeper", name: "ClickHouse Keeper", kind: "dcs", icon: "clickhouse", color: "amber", default_role: "keeper", role_title: "Keeper", topology: true, default_ports: [{ name: "Keeper", port: 9181 }] },
  { id: "proxysql", name: "ProxySQL", kind: "proxy", icon: "mysql", color: "blue", default_role: "router", role_title: "代理路由", topology: true, default_ports: [{ name: "ProxySQL", port: 6033 }] },
  { id: "maxscale", name: "MariaDB MaxScale", kind: "proxy", icon: "mariadb", color: "indigo", default_role: "router", role_title: "代理路由", topology: true, default_ports: [{ name: "MaxScale", port: 4006 }] },
  { id: "obproxy", name: "OBProxy", kind: "proxy", icon: "oceanbase", color: "teal", default_role: "router", role_title: "代理路由", topology: true, default_ports: [{ name: "OBProxy", port: 2883 }] },
  { id: "node-exporter", name: "node_exporter", kind: "os_component", icon: "prometheus", color: "coral", default_role: "exporter", role_title: "OS 指标采集", topology: false, default_ports: [{ name: "Metrics", port: 9100 }] },
  { id: "process-exporter", name: "process_exporter", kind: "os_component", icon: "prometheus", color: "coral", default_role: "exporter", role_title: "OS 进程采集", topology: false, default_ports: [{ name: "Metrics", port: 9256 }] },
  { id: "postgres-exporter", name: "postgres_exporter", kind: "monitoring", icon: "prometheus", color: "coral", default_role: "exporter", role_title: "PG 指标采集", topology: false, default_ports: [{ name: "Metrics", port: 9187 }] },
  { id: "mysqld-exporter", name: "mysqld_exporter", kind: "monitoring", icon: "prometheus", color: "coral", default_role: "exporter", role_title: "MySQL 指标采集", topology: false, default_ports: [{ name: "Metrics", port: 9104 }] },
  { id: "redis-exporter", name: "redis_exporter", kind: "monitoring", icon: "prometheus", color: "coral", default_role: "exporter", role_title: "Redis 指标采集", topology: false, default_ports: [{ name: "Metrics", port: 9121 }] },
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
  companionIcon,
  companionKindMeta,
  detectMissingCompanionsFromMeta,
  effectiveCompanionKind,
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
      title: canonicalCompanionTitle(cid, cm.display_name || def?.name),
      version: cleanDisplayVersion(cm.version),
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

function splitNotesToClues(raw: string): string[] {
  const txt = (raw || "").trim();
  if (!txt) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const clean = s
      .replace(/^\s*(?:[•·\-*]|\d+[.)、])\s*/, "")
      .replace(/[。；;]+$/, "")
      .trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  };
  for (const line of txt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Split dense prose sentences on Chinese full stop (。) without breaking IPs or version numbers (.)
    if (trimmed.includes("。")) {
      for (const seg of trimmed.split(/。+/)) {
        push(seg);
      }
    } else {
      push(trimmed);
    }
  }
  return out;
}

function joinCluesToNotes(clues: string[]): string {
  return clues
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => `• ${c}`)
    .join("\n");
}

function clueCategoryMeta(text: string): { label: string; tone: string } {
  const low = text.toLowerCase();
  if (/发行版|percona|版本|version|内核|ubuntu|centos|rocky|kylin|openeuler/.test(low)) {
    return { label: bi("版本环境", "Edition"), tone: "blue" };
  }
  if (/patroni|leader|standby|quorum|主库|从库|复制|lag|lsn|etcd|sentinel|高可用|切换|tl=/.test(low)) {
    return { label: bi("高可用", "HA"), tone: "teal" };
  }
  if (/备份|pgbackrest|stanza|archive|wal|恢复|xtrabackup|rdb|aof/.test(low)) {
    return { label: bi("备份容灾", "Backup"), tone: "amber" };
  }
  if (/vip|入口|域名|haproxy|keepalived|nginx|端口|监听/.test(low)) {
    return { label: bi("访问入口", "Endpoint"), tone: "indigo" };
  }
  if (/tls|ssl|证书|加密|http|hba|权限|安全|cve|审计/.test(low)) {
    return { label: bi("安全合规", "Security"), tone: "coral" };
  }
  if (/日志|log|exporter|监控|告警|metrics|目录|磁盘|路径/.test(low)) {
    return { label: bi("路径监控", "Ops"), tone: "neutral" };
  }
  if (/节点|主机|node-|探针|仅在|hosts/.test(low)) {
    return { label: bi("节点范围", "Nodes"), tone: "neutral" };
  }
  return { label: bi("现场线索", "Clue"), tone: "neutral" };
}

/** Structured, scannable field-clue list replacing cramped paragraph textareas (with raw text toggle). */
function FieldCluesEditor({
  value,
  onChange,
  title,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  title?: string;
  placeholder?: string;
}) {
  useLang();
  const [rawMode, setRawMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const clues = useMemo(() => splitNotesToClues(value), [value]);

  const commitClues = (next: string[]) => {
    onChange(joinCluesToNotes(next));
  };

  const addClue = () => {
    const t = draft.trim();
    if (!t) return;
    commitClues([...clues, t]);
    setDraft("");
  };

  const saveEdit = (idx: number) => {
    const t = editingText.trim();
    if (!t) {
      commitClues(clues.filter((_, i) => i !== idx));
    } else {
      commitClues(clues.map((c, i) => (i === idx ? t : c)));
    }
    setEditingIdx(null);
    setEditingText("");
  };

  return (
    <div className="imp-clues-wrap">
      <div className="imp-clues-head">
        <div className="imp-clues-head-l">
          <span className="imp-lbl-left">
            {title || bi("现场线索与运维约束", "Field Clues & Operational Notes")}
          </span>
          {clues.length > 0 && <span className="imp-count-badge">{clues.length}</span>}
        </div>
        <button
          type="button"
          className="imp-inline-clear"
          onClick={() => setRawMode((v) => !v)}
        >
          {rawMode ? bi("切换卡片条理视图", "Structured View") : bi("切换纯文本编辑", "Plain Text")}
        </button>
      </div>

      {rawMode ? (
        <Input.TextArea
          autoSize={{ minRows: 4, maxRows: 10 }}
          value={value}
          onChange={onChange}
          placeholder={
            placeholder ||
            bi(
              "每行一条现场线索或运维约束（如维护窗口、特殊配置、待核对事项）",
              "One operational clue or constraint per line",
            )
          }
        />
      ) : (
        <div className="imp-clues-card">
          {clues.length === 0 ? (
            <div className="imp-clues-empty">
              {bi(
                "暂无线索记录。运行只读探针、变更演练或手动在下方添加维护窗口与环境约束，将自动沉淀于此。",
                "No clues recorded yet. Run a read-only probe, change rehearsal, or add notes below.",
              )}
            </div>
          ) : (
            <div className="imp-clues-list">
              {clues.map((item, idx) => {
                const cat = clueCategoryMeta(item);
                const isEditing = editingIdx === idx;
                return (
                  <div key={idx} className="imp-clue-row">
                    <span className={`imp-clue-tag is-${cat.tone}`}>{cat.label}</span>
                    {isEditing ? (
                      <div className="imp-clue-edit">
                        <Input
                          size="small"
                          value={editingText}
                          onChange={setEditingText}
                          autoFocus
                          onPressEnter={() => saveEdit(idx)}
                          onBlur={() => saveEdit(idx)}
                        />
                      </div>
                    ) : (
                      <span
                        className="imp-clue-txt"
                        title={bi("点击就地编辑", "Click to edit")}
                        onClick={() => {
                          setEditingIdx(idx);
                          setEditingText(item);
                        }}
                      >
                        {item}
                      </span>
                    )}
                    <div className="imp-clue-acts">
                      {!isEditing && (
                        <button
                          type="button"
                          className="imp-clue-icon"
                          aria-label={bi("编辑线索", "Edit clue")}
                          onClick={() => {
                            setEditingIdx(idx);
                            setEditingText(item);
                          }}
                        >
                          <IconEdit />
                        </button>
                      )}
                      <button
                        type="button"
                        className="imp-clue-icon is-del"
                        aria-label={bi("删除线索", "Delete clue")}
                        onClick={() => commitClues(clues.filter((_, i) => i !== idx))}
                      >
                        <IconDelete />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="imp-clues-add">
            <Input
              size="small"
              value={draft}
              onChange={setDraft}
              onPressEnter={addClue}
              placeholder={
                placeholder ||
                bi(
                  "补充一条现场线索或约束（如：每周日 02:00-04:00 为生产维护窗口），回车添加…",
                  "Add a field clue or constraint (e.g., maintenance window Sun 02:00-04:00) and press Enter…",
                )
              }
            />
            <Button size="small" icon={<IconPlus />} disabled={!draft.trim()} onClick={addClue}>
              {bi("添加", "Add")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

type ImportLiveKind = "import-parse" | "import-probe" | "import-diagnose";

function buildImportInitialLive(
  kind: ImportLiveKind,
  title: string,
  target?: { provider?: string; model?: string },
): LiveAIState<ImportLiveKind> {
  const steps: RehearsalTraceStep[] =
    kind === "import-probe"
      ? [
          {
            id: "inspect-baseline",
            kind: "inspect",
            title: bi("读取集群基线与采集目标", "Inspect Baseline & Probe Targets"),
            detail: bi("正在装载组件形态与待补采缺口上下文…", "Loading component layout & selected gap context…"),
            ok: true,
            status: "running",
          },
          {
            id: "inject-ro-policy",
            kind: "guard",
            title: bi("注入 100% 纯只读安全红线规则", "Inject 100% Read-Only Safety Guardrails"),
            detail: bi("锁定零写操作、零服务重启与凭据脱敏约束", "Locking zero-write, zero-restart & secret redaction rules"),
            ok: true,
            status: "pending",
          },
          {
            id: "connect-model",
            kind: "connect",
            title: bi("连接模型网关与投递上下文", "Connect Model Gateway & Dispatch Context"),
            detail: bi("等待安全校验完成后建立模型流式连接", "Waiting for safety checks before opening AI stream"),
            ok: true,
            status: "pending",
          },
          {
            id: "model-think",
            kind: "think",
            title: bi("设计精炼只读现场采集策略", "Design Lean Read-Only Probe Strategy"),
            detail: bi("等待模型通道返回首包后展开推演", "Waiting for first token from model stream"),
            ok: true,
            status: "pending",
          },
          {
            id: "readonly-ast-guard",
            kind: "guard",
            title: bi("生成探针脚本与静态安全门禁校验", "Generate Probe & Static Read-Only Gate"),
            detail: bi("等待脚本编写完成后执行静态只读安全扫描", "Waiting for script output before static read-only scan"),
            ok: true,
            status: "pending",
          },
        ]
      : kind === "import-diagnose"
        ? [
            {
              id: "scan-baseline",
              kind: "inspect",
              title: bi("通读集群基线、架构栈与变更台账", "Read Baseline, Stack & History"),
              detail: bi("正在加载当前拓扑、参数、历史变更与安全态势…", "Loading topology, params, change history & security context…"),
              ok: true,
              status: "running",
            },
            {
              id: "redact-context",
              kind: "guard",
              title: bi("敏感凭据自动脱敏与只读核验锁定", "Scrub Credentials & Lock Read-Only"),
              detail: bi("自动剥离敏感凭据，仅放行 100% 只读核验项", "Scrubbing secrets locally; allowing 100% read-only checks only"),
              ok: true,
              status: "pending",
            },
            {
              id: "connect-model",
              kind: "connect",
              title: bi("连接模型网关与投递上下文", "Connect Model Gateway & Dispatch Context"),
              detail: bi("等待脱敏完成后建立模型流式连接", "Waiting for redaction before opening AI stream"),
              ok: true,
              status: "pending",
            },
            {
              id: "model-think",
              kind: "think",
              title: bi("研判固定规则之外的架构盲区", "Identify Architecture-Specific Blind Spots"),
              detail: bi("等待模型通道返回首包后展开推演", "Waiting for first token from model stream"),
              ok: true,
              status: "pending",
            },
            {
              id: "synth-gaps",
              kind: "synthesize",
              title: bi("收敛只读补采清单与优先级", "Compile Read-Only Gap Checklist"),
              detail: bi("等待盲区研判完成后生成只读补采建议", "Waiting for analysis before compiling gap checklist"),
              ok: true,
              status: "pending",
            },
          ]
        : [
            {
              id: "det-scan",
              kind: "inspect",
              title: bi("扫描现场回显与架构线索", "Scan Live Evidence & Clues"),
              detail: bi("正在运行规则预扫描并整理输入回显与截图…", "Running pre-scan over pasted output & screenshots…"),
              ok: true,
              status: "running",
            },
            {
              id: "redact-secrets",
              kind: "guard",
              title: bi("敏感凭据自动脱敏与规范化", "Scrub Credentials & Normalize Input"),
              detail: bi("自动剥离口令、私钥与敏感连接串，仅投递架构元数据", "Scrubbing passwords, keys & DSNs; topology metadata only"),
              ok: true,
              status: "pending",
            },
            {
              id: "connect-model",
              kind: "connect",
              title: bi("连接模型网关与投递上下文", "Connect Model Gateway & Dispatch Context"),
              detail: bi("等待脱敏完成后建立模型流式连接", "Waiting for redaction before opening AI stream"),
              ok: true,
              status: "pending",
            },
            {
              id: "model-think",
              kind: "think",
              title: bi("识别主机角色与多组件架构栈", "Analyze Hosts & Companion Stack"),
              detail: bi("等待模型通道返回首包后展开推演", "Waiting for first token from model stream"),
              ok: true,
              status: "pending",
            },
            {
              id: "synth-baseline",
              kind: "synthesize",
              title: bi("合成结构化纳管基线草稿", "Synthesize Structured Baseline Draft"),
              detail: bi("等待架构推演完成后组装基线拓扑草稿", "Waiting for analysis before assembling baseline draft"),
              ok: true,
              status: "pending",
            },
          ];

  return {
    kind,
    title,
    startedAt: Date.now(),
    steps,
    thinking: "",
    phase: steps[0]?.detail || "",
    chars: 0,
    provider: target?.provider,
    model: target?.model,
  };
}

type ProbeTailorPreset = {
  id: string;
  tag: string;
  tone: "brand" | "teal" | "ok" | "warn" | "violet" | "neutral";
  title: string;
  desc: string;
  prompt: string;
  recommended?: boolean;
};

function formatProbeStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function buildTimestampedProbeFilename(
  base: string,
  source: "template" | "ai",
  mode: "gap" | "full",
  stamp: string,
): string {
  const clean = (base || "mw-import-probe.sh").trim();
  const dot = clean.lastIndexOf(".");
  const stem = (dot > 0 ? clean.slice(0, dot) : clean).replace(/-\d{8}-\d{6}$/, "");
  const ext = dot > 0 ? clean.slice(dot) : ".sh";
  const tag =
    source === "ai"
      ? mode === "gap"
        ? "-ai-gap"
        : "-ai"
      : mode === "gap"
        ? "-gap"
        : "";
  return `${stem}${tag}-${stamp}${ext}`;
}

function getProbeTailorSuggestions(
  componentId?: string,
  deployMethod?: string,
): ProbeTailorPreset[] {
  const cid = (componentId || "").trim().toLowerCase();
  const isContainer = deployMethod === "docker" || deployMethod === "k8s";

  if (cid === "postgresql" || cid.includes("postgres") || cid === "pg") {
    return [
      {
        id: "pg-ha",
        tag: bi("高可用", "HA"),
        tone: "brand",
        title: bi("Patroni + etcd 高可用拓扑", "Patroni + etcd HA Stack"),
        desc: bi("采 patronictl list、etcd 成员健康、主从角色与 WAL 延迟", "Collect patronictl list, etcd member health, roles & WAL lag"),
        prompt: "重点采集 Patroni (patronictl list / patroni.yml) 与 etcd 成员健康状态、主从角色及同步延迟",
        recommended: true,
      },
      {
        id: "pg-backup",
        tag: bi("备份", "Backup"),
        tone: "ok",
        title: bi("pgBackRest 与 WAL 归档", "pgBackRest & WAL Archive"),
        desc: bi("采 stanza 状态、最近全量/增量备份与 archive_command", "Collect stanza info, latest backups & archive_command"),
        prompt: "重点采集 pgBackRest stanza 配置、最近备份状态、archive_command 与 WAL 归档目录",
        recommended: true,
      },
      {
        id: "pg-proxy",
        tag: bi("入口代理", "Proxy/VIP"),
        tone: "teal",
        title: bi("PgBouncer / HAProxy / VIP", "PgBouncer / HAProxy / VIP"),
        desc: bi("采连接池模式、代理监听端口与 Keepalived VIP 归属", "Collect pool mode, proxy listeners & Keepalived VIP"),
        prompt: "重点探测 PgBouncer 连接池配置、HAProxy/Nginx 监听端口与 Keepalived VIP 归属",
      },
      {
        id: "pg-tls",
        tag: bi("安全证书", "TLS/Auth"),
        tone: "violet",
        title: bi("TLS 证书有效期与 pg_hba", "TLS Certs & pg_hba Rules"),
        desc: bi("采 SSL 证书到期时间、协议版本与脱敏认证规则", "Collect SSL cert expiry, TLS version & redacted pg_hba"),
        prompt: "重点采集 PostgreSQL SSL 证书链有效期、TLS 版本以及脱敏后的 pg_hba.conf 认证方式",
      },
      {
        id: "pg-container",
        tag: bi("部署形态", "Runtime"),
        tone: "warn",
        title: bi("容器 / 非标准路径部署", "Container / Custom PGDATA"),
        desc: bi("适配 Docker/Podman/K8s 与自定义 PGDATA、多实例目录", "Support Docker/Podman/K8s & custom PGDATA paths"),
        prompt: "适配容器（Docker/Podman/K8s）及非标准 PGDATA 路径、多实例 systemd 服务名探测",
        recommended: isContainer,
      },
      {
        id: "pg-fast",
        tag: bi("极速模式", "Fast"),
        tone: "neutral",
        title: bi("极速核心拓扑（10 秒内）", "Fast Core Topology (<10s)"),
        desc: bi("跳过耗时目录扫描，仅快采主机、版本、角色与核心参数", "Skip heavy scans; grab hosts, versions, roles & key params"),
        prompt: "保持极速精简（10 秒内完成），跳过大目录遍历，仅采主机、版本、主从角色、端口与核心参数",
      },
    ];
  }

  if (cid === "mysql" || cid === "mariadb") {
    return [
      {
        id: "my-ha",
        tag: bi("高可用", "HA"),
        tone: "brand",
        title: bi("MGR / MHA / 主从复制", "MGR / MHA / Replication"),
        desc: bi("采组复制成员、GTID、半同步与主从 IO/SQL 延迟", "Collect group replication, GTID, semi-sync & lag"),
        prompt: "重点采集 MySQL/MariaDB 主从复制或 MGR 组复制状态、GTID 配置与复制延迟",
        recommended: true,
      },
      {
        id: "my-proxy",
        tag: bi("入口代理", "Proxy/VIP"),
        tone: "teal",
        title: bi("ProxySQL / HAProxy / VIP", "ProxySQL / HAProxy / VIP"),
        desc: bi("采读写分离路由、代理监听端口与 Keepalived VIP", "Collect read/write split rules, proxy ports & VIP"),
        prompt: "重点探测 ProxySQL/MaxScale/HAProxy 读写分离代理配置与 Keepalived VIP",
        recommended: true,
      },
      {
        id: "my-innodb",
        tag: bi("核心参数", "InnoDB"),
        tone: "ok",
        title: bi("InnoDB 与 Binlog 基线", "InnoDB & Binlog Baseline"),
        desc: bi("采缓冲池大小、最大连接、binlog 格式与慢日志配置", "Collect buffer pool, max_connections, binlog & slow log"),
        prompt: "重点采集 InnoDB 缓冲池、连接数上限、binlog 格式/保留策略与慢日志路径",
      },
      {
        id: "my-tls",
        tag: bi("安全备份", "TLS/Backup"),
        tone: "violet",
        title: bi("TLS 证书与定时备份线索", "TLS Certs & Backup Cron"),
        desc: bi("采 SSL 证书到期时间、XtraBackup/mysqldump 定时任务", "Collect SSL expiry & XtraBackup/mysqldump schedules"),
        prompt: "重点采集 MySQL SSL 证书有效期以及 XtraBackup/mysqldump 定时备份脚本线索",
      },
      {
        id: "my-container",
        tag: bi("部署形态", "Runtime"),
        tone: "warn",
        title: bi("容器 / 多实例部署", "Container / Multi-Instance"),
        desc: bi("适配 Docker/Podman 与多端口 mysqld、非标准 my.cnf", "Support Docker/Podman & multi-port mysqld instances"),
        prompt: "适配容器（Docker/Podman）及同机多实例 mysqld 端口、非标准 my.cnf 路径探测",
        recommended: isContainer,
      },
      {
        id: "my-fast",
        tag: bi("极速模式", "Fast"),
        tone: "neutral",
        title: bi("极速核心拓扑（10 秒内）", "Fast Core Topology (<10s)"),
        desc: bi("跳过耗时扫描，快速采出主机、版本、角色与核心参数", "Skip heavy scans; grab hosts, version, role & key params"),
        prompt: "保持极速精简（10 秒内完成），仅采主机、版本、主从角色、端口、目录与核心参数",
      },
    ];
  }

  if (cid === "redis" || cid === "valkey") {
    return [
      {
        id: "rd-ha",
        tag: bi("高可用", "HA"),
        tone: "brand",
        title: bi("Sentinel / Cluster 分片", "Sentinel / Cluster Slots"),
        desc: bi("采 CLUSTER NODES、哨兵仲裁状态与主从复制偏移", "Collect CLUSTER NODES, Sentinel quorum & repl offset"),
        prompt: "重点采集 Redis/Valkey Cluster 分片拓扑或 Sentinel 哨兵仲裁状态、主从复制关系",
        recommended: true,
      },
      {
        id: "rd-mem",
        tag: bi("持久化", "Persist"),
        tone: "ok",
        title: bi("RDB/AOF 与内存水位", "RDB/AOF & Memory Policy"),
        desc: bi("采 maxmemory 淘汰策略、内存碎片率与落盘目录", "Collect maxmemory policy, fragmentation & persistence dir"),
        prompt: "重点采集 maxmemory 及淘汰策略、内存碎片率、RDB/AOF 持久化配置与数据目录水位",
        recommended: true,
      },
      {
        id: "rd-sec",
        tag: bi("安全鉴权", "Security"),
        tone: "violet",
        title: bi("TLS 证书与 ACL / 禁危命令", "TLS Certs & ACL Rules"),
        desc: bi("采 TLS 证书有效期、ACL 开关与 rename-command（全脱敏）", "Collect TLS expiry, ACL mode & rename-command (redacted)"),
        prompt: "重点采集 TLS 证书有效期、是否启用 ACL/密码鉴权（严禁输出密码原文）与 rename-command 规则",
      },
      {
        id: "rd-proxy",
        tag: bi("入口代理", "Proxy/VIP"),
        tone: "teal",
        title: bi("HAProxy / Keepalived 入口", "HAProxy / Keepalived Entry"),
        desc: bi("采前置代理监听端口、后端探测与 VIP 归属", "Collect proxy listeners, health checks & VIP"),
        prompt: "重点探测 HAProxy / Keepalived / Twemproxy 前置入口配置与 VIP 归属",
      },
      {
        id: "rd-container",
        tag: bi("部署形态", "Runtime"),
        tone: "warn",
        title: bi("容器 / 同机多端口实例", "Container / Multi-Port"),
        desc: bi("适配 Docker/Podman 与单机多端口 Redis 进程探测", "Support Docker/Podman & multi-port instances"),
        prompt: "适配容器部署及同机多端口 Redis 实例配置路径定位",
        recommended: isContainer,
      },
      {
        id: "rd-fast",
        tag: bi("极速模式", "Fast"),
        tone: "neutral",
        title: bi("极速核心拓扑（10 秒内）", "Fast Core Topology (<10s)"),
        desc: bi("轻量只读快采角色、版本、端口、内存上限与配置路径", "Fast read-only capture of role, version, ports & memory"),
        prompt: "保持极速精简（10 秒内完成），仅采节点角色、版本、端口、内存上限与核心配置",
      },
    ];
  }

  if (cid === "kafka") {
    return [
      {
        id: "kf-coord",
        tag: bi("集群协调", "Quorum"),
        tone: "brand",
        title: bi("KRaft / ZooKeeper 协调栈", "KRaft / ZooKeeper Quorum"),
        desc: bi("采 Broker/Controller 角色、Quorum 状态与元数据路径", "Collect Broker/Controller roles, quorum & metadata dir"),
        prompt: "重点识别 Kafka 采用 KRaft 还是 ZooKeeper 模式，采集协调节点列表与 Quorum 状态",
        recommended: true,
      },
      {
        id: "kf-disk",
        tag: bi("存储分区", "Storage"),
        tone: "ok",
        title: bi("log.dirs 数据盘与保留策略", "log.dirs Disk & Retention"),
        desc: bi("采多块数据盘挂载水位、副本因子与日志保留周期", "Collect log.dirs mount usage, replication & retention"),
        prompt: "重点采集 log.dirs 多盘挂载点与磁盘水位、默认副本因子、min.insync.replicas 与保留策略",
        recommended: true,
      },
      {
        id: "kf-sec",
        tag: bi("安全认证", "Security"),
        tone: "violet",
        title: bi("SASL / TLS 安全监听", "SASL / TLS Listeners"),
        desc: bi("采 listeners 协议、Kerberos/SASL 线索与证书有效期", "Collect listeners protocol, SASL hints & cert expiry"),
        prompt: "重点采集 Kafka listeners / security.protocol、SASL 认证方式（全脱敏）与 TLS 证书有效期",
      },
      {
        id: "kf-eco",
        tag: bi("伴生生态", "Ecosystem"),
        tone: "teal",
        title: bi("Connect / Schema / Exporter", "Connect / Schema / Exporter"),
        desc: bi("识别 Kafka Connect、Schema Registry 与监控采集器", "Detect Kafka Connect, Schema Registry & exporters"),
        prompt: "重点探测 Kafka Connect、Schema Registry、JMX/Kafka Exporter 等伴生进程与端口",
      },
      {
        id: "kf-container",
        tag: bi("部署形态", "Runtime"),
        tone: "warn",
        title: bi("容器 / 自定义 JVM 路径", "Container / Custom JVM"),
        desc: bi("适配 Docker/K8s 与非标准 server.properties、堆内存参数", "Support Docker/K8s, custom config & JVM heap flags"),
        prompt: "适配容器部署及非标准 server.properties 路径，采集 JVM 堆内存与 GC 参数",
        recommended: isContainer,
      },
      {
        id: "kf-fast",
        tag: bi("极速模式", "Fast"),
        tone: "neutral",
        title: bi("极速核心拓扑（10 秒内）", "Fast Core Topology (<10s)"),
        desc: bi("跳过重度 Topic 遍历，快采 Broker、版本、端口与磁盘", "Skip topic scans; grab Broker, version, ports & disks"),
        prompt: "保持极速精简（10 秒内完成），跳过全量 Topic 遍历，仅采 Broker、版本、监听端口与磁盘",
      },
    ];
  }

  if (cid === "nginx" || cid === "haproxy" || cid === "keepalived" || cid === "apisix") {
    return [
      {
        id: "lb-vrrp",
        tag: bi("高可用", "VRRP/VIP"),
        tone: "brand",
        title: bi("Keepalived VRRP 与 VIP", "Keepalived VRRP & VIP"),
        desc: bi("采 VRRP 优先级、漂移网卡、健康检测脚本与 VIP 归属", "Collect VRRP priority, interface, check script & VIP"),
        prompt: "重点采集 Keepalived VRRP 实例状态、优先级、绑定网卡、健康检查脚本与当前 VIP 归属",
        recommended: true,
      },
      {
        id: "lb-up",
        tag: bi("转发路由", "Upstreams"),
        tone: "teal",
        title: bi("Upstream 与后端健康池", "Upstreams & Backends"),
        desc: bi("梳理四/七层上游后端列表、均衡算法与超时参数", "Collect L4/L7 upstream pools, balance policy & timeouts"),
        prompt: "重点梳理所有四层/七层 Upstream 后端地址池、负载均衡算法、连接超时与限流参数",
        recommended: true,
      },
      {
        id: "lb-tls",
        tag: bi("证书安全", "HTTPS/TLS"),
        tone: "violet",
        title: bi("HTTPS / TLS 证书有效期", "HTTPS / TLS Cert Expiry"),
        desc: bi("扫描所有生效站点证书到期时间、协议版本与密码套件", "Scan active site cert expiry, TLS versions & ciphers"),
        prompt: "重点扫描生效配置引用的全部 TLS/SSL 证书到期时间、TLS 协议版本与加密套件",
      },
      {
        id: "lb-obs",
        tag: bi("监控日志", "Metrics"),
        tone: "ok",
        title: bi("Exporter 与日志切割路径", "Exporters & Log Rotation"),
        desc: bi("采 stub_status/stats 端口、日志目录水位与 Exporter", "Collect stats endpoint, log usage & exporters"),
        prompt: "重点采集 stub_status/HAProxy stats 监控端口、日志路径磁盘水位与 Prometheus Exporter",
      },
      {
        id: "lb-container",
        tag: bi("部署形态", "Runtime"),
        tone: "warn",
        title: bi("容器 / 多配置包含目录", "Container / Include Dirs"),
        desc: bi("适配 Docker/OpenResty 与 conf.d/sites-enabled 多文件", "Support Docker/OpenResty & nested include configs"),
        prompt: "适配容器或 OpenResty 部署，完整跟随 include 展开 conf.d / sites-enabled 配置结构",
        recommended: isContainer,
      },
      {
        id: "lb-fast",
        tag: bi("极速模式", "Fast"),
        tone: "neutral",
        title: bi("极速核心拓扑（10 秒内）", "Fast Core Topology (<10s)"),
        desc: bi("快采版本、编译模块、监听端口、VIP 与上游概览", "Grab version, modules, listeners, VIP & upstreams"),
        prompt: "保持极速精简（10 秒内完成），仅采版本、监听端口、VIP 归属与上游概览",
      },
    ];
  }

  return [
    {
      id: "gen-ha",
      tag: bi("高可用", "HA"),
      tone: "brand",
      title: bi("集群拓扑与主从/仲裁状态", "Cluster Topology & Quorum"),
      desc: bi("重点采节点角色、成员健康、复制同步状态与仲裁端口", "Collect node roles, member health, sync & quorum ports"),
      prompt: "重点采集集群节点角色、成员健康与主从/仲裁同步状态、内部通信端口",
      recommended: true,
    },
    {
      id: "gen-proxy",
      tag: bi("入口代理", "Proxy/VIP"),
      tone: "teal",
      title: bi("VIP / HAProxy / Nginx 入口", "VIP / HAProxy / Nginx Entry"),
      desc: bi("识别前置负载均衡、Keepalived VIP 与对外访问端口", "Detect front load balancers, Keepalived VIP & ports"),
      prompt: "重点探测前置 Keepalived VIP、HAProxy/Nginx 代理转发配置及对外监听端口",
      recommended: true,
    },
    {
      id: "gen-tls",
      tag: bi("安全证书", "TLS/Auth"),
      tone: "violet",
      title: bi("TLS 证书有效期与访问控制", "TLS Certs & Access Control"),
      desc: bi("采服务证书到期时间、监听绑定地址与脱敏认证方式", "Collect cert expiry, bind addresses & redacted auth"),
      prompt: "重点采集服务 TLS 证书链有效期、监听绑定地址以及脱敏后的访问控制配置",
    },
    {
      id: "gen-disk",
      tag: bi("存储备份", "Storage"),
      tone: "ok",
      title: bi("数据盘挂载与备份策略", "Data Disks & Backup Jobs"),
      desc: bi("采数据/日志目录磁盘水位、文件系统与定时备份线索", "Collect data/log mount usage, FS & backup schedules"),
      prompt: "重点采集数据盘与日志盘挂载点、文件系统水位以及 crontab/systemd 定时备份线索",
    },
    {
      id: "gen-container",
      tag: bi("部署形态", "Runtime"),
      tone: "warn",
      title: bi("容器 / 自定义安装路径", "Container / Custom Paths"),
      desc: bi("适配 Docker/Podman/K8s 与非标准 systemd 服务路径", "Support Docker/Podman/K8s & custom service paths"),
      prompt: "适配容器（Docker/Podman/K8s）部署及非标准配置/数据目录路径探测",
      recommended: isContainer,
    },
    {
      id: "gen-fast",
      tag: bi("极速模式", "Fast"),
      tone: "neutral",
      title: bi("极速核心拓扑（10 秒内）", "Fast Core Topology (<10s)"),
      desc: bi("跳过耗时目录扫描，快采主机、版本、端口与核心参数", "Skip heavy scans; grab hosts, version, ports & params"),
      prompt: "保持极速精简（10 秒内完成），跳过耗时目录扫描，仅采主机、版本、角色、端口与核心参数",
    },
  ];
}

function ProbeCodeBlock({
  script,
  filename,
  componentId,
  componentName,
  deployMethod,
  safe = true,
  source = "template",
  mode = "full",
  coveredGaps = [],
  runHint,
  modelName,
  compact = false,
  hideTailorBar = false,
  aiEnabled = false,
  aiBusy = false,
  gapCount,
  onCustomizeWithAI,
  onResetTemplate,
}: {
  script: string;
  filename: string;
  componentId?: string;
  componentName?: string;
  deployMethod?: string;
  safe?: boolean;
  source?: "template" | "ai";
  mode?: "gap" | "full";
  coveredGaps?: string[];
  runHint?: string;
  modelName?: string;
  compact?: boolean;
  hideTailorBar?: boolean;
  aiEnabled?: boolean;
  aiBusy?: boolean;
  gapCount?: number;
  onCustomizeWithAI?: (focus: string) => void | Promise<void>;
  onResetTemplate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [aiBarOpen, setAiBarOpen] = useState(false);
  const [selectedPresetIds, setSelectedPresetIds] = useState<string[]>([]);
  const [focusText, setFocusText] = useState("");
  const [copied, setCopied] = useState(false);
  const [scriptStamp, setScriptStamp] = useState(() => formatProbeStamp());
  const lines = useMemo(() => (script ? script.split("\n") : []), [script]);

  useEffect(() => {
    if (script) {
      setScriptStamp(formatProbeStamp());
    }
  }, [script, source, mode]);

  useEffect(() => {
    // Reset selections if the user switches middleware type in Step 1.
    setSelectedPresetIds([]);
  }, [componentId]);

  useEffect(() => {
    // Auto-fold panels when AI probe generation starts so the AIProcessCard takes focus.
    if (aiBusy) {
      setExpanded(false);
      setAiBarOpen(false);
    }
  }, [aiBusy]);

  const tailorPresets = useMemo(
    () => getProbeTailorSuggestions(componentId, deployMethod),
    [componentId, deployMethod],
  );

  const displayFilename = useMemo(
    () => buildTimestampedProbeFilename(filename, source, mode, scriptStamp),
    [filename, source, mode, scriptStamp],
  );

  const downloadScript = () => {
    const stampedName = buildTimestampedProbeFilename(
      filename,
      source,
      mode,
      formatProbeStamp(),
    );
    const blob = new Blob([script], { type: "text/x-shellscript;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = stampedName;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    Message.success(
      bi(`已下载 ${stampedName}`, `Downloaded ${stampedName}`),
    );
  };

  const handleCopy = () => {
    copy(script);
    setCopied(true);
    Message.success(bi("已复制 100% 只读采集脚本", "100% read-only probe script copied"));
    window.setTimeout(() => setCopied(false), 1600);
  };

  const togglePreset = (id: string) => {
    setSelectedPresetIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleRunTailor = () => {
    if (!onCustomizeWithAI || aiBusy) return;
    const pickedPrompts = tailorPresets
      .filter((p) => selectedPresetIds.includes(p.id))
      .map((p) => p.prompt);
    const custom = focusText.trim();
    const combined = [...pickedPrompts, ...(custom ? [custom] : [])].join("；");
    setAiBarOpen(false);
    void onCustomizeWithAI(combined);
  };

  const hasSubMeta = coveredGaps.length > 0 || Boolean(runHint) || Boolean(modelName);
  const selectedCount = selectedPresetIds.length;

  return (
    <div className="imp-probe-stack">
      {!hideTailorBar && aiBarOpen && onCustomizeWithAI && (
        <div
          className="imp-tailor-card enter"
          role="region"
          aria-label={bi("AI 智能定制只读探针", "AI Read-Only Probe Tailor")}
        >
          <div className="imp-tailor-head">
            <div className="imp-tailor-head-l">
              <span className="imp-tailor-spark-badge" aria-hidden>
                <Spark size={14} rainbow />
              </span>
              <div className="imp-tailor-title-group">
                <div className="imp-tailor-title-row">
                  <b>{bi("AI 智能定制只读探针", "AI Read-Only Probe Tailor")}</b>
                  {componentName && (
                    <span className="imp-tailor-scope-pill">
                      {bi(`${componentName} 场景推荐`, `${componentName} Presets`)}
                    </span>
                  )}
                </div>
                <p>
                  {bi(
                    "点选现场特征卡片（可多选），或补充自定义需求，AI 将精炼生成 100% 只读专属脚本。",
                    "Select scenario cards below (multi-select) or add custom hints; AI crafts a 100% read-only script.",
                  )}
                </p>
              </div>
            </div>
            <div className="imp-tailor-head-r">
              {selectedCount > 0 && (
                <>
                  <span className="imp-tailor-sel-pill num">
                    {bi(`已选 ${selectedCount} 项`, `${selectedCount} selected`)}
                  </span>
                  <Button
                    size="mini"
                    type="text"
                    disabled={aiBusy}
                    onClick={() => setSelectedPresetIds([])}
                  >
                    {bi("清空", "Clear")}
                  </Button>
                </>
              )}
              <Button
                size="mini"
                type="text"
                icon={<IconClose />}
                onClick={() => setAiBarOpen(false)}
                aria-label={bi("收起 AI 定制面板", "Close AI tailor panel")}
              />
            </div>
          </div>

          <div className="imp-tailor-grid" role="group" aria-label={bi("AI 推荐现场场景", "AI Recommended Scenarios")}>
            {tailorPresets.map((item) => {
              const on = selectedPresetIds.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`imp-tailor-opt ${on ? "is-selected" : ""}`}
                  aria-pressed={on}
                  disabled={aiBusy}
                  onClick={() => togglePreset(item.id)}
                >
                  <div className="imp-tailor-opt-top">
                    <div className="imp-tailor-opt-tags">
                      <span className={`imp-tailor-tag is-${item.tone}`}>{item.tag}</span>
                      {item.recommended && (
                        <span className="imp-tailor-rec">
                          <Spark size={9} /> {bi("推荐", "Pick")}
                        </span>
                      )}
                    </div>
                    <span className={`imp-tailor-check ${on ? "is-on" : ""}`} aria-hidden>
                      {on && <IconCheck />}
                    </span>
                  </div>
                  <b>{item.title}</b>
                  <p>{item.desc}</p>
                </button>
              );
            })}
          </div>

          <div className="imp-tailor-foot">
            <Input
              allowClear
              disabled={aiBusy}
              value={focusText}
              onChange={setFocusText}
              onPressEnter={handleRunTailor}
              placeholder={bi(
                "可选：补充其他现场特点（如自定义端口 15432、指定配置目录 /data/conf、过滤敏感目录…）",
                "Optional: add custom hints (e.g. custom port 15432, config dir /data/conf…)",
              )}
              aria-label={bi("补充自定义探针要求", "Custom probe instructions")}
            />
            <div className="imp-tailor-foot-acts">
              {source === "ai" && onResetTemplate && (
                <Button size="small" disabled={aiBusy} onClick={onResetTemplate}>
                  {bi("恢复标准探针", "Reset Standard")}
                </Button>
              )}
              <Button
                size="small"
                type="primary"
                loading={aiBusy}
                icon={<Spark size={12} />}
                onClick={handleRunTailor}
              >
                {selectedCount > 0
                  ? bi(`生成专属探针 (${selectedCount})`, `Generate Tailored (${selectedCount})`)
                  : bi("生成精炼探针", "Generate Probe")}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className={`imp-probe-box ${!expanded && !hasSubMeta ? "is-folded" : ""}`}>
        <div className="imp-probe-bar">
          <div className="imp-probe-bar-l">
            <code className="imp-probe-fname" title={displayFilename}>
              {displayFilename}
            </code>
            <Tooltip
              content={
                safe
                  ? bi("已通过 100% 静态只读安全校验，绝不修改任何线上配置或进程", "Passed 100% static read-only safety verification")
                  : bi("只读探针采集脚本", "Read-only probe script")
              }
              mini
            >
              <span className="imp-probe-shield">
                <IconCheckCircle />
                <span>{safe ? bi("只读校验", "Read-Only") : bi("只读", "RO")}</span>
              </span>
            </Tooltip>
            <span className={`imp-probe-mode-tag ${source === "ai" ? "is-ai" : ""}`}>
              {source === "ai" && <Spark size={10} />}
              {source === "ai"
                ? mode === "gap"
                  ? bi("AI 补采", "AI Gap")
                  : bi("AI 定制", "AI Tailored")
                : mode === "gap"
                  ? bi("缺口补采", "Gap")
                  : bi("标准探针", "Standard")}
            </span>
            <span className="imp-probe-lines num">
              {lines.length > 0
                ? `${lines.length} ${bi("行", "lines")}`
                : bi("加载中…", "Loading…")}
            </span>
          </div>

          <div className="imp-probe-actions">
            {!hideTailorBar && onCustomizeWithAI && aiEnabled && (
              <button
                type="button"
                className={`imp-probe-act is-ai ${aiBarOpen ? "is-on" : ""}`}
                disabled={aiBusy}
                onClick={() => setAiBarOpen((v) => !v)}
              >
                <Spark size={11} rainbow={!aiBarOpen} />
                <span>
                  {selectedCount > 0 && !aiBarOpen
                    ? bi(`AI 定制 · ${selectedCount}`, `AI Tailor · ${selectedCount}`)
                    : bi("AI 定制", "AI Tailor")}
                </span>
              </button>
            )}
            {lines.length > 0 && (
              <button
                type="button"
                className="imp-probe-act"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? <IconUp /> : <IconDown />}
                <span>{expanded ? bi("收起脚本", "Hide Script") : bi("查看脚本", "View Script")}</span>
              </button>
            )}
            <button type="button" className="imp-probe-act" disabled={!script} onClick={downloadScript}>
              <IconDownload />
              <span>{bi("下载", "Download")}</span>
            </button>
            <button
              type="button"
              className={`imp-probe-act is-primary ${copied ? "is-copied" : ""}`}
              disabled={!script}
              onClick={handleCopy}
            >
              {copied ? <IconCheck /> : <IconCopy />}
              <span>{copied ? bi("已复制", "Copied") : bi("复制脚本", "Copy")}</span>
            </button>
          </div>
        </div>

        {hasSubMeta && (
          <div className="imp-probe-meta-strip">
            {coveredGaps.length > 0 && (
              <div className="imp-probe-cov">
                <span>{bi("覆盖：", "Covers:")}</span>
                {coveredGaps.map((g, i) => (
                  <em key={i}>{g}</em>
                ))}
              </div>
            )}
            {modelName && <span className="imp-probe-model mono">{modelName}</span>}
            {runHint && <span className="imp-probe-hint">{runHint}</span>}
          </div>
        )}

        {expanded && (
          <pre className="imp-probe-pre is-expanded">
            {script || bi("正在生成只读采集脚本…", "Generating read-only probe script...")}
          </pre>
        )}
      </div>
    </div>
  );
}

function ImportParseFocusBar({
  collapsed,
  onToggle,
  includesProbe = false,
  textLength,
  imageCount,
  isRunning,
}: {
  collapsed: boolean;
  onToggle: () => void;
  includesProbe?: boolean;
  textLength: number;
  imageCount: number;
  isRunning: boolean;
}) {
  const parts: string[] = [];
  if (textLength > 0) {
    parts.push(bi(`${textLength.toLocaleString()} 字回显`, `${textLength.toLocaleString()} chars`));
  }
  if (imageCount > 0) {
    parts.push(bi(`${imageCount} 张截图`, `${imageCount} image(s)`));
  }
  return (
    <div className={`imp-parse-focus-bar ${collapsed ? "is-collapsed" : "is-open"}`}>
      <div className="imp-parse-focus-l">
        <span className={`imp-parse-focus-dot ${isRunning ? "is-live" : ""}`} aria-hidden />
        <span className="imp-parse-focus-title">
          {collapsed
            ? includesProbe
              ? bi("探针脚本与现场回显输入已收起", "Probe script & input folded")
              : bi("现场回显录入区已收起", "Input composer folded")
            : includesProbe
              ? bi("已展开探针脚本与现场回显输入", "Probe script & input expanded")
              : bi("已展开现场回显录入区", "Input composer expanded")}
        </span>
        {parts.length > 0 && (
          <span className="imp-parse-focus-meta num">{parts.join(" · ")}</span>
        )}
        <span className="imp-parse-focus-shield">
          <IconCheckCircle />
          <span>{bi("口令已脱敏", "Redacted")}</span>
        </span>
      </div>
      <button
        type="button"
        className="imp-parse-focus-btn"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        {collapsed ? <IconDown /> : <IconUp />}
        <span>
          {collapsed
            ? includesProbe
              ? bi("展开脚本与输入", "Expand Script & Input")
              : bi("展开查看输入", "Expand Input")
            : bi("收起聚焦解析", "Fold to Focus")}
        </span>
      </button>
    </div>
  );
}

const IMPORT_TEXT_EXT_RE = /\.(log|txt|out|json|ya?ml|conf|ini|cfg|csv|md|sh)$/i;

async function compressImportImageIfNeeded(file: File): Promise<string> {
  const rawUrl = await readFileAsDataURL(file);
  if (file.size <= 1.2 * 1024 * 1024 || file.type === "image/gif") {
    return rawUrl;
  }
  return await new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 2048;
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(rawUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/webp", 0.86));
    };
    img.onerror = () => resolve(rawUrl);
    img.src = rawUrl;
  });
}

function ImportEvidenceComposer({
  title,
  placeholder,
  value,
  onChange,
  images,
  onImagesChange,
  busy = false,
  aiEnabled = true,
  minRows = 7,
  maxRows = 18,
  submitLabel,
  onSubmit,
  leftSlot,
  imageBtnLabel,
  footHint,
  modelPick,
  aiOpts,
}: {
  title: React.ReactNode;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
  images: string[];
  onImagesChange: React.Dispatch<React.SetStateAction<string[]>>;
  busy?: boolean;
  aiEnabled?: boolean;
  minRows?: number;
  maxRows?: number;
  submitLabel: string;
  onSubmit: () => void;
  leftSlot?: React.ReactNode;
  imageBtnLabel?: string;
  footHint?: string;
  modelPick?: ReturnType<typeof useModelPick>;
  aiOpts?: ReturnType<typeof useAIOptions>;
}) {
  const [dragging, setDragging] = useState(false);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  const hasInput = Boolean(value.trim()) || images.length > 0;

  const ingestFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files) return;
      const list = Array.from(files);
      const addedTexts: string[] = [];
      let imgAdded = 0;

      for (const f of list) {
        if (f.type.startsWith("image/")) {
          if (f.size > 16 * 1024 * 1024) {
            Message.warning(bi(`${f.name} 超过 16MB，请裁剪后重试`, `${f.name} exceeds 16MB limit`));
            continue;
          }
          try {
            const dataUrl = await compressImportImageIfNeeded(f);
            onImagesChange((prev) => [...prev, dataUrl]);
            imgAdded += 1;
          } catch {
            // ignore
          }
        } else if (f.type.startsWith("text/") || IMPORT_TEXT_EXT_RE.test(f.name)) {
          if (f.size > 2 * 1024 * 1024) {
            Message.warning(bi(`${f.name} 超过 2MB，已跳过`, `${f.name} exceeds 2MB, skipped`));
            continue;
          }
          try {
            const txt = await f.text();
            if (txt.trim()) {
              addedTexts.push(`# file: ${f.name}\n${txt.trim()}`);
            }
          } catch {
            // ignore
          }
        } else {
          Message.warning(
            bi(`暂不支持的文件类型：${f.name}（请上传截图或 .log/.txt/.yml/.conf）`, `Unsupported file: ${f.name}`),
          );
        }
      }
      if (addedTexts.length > 0) {
        const prefix = value.trim() ? `${value.trimEnd()}\n\n` : "";
        onChange(prefix + addedTexts.join("\n\n"));
        Message.success(
          bi(`已导入 ${addedTexts.length} 份文本/日志文件`, `Imported ${addedTexts.length} text/log file(s)`),
        );
      } else if (imgAdded > 0) {
        Message.success(
          bi(`已添加 ${imgAdded} 张截图，解析时将自动识图`, `Added ${imgAdded} screenshot(s) for extraction`),
        );
      }
    },
    [images.length, onChange, onImagesChange, value],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imgs: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) imgs.push(f);
        }
      }
      if (imgs.length > 0) {
        if (!e.clipboardData?.getData("text/plain")) {
          e.preventDefault();
        }
        void ingestFiles(imgs);
      }
    },
    [ingestFiles],
  );

  return (
    <div
      className={`imp-compose-box ${dragging ? "is-drag" : ""} ${busy ? "is-busy" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer?.files?.length) {
          void ingestFiles(e.dataTransfer.files);
        }
      }}
      onPaste={handlePaste}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && hasInput && !busy) {
          e.preventDefault();
          onSubmit();
        }
      }}
    >
      <div className="imp-compose-head">
        <div className="imp-compose-head-left">
          <span className="imp-compose-title">{title}</span>
          <span className="imp-compose-safety">
            <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M10 2.5L4 5v4.6c0 3.8 2.5 6.9 6 7.9 3.5-1 6-4.1 6-7.9V5l-6-2.5z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
            </svg>
            <span>{bi("口令与密钥自动脱敏", "Auto-redacts secrets")}</span>
          </span>
        </div>
        <div className="imp-compose-tools">
          <input
            ref={imgInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              void ingestFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={textInputRef}
            type="file"
            accept=".log,.txt,.out,.json,.yml,.yaml,.conf,.ini,.cfg,.csv,.md"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              void ingestFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="imp-attach-btn"
            disabled={busy}
            onClick={() => imgInputRef.current?.click()}
          >
            <IconImage />
            <span>
              {imageBtnLabel || bi("上传截图", "Upload Image")}
              {images.length > 0 ? ` (${images.length})` : ""}
            </span>
          </button>
          <button
            type="button"
            className="imp-attach-btn"
            disabled={busy}
            onClick={() => textInputRef.current?.click()}
          >
            <IconUpload />
            <span>{bi("上传 .log / .txt", "Upload .log / .txt")}</span>
          </button>
          {Boolean(value.trim()) && (
            <button
              type="button"
              className="imp-inline-clear"
              disabled={busy}
              onClick={() => onChange("")}
            >
              {bi("清空", "Clear")}
            </button>
          )}
        </div>
      </div>

      <Input.TextArea
        className="mono imp-compose-area"
        autoSize={{ minRows, maxRows }}
        disabled={busy}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
      />

      {images.length > 0 && (
        <div className="imp-compose-imgs">
          {images.map((src, idx) => (
            <div key={idx} className="imp-img-thumb">
              <img src={src} alt={`capture-${idx + 1}`} />
              <button
                type="button"
                className="imp-img-del"
                aria-label={bi("删除截图", "Remove screenshot")}
                onClick={() => onImagesChange((prev) => prev.filter((_, i) => i !== idx))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="imp-compose-foot">
        <div className="imp-compose-foot-left">
          {leftSlot}
          <span className="imp-foot-note">
            {isMac ? bi("⌘ + Enter 提交识别", "⌘ + Enter Extract") : bi("Ctrl + Enter 提交识别", "Ctrl + Enter Extract")}
            {footHint ? ` · ${footHint}` : ""}
          </span>
        </div>
        <div className="imp-compose-foot-right">
          {aiEnabled && aiOpts && modelPick && (
            <ThinkLevel
              levels={modelPick.current?.effort}
              value={aiOpts.pref.think}
              onChange={(v) => aiOpts.update({ think: v })}
              compact
            />
          )}
          {aiEnabled && modelPick && <ModelPicker pick={modelPick} compact />}
          <Button
            type="primary"
            shape="round"
            className={`ai-pill ${hasInput ? "ai-pill-primary" : ""}`}
            icon={aiEnabled ? <Spark size={14} rainbow={!hasInput} /> : <IconRight />}
            loading={busy}
            disabled={!hasInput || busy}
            onClick={onSubmit}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function RuntimePathListCard({
  title,
  items,
  onChange,
  placeholder,
  kind,
  twoCol = false,
}: {
  title: string;
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  kind: "service" | "file" | "dir";
  twoCol?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const parts = draft
      .split(/[\r\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    onChange(normalizeTagList([...items, ...parts]));
    setDraft("");
  };
  const removeAt = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx));
  };

  if (kind === "service") {
    return (
      <div className="imp-rpath-card is-service">
        <div className="imp-rpath-head">
          <span className="imp-rpath-title">{title}</span>
          <span className="imp-rpath-count num">{items.length}</span>
        </div>
        <div className="imp-rpath-chips">
          {items.map((sv, idx) => (
            <span key={`${sv}-${idx}`} className="imp-rpath-svc-chip mono">
              <span>{sv}</span>
              <button
                type="button"
                aria-label={bi(`移除 ${sv}`, `Remove ${sv}`)}
                onClick={() => removeAt(idx)}
              >
                <IconClose />
              </button>
            </span>
          ))}
          <div className="imp-rpath-inline-add">
            <Input
              size="mini"
              className="mono"
              value={draft}
              placeholder={placeholder}
              onChange={setDraft}
              onPressEnter={commit}
              onBlur={commit}
            />
            <button
              type="button"
              className="imp-rpath-add-btn"
              disabled={!draft.trim()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={commit}
              aria-label={bi("添加服务单元", "Add service unit")}
            >
              <IconPlus />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="imp-rpath-card">
      <div className="imp-rpath-head">
        <span className="imp-rpath-title">{title}</span>
        <span className="imp-rpath-count num">{items.length}</span>
      </div>
      {items.length > 0 && (
        <div className={`imp-rpath-rows ${twoCol ? "is-two-col" : ""}`}>
          {items.map((p, idx) => (
            <div key={`${p}-${idx}`} className="imp-rpath-row">
              <span className="imp-rpath-ic" aria-hidden>
                {kind === "file" ? <IconFile /> : <IconFolder />}
              </span>
              <Tooltip content={p} mini>
                <span className="imp-rpath-val mono">{p}</span>
              </Tooltip>
              <button
                type="button"
                className="imp-rpath-del"
                aria-label={bi(`移除 ${p}`, `Remove ${p}`)}
                onClick={() => removeAt(idx)}
              >
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="imp-rpath-foot-add">
        <Input
          size="small"
          className="mono"
          value={draft}
          placeholder={placeholder}
          onChange={setDraft}
          onPressEnter={commit}
        />
        <Button size="small" icon={<IconPlus />} disabled={!draft.trim()} onClick={commit}>
          {bi("添加", "Add")}
        </Button>
      </div>
    </div>
  );
}

function RuntimePathsEditor({
  serviceUnits,
  onServiceUnitsChange,
  configPaths,
  onConfigPathsChange,
  dataDirs,
  onDataDirsChange,
  logDirs,
  onLogDirsChange,
  servicePlaceholder,
  configPlaceholder,
  dataPlaceholder,
  logPlaceholder,
}: {
  serviceUnits: string[];
  onServiceUnitsChange: (v: string[]) => void;
  configPaths: string[];
  onConfigPathsChange: (v: string[]) => void;
  dataDirs: string[];
  onDataDirsChange: (v: string[]) => void;
  logDirs: string[];
  onLogDirsChange: (v: string[]) => void;
  servicePlaceholder?: string;
  configPlaceholder?: string;
  dataPlaceholder?: string;
  logPlaceholder?: string;
}) {
  return (
    <div className="imp-rpath-grid">
      <RuntimePathListCard
        title={bi("系统服务单元", "Service Units")}
        items={serviceUnits}
        onChange={onServiceUnitsChange}
        placeholder={servicePlaceholder || "patroni.service"}
        kind="service"
      />
      <RuntimePathListCard
        title={bi("配置文件路径", "Config Paths")}
        items={configPaths}
        onChange={onConfigPathsChange}
        placeholder={configPlaceholder || "/etc/patroni/patroni.yml"}
        kind="file"
        twoCol
      />
      <div className="imp-rpath-dirs">
        <RuntimePathListCard
          title={bi("数据目录", "Data Directories")}
          items={dataDirs}
          onChange={onDataDirsChange}
          placeholder={dataPlaceholder || "/data/pg"}
          kind="dir"
        />
        <RuntimePathListCard
          title={bi("日志目录", "Log Directories")}
          items={logDirs}
          onChange={onLogDirsChange}
          placeholder={logPlaceholder || "/var/log/postgresql"}
          kind="dir"
        />
      </div>
    </div>
  );
}

const COMPANION_GENERAL_ICONS = [
  "balance",
  "vip",
  "gateway",
  "cloud",
  "storage",
  "database",
  "cache",
  "queue",
  "monitor",
  "cluster",
  "server",
  "network",
  "key",
  "file",
];

const COMPANION_BRAND_ICONS = [
  "haproxy",
  "keepalived",
  "nginx",
  "elb",
  "envoy",
  "traefik",
  "patroni",
  "etcd",
  "zookeeper",
  "consul",
  "prometheus",
  "grafana",
  "zabbix",
  "docker",
  "kubernetes",
  "minio",
];

const COMPANION_QUICK_ICONS = [
  "balance",
  "vip",
  "elb",
  "haproxy",
  "nginx",
  "keepalived",
  "storage",
  "monitor",
  "cloud",
  "server",
];

function defaultGlyphForCompanionKind(kind: string): { icon: string; color: string } {
  switch (kind) {
    case "proxy":
      return { icon: "balance", color: "blue" };
    case "vip":
      return { icon: "vip", color: "teal" };
    case "ha_manager":
      return { icon: "cluster", color: "indigo" };
    case "dcs":
      return { icon: "kv", color: "blue" };
    case "pooler":
      return { icon: "network", color: "indigo" };
    case "backup":
      return { icon: "storage", color: "green" };
    case "monitoring":
      return { icon: "monitor", color: "coral" };
    case "os_component":
      return { icon: "server", color: "slate" };
    default:
      return { icon: "cloud", color: "blue" };
  }
}

function CompanionIconPicker({
  icon,
  color,
  onSelect,
  children,
}: {
  icon: string;
  color: string;
  onSelect: (next: { icon: string; color: string }) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const brandSelected = isBrandIcon(icon);
  return (
    <Popover
      trigger="click"
      position="bl"
      popupVisible={open}
      onVisibleChange={setOpen}
      content={
        <div className="imp-icon-pop">
          <div className="imp-icon-pop-sec">
            <span className="imp-icon-pop-lbl">{bi("通用架构图标", "General Icons")}</span>
            <div className="imp-icon-pop-grid">
              {COMPANION_GENERAL_ICONS.map((ic) => (
                <button
                  key={ic}
                  type="button"
                  className={`imp-icon-pop-btn ${icon === ic ? "on" : ""}`}
                  title={ic}
                  onClick={() => onSelect({ icon: ic, color })}
                >
                  <AppGlyph id={`pick-${ic}`} icon={ic} color={color} size={24} />
                </button>
              ))}
            </div>
          </div>
          <div className="imp-icon-pop-sec">
            <span className="imp-icon-pop-lbl">{bi("常见品牌 / 组件图标", "Brand & Component Logos")}</span>
            <div className="imp-icon-pop-grid">
              {COMPANION_BRAND_ICONS.map((ic) => (
                <button
                  key={ic}
                  type="button"
                  className={`imp-icon-pop-btn ${icon === ic ? "on" : ""}`}
                  title={ic}
                  onClick={() => {
                    onSelect({ icon: ic, color });
                    setOpen(false);
                  }}
                >
                  <AppGlyph id={`pick-${ic}`} icon={ic} color={color} size={24} />
                </button>
              ))}
            </div>
          </div>
          {!brandSelected && (
            <div className="imp-icon-pop-sec">
              <span className="imp-icon-pop-lbl">{bi("图标配色", "Tile Color")}</span>
              <div className="imp-color-swatches">
                {COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`imp-color-swatch ${color === c.id ? "on" : ""}`}
                    style={{ background: `linear-gradient(180deg, ${c.tile[0]}, ${c.tile[1]})` }}
                    title={c.label}
                    onClick={() => onSelect({ icon, color: c.id })}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      }
    >
      {children}
    </Popover>
  );
}

type EndpointPreset = {
  value: string;
  label: string;
  group: "lb" | "direct";
  defaultRole: "readwrite" | "readonly" | "admin";
  short?: string;
};

function getEndpointPresets(): EndpointPreset[] {
  return [
    { value: "vip", label: bi("VIP 虚拟 IP（Keepalived）", "Virtual IP (VIP)"), group: "lb", defaultRole: "readwrite", short: "VIP" },
    { value: "eip", label: bi("EIP 弹性公网 IP", "Elastic IP (EIP)"), group: "lb", defaultRole: "readwrite", short: "EIP" },
    { value: "f5", label: bi("F5 负载均衡", "F5 Load Balancer"), group: "lb", defaultRole: "readwrite", short: "F5" },
    { value: "elb", label: bi("ELB 云负载均衡", "Cloud ELB"), group: "lb", defaultRole: "readwrite", short: "ELB" },
    { value: "slb", label: bi("SLB 云负载均衡", "Cloud SLB"), group: "lb", defaultRole: "readwrite", short: "SLB" },
    { value: "lvs", label: bi("LVS 四层均衡", "LVS L4 LB"), group: "lb", defaultRole: "readwrite", short: "LVS" },
    { value: "haproxy", label: bi("HAProxy 代理入口", "HAProxy Proxy"), group: "lb", defaultRole: "readwrite", short: "HAProxy" },
    { value: "nginx", label: bi("Nginx 代理入口", "Nginx Proxy"), group: "lb", defaultRole: "readwrite", short: "Nginx" },
    { value: "pooler", label: bi("连接池入口（PgBouncer）", "Connection Pooler"), group: "lb", defaultRole: "readwrite", short: bi("连接池", "Pooler") },
    { value: "dns", label: bi("DNS 域名入口", "DNS Endpoint"), group: "lb", defaultRole: "readwrite", short: "DNS" },
    { value: "writer", label: bi("主库读写入口", "Primary Read/Write"), group: "direct", defaultRole: "readwrite", short: bi("主库读写", "Primary") },
    { value: "reader", label: bi("从库只读入口", "Replica Read-Only"), group: "direct", defaultRole: "readonly", short: bi("从库只读", "Replica") },
    { value: "admin", label: bi("管理 / 控制台入口", "Admin / Console"), group: "direct", defaultRole: "admin", short: bi("管理入口", "Admin") },
    { value: "metrics", label: bi("监控指标入口", "Metrics Endpoint"), group: "direct", defaultRole: "admin", short: bi("监控指标", "Metrics") },
  ];
}

function EndpointListEditor({
  endpoints,
  defaultPort,
  onChange,
}: {
  endpoints: ImportedEndpoint[];
  defaultPort?: number;
  onChange: (next: ImportedEndpoint[]) => void;
}) {
  useLang();
  const presets = getEndpointPresets();
  const presetByVal = new Map(presets.map((p) => [p.value, p]));
  const lbPresets = presets.filter((p) => p.group === "lb");
  const directPresets = presets.filter((p) => p.group === "direct");
  const quickAdds = ["vip", "eip", "f5", "elb", "writer", "reader"];

  const addPreset = (val: string) => {
    const p = presetByVal.get(val);
    onChange([
      ...endpoints,
      { name: val, address: "", role: p?.defaultRole || "readwrite" },
    ]);
  };

  return (
    <div className="imp-ep-editor">
      {endpoints.length > 0 && (
        <div className="imp-table-rows">
          <div className="imp-ep-row imp-col-heads">
            <span>{bi("入口类型 / 名称（可选或自填）", "Entry Type / Name")}</span>
            <span>{bi("访问地址 : 端口", "Address : Port")}</span>
            <span>{bi("入口用途", "Role")}</span>
            <span />
          </div>
          {endpoints.map((ep, idx) => {
            const rawName = (ep.name || "").trim();
            const hasInPresets = presetByVal.has(rawName);
            return (
              <div key={idx} className="imp-ep-row">
                <Select
                  allowCreate
                  showSearch
                  allowClear
                  value={rawName || undefined}
                  placeholder={bi("选择 VIP / EIP / F5 或自填…", "Pick VIP / EIP / F5 or type…")}
                  onChange={(v) => {
                    const nextVal = String(v || "").trim();
                    const matched = presetByVal.get(nextVal.toLowerCase());
                    onChange(
                      endpoints.map((r, i) =>
                        i === idx
                          ? {
                              ...r,
                              name: nextVal,
                              role: matched ? matched.defaultRole : r.role,
                            }
                          : r,
                      ),
                    );
                  }}
                >
                  {rawName && !hasInPresets && (
                    <Select.Option value={rawName}>{rawName}</Select.Option>
                  )}
                  <Select.OptGroup label={bi("外部 / 负载均衡入口", "External & Load Balancers")}>
                    {lbPresets.map((p) => (
                      <Select.Option key={p.value} value={p.value}>
                        {p.label}
                      </Select.Option>
                    ))}
                  </Select.OptGroup>
                  <Select.OptGroup label={bi("节点直连 / 管理用途", "Direct & Management")}>
                    {directPresets.map((p) => (
                      <Select.Option key={p.value} value={p.value}>
                        {p.label}
                      </Select.Option>
                    ))}
                  </Select.OptGroup>
                </Select>
                <Input
                  className="mono"
                  placeholder={`10.0.1.100:${defaultPort || 5432}`}
                  value={ep.address}
                  onChange={(v) =>
                    onChange(endpoints.map((r, i) => (i === idx ? { ...r, address: v } : r)))
                  }
                />
                <Select
                  value={normalizeEndpointRole(ep.role)}
                  onChange={(v) =>
                    onChange(endpoints.map((r, i) => (i === idx ? { ...r, role: v } : r)))
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
                  onClick={() => onChange(endpoints.filter((_, i) => i !== idx))}
                />
              </div>
            );
          })}
        </div>
      )}

      <div className="imp-quick-add">
        <span className="imp-quick-add-lbl">{bi("快捷添加入口：", "Quick add:")}</span>
        <div className="imp-quick-add-pills">
          {quickAdds.map((id) => {
            const p = presetByVal.get(id)!;
            return (
              <button
                key={id}
                type="button"
                className="imp-quick-chip"
                onClick={() => addPreset(id)}
              >
                <IconPlus style={{ fontSize: 10 }} />
                {p.short || p.label}
              </button>
            );
          })}
        </div>
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
  const [customKind, setCustomKind] = useState("proxy");
  const [customIcon, setCustomIcon] = useState("balance");
  const [customColor, setCustomColor] = useState("blue");
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

  const handleCustomKindChange = (nextKind: string) => {
    setCustomKind(nextKind);
    const defGlyph = defaultGlyphForCompanionKind(nextKind);
    setCustomIcon(defGlyph.icon);
    setCustomColor(defGlyph.color);
  };

  const addCatalogCompanion = (id: string) => {
    const def = catalogByID.get(id);
    if (!def || activeIDs.has(id)) return;
    const ports = (def.default_ports || []).map((p) => p.port).filter((p) => p > 0);
    const nextItem: ImportedCompanion = {
      component: def.id,
      display_name: def.name,
      icon: def.icon,
      color: def.color,
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
    if (!name) {
      Message.warning(bi("请填写伴生组件名称", "Please enter a component name"));
      return;
    }
    const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || `comp-${Date.now()}`;
    if (activeIDs.has(id)) {
      Message.warning(bi("该伴生组件已存在", "Companion already added"));
      return;
    }
    const ports = customPort
      .split(/[,，\s]+/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= 65535);
    onChange([
      ...companions,
      {
        component: id,
        display_name: name,
        icon: customIcon,
        color: customColor,
        kind: customKind,
        role: "node",
        hosts: validHostNames,
        ports,
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
              <span className="imp-stack-hosts">{bi(`${validHostNames.length} 台节点`, `${validHostNames.length} host(s)`)}</span>
            </div>
          </div>
          <span className="small muted imp-stack-core-lbl">{bi("核心组件", "Core")}</span>
        </div>

        {/* Companion component rows */}
        {companions.map((cm, idx) => {
          const def = catalogByID.get(cm.component);
          const effKind = effectiveCompanionKind(cm.component, cm.kind);
          const km = companionKindMeta(effKind);
          const fallbackGlyph = defaultGlyphForCompanionKind(effKind);
          const curIcon = cm.icon || def?.icon || companionIcon(cm.component) || fallbackGlyph.icon;
          const curColor = cm.color || (def?.color === "emerald" ? "green" : def?.color) || fallbackGlyph.color;
          const hostCount = cm.placement
            ? new Set(Object.values(cm.placement).flat()).size
            : cm.hosts?.length || validHostNames.length;
          return (
            <div key={`${cm.component}-${idx}`} className="imp-stack-item">
              <CompanionIconPicker
                icon={curIcon}
                color={curColor}
                onSelect={({ icon: nextIc, color: nextCol }) =>
                  onChange(
                    companions.map((item, i) =>
                      i === idx ? { ...item, icon: nextIc, color: nextCol } : item,
                    ),
                  )
                }
              >
                <button
                  type="button"
                  className="imp-stack-icon-btn"
                  title={bi("点击更换图标与配色", "Click to customize icon & color")}
                >
                  <AppGlyph id={cm.component} icon={curIcon} color={curColor} size={30} />
                </button>
              </CompanionIconPicker>
              <div className="imp-stack-main">
                <div className="imp-stack-top">
                  <strong>{canonicalCompanionTitle(cm.component, cm.display_name || def?.name)}</strong>
                  <span className={`imp-kind-pill ${km.tone}`}>{km.label}</span>
                  {cm.ports && cm.ports.length > 0 && (
                    <span className="mono small muted imp-stack-ports">:{cm.ports.join(", :")}</span>
                  )}
                </div>
                <div className="imp-stack-meta">
                  <span className="imp-stack-hosts">{bi(`${hostCount} 台节点`, `${hostCount} host(s)`)}</span>
                  {validHostNames.length > 1 && hostCount < validHostNames.length && effKind !== "backup" && effKind !== "monitoring" && effKind !== "os_component" && (
                    <button
                      type="button"
                      className="cl-imp-notes-toggle"
                      style={{ flexShrink: 0 }}
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
                  {cm.evidence && (
                    <>
                      <span className="imp-meta-sep" aria-hidden>·</span>
                      <span className="imp-stack-ev" title={cm.evidence}>
                        {cm.evidence}
                      </span>
                    </>
                  )}
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
            className={`imp-quick-chip ${customOpen ? "is-open" : ""}`}
            onClick={() => setCustomOpen((v) => !v)}
          >
            <IconPlus style={{ fontSize: 10 }} />
            {bi("其他组件", "Custom")}
          </button>
        </div>
      </div>

      {customOpen && (
        <div className="imp-custom-comp-box">
          <div className="imp-custom-comp-grid">
            <CompanionIconPicker
              icon={customIcon}
              color={customColor}
              onSelect={({ icon: ic, color: col }) => {
                setCustomIcon(ic);
                setCustomColor(col);
              }}
            >
              <button
                type="button"
                className="imp-custom-icon-trigger"
                title={bi("点击选择图标与配色", "Choose icon & color")}
              >
                <AppGlyph id="custom-preview" icon={customIcon} color={customColor} size={32} />
              </button>
            </CompanionIconPicker>
            <Input
              placeholder={bi("组件名，如 F5 / Keepalived / Zabbix", "Name, e.g. F5 / Keepalived / Zabbix")}
              value={customName}
              onChange={setCustomName}
              onPressEnter={addCustomCompanion}
            />
            <Select value={customKind} onChange={handleCustomKindChange}>
              <Select.Option value="proxy">{bi("代理 / 均衡", "Proxy / LB")}</Select.Option>
              <Select.Option value="vip">{bi("虚拟 IP / VIP", "VIP / VRRP")}</Select.Option>
              <Select.Option value="ha_manager">{bi("高可用管理", "HA Manager")}</Select.Option>
              <Select.Option value="dcs">{bi("分布式协调 DCS", "DCS / Quorum")}</Select.Option>
              <Select.Option value="pooler">{bi("连接池", "Pooler")}</Select.Option>
              <Select.Option value="backup">{bi("备份工具", "Backup")}</Select.Option>
              <Select.Option value="monitoring">{bi("监控采集", "Monitoring")}</Select.Option>
              <Select.Option value="os_component">{bi("OS 组件", "OS Component")}</Select.Option>
              <Select.Option value="companion">{bi("其他伴生组件", "Companion")}</Select.Option>
            </Select>
            <Input
              className="mono"
              placeholder={bi("端口(选填)", "Port")}
              value={customPort}
              onChange={setCustomPort}
              onPressEnter={addCustomCompanion}
            />
          </div>

          <div className="imp-custom-comp-foot">
            <div className="imp-custom-icon-strip">
              <span className="imp-custom-icon-lbl">{bi("图标：", "Icon:")}</span>
              {COMPANION_QUICK_ICONS.map((ic) => (
                <button
                  key={ic}
                  type="button"
                  className={`imp-icon-pop-btn ${customIcon === ic ? "on" : ""}`}
                  title={ic}
                  onClick={() => setCustomIcon(ic)}
                >
                  <AppGlyph id={`q-${ic}`} icon={ic} color={customColor} size={22} />
                </button>
              ))}
              <CompanionIconPicker
                icon={customIcon}
                color={customColor}
                onSelect={({ icon: ic, color: col }) => {
                  setCustomIcon(ic);
                  setCustomColor(col);
                }}
              >
                <button type="button" className="imp-icon-more-btn">
                  {bi("更多 / 配色", "More")}
                </button>
              </CompanionIconPicker>
            </div>
            <div className="imp-custom-comp-acts">
              <Button size="small" onClick={() => setCustomOpen(false)}>
                {bi("取消", "Cancel")}
              </Button>
              <Button size="small" type="primary" icon={<IconPlus />} onClick={addCustomCompanion}>
                {bi("添加组件", "Add Component")}
              </Button>
            </div>
          </div>
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
  const [maxStepReached, setMaxStepReached] = useState<1 | 2 | 3>(1);
  const [reviewTraceOpen, setReviewTraceOpen] = useState(false);
  const [reviewDetailsOpen, setReviewDetailsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");

  const goStep = useCallback((next: 1 | 2 | 3) => {
    setStep(next);
    setMaxStepReached((prev) => (next > prev ? next : prev));
  }, []);

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
  const [probeSource, setProbeSource] = useState<"template" | "ai">("template");
  const [probeGenerating, setProbeGenerating] = useState(false);
  const [probeLive, setProbeLive] = useState<LiveAIState<ImportLiveKind> | null>(null);
  const [probeTrace, setProbeTrace] = useState<RehearsalTrace | null>(null);
  const [lastProbeFocus, setLastProbeFocus] = useState("");
  const probeAbortRef = useRef<AbortController | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);
  const [parseLive, setParseLive] = useState<LiveAIState<ImportLiveKind> | null>(null);
  const [parseTrace, setParseTrace] = useState<RehearsalTrace | null>(null);
  const [parseInputsCollapsed, setParseInputsCollapsed] = useState(false);
  const parseAbortRef = useRef<AbortController | null>(null);
  const [parseInfo, setParseInfo] = useState<{ parser: string; warnings: string[]; missing: string[]; companionCount: number } | null>(null);

  useEffect(() => {
    return () => {
      probeAbortRef.current?.abort();
      parseAbortRef.current?.abort();
    };
  }, []);

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

  const wizardModelPick = useModelPick("assistant");
  const wizardAIOpts = useAIOptions();

  const fetchImportProbe = useCallback(
    async (opts?: { useAI?: boolean; focus?: string }) => {
      type ProbeResp = {
        script: string;
        filename: string;
        safe: boolean;
        source?: "template" | "ai";
        ai_note?: string;
        trace?: RehearsalTrace;
      };
      const payload = {
        component: effectiveCompID,
        display_name: effectiveDisplayName,
        deploy_method: deployMethod,
        use_ai: Boolean(opts?.useAI),
        focus: opts?.focus?.trim() || undefined,
        model: wizardModelPick.ref || undefined,
        think: wizardAIOpts.pref.think || undefined,
      };
      if (!opts?.useAI) {
        try {
          const res = await api<ProbeResp>("/api/clusters/import/probe-script", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          setProbeScript(res.script);
          setProbeFilename(res.filename);
          setProbeSafe(res.safe);
          setProbeSource(res.source === "ai" ? "ai" : "template");
          setProbeLive(null);
          setProbeTrace(null);
        } catch {
          /* ignore silent template refresh failure */
        }
        return;
      }

      probeAbortRef.current?.abort();
      const ac = new AbortController();
      probeAbortRef.current = ac;
      setLastProbeFocus(opts.focus || "");
      setProbeGenerating(true);
      const modelHint = wizardModelPick.current?.model || wizardModelPick.ref?.split("|")[1];
      setProbeLive(
        buildImportInitialLive(
          "import-probe",
          bi("AI 正在定制 100% 只读采集探针", "AI Tailoring 100% Read-Only Probe"),
          modelHint
            ? { model: modelHint, provider: wizardModelPick.current?.provider }
            : undefined,
        ),
      );
      try {
        const res = await streamPipelineSSE<ProbeResp, ImportLiveKind>(
          "/api/clusters/import/probe-script",
          payload,
          (updater) => setProbeLive((prev) => (prev ? updater(prev) : prev)),
          ac.signal,
        );
        if (ac.signal.aborted) return;
        setProbeScript(res.script);
        setProbeFilename(res.filename);
        setProbeSafe(res.safe);
        setProbeSource(res.source === "ai" ? "ai" : "template");
        setProbeTrace(res.trace || null);
        setProbeLive(null);
        if (res.source === "ai") {
          Message.success(bi("AI 已按现场特点定制精炼只读探针（已通过安全扫描）", "AI tailored a concise read-only probe (verified safe)"));
        } else if (res.ai_note) {
          Message.warning(res.ai_note);
        }
      } catch (e) {
        if (ac.signal.aborted || (e as Error)?.name === "AbortError") {
          setProbeLive(null);
          return;
        }
        setProbeLive((prev) => (prev ? markLiveStateError(prev, e) : prev));
      } finally {
        if (probeAbortRef.current === ac) {
          probeAbortRef.current = null;
        }
        setProbeGenerating(false);
      }
    },
    [effectiveCompID, effectiveDisplayName, deployMethod, wizardModelPick.ref, wizardAIOpts.pref.think],
  );

  // Fetch read-only probe script when entering Step 2 in probe mode
  useEffect(() => {
    if (step !== 2 || inputMode !== "probe") return;
    void fetchImportProbe();
  }, [step, inputMode, fetchImportProbe]);

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

  const selectPreset = useCallback(
    (item: ImportPresetItem) => {
      if (!isCustom && selectedPreset?.id === item.id) {
        return;
      }
      setIsCustom(false);
      setSelectedPreset(item);
      setVersion((cur) => (cur.trim() ? cur : item.versions?.[0] || ""));
      if (!parseInfo) {
        setExactVersion("");
      }
      if (item.roles?.length) {
        setHosts((prev) => {
          const hasPopulatedHosts = prev.some((h) => h.ip.trim().length > 0);
          if (hasPopulatedHosts) return prev;
          return prev.map((h, i) => ({
            ...h,
            role: item.roles[Math.min(i, item.roles.length - 1)]?.id || item.roles[0].id,
          }));
        });
      }
    },
    [isCustom, parseInfo, selectedPreset?.id],
  );

  const handlePlatformChange = useCallback((v: string) => setPlatform(v), []);
  const handleDeployMethodChange = useCallback((v: string) => setDeployMethod(v), []);
  const platformsList = presetsData?.platforms ?? EMPTY_PLATFORMS;

  const canProceedStep1 =
    CLUSTER_ID_RE.test(clusterId.trim()) &&
    (isCustom ? customName.trim().length > 0 : selectedPreset !== null);

  const validHosts = useMemo(() => hosts.filter((h) => h.name.trim() || h.ip.trim()), [hosts]);

  const runParseAndProceed = async (opts?: { useAI?: boolean }) => {
    if (parsing) return;
    if (!pasteText.trim() && images.length === 0) {
      Message.warning(bi("请先粘贴采集脚本输出或文档文本，或上传截图", "Paste probe output / text or upload screenshots first"));
      return;
    }
    const useAI = opts?.useAI ?? Boolean(presetsData?.ai_enabled);
    parseAbortRef.current?.abort();
    const ac = new AbortController();
    parseAbortRef.current = ac;
    setParsing(true);
    const modelHint = wizardModelPick.current?.model || wizardModelPick.ref?.split("|")[1];
    if (useAI) {
      setParseInputsCollapsed(true);
      setParseLive(
        buildImportInitialLive(
          "import-parse",
          bi("AI 正在解析现场回显与多组件架构", "AI Parsing Evidence & Multi-Component Stack"),
          modelHint
            ? { model: modelHint, provider: wizardModelPick.current?.provider }
            : undefined,
        ),
      );
    } else {
      setParseInputsCollapsed(false);
      setParseLive(null);
    }
    try {
      const payload = {
        component: effectiveCompID,
        display_name: effectiveDisplayName,
        source_kind: inputMode === "probe" ? "probe" : "ai_doc",
        text: pasteText,
        images,
        use_ai: useAI,
        model: wizardModelPick.ref || undefined,
        think: wizardAIOpts.pref.think || undefined,
      };
      const res = useAI
        ? await streamPipelineSSE<ParseResp, ImportLiveKind>(
            "/api/clusters/import/parse",
            payload,
            (updater) => setParseLive((prev) => (prev ? updater(prev) : prev)),
            ac.signal,
          )
        : await api<ParseResp>("/api/clusters/import/parse", {
            method: "POST",
            body: JSON.stringify(payload),
            signal: ac.signal,
          });
      if (ac.signal.aborted) return;
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

      setParseLive(null);
      setParseInputsCollapsed(false);
      setParseTrace(res.trace || null);
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
      setReviewTraceOpen(false);
      setReviewDetailsOpen(false);
      goStep(3);
    } catch (e) {
      if (ac.signal.aborted || (e as Error)?.name === "AbortError") {
        setParseLive(null);
        setParseInputsCollapsed(false);
        return;
      }
      if (useAI) {
        setParseLive((prev) => (prev ? markLiveStateError(prev, e) : prev));
      } else {
        Message.error((e as Error).message || bi("解析失败", "Parse failed"));
      }
    } finally {
      if (parseAbortRef.current === ac) {
        parseAbortRef.current = null;
      }
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
  const hasReviewDraft = maxStepReached >= 3 || Boolean(parseInfo);

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
            ].map((st, i) => {
              const unlocked =
                !parsing &&
                (st.n === 1 ||
                  (st.n === 2 && canProceedStep1) ||
                  (st.n === 3 && canProceedStep1 && (hasReviewDraft || step === 3)));
              const isDone =
                st.n !== step &&
                (st.n < step || (st.n === 3 && hasReviewDraft && canProceedStep1) || (st.n === 2 && maxStepReached >= 2 && canProceedStep1));
              return (
                <React.Fragment key={st.n}>
                  {i > 0 && <IconRight className="imp-step-sep" aria-hidden="true" />}
                  <button
                    type="button"
                    className={`imp-step-btn ${step === st.n ? "is-active" : isDone ? "is-done" : ""}`}
                    disabled={!unlocked}
                    onClick={() => {
                      if (unlocked) goStep(st.n);
                    }}
                  >
                    <span className="imp-step-num">
                      {isDone ? <IconCheck /> : st.n}
                    </span>
                    <span>{st.label}</span>
                  </button>
                </React.Fragment>
              );
            })}
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
                  onClick={() => goStep(2)}
                >
                  {bi("下一步：采集与识别节点", "Next: Capture & Recognize")} <IconRight />
                </Button>
                {hasReviewDraft && canProceedStep1 && (
                  <Button
                    long
                    size="default"
                    type="secondary"
                    onClick={() => goStep(3)}
                  >
                    {bi(
                      `直接返回第 3 步核对草稿（${validHosts.length} 台节点）`,
                      `Return to Step 3 Review (${validHosts.length} hosts)`,
                    )}{" "}
                    <IconRight />
                  </Button>
                )}
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
        {step === 2 && (() => {
          const focusParseView =
            (inputMode === "probe" || inputMode === "ai_doc") &&
            Boolean(parseLive) &&
            parseInputsCollapsed;
          return (
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
              <div className="imp-ctx-right">
                {hasReviewDraft && !parsing && (
                  <Button
                    size="mini"
                    type="secondary"
                    className="imp-draft-return-btn"
                    onClick={() => goStep(3)}
                  >
                    <IconCheckCircle />
                    <span>
                      {bi(
                        `已保留草稿（${validHosts.length} 节点）· 返回第 3 步`,
                        `Draft Kept (${validHosts.length} hosts) · Step 3`,
                      )}
                    </span>
                    <IconRight />
                  </Button>
                )}
                <Button size="mini" type="text" disabled={parsing} onClick={() => goStep(1)}>
                  <IconEdit /> {bi("修改中间件或标识", "Change Middleware / ID")}
                </Button>
              </div>
            </div>

            {!focusParseView && (
              <>
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
                    disabled={parsing}
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
                    disabled={parsing}
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
                    disabled={parsing}
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
              </>
            )}

            {(inputMode === "probe" || inputMode === "ai_doc") && parseLive && (
              <ImportParseFocusBar
                collapsed={parseInputsCollapsed}
                onToggle={() => setParseInputsCollapsed((v) => !v)}
                includesProbe={inputMode === "probe"}
                textLength={pasteText.trim().length}
                imageCount={images.length}
                isRunning={parsing}
              />
            )}

            {inputMode === "probe" && !focusParseView && (
              <>
                {(probeLive || probeTrace) && (
                  <AIProcessCard
                    live={probeLive}
                    trace={probeLive ? null : probeTrace}
                    title={bi("AI 定制只读探针推演记录", "AI Read-Only Probe Generation Trace")}
                    onAbort={() => {
                      probeAbortRef.current?.abort();
                      setProbeLive(null);
                      setProbeGenerating(false);
                    }}
                    onRetry={() => void fetchImportProbe({ useAI: true, focus: lastProbeFocus })}
                    onDismiss={() => setProbeLive(null)}
                  />
                )}

                <ProbeCodeBlock
                  script={probeScript}
                  filename={probeFilename}
                  componentId={effectiveCompID}
                  componentName={effectiveDisplayName}
                  deployMethod={deployMethod}
                  safe={probeSafe}
                  source={probeSource}
                  aiEnabled={Boolean(presetsData?.ai_enabled)}
                  aiBusy={probeGenerating}
                  onCustomizeWithAI={(focus) => fetchImportProbe({ useAI: true, focus })}
                  onResetTemplate={() => void fetchImportProbe()}
                />

                <ImportEvidenceComposer
                  title={
                    <>
                      {bi("执行 ", "Run ")}
                      <code>bash {probeFilename}</code>
                      {bi(" 后的终端回显 / 截图", " output & screenshots")}
                    </>
                  }
                  placeholder={bi(
                    "=== MW_IMPORT_BEGIN ===\nHOSTNAME=...\n直接粘贴终端回显、拖拽 .log/.txt 文件，或按 Ctrl+V 粘贴堡垒机/终端截图（多台节点输出可直接拼接）…",
                    "=== MW_IMPORT_BEGIN ===\nHOSTNAME=...\nPaste terminal output, drag & drop .log/.txt files, or Ctrl+V screenshots (multi-node outputs can be concatenated)…",
                  )}
                  value={pasteText}
                  onChange={setPasteText}
                  images={images}
                  onImagesChange={setImages}
                  busy={parsing}
                  aiEnabled={Boolean(presetsData?.ai_enabled)}
                  modelPick={wizardModelPick}
                  aiOpts={wizardAIOpts}
                  imageBtnLabel={bi("上传终端截图", "Upload Screenshot")}
                  footHint={bi("支持拖拽 .log/.txt/截图 · 自动识别伴生与 OS 组件", "Drag & drop .log/.txt/images · Auto-detects companions & OS agents")}
                  leftSlot={
                    <Button size="small" type="text" onClick={() => setStep(1)} disabled={parsing}>
                      <IconArrowLeft /> {bi("上一步", "Back")}
                    </Button>
                  }
                  submitLabel={
                    presetsData?.ai_enabled
                      ? bi("AI 智能识别并核对拓扑", "Extract & Review Topology")
                      : bi("规则引擎解析并核对拓扑", "Parse & Review Topology")
                  }
                  onSubmit={() => void runParseAndProceed()}
                />
              </>
            )}

            {inputMode === "ai_doc" && !focusParseView && (
              <ImportEvidenceComposer
                title={bi("CMDB 表格 / 交接文档 / 配置文件 / 架构截图", "CMDB Tables / Handover Docs / Configs / Diagrams")}
                placeholder={docPlaceholderFor(effectiveCompID, effectiveDisplayName, selectedPreset?.default_port)}
                value={pasteText}
                onChange={setPasteText}
                images={images}
                onImagesChange={setImages}
                busy={parsing}
                aiEnabled={Boolean(presetsData?.ai_enabled)}
                modelPick={wizardModelPick}
                aiOpts={wizardAIOpts}
                minRows={8}
                imageBtnLabel={bi("上传架构图 / 截图", "Upload Diagram")}
                footHint={bi("支持拖拽 .yml/.conf/.txt/截图", "Drag & drop .yml/.conf/.txt/images")}
                leftSlot={
                  <Button size="small" type="text" onClick={() => setStep(1)} disabled={parsing}>
                    <IconArrowLeft /> {bi("上一步", "Back")}
                  </Button>
                }
                submitLabel={
                  presetsData?.ai_enabled
                    ? bi("AI 智能识别并核对拓扑", "Extract & Review Topology")
                    : bi("规则引擎解析并核对拓扑", "Parse & Review Topology")
                }
                onSubmit={() => void runParseAndProceed()}
              />
            )}

            {(inputMode === "probe" || inputMode === "ai_doc") && parseLive && (
              <AIProcessCard
                live={parseLive}
                title={bi("AI 现场回显与多组件架构解析", "AI Evidence & Multi-Component Stack Parsing")}
                onAbort={() => {
                  parseAbortRef.current?.abort();
                  setParseLive(null);
                  setParseInputsCollapsed(false);
                  setParsing(false);
                }}
                onRetry={() => void runParseAndProceed({ useAI: true })}
                onDismiss={() => {
                  setParseLive(null);
                  setParseInputsCollapsed(false);
                }}
                extraErrorActions={
                  pasteText.trim() ? (
                    <Button
                      size="small"
                      type="secondary"
                      onClick={() => void runParseAndProceed({ useAI: false })}
                    >
                      {bi("改用内置规则引擎提取", "Use Built-in Rule Parser")}
                    </Button>
                  ) : null
                }
              />
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
                    onClick={() => goStep(3)}
                  >
                    {bi("下一步：核对基线与拓扑预览", "Next: Review & Live Topology")} <IconRight />
                  </Button>
                </div>
              </>
            )}
          </section>
          );
        })()}

        {/* ---------------- STEP 3: Focused Baseline Review & Live Topology ---------------- */}
        {step === 3 && (() => {
          const validEndpoints = endpoints.filter((e) => e.address.trim());
          const hostsWithIP = validHosts.filter((h) => h.ip.trim()).length;
          const pathTotal =
            serviceUnits.length + configPaths.length + dataDirs.length + logDirs.length;
          const clueCount = splitNotesToClues(notes).length;
          const hasAttention =
            Boolean(parseInfo?.missing?.length) ||
            Boolean(parseInfo?.warnings?.length) ||
            !idValid ||
            validHosts.length === 0 ||
            hostsWithIP < validHosts.length;

          return (
          <div className="imp-review-grid imp-step-pane">
            <div className="imp-review-main">
              {/* Calm Readiness Strip (replaces noisy banner + open trace wall) */}
              <section className={`imp-review-hero ${hasAttention ? "has-warn" : ""}`}>
                <div className="imp-review-hero-top">
                  <div className="imp-review-hero-l">
                    <span className={`imp-review-status-ic ${hasAttention ? "is-warn" : "is-ok"}`}>
                      <IconCheckCircle />
                    </span>
                    <div className="imp-review-hero-txt">
                      <div className="imp-review-hero-title">
                        <b>
                          {parseInfo
                            ? parseInfo.parser === "ai"
                              ? bi("AI 已提取多组件基线草稿", "AI Multi-Component Baseline Ready")
                              : bi("规则引擎已提取基线草稿", "Baseline Draft Extracted")
                            : bi("核对集群基线草稿", "Review Cluster Baseline Draft")}
                        </b>
                        <div className="imp-review-kpis">
                          <span className="imp-review-kpi num">
                            {validHosts.length} {bi("台节点", "hosts")}
                          </span>
                          <span className="imp-review-kpi num">
                            {1 + companions.length} {bi("个组件", "components")}
                          </span>
                          <span className="imp-review-kpi num">
                            {validEndpoints.length} {bi("个入口", "endpoints")}
                          </span>
                          {packages.length > 0 && (
                            <span className="imp-review-kpi num">
                              {packages.length} {bi("软件包", "pkgs")}
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="imp-review-hero-sub">
                        {bi(
                          "只需重点核对 ① 身份与节点 IP、② 访问入口与组件栈，确认右侧拓扑无误即可建档。",
                          "Verify ① Identity & Hosts and ② Endpoints & Stack, confirm the live topology on the right, then complete onboarding.",
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="imp-review-hero-r">
                    {parseTrace && (
                      <button
                        type="button"
                        className={`imp-review-ghost-btn ${reviewTraceOpen ? "is-on" : ""}`}
                        aria-expanded={reviewTraceOpen}
                        onClick={() => setReviewTraceOpen((v) => !v)}
                      >
                        <Spark size={11} />
                        <span>{reviewTraceOpen ? bi("收起推演", "Hide Trace") : bi("推演过程", "AI Trace")}</span>
                        {reviewTraceOpen ? <IconUp /> : <IconDown />}
                      </button>
                    )}
                    <button
                      type="button"
                      className="imp-review-ghost-btn"
                      onClick={() => goStep(2)}
                    >
                      <IconArrowLeft />
                      <span>{bi("返回补充采集", "Back to Capture")}</span>
                    </button>
                  </div>
                </div>

                {(parseInfo?.missing?.length || parseInfo?.warnings?.length) ? (
                  <div className="imp-review-attention">
                    {parseInfo.missing.length > 0 && (
                      <div>
                        <b>{bi("待核对补齐：", "Suggested to verify: ")}</b>
                        <span>{parseInfo.missing.join(" · ")}</span>
                      </div>
                    )}
                    {parseInfo.warnings.map((w, i) => (
                      <div key={i} className="imp-review-warn-line">
                        {w}
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>

              {parseTrace && reviewTraceOpen && (
                <AIProcessCard
                  trace={parseTrace}
                  title={bi("AI 架构识别与推演过程", "AI Architecture Parsing Trace")}
                />
              )}

              {/* Focus ①: Cluster Identity + Host Inventory (Unified Primary Card) */}
              <section className="imp-card imp-review-sec">
                <div className="imp-card-head">
                  <div className="imp-review-sec-title">
                    <span className="imp-sec-index">1</span>
                    <div className="imp-card-head-title">
                      <h2>
                        {bi("集群身份与主机节点", "Cluster Identity & Hosts")}
                        <span className="imp-count-badge">{validHosts.length}</span>
                      </h2>
                      <p>
                        {bi(
                          "确认集群标识、主精确版本以及每台节点的主机名、业务 IP 与主从角色。",
                          "Verify Cluster ID, version, and each host's hostname, IP address, and role.",
                        )}
                      </p>
                    </div>
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

                <div className="imp-form-grid-2">
                  <div className="imp-field">
                    <label>
                      <span className="imp-lbl-left">{bi("集群标识", "Cluster ID")}</span>
                    </label>
                    <Input
                      className="mono"
                      status={clusterId && !idValid ? "error" : undefined}
                      value={clusterId}
                      onChange={(v) => setClusterId(v.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
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
                </div>

                <div className="imp-sec-divider" />

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

              {/* Focus ②: Access Endpoints + Multi-Component Architecture Stack */}
              <section className="imp-card imp-review-sec">
                <div className="imp-card-head">
                  <div className="imp-review-sec-title">
                    <span className="imp-sec-index">2</span>
                    <div className="imp-card-head-title">
                      <h2>
                        {bi("访问入口与架构组件栈", "Endpoints & Architecture Stack")}
                        <span className="imp-count-badge">{1 + companions.length}</span>
                      </h2>
                      <p>
                        {bi(
                          "确认业务入口（VIP / EIP / F5 / 域名）及 Patroni、etcd、HAProxy、备份等伴生高可用组件。",
                          "Verify business endpoints (VIP / EIP / domain) and co-located HA, DCS, LB, and backup components.",
                        )}
                      </p>
                    </div>
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

                <EndpointListEditor
                  endpoints={endpoints}
                  defaultPort={selectedPreset?.default_port}
                  onChange={setEndpoints}
                />

                <div className="imp-sec-divider" />

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

              {/* Progressive Disclosure ③: Runtime Paths, Parameters, Packages & Field Clues (Collapsed by Default) */}
              <section className={`imp-card imp-review-adv ${reviewDetailsOpen ? "is-open" : ""}`}>
                <div
                  className="imp-review-adv-head"
                  role="button"
                  tabIndex={0}
                  aria-expanded={reviewDetailsOpen}
                  onClick={() => setReviewDetailsOpen((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setReviewDetailsOpen((v) => !v);
                    }
                  }}
                >
                  <div className="imp-review-sec-title">
                    <span className="imp-sec-index is-soft">3</span>
                    <div className="imp-card-head-title">
                      <h2>{bi("运行路径、参数与现场档案", "Runtime Paths, Params & Field Notes")}</h2>
                      <div className="imp-review-adv-pills">
                        <span className="imp-review-kpi num">
                          {bi(`服务/路径 ${pathTotal}`, `Paths ${pathTotal}`)}
                        </span>
                        <span className="imp-review-kpi num">
                          {bi(`运行参数 ${paramRows.length}`, `Params ${paramRows.length}`)}
                        </span>
                        <span className="imp-review-kpi num">
                          {bi(`CVE 软件包 ${packages.length}`, `Packages ${packages.length}`)}
                        </span>
                        <span className="imp-review-kpi num">
                          {bi(`现场线索 ${clueCount}`, `Notes ${clueCount}`)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <span className="imp-review-adv-toggle">
                    <span>{reviewDetailsOpen ? bi("收起细节", "Fold") : bi("展开微调", "Inspect / Edit")}</span>
                    {reviewDetailsOpen ? <IconUp /> : <IconDown />}
                  </span>
                </div>

                {reviewDetailsOpen && (
                  <div className="imp-review-adv-body">
                    <RuntimePathsEditor
                      serviceUnits={serviceUnits}
                      onServiceUnitsChange={setServiceUnits}
                      configPaths={configPaths}
                      onConfigPathsChange={setConfigPaths}
                      dataDirs={dataDirs}
                      onDataDirsChange={setDataDirs}
                      logDirs={logDirs}
                      onLogDirsChange={setLogDirs}
                      servicePlaceholder={selectedPreset?.service_hints?.join(", ") || "patroni.service"}
                      configPlaceholder={selectedPreset?.config_hints?.[0] || "/etc/patroni/patroni.yml"}
                      dataPlaceholder={selectedPreset?.data_hints?.[0] || "/data/pg"}
                      logPlaceholder={selectedPreset?.log_hints?.[0] || "/var/log/postgresql"}
                    />

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
                          {packages.slice(0, 16).map((pk, idx) => (
                            <Tag key={idx} size="small" className="mono">
                              {pk.name}={pk.version}
                            </Tag>
                          ))}
                          {packages.length > 16 && (
                            <Tag size="small" color="gray">
                              +{packages.length - 16}
                            </Tag>
                          )}
                        </div>
                      </div>
                    )}

                    <FieldCluesEditor
                      title={bi("现场线索与运维约束", "Field Clues & Maintenance Window")}
                      value={notes}
                      onChange={setNotes}
                    />
                  </div>
                )}
              </section>
            </div>

            {/* Right Sticky Live Topology Preview & Readiness Commit Card */}
            <aside className="imp-review-side">
              <section className="imp-card imp-review-commit-card">
                <div className="imp-review-commit-head">
                  <AppGlyph
                    id={effectiveCompID}
                    icon={isCustom ? customIcon : selectedPreset?.icon}
                    color={isCustom ? customColor : selectedPreset?.color}
                    size={36}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="mono imp-review-commit-id">
                      {clusterId || "—"}
                    </div>
                    <div className="small muted">
                      {effectiveDisplayName} {exactVersion || version} · {validHosts.length} {bi("台节点", "hosts")} · {1 + companions.length} {bi("组件", "components")}
                    </div>
                  </div>
                </div>

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

                <div className="imp-ready-checks">
                  <div className={`imp-ready-item ${idValid ? "is-ok" : "is-warn"}`}>
                    <IconCheckCircle />
                    <span>
                      {idValid
                        ? bi("集群标识合规", "Cluster ID valid")
                        : bi("请填写合规集群标识", "Valid Cluster ID required")}
                    </span>
                  </div>
                  <div className={`imp-ready-item ${validHosts.length > 0 && hostsWithIP === validHosts.length ? "is-ok" : "is-warn"}`}>
                    <IconCheckCircle />
                    <span>
                      {validHosts.length === 0
                        ? bi("至少需要 1 台主机节点", "At least 1 host required")
                        : hostsWithIP === validHosts.length
                          ? bi(`已核对 ${validHosts.length} 台节点与业务 IP`, `${validHosts.length} host(s) with IPs ready`)
                          : bi(
                              `共 ${validHosts.length} 台节点，其中 ${validHosts.length - hostsWithIP} 台待补 IP`,
                              `${validHosts.length - hostsWithIP} of ${validHosts.length} host(s) missing IP`,
                            )}
                    </span>
                  </div>
                  <div className="imp-ready-item is-ok">
                    <IconCheckCircle />
                    <span>
                      {bi(
                        `已就绪 ${1 + companions.length} 个组件 · ${validEndpoints.length} 个入口 · ${packages.length} 项软件包`,
                        `${1 + companions.length} component(s) · ${validEndpoints.length} endpoint(s) · ${packages.length} pkg(s)`,
                      )}
                    </span>
                  </div>
                </div>

                <div className="imp-review-commit-acts">
                  <Button
                    type="primary"
                    size="large"
                    long
                    loading={submitting}
                    disabled={!idValid || validHosts.length === 0}
                    onClick={submitImport}
                  >
                    <IconCheck /> {bi("完成纳管建档", "Complete Onboarding")}
                  </Button>
                  <Button long type="text" size="small" onClick={() => goStep(2)}>
                    <IconArrowLeft /> {bi("返回第 2 步补充采集（保留当前数据）", "Back to Step 2 (keeps draft)")}
                  </Button>
                </div>
              </section>
            </aside>
          </div>
          );
        })()}
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

  // Re-probe & Gap Diagnosis state
  const [health, setHealth] = useState<BaselineHealth | null>(null);
  const [selectedGapIDs, setSelectedGapIDs] = useState<string[]>([]);
  const [diagnosingGaps, setDiagnosingGaps] = useState(false);
  const [diagLive, setDiagLive] = useState<LiveAIState<ImportLiveKind> | null>(null);
  const [diagTrace, setDiagTrace] = useState<RehearsalTrace | null>(null);
  const diagAbortRef = useRef<AbortController | null>(null);
  const [aiGapDone, setAiGapDone] = useState(false);
  const [aiGapModel, setAiGapModel] = useState("");
  const [aiGapAdded, setAiGapAdded] = useState(0);
  const [probeMode, setProbeMode] = useState<"gap" | "full">("gap");
  const [probeFocus, setProbeFocus] = useState("");
  const [probeScript, setProbeScript] = useState("");
  const [probeFilename, setProbeFilename] = useState("mw-import-probe.sh");
  const [probeSafe, setProbeSafe] = useState(true);
  const [probeSource, setProbeSource] = useState<"template" | "ai">("template");
  const [probeCoveredGaps, setProbeCoveredGaps] = useState<string[]>([]);
  const [probeRunHint, setProbeRunHint] = useState("");
  const [probeModelName, setProbeModelName] = useState("");
  const [probeGenerating, setProbeGenerating] = useState(false);
  const [probeLive, setProbeLive] = useState<LiveAIState<ImportLiveKind> | null>(null);
  const [probeTrace, setProbeTrace] = useState<RehearsalTrace | null>(null);
  const probeAbortRef = useRef<AbortController | null>(null);
  const [probeOutput, setProbeOutput] = useState("");
  const [probeImages, setProbeImages] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);
  const [parseLive, setParseLive] = useState<LiveAIState<ImportLiveKind> | null>(null);
  const [drawerParseCollapsed, setDrawerParseCollapsed] = useState(false);
  const [parseTrace, setParseTrace] = useState<RehearsalTrace | null>(null);
  const parseAbortRef = useRef<AbortController | null>(null);
  const [mergeDiff, setMergeDiff] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) {
      diagAbortRef.current?.abort();
      probeAbortRef.current?.abort();
      parseAbortRef.current?.abort();
    }
    return () => {
      diagAbortRef.current?.abort();
      probeAbortRef.current?.abort();
      parseAbortRef.current?.abort();
    };
  }, [visible]);
  // Progressive 3-step collapsible flow: Step 1 expanded by default; Step 2 & Step 3 collapsed until needed.
  const [step1Open, setStep1Open] = useState(true);
  const [step2Open, setStep2Open] = useState(false);
  const [step3Open, setStep3Open] = useState(false);
  const [autoSummary, setAutoSummary] = useState<ClusterAutomationSummary | null>(null);
  const [autoProbeBusy, setAutoProbeBusy] = useState(false);
  const [autoProbeTask, setAutoProbeTask] = useState<RehearsalExecTask | null>(null);
  const autoProbeAbortRef = useRef<AbortController | null>(null);
  const modelPick = useModelPick("assistant");
  const aiOpts = useAIOptions();

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
        setHealth(res.health || null);
        const defaultGaps = (res.health?.gaps || []).filter((g) => g.selected).map((g) => g.id);
        const fallbackGaps =
          defaultGaps.length > 0
            ? defaultGaps
            : (res.health?.gaps || []).slice(0, 3).map((g) => g.id);
        setSelectedGapIDs(fallbackGaps);
        setProbeMode(res.health && res.health.gaps.length > 0 ? "gap" : "full");
        setMergeDiff([]);
        setAiGapDone(false);
        setAiGapModel("");
        setAiGapAdded(0);
        setStep1Open(true);
        setStep2Open(false);
        setStep3Open(false);
      })
      .catch((e: Error) => Message.error(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [visible, cluster.id]);

  const fetchDrawerProbe = useCallback(
    async (opts?: {
      useAI?: boolean;
      focus?: string;
      mode?: "gap" | "full";
      gapIDs?: string[];
      gapsList?: BaselineGap[];
    }) => {
      const targetMode = opts?.mode || probeMode;
      const targetGaps = opts?.gapIDs ?? selectedGapIDs;
      const sourceGaps = opts?.gapsList ?? health?.gaps ?? [];
      const customGaps =
        targetMode === "gap"
          ? sourceGaps.filter((g) => g.source === "ai" && targetGaps.includes(g.id))
          : [];
      type DrawerProbeResp = {
        script: string;
        filename: string;
        safe?: boolean;
        source?: "template" | "ai";
        mode?: "gap" | "full";
        covered_gaps?: string[];
        run_hint?: string;
        model?: string;
        ai_note?: string;
        trace?: RehearsalTrace;
      };
      const payload = {
        cluster_id: cluster.id,
        component: cluster.app_id,
        display_name: cluster.app_name,
        deploy_method: deployMethod,
        service_units: serviceUnits,
        config_paths: configPaths,
        mode: targetMode,
        missing_gaps: targetMode === "gap" ? targetGaps : [],
        custom_gaps: customGaps,
        use_ai: Boolean(opts?.useAI),
        focus: (opts?.focus ?? probeFocus).trim() || undefined,
        model: modelPick.ref || undefined,
        think: aiOpts.pref.think || undefined,
      };
      if (!opts?.useAI) {
        try {
          const res = await api<DrawerProbeResp>("/api/clusters/import/probe-script", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          setProbeScript(res.script);
          setProbeFilename(res.filename);
          setProbeSafe(res.safe !== false);
          setProbeSource(res.source === "ai" ? "ai" : "template");
          setProbeCoveredGaps(res.covered_gaps || []);
          setProbeRunHint(res.run_hint || "");
          setProbeModelName(res.model || "");
        } catch {
          /* ignore silent template refresh */
        }
        return;
      }

      probeAbortRef.current?.abort();
      const ac = new AbortController();
      probeAbortRef.current = ac;
      setProbeGenerating(true);
      setStep1Open(false);
      setStep2Open(true);
      const modelHint = modelPick.current?.model || modelPick.ref?.split("|")[1];
      setProbeLive(
        buildImportInitialLive(
          "import-probe",
          bi("AI 正在生成专项 100% 只读探针", "AI Generating Targeted 100% Read-Only Probe"),
          modelHint ? { model: modelHint, provider: modelPick.current?.provider } : undefined,
        ),
      );
      try {
        const res = await streamPipelineSSE<DrawerProbeResp, ImportLiveKind>(
          "/api/clusters/import/probe-script",
          payload,
          (updater) => setProbeLive((prev) => (prev ? updater(prev) : prev)),
          ac.signal,
        );
        if (ac.signal.aborted) return;
        setProbeScript(res.script);
        setProbeFilename(res.filename);
        setProbeSafe(res.safe !== false);
        setProbeSource(res.source === "ai" ? "ai" : "template");
        setProbeCoveredGaps(res.covered_gaps || []);
        setProbeRunHint(res.run_hint || "");
        setProbeModelName(res.model || "");
        setProbeTrace(res.trace || null);
        setProbeLive(null);
        if (res.source === "ai") {
          Message.success(
            bi(
              "AI 已按所选需求生成专项 100% 只读探针（已通过静态安全门禁）",
              "AI generated targeted 100% read-only probe (verified safe)",
            ),
          );
        } else if (res.ai_note) {
          Message.warning(res.ai_note);
        }
      } catch (e) {
        if (ac.signal.aborted || (e as Error)?.name === "AbortError") {
          setProbeLive(null);
          return;
        }
        setProbeLive((prev) => (prev ? markLiveStateError(prev, e) : prev));
      } finally {
        if (probeAbortRef.current === ac) {
          probeAbortRef.current = null;
        }
        setProbeGenerating(false);
      }
    },
    [
      cluster.id,
      cluster.app_id,
      cluster.app_name,
      deployMethod,
      serviceUnits,
      configPaths,
      health?.gaps,
      probeMode,
      selectedGapIDs,
      probeFocus,
      modelPick.ref,
      aiOpts.pref.think,
    ],
  );

  const runAIDiagnoseGaps = useCallback(async () => {
    if (diagnosingGaps) return;
    type DiagResp = {
      health: BaselineHealth;
      ai_used?: boolean;
      ai_added?: number;
      model?: string;
      ai_note?: string;
      trace?: RehearsalTrace;
    };
    diagAbortRef.current?.abort();
    const ac = new AbortController();
    diagAbortRef.current = ac;
    setDiagnosingGaps(true);
    const modelHint = modelPick.current?.model || modelPick.ref?.split("|")[1];
    setDiagLive(
      buildImportInitialLive(
        "import-diagnose",
        bi("AI 正在深度排查架构基线盲区", "AI Deep Baseline Gap Diagnosis"),
        modelHint ? { model: modelHint, provider: modelPick.current?.provider } : undefined,
      ),
    );
    try {
      const res = await streamPipelineSSE<DiagResp, ImportLiveKind>(
        "/api/clusters/import/diagnose-gaps",
        {
          cluster_id: cluster.id,
          focus: probeFocus.trim() || undefined,
          model: modelPick.ref || undefined,
          think: aiOpts.pref.think || undefined,
        },
        (updater) => setDiagLive((prev) => (prev ? updater(prev) : prev)),
        ac.signal,
      );
      if (ac.signal.aborted) return;
      if (res.health) {
        setHealth(res.health);
        const newAISelected = (res.health.gaps || [])
          .filter((g) => g.source === "ai" && g.selected)
          .map((g) => g.id);
        if (newAISelected.length > 0) {
          setSelectedGapIDs((prev) => Array.from(new Set([...prev, ...newAISelected])));
          setProbeMode("gap");
        }
      }
      setAiGapDone(Boolean(res.ai_used));
      setAiGapModel(res.model || "");
      setAiGapAdded(res.ai_added || 0);
      setDiagTrace(res.trace || null);
      setDiagLive(null);
      if (res.ai_used) {
        if ((res.ai_added || 0) > 0) {
          Message.success(
            bi(
              `AI 深度发现 ${res.ai_added} 项固定规则未覆盖的专属补采项（已自动勾选高/中优先级）`,
              `AI discovered ${res.ai_added} cluster-specific gap(s) beyond fixed rules`,
            ),
          );
        } else {
          Message.info(
            bi(
              "AI 已通读基线与历史变更，当前未发现固定规则之外的新增盲区",
              "AI reviewed baseline & history; no additional blind spots found",
            ),
          );
        }
      } else if (res.ai_note) {
        Message.warning(res.ai_note);
      }
    } catch (e) {
      if (ac.signal.aborted || (e as Error)?.name === "AbortError") {
        setDiagLive(null);
        return;
      }
      setDiagLive((prev) => (prev ? markLiveStateError(prev, e) : prev));
    } finally {
      if (diagAbortRef.current === ac) {
        diagAbortRef.current = null;
      }
      setDiagnosingGaps(false);
    }
  }, [diagnosingGaps, cluster.id, probeFocus, modelPick.ref, aiOpts.pref.think]);

  const toggleGapID = (gid: string) => {
    setSelectedGapIDs((prev) =>
      prev.includes(gid) ? prev.filter((x) => x !== gid) : [...prev, gid],
    );
  };

  const selectedGapKey = selectedGapIDs.join(",");

  useEffect(() => {
    if (!visible || tab !== "probe" || loading) return;
    void fetchDrawerProbe({ mode: probeMode, gapIDs: selectedGapIDs });
  }, [visible, tab, loading, probeMode, cluster.id]);

  useEffect(() => {
    if (!visible || tab !== "probe" || loading || probeGenerating || probeSource === "ai") return;
    void fetchDrawerProbe({ mode: probeMode, gapIDs: selectedGapIDs });
  }, [selectedGapKey]);

  useEffect(() => {
    if (!visible || tab !== "probe") return;
    let alive = true;
    api<ClusterAutomationSummary>(`/api/clusters/${encodeURIComponent(cluster.id)}/automation`)
      .then((res) => alive && setAutoSummary(res))
      .catch(() => {});
    return () => {
      alive = false;
      autoProbeAbortRef.current?.abort();
    };
  }, [visible, tab, cluster.id]);

  const runAutoBaselineProbe = async () => {
    if (!probeScript.trim() || autoProbeBusy) return;
    autoProbeAbortRef.current?.abort();
    const ctrl = new AbortController();
    autoProbeAbortRef.current = ctrl;
    setStep2Open(true);
    setAutoProbeBusy(true);
    try {
      const task = await api<RehearsalExecTask>(
        `/api/clusters/${encodeURIComponent(cluster.id)}/automation/probe`,
        {
          method: "POST",
          body: JSON.stringify({ script: probeScript }),
        },
      );
      setAutoProbeTask(task);
      const fin = await pollRehearsalExecTask(cluster.id, task.id, setAutoProbeTask, ctrl.signal);
      if (fin.combined_output?.trim()) {
        setProbeOutput(fin.combined_output);
        setStep3Open(true);
        Message.success(
          bi(
            "只读探针已自动采集完成并填入下方回显框，点击「AI 解析并增量合并基线」即可合入",
            "Read-only probe auto-collected and populated below; click AI Parse & Merge to apply",
          ),
        );
      } else if (fin.state !== "succeeded") {
        Message.warning(bi("自动采集未成功，请查看下方脱敏日志", "Automated probe did not succeed; inspect log below"));
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        Message.error((e as Error).message || bi("自动执行只读探针失败", "Auto-run probe failed"));
      }
    } finally {
      setAutoProbeBusy(false);
    }
  };

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

  const parseAndMergeProbe = async (opts?: { useAI?: boolean }) => {
    if (parsing) return;
    if (!probeOutput.trim() && probeImages.length === 0) {
      Message.warning(bi("请先粘贴采集脚本终端输出或上传截图", "Paste probe terminal output or upload screenshots first"));
      return;
    }
    const useAI = opts?.useAI ?? true;
    parseAbortRef.current?.abort();
    const ac = new AbortController();
    parseAbortRef.current = ac;
    setParsing(true);
    const modelHint = modelPick.current?.model || modelPick.ref?.split("|")[1];
    if (useAI) {
      setStep1Open(false);
      setStep2Open(false);
      setDrawerParseCollapsed(true);
      setParseLive(
        buildImportInitialLive(
          "import-parse",
          bi("AI 正在解析回显并增量合并基线", "AI Parsing Evidence & Merging Baseline"),
          modelHint ? { model: modelHint, provider: modelPick.current?.provider } : undefined,
        ),
      );
    } else {
      setDrawerParseCollapsed(false);
      setParseLive(null);
    }
    try {
      const payload = {
        cluster_id: cluster.id,
        component: cluster.app_id,
        display_name: cluster.app_name,
        source_kind: "probe",
        text: probeOutput,
        images: probeImages,
        use_ai: useAI,
        model: modelPick.ref || undefined,
        think: aiOpts.pref.think || undefined,
      };
      const res = useAI
        ? await streamPipelineSSE<ParseResp, ImportLiveKind>(
            "/api/clusters/import/parse",
            payload,
            (updater) => setParseLive((prev) => (prev ? updater(prev) : prev)),
            ac.signal,
          )
        : await api<ParseResp>("/api/clusters/import/parse", {
            method: "POST",
            body: JSON.stringify(payload),
            signal: ac.signal,
          });
      if (ac.signal.aborted) return;
      const d = res.draft;
      const changes: string[] = [];
      const unionStrings = (cur: string[], incoming?: string[], label?: string) => {
        if (!incoming?.length) return cur;
        const set = new Set(cur.map((x) => x.trim()).filter(Boolean));
        const next = [...cur];
        let added = 0;
        for (const v of incoming) {
          const t = v.trim();
          if (t && !set.has(t)) {
            set.add(t);
            next.push(t);
            added++;
          }
        }
        if (added > 0 && label) changes.push(`+${added} ${label}`);
        return next;
      };

      if (d.version && d.version !== version) setVersion(d.version);
      if (d.exact_version && d.exact_version !== exactVersion) {
        setExactVersion(d.exact_version);
        changes.push(bi(`精确版本 → ${d.exact_version}`, `Exact version → ${d.exact_version}`));
      }
      if (d.platform) setPlatform(d.platform);
      if (d.deploy_method) setDeployMethod(d.deploy_method);
      if (d.arch_summary && !archSummary) setArchSummary(d.arch_summary);

      // Additive merge for hosts (preserve existing hosts, fill missing disk/role/IP)
      if (d.hosts?.length) {
        const nextHosts = [...hosts];
        let hostUpdated = 0;
        for (const nh of d.hosts) {
          const idx = nextHosts.findIndex(
            (eh) =>
              (nh.ip && eh.ip === nh.ip) ||
              (nh.name && eh.name.toLowerCase() === nh.name.toLowerCase()),
          );
          if (idx >= 0) {
            const curH = nextHosts[idx];
            const mergedH = {
              name: curH.name || nh.name,
              ip: curH.ip || nh.ip,
              role: nh.role || curH.role,
              disk: nh.disk || curH.disk,
            };
            if (mergedH.disk !== curH.disk || mergedH.role !== curH.role) hostUpdated++;
            nextHosts[idx] = mergedH;
          } else if (nh.name || nh.ip) {
            nextHosts.push(nh);
            hostUpdated++;
          }
        }
        setHosts(nextHosts);
        if (hostUpdated > 0) changes.push(bi(`更新 ${hostUpdated} 台主机信息`, `Updated ${hostUpdated} host(s)`));
      }

      // Additive merge for endpoints
      if (d.endpoints?.length) {
        const seenEp = new Set(endpoints.map((e) => e.address.trim().toLowerCase()));
        const nextEps = [...endpoints];
        let epAdded = 0;
        for (const ep of d.endpoints) {
          const addr = (ep.address || "").trim();
          if (addr && !seenEp.has(addr.toLowerCase())) {
            seenEp.add(addr.toLowerCase());
            nextEps.push({ ...ep, role: normalizeEndpointRole(ep.role) });
            epAdded++;
          }
        }
        if (epAdded > 0) {
          setEndpoints(nextEps);
          changes.push(bi(`+${epAdded} 访问入口`, `+${epAdded} endpoint(s)`));
        }
      }

      // Additive merge for companions (preserve existing + enrich versions/ports)
      if (d.companions?.length) {
        const byID = new Map(companions.map((c) => [c.component.toLowerCase(), { ...c }]));
        let compChanged = 0;
        for (const cm of d.companions) {
          const k = cm.component.toLowerCase();
          const ex = byID.get(k);
          if (ex) {
            const nextVer = cm.version || ex.version;
            const nextPorts = Array.from(new Set([...(ex.ports || []), ...(cm.ports || [])]));
            if (nextVer !== ex.version || nextPorts.length !== (ex.ports || []).length) compChanged++;
            byID.set(k, {
              ...ex,
              ...cm,
              version: nextVer,
              ports: nextPorts,
              hosts: cm.hosts?.length ? cm.hosts : ex.hosts,
            });
          } else {
            byID.set(k, cm);
            compChanged++;
          }
        }
        setCompanions(Array.from(byID.values()));
        setSuggestedCompanions([]);
        if (compChanged > 0) changes.push(bi(`完善 ${compChanged} 个组件栈条目`, `Enriched ${compChanged} stack component(s)`));
      }

      setServiceUnits((cur) => unionStrings(cur, d.service_units, bi("服务单元", "service(s)")));
      setConfigPaths((cur) => unionStrings(cur, d.config_paths, bi("配置路径", "config path(s)")));
      setDataDirs((cur) => unionStrings(cur, d.data_dirs, bi("数据目录", "data dir(s)")));
      setLogDirs((cur) => unionStrings(cur, d.log_dirs, bi("日志目录", "log dir(s)")));

      // Additive merge for runtime parameters!
      if (d.params && Object.keys(d.params).length > 0) {
        const map = new Map(paramRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
        let pChanged = 0;
        for (const [k, v] of Object.entries(d.params)) {
          const key = k.trim();
          const val = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
          if (key && val && map.get(key) !== val) {
            map.set(key, val);
            pChanged++;
          }
        }
        if (pChanged > 0) {
          setParamRows(Array.from(map.entries()).map(([key, value]) => ({ key, value })));
          changes.push(bi(`+${pChanged} 项核心运行参数`, `+${pChanged} runtime param(s)`));
        }
      }

      // Additive merge for packages
      if (d.packages?.length) {
        const pkgMap = new Map(packages.map((p) => [p.name.toLowerCase(), p]));
        let pkgAdded = 0;
        for (const pk of d.packages) {
          if (!pkgMap.has(pk.name.toLowerCase())) pkgAdded++;
          pkgMap.set(pk.name.toLowerCase(), pk);
        }
        setPackages(Array.from(pkgMap.values()));
        if (pkgAdded > 0) changes.push(bi(`+${pkgAdded} 软件包`, `+${pkgAdded} package(s)`));
      }

      // Additive merge for structured clues/notes
      if (d.notes) {
        const mergedClues = splitNotesToClues(`${notes}\n${d.notes}`);
        const oldCount = splitNotesToClues(notes).length;
        setNotes(joinCluesToNotes(mergedClues));
        if (mergedClues.length > oldCount) {
          changes.push(bi(`+${mergedClues.length - oldCount} 条现场线索`, `+${mergedClues.length - oldCount} field clue(s)`));
        }
      }

      setMergeDiff(changes);
      setParseLive(null);
      setDrawerParseCollapsed(false);
      setParseTrace(res.trace || null);
      Message.success(
        changes.length > 0
          ? bi(`已增量合并：${changes.join(" · ")}，请核对后保存基线`, `Merged: ${changes.join(" · ")}; review and save`)
          : bi("采集回显已核验完毕，未发现新增差异字段", "Probe verified; no additional changes found"),
      );
      setTab("edit");
    } catch (e) {
      if (ac.signal.aborted || (e as Error)?.name === "AbortError") {
        setParseLive(null);
        setDrawerParseCollapsed(false);
        return;
      }
      if (useAI) {
        setParseLive((prev) => (prev ? markLiveStateError(prev, e) : prev));
      } else {
        Message.error((e as Error).message);
      }
    } finally {
      if (parseAbortRef.current === ac) {
        parseAbortRef.current = null;
      }
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
      width="min(880px, 95vw)"
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
              {bi("AI 只读补采", "AI Read-Only Probe")}
              {health && health.gaps.length > 0 && (
                <em className="imp-tab-dot">{health.gaps.length}</em>
              )}
            </button>
          </div>
        </div>
      }
      onCancel={onClose}
      footer={
        tab === "probe" ? null : (
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
        (() => {
          const allGaps = health?.gaps || [];
          const selectedGapObjs = allGaps.filter((g) => selectedGapIDs.includes(g.id));
          const aiGapCount = allGaps.filter((g) => g.source === "ai").length;
          const ruleGapCount = allGaps.length - aiGapCount;
          const probeLineCount = probeScript ? probeScript.split("\n").length : 0;
          const isMac =
            typeof navigator !== "undefined" &&
            /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
          const triggerGenerateProbe = () =>
            void fetchDrawerProbe({
              useAI: true,
              focus: probeFocus,
              mode: probeMode,
              gapIDs: selectedGapIDs,
              gapsList: allGaps,
            });

          return (
            <div className="imp-probe-studio">
              {/* Step 1: Define Probe Requirements (Rule Baseline + AI Deep Discovery + Flowing AI Intent Composer) */}
              <section className={`imp-step-card ${step1Open ? "is-open" : ""}`}>
                <div
                  className="imp-step-head"
                  role="button"
                  tabIndex={0}
                  aria-expanded={step1Open}
                  onClick={() => setStep1Open((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setStep1Open((v) => !v);
                    }
                  }}
                >
                  <div className="imp-step-head-l">
                    <span className={`imp-step-num ${!step1Open && (selectedGapObjs.length > 0 || probeFocus.trim()) ? "is-done" : "is-active"}`}>
                      {!step1Open && (selectedGapObjs.length > 0 || probeFocus.trim()) ? <IconCheck /> : "1"}
                    </span>
                    {health && (
                      <span
                        className={`imp-gap-score xs num ${
                          health.score >= 85 ? "is-ok" : health.score >= 55 ? "is-warn" : "is-low"
                        }`}
                      >
                        {health.score}%
                      </span>
                    )}
                    <div className="imp-step-titles">
                      <div className="imp-step-title-row">
                        <h4>{bi("明确补采需求", "Define Probe Scope")}</h4>
                        <span className="imp-iron-badge">
                          <IconCheckCircle /> {bi("100% 只读铁律", "100% Read-Only")}
                        </span>
                        {aiGapCount > 0 && (
                          <span className="imp-gap-ai-tag">
                            <Spark size={10} rainbow />
                            {bi(`含 ${aiGapCount} 项 AI 发现`, `${aiGapCount} AI-found`)}
                          </span>
                        )}
                      </div>
                      {!step1Open && (
                        <div className="imp-step-summary">
                          {probeMode === "full"
                            ? bi("全量标准基线探针", "Full standard baseline probe")
                            : selectedGapObjs.length > 0
                              ? bi(
                                  `已选 ${selectedGapObjs.length} 项缺口：${selectedGapObjs.map((g) => g.category).slice(0, 4).join("、")}${selectedGapObjs.length > 4 ? " 等" : ""}`,
                                  `${selectedGapObjs.length} gap(s): ${selectedGapObjs.map((g) => g.category).slice(0, 4).join(", ")}`,
                                )
                              : bi("自定义只读核查需求", "Custom read-only verification scope")}
                          {probeFocus.trim() ? ` · 「${probeFocus.trim().slice(0, 32)}${probeFocus.trim().length > 32 ? "…" : ""}」` : ""}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="imp-step-head-r">
                    <span className="imp-step-toggle">
                      {step1Open ? bi("收起", "Collapse") : bi("修改需求", "Edit Scope")}
                      {step1Open ? <IconUp /> : <IconDown />}
                    </span>
                  </div>
                </div>

                {step1Open && (
                  <div className="imp-step-body">
                    <div className="imp-gap-toolbar">
                      <div className="imp-gap-toolbar-l">
                        <p className="imp-gap-sub">
                          {health?.summary ||
                            bi(
                              "先通过规则初检定位标准基线缺失项，可进一步让 AI 结合架构栈与变更历史深度发现专属盲区。",
                              "Start with baseline rule checks, or let AI deeply inspect stack & change history for hidden blind spots.",
                            )}
                        </p>
                        <div className="imp-gap-src-meta">
                          <span>{bi(`规则初检 ${ruleGapCount} 项`, `${ruleGapCount} rule check(s)`)}</span>
                          {aiGapDone && (
                            <span className="is-ai">
                              <Spark size={11} rainbow />
                              {bi(
                                `AI 深度发现 +${aiGapAdded} 项${aiGapModel ? ` · ${aiGapModel}` : ""}`,
                                `AI discovered +${aiGapAdded}${aiGapModel ? ` · ${aiGapModel}` : ""}`,
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="imp-gap-toolbar-r">
                        <Button
                          size="small"
                          shape="round"
                          type={aiGapDone ? "outline" : "secondary"}
                          className="imp-ai-discover-btn"
                          loading={diagnosingGaps}
                          disabled={probeGenerating}
                          icon={<Spark size={12} rainbow />}
                          onClick={() => void runAIDiagnoseGaps()}
                        >
                          {aiGapDone
                            ? bi("AI 重新深度发现", "Re-run AI Discovery")
                            : bi("AI 深度发现遗漏项", "AI Deep Gap Discovery")}
                        </Button>
                        <div className="imp-gap-mode-sw">
                          <button
                            type="button"
                            className={probeMode === "gap" ? "on" : ""}
                            onClick={() => setProbeMode("gap")}
                            disabled={allGaps.length === 0}
                          >
                            {bi("专项缺口补采", "Gap Probe")}
                          </button>
                          <button
                            type="button"
                            className={probeMode === "full" ? "on" : ""}
                            onClick={() => setProbeMode("full")}
                          >
                            {bi("全量标准探针", "Full Standard")}
                          </button>
                        </div>
                      </div>
                    </div>

                    {(diagLive || diagTrace) && (
                      <AIProcessCard
                        live={diagLive}
                        trace={diagLive ? null : diagTrace}
                        title={bi("AI 深度基线盲区诊断推演", "AI Deep Baseline Gap Diagnosis")}
                        onAbort={() => {
                          diagAbortRef.current?.abort();
                          setDiagLive(null);
                          setDiagnosingGaps(false);
                        }}
                        onRetry={() => void runAIDiagnoseGaps()}
                        onDismiss={() => setDiagLive(null)}
                      />
                    )}

                    {probeMode === "gap" && allGaps.length > 0 && (
                      <div className="imp-gap-grid">
                        {allGaps.map((g) => {
                          const picked = selectedGapIDs.includes(g.id);
                          const isAI = g.source === "ai";
                          return (
                            <button
                              key={g.id}
                              type="button"
                              className={`imp-gap-item ${picked ? "is-on" : ""} ${isAI ? "is-ai" : ""}`}
                              onClick={() => toggleGapID(g.id)}
                            >
                              <div className="imp-gap-item-top">
                                <span className={`imp-gap-chk ${picked ? "is-on" : ""}`}>
                                  {picked && <IconCheck />}
                                </span>
                                <span className={`imp-gap-sev is-${g.severity}`}>
                                  {g.severity === "high"
                                    ? bi("建议优先", "High")
                                    : g.severity === "medium"
                                      ? bi("建议完善", "Medium")
                                      : bi("可选", "Optional")}
                                </span>
                                <span className="imp-gap-cat">{g.category}</span>
                                {isAI && (
                                  <span className="imp-gap-ai-tag">
                                    <Spark size={10} rainbow />
                                    {bi("AI 发现", "AI Found")}
                                  </span>
                                )}
                              </div>
                              <div className="imp-gap-item-title">{g.title}</div>
                              <div className="imp-gap-item-act">{g.probe_action}</div>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Flagship Flowing-Rim AI Intent Composer */}
                    <div className={`imp-intent-box ${probeGenerating || diagnosingGaps ? "is-busy" : ""}`}>
                      <div className="imp-intent-head">
                        <div className="imp-intent-chips">
                          <span className="imp-intent-lbl">
                            <Spark size={12} rainbow />
                            {probeMode === "full"
                              ? bi("全量标准基线模式", "Full Standard Baseline Mode")
                              : bi("本次补采范围", "Selected Scope")}
                          </span>
                          {probeMode === "gap" && selectedGapObjs.length > 0 ? (
                            <>
                              {selectedGapObjs.map((g) => (
                                <span
                                  key={g.id}
                                  className={`imp-intent-chip ${g.source === "ai" ? "is-ai" : ""}`}
                                >
                                  {g.source === "ai" && <Spark size={10} rainbow />}
                                  <span>{g.category}</span>
                                  <button
                                    type="button"
                                    aria-label={bi("移除", "Remove")}
                                    onClick={() => toggleGapID(g.id)}
                                  >
                                    <IconClose />
                                  </button>
                                </span>
                              ))}
                              <button
                                type="button"
                                className="imp-inline-clear"
                                onClick={() => setSelectedGapIDs([])}
                              >
                                {bi("清空", "Clear")}
                              </button>
                            </>
                          ) : probeMode === "gap" ? (
                            <span className="imp-intent-empty-hint">
                              {bi("未勾选上方卡片，可直接用自然语言指定你想核查的项目", "No cards selected — describe what to inspect below")}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <Input.TextArea
                        className="imp-intent-area"
                        value={probeFocus}
                        onChange={setProbeFocus}
                        disabled={probeGenerating}
                        autoSize={{ minRows: 2, maxRows: 5 }}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                            e.preventDefault();
                            if (!probeGenerating) triggerGenerateProbe();
                          }
                        }}
                        placeholder={bi(
                          "补充本次想重点核查的现场诉求（可选）… 例如：核查 VIP 172.30.2.120 承载位置、Patroni 切换保护参数与备库复制槽状态",
                          "Optional natural-language focus… e.g. verify VIP 172.30.2.120 binding, Patroni failover TTL, and replica slot status",
                        )}
                      />

                      <div className="imp-intent-foot">
                        <div className="imp-intent-foot-l">
                          <ThinkLevel
                            compact
                            levels={modelPick.current?.effort}
                            value={aiOpts.pref.think}
                            onChange={(v) => aiOpts.update({ think: v })}
                          />
                          <ModelPicker compact pick={modelPick} />
                          <span className="imp-foot-note">
                            {isMac ? "⌘" : "Ctrl"} + Enter
                          </span>
                        </div>
                        <div className="imp-intent-foot-r">
                          <Button
                            size="small"
                            shape="round"
                            className="ai-pill"
                            loading={probeGenerating}
                            disabled={diagnosingGaps}
                            icon={<Spark size={13} rainbow />}
                            onClick={triggerGenerateProbe}
                          >
                            {probeMode === "gap" && selectedGapObjs.length > 0
                              ? bi(
                                  `AI 生成专项 100% 只读探针（${selectedGapObjs.length} 项）`,
                                  `AI Generate Targeted Probe (${selectedGapObjs.length})`,
                                )
                              : bi("AI 生成 100% 只读探针", "AI Generate Read-Only Probe")}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {/* Step 2: 100% Read-Only Probe Script (Collapsed by default; auto-expands on AI generation) */}
              <section className={`imp-step-card ${step2Open ? "is-open" : ""}`}>
                <div
                  className="imp-step-head"
                  role="button"
                  tabIndex={0}
                  aria-expanded={step2Open}
                  onClick={() => setStep2Open((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setStep2Open((v) => !v);
                    }
                  }}
                >
                  <div className="imp-step-head-l">
                    <span className={`imp-step-num ${probeSource === "ai" ? "is-done" : step2Open ? "is-active" : ""}`}>
                      {probeSource === "ai" && !probeGenerating ? <IconCheck /> : "2"}
                    </span>
                    <div className="imp-step-titles">
                      <div className="imp-step-title-row">
                        <h4>{bi("获取并执行 100% 只读探针", "Get & Run 100% Read-Only Probe")}</h4>
                        {probeGenerating ? (
                          <span className="imp-gap-ai-tag">
                            <Spark size={10} rainbow />
                            {bi("AI 正在生成并做安全校验…", "AI generating & verifying…")}
                          </span>
                        ) : (
                          <span className={`imp-probe-mode-tag ${probeSource === "ai" ? "is-ai" : ""}`}>
                            {probeSource === "ai" && <Spark size={10} />}
                            {probeSource === "ai"
                              ? bi("AI 专项已就绪", "AI Probe Ready")
                              : bi("模板探针就绪", "Template Ready")}
                            {probeLineCount > 0 ? ` · ${probeLineCount} ${bi("行", "lines")}` : ""}
                          </span>
                        )}
                      </div>
                      {!step2Open && (
                        <div className="imp-step-summary">
                          {probeCoveredGaps.length > 0
                            ? bi(
                                `覆盖 ${probeCoveredGaps.join("、")} · 通过静态只读安全门禁，可直接复制或展开查看`,
                                `Covers ${probeCoveredGaps.join(", ")} · Static read-only verified`,
                              )
                            : bi(
                                "已通过 100% 静态只读校验（零写入、零重启），先定需求后再展开或直接复制执行",
                                "100% static read-only verified (zero writes/restarts); expand when ready",
                              )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="imp-step-head-r">
                    {!step2Open && probeScript && !probeGenerating && (
                      <Button
                        size="mini"
                        type="secondary"
                        icon={<IconCopy />}
                        onClick={(e) => {
                          e.stopPropagation();
                          copy(probeScript);
                          Message.success(bi("已复制 100% 只读采集脚本", "100% read-only probe script copied"));
                        }}
                      >
                        {bi("复制脚本", "Copy")}
                      </Button>
                    )}
                    <span className="imp-step-toggle">
                      {step2Open ? bi("收起", "Collapse") : bi("展开脚本", "Expand")}
                      {step2Open ? <IconUp /> : <IconDown />}
                    </span>
                  </div>
                </div>

                {step2Open && (
                  <div className="imp-step-body">
                    {(probeLive || probeTrace) && (
                      <AIProcessCard
                        live={probeLive}
                        trace={probeLive ? null : probeTrace}
                        title={bi("AI 定制只读探针推演记录", "AI Read-Only Probe Generation Trace")}
                        onAbort={() => {
                          probeAbortRef.current?.abort();
                          setProbeLive(null);
                          setProbeGenerating(false);
                        }}
                        onRetry={() => void fetchDrawerProbe({ useAI: true })}
                        onDismiss={() => setProbeLive(null)}
                      />
                    )}
                    <ProbeCodeBlock
                      script={probeScript}
                      filename={probeFilename}
                      safe={probeSafe}
                      source={probeSource}
                      mode={probeMode}
                      coveredGaps={probeCoveredGaps}
                      runHint={probeRunHint}
                      modelName={probeModelName}
                      compact
                      hideTailorBar
                      aiBusy={probeGenerating}
                      gapCount={selectedGapIDs.length}
                    />
                    {autoProbeTask && (
                      <LiveExecLogCard
                        task={autoProbeTask}
                        clusterId={cluster.id}
                        compact
                        onCancelled={setAutoProbeTask}
                      />
                    )}
                    <div className="imp-step-next">
                      <span className="imp-step-next-hint">
                        {bi(
                          "在目标主/备节点终端执行后复制完整回显；若已配置自动化通道也可直接一键采集",
                          "Run on target terminals and copy output, or use 1-click automated collection if configured",
                        )}
                      </span>
                      <div className="imp-step-next-acts">
                        {can("delivery.execute") && (
                          autoSummary?.ready ? (
                            <Button
                              size="small"
                              type="secondary"
                              loading={autoProbeBusy}
                              disabled={probeGenerating || !probeScript}
                              icon={<IconThunderbolt style={{ color: "var(--ok)" }} />}
                              onClick={() => void runAutoBaselineProbe()}
                            >
                              {bi("自动执行只读探针", "Auto-Run Probe")}
                            </Button>
                          ) : (
                            <Button
                              size="small"
                              type="outline"
                              icon={<IconThunderbolt style={{ color: "var(--warn)" }} />}
                              onClick={() => {
                                onClose();
                                navigateToClusterAutomation(cluster.id);
                              }}
                            >
                              {bi("前往配置自动采集", "Configure Automation")}
                            </Button>
                          )
                        )}
                        <Button
                          size="small"
                          type="text"
                          onClick={() => {
                            setStep1Open(true);
                            setStep2Open(false);
                          }}
                        >
                          {bi("调整补采需求", "Edit Scope")}
                        </Button>
                        <Button
                          size="small"
                          type="primary"
                          disabled={probeGenerating}
                          onClick={() => {
                            setStep2Open(false);
                            setStep3Open(true);
                          }}
                        >
                          {bi("已执行完毕，去粘贴回显", "Done — Paste Output")} <IconArrowRight />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {/* Step 3: Paste Output / Screenshots & Incremental Merge (Collapsed by default) */}
              <section className={`imp-step-card ${step3Open ? "is-open" : ""}`}>
                <div
                  className="imp-step-head"
                  role="button"
                  tabIndex={0}
                  aria-expanded={step3Open}
                  onClick={() => setStep3Open((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setStep3Open((v) => !v);
                    }
                  }}
                >
                  <div className="imp-step-head-l">
                    <span className={`imp-step-num ${step3Open ? "is-active" : ""}`}>3</span>
                    <div className="imp-step-titles">
                      <div className="imp-step-title-row">
                        <h4>{bi("粘贴回显与截图 · AI 增量合并基线", "Paste Output / Screenshots · AI Incremental Merge")}</h4>
                        {(probeOutput.trim() || probeImages.length > 0) && (
                          <span className="imp-gap-ai-tag">
                            {bi(
                              `已待解析${probeOutput.trim() ? ` ${probeOutput.trim().length} 字` : ""}${probeImages.length > 0 ? ` · ${probeImages.length} 张图` : ""}`,
                              `Draft ready${probeOutput.trim() ? ` (${probeOutput.trim().length} chars)` : ""}${probeImages.length > 0 ? ` · ${probeImages.length} img` : ""}`,
                            )}
                          </span>
                        )}
                      </div>
                      {!step3Open && (
                        <div className="imp-step-summary">
                          {bi(
                            "支持直接粘贴回显、拖拽 .log/.txt 或 Ctrl+V 截图；自动脱敏并增量合并，不覆盖已有基线",
                            "Paste terminal output, drop .log/.txt, or Ctrl+V screenshots; auto-redacted additive merge",
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="imp-step-head-r">
                    <span className="imp-step-toggle">
                      {step3Open ? bi("收起", "Collapse") : bi("展开粘贴", "Expand")}
                      {step3Open ? <IconUp /> : <IconDown />}
                    </span>
                  </div>
                </div>

                {step3Open && (
                  <div className="imp-step-body">
                    {parseLive && (
                      <ImportParseFocusBar
                        collapsed={drawerParseCollapsed}
                        onToggle={() => setDrawerParseCollapsed((v) => !v)}
                        textLength={probeOutput.trim().length}
                        imageCount={probeImages.length}
                        isRunning={parsing}
                      />
                    )}
                    {!(parseLive && drawerParseCollapsed) && (
                      <ImportEvidenceComposer
                        title={bi("回显文本 / 截图（自动增量合并，不覆盖已有基线）", "Probe Output / Screenshots (Additive Merge)")}
                        placeholder={bi(
                          "=== MW_IMPORT_BEGIN ===\n直接粘贴采集终端回显、拖拽 .log/.txt 文件，或按 Ctrl+V 粘贴终端截图；AI 将自动提取缺失字段并增量合并…",
                          "=== MW_IMPORT_BEGIN ===\nPaste terminal output, drag & drop .log/.txt files, or Ctrl+V screenshots; AI will extract and merge incrementally…",
                        )}
                        value={probeOutput}
                        onChange={setProbeOutput}
                        images={probeImages}
                        onImagesChange={setProbeImages}
                        busy={parsing}
                        aiEnabled
                        modelPick={modelPick}
                        aiOpts={aiOpts}
                        minRows={6}
                        maxRows={15}
                        imageBtnLabel={bi("上传回显截图", "Upload Image")}
                        footHint={bi("支持拖拽 .log/.txt/截图", "Drag & drop .log/.txt/images")}
                        leftSlot={
                          <Button size="small" type="text" onClick={() => setTab("edit")} disabled={parsing}>
                            <IconArrowLeft /> {bi("返回基线编辑", "Back to Edit")}
                          </Button>
                        }
                        submitLabel={bi("AI 解析并增量合并基线", "AI Parse & Merge")}
                        onSubmit={() => void parseAndMergeProbe({ useAI: true })}
                      />
                    )}
                    {parseLive && (
                      <AIProcessCard
                        live={parseLive}
                        title={bi("AI 现场回显与多组件架构解析", "AI Evidence & Multi-Component Stack Parsing")}
                        onAbort={() => {
                          parseAbortRef.current?.abort();
                          setParseLive(null);
                          setDrawerParseCollapsed(false);
                          setParsing(false);
                        }}
                        onRetry={() => void parseAndMergeProbe({ useAI: true })}
                        onDismiss={() => {
                          setParseLive(null);
                          setDrawerParseCollapsed(false);
                        }}
                        extraErrorActions={
                          probeOutput.trim() ? (
                            <Button
                              size="small"
                              type="secondary"
                              onClick={() => void parseAndMergeProbe({ useAI: false })}
                            >
                              {bi("改用内置规则引擎提取", "Use Built-in Rule Parser")}
                            </Button>
                          ) : null
                        }
                      />
                    )}
                  </div>
                )}
              </section>
            </div>
          );
        })()
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {mergeDiff.length > 0 && (
            <div className="imp-merge-banner">
              <div className="imp-merge-banner-l">
                <IconCheckCircle />
                <div>
                  <b>{bi("本次只读补采已增量合并至下方表单", "Read-only probe results merged incrementally")}</b>
                  <div className="small muted">{mergeDiff.join(" · ")} — {bi("核对无误后点击右下角「保存基线并刷新拓扑」生效", "Review and click Save below to persist")}</div>
                </div>
              </div>
              <Button size="mini" type="primary" loading={saving} onClick={saveBaseline}>
                {bi("立即保存", "Save Now")}
              </Button>
            </div>
          )}
          {parseTrace && (
            <AIProcessCard
              trace={parseTrace}
              title={bi("AI 增量补采解析推演记录", "AI Incremental Merge Trace")}
            />
          )}

          {health && health.gaps.length > 0 && mergeDiff.length === 0 && (
            <div className="imp-health-strip">
              <div className="imp-health-strip-l">
                <span className={`imp-gap-score sm num ${health.score >= 85 ? "is-ok" : health.score >= 55 ? "is-warn" : "is-low"}`}>
                  {health.score}%
                </span>
                <div className="imp-health-strip-t">
                  <b>
                    {bi(
                      `标准基线已齐备 ${health.passed}/${health.total} 项 · 发现 ${health.gaps.length} 项待补采`,
                      `Standard baseline ${health.passed}/${health.total} complete · ${health.gaps.length} gap(s)`,
                    )}
                  </b>
                  <span className="small muted">
                    {health.gaps
                      .slice(0, 2)
                      .map((g) => g.title)
                      .join("；")}
                    {health.gaps.length > 2 ? bi(" 等", "…") : ""}
                  </span>
                </div>
              </div>
              <Button
                size="small"
                shape="round"
                className="ai-pill"
                icon={<Spark size={12} rainbow />}
                onClick={() => setTab("probe")}
              >
                {bi("AI 只读补采", "AI Gap Probe")}
              </Button>
            </div>
          )}
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
            <EndpointListEditor
              endpoints={endpoints}
              onChange={setEndpoints}
            />
          </div>

          {/* Section 5: Structured Runtime Paths & Service Units Editor */}
          <div className="imp-drawer-sec">
            <div className="imp-drawer-sec-h">
              <h4>{bi("服务单元与运行路径", "Service Units & Paths")}</h4>
            </div>
            <RuntimePathsEditor
              serviceUnits={serviceUnits}
              onServiceUnitsChange={setServiceUnits}
              configPaths={configPaths}
              onConfigPathsChange={setConfigPaths}
              dataDirs={dataDirs}
              onDataDirsChange={setDataDirs}
              logDirs={logDirs}
              onLogDirsChange={setLogDirs}
              servicePlaceholder="patroni.service, etcd.service"
              configPlaceholder="/etc/patroni/patroni.yml"
              dataPlaceholder="/data/pg, /data/etcd"
              logPlaceholder="/var/log/postgresql"
            />
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
            <div style={{ marginTop: 6 }}>
              <FieldCluesEditor
                title={bi("现场线索与运维约束", "Field Clues & Operational Notes")}
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

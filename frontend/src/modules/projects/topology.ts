import React from 'react';
import type {
  ChangeRehearsal,
  ClusterView,
  FlowView,
  ImportedMeta,
  InstanceView,
  PackageRequest,
} from '../../shared/shared';
import { bi } from '../../app/i18n';

const STALE_CHUNK_RE =
  /dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to fetch|error loading dynamically imported module/i;

/** Lazy-loads a sub-view chunk with one-shot reload recovery on stale asset hashes. */
export function lazySubView<T extends React.ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return React.lazy(async () => {
    try {
      return await loader();
    } catch (e) {
      if (
        STALE_CHUNK_RE.test(String((e as Error)?.message || e)) &&
        typeof window !== 'undefined'
      ) {
        const key = 'mh-reloaded-for';
        if (sessionStorage.getItem(key) !== location.href) {
          sessionStorage.setItem(key, location.href);
          location.reload();
          return await new Promise<never>(() => {});
        }
      }
      throw e;
    }
  });
}

export type EffectiveClusterChange = {
  key: string;
  before?: string;
  after: string;
  note?: string;
  source_id: string;
  source_title: string;
  source_doc_id?: string;
  applied_at: string;
  applied_by: string;
  update_count: number;
};

/**
 * Merges confirmed production rehearsal changes chronologically (oldest -> newest)
 * so each configuration key resolves to its currently effective value, while keeping
 * a `latestByKey` lookup to mark superseded historical deltas.
 */
export function computeEffectiveClusterChanges(
  rehearsals: ChangeRehearsal[] | null | undefined,
): {
  items: EffectiveClusterChange[];
  latestByKey: Map<string, EffectiveClusterChange>;
} {
  const applied = (rehearsals || [])
    .filter((r) => r && r.stage === 'finalized' && r.applied && !r.voided)
    .slice()
    .sort((a, b) => {
      const ta = a.applied_at || a.updated_at || a.created_at || '';
      const tb = b.applied_at || b.updated_at || b.created_at || '';
      if (ta !== tb) return ta.localeCompare(tb);
      return a.id.localeCompare(b.id);
    });
  const order: string[] = [];
  const latestByKey = new Map<string, EffectiveClusterChange>();
  for (const rh of applied) {
    const at = rh.applied_at || rh.updated_at || '';
    const by = rh.applied_by || rh.owner || '';
    for (const ch of rh.applied_changes || []) {
      const k = (ch.key || '').trim();
      if (!k) continue;
      const lk = k.toLowerCase();
      const prev = latestByKey.get(lk);
      if (prev) {
        prev.after = ch.after;
        if (ch.note) prev.note = ch.note;
        prev.source_id = rh.id;
        prev.source_title = rh.title;
        prev.source_doc_id = rh.doc_id;
        prev.applied_at = at;
        prev.applied_by = by;
        prev.update_count += 1;
      } else {
        order.push(lk);
        latestByKey.set(lk, {
          key: k,
          before: ch.before,
          after: ch.after,
          note: ch.note,
          source_id: rh.id,
          source_title: rh.title,
          source_doc_id: rh.doc_id,
          applied_at: at,
          applied_by: by,
          update_count: 1,
        });
      }
    }
  }
  const items = order
    .map((lk) => latestByKey.get(lk)!)
    .filter(Boolean);
  return { items, latestByKey };
}

export function isOSCompanion(component?: string): boolean {
  const low = (component || '').trim().toLowerCase().replace(/_/g, '-');
  return [
    'node-exporter',
    'process-exporter',
    'systemd-exporter',
    'host-exporter',
    'linux-exporter',
    'cadvisor',
    'telegraf',
    'filebeat',
    'fluent-bit',
    'fluentbit',
    'vector',
    'alloy',
  ].includes(low);
}

export function effectiveCompanionKind(component?: string, kind?: string): string {
  const k = (kind || '').trim().toLowerCase();
  if (isOSCompanion(component) && (!k || k === 'monitoring' || k === 'companion')) {
    return 'os_component';
  }
  return k || inferCompanionKind(component);
}

export function companionIcon(component?: string): string {
  const low = (component || '').trim().toLowerCase().replace(/_/g, '-');
  if (low === 'prometheus' || low.endsWith('-exporter')) {
    return 'prometheus';
  }
  return component || '';
}

export function companionKindMeta(kind?: string): { label: string; tone: string } {
  switch ((kind || '').toLowerCase()) {
    case 'ha_manager':
      return { label: bi('高可用管理', 'HA Manager'), tone: 't-brand' };
    case 'dcs':
      return { label: bi('分布式协调', 'DCS / Quorum'), tone: 't-cobalt' };
    case 'proxy':
      return { label: bi('代理 / 均衡', 'Proxy / LB'), tone: 't-violet' };
    case 'vip':
      return { label: bi('虚拟 IP', 'VIP / VRRP'), tone: 't-brand' };
    case 'pooler':
      return { label: bi('连接池', 'Pooler'), tone: 't-cobalt' };
    case 'backup':
      return { label: bi('备份工具', 'Backup'), tone: 't-ok' };
    case 'monitoring':
      return { label: bi('监控采集', 'Monitoring'), tone: '' };
    case 'os_component':
      return { label: bi('OS 组件', 'OS Component'), tone: '' };
    default:
      return { label: bi('伴生组件', 'Companion'), tone: '' };
  }
}

export function localizeEndpointTitle(epName?: string, role?: string): string {
  const lowName = (epName || '').trim().toLowerCase();
  const lowRole = (role || '').trim().toLowerCase();
  const generic = new Set([
    '', 'readwrite', 'rw', 'write', 'writer', 'primary', 'master',
    'readonly', 'ro', 'read', 'reader', 'replica', 'standby',
    'admin', 'console', 'mgmt', 'management', 'endpoint', 'vip',
  ]);
  if (epName && !generic.has(lowName)) return epName.trim();
  if (['readonly', 'ro', 'read', 'reader', 'replica', 'standby'].includes(lowRole) || ['readonly', 'ro', 'read', 'reader'].includes(lowName)) {
    return bi('只读入口', 'Read-Only');
  }
  if (['admin', 'console', 'mgmt', 'management'].includes(lowRole) || ['admin', 'console', 'mgmt'].includes(lowName)) {
    return bi('管理入口', 'Admin');
  }
  return bi('读写入口', 'Read/Write');
}

export function localizePortName(name?: string, component?: string): string {
  const raw = (name || '').trim();
  const low = raw.toLowerCase();
  const comp = (component || '').trim().toLowerCase();
  if (low === 'postgresql' || low === 'postgres') return 'PostgreSQL';
  if (low === 'mysql') return 'MySQL';
  if (low === 'redis') return 'Redis';
  if (low === 'sentinel' || low === 'redis-sentinel') return 'Redis Sentinel';
  if (low === 'patroni-rest' || low === 'patroni') return 'Patroni API';
  if (low === 'client') {
    return comp === 'etcd'
      ? bi('etcd 客户端', 'etcd client')
      : bi('客户端', 'Client');
  }
  if (low === 'peer') {
    return comp === 'etcd'
      ? bi('etcd 节点间', 'etcd peer')
      : bi('节点间', 'Peer');
  }
  if (low === 'stats') return bi('监控统计', 'Stats');
  if (low === 'metrics') return bi('监控指标', 'Metrics');
  if (low === 'readwrite' || low === 'writer' || low === 'rw') {
    return bi('读写', 'RW');
  }
  if (low === 'readonly' || low === 'reader' || low === 'ro') {
    return bi('只读', 'RO');
  }
  if (low === 'admin' || low === 'mgmt' || low === 'console') {
    return bi('管理', 'Admin');
  }
  return raw;
}

export type ClusterStackPill = {
  key: string;
  component: string;
  icon?: string;
  title: string;
  version?: string;
  kindLabel: string;
  primary?: boolean;
};

function inferCompanionKind(component?: string): string {
  const low = (component || '').trim().toLowerCase().replace(/_/g, '-');
  if (['patroni', 'redis-sentinel', 'sentinel', 'orchestrator', 'repmgr'].includes(low)) {
    return 'ha_manager';
  }
  if (['etcd', 'zookeeper', 'consul', 'clickhouse-keeper'].includes(low)) {
    return 'dcs';
  }
  if (low === 'keepalived') return 'vip';
  if (['haproxy', 'nginx', 'proxysql', 'maxscale', 'obproxy', 'envoy'].includes(low)) {
    return 'proxy';
  }
  if (['pgbouncer', 'odyssey'].includes(low)) return 'pooler';
  if (['pgbackrest', 'barman', 'wal-g', 'xtrabackup'].includes(low)) {
    return 'backup';
  }
  if (isOSCompanion(low)) {
    return 'os_component';
  }
  if (low === 'prometheus' || low.endsWith('-exporter')) {
    return 'monitoring';
  }
  return 'other';
}

/** Extracts a clean upstream version (e.g. "4.1.5" from "1:4.1.5-1.noble") from locked instance packages. */
export function packageUpstreamVersion(
  packages: PackageRequest[] | undefined,
  nameRe: RegExp,
): string {
  if (!Array.isArray(packages) || packages.length === 0) return '';
  const hit = packages.find(
    (p) => p && typeof p.name === 'string' && nameRe.test(p.name),
  );
  if (!hit || typeof hit.version !== 'string') return '';
  return hit.version
    .trim()
    .replace(/^\d+:/, '')
    .replace(/[-+~].*$/, '')
    .trim();
}

export function buildClusterStackPills(
  c: ClusterView,
  real: DisplayInstance[],
): ClusterStackPill[] {
  const canon = (s?: string) => (s || '').trim().toLowerCase().replace(/_/g, '-');
  const imp = c.imported;
  const main =
    real.find((i) => i.id === c.app_id || i.component === c.app_id) || real[0];
  const primaryComp = (main?.component || c.app_id || '').trim();
  const primaryKey = canon(primaryComp) || 'primary';
  const allPackages = real.flatMap((i) => i.packages || []);

  const out: ClusterStackPill[] = [];
  const byKey = new Map<string, ClusterStackPill>();

  const primaryPill: ClusterStackPill = {
    key: primaryKey,
    component: primaryComp || c.app_id,
    icon: imp?.icon || c.icon || primaryComp || c.app_id,
    title: imp?.display_name || main?.title || c.app_name || c.app_id,
    version: (imp?.exact_version || main?.version || c.version || '').trim() || undefined,
    kindLabel: bi('主组件', 'Primary'),
    primary: true,
  };
  out.push(primaryPill);
  byKey.set(primaryKey, primaryPill);

  for (const inst of real) {
    if (inst === main || inst.external) continue;
    const ck = canon(inst.component);
    if (!ck || byKey.has(ck)) continue;
    const pill: ClusterStackPill = {
      key: ck,
      component: inst.component,
      icon: inst.component,
      title: inst.title || inst.component,
      version: (inst.version || '').trim() || undefined,
      kindLabel: companionKindMeta(inferCompanionKind(inst.component)).label,
    };
    out.push(pill);
    byKey.set(ck, pill);
  }

  if (
    (primaryKey === 'postgresql' || canon(c.app_id) === 'postgresql') &&
    Boolean(main?.params?.backup_retention_full) &&
    !byKey.has('pgbackrest')
  ) {
    const pill: ClusterStackPill = {
      key: 'pgbackrest',
      component: 'pgbackrest',
      icon: 'pgbackrest',
      title: 'pgBackRest',
      version: packageUpstreamVersion(allPackages, /pgbackrest/i) || undefined,
      kindLabel: bi('备份工具', 'Backup'),
    };
    out.push(pill);
    byKey.set('pgbackrest', pill);
  }

  if (
    (primaryKey === 'redis' || primaryKey === 'valkey') &&
    ((main?.roles?.sentinel?.length || 0) > 0 ||
      (main?.ports || []).some((pt) => (pt.Name || '').toLowerCase() === 'sentinel')) &&
    !byKey.has('redis-sentinel')
  ) {
    const pill: ClusterStackPill = {
      key: 'redis-sentinel',
      component: 'redis',
      icon: 'redis',
      title: 'Redis Sentinel',
      version:
        packageUpstreamVersion(allPackages, /redis-sentinel/i) ||
        (main?.version || '').trim() ||
        undefined,
      kindLabel: bi('高可用管理', 'HA Sentinel'),
    };
    out.push(pill);
    byKey.set('redis-sentinel', pill);
  }

  for (const cm of imp?.companions || []) {
    const ck = canon(cm.component);
    if (!ck) continue;
    const effKind = effectiveCompanionKind(cm.component, cm.kind);
    const existing = byKey.get(ck);
    if (existing) {
      if (!existing.version && cm.version) existing.version = cm.version;
      if (cm.display_name) existing.title = cm.display_name;
      if (effKind && !existing.primary) {
        existing.kindLabel = companionKindMeta(effKind).label;
      }
      continue;
    }
    const pill: ClusterStackPill = {
      key: ck,
      component: cm.component,
      icon: companionIcon(cm.component),
      title: cm.display_name || cm.component,
      version: (cm.version || '').trim() || undefined,
      kindLabel: companionKindMeta(effKind).label,
    };
    out.push(pill);
    byKey.set(ck, pill);
  }

  return out;
}

/** Light client-side detector for legacy single-instance clusters whose metadata mentions unmodeled companions. */
export function detectMissingCompanionsFromMeta(
  primaryComp: string,
  meta?: ImportedMeta,
): string[] {
  if (!meta) return [];
  const primary = (primaryComp || '').toLowerCase();
  const existing = new Set((meta.companions || []).map((c) => (c.component || '').toLowerCase()));
  const positiveBag = [
    ...(meta.service_units || []),
    ...(meta.config_paths || []),
    ...(meta.data_dirs || []),
    ...(meta.packages || []).map((p) => p.name),
    meta.arch_summary || '',
  ]
    .join(' ')
    .toLowerCase();
  if (!positiveBag.trim()) return [];
  const rules: [string, string, string][] = [
    ['patroni', 'patroni', 'Patroni'],
    ['etcd', 'etcd', 'etcd'],
    ['pgbackrest', 'pgbackrest', 'pgBackRest'],
    ['pgbouncer', 'pgbouncer', 'PgBouncer'],
    ['haproxy', 'haproxy', 'HAProxy'],
    ['keepalived', 'keepalived', 'Keepalived'],
    ['zookeeper', 'zookeeper', 'ZooKeeper'],
    ['clickhouse-keeper', 'clickhouse-keeper', 'ClickHouse Keeper'],
    ['proxysql', 'proxysql', 'ProxySQL'],
  ];
  const out: string[] = [];
  for (const [id, token, label] of rules) {
    if (id === primary || existing.has(id)) continue;
    if (positiveBag.includes(token)) out.push(label);
  }
  if ((primary === 'redis' || primary === 'valkey') && !existing.has('redis-sentinel') && positiveBag.includes('sentinel')) {
    out.push('Redis Sentinel');
  }
  return out;
}

export type DisplayInstance = InstanceView & { embedded?: boolean };
export const componentOrder: Record<string, number> = { postgresql: 0, etcd: 1, patroni: 2 };

// Snapshot presentation only: never add these inferred entries to deployment specs.
export function displayInstances(instances: InstanceView[]): DisplayInstance[] {
  const safe = Array.isArray(instances) ? instances : [];
  const expanded = safe.flatMap((inst): DisplayInstance[] => {
    const managed = safe.some((m) => m.managed_context === inst.id);
    const params = inst.params || {};
    const embedded = inst.component === 'postgresql' && !managed &&
      !['single', 'replication'].includes(String(params.deployment_mode || '')) &&
      !!inst.uses?.dcs && (inst.ports || []).some((p) => p.Name === 'patroni-rest') &&
      typeof params.patroni_ttl === 'number';
    if (!embedded) return [inst];
    return [inst, {
      id: inst.id + '/embedded-patroni', component: 'patroni', title: 'Patroni',
      version: packageUpstreamVersion(inst.packages, /patroni/i), status: inst.status, auto: true, embedded: true, managed_context: inst.id,
      roles: inst.roles, role_titles: inst.role_titles, hosts: inst.hosts,
      params: {}, visible: {},
    }];
  });
  return expanded.sort((a, b) =>
    (componentOrder[a.component] ?? 3) - (componentOrder[b.component] ?? 3));
}

const flowIdentity = (f: FlowView) => JSON.stringify([
  f.kind, f.from_role, f.to_role, [...(f.from || [])].sort(), [...(f.to || [])].sort(), !!f.sync,
]);

// A manager can describe the same database flow. Collapse only an exact match
// through its explicit binding; independent databases must retain their own flows.
export function displayFlows(instances: InstanceView[]) {
  const safe = Array.isArray(instances) ? instances : [];
  return safe.flatMap((inst) => {
    const database = safe.find((i) => i.id === inst.managed_context);
    return (inst.flows || []).filter((flow) =>
      !database?.flows?.some((f) => flowIdentity(f) === flowIdentity(flow))
    ).map((flow) => ({ ...flow, inst }));
  });
}

export type HostStorageInput = {
  disk?: string;
  partition?: string;
  initialize?: boolean;
  params?: Record<string, unknown>;
};

export type HostStorageOptions = {
  imported?: boolean;
  importedDataDirs?: string[];
};

export type HostStorageInfo = {
  label: string;
  path: string;
  note: string;
};

export function hostStorage(
  host?: HostStorageInput,
  opts?: HostStorageOptions,
): HostStorageInfo {
  const isImported = Boolean(opts?.imported);
  const disk = (host?.disk || '').trim();
  const partition = (host?.partition || '').trim();
  const diskLabel = disk ? (partition ? `${disk} · ${partition}` : disk) : '';
  const paramRoot =
    typeof host?.params?.data_root === 'string'
      ? host.params.data_root.trim()
      : '';
  const importedRoot = (Array.isArray(opts?.importedDataDirs) ? opts.importedDataDirs : [])
    .map((d) => String(d || '').trim())
    .filter(Boolean)
    .join(', ');
  const storageMode =
    typeof host?.params?.storage_mode === 'string'
      ? host.params.storage_mode
      : '';

  if (isImported) {
    const path = paramRoot || importedRoot;
    if (diskLabel) {
      return {
        label: diskLabel,
        path,
        note: bi('存量纳管目录（沿用现场磁盘）', 'Existing mounted dir (brownfield)'),
      };
    }
    if (storageMode === 'system_directory') {
      return {
        label: bi('系统盘目录', 'System disk dir'),
        path,
        note: bi('存量纳管目录（沿用现场环境）', 'Existing mounted dir (brownfield)'),
      };
    }
    return {
      label: bi('存量纳管目录', 'Existing mounted dir'),
      path,
      note: path
        ? bi('存量纳管 · 沿用现场数据目录', 'Brownfield · Existing data directory')
        : bi('存量纳管 · 沿用现场已有挂载', 'Brownfield · Existing mounted dir'),
    };
  }

  if (!host) {
    return {
      label: bi('未记录', 'Not recorded'),
      path: '',
      note: bi('未记录初始化', 'Init unrecorded'),
    };
  }

  const root = paramRoot || '/data';
  const initNote =
    host.initialize === true
      ? bi('初始化磁盘', 'Init enabled')
      : host.initialize === false
        ? bi('不初始化磁盘', 'Init disabled')
        : bi('未记录初始化', 'Init unrecorded');

  if (storageMode === 'system_directory') {
    return {
      label: bi('系统盘目录', 'System disk dir'),
      path: root,
      note:
        host.initialize === true
          ? bi('初始化磁盘', 'Init enabled')
          : bi('系统盘目录（不初始化磁盘）', 'System disk dir (no disk init)'),
    };
  }

  if (diskLabel) {
    return { label: diskLabel, path: root, note: initNote };
  }

  return {
    label: bi('已有挂载目录', 'Mounted directory'),
    path: root,
    note:
      host.initialize === true
        ? bi('初始化磁盘', 'Init enabled')
        : host.initialize === false
          ? bi('不初始化磁盘', 'Init disabled')
          : bi('沿用已有挂载目录', 'Using existing mount'),
  };
}

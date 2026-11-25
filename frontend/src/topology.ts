import React from 'react';
import type { ChangeRehearsal, FlowView, ImportedMeta, InstanceView } from './shared';
import { bi } from './i18n';

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
      version: '', status: inst.status, auto: true, embedded: true, managed_context: inst.id,
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

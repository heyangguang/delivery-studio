import type { FlowView, InstanceView } from './shared';
import { bi } from './i18n';

export type DisplayInstance = InstanceView & { embedded?: boolean };
export const componentOrder: Record<string, number> = { postgresql: 0, etcd: 1, patroni: 2 };

// Snapshot presentation only: never add these inferred entries to deployment specs.
export function displayInstances(instances: InstanceView[]): DisplayInstance[] {
  const expanded = instances.flatMap((inst): DisplayInstance[] => {
    const managed = instances.some((m) => m.managed_context === inst.id);
    const embedded = inst.component === 'postgresql' && !managed &&
      !['single', 'replication'].includes(String(inst.params.deployment_mode || '')) &&
      !!inst.uses?.dcs && inst.ports?.some((p) => p.Name === 'patroni-rest') &&
      typeof inst.params.patroni_ttl === 'number';
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
  f.kind, f.from_role, f.to_role, [...f.from].sort(), [...f.to].sort(), !!f.sync,
]);

// A manager can describe the same database flow. Collapse only an exact match
// through its explicit binding; independent databases must retain their own flows.
export function displayFlows(instances: InstanceView[]) {
  return instances.flatMap((inst) => {
    const database = instances.find((i) => i.id === inst.managed_context);
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
  const importedRoot = (opts?.importedDataDirs || [])
    .map((d) => d.trim())
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

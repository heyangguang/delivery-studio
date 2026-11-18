import type { FlowView, InstanceView } from './shared';

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

export function hostStorage(host?: { disk?: string; params?: Record<string, unknown> }) {
  if (!host) return { label: '未记录', path: '' };
  const root = typeof host.params?.data_root === 'string' ? host.params.data_root : '/data';
  if (host.params?.storage_mode === 'system_directory') return { label: '系统盘目录', path: root };
  return { label: host.disk || '已有挂载目录', path: root };
}

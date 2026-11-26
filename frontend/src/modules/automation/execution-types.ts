import { bi } from "../../app/i18n";

export type AgentHostProbe = {
  hostname?: string;
  os?: string;
  kernel?: string;
  arch?: string;
  cpu_cores?: number;
  load1?: number;
  load5?: number;
  mem_total_mb?: number;
  mem_used_pct?: number;
  disk_total_gb?: number;
  disk_used_pct?: number;
  uptime_sec?: number;
  interval_sec?: number;
};

export type ExecutionNode = {
  kind?: "independent" | "embedded";
  protocol?: number;
  authorized?: boolean;
  compatible?: boolean;
  reason?: string;
  id: string;
  name: string;
  clusters: string[];
  ips: string[];
  controller_ip: string;
  last_seen?: string;
  disabled: boolean;
  version?: string;
  allow_delivery?: boolean;
  allow_probe?: boolean;
  allow_rehearsal?: boolean;
  probe?: AgentHostProbe;
};

export type ExecutionPreparation = {
  id: string;
  node: string;
  job: string;
  revision: string;
  env_hash?: string;
  env_match?: boolean;
  created: string;
  finished?: string;
  invalidated?: string;
  state: "pending" | "ready" | "blocked" | "expired";
  checks: {
    id: string;
    title: string;
    host?: string;
    state: string;
    message: string;
    warnings?: string[];
  }[];
};

export type ClusterAutomationHost = {
  name: string;
  ip: string;
  role?: string;
};

export type AgentClusterMode = "readonly" | "readwrite";

export type AgentHeartbeatSample = {
  at: string;
  load1?: number;
  mem_pct?: number;
  disk_pct?: number;
};

export type AgentClusterCatalogItem = {
  id: string;
  app_name: string;
  version?: string;
  platform?: string;
  owner?: string;
  host_ips?: string[];
  host_names?: string[];
  can_op: boolean;
};

export type UnifiedAgentView = {
  id: string;
  backing: "node" | "direct";
  name: string;
  ip: string;
  online: boolean;
  disabled: boolean;
  revoked?: boolean;
  last_seen?: string;
  version?: string;
  protocol?: number;
  supports_exec: boolean;
  cluster_modes: Record<string, AgentClusterMode>;
  clusters: string[];
  suggested_clusters?: string[];
  probe?: AgentHostProbe;
  heartbeats?: AgentHeartbeatSample[];
  service_name?: string;
};

export type ClusterAutomationConfig = {
  cluster_id: string;
  enabled: boolean;
  transport: "node" | "agent";
  node_id?: string;
  last_agent_id?: string;
  node_exec_method?: "auto" | "ansible" | "ssh";
  ssh_user?: string;
  ssh_port?: number;
  env_kind: "prod" | "test";
  default_pacing?: "step_confirm" | "ai_gated_auto";
  pause_before_mutate: boolean;
  allow_prod_mutate: boolean;
  test_cluster_id?: string;
  custom_hosts?: ClusterAutomationHost[];
  updated_at?: string;
  updated_by?: string;
};

export type AutomationNodeView = ExecutionNode & {
  online: boolean;
  allow_delivery: boolean;
  allow_probe: boolean;
  allow_rehearsal: boolean;
  supports_v3: boolean;
};

export type AutomationAgentView = {
  id: string;
  job?: string;
  cluster?: string;
  clusters?: string[];
  node?: string;
  mode?: string; // "" / "ssh_trust" | "direct"
  allow_mutating?: boolean;
  capabilities?: string[];
  host: string;
  ip: string;
  created: string;
  expires: string;
  last_seen?: string;
  version?: string;
  desired: string;
  applied?: string;
  matched_clusters?: string[];
  suggested_clusters?: string[];
  message?: string;
  probe?: AgentHostProbe;
  online: boolean;
};

export type AgentEnrollPrefill = {
  role?: "controller" | "target";
  host?: string;
  ip?: string;
  cluster?: string;
  ts?: number;
};

const AGENT_ENROLL_PREFILL_KEY = "ds:agent-enroll-prefill";
const AGENT_ENROLL_PREFILL_TTL_MS = 5 * 60 * 1000;

export function saveAgentEnrollPrefill(prefill: Omit<AgentEnrollPrefill, "ts">) {
  try {
    sessionStorage.setItem(
      AGENT_ENROLL_PREFILL_KEY,
      JSON.stringify({ ...prefill, ts: Date.now() } satisfies AgentEnrollPrefill),
    );
  } catch {
    // Ignore private-mode storage failures
  }
}

export function consumeAgentEnrollPrefill(): AgentEnrollPrefill | null {
  try {
    const raw = sessionStorage.getItem(AGENT_ENROLL_PREFILL_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(AGENT_ENROLL_PREFILL_KEY);
    const parsed = JSON.parse(raw) as AgentEnrollPrefill;
    if (!parsed || (parsed.ts && Date.now() - parsed.ts > AGENT_ENROLL_PREFILL_TTL_MS)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export type RehearsalExecTarget = {
  host: string;
  ip: string;
  role?: string;
  agent_id?: string;
};

export type RehearsalExecTargetResult = {
  host: string;
  ip: string;
  role?: string;
  agent_id?: string;
  state:
    | "queued"
    | "leased"
    | "running"
    | "succeeded"
    | "failed"
    | "stopped"
    | "unknown"
    | "blocked";
  exit_code?: number;
  started_at?: string;
  finished_at?: string;
  elapsed_sec?: number;
  output?: string;
  error?: string;
  seq?: number;
};

export type RehearsalExecTask = {
  id: string;
  cluster_id: string;
  rehearsal_id?: string;
  step_id?: string;
  step_order?: number;
  step_title?: string;
  sub_index: number;
  kind:
    | "connectivity_check"
    | "baseline_probe"
    | "rehearsal_probe"
    | "rehearsal_step"
    | "rehearsal_rollback";
  read_only: boolean;
  transport: "node" | "agent";
  node_id?: string;
  node_name?: string;
  node_exec_method?: string;
  ssh_user?: string;
  ssh_port?: number;
  env_kind: "prod" | "test";
  script: string;
  script_sha256: string;
  timeout_sec: number;
  targets: RehearsalExecTarget[];
  results: RehearsalExecTargetResult[];
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "stopped"
    | "unknown"
    | "blocked";
  cancel?: boolean;
  combined_output?: string;
  error?: string;
  by: string;
  created_at: string;
  updated_at: string;
  finished_at?: string;
};

export type AutomationBootstrapInfo = {
  origin: string;
  is_loopback: boolean;
  suggested_urls: string[];
  tls_enabled: boolean;
  tls_self_signed: boolean;
  ca_available: boolean;
  binary_available: boolean;
  version: string;
};

export type ClusterAutomationSummary = {
  config: ClusterAutomationConfig;
  hosts: ClusterAutomationHost[];
  nodes: AutomationNodeView[];
  agents: AutomationAgentView[];
  unbound_agents?: AutomationAgentView[];
  unified_agents?: UnifiedAgentView[];
  available_agents?: UnifiedAgentView[];
  last_agent_id?: string;
  online_agents: number;
  ready: boolean;
  ready_reason?: string;
  verified?: boolean;
  last_check_state?: string;
  last_check_at?: string;
  bootstrap: AutomationBootstrapInfo;
  recent_tasks: RehearsalExecTask[];
};

export const isExecutionNodeOnline = (node: ExecutionNode) =>
  !node.disabled &&
  !!node.last_seen &&
  Date.now() - Date.parse(node.last_seen) < 35000;

export function nodeConnection(node: ExecutionNode) {
  if (node.disabled) return { key: "disabled", label: bi("已暂停接单", "Paused") };
  if (isExecutionNodeOnline(node)) return { key: "online", label: bi("已连接", "Connected") };
  return node.last_seen
    ? { key: "offline", label: bi("连接中断", "Disconnected") }
    : { key: "waiting", label: bi("等待连接", "Waiting") };
}

export function isRehearsalTaskTerminal(state?: string): boolean {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "stopped" ||
    state === "unknown" ||
    state === "blocked"
  );
}

/**
 * Smartly resolves a step's natural-language `target_role` (e.g. "主库 db-node-01 (172.30.2.67)",
 * "所有节点", "所有备库 / Standby") to concrete RehearsalExecTarget(s), prioritizing live drift roles.
 */
export function resolveStepTargets(
  targetRole: string | undefined,
  hosts: ClusterAutomationHost[],
  driftHosts?: { name: string; ip: string; actual_role?: string; initial_role?: string }[],
): RehearsalExecTarget[] {
  const enriched: RehearsalExecTarget[] = hosts.map((h) => {
    const dh = driftHosts?.find(
      (d) =>
        (d.ip && h.ip && d.ip.trim() === h.ip.trim()) ||
        (d.name && h.name && d.name.trim().toLowerCase() === h.name.trim().toLowerCase()),
    );
    return {
      host: h.name,
      ip: h.ip,
      role: (dh?.actual_role || dh?.initial_role || h.role || "").trim(),
    };
  });
  if (enriched.length === 0) return [];
  const raw = (targetRole || "").trim();
  if (!raw) return [enriched[0]];

  // 1. Explicit IP match(es) mentioned in targetRole
  const ipMatches = enriched.filter((h) => h.ip && raw.includes(h.ip));
  if (ipMatches.length > 0) return ipMatches;

  // 2. Explicit hostname match(es)
  const low = raw.toLowerCase();
  const nameMatches = enriched.filter(
    (h) => h.host && h.host.length >= 3 && low.includes(h.host.toLowerCase()),
  );
  if (nameMatches.length > 0) return nameMatches;

  // 3. All-nodes intent
  if (/(所有|全部|全节点|三台|每台|逐台|all\s*nodes|every\s*node|all\s*hosts)/i.test(raw)) {
    return enriched;
  }

  const isPrimaryRole = (r?: string) =>
    /(leader|primary|master|主库|主节点|writer|读写)/i.test(r || "");
  const isReplicaRole = (r?: string) =>
    /(standby|replica|slave|secondary|follower|从库|从节点|备库|备节点|只读|reader)/i.test(
      r || "",
    );

  // 4. Standby/Replica intent (without primary)
  if (isReplicaRole(raw) && !isPrimaryRole(raw)) {
    const replicas = enriched.filter((h) => isReplicaRole(h.role) && !isPrimaryRole(h.role));
    if (replicas.length > 0) {
      if (/(任一|一台|某台|one\s|single)/i.test(raw)) return [replicas[0]];
      return replicas;
    }
  }

  // 5. Primary/Leader intent
  if (isPrimaryRole(raw)) {
    const primaries = enriched.filter((h) => isPrimaryRole(h.role));
    if (primaries.length > 0) return [primaries[0]];
  }

  // 6. Default to first primary or first host
  const firstPrimary = enriched.find((h) => isPrimaryRole(h.role));
  return [firstPrimary || enriched[0]];
}

import { bi } from "../../app/i18n";

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

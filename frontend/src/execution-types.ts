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
  }[];
};

export const isExecutionNodeOnline = (node: ExecutionNode) =>
  !node.disabled &&
  !!node.last_seen &&
  Date.now() - Date.parse(node.last_seen) < 35000;

export function nodeConnection(node: ExecutionNode) {
  if (node.disabled) return { key: "disabled", label: "已暂停接单" };
  if (isExecutionNodeOnline(node)) return { key: "online", label: "已连接" };
  return node.last_seen
    ? { key: "offline", label: "连接中断" }
    : { key: "waiting", label: "等待连接" };
}

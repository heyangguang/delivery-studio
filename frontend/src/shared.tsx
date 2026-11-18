export type DeploymentScheme = {
  source?: string;
  evidence?: string[];
  id?: string;
  name: string;
  nodes: number;
  topology: string;
  contract: NonNullable<AppPlan["contract"]>;
};
import { useEffect, useState, useSyncExternalStore } from "react";
import { Message } from "@arco-design/web-react";
import { bi, biv, getLang, withLang } from "./i18n";

export type Session = {
  username: string;
  role: string;
  csrf: string;
  perms?: string[];
  scope?: string;
  roles?: string[];
  role_names?: string[];
  teams?: string[];
  team_names?: string[];
  session_id?: string;
  auth_type?: string;
  issued_at?: string;
  last_active_at?: string;
  expires_at?: string;
  ttl_seconds?: number;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
};

/* What the signed-in person may do. Set when the session is known; pages ask can() to decide what to show. */
let PERMS = new Set<string>();
let ME = "";
let TEAMS: { id: string; name: string }[] = [];
export const setPerms = (
  ps?: string[],
  who = "",
  teams: { id: string; name: string }[] = [],
) => {
  PERMS = new Set(ps || []);
  ME = who;
  TEAMS = teams;
};
/** The teams the signed-in person belongs to. */
export const myTeams = () => TEAMS;
/** The signed-in person's name. */
export const meName = () => ME;
/** Whether the person holds a permission ("a|b": either). */
export const can = (p: string) => p.split("|").some((x) => PERMS.has(x));

/* ---------- catalog and component schema (the platform's data model) ---------- */

export type RoleSpec = {
  name: string;
  title?: string;
  min: number;
  max: number;
  default?: number;
  exclusive?: boolean;
  initial?: boolean;
  odd?: boolean;
  advise?: number;
  advise_why?: string;
};
/** How many machines a role takes, in words: "1", "≥1", "0–1"; only a real upper bound is shown as one. */
export const roleRange = (r: RoleSpec) =>
  r.max
    ? r.min === r.max
      ? `${r.min}`
      : `${r.min}–${r.max}`
    : bi(`${r.min} 台起`, `≥ ${r.min} nodes`);
export type RoleCount = { role: string; count: number };
export type AppPlan = {
  contract?: {
    when: string;
    series: string;
    failover: string;
    mechanism: string;
    read_access: string;
    sharding: boolean;
    limitations: string[];
    acceptance: string[];
    operations: string[];
  };
  id: string;
  name: string;
  tag?: string;
  spec?: string;
  topology: RoleCount[];
  params?: Record<string, unknown>;
};
export type NamedText = { name: string; text: string };
export type AppDetail = {
  tagline?: string;
  scale?: string;
  capabilities?: NamedText[];
  includes?: NamedText[];
  limits?: string[];
};
export type Artifact = {
  name: string;
  kind: string;
  file: string;
  sha256?: string;
};
export type PackageRequest = { name: string; version: string };
/** Whether the package library holds a version's packages for one operating system, and whether it can be deployed. */
export type Coverage = {
  ready: boolean;
  deployable: boolean;
  missing?: PackageRequest[];
};
export type VersionInfo = {
  id: string;
  status: "draft" | "verifying" | "published" | string;
  platforms?: string[];
  artifacts?: Artifact[];
  packages?: Record<string, PackageRequest[]>;
  coverage?: Record<string, Coverage>;
  released?: string;
  notes?: string[];
};
export type AppInfo = {
  id: string;
  delivery_modes?: string[];
  deployment_available?: boolean;
  /** Default instance id for a new deployment (pg, lb). */
  short?: string;
  name: string;
  category: string;
  description: string;
  tags?: string[];
  /** The component's own logo and tint (names from glyphs.tsx); empty means the category default. */
  icon?: string;
  color?: string;
  /** Declared data flows between roles, used to draw the component's topology. */
  flows?: {
    id: string;
    title: string;
    kind: string;
    from: string;
    to: string;
    sync?: string;
  }[];
  kind?: string;
  provides?: string[];
  /** The default version id. */
  version: string;
  versions: VersionInfo[];
  platform: string;
  available: boolean;
  reason?: string;
  detail?: AppDetail;
  /** The author's operations knowledge (component.yaml operations:). */
  operations?: {
    overview?: string;
    checks?: unknown[];
    tasks?: unknown[];
    faults?: unknown[];
    logs?: unknown[];
  };
  roles: RoleSpec[];
  plans?: AppPlan[];
  materials?: { kind: string; name: string; bytes: number; updated: string }[];
};

export type ParamDef = {
  key: string;
  group?: string;
  label: string;
  type:
    | "int"
    | "float"
    | "bool"
    | "enum"
    | "string"
    | "size"
    | "port"
    | "cidr"
    | "cidr-list"
    | "ip"
    | "host";
  default?: unknown;
  min?: unknown;
  max?: unknown;
  unit?: string;
  options?: string[];
  pattern?: string;
  hint?: string;
  required?: boolean;
  restart?: boolean;
  advanced?: boolean;
  when?: string;
};
export type ParamGroup = {
  id: string;
  label: string;
  scope?: string;
  tab?: string;
};
export type Endpoint = {
  name: string;
  title?: string;
  protocol: string;
  lb?: string;
  note?: string;
};
export type Requirement = {
  capability: string;
  title?: string;
  when?: string;
  default_impl?: string;
};
export type InputDef = {
  name: string;
  label: string;
  kind: string;
  when?: string;
};
export type Addon = {
  id: string;
  title?: string;
  contrib?: boolean;
  builtin?: boolean;
  restart?: boolean;
  since?: string;
  until?: string;
};
export type Schema = {
  delivery_modes?: string[];
  component: string;
  title: string;
  version: string;
  status: string;
  platforms: string[];
  kind?: string;
  provides?: string[];
  roles: RoleSpec[];
  groups: ParamGroup[];
  params: ParamDef[];
  rules?: { id: string; message: string; warn?: boolean }[];
  requires?: Requirement[];
  endpoints?: Endpoint[];
  inputs?: InputDef[];
  addons?: {
    kind: string;
    scope: { name: string; defaults?: string[] };
    items: Addon[];
  };
  lb?: { protocols: string[]; health: string[] };
  presets?: AppPlan[];
};

/* ---------- deployment spec (what an implementer fills in) ---------- */

export type HostSpec = {
  params?: Record<string, unknown>;
  name: string;
  ip: string;
  disk?: string;
  partition?: string;
  initialize?: boolean;
};
export type BindSpec = { endpoint: string; listen?: number; name?: string };
export type AddonSel = {
  id: string;
  databases?: string[];
  params?: Record<string, unknown>;
};
export type InstanceSpec = {
  id: string;
  component: string;
  version?: string;
  placement?: Record<string, string[]>;
  params?: Record<string, unknown>;
  uses?: Record<string, string>;
  binds?: BindSpec[];
  addons?: AddonSel[];
};
export type ExecutionHost = { name: string; ip: string; repository_port: number };
export type Deployment = {
  execution_host?: ExecutionHost;
  delivery_mode?: "offline" | "configuration";
  schema?: string;
  id: string;
  title?: string;
  controller?: string;
  platform?: string;
  hosts: HostSpec[];
  instances: InstanceSpec[];
};

/* ---------- resolution result ---------- */

export type Issue = {
  severity: "error" | "warning";
  path?: string;
  message: string;
};
export type FrontFacts = {
  balancer: string;
  name: string;
  listen: number;
  address: string;
  external: boolean;
  mode?: string;
  resolve_ip?: string;
};
export type InstanceView = {
  scheme?: DeploymentScheme;
  contract?: AppPlan["contract"];
  managed_context?: string;
  id: string;
  component: string;
  title: string;
  version: string;
  status: string;
  auto?: boolean;
  auto_reason?: string;
  external?: boolean;
  roles: Record<string, string[]>;
  role_titles?: Record<string, string>;
  flows?: FlowView[];
  hosts: string[];
  params: Record<string, unknown>;
  visible: Record<string, boolean>;
  endpoints?: {
    name: string;
    title: string;
    protocol: string;
    port: number;
    lb: string;
    note?: string;
    backends?: { host: string; ip: string; port: number; role: string }[];
    health?: { type: string; port?: number; path?: string; status?: number };
  }[];
  ports?: {
    Instance: string;
    Name: string;
    Port: number;
    Proto: string;
    Hosts: string[];
  }[];
  fronts?: Record<string, FrontFacts>;
  uses?: Record<
    string,
    { capability: string; instance: string; component: string }
  >;
};
/** A declared data flow between roles of one instance, resolved to machine names. */
export type FlowView = {
  id: string;
  title: string;
  kind: "replication" | "mesh" | string;
  from: string[];
  to: string[];
  from_role?: string;
  to_role?: string;
  sync?: boolean;
};
export type PlanStep = {
  /** How to undo the step if something goes wrong after it; empty when the component did not say. */
  rollback?: string;
  section: string;
  phase?: string;
  instance?: string;
  id: string;
  title: string;
  desc?: string;
  effect: "read-only" | "change" | "disruptive" | "destructive" | string;
  expect?: string;
  hosts: string[];
  serial?: number;
  playbook?: string;
  command: string;
  confirm?: boolean;
  skipped?: string;
};
export type PlanView = {
  execution_host?: ExecutionHost;
  ok: boolean;
  issues: Issue[];
  controller: string;
  platforms: string[];
  instances: InstanceView[];
  inputs: { instance: string; name: string; label: string; kind: string }[];
  artifacts: { name: string; file: string; kind: string }[];
  phases?: { phase: string; title: string; steps: PlanStep[] }[];
};
export type Resolution = {
  plan: PlanView;
  artifacts: {
    name: string;
    file: string;
    kind: string;
    present: boolean;
    bytes?: number;
  }[];
  packages: { platform: string; total: number; missing: PackageRequest[] };
};

/* ---------- package library ---------- */

export type PlatformDef = {
  id: string;
  title: string;
  family: "apt" | "rpm";
  image: string;
  os_ids: string[];
  version: string;
  arch: string;
};
export type IndexState = {
  platform: string;
  updated?: string;
  imported?: string;
  files: {
    source: string;
    suite: string;
    component: string;
    packages: number;
    date?: string;
  }[];
  packages: number;
};
export type RuntimeInfo = {
  file: string;
  bundle?: string;
  size: number;
  sha256?: string;
  ansible?: string;
  python?: string;
  controller?: string;
  packages: { name: string; version: string }[];
};
export type PlatformStatus = PlatformDef & {
  runtime?: RuntimeInfo;
  deployable: boolean;
  stats: { closures: number; files: number; bytes: number };
  sources: number;
  index: IndexState;
  direct: boolean;
};
export type SearchHit = {
  name: string;
  latest: string;
  versions: number;
  desc?: string;
  source: string;
};
export type VersionDetail = {
  version: string;
  source: string;
  suite: string;
  size: number;
  have: boolean;
};
export type PlanRow = {
  name: string;
  version: string;
  size: number;
  source: string;
  suite: string;
  reason: string;
  upgrade?: boolean;
  have: boolean;
  file: string;
};
export type DepPlan = {
  request: PackageRequest;
  packages: PlanRow[];
  bytes: number;
  download_bytes: number;
  unresolved: string[];
  notes: string[];
  stored: boolean;
};
export type TaskStep = {
  id: string;
  group?: string;
  label: string;
  state: "pending" | "running" | "done" | "skipped" | "failed";
  detail?: string;
  size?: number;
};
export type FetchTask = {
  id: string;
  kind?: "index" | "python" | "";
  steps?: TaskStep[];
  platform: string;
  packages: PackageRequest[];
  state: "running" | "done" | "failed";
  error?: string;
  logs: string[];
  started: string;
  finished?: string;
  by?: string;
};
export type LibraryOverview = {
  platforms: PlatformStatus[];
  busy: boolean;
  last_task: FetchTask | null;
  default_platform: string;
};
export type ClosureRow = {
  request: PackageRequest;
  platform: string;
  files: { file: string; sha256: string; size: number }[];
  packages: { name: string; version: string }[];
  bytes: number;
  fetched: string;
  via: string;
  sources?: string[];
  used_by: string[] | null;
  intact: boolean;
};
export type PackageSource = {
  id: string;
  title: string;
  platforms: string[];
  kind: "apt" | "rpm";
  url?: string;
  suites?: string[];
  components?: string[];
  baseurl?: string;
  key_file?: string;
  disabled?: boolean;
  builtin: boolean;
};

/** The structured handbook stored with a delivery (plan.json). */
export type DeliveryPlan = {
  execution_host?: ExecutionHost;
  delivery_mode?: "offline" | "configuration";
  step_format?: number;
  cluster: string;
  controller: string;
  project?: string;
  project_dir: string;
  upload_dir: string;
  hosts: { name: string; ip: string }[];
  instances: InstanceView[];
  prepare: PlanStep[];
  deploy: {
    phase: string;
    title: string;
    playbook: string;
    command: string;
    steps: PlanStep[];
  }[];
  tests: PlanStep[];
  endpoint_tests: PlanStep[];
  cleanup: PlanStep[];
  warnings?: Issue[];
};

export type Job = {
  delivery_mode?: "offline" | "configuration";
  scheme?: DeploymentScheme;
  id: string;
  owner: string;
  app_id: string;
  app_name: string;
  version: string;
  cluster_id: string;
  state: string;
  stage: string;
  error?: string;
  /** The job's place in its cluster: 0 for the first deployment, then 1, 2, … for the plans after it. */
  seq?: number;
  /** What the engineer reported after working through the runbook. */
  outcome?: Outcome;
  outcome_note?: string;
  marked?: string;
  marked_by?: string;
  /** How far the on-site execution record has got (see the runbook). */
  run_done?: number;
  run_failed?: number;
  run_total?: number;
  revises?: string;
  revised_by?: string;
  /** Times the delivery took a component fix without being made again. */
  syncs?: {
    n: number;
    at: string;
    by: string;
    files: string[];
    steps: string[];
    update?: string;
    remove?: string[];
    kind?: string;
    reason?: string;
  }[];
  created: string;
  updated?: string;
  logs: string[];
};
export type JobRef = {
  delivery_mode?: "offline" | "configuration";
  id: string;
  cluster_id: string;
  app_name: string;
  version: string;
  state: string;
  outcome?: string;
  created: string;
};
export type Change = {
  area: string;
  op: "add" | "remove" | "change";
  label: string;
  from?: string;
  to?: string;
};
/** Where a delivery came from and what was made from it (a change delivery is a new delivery derived from an old one). */
export type Lineage = {
  source?: JobRef;
  children?: JobRef[];
  changes?: Change[];
  source_gone?: boolean;
  revision?: boolean;
};
export type JobFile = { name: string; bytes: number; url: string };
export type JobDetail = {
  job: Job;
  files: JobFile[];
  spec?: { deployment: Deployment; yaml: string } | null;
  plan?: DeliveryPlan | null;
  lineage?: Lineage | null;
};
export type Account = {
  username: string;
  role: string;
  roles?: string[];
  teams?: string[];
  deliveries?: number;
  active?: number;
  last_delivery?: string;
  disabled?: boolean;
};

/* ---------- connectivity ---------- */

let reachable = true;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const setReachable = (v: boolean) => {
  if (reachable !== v) {
    reachable = v;
    emit();
  }
};
if (typeof window !== "undefined") {
  window.addEventListener("online", emit);
  window.addEventListener("offline", emit);
}
/** "offline" = the browser has no network; "unreachable" = network is up but the service did not answer. */
export function useConnectivity(): "online" | "offline" | "unreachable" {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () =>
      !navigator.onLine ? "offline" : reachable ? "online" : "unreachable",
  );
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (f: () => void) => {
  onUnauthorized = f;
};

const TOKEN_STORAGE_KEY = "mw_access_token";
let bearerToken =
  typeof sessionStorage !== "undefined"
    ? sessionStorage.getItem(TOKEN_STORAGE_KEY) || ""
    : "";
export const setAuthToken = (v?: string) => {
  bearerToken = v || "";
  try {
    if (typeof sessionStorage !== "undefined") {
      if (bearerToken) sessionStorage.setItem(TOKEN_STORAGE_KEY, bearerToken);
      else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    /* ignore restricted storage */
  }
};
export const authToken = () => bearerToken;
export const clearAuth = () => {
  csrf = "";
  setAuthToken("");
};

export const formatDuration = (sec?: number): string => {
  const s = Math.max(0, Math.floor(sec || 0));
  if (getLang() === "en-US") {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const remS = s % 60;
    if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    if (h < 24) return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
    const d = Math.floor(h / 24);
    const remH = h % 24;
    return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
  }
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS > 0 ? `${m} 分 ${remS} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM > 0 ? `${h} 小时 ${remM} 分` : `${h} 小时`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH > 0 ? `${d} 天 ${remH} 小时` : `${d} 天`;
};

let csrf = "";
export const setCsrf = (v: string) => {
  csrf = v;
};
export const csrfToken = () => csrf;

export class ApiError extends Error {
  status: number;
  /** The parsed response body, when the server sent structured detail with the error. */
  body?: any;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has("X-Lang")) headers.set("X-Lang", getLang());
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (bearerToken && path !== "/api/login" && !headers.has("Authorization"))
    headers.set("Authorization", `Bearer ${bearerToken}`);
  if (options.method && options.method !== "GET")
    headers.set("X-CSRF-Token", csrf);
  let r: Response;
  try {
    r = await fetch(path, { ...options, headers, credentials: "same-origin" });
  } catch (e) {
    // a request the page called off is not the server being unreachable
    if (options.signal?.aborted) throw e;
    setReachable(false);
    throw new ApiError(
      navigator.onLine
        ? bi("无法连接到服务，请稍后重试", "Unable to connect to the server; please try again later")
        : bi("网络已断开", "Network disconnected"),
      0,
    );
  }
  setReachable(r.status < 502 || r.status > 504);
  const text = await r.text();
  let d: any = {};
  try {
    d = text ? JSON.parse(text) : {};
  } catch {
    if (!r.ok)
      throw new ApiError(
        bi(`服务暂时不可用（${r.status}）`, `Service temporarily unavailable (${r.status})`),
        r.status,
      );
    return text as unknown as T;
  }
  if (r.status === 401 && path !== "/api/login") {
    clearAuth();
    if (path !== "/api/session") onUnauthorized();
  }
  if (!r.ok)
    throw new ApiError(
      d.error || bi(`请求失败（${r.status}）`, `Request failed (${r.status})`),
      r.status,
      d,
    );
  return d;
}

/** Plain-text fetch for generated documents; the server marks them as attachments, fetch ignores that. */
export async function fetchText(url: string): Promise<string> {
  let r: Response;
  try {
    r = await fetch(withLang(url), {
      credentials: "same-origin",
      headers: { "X-Lang": getLang() },
    });
  } catch {
    setReachable(false);
    throw new ApiError(bi("无法连接到服务", "Unable to reach the service"), 0);
  }
  if (!r.ok)
    throw new ApiError(
      bi(`文件读取失败（${r.status}）`, `Failed to read file (${r.status})`),
      r.status,
    );
  return r.text();
}

/* ---------- formatting ---------- */

export const states: Record<string, string> = {
  get queued() { return bi("排队中", "Queued"); },
  get running() { return bi("生成中", "Generating"); },
  get succeeded() { return bi("已生成", "Generated"); },
  get generated() { return bi("已生成", "Generated"); },
  get configuration() { return bi("配置已生成", "Config ready"); },
  get done() { return bi("完成", "Done"); },
  get failed() { return bi("失败", "Failed"); },
};
export const running = (s: string) => s === "queued" || s === "running";
/** What a delivery is called to its owner: generated, then whatever they report after deploying. */
export type Phase = "running" | "generated" | "configuration" | "done" | "failed";
export const phaseOf = (j: Pick<Job, "state" | "outcome" | "delivery_mode">): Phase =>
  running(j.state)
    ? "running"
    : j.state === "failed" || j.outcome === "failed"
      ? "failed"
      : j.outcome === "done" || j.outcome === "deviated"
        ? "done"
        : j.delivery_mode === "configuration" ? "configuration" : "generated";

/* ---------- clusters: one first deployment and the plans made after it (see store_cluster.go) ---------- */

export type Outcome = "done" | "deviated" | "failed" | "void";
export type PlanEntry = {
  delivery_mode?: "offline" | "configuration";
  scheme?: DeploymentScheme;
  id: string;
  seq: number;
  owner: string;
  version: string;
  state: string;
  stage?: string;
  error?: string;
  outcome?: Outcome;
  outcome_note?: string;
  marked?: string;
  marked_by?: string;
  run_done?: number;
  run_failed?: number;
  run_total?: number;
  revises?: string;
  revised_by?: string;
  created: string;
  updated?: string;
};
export type ClusterView = {
  delivery_mode?: "offline" | "configuration";
  scheme?: DeploymentScheme;
  id: string;
  app_id: string;
  app_name: string;
  owner: string;
  version: string;
  platform?: string;
  hosts: number;
  created: string;
  updated: string;
  current?: string;
  head?: string;
  holder?: string;
  plans: PlanEntry[];
  blocked?: string;
};

/* ---------- cluster documents (store_docs.go) ---------- */

export type DocBlock = {
  kind:
    | "h"
    | "p"
    | "note"
    | "table"
    | "code"
    | "list"
    | "image"
    | "section"
    | "old";
  /** Which part of an execution report the block belongs to; blocks without it are always shown. */
  variant?: "auto" | "cmd" | "result";
  detail?: boolean;
  /** The delivery whose pictures an image block lists. */
  job?: string;
  level?: number;
  text?: string;
  head?: string[];
  rows?: string[][];
  items?: string[];
  key?: string;
  title?: string;
  hint?: string;
  ai?: boolean;
  source?: "ai" | "user";
  confirmed?: boolean;
  by?: string;
  at?: string;
  /** The plans carried out after the section was written; it may no longer be true. */
  stale?: string;
};
export type ClusterDoc = {
  id: string;
  kind: "delivery" | "change" | "kt" | "rca" | "assess";
  title: string;
  subtitle?: string;
  cluster: string;
  job?: string;
  cover?: [string, string][];
  blocks?: DocBlock[];
  sections: number;
  empty: number;
  drafts: number;
  stale: number;
  updated?: string;
  /** A root-cause analysis someone started by hand (can be removed). */
  manual?: boolean;
};

/** Where a plan stands, as people say it. */
export type PlanPhase =
  | "generating"
  | "genfailed"
  | "configured"
  | "ready"
  | "running"
  | "done"
  | "deviated"
  | "failed"
  | "void";
export const planPhase = (
  p: Pick<PlanEntry, "state" | "outcome" | "run_done" | "run_failed" | "delivery_mode">,
): PlanPhase =>
  running(p.state)
    ? "generating"
    : p.state === "failed"
      ? "genfailed"
      : p.outcome === "done" ||
          p.outcome === "deviated" ||
          p.outcome === "failed" ||
          p.outcome === "void"
        ? p.outcome
        : p.delivery_mode === "configuration"
          ? "configured"
          : (p.run_done || 0) + (p.run_failed || 0) > 0
          ? "running"
          : "ready";
export const PLAN_PHASE: Record<PlanPhase, { label: string; dot: string }> = {
  generating: { get label() { return bi("生成中", "Generating"); }, dot: "running" },
  genfailed: { get label() { return bi("生成失败", "Build failed"); }, dot: "failed" },
  configured: { get label() { return bi("配置已生成", "Config ready"); }, dot: "generated" },
  ready: { get label() { return bi("待执行", "Ready to run"); }, dot: "generated" },
  running: { get label() { return bi("执行中", "Executing"); }, dot: "running" },
  done: { get label() { return bi("已完成", "Completed"); }, dot: "done" },
  deviated: { get label() { return bi("完成有偏差", "Completed w/ drift"); }, dot: "warn" },
  failed: { get label() { return bi("失败待处理", "Failed"); }, dot: "failed" },
  void: { get label() { return bi("已作废", "Void"); }, dot: "void" },
};
/** "首次部署" or "配置交付" for a first deployment. */
export const planTitle = (p: { delivery_mode?: string }) =>
  p.delivery_mode === "configuration"
    ? bi("配置交付", "Config Delivery")
    : bi("首次部署", "Initial Deploy");
/** The cluster's state in a few words, for its row and header. */
export function clusterStatus(c: ClusterView): {
  label: string;
  dot: string;
  holder?: PlanEntry;
} {
  if (c.delivery_mode === "configuration" && c.current)
    return { label: bi("配置已生成", "Config ready"), dot: "generated" };
  const holder = c.plans.find((p) => p.id === c.holder);
  if (holder) {
    const ph = planPhase(holder);
    const what = planTitle(holder);
    if (ph === "generating")
      return { label: bi(`${what}生成中`, `${what} generating`), dot: "running", holder };
    if (ph === "failed")
      return { label: bi(`${what}失败待处理`, `${what} failed`), dot: "failed", holder };
    return {
      label: bi(
        `${what}${ph === "running" ? "执行中" : "待执行"}`,
        `${what} ${ph === "running" ? "executing" : "ready"}`,
      ),
      dot: ph === "running" ? "running" : "generated",
      holder,
    };
  }
  if (c.head) return { label: bi("运行中", "Running"), dot: "done" };
  if (c.plans.some((p) => p.state === "failed"))
    return { label: bi("生成失败", "Build failed"), dot: "failed" };
  return { label: bi("已作废", "Void"), dot: "void" };
}
export const err = (e: unknown) =>
  Message.error({ content: (e as Error).message, duration: 4000 });
export const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1073741824
        ? `${(n / 1048576).toFixed(1)} MB`
        : `${(n / 1073741824).toFixed(2)} GB`;

const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (s: string) => {
  const d = new Date(s);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fullTime = (s: string) =>
  new Date(s).toLocaleString(getLang(), { hour12: false });
export function dayLabel(s: string) {
  const d = new Date(s);
  const today = new Date();
  const start = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return bi("今天", "Today");
  if (diff === 1) return bi("昨天", "Yesterday");
  if (getLang() === "en-US") {
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
    });
  }
  if (d.getFullYear() === today.getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
export function ago(s: string) {
  const sec = Math.max(
    0,
    Math.round((Date.now() - new Date(s).getTime()) / 1000),
  );
  if (sec < 45) return bi("刚刚", "just now");
  if (sec < 3600) {
    const m = Math.round(sec / 60);
    return bi(`${m} 分钟前`, `${m}m ago`);
  }
  if (sec < 86400) {
    const h = Math.round(sec / 3600);
    return bi(`${h} 小时前`, `${h}h ago`);
  }
  return `${dayLabel(s)} ${clock(s)}`;
}
export function duration(a: string, b: string) {
  const sec = Math.max(
    0,
    Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000),
  );
  return biv(
    sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`,
    sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`,
  );
}

/* ---------- small hooks ---------- */

/** State that survives leaving and re-entering a page within the tab. */
export function useStored<T>(
  key: string,
  initial: T,
): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? ({ ...initial, ...JSON.parse(raw) } as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* storage may be unavailable; the state still works */
    }
  }, [key, v]);
  return [v, setV];
}

/**
 * A preference that survives reloads and new tabs, stored exactly as given (numbers, booleans and lists stay what
 * they are). A stored value of another type than the initial one is ignored, so an old or damaged entry cannot
 * break the page.
 */
export function useLocal<T>(
  key: string,
  initial: T,
): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed = JSON.parse(raw);
      const same = Array.isArray(initial)
        ? Array.isArray(parsed)
        : typeof parsed === typeof initial;
      return same ? (parsed as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* storage may be unavailable; the state still works */
    }
  }, [key, v]);
  return [v, setV];
}

/* ---------- page data that survives leaving the page ---------- */

const memo = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

/** The last answer to a GET, if this tab has fetched it before. A page entered again draws it at once. */
export const cached = <T,>(path: string): T | undefined =>
  memo.get(path) as T | undefined;

/** Stores a fresh response into the in-memory GET cache so revisiting the view renders immediately without skeleton flash. */
export function putCached<T>(path: string, val: T): T {
  memo.set(path, val);
  return val;
}

/** Drops cached GET entries matching a prefix after a mutation invalidates them. */
export function dropCached(prefix: string) {
  for (const k of [...memo.keys()]) {
    if (k.startsWith(prefix)) memo.delete(k);
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("mh-lang-change", () => memo.clear());
}

/** Fetches a GET and keeps the answer for the tab; asking again while it is on its way shares the same request. */
export function fetchCached<T>(path: string): Promise<T> {
  const p = inflight.get(path);
  if (p) return p as Promise<T>;
  const q = api<T>(path)
    .then((r) => {
      memo.set(path, r);
      return r;
    })
    .finally(() => inflight.delete(path));
  inflight.set(path, q);
  return q;
}

/** True only once `on` has stayed true for `ms`: a placeholder that would flash for a moment is not shown at all. */
export function useDelayed(on: boolean, ms = 220) {
  const [v, setV] = useState(false);
  useEffect(() => {
    if (!on) {
      setV(false);
      return;
    }
    const t = setTimeout(() => setV(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return v;
}

export const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, [q]);
  return m;
}

/** True when the keyboard event comes from a text field, so single-key shortcuts stay out of the way. */
export const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  if (t instanceof HTMLInputElement && /^(radio|checkbox|button)$/.test(t.type))
    return false;
  return (
    !!t &&
    (t.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
      !!t.closest("[role=combobox],[role=dialog] input"))
  );
};

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  Message.success({ content: bi("已复制", "Copied"), duration: 1200 });
}

export const platformShort = (id?: string) =>
  !id
    ? ""
    : id === "pypi"
      ? bi("Python 包", "Python packages")
      : id.startsWith("el")
        ? "RHEL " + id.slice(2, 3)
        : id.startsWith("ubuntu")
          ? "Ubuntu " + id.split("-")[1]
          : id;

/* ---------- platform settings ---------- */

export type NotifyChannel = {
  id: string;
  name: string;
  kind: "webhook" | "wecom" | "dingtalk" | "feishu";
  url: string;
  secret?: string;
  enabled: boolean;
  created: string;
};
export type NotifyAttempt = {
  at: string;
  channel: string;
  name: string;
  event: string;
  title: string;
  ok: boolean;
  error?: string;
};
export type Channels = {
  channels: NotifyChannel[];
  kinds: Record<string, string>;
  log: NotifyAttempt[];
};

/** A moment to the second, in local time: 2026-10-25 22:55:03. */
export function stamp(s?: string) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** Large counts the way they are read: 582,775 → 58.3 万 is not clearer, so keep thousands separators and K/M above a million. */
export const num = (n: number) =>
  n >= 1e7 ? `${(n / 1e6).toFixed(1)}M` : n.toLocaleString("en-US");
export const money = (n: number, cur?: string) =>
  `${cur === "USD" ? "$" : "¥"}${n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;

/* ---------- global reactive AI master switch ---------- */

export type AIStatus = {
  enabled: boolean;
  master_enabled?: boolean;
  configured?: boolean;
  features: Record<string, boolean>;
  no_vision?: Record<string, boolean>;
};

const EMPTY_AI_STATUS: AIStatus = {
  enabled: false,
  master_enabled: false,
  configured: false,
  features: {},
  no_vision: {},
};

let aiSnapshot: AIStatus = EMPTY_AI_STATUS;
let aiLoaded = false;
let aiInflight: Promise<AIStatus> | null = null;
const aiListeners = new Set<() => void>();

function normalizeAIStatus(r?: Partial<AIStatus> | null): AIStatus {
  const on = !!r?.enabled;
  return {
    enabled: on,
    master_enabled: r?.master_enabled ?? on,
    configured: r?.configured ?? on,
    features: on ? { ...(r?.features || {}) } : {},
    no_vision: on ? { ...(r?.no_vision || {}) } : {},
  };
}

function clearAICachedCatalogs() {
  memo.delete("/api/ai/models");
  inflight.delete("/api/ai/models");
  memo.delete("/api/ai/options");
  inflight.delete("/api/ai/options");
}

function setAISnapshot(next: AIStatus) {
  aiSnapshot = next;
  memo.set("/api/ai/status", next);
  clearAICachedCatalogs();
  aiListeners.forEach((l) => l());
}

/** Force-refreshes global AI status and broadcasts immediately to every subscribed component. */
export function refreshAIStatus(): Promise<AIStatus> {
  memo.delete("/api/ai/status");
  inflight.delete("/api/ai/status");
  clearAICachedCatalogs();
  if (aiInflight) return aiInflight;
  const p = api<AIStatus>("/api/ai/status")
    .then((r) => {
      aiLoaded = true;
      const next = normalizeAIStatus(r);
      setAISnapshot(next);
      return next;
    })
    .catch(() => {
      aiLoaded = true;
      return aiSnapshot;
    })
    .finally(() => {
      aiInflight = null;
    });
  aiInflight = p;
  return p;
}

/** Resets AI status and session-scoped page caches on sign-out so no stale state leaks across accounts. */
export function resetAIStatus() {
  aiLoaded = false;
  memo.clear();
  inflight.clear();
  clearAICachedCatalogs();
  setAISnapshot(EMPTY_AI_STATUS);
}

/** Reactive global AI status: updates in real time whenever the master switch or providers change. */
export function useAIStatus(): AIStatus {
  const st = useSyncExternalStore(
    (l) => {
      aiListeners.add(l);
      return () => aiListeners.delete(l);
    },
    () => aiSnapshot,
  );
  useEffect(() => {
    if (!aiLoaded && !aiInflight) {
      void refreshAIStatus();
    }
  }, []);
  return st;
}

/** Whether one AI feature is on for this person (reactive to the global master switch). */
export function useAIStatusLite(feature: string): boolean {
  const st = useAIStatus();
  return !!(st.enabled && st.features?.[feature]);
}

/* ---------- AI guided change rehearsal (store_rehearsal.go) ---------- */

export type ScopeQuestion = {
  id: string;
  label?: string;
  question: string;
  options?: string[];
  answer?: string;
};

export type DriftHost = {
  name: string;
  ip: string;
  initial_role: string;
  actual_role: string;
  version?: string;
  status: string;
};

export type DriftParam = {
  key: string;
  initial: string;
  actual: string;
  risk?: string;
};

export type DriftSummary = {
  summary: string;
  drifted: boolean;
  hosts: DriftHost[];
  param_diffs?: DriftParam[];
  risks?: string[];
  recommendations?: string[];
};

export type StepProposal = {
  diagnosis: string;
  action: "replace" | "insert_before";
  title?: string;
  target_role?: string;
  command: string;
  expect?: string;
  rollback?: string;
  risk_note?: string;
};

export type StepRevision = {
  at: string;
  by?: string;
  error_snippet?: string;
  diagnosis: string;
  old_command?: string;
  new_command: string;
};

export type AIAttemptDiag = {
  endpoint: string;
  api: string;
  http_status?: number;
  ms: number;
  response_id?: string;
  upstream_status?: string;
  reason?: string;
  in_tokens?: number;
  out_tokens?: number;
  cached_tokens?: number;
  sse_events?: string[];
  keepalives?: number;
  request_note?: string;
};

export type AICallDiag = {
  provider?: string;
  model?: string;
  api?: string;
  endpoint?: string;
  http_status?: number;
  reason_code?:
    | "empty_output"
    | "http_error"
    | "sse_error"
    | "incomplete"
    | "network_error"
    | "timeout"
    | string;
  response_id?: string;
  upstream_status?: string;
  ms?: number;
  in_tokens?: number;
  out_tokens?: number;
  cached_tokens?: number;
  sse_events?: string[];
  keepalives?: number;
  request_summary?: string;
  response_raw?: string;
  fallback_used?: string;
  attempts?: AIAttemptDiag[];
};

export type RehearsalTraceStep = {
  id: string;
  kind: "inspect" | "guard" | "connect" | "think" | "synthesize" | string;
  title: string;
  detail?: string;
  ms?: number;
  ok: boolean;
  status?: "pending" | "running" | "done" | "warn" | "error";
  diag?: AICallDiag;
};

export type RehearsalTrace = {
  stage: string;
  model?: string;
  provider?: string;
  thinking?: string;
  reasoning?: number;
  steps?: RehearsalTraceStep[];
  in_tokens?: number;
  out_tokens?: number;
  ms?: number;
  at?: string;
  diag?: AICallDiag;
};

export type RehearsalStep = {
  id: string;
  phase: "precheck" | "execute" | "verify" | "rollback";
  order: number;
  title: string;
  target_role: string;
  command: string;
  expect: string;
  risk_note?: string;
  rollback?: string;
  optional?: boolean;
  status: "pending" | "passed" | "failed" | "skipped";
  elapsed?: string;
  note?: string;
  last_error?: string;
  error_images?: string[];
  trouble_trace?: RehearsalTrace | null;
  proposal?: StepProposal | null;
  revisions?: StepRevision[];
};

export type ChangeRehearsal = {
  id: string;
  cluster_id: string;
  app_id: string;
  app_name: string;
  base_job_id: string;
  title: string;
  goal: string;
  goal_images?: string[];
  extra_scope?: string;
  owner: string;
  stage: "scoping" | "probing" | "rehearsing" | "finalized";
  scope_questions?: ScopeQuestion[];
  scope_summary?: string;
  probe_script?: string;
  probe_notes?: string[];
  probe_safe?: boolean;
  probe_warnings?: string[];
  probe_output?: string;
  probe_images?: string[];
  manual_state?: string;
  drift?: DriftSummary | null;
  test_env_note?: string;
  steps?: RehearsalStep[];
  traces?: Record<string, RehearsalTrace>;
  doc_id?: string;
  created_at: string;
  updated_at: string;
};

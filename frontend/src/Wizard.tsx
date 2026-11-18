import { HostParameterFields, hiddenHostFields, hostValue } from "./hostcontract";
import type { HostContract } from "./hostcontract";
import { SchemeInfo } from "./scheme";
import { ExecutionPlacement, ExecutionHostSummary } from "./execution-placement";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { OsName } from "./oslogo";
import {
  FormChat,
  FormGlow,
  diffForm,
  useAIMarks,
  useFormAI,
} from "./formchat";
import { AIStageBar, FormWorkspace } from "./formwork";
import type { Attach, Stage } from "./formchat";
import { uploadFiles, type FileNode } from "./myfiles";
import { Spark, useAIStatus } from "./aichat";
import {
  Button,
  Drawer,
  Input,
  Message,
  Modal,
  Select,
  Spin,
  Switch,
  Tooltip,
  Upload,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheck,
  IconCheckCircleFill,
  IconCode,
  IconDelete,
  IconFile,
  IconExclamationCircleFill,
  IconPlus,
  IconSearch,
} from "@arco-design/web-react/icon";
import { api, ago, copy, err, size, useMedia } from "./shared";
import {
  clearFormDraft,
  draftScope,
  readFormDraft,
  saveFormDraft,
  NEW_DELIVERY_INTENT,
} from "./formdraft";
import type { FormDraft } from "./formdraft";
import { go as navigate } from "./router";
import type {
  AppInfo,
  AppPlan,
  Deployment,
  HostSpec,
  InstanceSpec,
  InstanceView,
  Issue,
  Job,
  JobDetail,
  LibraryOverview,
  ParamDef,
  PlanView,
  Resolution,
  Schema,
} from "./shared";
import { AppGlyph, InstanceGraph, Segmented, Smooth, StatusBadge } from "./ui";
import { FLUSH_INPUTS_EVENT, ParamField, Row, showValue } from "./fields";

/* ---------------------------------------------------------------- schema cache */

const schemas = new Map<string, Promise<Schema>>();
const schemaKey = (c: string, v?: string) => `${c}@${v || ""}`;
function loadSchema(component: string, version?: string): Promise<Schema> {
  const k = schemaKey(component, version);
  let p = schemas.get(k);
  if (!p) {
    p = api<Schema>(
      `/api/components/${encodeURIComponent(component)}${version ? `?version=${encodeURIComponent(version)}` : ""}`,
    );
    p.catch(() => schemas.delete(k));
    schemas.set(k, p);
  }
  return p;
}
/** Schemas for every instance of the deployment, loaded once each. */
function useSchemas(insts: { component: string; version?: string }[]) {
  const [loaded, setLoaded] = useState<Record<string, Schema>>({});
  const key = insts.map((i) => schemaKey(i.component, i.version)).join("|");
  useEffect(() => {
    let live = true;
    for (const i of insts) {
      const k = schemaKey(i.component, i.version);
      loadSchema(i.component, i.version)
        .then((s) => live && setLoaded((m) => (m[k] ? m : { ...m, [k]: s })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [key]);
  return (c: string, v?: string) => loaded[schemaKey(c, v)];
}

/* ---------------------------------------------------------------- deployment helpers */

const idOk = /^[a-z][a-z0-9-]{0,40}$/;
const ipv4 = (v: string) =>
  /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(v);

const hostName = (i: number) => `node-${String(i + 1).padStart(2, "0")}`;

function rolesOf(app: AppInfo) {
  return app.roles || [];
}

/** Versions of a component that exist for an operating system, newest first. */
const versionsFor = (app: AppInfo, platform: string) =>
  app.versions.filter(
    (v) => !v.platforms?.length || v.platforms.includes(platform),
  );

/** The operating system a new deployment starts on: the platform default when the component supports it. */
function firstPlatform(
  app: AppInfo,
  preferred: string,
  deployable: string[],
): string {
  const ok = (id: string) =>
    app.versions.some((v) => v.platforms?.includes(id)) &&
    (!deployable.length || deployable.includes(id));
  if (ok(preferred)) return preferred;
  const any = app.versions.flatMap((v) => v.platforms || []).find(ok);
  return any || preferred;
}

/** A new deployment of one component, sized by a preset (or by the role defaults). */
function startDeployment(
  app: AppInfo,
  plan?: AppPlan,
  platform?: string,
): Deployment {
  plan = plan || app.plans?.[0];
  const roles = rolesOf(app);
  const counts: Record<string, number> = {};
  roles.forEach(
    (r) =>
      (counts[r.name] = plan
        ? (plan.topology.find((t) => t.role === r.name)?.count ?? 0)
        : (r.default ?? r.min)),
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const hosts: HostSpec[] = Array.from(
    { length: Math.max(total, 1) },
    (_, i) => ({
      name: hostName(i),
      ip: "",
      disk: "/dev/vdb",
      initialize: false,
    }),
  );
  const placement: Record<string, string[]> = {};
  let next = 0;
  roles.forEach((r) => {
    placement[r.name] = [];
    for (let k = 0; k < counts[r.name]; k++)
      placement[r.name].push(hosts[next++ % hosts.length].name);
  });
  const pl = platform || firstPlatform(app, "ubuntu-24.04-amd64", []);
  const versions = versionsFor(app, pl);
  const version = versions.find((v) => v.id === app.version)
    ? app.version
    : versions[0]?.id || app.version;
  return {
    schema: "mwdeploy/v1",
    id: "",
    ...(app.delivery_modes?.includes("configuration") &&
      (app.deployment_available === false || !app.delivery_modes.some(m => m === "offline" || m === "automatic"))
      ? {delivery_mode: "configuration" as const} : {}),
    platform: pl,
    hosts,
    instances: [
      {
        id: app.short || app.id,
        component: app.id,
        version,
        placement,
        params: { ...(plan?.params || {}) },
      },
    ],
  };
}

/** Machines to add so that every role has enough distinct machines; existing machines are kept. */
function growHosts(d: Deployment, need: number): HostSpec[] {
  const hosts = [...d.hosts];
  while (hosts.length < need)
    hosts.push({
      name: hostName(hosts.length),
      ip: "",
      disk: "/dev/vdb",
      initialize: false,
    });
  return hosts;
}

const mapInst = (
  d: Deployment,
  id: string,
  f: (i: InstanceSpec) => InstanceSpec,
): Deployment => ({
  ...d,
  instances: d.instances.map((i) => (i.id === id ? f(i) : i)),
});

/** A deployment as the server sees it: no empty optional strings. */
function clean(d: Deployment): Deployment {
  return {
    ...d,
    controller: d.controller || undefined,
    title: d.title || undefined,
    hosts: d.hosts.map((h) => ({
      ...h,
      name: h.name,
      ip: h.ip,
      disk: h.disk || undefined,
      initialize: h.initialize || undefined,
    })),
  };
}

/* ---------------------------------------------------------------- sections */

const SECTIONS: { id: string; title: string; lead: string }[] = [
  {
    id: "basics",
    title: "集群与架构方案",
    lead: "命名集群，选择系统版本与高可用部署方案",
  },
  {
    id: "hosts",
    title: "主机与执行通道",
    lead: "填写目标机器 IPv4、数据盘与控制节点免密执行通道",
  },
  {
    id: "placement",
    title: "角色与拓扑放置",
    lead: "核对各角色节点分布，平台自动补齐依赖组件",
  },
  {
    id: "params",
    title: "关键参数",
    lead: "按需调整核心运行参数，未改动项保持推荐默认值",
  },
  {
    id: "access",
    title: "入口与证书",
    lead: "配置负载均衡、虚拟 IP 与传输加密证书",
  },
];

const uploadKey = (instance: string, name: string, part: string) =>
  `tls:${instance}:${name}:${part}`;

function sectionOf(
  path: string | undefined,
  insts: InstanceSpec[],
  schemaOf: (c: string, v?: string) => Schema | undefined,
): string {
  if (!path || path === "id" || path === "controller" || path === "title")
    return "basics";
  if (path.startsWith("hosts") || path.startsWith("execution_host")) return "hosts";
  const m = /^instances\[([^\]]+)\](?:\.(.*))?$/.exec(path);
  if (!m) return "basics";
  const [, id, rest = ""] = m;
  if (
    rest.startsWith("placement") ||
    rest.startsWith("requires") ||
    rest.startsWith("ports") ||
    rest === ""
  )
    return "placement";
  if (rest.startsWith("binds") || rest.startsWith("uses")) return "access";
  const inst = insts.find((i) => i.id === id);
  const sc = inst && schemaOf(inst.component, inst.version);
  if (sc?.provides?.includes("l4-lb") || sc?.kind === "external")
    return "access";
  return rest.startsWith("params") ||
    rest.startsWith("addons") ||
    rest.startsWith("rules")
    ? "params"
    : "placement";
}

const TAB_LABEL: Record<string, string> = {
  base: "基础",
  ha: "高可用",
  database: "数据库",
  backup: "备份",
  os: "系统",
  main: "参数",
  addons: "扩展",
};

/* ---------------------------------------------------------------- wizard */

type NewDeliveryProps = {
  chat?: string;
  app: AppInfo;
  from?: string;
  /** A first deployment that has not been carried out: change its configuration; the new delivery replaces it. */
  revise?: string;
  preset?: string;
  back: () => void;
  created: (j: Job) => void;
  jobs?: Job[];
  jobsLoading?: boolean;
};

/** Decide whether this entry continues a draft before mounting either the form or its assistant. */
export function NewDelivery(props: NewDeliveryProps) {
  const { app, jobs = [], jobsLoading, back } = props;
  const scope = draftScope(props);
  const [entry, setEntry] = useState(() => {
    let draft = readFormDraft(app.id, scope);
    if (
      draft &&
      !scope &&
      !draft.dep.id &&
      !draft.dep.hosts.some((h) => h.ip)
    ) {
      const candidates = [app.plans?.find((p) => p.id === props.preset)];
      const empty = candidates.some(
        (p) =>
          JSON.stringify(clean(draft!.dep)) ===
          JSON.stringify(clean(startDeployment(app, p, draft!.dep.platform))),
      );
      let conversation = false;
      try {
        conversation = !!JSON.parse(
          sessionStorage.getItem("mh-formchat-" + app.id) || "null",
        )?.used;
      } catch {}
      if (empty && !conversation) {
        clearFormDraft(app.id, scope);
        draft = null;
      }
    }
    if (!draft) clearFormDraft(app.id, scope);
    return { draft, chosen: !draft || !!props.chat, serial: 0 };
  });
  const submittedDraft =
    !entry.chosen &&
    !!entry.draft?.dep.id &&
    !scope &&
    jobs.some((j) => j.cluster_id === entry.draft!.dep.id);
  useEffect(() => {
    if (!submittedDraft) return;
    clearFormDraft(app.id, scope);
    setEntry((e) => ({ draft: null, chosen: true, serial: e.serial + 1 }));
  }, [submittedDraft, app.id, scope]);
  const fresh = () => {
    clearFormDraft(app.id, scope);
    if (props.chat) {
      navigate({ name: "new", app: app.id });
      return;
    }
    setEntry((e) => ({ draft: null, chosen: true, serial: e.serial + 1 }));
  };
  if (submittedDraft || (!entry.chosen && entry.draft && jobsLoading))
    return (
      <div className="center-fill">
        <Spin aria-label="检查未完成的配置" />
      </div>
    );
  if (entry.draft && !entry.chosen)
    return (
      <section className="wz-resume" aria-label="选择继续填写或新建">
        <Button
          type="text"
          className="back"
          icon={<IconArrowLeft />}
          onClick={back}
        >
          返回
        </Button>
        <header>
          <AppGlyph id={app.id} category={app.category} size={40} />
          <div>
            <h1>继续上次的配置，还是新建一份？</h1>
            <p>上次未完成的 {app.name} 配置已保留，选择这次要做的事。</p>
          </div>
        </header>
        <div className="wz-resume-draft">
          <IconFile />
          <div>
            <b>{entry.draft.dep.id || "未命名集群"}</b>
            <span>
              {entry.draft.dep.hosts.length} 台机器
              {entry.draft.updated
                ? ` · ${ago(entry.draft.updated)}保存`
                : " · 未完成的配置"}
            </span>
          </div>
        </div>
        <div className="wz-resume-actions">
          <Button onClick={() => setEntry((e) => ({ ...e, chosen: true }))}>
            继续填写
          </Button>
          <Button type="primary" onClick={fresh}>
            {props.from || props.revise ? "重新填写" : "新建一份"}
          </Button>
        </div>
        <p className="wz-resume-note">
          {props.from || props.revise
            ? "重新填写会清空这份草稿，并重新载入来源配置。"
            : "新建一份会清空这份未完成的配置，从空白表单开始。"}
        </p>
      </section>
    );
  return (
    <DeliveryForm
      key={entry.serial}
      {...props}
      scope={scope}
      resume={entry.draft}
      onRestart={fresh}
    />
  );
}

const FrozenSection = React.memo(
  function FrozenSection({
    render,
  }: {
    hidden: boolean;
    render: () => React.ReactNode;
  }) {
    return <>{render()}</>;
  },
  (prev, next) => prev.hidden && next.hidden,
);

function DeliveryForm({
  app,
  jobs,
  from,
  revise,
  preset,
  back,
  created,
  chat,
  scope,
  resume,
  onRestart,
}: NewDeliveryProps & {
  scope: string;
  resume: FormDraft | null;
  onRestart: () => void;
}) {
  const submitted = useRef(false);
  const [dep, setDep] = useState<Deployment>(
    () =>
      resume?.dep ||
      startDeployment(
        app,
        app.plans?.find((p) => p.id === preset) || undefined,
      ),
  );
  const [plan, setPlan] = useState<string>(resume ? resume.plan : preset || "");
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [res, setRes] = useState<Resolution | null>(null);
  const [resolving, setResolving] = useState(false);
  const sections = SECTIONS;
  const initialSection = sections.some((s) => s.id === resume?.section)
    ? resume!.section!
    : sections[0].id;
  const [sec, setSec] = useState(initialSection);
  const [dir, setDir] = useState(0);
  const [mounted, setMounted] = useState<Set<string>>(
    () => new Set([initialSection]),
  );
  const [tab, setTab] = useState("");
  const [focusInst, setFocusInst] = useState<string>("");
  const [query, setQuery] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [advanced, setAdvanced] = useState<Record<string, boolean>>({});
  const [review, setReview] = useState(false);
  const aiSt = useAIStatus();
  const [yamlOpen, setYamlOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [hostContract, setHostContract] = useState<HostContract>({
    schema: "mw-host-parameters/v1",
    parameters: [],
    rules: [],
  });
  useEffect(() => {
    api<HostContract>("/api/components/platform-shared/parameters")
      .then(setHostContract)
      .catch(err);
  }, []);
  const [origin, setOrigin] = useState<{
    kind: "draft" | "job" | "revise";
    label: string;
  } | null>(
    resume ? { kind: "draft", label: resume.dep.id || "未命名" } : null,
  );
  // the first deployment being revised, to say what the revision changes
  const [revBase, setRevBase] = useState<Deployment | null>(null);
  const [lbCatalog, setLbCatalog] = useState<AppInfo[]>([]);
  const [lib, setLib] = useState<LibraryOverview | null>(null);
  const withPreview = useMedia("(min-width: 1200px)");
  const narrow = useMedia("(max-width: 900px)");

  const schemaOf = useSchemas(dep.instances);

  // Resumed workflows keep their edits; fresh copies start from their source delivery.
  useEffect(() => {
    api<AppInfo[]>("/api/catalog?fronts=1")
      .then((all) =>
        setLbCatalog(all.filter((a) => a.provides?.includes("l4-lb"))),
      )
      .catch(() => {});
    api<LibraryOverview>("/api/library")
      .then((o) => {
        setLib(o);
        // A fresh deployment starts on a system that can actually be deployed.
        setDep((d) => {
          if (resume || from || revise || d.id || d.instances.length !== 1)
            return d;
          const pl = firstPlatform(
            app,
            d.platform || o.default_platform,
            o.platforms.filter((x) => d.delivery_mode === "configuration" || x.deployable).map((x) => x.id),
          );
          return pl === d.platform
            ? d
            : {
                ...d,
                platform: pl,
                instances: d.instances.map((i, ix) =>
                  ix === 0
                    ? {
                        ...i,
                        version:
                          versionsFor(app, pl).find((v) => v.id === i.version)
                            ?.id ||
                          versionsFor(app, pl)[0]?.id ||
                          i.version,
                      }
                    : i,
                ),
              };
        });
      })
      .catch(() => {});
    if (from || revise) {
      api<JobDetail>(`/api/jobs/${from || revise}`)
        .then((d) => {
          if (d.spec?.deployment) {
            const baseDep = revise
              ? {
                  ...d.spec.deployment,
                  id: d.job.cluster_id,
                }
              : d.job.state === "failed"
                ? d.spec.deployment
                : { ...d.spec.deployment, id: "" };
            if (!resume) setDep(baseDep);
            if (revise) setRevBase(d.spec.deployment);
            if (!resume) setPlan("");
            setOrigin({
              kind: revise ? "revise" : "job",
              label: d.job.cluster_id,
            });
          }
        })
        .catch(err)
        .finally(() => setReady(true));
      return;
    }
    if (chat && !resume && aiSt.enabled) {
      api<{ messages: { form?: { deployment?: Deployment } }[] }>(
        `/api/ai/chats/${encodeURIComponent(chat)}`,
      )
        .then((r) => {
          const saved = [...(r.messages || [])]
            .reverse()
            .find((m) => m.form?.deployment)?.form?.deployment;
          if (saved?.instances?.some((i) => i.component === app.id)) {
            setDep(saved);
            setOrigin({ kind: "draft", label: saved.id || "未命名" });
          }
        })
        .catch(err)
        .finally(() => setReady(true));
      return;
    }
    setReady(true);
  }, [from, revise, app.id]);

  // Resolve on every change: the server decides which fields apply, what is added automatically, and what is wrong.
  const seq = useRef(0);
  // a component's status changed elsewhere (published, verified): what the form says about it follows
  const [appsTick, setAppsTick] = useState(0);
  useEffect(() => {
    const h = () => setAppsTick((n) => n + 1);
    window.addEventListener("mh-apps-changed", h);
    window.addEventListener("focus", h);
    return () => {
      window.removeEventListener("mh-apps-changed", h);
      window.removeEventListener("focus", h);
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const n = ++seq.current;
    const ac = new AbortController();
    const t = setTimeout(() => {
      setResolving(true);
      api<Resolution>("/api/resolve", {
        method: "POST",
        body: JSON.stringify(clean(dep)),
        signal: ac.signal,
      })
        .then((r) => n === seq.current && setRes(r))
        .catch((e) => {
          if ((e as Error)?.name === "AbortError") return;
          if (n === seq.current) err(e);
        })
        .finally(() => n === seq.current && setResolving(false));
    }, 250);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [dep, ready, appsTick, review]);

  const pv: PlanView | undefined = res?.plan;
  const issues: Issue[] = pv?.issues || [];
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const instView = (id: string): InstanceView | undefined =>
    pv?.instances.find((i) => i.id === id);
  const specInst = (id: string) => dep.instances.find((i) => i.id === id);
  const set = (p: Partial<Deployment>) => setDep((d) => ({ ...d, ...p }));
  const edit = (id: string, f: (i: InstanceSpec) => InstanceSpec) =>
    setDep((d) => mapInst(d, id, f));
  const setParamByKey = useCallback((id: string, key: string, v: unknown) => {
    setDep((d) =>
      mapInst(d, id, (i) => ({ ...i, params: { ...(i.params || {}), [key]: v } })),
    );
  }, []);
  const resetParamByKey = useCallback((id: string, key: string) => {
    setDep((d) =>
      mapInst(d, id, (i) => {
        const p = { ...(i.params || {}) };
        delete p[key];
        return { ...i, params: p };
      }),
    );
  }, []);
  const issueFor = (path: string) =>
    errors.find((e) => e.path === path)?.message;

  const main = dep.instances[0];
  const mainSchema = main && schemaOf(main.component, main.version);
  const nonLb = dep.instances.filter(
    (i) => !schemaOf(i.component, i.version)?.provides?.includes("l4-lb"),
  );
  const paramInsts = nonLb.filter((i) => !!i.id);
  const lbInstances = dep.instances.filter((i) =>
    schemaOf(i.component, i.version)?.provides?.includes("l4-lb"),
  );
  const autoInstances = (pv?.instances || []).filter((i) => i.auto);

  /* ---- actions ---- */

  function applyPlan(p: AppPlan) {
    if (!main) return;
    // Explicitly adopted dependencies of the previous generated scheme must
    // not survive as unrelated deployments after a scheme switch.
    const related = new Set<string>([main.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const view of pv?.instances || []) {
        if (
          view.managed_context &&
          related.has(view.managed_context) &&
          !related.has(view.id)
        ) {
          related.add(view.id);
          grew = true;
        }
        if (related.has(view.id))
          for (const use of Object.values(view.uses || {})) {
            if (!related.has(use.instance)) {
              related.add(use.instance);
              grew = true;
            }
          }
      }
    }
    // Shared dependencies used by another explicit component are retained.
    const shared = new Set<string>();
    for (const view of pv?.instances || [])
      if (!related.has(view.id)) {
        for (const use of Object.values(view.uses || {}))
          shared.add(use.instance);
      }
    const obsolete = dep.instances.filter(
      (i) =>
        i.id !== main.id &&
        related.has(i.id) &&
        !shared.has(i.id) &&
        (p.contract
          ? instView(main.id)?.contract?.when !== p.contract.when
          : plan !== p.id),
    );
    if (obsolete.length) {
      Modal.confirm({
        title: "切换部署方案？",
        content:
          "将移除原方案中已自行指定的组件配置：" +
          obsolete.map((i) => i.id).join("、") +
          "。新方案会重新计算依赖，并移除不再使用的机器；仍被其他组件使用的机器会保留。",
        okText: "切换方案",
        cancelText: "保留当前方案",
        onOk: () => changePlan(p, new Set(obsolete.map((i) => i.id))),
      });
      return;
    }
    changePlan(p);
  }
  function changePlan(p: AppPlan, remove = new Set<string>()) {
    const count = p.topology.reduce((total, role) => total + role.count, 0);
    const retained = new Set(dep.hosts.slice(0, count).map((h) => h.name));
    for (const instance of dep.instances.slice(1)) {
      if (!remove.has(instance.id))
        for (const host of Object.values(instance.placement || {}).flat())
          retained.add(host);
    }
    const dropped = dep.hosts.filter((h) => !retained.has(h.name) && !!h.ip);
    if (dropped.length) {
      Modal.confirm({
        title: "确认调整机器数量",
        content:
          "切换到「" +
          p.name +
          "」将从当前配置移除：" +
          dropped.map((h) => h.name + "（" + h.ip + "）").join("、") +
          "。这只修改部署表单，不会操作这些机器。",
        okText: "切换并移除",
        cancelText: "保留当前方案",
        onOk: () => commitPlan(p, remove),
      });
      return;
    }
    commitPlan(p, remove);
  }
  function commitPlan(p: AppPlan, remove = new Set<string>()) {
    setPlan(p.id);
    setDep((d) => {
      const fresh = startDeployment(app, p);
      const hosts = growHosts({ ...d, hosts: d.hosts }, fresh.hosts.length);
      const placement: Record<string, string[]> = {};
      let next = 0;
      rolesOf(app).forEach((r) => {
        const n = p.topology.find((t) => t.role === r.name)?.count ?? 0;
        placement[r.name] = [];
        for (let k = 0; k < n; k++)
          placement[r.name].push(hosts[next++ % hosts.length].name);
      });
      const instances = d.instances
        .filter((i) => !remove.has(i.id))
        .map((i, ix) =>
          ix === 0 ? { ...i, placement, params: { ...(p.params || {}) } } : i,
        );
      // A scheme owns its database machines. Keep machines still used by
      // another explicit component, but remove the old scheme's spare nodes.
      const used = new Set(
        instances.flatMap((i) => Object.values(i.placement || {}).flat()),
      );
      const activeHosts = hosts.filter((h) => used.has(h.name));
      return {
        ...d,
        hosts: activeHosts,
        instances,
        controller:
          d.controller && used.has(d.controller) ? d.controller : undefined,
      };
    });
  }
  function startOver() {
    Modal.confirm({
      title: from ? "重新填写这份配置？" : "新建一份交付？",
      content: from
        ? "当前草稿将被清空，重新载入来源交付的配置。"
        : chat
          ? "结束这次对话的填表，返回新建入口。"
          : "当前未完成的配置将被清空，从空白表单开始。",
      okText: from ? "重新填写" : "新建一份",
      cancelText: "继续当前配置",
      onOk: () => {
        submitted.current = true;
        onRestart();
      },
    });
  }
  useEffect(() => {
    window.addEventListener(NEW_DELIVERY_INTENT, startOver);
    return () => window.removeEventListener(NEW_DELIVERY_INTENT, startOver);
  }, [onRestart, from]);
  function setHost(i: number, p: Partial<HostSpec>) {
    setDep((d) => {
      const old = d.hosts[i].name;
      const hosts = d.hosts.map((h, j) => (j === i ? { ...h, ...p } : h));
      // Renaming a machine renames it everywhere it is placed.
      if (p.name !== undefined && p.name !== old) {
        const instances = d.instances.map((inst) => ({
          ...inst,
          placement: Object.fromEntries(
            Object.entries(inst.placement || {}).map(([r, hs]) => [
              r,
              hs.map((h) => (h === old ? p.name! : h)),
            ]),
          ),
        }));
        return {
          ...d,
          hosts,
          instances,
          controller: d.controller === old ? p.name : d.controller,
        };
      }
      return { ...d, hosts };
    });
  }
  function addHost(prefix?: string) {
    setDep((d) => {
      const n = d.hosts.length;
      const name = prefix
        ? `${prefix}-${String(d.hosts.filter((h) => h.name.startsWith(prefix + "-")).length + 1).padStart(2, "0")}`
        : hostName(n);
      return {
        ...d,
        hosts: [
          ...d.hosts,
          { name, ip: "", disk: "/dev/vdb", initialize: false },
        ],
      };
    });
  }
  function removeHost(i: number) {
    setDep((d) => {
      const gone = d.hosts[i].name;
      return {
        ...d,
        hosts: d.hosts.filter((_, j) => j !== i),
        controller: d.controller === gone ? undefined : d.controller,
        instances: d.instances.map((inst) => ({
          ...inst,
          placement: Object.fromEntries(
            Object.entries(inst.placement || {}).map(([r, hs]) => [
              r,
              hs.filter((h) => h !== gone),
            ]),
          ),
        })),
      };
    });
  }
  function fillIPs() {
    const first = dep.hosts[0]?.ip;
    if (!first || !ipv4(first))
      return err(new Error("请先填写第一台机器的 IP"));
    const o = first.split(".").map(Number);
    const base = ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
    setDep((d) => ({
      ...d,
      hosts: d.hosts.map((h, i) =>
        h.ip
          ? h
          : {
              ...h,
              ip: [24, 16, 8, 0]
                .map((s) => Math.floor((base + i) / 2 ** s) % 256)
                .join("."),
            },
      ),
    }));
  }
  /** Turn an automatically added instance into an explicit one so it can be placed and tuned by hand. */
  function takeOver(a: InstanceView) {
    setDep((d) => ({
      ...d,
      instances: [
        ...d.instances,
        {
          id: a.id,
          component: a.component,
          version: a.version,
          placement: Object.fromEntries(
            Object.entries(a.roles).map(([r, hs]) => [r, [...(hs || [])]]),
          ),
          params: {},
        },
      ],
    }));
    setSec("placement");
  }
  function addFront(lb: AppInfo) {
    setDep((d) => {
      let id = lb.short || lb.id;
      for (let n = 2; d.instances.some((i) => i.id === id); n++)
        id = `${lb.short || lb.id}${n}`;
      let hosts = d.hosts;
      const placement: Record<string, string[]> = {};
      if (lb.kind !== "external") {
        rolesOf(lb).forEach((r) => {
          const want = r.default ?? r.min;
          placement[r.name] = [];
          for (let k = 0; k < want; k++) {
            const name = `${lb.short || "lb"}-${String(hosts.filter((h) => h.name.startsWith((lb.short || "lb") + "-")).length + 1).padStart(2, "0")}`;
            hosts = [
              ...hosts,
              { name, ip: "", disk: "/dev/vdb", initialize: false },
            ];
            placement[r.name].push(name);
          }
        });
      }
      const target = d.instances[0];
      const writer = target ? `${target.id}.writer` : "";
      return {
        ...d,
        hosts,
        instances: [
          ...d.instances,
          {
            id,
            component: lb.id,
            version: lb.version,
            placement,
            params: {},
            binds: writer ? [{ endpoint: writer }] : [],
          },
        ],
      };
    });
    setSec("access");
  }
  function removeInstance(id: string) {
    setDep((d) => ({
      ...d,
      instances: d.instances.filter((i) => i.id !== id),
    }));
  }

  async function generate() {
    if (busy || submitted.current || fa.busy || fa.playing) return;
    window.dispatchEvent(new Event(FLUSH_INPUTS_EVENT));
    setBusy(true);
    try {
      const f = new FormData();
      f.set(
        "request",
        JSON.stringify({
          deployment: clean(dep),
          revises: revise || undefined,
        }),
      );
      for (const [k, v] of Object.entries(files)) if (v) f.set(k, v);
      const job = await api<Job>("/api/jobs", { method: "POST", body: f });
      submitted.current = true;
      clearFormDraft(app.id, scope);
      created(job);
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  }

  /* ---- navigation ---- */

  const order = sections.map((x) => x.id);
  useEffect(() => {
    if (!ready) return;
    const next = order.find((id) => !mounted.has(id));
    if (!next) return;
    const idle = (
      window as unknown as {
        requestIdleCallback?: (
          f: () => void,
          o?: { timeout: number },
        ) => number;
      }
    ).requestIdleCallback;
    const h = idle
      ? idle(() => setMounted((m) => new Set(m).add(next)), { timeout: 1200 })
      : window.setTimeout(() => setMounted((m) => new Set(m).add(next)), 250);
    return () =>
      idle
        ? (
            window as unknown as { cancelIdleCallback: (n: number) => void }
          ).cancelIdleCallback(h)
        : clearTimeout(h);
  }, [ready, mounted]);
  const openSection = (id: string) => {
    window.dispatchEvent(new Event(FLUSH_INPUTS_EVENT));
    if (!order.includes(id)) id = order[0];
    setModeRaw((m) => (m === "choose" ? "form" : m));
    // with the assistant, opening a step shows it in place of the conversation
    if (modeNow.current === "ai") setAiView(id);
    setDir(order.indexOf(id) >= order.indexOf(sec) ? 1 : -1);
    setMounted((m) => (m.has(id) ? m : new Set(m).add(id)));
    setSec(id);
    setReview(false);
    document.querySelector(".wz-pane-body")?.scrollTo({ top: 0 });
  };
  const step = (d: number) => {
    window.dispatchEvent(new Event(FLUSH_INPUTS_EVENT));
    const i = order.indexOf(sec) + d;
    if (i >= order.length) reviewNow();
    else if (i >= 0) openSection(order[i]);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  const issueSection = (x: Issue) => {
    const id = sectionOf(x.path, dep.instances, schemaOf);
    return order.includes(id) ? id : order[0];
  };
  const secIssues = (id: string) =>
    errors.filter((x) => issueSection(x) === id).length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        review ||
        yamlOpen ||
        document.querySelector(".arco-modal-wrapper,.pal-mask")
      )
        return;
      if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        stepRef.current(e.key === "ArrowDown" ? 1 : -1);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        stepRef.current(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [review, yamlOpen]);

  /* ---- render helpers ---- */

  /** All parameter groups of one instance, tabbed when the component declares tabs. */
  function paramsPanel(
    id: string,
    opts: {
      tabbed?: boolean;
      tabState?: [string, (t: string) => void];
      onlyChanged?: boolean;
    } = {},
  ) {
    const inst = specInst(id);
    const view = instView(id);
    const sc = inst && schemaOf(inst.component, inst.version);
    if (!inst || !sc) return <Spin />;
    const revInst = revBase?.instances.find((i) => i.id === id);
    const visible = (d: ParamDef) =>
      !app.plans?.some(
        (p) => p.params?.[d.key] !== undefined && d.key === "deployment_mode",
      ) && view?.visible?.[d.key] !== false;
    const value = (d: ParamDef) =>
      view?.params ? view.params[d.key] : d.default;
    const changedKey = (d: ParamDef) => inst.params?.[d.key] !== undefined;
    const q = opts.tabbed ? query.trim().toLowerCase() : "";
    const filterChanged = Boolean(opts.tabbed && opts.onlyChanged);
    const groups = sc.groups.length ? sc.groups : [{ id: "", label: "参数" }];
    const tabsOrder: string[] = [];
    groups.forEach((g) => {
      const t = (g as { tab?: string }).tab || "main";
      if (
        !tabsOrder.includes(t) &&
        sc.params.some((d) => (d.group || "") === g.id && visible(d))
      )
        tabsOrder.push(t);
    });
    if (sc.addons?.items.length) tabsOrder.push("addons");
    const tabbed = opts.tabbed && tabsOrder.length > 1;
    const active = tabbed
      ? tabsOrder.includes(opts.tabState![0])
        ? opts.tabState![0]
        : tabsOrder[0]
      : "";
    const field = (d: ParamDef) => (
      <ParamField
        key={d.key}
        ai={`instances[${id}].params.${d.key}`}
        d={d}
        value={value(d)}
        changed={changedKey(d)}
        bad={issueFor(`instances[${id}].params.${d.key}`)}
        instanceId={id}
        onParamChange={setParamByKey}
        onParamReset={resetParamByKey}
        was={
          revBase &&
          JSON.stringify(inst.params?.[d.key]) !==
            JSON.stringify(revInst?.params?.[d.key])
            ? showValue(revInst?.params?.[d.key] ?? d.default)
            : undefined
        }
      />
    );
    if (q || filterChanged) {
      const found = sc.params.filter(
        (d) =>
          visible(d) &&
          (!filterChanged || changedKey(d)) &&
          (!q || (d.label + d.key + (d.hint || "")).toLowerCase().includes(q)),
      );
      return (
        <div className="tune-body">
          <div className="wz-tune-meta">
            <span className="muted small num">
              {filterChanged && !q
                ? `已修改 ${found.length} 项参数`
                : `找到 ${found.length} 项匹配参数`}
            </span>
            {found.length === 0 && (
              <button
                type="button"
                className="link small"
                onClick={() => {
                  setQuery("");
                  setOnlyChanged(false);
                }}
              >
                清除筛选
              </button>
            )}
          </div>
          {found.length > 0 && <div className="params">{found.map(field)}</div>}
        </div>
      );
    }
    const groupBlock = (g: { id: string; label: string; scope?: string }) => {
      const list = sc.params.filter(
        (d) => (d.group || "") === g.id && visible(d),
      );
      if (!list.length) return null;
      const adv = list.filter((d) => d.advanced);
      const k = `${id}/${g.id}`;
      const shown = list.filter(
        (d) => !d.advanced || advanced[k] || changedKey(d),
      );
      return (
        <div className="pgroup" key={g.id}>
          <div className="pgroup-head">
            <h4>{g.label}</h4>
            {g.scope && <span className="scope">{g.scope}</span>}
            {adv.length > 0 && (
              <button
                className="link"
                onClick={() => setAdvanced((a) => ({ ...a, [k]: !a[k] }))}
                aria-expanded={!!advanced[k]}
              >
                {advanced[k] ? "收起高级参数" : `显示高级参数 ${adv.length}`}
              </button>
            )}
          </div>
          <div className="params">{shown.map(field)}</div>
        </div>
      );
    };
    const tabChanged = (t: string) =>
      sc.params.filter(
        (d) =>
          changedKey(d) &&
          ((
            groups.find((g) => g.id === (d.group || "")) as
              { tab?: string } | undefined
          )?.tab || "main") === t,
      ).length;
    return (
      <>
        {tabbed && (
          <div className="tune-bar">
            <Segmented
              size="sm"
              label="参数分类"
              value={active}
              onChange={opts.tabState![1]}
              options={tabsOrder.map((t) => ({
                value: t,
                label: (
                  <>
                    {TAB_LABEL[t] || t}
                    {t !== "addons" && tabChanged(t) > 0 && (
                      <em className="mark-n num">{tabChanged(t)}</em>
                    )}
                  </>
                ),
              }))}
            />
          </div>
        )}
        <div className="tune-body" key={active}>
          {active === "addons"
            ? addonsPanel(id)
            : groups
                .filter(
                  (g) =>
                    !tabbed ||
                    ((g as { tab?: string }).tab || "main") === active,
                )
                .map(groupBlock)}
        </div>
      </>
    );
  }

  function addonsPanel(id: string) {
    const inst = specInst(id);
    const sc = inst && schemaOf(inst.component, inst.version);
    if (!inst || !sc?.addons) return null;
    const scope = sc.addons.scope;
    return (
      <div className="addons">
        <p className="muted small">
          {scope.name === "database"
            ? "集群刚建好时还没有业务库，所以默认装进 template1：以后新建的数据库自动带上这个扩展，不用再逐个库处理。已存在的扩展保留，不自动升级。"
            : `按${scope.name}安装。已存在的保留，不自动升级。`}
        </p>
        {sc.addons.items.map((a) => {
          const sel = inst.addons?.find((x) => x.id === a.id);
          return (
            <div key={a.id} className={`addon ${sel ? "on" : ""}`}>
              <label>
                <Switch
                  size="small"
                  checked={!!sel}
                  onChange={(on) =>
                    edit(id, (i) => ({
                      ...i,
                      addons: on
                        ? [...(i.addons || []), { id: a.id }]
                        : (i.addons || []).filter((x) => x.id !== a.id),
                    }))
                  }
                  aria-label={a.title || a.id}
                />
                <b>{a.title || a.id}</b>
                {a.builtin && <span className="flag">通常已存在</span>}
                {a.restart && <span className="flag">需重启</span>}
              </label>
              {sel && scope.name === "database" && (
                <AddonTarget
                  value={sel.databases || []}
                  defaults={scope.defaults || []}
                  label={a.title || a.id}
                  onChange={(databases) =>
                    edit(id, (i) => ({
                      ...i,
                      addons: (i.addons || []).map((x) =>
                        x.id === a.id ? { ...x, databases } : x,
                      ),
                    }))
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    );
  }

  function placementEditor(inst: InstanceSpec) {
    const sc = schemaOf(inst.component, inst.version);
    if (!sc) return <Spin />;
    if (sc.kind === "external")
      return <p className="muted small">由客户自行运维，不放置到机器上。</p>;
    const contract = instView(inst.id)?.contract;
    const selectedScheme = app.plans?.find(
      (p) => p.contract?.when === contract?.when,
    );
    const allowedRoles =
      contract?.series === "basic" && selectedScheme
        ? sc.roles.filter((role) =>
            selectedScheme.topology.some(
              (r) => r.role === role.name && r.count > 0,
            ),
          )
        : sc.roles;
    return (
      <div className="place">
        {contract?.series === "basic" && (
          <p className="muted small">
            基础系列只放置一个节点；需要从节点请先切换部署方案。
          </p>
        )}
        {allowedRoles.map((r) => {
          const cur = inst.placement?.[r.name] || [];
          const range = r.max
            ? r.min === r.max
              ? `固定 ${r.min} 台`
              : `${r.min}–${r.max} 台`
            : r.min
              ? `至少 ${r.min} 台`
              : "可不放置";
          const bad = issueFor(`instances[${inst.id}].placement.${r.name}`);
          return (
            <div className={`place-row ${bad ? "is-bad" : ""}`} key={r.name}>
              <div className="place-role">
                <div className="place-role-top">
                  <b>{r.title || r.name}</b>
                  <span
                    className={`wz-role-cnt num ${bad ? "bad" : cur.length > 0 ? "ok" : ""}`}
                  >
                    已选 {cur.length} 台
                  </span>
                </div>
                <small>
                  {range}
                  {r.odd ? " · 建议奇数" : ""}
                  {r.exclusive ? " · 独占机器" : ""}
                </small>
              </div>
              <Select
                mode="multiple"
                value={cur}
                triggerProps={{ autoFitPosition: true }}
                options={dep.hosts.map((h) => ({
                  value: h.name,
                  label: `${h.name}${h.ip ? ` (${h.ip})` : ""}`,
                }))}
                placeholder="选择机器"
                onChange={(v) =>
                  edit(inst.id, (i) => ({
                    ...i,
                    placement: {
                      ...(i.placement || {}),
                      [r.name]: v as string[],
                    },
                  }))
                }
                aria-label={`${inst.id} ${r.title || r.name} 放置`}
                status={bad ? "error" : undefined}
              />
              {bad && <span className="place-bad">{bad}</span>}
            </div>
          );
        })}
      </div>
    );
  }

  const endpointOptions = useMemo(() => {
    const out: { value: string; label: string; disabled?: boolean }[] = [];
    (pv?.instances || []).forEach((i) =>
      (i.endpoints || []).forEach((e) =>
        out.push({
          value: `${i.id}.${e.name}`,
          label: `${i.id}.${e.name} · ${e.title}${e.lb === "none" ? "（不适合放在负载均衡后）" : ""}`,
          disabled: e.lb === "none",
        }),
      ),
    );
    return out;
  }, [pv]);

  function frontCard(inst: InstanceSpec) {
    const sc = schemaOf(inst.component, inst.version);
    const view = instView(inst.id);
    return (
      <div className="front" key={inst.id} data-ai={`instances[${inst.id}]`}>
        <div className="front-head">
          <AppGlyph id={inst.component} category="负载均衡" size={28} />
          <div>
            <b>{sc?.title || inst.component}</b>
            <small className="mono">
              {inst.id}
              {view ? ` · ${view.version}` : ""}
            </small>
          </div>
          {view && (
            <StatusBadge
              state={view.status === "published" ? "done" : "queued"}
              label={view.status === "published" ? "已发布" : "待验证"}
            />
          )}
          <Button
            type="text"
            status="danger"
            icon={<IconDelete />}
            onClick={() => removeInstance(inst.id)}
            aria-label={`删除入口 ${inst.id}`}
          />
        </div>
        <h5>代理的端点</h5>
        <div className="binds">
          {(inst.binds || []).map((b, i) => (
            <div className="bind-row" key={i}>
              <Select
                value={b.endpoint}
                options={endpointOptions}
                triggerProps={{
                  autoFitPosition: true,
                  autoAlignPopupWidth: false,
                  autoAlignPopupMinWidth: true,
                }}
                onChange={(v) =>
                  edit(inst.id, (x) => ({
                    ...x,
                    binds: (x.binds || []).map((y, j) =>
                      j === i ? { ...y, endpoint: v } : y,
                    ),
                  }))
                }
                aria-label="代理的端点"
              />
              <Input
                className="mono-in"
                value={b.listen ? String(b.listen) : ""}
                placeholder="监听端口（留空同后端）"
                onChange={(v) =>
                  edit(inst.id, (x) => ({
                    ...x,
                    binds: (x.binds || []).map((y, j) =>
                      j === i
                        ? { ...y, listen: v ? Number(v) || 0 : undefined }
                        : y,
                    ),
                  }))
                }
                aria-label="监听端口"
              />
              <Button
                type="text"
                icon={<IconDelete />}
                onClick={() =>
                  edit(inst.id, (x) => ({
                    ...x,
                    binds: (x.binds || []).filter((_, j) => j !== i),
                  }))
                }
                aria-label="移除"
              />
              {issueFor(`instances[${inst.id}].binds[${i}]`) && (
                <span className="place-bad">
                  {issueFor(`instances[${inst.id}].binds[${i}]`)}
                </span>
              )}
            </div>
          ))}
          <button
            className="link"
            onClick={() =>
              edit(inst.id, (x) => ({
                ...x,
                binds: [
                  ...(x.binds || []),
                  {
                    endpoint:
                      endpointOptions.find((o) => !o.disabled)?.value || "",
                  },
                ],
              }))
            }
          >
            + 添加端点
          </button>
          {errors
            .filter((e) => e.path === `instances[${inst.id}].binds`)
            .map((e, i) => (
              <span className="place-bad" key={i}>
                {e.message}
              </span>
            ))}
        </div>
        {sc?.kind !== "external" && (
          <>
            <h5>放置</h5>
            {placementEditor(inst)}
            <button className="link" onClick={() => addHost(inst.id)}>
              + 为它添加一台新机器
            </button>
          </>
        )}
        <h5>参数</h5>
        {paramsPanel(inst.id)}
        {autoInstances
          .filter((a) => a.auto_reason?.includes(sc?.title || inst.component))
          .map((a) => (
            <div key={a.id} className="note">
              平台已自动加入 <b>{a.title}</b>（{a.id}）：{a.auto_reason}
              ，与它同机部署。
            </div>
          ))}
      </div>
    );
  }

  const upload = (key: string, label: string, required = false) => (
    <div className="cert-row" key={key}>
      <div>
        <b>{label}</b>
        <span>{required ? "必需" : "可选"}</span>
      </div>
      <Upload
        autoUpload={false}
        limit={1}
        fileList={
          files[key]
            ? [
                {
                  uid: key,
                  name: files[key]!.name,
                  originFile: files[key],
                  status: "done",
                },
              ]
            : []
        }
        accept={
          key.endsWith("private_key") ? ".key,.pem" : ".p7b,.p7c,.pem,.crt,.cer"
        }
        onChange={(list) => {
          const picked = list[0]?.originFile;
          if (picked && picked.size > 2 * 1024 * 1024)
            return err(new Error("单个文件不超过 2 MiB"));
          setFiles((o) => ({ ...o, [key]: picked }));
        }}
      >
        {!files[key] && (
          <Button size="small" icon={<IconPlus />} aria-label={`选择${label}`}>
            选择文件
          </Button>
        )}
      </Upload>
    </div>
  );
  // a plan made from a delivery keeps that delivery's certificates (the server reads them from it)
  // the cluster id is the cluster: a first deployment cannot take one that already has a live delivery
  const idTaken =
    !revise &&
    !!dep.id &&
    (jobs || []).some(
      (j) =>
        j.cluster_id === dep.id && j.state !== "failed" && j.outcome !== "void",
    );
  const revised = useMemo(
    () => (revBase ? diffForm(revBase, dep, schemaOf, app.id) : []),
    [revBase, dep, schemaOf, app.id],
  );
  const missingUploads = revise
    ? []
    : (pv?.inputs || []).flatMap((i) =>
        ["certificate", "private_key"]
          .filter((p) => !files[uploadKey(i.instance, i.name, p)])
          .map((p) => ({ i, p })),
      );

  /* ---- section bodies ---- */

  const pickVersion = (v: string) =>
    edit(main.id, (i) => ({ ...i, version: v }));
  const platform = dep.platform || "ubuntu-24.04-amd64";
  const deployableIds = (lib?.platforms || [])
    .filter((x) => x.deployable)
    .map((x) => x.id);
  const platformChoices = (lib?.platforms || []).filter((x) =>
    app.versions.some((v) => v.platforms?.includes(x.id)),
  );

  /* ---- the form assistant: talk the form through; it writes here as you watch and you confirm once ---- */
  const pane = useRef<HTMLElement>(null);
  const secNow = useRef(sec);
  secNow.current = sec;
  const stageFns = useRef<Stage>(null!);
  stageFns.current = {
    open: openSection,
    // a parameter is on one tab of one instance: open those so its field is on the page
    reveal: (path) => {
      const m = /^instances\[([^\]]+)\]\.params\.(.+)$/.exec(path);
      if (!m) return;
      const inst = dep.instances.find((i) => i.id === m[1]);
      const sc = inst && schemaOf(inst.component, inst.version);
      const d = sc?.params.find((x) => x.key === m[2]);
      const g = sc?.groups.find((x) => x.id === (d?.group || "")) as
        { tab?: string } | undefined;
      setQuery("");
      setOnlyChanged(false);
      setFocusInst(m[1]);
      setTab(g?.tab || "main");
    },
    current: () => secNow.current,
    viewing: () =>
      modeNow.current === "ai"
        ? aiViewNow.current === "chat"
          ? ""
          : aiViewNow.current
        : secNow.current,
    pane: () => pane.current,
  };
  const stage = useMemo<Stage>(
    () => ({
      open: (x) => stageFns.current.open(x),
      reveal: (x) => stageFns.current.reveal(x),
      current: () => stageFns.current.current(),
      pane: () => stageFns.current.pane(),
      viewing: () => stageFns.current.viewing(),
    }),
    [],
  );
  const putFilesRef = useRef<
    (
      l: { part: string; name: string; data: string }[],
      t?: { instance: string; name: string },
    ) => void
  >(() => {});
  const fa = useFormAI({
    putFiles: (l, t) => putFilesRef.current(l, t),
    app: { id: app.id, name: app.name, version: app.version },
    dep,
    setDep,
    platforms: platformChoices.map((x) => x.id),
    schemaOf,
    stage,
    chat,
    enabled: ready,
    onSwitch:
      from || revise
        ? undefined
        : (target, next, conversation) => {
            const targetScope = "chat:" + conversation;
            if (
              !saveFormDraft(target, targetScope, {
                dep: next,
                plan: "",
                mode: "ai",
                aiView: "chat",
                updated: new Date().toISOString(),
              })
            ) {
              Message.warning(
                "浏览器暂时无法保存草稿，将从已保存的对话恢复配置",
              );
            }
            navigate({ name: "new", app: target, chat: conversation });
            Message.success("已切换组件，需求与对话已保留");
          },
    draftScope: scope,
    canPersist: () => !submitted.current,
  });
  // Certificates are checked as soon as they are chosen, against the entry domain the form has now: a wrong file or a
  // mistyped domain is said here, not when the delivery is generated.
  type CertCheck = {
    ok: boolean;
    error?: string;
    domain?: string;
    names?: string[];
    not_after?: string;
    busy?: boolean;
  };
  const [certChecks, setCertChecks] = useState<Record<string, CertCheck>>({});
  const fronts = JSON.stringify(
    dep.instances
      .filter((i) => i.binds?.length)
      .map((i) => [i.params, i.binds]),
  );
  useEffect(() => {
    const inputs = pv?.inputs || [];
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      for (const inp of inputs) {
        const k = (part: string) => uploadKey(inp.instance, inp.name, part);
        if (!files[k("certificate")] || !files[k("private_key")]) {
          setCertChecks((c) =>
            c[inp.instance] ? (({ [inp.instance]: _, ...rest }) => rest)(c) : c,
          );
          continue;
        }
        const f = new FormData();
        f.set(
          "request",
          JSON.stringify({ deployment: clean(dep), instance: inp.instance }),
        );
        for (const part of [
          "certificate",
          "private_key",
          "ca_cert",
          "intermediates",
        ])
          if (files[k(part)]) f.set(part, files[k(part)]!);
        setCertChecks((c) => ({
          ...c,
          [inp.instance]: { ...(c[inp.instance] || { ok: false }), busy: true },
        }));
        api<CertCheck>("/api/certificates/check", {
          method: "POST",
          body: f,
          signal: ac.signal,
        })
          .then((r) => setCertChecks((c) => ({ ...c, [inp.instance]: r })))
          .catch(
            (e) =>
              (e as Error).name !== "AbortError" &&
              setCertChecks((c) => ({
                ...c,
                [inp.instance]: { ok: false, error: (e as Error).message },
              })),
          );
      }
    }, 400);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [files, fronts, JSON.stringify(pv?.inputs || [])]); // eslint-disable-line react-hooks/exhaustive-deps
  const certBad = Object.entries(certChecks).filter(
    ([, c]) => !c.ok && !c.busy && c.error,
  );
  /* Files given to the assistant: any file. They are kept in the person's files and sent with the next message; the
     assistant looks inside (a p7b, a bundle, a key), works out what belongs where, and puts the result into the form's
     certificate slots. Private keys are only read on the server, never shown to the model. */
  const SLOT_LABEL: Record<string, string> = {
    certificate: "证书",
    private_key: "私钥",
    ca_cert: "CA 证书",
    intermediates: "中间证书",
  };
  const certTarget = (pv?.inputs || [])[0];
  const [chatFiles, setChatFiles] = useState<FileNode[]>([]);
  const [chatUp, setChatUp] = useState(0);
  const addChatFiles = async (picked: File[]) => {
    const ok = picked.filter((f) => {
      if (f.size > 4 * 1024 * 1024) {
        Message.warning(`${f.name} 超过 4 MiB，没有添加`);
        return false;
      }
      return true;
    });
    if (!ok.length) return;
    if (chatFiles.length + ok.length > 8)
      return void Message.warning("一条消息最多附带 8 个文件");
    setChatUp((n) => n + ok.length);
    try {
      const r = await uploadFiles(ok, "", "chat");
      setChatFiles((x) => [...x, ...r.added]);
      r.failed.forEach((m) => Message.warning(m));
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
      setChatUp((n) => n - ok.length);
    }
  };
  putFilesRef.current = (list, target) => {
    const where = target || certTarget;
    if (!where) return;
    const next: Record<string, File> = {};
    for (const x of list) {
      if (!SLOT_LABEL[x.part]) continue;
      const bin = atob(x.data);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      next[uploadKey(where.instance, where.name, x.part)] = new File(
        [bytes],
        x.name,
        { type: "text/plain" },
      );
    }
    setFiles((o) => ({ ...o, ...next }));
  };
  const slotFile = (part: string) =>
    certTarget
      ? files[uploadKey(certTarget.instance, certTarget.name, part)]
      : undefined;
  const certAttach: Attach | undefined = fa.on
    ? {
        accept: "",
        list: [
          ...chatFiles.map((f) => ({
            id: "f:" + f.id,
            name: f.name,
            slot: "待发送",
          })),
          ...Object.keys(SLOT_LABEL)
            .filter((part) => slotFile(part))
            .map((part) => ({
              id: part,
              name: slotFile(part)!.name,
              slot: SLOT_LABEL[part],
            })),
        ],
        waiting: chatFiles.length,
        busy: chatUp > 0,
        take: () => {
          const files = chatFiles.map((f) => ({
            id: f.id,
            name: f.name,
            mime: f.mime,
            size: f.size,
          }));
          setChatFiles([]);
          return files;
        },
        add: addChatFiles,
        remove: (id) => {
          if (id.startsWith("f:"))
            return setChatFiles((x) => x.filter((f) => "f:" + f.id !== id));
          if (certTarget)
            setFiles((o) => ({
              ...o,
              [uploadKey(certTarget.instance, certTarget.name, id)]: undefined,
            }));
        },
        note: () => {
          const out: string[] = [];
          const have = certTarget
            ? Object.keys(SLOT_LABEL).filter((part) => slotFile(part))
            : [];
          if (have.length) {
            const chk = certTarget && certChecks[certTarget.instance];
            out.push(
              `表单里已有：${have.map((part) => `${SLOT_LABEL[part]} ${slotFile(part)!.name}`).join("、")}${chk && !chk.busy ? `；平台核对：${chk.ok ? "证书与域名匹配" : chk.error || "未通过"}` : ""}`,
            );
          }
          return out.length ? `（${out.join("。")}）` : "";
        },
      }
    : undefined;

  // How a new cluster starts: the first screen asks nothing but offers both ways at once (typing to the assistant is
  // choosing it; "fill it in yourself" is the other). Coming back to a draft, copying a delivery, a plan or a preset skips it.
  const [mode, setModeRaw] = useState<"choose" | "form" | "ai">(
    () => resume?.mode || (from || revise || resume ? "form" : "ai"),
  );
  // with the assistant the middle of the page is the conversation ("chat") or one step of the form, never both at once
  const [aiView, setAiView] = useState<string>(resume?.aiView || "chat");
  const modeNow = useRef(mode);
  modeNow.current = mode;
  const aiViewNow = useRef(aiView);
  aiViewNow.current = aiView;
  useEffect(() => {
    if (fa.started && (!resume?.mode || resume.mode === "ai" || chat))
      setModeRaw("ai");
    else if (origin) setModeRaw((m) => (m === "choose" ? "form" : m));
  }, [fa.started, origin]);
  /** Changes the way of filling in, the box moving between its places (a view transition) where the browser can. */
  const setMode = (m: "choose" | "form" | "ai"): Promise<unknown> => {
    const go = () =>
      flushSync(() => {
        setModeRaw(m);
        if (m === "ai") setAiView("chat");
      });
    const vt = (
      document as unknown as {
        startViewTransition?: (f: () => void) => {
          finished: Promise<void>;
          updateCallbackDone: Promise<void>;
        };
      }
    ).startViewTransition;
    if (!vt || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      go();
      return Promise.resolve();
    }
    // this transition only: the side columns hold still, the page fades out, the box flies, the form rises (formchat.css)
    const html = document.documentElement;
    html.classList.add("fc-vt");
    const t = vt.call(document, go);
    t.finished.finally(() => html.classList.remove("fc-vt"));
    // resolves once the page shows the form: what happens next (the message going out) is part of the new page
    return t.updateCallbackDone.catch(() => undefined);
  };
  useAIMarks(
    pane,
    fa.marks,
    `${sec}:${tab}:${focusInst}:${query}:${onlyChanged}:${mode}:${aiView}`,
  );
  const cleanDepStr = useMemo(() => JSON.stringify(clean(dep)), [dep]);
  const pristineStr = useMemo(
    () =>
      JSON.stringify(
        clean(
          startDeployment(
            app,
            app.plans?.find((p) => p.id === preset),
            dep.platform,
          ),
        ),
      ),
    [app, preset, dep.platform],
  );
  const [draftError, setDraftError] = useState(false);
  const draftDataRef = useRef<{
    pristine: boolean;
    payload: FormDraft;
  } | null>(null);
  draftDataRef.current = {
    pristine: !from && !revise && !fa.started && cleanDepStr === pristineStr,
    payload: {
      dep,
      plan,
      section: sec,
      mode,
      aiView,
      updated: "",
    },
  };
  useEffect(() => {
    if (!ready || submitted.current) return;
    if (draftDataRef.current?.pristine) {
      clearFormDraft(app.id, scope);
      return;
    }
    const t = window.setTimeout(() => {
      const snap = draftDataRef.current;
      if (!snap || submitted.current) return;
      if (snap.pristine) {
        clearFormDraft(app.id, scope);
        return;
      }
      setDraftError(
        !saveFormDraft(app.id, scope, {
          ...snap.payload,
          updated: new Date().toISOString(),
        }),
      );
    }, 250);
    return () => window.clearTimeout(t);
  }, [
    cleanDepStr,
    pristineStr,
    plan,
    sec,
    mode,
    aiView,
    ready,
    fa.started,
    app.id,
    scope,
    from,
    revise,
  ]);
  useEffect(
    () => () => {
      if (!ready || submitted.current) return;
      const snap = draftDataRef.current;
      if (!snap || snap.pristine) return;
      saveFormDraft(app.id, scope, {
        ...snap.payload,
        updated: new Date().toISOString(),
      });
    },
    [app.id, scope, ready],
  );
  const choosing = mode === "choose" && fa.on;
  // with the assistant the step list steps aside: the page is the conversation, or one step of the form
  const aiFocus = mode === "ai" && fa.on;
  const aiChat = aiFocus && aiView === "chat";
  // the assistant called up from the form gets the cursor; arriving from the first screen it is already answering
  // nothing is generated while changes of the assistant wait for the person's confirmation
  const reviewNow = () => {
    window.dispatchEvent(new Event(FLUSH_INPUTS_EVENT));
    if (!fa.pending) return setReview(true);
    fa.nudge();
    Message.info("先确认或撤销 AI 的改动");
  };
  const pickPlatform = (id: string) =>
    setDep((d) => {
      const vs = versionsFor(app, id);
      return {
        ...d,
        platform: id,
        instances: d.instances.map((i, ix) =>
          ix === 0 && !vs.some((v) => v.id === i.version)
            ? { ...i, version: vs[0]?.id || i.version }
            : i,
        ),
      };
    });
  const versionNote = (id: string) => {
    const v = app.versions.find((x) => x.id === id);
    const cv = v?.coverage?.[platform];
    if (v?.status !== "published") return "尚未在空环境验证，不要用于生产";
    return dep.delivery_mode !== "configuration" && cv && !cv.ready
      ? `软件库缺 ${cv.missing?.length ?? 0} 个软件包`
      : "已发布";
  };
  const idFormatHint = !dep.id
    ? ""
    : !/^[a-z]/.test(dep.id)
      ? "需以小写英文字母（a-z）开头"
      : dep.id.length > 41
        ? "标识长度不超过 41 个字符"
        : !idOk.test(dep.id)
          ? "仅支持小写英文字母、数字与连字符（-）"
          : "";

  const hostNameCounts = new Map<string, number>();
  const hostIpCounts = new Map<string, number>();
  dep.hosts.forEach((h) => {
    if (h.name) hostNameCounts.set(h.name, (hostNameCounts.get(h.name) || 0) + 1);
    if (h.ip) hostIpCounts.set(h.ip, (hostIpCounts.get(h.ip) || 0) + 1);
  });
  const readyIpCount = dep.hosts.filter(
    (h) => ipv4(h.ip) && (hostIpCounts.get(h.ip) || 0) === 1,
  ).length;
  const hostLocalIssue = (h: HostSpec, i: number): string | undefined => {
    if (!h.name.trim()) return "请填写机器名称";
    if ((hostNameCounts.get(h.name) || 0) > 1) return `机器名称 ${h.name} 重复`;
    if (h.ip && !ipv4(h.ip)) return "IPv4 地址格式不正确（示例：10.0.1.11）";
    if (h.ip && ipv4(h.ip) && (hostIpCounts.get(h.ip) || 0) > 1)
      return `IPv4 地址 ${h.ip} 与其他机器重复`;
    return issueFor(`hosts[${i}]`);
  };

  const activeParamId =
    focusInst && paramInsts.some((i) => i.id === focusInst)
      ? focusInst
      : paramInsts[0]?.id || "";
  const activeParamInst = specInst(activeParamId);
  const activeParamSc =
    activeParamInst &&
    schemaOf(activeParamInst.component, activeParamInst.version);
  const activeParamChangedCount = (activeParamSc?.params || []).filter(
    (d) => activeParamInst?.params?.[d.key] !== undefined,
  ).length;

  const bodies: Record<string, React.ReactNode> = {
    basics: (
      <>
        <Row label="交付内容" hint="先生成可审核的材料。选择自动执行、步骤和机器，在生成后的交付页面确认。" wide>
          <Select aria-label="交付内容" value={dep.delivery_mode||"offline"} onChange={v=>set({delivery_mode:v})} triggerProps={{autoFitPosition:true,autoAlignPopupWidth:false,autoAlignPopupMinWidth:true}} options={[
            {value:"offline",label:"生成部署材料（离线手动执行 / 已授权的自动执行）",disabled:!!mainSchema?.delivery_modes && !mainSchema.delivery_modes.some(m=>m==="offline"||m==="automatic")},
            {value:"configuration",label:"仅生成配置文件，不部署",disabled:!mainSchema?.delivery_modes?.includes("configuration")}
          ]}/>
        </Row>
        <Row
          label="集群标识"
          hint="集群的唯一标识；小写字母开头，只包含小写字母、数字与连字符"
          wide
          ai="id"
        >
          <div className="wz-id-row">
            <Input
              className="cluster-in"
              value={dep.id}
              onChange={(v) => set({ id: v.trim() })}
              placeholder="pg-order-prod"
              aria-label="集群标识"
              autoFocus={!origin}
              disabled={!!revise}
              status={
                dep.id && (Boolean(idFormatHint) || idTaken) ? "error" : undefined
              }
            />
            {dep.id && !idFormatHint && !idTaken && (
              <span className="wz-id-ok">
                <IconCheck /> 可用
              </span>
            )}
          </div>
          {idFormatHint && (
            <div className="field-warn" role="alert">
              {idFormatHint}
            </div>
          )}
          {!idFormatHint && idTaken && (
            <div className="field-warn" role="alert">
              集群标识 {dep.id} 已被使用，请更换一个标识。
            </div>
          )}
        </Row>
        <div className="fgrid">
          <Row
            ai="platform"
            label="操作系统"
            hint={
              dep.delivery_mode === "configuration"
                ? "配置文件按这个系统和组件版本生成；不需要安装运行环境"
                : deployableIds.includes(platform)
                ? "所有机器必须是这个系统；软件包按它从软件库取"
                : "这个系统还没有 Ansible 运行环境，暂时不能生成交付"
            }
          >
            <Segmented
              label="操作系统"
              value={platform}
              onChange={pickPlatform}
              options={(platformChoices.length
                ? platformChoices
                : [{ id: platform, title: platform, deployable: true }]
              ).map((x) => ({
                value: x.id,
                label: <OsName id={x.id} title={x.title} />,
                disabled: dep.delivery_mode !== "configuration" && !x.deployable,
              }))}
            />
          </Row>
          <Row
            label="版本"
            hint={versionNote(main?.version || app.version)}
            ai="version"
          >
            <Segmented
              label="版本"
              value={main?.version || app.version}
              onChange={pickVersion}
              options={versionsFor(app, platform).map((v) => ({
                value: v.id,
                label: v.id,
              }))}
            />
          </Row>
          <Row label="说明（可选）" hint="显示在交付列表里" ai="title">
            <Input
              value={dep.title || ""}
              onChange={(v) => set({ title: v })}
              placeholder="订单库生产集群"
              aria-label="说明"
            />
          </Row>
        </div>
        {!!app.plans?.length && (
          <section className="wz-sub" aria-label="部署架构方案">
            <div className="wz-sub-top">
              <h3>部署架构方案</h3>
              <span className="muted small">
                切换方案将自动同步所需机器台数与角色拓扑
              </span>
            </div>
            <div className="plans" role="radiogroup" aria-label="常用方案">
              {app.plans.map((p) => {
                const isSelected = p.contract
                  ? instView(main?.id || "")?.contract?.when === p.contract.when
                  : plan === p.id;
                const nodeCount = p.topology.reduce((s, t) => s + t.count, 0);
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    className={`plan ${isSelected ? "on" : ""}`}
                    onClick={() => applyPlan(p)}
                  >
                    <span className="plan-meta">
                      {nodeCount > 0 && (
                        <span className="plan-tag num">{nodeCount} 台节点</span>
                      )}
                      {p.contract && (
                        <span
                          className={`plan-ha ${p.contract.failover === "automatic" ? "ok" : ""}`}
                        >
                          {p.contract.failover === "automatic"
                            ? "自动切换"
                            : p.contract.failover === "manual"
                              ? "人工切换"
                              : "无故障切换"}
                        </span>
                      )}
                    </span>
                    <strong>{p.name}</strong>
                    <span>{p.spec}</span>
                    {p.contract && (
                      <small className="plan-mech">{p.contract.mechanism}</small>
                    )}
                  </button>
                );
              })}
              {!app.plans.some((p) => p.contract) && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={plan === ""}
                  className={`plan ${plan === "" ? "on" : ""}`}
                  onClick={() => setPlan("")}
                >
                  <span className="plan-meta">
                    <span className="plan-tag">自由组合</span>
                  </span>
                  <strong>自定义</strong>
                  <span>按需调整机器数量与角色放置</span>
                </button>
              )}
            </div>
            {pv?.instances.find((i) => i.id === main?.id)?.contract &&
              (() => {
                const contract = pv.instances.find(
                  (i) => i.id === main?.id,
                )!.contract!;
                return (
                  <div className="wz-contract-note" role="note">
                    <p>{contract.read_access}</p>
                    {contract.limitations.length > 0 && (
                      <p className="muted">{contract.limitations.join("；")}</p>
                    )}
                  </div>
                );
              })()}
          </section>
        )}
      </>
    ),
    hosts: (
      <>
        <div className="wz-host-bar">
          <span
            className={`wz-host-stat num ${readyIpCount === dep.hosts.length && dep.hosts.length > 0 ? "ok" : ""}`}
          >
            {readyIpCount === dep.hosts.length && dep.hosts.length > 0 && (
              <IconCheck />
            )}
            <span>
              IPv4 已填写 <b>{readyIpCount}</b> / {dep.hosts.length} 台
            </span>
          </span>
          <div className="row-gap">
            {dep.hosts.length > 1 && (
              <button type="button" className="link" onClick={fillIPs}>
                按首台 IP 依次补全空白
              </button>
            )}
            <Button size="small" icon={<IconPlus />} onClick={() => addHost()}>
              添加机器
            </Button>
          </div>
        </div>
        <div className="host-table" role="table" aria-label="机器">
          <div className="hosts-head" role="row">
            <span>名称</span>
            <span>IPv4</span>
            <span>数据盘</span>
            <span>初始化</span>
            <span />
          </div>
          {dep.hosts.map((h, i) => {
            const rowErr = hostLocalIssue(h, i);
            const badName =
              !h.name.trim() || (hostNameCounts.get(h.name) || 0) > 1;
            const badIp =
              Boolean(h.ip) &&
              (!ipv4(h.ip) || (hostIpCounts.get(h.ip) || 0) > 1);
            return (
              <div
                className={`host-row ${rowErr ? "is-bad" : ""}`}
                key={i}
                role="row"
                data-ai={`hosts[${i}]`}
              >
                <Input
                  value={h.name}
                  onChange={(v) => setHost(i, { name: v.trim() })}
                  className="mono-in"
                  aria-label={`机器 ${i + 1} 名称`}
                  status={
                    badName || (issueFor(`hosts[${i}]`) && !badIp)
                      ? "error"
                      : undefined
                  }
                />
                <Input
                  value={h.ip}
                  onChange={(v) => setHost(i, { ip: v.trim() })}
                  placeholder={`10.0.1.${11 + i}`}
                  className="mono-in"
                  aria-label={`机器 ${i + 1} IPv4`}
                  status={badIp ? "error" : undefined}
                />
                {hiddenHostFields(h, hostContract).has("disk") ? (
                  <span className="muted">
                    {hostValue(h, hostContract, "params.storage_mode") ===
                    "system_directory"
                      ? "系统盘目录 " +
                        String(
                          hostValue(h, hostContract, "params.data_root") ||
                            "/data",
                        )
                      : "无需独立数据盘"}
                  </span>
                ) : (
                  <Select
                    value={h.disk || ""}
                    onChange={(v) => setHost(i, { disk: v })}
                    allowCreate
                    allowClear
                    triggerProps={{
                      autoFitPosition: true,
                      autoAlignPopupWidth: false,
                      autoAlignPopupMinWidth: true,
                    }}
                    options={[
                      "/dev/vdb",
                      "/dev/vdc",
                      "/dev/sdb",
                      "/dev/sdc",
                      "/dev/nvme1n1",
                    ]}
                    placeholder="无数据盘"
                    aria-label={`机器 ${i + 1} 数据盘`}
                  />
                )}
                {hiddenHostFields(h, hostContract).has("initialize") ? (
                  <span className="muted">不初始化</span>
                ) : (
                  <Tooltip
                    content={
                      h.initialize
                        ? "会格式化这块盘，仅用于全新空盘"
                        : "关闭时使用已有挂载：" +
                          String(
                            hostValue(h, hostContract, "params.data_root") ||
                              "/data",
                          )
                    }
                    mini
                  >
                    <span>
                      <Switch
                        size="small"
                        checked={!!h.initialize}
                        onChange={(v) => setHost(i, { initialize: v })}
                        aria-label={`机器 ${i + 1} 初始化数据盘`}
                      />
                    </span>
                  </Tooltip>
                )}
                <Button
                  type="text"
                  status="danger"
                  icon={<IconDelete />}
                  disabled={dep.hosts.length <= 1}
                  onClick={() => removeHost(i)}
                  aria-label={`删除机器 ${h.name}`}
                />
                <HostParameterFields
                  host={h}
                  index={i}
                  contract={hostContract}
                  onChange={(v) => setHost(i, v)}
                />
                {rowErr && (
                  <span className="place-bad host-bad">{rowErr}</span>
                )}
              </div>
            );
          })}
        </div>
        {dep.hosts.some((h) => h.initialize) && (
          <div className="note warn">
            已选择初始化数据盘：会对所列设备分区并格式化，盘上有任何签名、分区或数据时会停止。
          </div>
        )}
        {dep.delivery_mode !== "configuration" && (
          <ExecutionPlacement
            dep={dep}
            controller={pv?.controller}
            onChange={set}
          />
        )}
      </>
    ),
    placement: (
      <>
        {dep.instances.map((inst) => {
          const sc = schemaOf(inst.component, inst.version);
          if (sc?.provides?.includes("l4-lb")) return null;
          return (
            <section
              className="wz-sub"
              key={inst.id}
              aria-label={inst.id}
              data-ai={`instances[${inst.id}].placement`}
            >
              <h3>
                {sc?.title || inst.component}{" "}
                <small className="mono">{inst.id}</small>
              </h3>
              {placementEditor(inst)}
            </section>
          );
        })}
        {autoInstances.filter((a) => !specInst(a.id)).length > 0 && (
          <section className="wz-sub" aria-label="自动加入的组件">
            <h3>平台自动加入</h3>
            {autoInstances
              .filter((a) => !specInst(a.id))
              .map((a) => (
                <div className="auto" key={a.id}>
                  <div>
                    <b>{a.title}</b>{" "}
                    <span className="mono small">
                      {a.id} · {a.version}
                    </span>
                    <small>{a.auto_reason}</small>
                    <small>
                      放置：
                      {Object.entries(a.roles)
                        .map(([r, hs]) => `${r}：${(hs || []).join("、")}`)
                        .join("；")}
                    </small>
                  </div>
                  {a.managed_context ? (
                    <span className="muted small">
                      由 {a.managed_context}{" "}
                      的部署方案管理，节点与配置随数据库同步
                    </span>
                  ) : (
                    <Button size="small" onClick={() => takeOver(a)}>
                      自行指定
                    </Button>
                  )}
                </div>
              ))}
            <p className="muted small">
              需要独立机器、不同端口或不同版本时，点“自行指定”把它变成一个可编辑的实例。
            </p>
          </section>
        )}
        {dep.instances.filter(
          (i) =>
            !!i.id &&
            specInst(i.id) &&
            i !== main &&
            !schemaOf(i.component, i.version)?.provides?.includes("l4-lb"),
        ).length > 0 && (
          <p className="muted small">已自行指定的组件可以在“关键参数”一步调整。</p>
        )}
      </>
    ),
    params: (
      <>
        <div className="wz-tune-top">
          {paramInsts.length > 1 && (
            <Segmented
              label="组件"
              value={activeParamId}
              onChange={setFocusInst}
              options={paramInsts.map((i) => ({
                value: i.id,
                label: i.id,
              }))}
            />
          )}
          <div className="wz-tune-filters">
            {(activeParamChangedCount > 0 || onlyChanged) && (
              <button
                type="button"
                className={`wz-changed-toggle num ${onlyChanged ? "on" : ""}`}
                onClick={() => setOnlyChanged((v) => !v)}
                aria-pressed={onlyChanged}
              >
                仅看已改 ({activeParamChangedCount})
              </button>
            )}
            <Input
              allowClear
              prefix={<IconSearch />}
              className="tune-search"
              placeholder="搜索参数，如 shared_buffers"
              value={query}
              onChange={setQuery}
              aria-label="搜索参数"
            />
          </div>
        </div>
        {paramInsts.length > 0 &&
          paramsPanel(activeParamId, {
            tabbed: true,
            tabState: [tab, setTab],
            onlyChanged,
          })}
      </>
    ),
    access: (
      <>
        <section className="wz-sub" aria-label="入口">
          <h3>入口（负载均衡）</h3>
          <p className="muted small">
            应用通过一个稳定的入口连接。可以用本平台部署的 HAProxy、Nginx（可加
            keepalived 虚拟 IP），也可以由客户的云 ELB
            提供，平台只给出配置清单。
          </p>
          {lbInstances.map(frontCard)}
          <div className="row-gap">
            {lbCatalog.map((lb) => (
              <Button
                key={lb.id}
                icon={<IconPlus />}
                disabled={!lb.available}
                onClick={() => addFront(lb)}
                title={lb.available ? undefined : lb.reason}
              >
                添加 {lb.name}
              </Button>
            ))}
          </div>
        </section>
        {(pv?.inputs.length || 0) > 0 && (
          <section className="wz-sub" aria-label="证书">
            <h3>证书</h3>
            {pv!.inputs.map((inp) => (
              <div className="certs" key={`${inp.instance}/${inp.name}`}>
                <p className="muted small">
                  <b>{inp.instance}</b> · {inp.label}。PEM 或 P7B
                  均可，私钥要是没有加密的 PEM 格式；私钥只会放进控制节点的包。
                </p>
                <div className="cert-list">
                  {upload(
                    uploadKey(inp.instance, inp.name, "certificate"),
                    "服务器证书",
                    true,
                  )}
                  {upload(
                    uploadKey(inp.instance, inp.name, "private_key"),
                    "私钥（未加密 PEM）",
                    true,
                  )}
                  {upload(
                    uploadKey(inp.instance, inp.name, "ca_cert"),
                    "根 CA",
                  )}
                  {upload(
                    uploadKey(inp.instance, inp.name, "intermediates"),
                    "中间证书链",
                  )}
                </div>
                {certChecks[inp.instance] && (
                  <div
                    className={`cert-check ${certChecks[inp.instance].busy ? "busy" : certChecks[inp.instance].ok ? "ok" : "bad"}`}
                    role="status"
                  >
                    {certChecks[inp.instance].busy ? (
                      <span>正在检查证书…</span>
                    ) : certChecks[inp.instance].ok ? (
                      <>
                        <IconCheckCircleFill />
                        <span>
                          证书和私钥是一对，证书链有效
                          {certChecks[inp.instance].domain
                            ? `，包含入口域名 ${certChecks[inp.instance].domain}`
                            : ""}
                          {certChecks[inp.instance].not_after
                            ? ` · 有效期至 ${certChecks[inp.instance].not_after!.slice(0, 10)}`
                            : ""}
                        </span>
                      </>
                    ) : (
                      <>
                        <IconExclamationCircleFill />
                        <span>{certChecks[inp.instance].error}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}
      </>
    ),
  };

  const totalBlocking = errors.length + missingUploads.length + certBad.length;
  // nothing filled in yet: what is missing is not news, so it is not shown (nothing is wrong yet)
  const untouched =
    !from &&
    !revise &&
    !Object.values(files).some(Boolean) &&
    cleanDepStr === pristineStr;
  const sum: Record<string, string> = {
    basics: `${dep.id || "未命名"} · ${main?.version || ""}`,
    hosts: `${dep.hosts.length} 台 · IPv4 ${readyIpCount}/${dep.hosts.length}`,
    placement: `${pv?.instances.filter((i) => !i.external).length ?? dep.instances.length} 个实例${autoInstances.length ? ` · 自动 ${autoInstances.length}` : ""}`,
    params: `${dep.instances.reduce((n, i) => n + Object.keys(i.params || {}).length, 0)} 项已调整`,
    access: lbInstances.length ? `${lbInstances.length} 个入口` : "未配置入口",
  };

  const idx = order.indexOf(sec);
  const cur = sections[idx] || sections[0];
  const nextSec = sections[idx + 1];
  const goIssue = (x: Issue) => openSection(issueSection(x));
  const issueList = (limit?: number) => (
    <div className="issues">
      {(limit ? errors.slice(0, limit) : errors).map((x, i) => {
        const sec = sections.find((s) => s.id === issueSection(x));
        // a plan only edits what it is about; a problem elsewhere is the source delivery's, and is said as such
        return sec ? (
          <button key={i} onClick={() => goIssue(x)}>
            <span className="issue-sec">{sec.title}</span>
            {x.message}
          </button>
        ) : (
          <div key={i} className="issue-src">
            <span className="issue-sec">原交付</span>
            {x.message}
          </div>
        );
      })}
      {certBad.map(([inst, c]) => (
        <button key={`cert-${inst}`} onClick={() => openSection("access")}>
          <span className="issue-sec">入口与证书</span>
          {inst} 的证书：{c.error}
        </button>
      ))}
      {missingUploads
        .slice(0, limit ? Math.max(0, limit - errors.length) : undefined)
        .map(({ i, p }) => (
          <button
            key={`${i.instance}${p}`}
            onClick={() => openSection("access")}
          >
            <span className="issue-sec">入口与证书</span>
            上传 {i.instance} 的{p === "certificate" ? "服务器证书" : "私钥"}
          </button>
        ))}
      {limit && totalBlocking > limit && (
        <span className="more">还有 {totalBlocking - limit} 项</span>
      )}
    </div>
  );

  const project = dep.id || "…";
  const packageHosts = dep.execution_host ? [...dep.hosts, dep.execution_host] : dep.hosts;
  const pkgName = (i: number) =>
    `node${String(i + 1).padStart(2, "0")}-${project}-${packageHosts[i]?.ip || "…"}.tar.gz`;
  const plannedHosts = pv ? dep.hosts : dep.hosts;
  const art = res?.artifacts || [];

  if (!ready || !main)
    return (
      <div className="center-fill">
        <Spin />
      </div>
    );

  const secTitles = Object.fromEntries(sections.map((x) => [x.id, x.title]));
  const issueTexts = [
    ...errors.map((x) => x.message),
    ...certBad.map(([inst, c]) => `${inst} 的证书：${c.error}`),
    ...missingUploads.map(
      ({ i, p }) =>
        `上传 ${i.instance} 的${p === "certificate" ? "服务器证书" : "私钥"}`,
    ),
  ];

  const previewBody = (
    <>
      <div className="preview-head">
        <span>交付预览</span>
        <strong className="mono">{dep.id || "未命名集群"}</strong>
        {/* checking with the server: a dot in a fixed place, never a row that comes and goes */}
        <i
          className={`pv-sync ${resolving ? "on" : ""}`}
          title={resolving ? "正在核对" : undefined}
          aria-hidden
        />
      </div>
      <ExecutionHostSummary host={dep.execution_host} />
      <Smooth>
        {pv ? (
          <InstanceGraph
            hosts={dep.hosts}
            instances={pv.instances}
            controller={pv.controller}
          />
        ) : (
          <Spin />
        )}
      </Smooth>
      <Smooth>
        <div className="pinst">
          {(pv?.instances || []).map((i) => (
            <div key={i.id} className="pinst-row">
              <span className="mono">{i.id}</span>
              <span>
                {i.title} {i.version}
              </span>
              {i.auto && <span className="flag info">自动</span>}
              {i.status !== "published" && (
                <span className="flag warn">待验证</span>
              )}
              {/* an entry's address in full, on its own line: the diagram has room only for a shortened one */}
              {Object.values(i.fronts || {}).map((f) =>
                f.address ? (
                  <small key={f.address + f.listen} className="pinst-addr mono">
                    入口 {`${f.address}:${f.listen}`}
                  </small>
                ) : null,
              )}
            </div>
          ))}
        </div>
      </Smooth>
      <Smooth>
        <div className="pfiles">
          <span className="pfiles-h">将生成</span>
          {dep.delivery_mode === "configuration" ? (
            <div className="pfile">
              <span className="role-chip">配置</span>
              <span className="mono">configuration.zip</span>
            </div>
          ) : (
            packageHosts.map((h, i) => (
              <div key={i} className="pfile">
                <span
                  className={`role-chip ${h.name === pv?.controller ? "p" : ""}`}
                >
                  {h.name === pv?.controller
                    ? dep.execution_host
                      ? "执行"
                      : "控制"
                    : "业务"}
                </span>
                <span className="mono">{pkgName(i)}</span>
              </div>
            ))
          )}
          {res?.packages && res.packages.total > 0 && (
            <div className="pfile">
              <span className="role-chip">软件</span>
              <span className="mono">
                packages-{res.packages.platform}.tar.gz
              </span>
              {res.packages.missing.length ? (
                <a
                  className="bad small"
                  href={`#/library/${res.packages.platform}`}
                >
                  缺 {res.packages.missing.length} 个，去软件库
                </a>
              ) : (
                <span className="faint num">
                  {res.packages.total} 个软件包版本
                </span>
              )}
            </div>
          )}
          {art.map((a) => (
            <div key={a.file} className="pfile">
              <span className="role-chip">材料</span>
              <span className="mono">{a.file}</span>
              {a.present ? (
                a.bytes ? (
                  <span className="faint num">{size(a.bytes)}</span>
                ) : null
              ) : (
                <span className="bad small">材料库缺失</span>
              )}
            </div>
          ))}
          <div className="pfile">
            <span className="role-chip">手册</span>
            <span>
              {dep.delivery_mode === "configuration"
                ? "配置交付说明 · 部署规格"
                : `环境准备 · 部署 · 功能测试${lbInstances.length ? " · 入口测试" : ""} · 清理`}
            </span>
          </div>
        </div>
      </Smooth>
      <Smooth>
        {pv?.phases && (
          <div className="pphases">
            <span className="pfiles-h">部署阶段</span>
            {pv.phases.map((ph) => (
              <div key={ph.phase} className="pphase">
                <b>{ph.title}</b>
                <small>{ph.steps.length} 步</small>
              </div>
            ))}
          </div>
        )}
        {warnings.length > 0 && (
          <div className="preview-warns">
            {warnings.slice(0, 4).map((w, i) => (
              <div key={i} className="note warn">
                {w.message}
              </div>
            ))}
          </div>
        )}
        {untouched ? (
          <div className="preview-idle">
            填写后，这里会告诉你还缺什么，以及能不能生成。
          </div>
        ) : totalBlocking > 0 ? (
          <div className="preview-issues">
            <div className="pi-head">
              <IconExclamationCircleFill /> 待完善 {totalBlocking}
            </div>
            {issueList(5)}
          </div>
        ) : (
          <div className="preview-ready">
            <IconCheckCircleFill /> 可以生成
          </div>
        )}
      </Smooth>
      <Button type="primary" long size="large" onClick={reviewNow}>
        核对并生成
      </Button>
    </>
  );

  return (
    <div
      className={`wz ${withPreview ? "" : "no-preview"} ${aiFocus ? "ai-focus" : ""} ${aiChat ? "ai-chat" : ""}`}
    >
      <aside className="wz-side" aria-label="配置分区">
        <Button
          type="text"
          className="back"
          icon={<IconArrowLeft />}
          onClick={back}
        >
          返回
        </Button>
        <div className="wz-id">
          <AppGlyph id={app.id} category={app.category} size={36} />
          <div className="wz-id-main">
            <h1>新建 {app.name} 集群</h1>
            <span>{app.platform}</span>
          </div>
          {!from && !revise && (
            <button
              type="button"
              className="wz-switch-app"
              onClick={() => navigate({ name: "new" })}
            >
              切换组件
            </button>
          )}
        </div>
        <div className="wz-origin wz-draft-state">
          <span>
            {draftError
              ? "浏览器暂时无法保存草稿"
              : origin?.kind === "revise"
                ? `正在修订 ${origin.label} 待执行的部署交付，生成后原交付自动作废`
                : origin?.kind === "job"
                  ? `基于 ${origin.label}`
                  : origin?.kind === "draft"
                    ? "正在继续上次的配置"
                    : "未完成的配置会自动保留"}
          </span>
          {origin &&
            origin.kind !== "revise" &&
            (pv?.inputs.length || 0) > 0 && (
              <span className="faint">证书需重新选择</span>
            )}
          {!revise && (
            <button className="link" onClick={startOver}>
              {from ? "重新填写" : "新建一份"}
            </button>
          )}
        </div>
        <nav className="wz-nav">
          {sections.map((x, i) => {
            const n =
              secIssues(x.id) +
              (x.id === "access" ? missingUploads.length + certBad.length : 0);
            return (
              <button
                key={x.id}
                className={sec === x.id ? "on" : ""}
                aria-current={sec === x.id ? "step" : undefined}
                onClick={() => openSection(x.id)}
              >
                <span
                  className={`rail-mark ${untouched ? "idle" : n ? "bad" : "ok"}`}
                  aria-hidden
                >
                  {untouched ? null : n ? n : <IconCheck />}
                </span>
                <span className="wz-nav-text">
                  <b>
                    <span className="wz-nav-n num">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {x.title}
                  </b>
                  <small>{sum[x.id]}</small>
                </span>
                {fa.sections.has(x.id) && (
                  <span
                    className="fc-navdot"
                    title="AI 改过，等你确认"
                    aria-label="AI 改过"
                  />
                )}
                <span className="sr-only">
                  {untouched ? "还没填写" : n ? `${n} 项待完善` : "已完成"}
                </span>
              </button>
            );
          })}
        </nav>
        <button
          className="yaml-btn"
          onClick={() => {
            window.dispatchEvent(new Event(FLUSH_INPUTS_EVENT));
            setYamlOpen(true);
          }}
        >
          <IconCode /> 查看 / 导入 / 导出 YAML
        </button>
        <div className="wz-keys">
          <span>
            <kbd>Alt</kbd>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 切换分区
          </span>
          <span>
            <kbd>{/Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}</kbd>
            <kbd>↵</kbd> 下一步
          </span>
        </div>
      </aside>

      <main className="wz-pane" ref={pane}>
        <FormGlow on={fa.busy} />
        {aiFocus && (
          <AIStageBar
            fa={fa}
            sections={sections.map((x) => ({ id: x.id, title: x.title }))}
            view={aiView}
            onView={(v) => (v === "chat" ? setAiView("chat") : openSection(v))}
            issuesOf={(id) =>
              untouched
                ? -1
                : secIssues(id) +
                  (id === "access" ? missingUploads.length + certBad.length : 0)
            }
            onBack={back}
            onForm={() => setMode("form")}
            blocking={totalBlocking}
            issues={issueTexts}
            titles={secTitles}
            onGenerate={reviewNow}
            onNew={startOver}
          />
        )}
        <header className="wz-pane-head" hidden={choosing || aiChat}>
          <span className="wz-pane-n num">
            {String(idx + 1).padStart(2, "0")} /{" "}
            {String(sections.length).padStart(2, "0")}
          </span>
          <h2>{cur.title}</h2>
          <span className="wz-pane-lead">{cur.lead}</span>
          {fa.on && mode === "form" && (
            <button
              type="button"
              className="fc-callai"
              onClick={() => setMode("ai")}
            >
              <Spark size={14} rainbow />
              AI 帮我填
            </button>
          )}
          <span
            className={`wsec-state ${untouched ? "idle" : secIssues(sec) ? "bad" : "ok"}`}
            hidden={untouched}
          >
            {secIssues(sec) ? (
              <button
                className="link bad"
                onClick={() =>
                  goIssue(errors.find((x) => issueSection(x) === sec)!)
                }
              >
                {secIssues(sec)} 项待完善
              </button>
            ) : (
              <>
                <IconCheck /> 已完成
              </>
            )}
          </span>
        </header>
        <div className="wz-pane-body">
          {choosing && (
            <FormChat
              fa={fa}
              start={{
                title: `新建 ${app.name} 集群`,
                steps: sections.map((x) => x.title),
                onForm: () => setMode("form"),
              }}
              onSend={() => setMode("ai")}
              attach={certAttach}
            />
          )}
          {aiChat && (
            <FormWorkspace
              fa={fa}
              titles={secTitles}
              onGo={openSection}
              attach={certAttach}
            />
          )}
          {!choosing &&
            sections
              .filter((x) => mounted.has(x.id))
              .map((x) => {
                const isHidden = x.id !== sec || aiChat;
                return (
                  <div
                    key={x.id}
                    className={`wz-sec dir-${dir}`}
                    hidden={isHidden}
                    {...(fa.run?.active ? ({ inert: "" } as object) : {})}
                  >
                    <FrozenSection
                      hidden={isHidden}
                      render={() => bodies[x.id]}
                    />
                  </div>
                );
              })}
        </div>
        <footer className="wz-pane-foot" hidden={choosing || aiChat}>
          {aiFocus && (
            <Button
              type="outline"
              className="fw-chatbtn"
              onClick={() => setAiView("chat")}
            >
              <Spark size={14} rainbow />
              回到 AI 对话
            </Button>
          )}
          <span className="muted small wz-foot-state">
            {untouched
              ? fa.on
                ? "按步骤填写，或让 AI 帮你填"
                : "按步骤填写"
              : totalBlocking
                ? `共 ${totalBlocking} 项待完善`
                : "配置完整，可以生成"}
          </span>
          {sections.length > 1 && (
            <Button disabled={idx === 0} onClick={() => step(-1)}>
              上一步
            </Button>
          )}
          {nextSec ? (
            <Button type="primary" onClick={() => step(1)}>
              下一步：{nextSec.title}
            </Button>
          ) : (
            <Button type="primary" onClick={reviewNow}>
              核对并生成
            </Button>
          )}
        </footer>
      </main>

      {withPreview && (
        <aside className="wz-preview" aria-label="交付预览">
          {previewBody}
        </aside>
      )}

      {narrow && (
        <div className="wz-bar">
          <button
            className={`wz-bar-state ${untouched ? "idle" : totalBlocking ? "bad" : "ok"}`}
            onClick={() =>
              totalBlocking
                ? goIssue(
                    errors[0] || {
                      severity: "error",
                      path: "instances[x].binds",
                      message: "",
                    },
                  )
                : reviewNow()
            }
          >
            {untouched
              ? "还没填写"
              : totalBlocking
                ? `待完善 ${totalBlocking} 项`
                : `${dep.hosts.length} 台 · ${pv?.instances.length ?? 0} 个实例`}
          </button>
          <Button type="primary" onClick={reviewNow}>
            核对并生成
          </Button>
        </div>
      )}

      <YamlDrawer
        open={yamlOpen}
        onClose={() => setYamlOpen(false)}
        dep={dep}
        onApply={(d) => (setDep(d), setPlan(""), setYamlOpen(false))}
        narrow={narrow}
      />

      <Drawer
        width={narrow ? "100%" : 640}
        visible={review}
        onCancel={() => setReview(false)}
        title={`核对 ${dep.id || "未命名集群"}`}
        footer={
          <div className="review-foot">
            <span className="muted small">
              {dep.delivery_mode === "configuration"
                ? "仅生成配置文件包，不连接目标服务器"
                : "生成部署材料与手册，随后进入部署页启动执行"}
            </span>
            <div className="row-gap">
              <Button onClick={() => setReview(false)}>继续修改</Button>
              <Button
                type="primary"
                loading={busy}
                disabled={totalBlocking > 0 || !pv?.ok || fa.busy || fa.playing}
                onClick={generate}
              >
                {revise ? "生成修订版" : "生成交付"}
              </Button>
            </div>
          </div>
        }
      >
        {review && (
        <div className="review">
          {revise && revBase && (
            <div className="review-block">
              <h4>这次改了什么 {revised.length}</h4>
              {revised.length === 0 ? (
                <p className="muted small">还没有改动。</p>
              ) : (
                revised.map((c, i) => (
                  <div className="review-change" key={i}>
                    <b>{c.label}</b>
                    <span>{c.detail}</span>
                  </div>
                ))
              )}
              <p className="muted small">
                生成后，原待执行的部署交付自动作废；新交付按修订后的配置部署，并列出差异项。
              </p>
            </div>
          )}
          {totalBlocking > 0 && (
            <div className="review-block">
              <h4 className="bad">还有 {totalBlocking} 项需要处理</h4>
              {issueList()}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="review-block">
              <h4>提示 {warnings.length}</h4>
              {warnings.map((w, i) => (
                <div className="note warn" key={i}>
                  {w.message}
                </div>
              ))}
            </div>
          )}
          {!withPreview && pv && (
            <div className="review-block">
              <InstanceGraph
                hosts={dep.hosts}
                instances={pv.instances}
                controller={pv.controller}
                layout="row"
              />
            </div>
          )}
          <div className="review-block">
            <h4>机器</h4>
            <ExecutionHostSummary host={dep.execution_host} />
            <table className="rtable">
              <tbody>
                {plannedHosts.map((h) => (
                  <tr key={h.name} className={h.initialize ? "chg" : ""}>
                    <th>
                      <span className="mono">{h.name}</span>
                      {h.name === pv?.controller ? " · 控制" : ""}
                    </th>
                    <td className="mono small">
                      {h.ip || "—"} ·{" "}
                      {h.params?.storage_mode === "system_directory"
                        ? "系统盘目录 " + String(hostValue(h, hostContract, "params.data_root") || "/data")
                        : h.disk
                          ? h.initialize
                            ? `${h.disk}（初始化）`
                            : `${h.disk}（沿用 ${String(hostValue(h, hostContract, "params.data_root") || "/data")}）`
                          : "无数据盘"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="review-block">
            <h4>组件实例</h4>
            <table className="rtable">
              <tbody>
                {(pv?.instances || []).map((i) => (
                  <tr key={i.id} className={i.auto ? "chg" : ""}>
                    <th>
                      <span className="mono">{i.id}</span> {i.title} {i.version}
                      {i.auto && <span className="flag info">自动</span>}
                    </th>
                    <td className="small">
                      {i.external
                        ? "客户自行运维"
                        : Object.entries(i.roles)
                            .filter(([, hs]) => (hs || []).length)
                            .map(([r, hs]) => `${r}：${(hs || []).join("、")}`)
                            .join("；")}
                      {i.auto && (
                        <>
                          <br />
                          <span className="muted">{i.auto_reason}</span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {dep.instances.map((inst) => {
            const sc = schemaOf(inst.component, inst.version);
            const view = instView(inst.id);
            const changed = (sc?.params || []).filter(
              (d) =>
                inst.params?.[d.key] !== undefined &&
                view?.visible?.[d.key] !== false,
            );
            return (
              <div className="review-block" key={inst.id}>
                <h4>
                  {inst.id} 定制参数 {changed.length}
                </h4>
                {changed.length ? (
                  <table className="rtable">
                    <thead>
                      <tr>
                        <th>参数</th>
                        <th>默认</th>
                        <th>本次</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changed.map((d) => (
                        <tr key={d.key} className="chg">
                          <th>
                            {d.label} <code>{d.key}</code>{" "}
                            {d.restart && <span className="flag">重启</span>}
                          </th>
                          <td className="old mono">
                            {typeof d.default === "string" &&
                            d.default.startsWith("=")
                              ? "按规则"
                              : showValue(d.default)}
                          </td>
                          <td className="mono">
                            {showValue(view?.params?.[d.key])}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted">全部使用默认值</p>
                )}
                {!!inst.addons?.length && (
                  <p className="small">
                    扩展：
                    {inst.addons
                      .map(
                        (a) =>
                          `${a.id}（${(a.databases?.length ? a.databases : sc?.addons?.scope.defaults || []).join("、")}）`,
                      )
                      .join("；")}
                  </p>
                )}
              </div>
            );
          })}
          <div className="review-block">
            <h4>
              {dep.delivery_mode === "configuration"
                ? "配置交付文件"
                : "上传到各机器"}
            </h4>
            <table className="rtable">
              <tbody>
                {dep.delivery_mode === "configuration" ? (
                  <tr>
                    <th>配置包</th>
                    <td>
                      configuration.zip · 按实例和机器分开保存，由现场人员审核应用
                    </td>
                  </tr>
                ) : (
                  packageHosts.map((h, i) => (
                    <tr key={i}>
                      <th>
                        <span className="mono">{h.name}</span>
                      </th>
                      <td className="mono small">
                        {pkgName(i)}
                        {h.name === pv?.controller &&
                          res?.packages &&
                          res.packages.total > 0 && (
                            <>
                              <br />
                              packages-{res.packages.platform}.tar.gz
                            </>
                          )}
                        {h.name === pv?.controller &&
                          art.map((a) => (
                            <React.Fragment key={a.file}>
                              <br />
                              {a.file}
                            </React.Fragment>
                          ))}
                        {h.name === pv?.controller && (
                          <>
                            <br />
                            SHA256SUMS
                          </>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        )}
      </Drawer>
    </div>
  );
}

/* ---------------------------------------------------------------- YAML drawer */

function YamlDrawer({
  open,
  onClose,
  dep,
  onApply,
  narrow,
}: {
  open: boolean;
  onClose: () => void;
  dep: Deployment;
  onApply: (d: Deployment) => void;
  narrow: boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError("");
    api<{ yaml: string }>("/api/spec/export", {
      method: "POST",
      body: JSON.stringify(clean(dep)),
    })
      .then((r) => setText(r.yaml))
      .catch((e) => setError((e as Error).message));
  }, [open]);
  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      const d = await api<Deployment>("/api/spec/import", {
        method: "POST",
        body: JSON.stringify({ yaml: text }),
      });
      onApply({ ...d, hosts: d.hosts || [], instances: d.instances || [] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/yaml" }));
    a.download = `${dep.id || "deployment"}.yml`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Drawer
      width={narrow ? "100%" : 640}
      visible={open}
      onCancel={onClose}
      title="部署规格（YAML）"
      footer={
        <div className="review-foot">
          <span className="muted small">
            表单和 YAML 是同一份数据；导入会替换当前表单内容
          </span>
          <div className="row-gap">
            <Button onClick={() => copy(text)}>复制</Button>
            <Button onClick={download}>下载</Button>
            <Button type="primary" loading={busy} onClick={apply}>
              导入并应用
            </Button>
          </div>
        </div>
      }
    >
      {error && <div className="note warn">{error}</div>}
      <textarea
        className="yaml-edit mono"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="部署规格 YAML"
      />
    </Drawer>
  );
}

type TargetMode = "all" | "pg" | "custom";

/** Where an extension goes: into template1 so every database made later has it (the sensible default), only into
 *  postgres, or into named databases (for a cluster that already has some). */
function AddonTarget({
  value,
  defaults,
  label,
  onChange,
}: {
  value: string[];
  defaults: string[];
  label: string;
  onChange: (v: string[]) => void;
}) {
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x) => b.includes(x));
  const mode: TargetMode =
    value.length === 0 || same(value, defaults)
      ? "all"
      : same(value, ["postgres"])
        ? "pg"
        : "custom";
  const [custom, setCustom] = useState(mode === "custom");
  const shown: TargetMode = custom ? "custom" : mode;
  return (
    <div className="addon-target">
      <Segmented<TargetMode>
        value={shown}
        onChange={(m) => {
          setCustom(m === "custom");
          if (m === "all") onChange([]);
          else if (m === "pg") onChange(["postgres"]);
        }}
        label={`${label} 装在哪里`}
        options={[
          { value: "all", label: "新建的库都带上" },
          { value: "pg", label: "只装 postgres 库" },
          { value: "custom", label: "指定数据库" },
        ]}
      />
      {shown === "all" && (
        <span className="faint small">装进 {defaults.join("、")}（推荐）</span>
      )}
      {shown === "custom" && (
        <Select
          mode="multiple"
          allowCreate
          value={value}
          triggerProps={{ autoFitPosition: true }}
          placeholder="输入数据库名后回车；这些库在部署时必须已经存在"
          onChange={(v) => onChange((v as string[]).map((x) => x.trim()))}
          aria-label={`${label} 目标数据库`}
        />
      )}
    </div>
  );
}

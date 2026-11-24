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
import {
  api,
  ago,
  can,
  copy,
  err,
  isVersionPlatformReleased,
  platformShort,
  size,
  useMedia,
} from "./shared";
import type { SecSummaryPayload } from "./security";
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
import { bi, biv, catLabel, getLang, useLang, type Lang } from "./i18n";

/* ---------------------------------------------------------------- schema cache */

const schemas = new Map<string, Promise<Schema>>();
const schemaKey = (c: string, v?: string, l: Lang = getLang()) =>
  `${c}@${v || ""}:${l}`;
function loadSchema(
  component: string,
  version?: string,
  lang: Lang = getLang(),
): Promise<Schema> {
  const k = schemaKey(component, version, lang);
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
  const lang = useLang();
  const [loaded, setLoaded] = useState<Record<string, Schema>>({});
  const key = insts.map((i) => `${i.component}@${i.version || ""}`).join("|");
  useEffect(() => {
    let live = true;
    for (const i of insts) {
      const k = schemaKey(i.component, i.version, lang);
      loadSchema(i.component, i.version, lang)
        .then((s) => live && setLoaded((m) => (m[k] ? m : { ...m, [k]: s })))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [key, lang]);
  const otherLang: Lang = lang === "en-US" ? "zh-CN" : "en-US";
  return (c: string, v?: string) =>
    loaded[schemaKey(c, v, lang)] || loaded[schemaKey(c, v, otherLang)];
}

/* ---------------------------------------------------------------- deployment helpers */

const idOk = /^[a-z][a-z0-9-]{0,40}$/;
const ipv4 = (v: string) =>
  /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(v);

const hostName = (i: number) => `node-${String(i + 1).padStart(2, "0")}`;

function rolesOf(app: AppInfo) {
  return app.roles || [];
}

/** Versions of a component declared for an operating system. */
const declaredVersionsFor = (app: AppInfo, platform: string) =>
  app.versions.filter(
    (v) => !v.platforms?.length || v.platforms.includes(platform),
  );

/** Versions selectable for an operating system: formal deliveries only allow published+verified OSes; maintainer test channel allows any declared version (including unpublished/draft). */
const versionsFor = (app: AppInfo, platform: string, verify = false) =>
  app.versions.filter(
    (v) =>
      (!v.platforms?.length || v.platforms.includes(platform)) &&
      (verify ? true : isVersionPlatformReleased(v, platform)),
  );

/** The operating system a new deployment starts on: a released/selectable OS when available. */
function firstPlatform(
  app: AppInfo,
  preferred: string,
  deployable: string[],
  verify = false,
): string {
  const ok = (id: string) =>
    versionsFor(app, id, verify).length > 0 &&
    (!deployable.length || deployable.includes(id));
  if (ok(preferred)) return preferred;
  const any = app.versions.flatMap((v) => v.platforms || []).find(ok);
  if (any) return any;
  const fallback = (id: string) =>
    app.versions.some((v) => v.platforms?.includes(id)) &&
    (!deployable.length || deployable.includes(id));
  if (fallback(preferred)) return preferred;
  return app.versions.flatMap((v) => v.platforms || []).find(fallback) || preferred;
}

/** A new deployment of one component, sized by a preset (or by the role defaults). */
function startDeployment(
  app: AppInfo,
  plan?: AppPlan,
  platform?: string,
  verify = false,
  initialVer?: string,
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
  const pl = platform || firstPlatform(app, "ubuntu-24.04-amd64", [], verify);
  const versions = versionsFor(app, pl, verify);
  const version =
    (initialVer && versions.find((v) => v.id === initialVer)?.id) ||
    versions.find((v) => v.id === app.version)?.id ||
    versions[0]?.id ||
    app.version;
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

const getSections = (): { id: string; title: string; lead: string }[] => [
  {
    id: "basics",
    title: bi("集群与架构方案", "Cluster & Scheme"),
    lead: bi(
      "命名集群，选择系统版本与高可用部署方案",
      "Name the cluster and select OS, version, and HA deployment scheme",
    ),
  },
  {
    id: "hosts",
    title: bi("主机与执行通道", "Hosts & Execution"),
    lead: bi(
      "填写目标机器 IPv4、数据盘与控制节点免密执行通道",
      "Enter target IPv4 addresses, data disks, and passwordless execution path",
    ),
  },
  {
    id: "placement",
    title: bi("角色与拓扑放置", "Roles & Topology"),
    lead: bi(
      "核对各角色节点分布，平台自动补齐依赖组件",
      "Review role placement per host; dependencies are added automatically",
    ),
  },
  {
    id: "params",
    title: bi("关键参数", "Parameters"),
    lead: bi(
      "按需调整核心运行参数，未改动项保持推荐默认值",
      "Tune core runtime parameters; unchanged settings keep recommended defaults",
    ),
  },
  {
    id: "access",
    title: bi("入口与证书", "Access & TLS"),
    lead: bi(
      "配置负载均衡、虚拟 IP 与传输加密证书",
      "Configure load balancing, virtual IPs, and TLS certificates",
    ),
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

const tabLabel = (tab: string): string => {
  switch (tab) {
    case "base":
      return bi("基础", "Basic");
    case "ha":
      return bi("高可用", "HA");
    case "database":
      return bi("数据库", "Database");
    case "backup":
      return bi("备份", "Backup");
    case "os":
      return bi("系统", "OS");
    case "main":
      return bi("参数", "Parameters");
    case "addons":
      return bi("扩展", "Extensions");
    default:
      return tab;
  }
};

/* ---------------------------------------------------------------- wizard */

type NewDeliveryProps = {
  chat?: string;
  app: AppInfo;
  from?: string;
  /** A first deployment that has not been carried out: change its configuration; the new delivery replaces it. */
  revise?: string;
  preset?: string;
  verify?: boolean;
  initialVer?: string;
  initialPlatform?: string;
  back: () => void;
  created: (j: Job) => void;
  jobs?: Job[];
  jobsLoading?: boolean;
};

/** Build a clean, collision-free default cluster ID for component verification runs. */
function suggestVerifyClusterId(
  appId: string,
  platform: string,
  jobs?: Job[],
): string {
  const plTag = platform.startsWith("el")
    ? platform.replace("-amd64", "")
    : platform.startsWith("ubuntu-")
      ? "ubuntu"
      : platform.replace("-amd64", "");
  const cleanPart = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const base = `verify-${cleanPart(appId)}-${cleanPart(plTag)}`.slice(0, 36).replace(/-+$/, "");
  const taken = new Set(
    (jobs || [])
      .filter((j) => j.state !== "failed" && j.outcome !== "void")
      .map((j) => j.cluster_id),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const cand = `${base}-${n}`;
    if (!taken.has(cand)) return cand;
  }
  return base;
}

/** Decide whether this entry continues a draft before mounting either the form or its assistant. */
export function NewDelivery(props: NewDeliveryProps) {
  useLang();
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
        <Spin
          aria-label={bi("检查未完成的配置", "Checking unfinished configuration")}
        />
      </div>
    );
  if (entry.draft && !entry.chosen)
    return (
      <section
        className="wz-resume"
        aria-label={bi("选择继续填写或新建", "Resume draft or start new")}
      >
        <Button
          type="text"
          className="back"
          icon={<IconArrowLeft />}
          onClick={back}
        >
          {bi("返回", "Back")}
        </Button>
        <header>
          <AppGlyph id={app.id} category={app.category} size={40} />
          <div>
            <h1>
              {bi(
                "继续上次的配置，还是新建一份？",
                "Continue your previous draft, or start fresh?",
              )}
            </h1>
            <p>
              {bi(
                `上次未完成的 ${app.name} 配置已保留，选择这次要做的事。`,
                `Your unfinished ${app.name} configuration was saved. Choose how to proceed.`,
              )}
            </p>
          </div>
        </header>
        <div className="wz-resume-draft">
          <IconFile />
          <div>
            <b>{entry.draft.dep.id || bi("未命名集群", "Unnamed cluster")}</b>
            <span>
              {bi(
                `${entry.draft.dep.hosts.length} 台机器`,
                `${entry.draft.dep.hosts.length} ${entry.draft.dep.hosts.length === 1 ? "host" : "hosts"}`,
              )}
              {entry.draft.updated
                ? bi(
                    ` · ${ago(entry.draft.updated)}保存`,
                    ` · Saved ${ago(entry.draft.updated)}`,
                  )
                : bi(" · 未完成的配置", " · Unfinished draft")}
            </span>
          </div>
        </div>
        <div className="wz-resume-actions">
          <Button onClick={() => setEntry((e) => ({ ...e, chosen: true }))}>
            {bi("继续填写", "Resume draft")}
          </Button>
          <Button type="primary" onClick={fresh}>
            {props.from || props.revise
              ? bi("重新填写", "Reset & reload")
              : bi("新建一份", "Start new")}
          </Button>
        </div>
        <p className="wz-resume-note">
          {props.from || props.revise
            ? bi(
                "重新填写会清空这份草稿，并重新载入来源配置。",
                "Resetting clears this draft and reloads the source configuration.",
              )
            : bi(
                "新建一份会清空这份未完成的配置，从空白表单开始。",
                "Starting new clears this unfinished draft and begins from a blank form.",
              )}
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
    useLang();
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
  verify,
  initialVer,
  initialPlatform,
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
  const lang = useLang();
  const submitted = useRef(false);
  const [dep, setDep] = useState<Deployment>(() => {
    if (resume?.dep) return resume.dep;
    const base = startDeployment(
      app,
      app.plans?.find((p) => p.id === preset) || undefined,
      initialPlatform,
      !!verify,
      initialVer,
    );
    if (verify && !from && !revise) {
      base.id = suggestVerifyClusterId(
        app.id,
        base.platform || initialPlatform || "ubuntu-24.04-amd64",
        jobs,
      );
      if (
        !base.delivery_mode &&
        (!app.delivery_modes?.length || app.delivery_modes.includes("automatic"))
      ) {
        base.delivery_mode = "automatic";
      }
    }
    return base;
  });
  const [plan, setPlan] = useState<string>(resume ? resume.plan : preset || "");
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [res, setRes] = useState<Resolution | null>(null);
  const [resolving, setResolving] = useState(false);
  const sections = useMemo(() => getSections(), [lang]);
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
  }, [lang]);
  const [origin, setOrigin] = useState<{
    kind: "draft" | "job" | "revise";
    label: string;
  } | null>(resume ? { kind: "draft", label: resume.dep.id || "" } : null);
  // the first deployment being revised, to say what the revision changes
  const [revBase, setRevBase] = useState<Deployment | null>(null);
  const [lbCatalog, setLbCatalog] = useState<AppInfo[]>([]);
  const [lib, setLib] = useState<LibraryOverview | null>(null);
  const withPreview = useMedia("(min-width: 1200px)");
  const narrow = useMedia("(max-width: 900px)");

  const schemaOf = useSchemas(dep.instances);

  const pickedInitForApp = useRef("");
  useEffect(() => {
    api<AppInfo[]>("/api/catalog?fronts=1")
      .then((all) =>
        setLbCatalog(all.filter((a) => a.provides?.includes("l4-lb"))),
      )
      .catch(() => {});
    api<LibraryOverview>("/api/library")
      .then((o) => {
        setLib(o);
        if (pickedInitForApp.current === app.id) return;
        pickedInitForApp.current = app.id;
        // A fresh deployment starts on a system that can actually be deployed.
        setDep((d) => {
          if (
            resume ||
            from ||
            revise ||
            (verify && initialPlatform) ||
            (!verify && d.id) ||
            d.instances.length !== 1
          )
            return d;
          const pl = firstPlatform(
            app,
            d.platform || o.default_platform,
            o.platforms
              .filter((x) => d.delivery_mode === "configuration" || x.deployable)
              .map((x) => x.id),
            !!verify,
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
                          versionsFor(app, pl, !!verify).find(
                            (v) => v.id === i.version,
                          )?.id ||
                          versionsFor(app, pl, !!verify)[0]?.id ||
                          i.version,
                      }
                    : i,
                ),
              };
        });
      })
      .catch(() => {});
  }, [lang, app.id]);

  // Resumed workflows keep their edits; fresh copies start from their source delivery.
  useEffect(() => {
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
            setOrigin({ kind: "draft", label: saved.id || "" });
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
      api<Resolution>(
        verify ? "/api/resolve?purpose=verification" : "/api/resolve",
        {
          method: "POST",
          body: JSON.stringify(clean(dep)),
          signal: ac.signal,
        },
      )
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
  }, [dep, ready, appsTick, review, lang, verify]);

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
        title: bi("切换部署方案？", "Switch deployment scheme?"),
        content: bi(
          "将移除原方案中已自行指定的组件配置：" +
            obsolete.map((i) => i.id).join("、") +
            "。新方案会重新计算依赖，并移除不再使用的机器；仍被其他组件使用的机器会保留。",
          "Explicitly configured components from the previous scheme will be removed: " +
            obsolete.map((i) => i.id).join(", ") +
            ". The new scheme will recalculate dependencies and remove unused hosts; hosts still used by other components will be kept.",
        ),
        okText: bi("切换方案", "Switch scheme"),
        cancelText: bi("保留当前方案", "Keep current"),
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
        title: bi("确认调整机器数量", "Confirm host count change"),
        content: bi(
          "切换到「" +
            p.name +
            "」将从当前配置移除：" +
            dropped.map((h) => h.name + "（" + h.ip + "）").join("、") +
            "。这只修改部署表单，不会操作这些机器。",
          `Switching to "${p.name}" will remove from this configuration: ` +
            dropped.map((h) => `${h.name} (${h.ip})`).join(", ") +
            ". This only updates the form and will not touch the machines.",
        ),
        okText: bi("切换并移除", "Switch & remove"),
        cancelText: bi("保留当前方案", "Keep current"),
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
      title: from
        ? bi("重新填写这份配置？", "Reset this configuration?")
        : bi("新建一份交付？", "Start a new delivery?"),
      content: from
        ? bi(
            "当前草稿将被清空，重新载入来源交付的配置。",
            "The current draft will be cleared and reloaded from the source delivery.",
          )
        : chat
          ? bi(
              "结束这次对话的填表，返回新建入口。",
              "End this assistant session and return to the new-delivery entry.",
            )
          : bi(
              "当前未完成的配置将被清空，从空白表单开始。",
              "The current unfinished draft will be cleared to start from a blank form.",
            ),
      okText: from ? bi("重新填写", "Reset") : bi("新建一份", "Start new"),
      cancelText: bi("继续当前配置", "Keep editing"),
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
      return err(
        new Error(
          bi("请先填写第一台机器的 IP", "Enter the IPv4 of the first host first"),
        ),
      );
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
          purpose: verify ? "verification" : undefined,
          verify_target:
            verify && main
              ? {
                  component: main.component,
                  version: main.version || app.version,
                  platform: dep.platform || platform,
                }
              : undefined,
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
    const groups = sc.groups.length
      ? sc.groups
      : [{ id: "", label: bi("参数", "Parameters") }];
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
                ? bi(
                    `已修改 ${found.length} 项参数`,
                    `${found.length} modified ${found.length === 1 ? "parameter" : "parameters"}`,
                  )
                : bi(
                    `找到 ${found.length} 项匹配参数`,
                    `${found.length} matching ${found.length === 1 ? "parameter" : "parameters"}`,
                  )}
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
                {bi("清除筛选", "Clear filters")}
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
                {advanced[k]
                  ? bi("收起高级参数", "Hide advanced")
                  : bi(`显示高级参数 ${adv.length}`, `Show advanced (${adv.length})`)}
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
              label={bi("参数分类", "Parameter categories")}
              value={active}
              onChange={opts.tabState![1]}
              options={tabsOrder.map((t) => ({
                value: t,
                label: (
                  <>
                    {tabLabel(t)}
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
            ? bi(
                "集群刚建好时还没有业务库，所以默认装进 template1：以后新建的数据库自动带上这个扩展，不用再逐个库处理。已存在的扩展保留，不自动升级。",
                "No business databases exist yet at setup, so extensions install into template1 by default—new databases inherit them automatically. Existing extensions are kept without auto-upgrade.",
              )
            : bi(
                `按${scope.name}安装。已存在的保留，不自动升级。`,
                `Installed per ${scope.name}. Existing extensions are kept without auto-upgrade.`,
              )}
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
                {a.builtin && (
                  <span className="flag">{bi("通常已存在", "Usually built-in")}</span>
                )}
                {a.restart && (
                  <span className="flag">{bi("需重启", "Requires restart")}</span>
                )}
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
      return (
        <p className="muted small">
          {bi(
            "由客户自行运维，不放置到机器上。",
            "Customer-managed; not placed on hosts.",
          )}
        </p>
      );
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
            {bi(
              "基础系列只放置一个节点；需要从节点请先切换部署方案。",
              "Basic tier places only one node; switch deployment scheme to add replicas.",
            )}
          </p>
        )}
        {allowedRoles.map((r) => {
          const cur = inst.placement?.[r.name] || [];
          const range = r.max
            ? r.min === r.max
              ? bi(`固定 ${r.min} 台`, `Exact ${r.min}`)
              : bi(`${r.min}–${r.max} 台`, `${r.min}–${r.max} hosts`)
            : r.min
              ? bi(`至少 ${r.min} 台`, `Min ${r.min}`)
              : bi("可不放置", "Optional");
          const bad = issueFor(`instances[${inst.id}].placement.${r.name}`);
          return (
            <div className={`place-row ${bad ? "is-bad" : ""}`} key={r.name}>
              <div className="place-role">
                <div className="place-role-top">
                  <b>{r.title || r.name}</b>
                  <span
                    className={`wz-role-cnt num ${bad ? "bad" : cur.length > 0 ? "ok" : ""}`}
                  >
                    {bi(`已选 ${cur.length} 台`, `${cur.length} selected`)}
                  </span>
                </div>
                <small>
                  {range}
                  {r.odd ? bi(" · 建议奇数", " · Odd preferred") : ""}
                  {r.exclusive ? bi(" · 独占机器", " · Exclusive host") : ""}
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
                placeholder={bi("选择机器", "Select hosts")}
                onChange={(v) =>
                  edit(inst.id, (i) => ({
                    ...i,
                    placement: {
                      ...(i.placement || {}),
                      [r.name]: v as string[],
                    },
                  }))
                }
                aria-label={bi(
                  `${inst.id} ${r.title || r.name} 放置`,
                  `${inst.id} ${r.title || r.name} placement`,
                )}
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
          label: `${i.id}.${e.name} · ${e.title}${e.lb === "none" ? bi("（不适合放在负载均衡后）", " (not suitable behind LB)") : ""}`,
          disabled: e.lb === "none",
        }),
      ),
    );
    return out;
  }, [pv, lang]);

  function frontCard(inst: InstanceSpec) {
    const sc = schemaOf(inst.component, inst.version);
    const view = instView(inst.id);
    return (
      <div className="front" key={inst.id} data-ai={`instances[${inst.id}]`}>
        <div className="front-head">
          <AppGlyph
            id={inst.component}
            category={catLabel("Load Balancing")}
            size={28}
          />
          <div>
            <b>{sc?.title || inst.component}</b>
            <small className="mono">
              {inst.id}
              {view ? ` · ${view.version}` : ""}
            </small>
          </div>
          {view && (
            <StatusBadge
              state={view.status === "published" ? "done" : "idle"}
              label={
                view.status === "published"
                  ? bi("已发布", "Published")
                  : bi("未发布", "Unpublished")
              }
            />
          )}
          <Button
            type="text"
            status="danger"
            icon={<IconDelete />}
            onClick={() => removeInstance(inst.id)}
            aria-label={bi(`删除入口 ${inst.id}`, `Remove entrypoint ${inst.id}`)}
          />
        </div>
        <h5>{bi("代理的端点", "Proxied Endpoints")}</h5>
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
                aria-label={bi("代理的端点", "Proxied endpoint")}
              />
              <Input
                className="mono-in"
                value={b.listen ? String(b.listen) : ""}
                placeholder={bi(
                  "监听端口（留空同后端）",
                  "Listen port (blank = backend)",
                )}
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
                aria-label={bi("监听端口", "Listen port")}
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
                aria-label={bi("移除", "Remove")}
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
            {bi("+ 添加端点", "+ Add endpoint")}
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
            <h5>{bi("放置", "Placement")}</h5>
            {placementEditor(inst)}
            <button className="link" onClick={() => addHost(inst.id)}>
              {bi("+ 为它添加一台新机器", "+ Add a new host for this")}
            </button>
          </>
        )}
        <h5>{bi("参数", "Parameters")}</h5>
        {paramsPanel(inst.id)}
        {autoInstances
          .filter((a) => a.auto_reason?.includes(sc?.title || inst.component))
          .map((a) => (
            <div key={a.id} className="note">
              {biv(
                <>
                  平台已自动加入 <b>{a.title}</b>（{a.id}）：{a.auto_reason}
                  ，与它同机部署。
                </>,
                <>
                  Auto-added <b>{a.title}</b> ({a.id}): {a.auto_reason},
                  co-located on the same hosts.
                </>,
              )}
            </div>
          ))}
      </div>
    );
  }

  const upload = (key: string, label: string, required = false) => (
    <div className="cert-row" key={key}>
      <div>
        <b>{label}</b>
        <span>{required ? bi("必需", "Required") : bi("可选", "Optional")}</span>
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
            return err(
              new Error(
                bi("单个文件不超过 2 MiB", "File size must not exceed 2 MiB"),
              ),
            );
          setFiles((o) => ({ ...o, [key]: picked }));
        }}
      >
        {!files[key] && (
          <Button
            size="small"
            icon={<IconPlus />}
            aria-label={bi(`选择${label}`, `Select ${label}`)}
          >
            {bi("选择文件", "Choose file")}
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
    [revBase, dep, schemaOf, app.id, lang],
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
                bi(
                  "浏览器暂时无法保存草稿，将从已保存的对话恢复配置",
                  "Unable to save draft locally; configuration will restore from chat history",
                ),
              );
            }
            navigate({ name: "new", app: target, chat: conversation });
            Message.success(
              bi(
                "已切换组件，需求与对话已保留",
                "Switched component; requirements and chat history kept",
              ),
            );
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
    certificate: bi("证书", "Certificate"),
    private_key: bi("私钥", "Private key"),
    ca_cert: bi("CA 证书", "CA cert"),
    intermediates: bi("中间证书", "Intermediates"),
  };
  const certTarget = (pv?.inputs || [])[0];
  const [chatFiles, setChatFiles] = useState<FileNode[]>([]);
  const [chatUp, setChatUp] = useState(0);
  const addChatFiles = async (picked: File[]) => {
    const ok = picked.filter((f) => {
      if (f.size > 4 * 1024 * 1024) {
        Message.warning(
          bi(
            `${f.name} 超过 4 MiB，没有添加`,
            `${f.name} exceeds 4 MiB and was not added`,
          ),
        );
        return false;
      }
      return true;
    });
    if (!ok.length) return;
    if (chatFiles.length + ok.length > 8)
      return void Message.warning(
        bi("一条消息最多附带 8 个文件", "Up to 8 files per message"),
      );
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
            slot: bi("待发送", "Pending"),
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
              bi(
                `表单里已有：${have.map((part) => `${SLOT_LABEL[part]} ${slotFile(part)!.name}`).join("、")}${chk && !chk.busy ? `；平台核对：${chk.ok ? "证书与域名匹配" : chk.error || "未通过"}` : ""}`,
                `Already in form: ${have.map((part) => `${SLOT_LABEL[part]} ${slotFile(part)!.name}`).join(", ")}${chk && !chk.busy ? `; check: ${chk.ok ? "certificate matches domain" : chk.error || "failed"}` : ""}`,
              ),
            );
          }
          return out.length ? bi(`（${out.join("。")}）`, ` (${out.join(". ")})`) : "";
        },
      }
    : undefined;

  // How a new cluster starts: the first screen asks nothing but offers both ways at once (typing to the assistant is
  // choosing it; "fill it in yourself" is the other). Coming back to a draft, copying a delivery, a plan, verification or a preset skips it.
  const [mode, setModeRaw] = useState<"choose" | "form" | "ai">(
    () => resume?.mode || (from || revise || resume || verify ? "form" : "ai"),
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
    Message.info(
      bi("先确认或撤销 AI 的改动", "Confirm or undo AI changes first"),
    );
  };
  const pickPlatform = (id: string) =>
    setDep((d) => {
      const vs = versionsFor(app, id, !!verify);
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
    if (!v || !isVersionPlatformReleased(v, platform))
      return verify
        ? bi(
            `该版本在 ${platformShort(platform)} 上尚未发布；通过测试通道完成自动执行后将自动生成测试报告`,
            `Unpublished on ${platformShort(platform)}; completing automated test execution automatically captures a test report`,
          )
        : bi(
            `该版本在 ${platformShort(platform)} 上尚未发布，正式交付已拦截`,
            `Not yet published on ${platformShort(platform)}; blocked from formal delivery`,
          );
    return dep.delivery_mode !== "configuration" && cv && !cv.ready
      ? bi(
          `软件库缺 ${cv.missing?.length ?? 0} 个软件包`,
          `${cv.missing?.length ?? 0} missing ${cv.missing?.length === 1 ? "package" : "packages"} in Software Library`,
        )
      : bi("已发布", "Published");
  };
  const idFormatHint = !dep.id
    ? ""
    : !/^[a-z]/.test(dep.id)
      ? bi(
          "需以小写英文字母（a-z）开头",
          "Must start with a lowercase letter (a–z)",
        )
      : dep.id.length > 41
        ? bi("标识长度不超过 41 个字符", "Must be 41 characters or fewer")
        : !idOk.test(dep.id)
          ? bi(
              "仅支持小写英文字母、数字与连字符（-）",
              "Only lowercase letters, digits, and hyphens (-) are allowed",
            )
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
    if (!h.name.trim()) return bi("请填写机器名称", "Enter host name");
    if ((hostNameCounts.get(h.name) || 0) > 1)
      return bi(`机器名称 ${h.name} 重复`, `Duplicate host name: ${h.name}`);
    if (h.ip && !ipv4(h.ip))
      return bi(
        "IPv4 地址格式不正确（示例：10.0.1.11）",
        "Invalid IPv4 address (e.g. 10.0.1.11)",
      );
    if (h.ip && ipv4(h.ip) && (hostIpCounts.get(h.ip) || 0) > 1)
      return bi(
        `IPv4 地址 ${h.ip} 与其他机器重复`,
        `Duplicate IPv4 address: ${h.ip}`,
      );
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
        {verify && (
          <div className="wz-verify-banner" role="status">
            <span className="wz-verify-pill">
              {bi("组件测试部署通道", "Component Test Channel")}
            </span>
            <p>
              {bi(
                `正在为 ${app.name} ${main?.version || app.version}（${platformShort(platform)}）创建测试部署。采用自动执行全步通过后，平台将自动归档完整测试报告到组件页，之后可随时删除此测试交付。`,
                `Creating a test delivery for ${app.name} ${main?.version || app.version} (${platformShort(platform)}). Passing all steps in automated mode saves a self-contained test report to the component; you can delete this temporary delivery anytime.`,
              )}
            </p>
          </div>
        )}
        <Row
          label={bi("交付方式", "Delivery Mode")}
          hint={
            (dep.delivery_mode || "offline") === "automatic"
              ? bi(
                  "自动执行模式：生成离线材料与自动化执行计划，不含手工互信步骤；在交付页接入执行节点后直接自动运行并把日志回传到对应步骤。",
                  "Automated mode: generates bundles & automated runbook without manual SSH trust steps; connect an Execution Node on the delivery page to run steps and stream logs inline.",
                )
              : dep.delivery_mode === "configuration"
                ? bi(
                    "仅生成配置文件与说明文档，不生成安装包、不操作机器。",
                    "Generates configuration files and guide only; no packages or target changes.",
                  )
                : bi(
                    "离线手动模式：生成各机器上传包、手工免密脚本与分步终端手册，由现场人员手动执行并记录结果。",
                    "Offline manual mode: generates per-host upload packages, SSH trust setup scripts, and step-by-step terminal runbook for manual on-site execution.",
                  )
          }
          wide
        >
          <div className="wz-mode-grid" role="radiogroup" aria-label={bi("交付方式", "Delivery mode")}>
            {[
              {
                value: "automatic" as const,
                title: bi("自动化执行", "Automated Execution"),
                desc: bi(
                  "通过执行节点 / Target Agent 自动部署与测试，日志直接回传到各步骤",
                  "Execution Node / Target Agent runs deploy & tests with inline step logs",
                ),
                disabled:
                  !!mainSchema?.delivery_modes &&
                  !mainSchema.delivery_modes.includes("automatic"),
              },
              {
                value: "offline" as const,
                title: bi("离线手动部署", "Offline Manual"),
                desc: bi(
                  "生成完整离线包、手工免密脚本与终端手册，纯离线现场手工执行",
                  "Full offline packages, SSH trust scripts & terminal runbook for air-gapped sites",
                ),
                disabled:
                  !!mainSchema?.delivery_modes &&
                  !mainSchema.delivery_modes.some(
                    (m) => m === "offline" || m === "automatic",
                  ),
              },
              ...(mainSchema?.delivery_modes?.includes("configuration") ||
              dep.delivery_mode === "configuration"
                ? [
                    {
                      value: "configuration" as const,
                      title: bi("仅生成配置", "Config Files Only"),
                      desc: bi(
                        "只输出配置文件，不包含安装包与执行步骤",
                        "Configuration outputs only; no installation or execution steps",
                      ),
                      disabled:
                        !mainSchema?.delivery_modes?.includes("configuration"),
                    },
                  ]
                : []),
            ].map((opt) => {
              const active = (dep.delivery_mode || "offline") === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={opt.disabled}
                  className={`wz-mode-card ${active ? "on" : ""}`}
                  onClick={() => set({ delivery_mode: opt.value })}
                >
                  <b>{opt.title}</b>
                  <span>{opt.desc}</span>
                </button>
              );
            })}
          </div>
        </Row>
        <Row
          label={bi("集群标识", "Cluster ID")}
          hint={bi(
            "集群的唯一标识；小写字母开头，只包含小写字母、数字与连字符",
            "Unique cluster identifier; starts with a lowercase letter, using lowercase letters, digits, and hyphens",
          )}
          wide
          ai="id"
        >
          <div className="wz-id-row">
            <Input
              className="cluster-in"
              value={dep.id}
              onChange={(v) => set({ id: v.trim() })}
              placeholder="pg-order-prod"
              aria-label={bi("集群标识", "Cluster ID")}
              autoFocus={!origin}
              disabled={!!revise}
              status={
                dep.id && (Boolean(idFormatHint) || idTaken) ? "error" : undefined
              }
            />
            {dep.id && !idFormatHint && !idTaken && (
              <span className="wz-id-ok">
                <IconCheck /> {bi("可用", "Available")}
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
              {bi(
                `集群标识 ${dep.id} 已被使用，请更换一个标识。`,
                `Cluster ID "${dep.id}" is already in use; choose another.`,
              )}
            </div>
          )}
        </Row>
        <Row
          ai="platform"
          label={bi("操作系统", "OS Platform")}
          wide
          hint={
            dep.delivery_mode === "configuration"
              ? bi(
                  "配置文件按这个系统和组件版本生成；不需要安装运行环境",
                  "Configs are rendered for this OS and version; no execution runtime needed",
                )
              : !verify &&
                  platformChoices.some(
                    (x) => versionsFor(app, x.id, false).length === 0,
                  )
                ? bi(
                    "正式交付仅开放已发布的操作系统；标有「未发布」的系统仅维护者可通过组件测试通道验证",
                    "Formal deliveries only allow published OSes; unpublished OSes can only be tested via the maintainer test channel",
                  )
                : deployableIds.includes(platform)
                  ? bi(
                      "所有机器必须是这个系统；软件包按它从软件库取",
                      "All hosts must run this OS; packages are fetched for it from the Software Library",
                    )
                  : bi(
                      "这个系统还没有 Ansible 运行环境，暂时不能生成交付",
                      "No Ansible runtime available for this OS yet; cannot generate delivery",
                    )
          }
        >
          <Segmented
            label={bi("操作系统", "OS Platform")}
            value={platform}
            onChange={pickPlatform}
            options={(platformChoices.length
              ? platformChoices
              : [{ id: platform, title: platform, deployable: true }]
            ).map((x) => {
              const osReleased = versionsFor(app, x.id, false).length > 0;
              const osSelectable = versionsFor(app, x.id, !!verify).length > 0;
              return {
                value: x.id,
                label: (
                  <span className="wz-os-opt">
                    <OsName id={x.id} title={x.title} />
                    {!osReleased && (
                      <em className="wz-os-unver">
                        {bi("未发布", "Unpublished")}
                      </em>
                    )}
                  </span>
                ),
                disabled:
                  !osSelectable ||
                  (dep.delivery_mode !== "configuration" && !x.deployable),
              };
            })}
          />
        </Row>
        <div className="fgrid">
          <Row
            label={bi("版本", "Version")}
            hint={versionNote(main?.version || app.version)}
            ai="version"
          >
            <Segmented
              label={bi("版本", "Version")}
              value={main?.version || app.version}
              onChange={pickVersion}
              options={(declaredVersionsFor(app, platform).length
                ? declaredVersionsFor(app, platform)
                : versionsFor(app, platform, !!verify)
              ).map((v) => {
                const released = isVersionPlatformReleased(v, platform);
                return {
                  value: v.id,
                  label: (
                    <span className="wz-os-opt">
                      <span>{v.id}</span>
                      {!released && (
                        <em className="wz-os-unver">
                          {bi("未发布", "Unpublished")}
                        </em>
                      )}
                    </span>
                  ),
                  disabled: !verify && !released,
                };
              })}
            />
          </Row>
          <Row
            label={bi("说明（可选）", "Description (optional)")}
            hint={bi("显示在交付列表里", "Shown in the deliveries list")}
            ai="title"
          >
            <Input
              value={dep.title || ""}
              onChange={(v) => set({ title: v })}
              placeholder={bi("订单库生产集群", "Orders production cluster")}
              aria-label={bi("说明", "Description")}
            />
          </Row>
        </div>
        {!!app.plans?.length && (
          <section
            className="wz-sub"
            aria-label={bi("部署架构方案", "Deployment scheme")}
          >
            <div className="wz-sub-top">
              <h3>{bi("部署架构方案", "Deployment Scheme")}</h3>
              <span className="muted small">
                {bi(
                  "切换方案将自动同步所需机器台数与角色拓扑",
                  "Switching scheme syncs host count and role topology automatically",
                )}
              </span>
            </div>
            <div
              className="plans"
              role="radiogroup"
              aria-label={bi("常用方案", "Preset schemes")}
            >
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
                        <span className="plan-tag num">
                          {bi(
                            `${nodeCount} 台节点`,
                            `${nodeCount} ${nodeCount === 1 ? "node" : "nodes"}`,
                          )}
                        </span>
                      )}
                      {p.contract && (
                        <span
                          className={`plan-ha ${p.contract.failover === "automatic" ? "ok" : ""}`}
                        >
                          {p.contract.failover === "automatic"
                            ? bi("自动切换", "Auto failover")
                            : p.contract.failover === "manual"
                              ? bi("人工切换", "Manual failover")
                              : bi("无故障切换", "No failover")}
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
                    <span className="plan-tag">
                      {bi("自由组合", "Flexible")}
                    </span>
                  </span>
                  <strong>{bi("自定义", "Custom")}</strong>
                  <span>
                    {bi(
                      "按需调整机器数量与角色放置",
                      "Adjust host count and role placement freely",
                    )}
                  </span>
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
                      <p className="muted">
                        {contract.limitations.join(bi("；", "; "))}
                      </p>
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
              {biv(
                <>
                  IPv4 已填写 <b>{readyIpCount}</b> / {dep.hosts.length} 台
                </>,
                <>
                  IPv4 ready: <b>{readyIpCount}</b> / {dep.hosts.length}
                </>,
              )}
            </span>
          </span>
          <div className="row-gap">
            {dep.hosts.length > 1 && (
              <button type="button" className="link" onClick={fillIPs}>
                {bi("按首台 IP 依次补全空白", "Auto-fill from first IP")}
              </button>
            )}
            <Button size="small" icon={<IconPlus />} onClick={() => addHost()}>
              {bi("添加机器", "Add host")}
            </Button>
          </div>
        </div>
        <div
          className="host-table"
          role="table"
          aria-label={bi("机器", "Hosts")}
        >
          <div className="hosts-head" role="row">
            <span>{bi("名称", "Name")}</span>
            <span>IPv4</span>
            <span>{bi("数据盘", "Data disk")}</span>
            <span>{bi("初始化", "Initialize")}</span>
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
                  aria-label={bi(`机器 ${i + 1} 名称`, `Host ${i + 1} name`)}
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
                  aria-label={bi(`机器 ${i + 1} IPv4`, `Host ${i + 1} IPv4`)}
                  status={badIp ? "error" : undefined}
                />
                {hiddenHostFields(h, hostContract).has("disk") ? (
                  <span className="muted">
                    {hostValue(h, hostContract, "params.storage_mode") ===
                    "system_directory"
                      ? bi("系统盘目录 ", "System dir ") +
                        String(
                          hostValue(h, hostContract, "params.data_root") ||
                            "/data",
                        )
                      : bi("无需独立数据盘", "No separate data disk")}
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
                    placeholder={bi("无数据盘", "No data disk")}
                    aria-label={bi(
                      `机器 ${i + 1} 数据盘`,
                      `Host ${i + 1} data disk`,
                    )}
                  />
                )}
                {hiddenHostFields(h, hostContract).has("initialize") ? (
                  <span className="muted">{bi("不初始化", "Skip init")}</span>
                ) : (
                  <Tooltip
                    content={
                      h.initialize
                        ? bi(
                            "会格式化这块盘，仅用于全新空盘",
                            "Formats this disk; use only on brand-new empty disks",
                          )
                        : bi(
                            "关闭时使用已有挂载：",
                            "When off, uses existing mount: ",
                          ) +
                          String(
                            hostValue(h, hostContract, "params.data_root") ||
                              "/data",
                          )
                    }
                    mini
                  >
                    <span className="host-init-cell">
                      <Switch
                        size="small"
                        checked={!!h.initialize}
                        onChange={(v) => setHost(i, { initialize: v })}
                        aria-label={bi(
                          `机器 ${i + 1} 初始化数据盘`,
                          `Initialize data disk for host ${i + 1}`,
                        )}
                      />
                      <em className="host-init-lbl">
                        {bi("初始化", "Init disk")}
                      </em>
                    </span>
                  </Tooltip>
                )}
                <Button
                  type="text"
                  status="danger"
                  className="host-del-btn"
                  icon={<IconDelete />}
                  disabled={dep.hosts.length <= 1}
                  onClick={() => removeHost(i)}
                  aria-label={bi(`删除机器 ${h.name}`, `Remove host ${h.name}`)}
                />
                <HostParameterFields
                  host={h}
                  index={i}
                  contract={hostContract}
                  hasError={Boolean(
                    rowErr && /存储|数据盘|目录|空间|storage|disk|dir|free/i.test(rowErr),
                  )}
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
            {bi(
              "已选择初始化数据盘：会对所列设备分区并格式化，盘上有任何签名、分区或数据时会停止。",
              "Disk initialization enabled: listed devices will be partitioned and formatted; aborts if any signature, partition, or data exists.",
            )}
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
          <section
            className="wz-sub"
            aria-label={bi("自动加入的组件", "Auto-added components")}
          >
            <h3>{bi("平台自动加入", "Auto-Added by Platform")}</h3>
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
                      {bi("放置：", "Placement: ")}
                      {Object.entries(a.roles)
                        .map(([r, hs]) =>
                          bi(
                            `${r}：${(hs || []).join("、")}`,
                            `${r}: ${(hs || []).join(", ")}`,
                          ),
                        )
                        .join(bi("；", "; "))}
                    </small>
                  </div>
                  {a.managed_context ? (
                    <span className="muted small">
                      {bi(
                        `由 ${a.managed_context} 的部署方案管理，节点与配置随数据库同步`,
                        `Managed by ${a.managed_context}'s scheme; nodes and config sync with the database`,
                      )}
                    </span>
                  ) : (
                    <Button size="small" onClick={() => takeOver(a)}>
                      {bi("自行指定", "Customize")}
                    </Button>
                  )}
                </div>
              ))}
            <p className="muted small">
              {bi(
                "需要独立机器、不同端口或不同版本时，点“自行指定”把它变成一个可编辑的实例。",
                'When you need dedicated hosts, custom ports, or a different version, click "Customize" to edit it as an explicit instance.',
              )}
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
          <p className="muted small">
            {bi(
              "已自行指定的组件可以在“关键参数”一步调整。",
              'Customized components can be tuned in the "Parameters" step.',
            )}
          </p>
        )}
      </>
    ),
    params: (
      <>
        <div className="wz-tune-top">
          {paramInsts.length > 1 && (
            <Segmented
              label={bi("组件", "Component")}
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
                {bi("仅看已改", "Modified only")} ({activeParamChangedCount})
              </button>
            )}
            <Input
              allowClear
              prefix={<IconSearch />}
              className="tune-search"
              placeholder={bi(
                "搜索参数，如 shared_buffers",
                "Search parameters, e.g. shared_buffers",
              )}
              value={query}
              onChange={setQuery}
              aria-label={bi("搜索参数", "Search parameters")}
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
        <section className="wz-sub" aria-label={bi("入口", "Access")}>
          <h3>{bi("入口（负载均衡）", "Access (Load Balancing)")}</h3>
          <p className="muted small">
            {bi(
              "应用通过一个稳定的入口连接。可以用本平台部署的 HAProxy、Nginx（可加 keepalived 虚拟 IP），也可以由客户的云 ELB 提供，平台只给出配置清单。",
              "Applications connect through a stable entrypoint. Deploy HAProxy or Nginx (optionally with a keepalived VIP) via this platform, or use your cloud ELB where the platform outputs the target configuration.",
            )}
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
                {bi(`添加 ${lb.name}`, `Add ${lb.name}`)}
              </Button>
            ))}
          </div>
        </section>
        {(pv?.inputs.length || 0) > 0 && (
          <section className="wz-sub" aria-label={bi("证书", "Certificates")}>
            <h3>{bi("证书", "TLS Certificates")}</h3>
            {pv!.inputs.map((inp) => (
              <div className="certs" key={`${inp.instance}/${inp.name}`}>
                <p className="muted small">
                  <b>{inp.instance}</b> · {inp.label}
                  {bi(
                    "。PEM 或 P7B 均可，私钥要是没有加密的 PEM 格式；私钥只会放进控制节点的包。",
                    ". Accepts PEM or P7B; private key must be unencrypted PEM and is packaged only for the control node.",
                  )}
                </p>
                <div className="cert-list">
                  {upload(
                    uploadKey(inp.instance, inp.name, "certificate"),
                    bi("服务器证书", "Server certificate"),
                    true,
                  )}
                  {upload(
                    uploadKey(inp.instance, inp.name, "private_key"),
                    bi("私钥（未加密 PEM）", "Private key (unencrypted PEM)"),
                    true,
                  )}
                  {upload(
                    uploadKey(inp.instance, inp.name, "ca_cert"),
                    bi("根 CA", "Root CA"),
                  )}
                  {upload(
                    uploadKey(inp.instance, inp.name, "intermediates"),
                    bi("中间证书链", "Intermediate chain"),
                  )}
                </div>
                {certChecks[inp.instance] && (
                  <div
                    className={`cert-check ${certChecks[inp.instance].busy ? "busy" : certChecks[inp.instance].ok ? "ok" : "bad"}`}
                    role="status"
                  >
                    {certChecks[inp.instance].busy ? (
                      <span>{bi("正在检查证书…", "Checking certificate…")}</span>
                    ) : certChecks[inp.instance].ok ? (
                      <>
                        <IconCheckCircleFill />
                        <span>
                          {bi(
                            "证书和私钥是一对，证书链有效",
                            "Certificate and key match; chain is valid",
                          )}
                          {certChecks[inp.instance].domain
                            ? bi(
                                `，包含入口域名 ${certChecks[inp.instance].domain}`,
                                `, covers domain ${certChecks[inp.instance].domain}`,
                              )
                            : ""}
                          {certChecks[inp.instance].not_after
                            ? bi(
                                ` · 有效期至 ${certChecks[inp.instance].not_after!.slice(0, 10)}`,
                                ` · Expires ${certChecks[inp.instance].not_after!.slice(0, 10)}`,
                              )
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
    basics: `${dep.id || bi("未命名", "Unnamed")} · ${main?.version || ""}`,
    hosts: bi(
      `${dep.hosts.length} 台 · IPv4 ${readyIpCount}/${dep.hosts.length}`,
      `${dep.hosts.length} ${dep.hosts.length === 1 ? "host" : "hosts"} · IPv4 ${readyIpCount}/${dep.hosts.length}`,
    ),
    placement: (() => {
      const n =
        pv?.instances.filter((i) => !i.external).length ?? dep.instances.length;
      return bi(
        `${n} 个实例${autoInstances.length ? ` · 自动 ${autoInstances.length}` : ""}`,
        `${n} ${n === 1 ? "instance" : "instances"}${autoInstances.length ? ` · ${autoInstances.length} auto` : ""}`,
      );
    })(),
    params: (() => {
      const n = dep.instances.reduce(
        (c, i) => c + Object.keys(i.params || {}).length,
        0,
      );
      return bi(`${n} 项已调整`, `${n} tuned`);
    })(),
    access: lbInstances.length
      ? bi(
          `${lbInstances.length} 个入口`,
          `${lbInstances.length} ${lbInstances.length === 1 ? "entry" : "entries"}`,
        )
      : bi("未配置入口", "No entrypoint"),
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
            <span className="issue-sec">{bi("原交付", "Source")}</span>
            {x.message}
          </div>
        );
      })}
      {certBad.map(([inst, c]) => (
        <button key={`cert-${inst}`} onClick={() => openSection("access")}>
          <span className="issue-sec">{bi("入口与证书", "Access & TLS")}</span>
          {bi(`${inst} 的证书：${c.error}`, `${inst} cert: ${c.error}`)}
        </button>
      ))}
      {missingUploads
        .slice(0, limit ? Math.max(0, limit - errors.length) : undefined)
        .map(({ i, p }) => (
          <button
            key={`${i.instance}${p}`}
            onClick={() => openSection("access")}
          >
            <span className="issue-sec">{bi("入口与证书", "Access & TLS")}</span>
            {bi(
              `上传 ${i.instance} 的${p === "certificate" ? "服务器证书" : "私钥"}`,
              `Upload ${p === "certificate" ? "server certificate" : "private key"} for ${i.instance}`,
            )}
          </button>
        ))}
      {limit && totalBlocking > limit && (
        <span className="more">
          {bi(`还有 ${totalBlocking - limit} 项`, `${totalBlocking - limit} more`)}
        </span>
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
    ...certBad.map(([inst, c]) =>
      bi(`${inst} 的证书：${c.error}`, `${inst} cert: ${c.error}`),
    ),
    ...missingUploads.map(({ i, p }) =>
      bi(
        `上传 ${i.instance} 的${p === "certificate" ? "服务器证书" : "私钥"}`,
        `Upload ${p === "certificate" ? "server certificate" : "private key"} for ${i.instance}`,
      ),
    ),
  ];

  const previewBody = (
    <>
      <div className="preview-head">
        <span>{bi("交付预览", "Delivery Preview")}</span>
        <strong className="mono">
          {dep.id || bi("未命名集群", "Unnamed cluster")}
        </strong>
        {/* checking with the server: a dot in a fixed place, never a row that comes and goes */}
        <i
          className={`pv-sync ${resolving ? "on" : ""}`}
          title={resolving ? bi("正在核对", "Checking…") : undefined}
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
              {i.auto && <span className="flag info">{bi("自动", "Auto")}</span>}
              {i.status !== "published" && (
                <span className="flag warn">{bi("未发布", "Unpublished")}</span>
              )}
              {/* an entry's address in full, on its own line: the diagram has room only for a shortened one */}
              {Object.values(i.fronts || {}).map((f) =>
                f.address ? (
                  <small key={f.address + f.listen} className="pinst-addr mono">
                    {bi("入口", "Entry")} {`${f.address}:${f.listen}`}
                  </small>
                ) : null,
              )}
            </div>
          ))}
        </div>
      </Smooth>
      <Smooth>
        <div className="pfiles">
          <span className="pfiles-h">{bi("将生成", "Artifacts")}</span>
          {dep.delivery_mode === "configuration" ? (
            <div className="pfile">
              <span className="role-chip">{bi("配置", "Config")}</span>
              <span className="mono">configuration.zip</span>
            </div>
          ) : (
            packageHosts.map((h, i) => (
              <div key={i} className="pfile">
                <span
                  className={`role-chip ${h.name === pv?.controller ? "p" : "node"}`}
                >
                  {h.name === pv?.controller
                    ? dep.execution_host
                      ? bi("执行", "Exec")
                      : bi("控制", "Ctrl")
                    : bi("业务", "Node")}
                </span>
                <span className="mono">{pkgName(i)}</span>
              </div>
            ))
          )}
          {res?.packages && res.packages.total > 0 && (
            <div className="pfile">
              <span className="role-chip pkg">{bi("软件", "Pkg")}</span>
              <span className="mono">
                packages-{res.packages.platform}.tar.gz
              </span>
              {res.packages.missing.length ? (
                <a
                  className="bad small"
                  href={`#/library/${res.packages.platform}`}
                >
                  {bi(
                    `缺 ${res.packages.missing.length} 个，去软件库`,
                    `${res.packages.missing.length} missing — open Library`,
                  )}
                </a>
              ) : (
                <span className="faint num">
                  {bi(
                    `${res.packages.total} 个软件包版本`,
                    `${res.packages.total} package versions`,
                  )}
                </span>
              )}
            </div>
          )}
          {art.map((a) => (
            <div key={a.file} className="pfile">
              <span className="role-chip">{bi("材料", "Asset")}</span>
              <span className="mono">{a.file}</span>
              {a.present ? (
                a.bytes ? (
                  <span className="faint num">{size(a.bytes)}</span>
                ) : null
              ) : (
                <span className="bad small">{bi("材料库缺失", "Missing asset")}</span>
              )}
            </div>
          ))}
          <div className="pfile">
            <span className="role-chip">{bi("手册", "Docs")}</span>
            <span>
              {dep.delivery_mode === "configuration"
                ? bi(
                    "配置交付说明 · 部署规格",
                    "Config guide · Deployment spec",
                  )
                : dep.delivery_mode === "automatic"
                  ? bi(
                      `自动执行准备 · 自动部署 · 功能测试${lbInstances.length ? " · 入口测试" : ""} · 清理`,
                      `Auto Prep · Auto Deploy · Smoke Tests${lbInstances.length ? " · Entry Tests" : ""} · Cleanup`,
                    )
                  : bi(
                      `环境准备（含免密）· 离线部署 · 功能测试${lbInstances.length ? " · 入口测试" : ""} · 清理`,
                      `Prep (SSH trust) · Offline Deploy · Smoke Tests${lbInstances.length ? " · Entry Tests" : ""} · Cleanup`,
                    )}
            </span>
          </div>
        </div>
      </Smooth>
      <Smooth>
        {pv?.phases && (
          <div className="pphases">
            <span className="pfiles-h">{bi("部署阶段", "Deployment Phases")}</span>
            {pv.phases.map((ph) => (
              <div key={ph.phase} className="pphase">
                <b>{ph.title}</b>
                <small>
                  {bi(
                    `${ph.steps.length} 步`,
                    `${ph.steps.length} ${ph.steps.length === 1 ? "step" : "steps"}`,
                  )}
                </small>
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
            {bi(
              "填写后，这里会告诉你还缺什么，以及能不能生成。",
              "As you fill out the form, missing items and readiness appear here.",
            )}
          </div>
        ) : totalBlocking > 0 ? (
          <div className="preview-issues">
            <div className="pi-head">
              <IconExclamationCircleFill />{" "}
              {bi(`待完善 ${totalBlocking}`, `${totalBlocking} to fix`)}
            </div>
            {issueList(5)}
          </div>
        ) : (
          <div className="preview-ready">
            <IconCheckCircleFill /> {bi("可以生成", "Ready to generate")}
          </div>
        )}
      </Smooth>
      <Button type="primary" long size="large" onClick={reviewNow}>
        {bi("核对并生成", "Review & generate")}
      </Button>
    </>
  );

  return (
    <div
      className={`wz ${withPreview ? "" : "no-preview"} ${aiFocus ? "ai-focus" : ""} ${aiChat ? "ai-chat" : ""}`}
    >
      <aside
        className="wz-side"
        aria-label={bi("配置分区", "Configuration sections")}
      >
        <Button
          type="text"
          className="back"
          icon={<IconArrowLeft />}
          onClick={back}
        >
          {bi("返回", "Back")}
        </Button>
        <div className="wz-id">
          <AppGlyph id={app.id} category={app.category} size={36} />
          <div className="wz-id-main">
            <h1>{bi(`新建 ${app.name} 集群`, `New ${app.name} Cluster`)}</h1>
            <span>{app.platform}</span>
          </div>
          {!from && !revise && (
            <button
              type="button"
              className="wz-switch-app"
              onClick={() => navigate({ name: "new" })}
            >
              {bi("切换组件", "Switch app")}
            </button>
          )}
        </div>
        <div className="wz-origin wz-draft-state">
          <span>
            {draftError
              ? bi("浏览器暂时无法保存草稿", "Unable to save draft locally")
              : origin?.kind === "revise"
                ? bi(
                    `正在修订 ${origin.label} 待执行的部署交付，生成后原交付自动作废`,
                    `Revising pending delivery ${origin.label}; the original will be voided once generated`,
                  )
                : origin?.kind === "job"
                  ? bi(`基于 ${origin.label}`, `Based on ${origin.label}`)
                  : origin?.kind === "draft"
                    ? bi("正在继续上次的配置", "Resuming saved draft")
                    : bi(
                        "未完成的配置会自动保留",
                        "Unfinished progress is saved automatically",
                      )}
          </span>
          {origin &&
            origin.kind !== "revise" &&
            (pv?.inputs.length || 0) > 0 && (
              <span className="faint">
                {bi("证书需重新选择", "Re-select TLS certificates")}
              </span>
            )}
          {!revise && (
            <button className="link" onClick={startOver}>
              {from ? bi("重新填写", "Reset") : bi("新建一份", "Start new")}
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
                    title={bi("AI 改过，等你确认", "Edited by AI, pending review")}
                    aria-label={bi("AI 改过", "Edited by AI")}
                  />
                )}
                <span className="sr-only">
                  {untouched
                    ? bi("还没填写", "Not started")
                    : n
                      ? bi(`${n} 项待完善`, `${n} to fix`)
                      : bi("已完成", "Complete")}
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
          <IconCode /> {bi("查看 / 导入 / 导出 YAML", "View / Import / Export YAML")}
        </button>
        <div className="wz-keys">
          <span>
            <kbd>Alt</kbd>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {bi("切换分区", "Switch section")}
          </span>
          <span>
            <kbd>{/Mac/.test(navigator.platform) ? "⌘" : "Ctrl"}</kbd>
            <kbd>↵</kbd> {bi("下一步", "Next step")}
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
              {bi("AI 帮我填", "Fill with AI")}
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
                {bi(`${secIssues(sec)} 项待完善`, `${secIssues(sec)} to fix`)}
              </button>
            ) : (
              <>
                <IconCheck /> {bi("已完成", "Complete")}
              </>
            )}
          </span>
        </header>
        <div className="wz-pane-body">
          {choosing && (
            <FormChat
              fa={fa}
              start={{
                title: bi(`新建 ${app.name} 集群`, `New ${app.name} Cluster`),
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
              {bi("回到 AI 对话", "Back to AI Chat")}
            </Button>
          )}
          <span className="muted small wz-foot-state">
            {untouched
              ? fa.on
                ? bi("按步骤填写，或让 AI 帮你填", "Fill step by step, or let AI assist")
                : bi("按步骤填写", "Fill step by step")
              : totalBlocking
                ? bi(
                    `共 ${totalBlocking} 项待完善`,
                    `${totalBlocking} ${totalBlocking === 1 ? "item" : "items"} to fix`,
                  )
                : bi("配置完整，可以生成", "Ready to generate")}
          </span>
          {sections.length > 1 && (
            <Button disabled={idx === 0} onClick={() => step(-1)}>
              {bi("上一步", "Previous")}
            </Button>
          )}
          {nextSec ? (
            <Button type="primary" onClick={() => step(1)}>
              {bi(`下一步：${nextSec.title}`, `Next: ${nextSec.title}`)}
            </Button>
          ) : (
            <Button type="primary" onClick={reviewNow}>
              {bi("核对并生成", "Review & generate")}
            </Button>
          )}
        </footer>
      </main>

      {withPreview && (
        <aside className="wz-preview" aria-label={bi("交付预览", "Delivery preview")}>
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
              ? bi("还没填写", "Not started")
              : totalBlocking
                ? bi(`待完善 ${totalBlocking} 项`, `${totalBlocking} to fix`)
                : bi(
                    `${dep.hosts.length} 台 · ${pv?.instances.length ?? 0} 个实例`,
                    `${dep.hosts.length} ${dep.hosts.length === 1 ? "host" : "hosts"} · ${pv?.instances.length ?? 0} inst`,
                  )}
          </button>
          <Button type="primary" onClick={reviewNow}>
            {bi("核对并生成", "Review & generate")}
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
        title={bi(
          `核对 ${dep.id || "未命名集群"}`,
          `Review ${dep.id || "Unnamed cluster"}`,
        )}
        footer={
          <div className="review-foot">
            <span className="muted small">
              {dep.delivery_mode === "configuration"
                ? bi(
                    "仅生成配置文件包，不连接目标服务器",
                    "Generates configuration bundle only; no target connection",
                  )
                : dep.delivery_mode === "automatic"
                  ? bi(
                      "生成自动化交付包与执行计划，随后进入交付页连接执行节点并启动自动执行",
                      "Generates automated delivery bundle & plan, then opens the job page to connect an executor",
                    )
                  : bi(
                      "生成离线安装包与手工执行手册，随后进入交付页下载并按步操作",
                      "Generates offline bundles & manual runbook, then opens the job page",
                    )}
            </span>
            <div className="row-gap">
              <Button onClick={() => setReview(false)}>
                {bi("继续修改", "Keep editing")}
              </Button>
              <Button
                type="primary"
                loading={busy}
                disabled={totalBlocking > 0 || !pv?.ok || fa.busy || fa.playing}
                onClick={generate}
              >
                {revise
                  ? bi("生成修订版", "Generate revision")
                  : bi("生成交付", "Generate delivery")}
              </Button>
            </div>
          </div>
        }
      >
        {review && (
          <div className="review">
            <DeliverySecurityNotice
              platform={dep.platform || pv?.platforms?.[0] || ""}
              instances={(pv?.instances || []).map((i) => ({
                component: i.component,
                version: i.version,
              }))}
            />
            {revise && revBase && (
              <div className="review-block">
                <h4>
                  {bi(
                    `这次改了什么 ${revised.length}`,
                    `Changes in this revision (${revised.length})`,
                  )}
                </h4>
                {revised.length === 0 ? (
                  <p className="muted small">
                    {bi("还没有改动。", "No changes yet.")}
                  </p>
                ) : (
                  revised.map((c, i) => (
                    <div className="review-change" key={i}>
                      <b>{c.label}</b>
                      <span>{c.detail}</span>
                    </div>
                  ))
                )}
                <p className="muted small">
                  {bi(
                    "生成后，原待执行的部署交付自动作废；新交付按修订后的配置部署，并列出差异项。",
                    "Once generated, the original pending delivery is voided automatically; the new delivery deploys with these revised settings and highlights diffs.",
                  )}
                </p>
              </div>
            )}
            {totalBlocking > 0 && (
              <div className="review-block">
                <h4 className="bad">
                  {bi(
                    `还有 ${totalBlocking} 项需要处理`,
                    `${totalBlocking} ${totalBlocking === 1 ? "item" : "items"} still need attention`,
                  )}
                </h4>
                {issueList()}
              </div>
            )}
            {warnings.length > 0 && (
              <div className="review-block">
                <h4>
                  {bi(`提示 ${warnings.length}`, `Warnings (${warnings.length})`)}
                </h4>
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
              <h4>{bi("机器", "Hosts")}</h4>
              <ExecutionHostSummary host={dep.execution_host} />
              <table className="rtable">
                <tbody>
                  {plannedHosts.map((h) => (
                    <tr key={h.name} className={h.initialize ? "chg" : ""}>
                      <th>
                        <span className="mono">{h.name}</span>
                        {h.name === pv?.controller
                          ? bi(" · 控制", " · Ctrl")
                          : ""}
                      </th>
                      <td className="mono small">
                        {h.ip || "—"} ·{" "}
                        {h.params?.storage_mode === "system_directory"
                          ? bi("系统盘目录 ", "System dir ") +
                            String(
                              hostValue(h, hostContract, "params.data_root") ||
                                "/data",
                            )
                          : h.disk
                            ? h.initialize
                              ? bi(`${h.disk}（初始化）`, `${h.disk} (init)`)
                              : bi(
                                  `${h.disk}（沿用 ${String(hostValue(h, hostContract, "params.data_root") || "/data")}）`,
                                  `${h.disk} (reuse ${String(hostValue(h, hostContract, "params.data_root") || "/data")})`,
                                )
                            : bi("无数据盘", "No data disk")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="review-block">
              <h4>{bi("组件实例", "Component Instances")}</h4>
              <table className="rtable">
                <tbody>
                  {(pv?.instances || []).map((i) => (
                    <tr key={i.id} className={i.auto ? "chg" : ""}>
                      <th>
                        <span className="mono">{i.id}</span> {i.title}{" "}
                        {i.version}
                        {i.auto && (
                          <span className="flag info">{bi("自动", "Auto")}</span>
                        )}
                      </th>
                      <td className="small">
                        {i.external
                          ? bi("客户自行运维", "Customer-managed")
                          : Object.entries(i.roles)
                              .filter(([, hs]) => (hs || []).length)
                              .map(([r, hs]) =>
                                bi(
                                  `${r}：${(hs || []).join("、")}`,
                                  `${r}: ${(hs || []).join(", ")}`,
                                ),
                              )
                              .join(bi("；", "; "))}
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
                    {bi(
                      `${inst.id} 定制参数 ${changed.length}`,
                      `${inst.id} Tuned Parameters (${changed.length})`,
                    )}
                  </h4>
                  {changed.length ? (
                    <table className="rtable">
                      <thead>
                        <tr>
                          <th>{bi("参数", "Parameter")}</th>
                          <th>{bi("默认", "Default")}</th>
                          <th>{bi("本次", "Value")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {changed.map((d) => (
                          <tr key={d.key} className="chg">
                            <th>
                              {d.label} <code>{d.key}</code>{" "}
                              {d.restart && (
                                <span className="flag">
                                  {bi("重启", "Restart")}
                                </span>
                              )}
                            </th>
                            <td className="old mono">
                              {typeof d.default === "string" &&
                              d.default.startsWith("=")
                                ? bi("按规则", "Computed")
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
                    <p className="muted">
                      {bi("全部使用默认值", "All parameters use default values")}
                    </p>
                  )}
                  {!!inst.addons?.length && (
                    <p className="small">
                      {bi("扩展：", "Extensions: ")}
                      {inst.addons
                        .map((a) =>
                          bi(
                            `${a.id}（${(a.databases?.length ? a.databases : sc?.addons?.scope.defaults || []).join("、")}）`,
                            `${a.id} (${(a.databases?.length ? a.databases : sc?.addons?.scope.defaults || []).join(", ")})`,
                          ),
                        )
                        .join(bi("；", "; "))}
                    </p>
                  )}
                </div>
              );
            })}
            <div className="review-block">
              <h4>
                {dep.delivery_mode === "configuration"
                  ? bi("配置交付文件", "Configuration Artifacts")
                  : bi("上传到各机器", "Bundles per Host")}
              </h4>
              <table className="rtable">
                <tbody>
                  {dep.delivery_mode === "configuration" ? (
                    <tr>
                      <th>{bi("配置包", "Config bundle")}</th>
                      <td>
                        {bi(
                          "configuration.zip · 按实例和机器分开保存，由现场人员审核应用",
                          "configuration.zip · Organized by instance and host for on-site review",
                        )}
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
  useLang();
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
      title={bi("部署规格（YAML）", "Deployment Spec (YAML)")}
      footer={
        <div className="review-foot">
          <span className="muted small">
            {bi(
              "表单和 YAML 是同一份数据；导入会替换当前表单内容",
              "Form and YAML share the same model; importing replaces current form fields",
            )}
          </span>
          <div className="row-gap">
            <Button onClick={() => copy(text)}>{bi("复制", "Copy")}</Button>
            <Button onClick={download}>{bi("下载", "Download")}</Button>
            <Button type="primary" loading={busy} onClick={apply}>
              {bi("导入并应用", "Import & apply")}
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
        aria-label={bi("部署规格 YAML", "Deployment YAML specification")}
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
  useLang();
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
        label={bi(`${label} 装在哪里`, `Target databases for ${label}`)}
        options={[
          { value: "all", label: bi("新建的库都带上", "All new databases") },
          { value: "pg", label: bi("只装 postgres 库", "postgres DB only") },
          { value: "custom", label: bi("指定数据库", "Specific databases") },
        ]}
      />
      {shown === "all" && (
        <span className="faint small">
          {bi(
            `装进 ${defaults.join("、")}（推荐）`,
            `Install into ${defaults.join(", ")} (recommended)`,
          )}
        </span>
      )}
      {shown === "custom" && (
        <Select
          mode="multiple"
          allowCreate
          value={value}
          triggerProps={{ autoFitPosition: true }}
          placeholder={bi(
            "输入数据库名后回车；这些库在部署时必须已经存在",
            "Type database name and press Enter; databases must exist at deploy time",
          )}
          onChange={(v) => onChange((v as string[]).map((x) => x.trim()))}
          aria-label={bi(`${label} 目标数据库`, `Target databases for ${label}`)}
        />
      )}
    </div>
  );
}

function DeliverySecurityNotice({
  platform,
  instances,
}: {
  platform: string;
  instances: { component: string; version: string }[];
}) {
  const [summary, setSummary] = useState<SecSummaryPayload | null>(null);
  useEffect(() => {
    if (!can("security.view")) return;
    let alive = true;
    api<SecSummaryPayload>("/api/security/summary")
      .then((res) => {
        if (alive) setSummary(res);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!summary?.has_scan || !summary.policy?.warn_delivery_critical) return null;
  const mwOnly = Boolean(summary.policy?.gate_middleware_only);
  const risks = instances
    .map((inst) => summary.component_risks[`${inst.component}@${inst.version}@${platform}`])
    .filter((b): b is NonNullable<typeof b> => {
      if (!b) return false;
      const c = mwOnly ? (b.middleware_critical ?? 0) : b.critical;
      const h = mwOnly ? (b.middleware_high ?? 0) : b.high;
      return c > 0 || h > 0;
    });
  if (risks.length === 0) return null;

  const totalCrit = risks.reduce(
    (s, r) => s + (mwOnly ? (r.middleware_critical ?? 0) : r.critical),
    0,
  );
  const totalHigh = risks.reduce(
    (s, r) => s + (mwOnly ? (r.middleware_high ?? 0) : r.high),
    0,
  );
  const mwCrit = risks.reduce((s, r) => s + (r.middleware_critical ?? 0), 0);
  const mwHigh = risks.reduce((s, r) => s + (r.middleware_high ?? 0), 0);
  const osCrit = risks.reduce((s, r) => s + (r.os_critical ?? 0), 0);
  const osHigh = risks.reduce((s, r) => s + (r.os_high ?? 0), 0);

  return (
    <div
      className="review-block"
      style={{
        borderColor: "rgba(217, 119, 6, 0.4)",
        background: "rgba(217, 119, 6, 0.06)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <b style={{ color: "#b45309", fontSize: 13 }}>
          <IconExclamationCircleFill style={{ marginRight: 6 }} />
          {mwOnly
            ? bi(
                `安全中心提醒：所选组件本体存在 ${totalCrit} 个严重 / ${totalHigh} 个高危未豁免 CVE`,
                `Security Notice: Selected middleware has ${totalCrit} Critical / ${totalHigh} High unwaived CVEs`,
              )
            : bi(
                `安全中心提醒：存在 ${totalCrit} 个严重 / ${totalHigh} 个高危未豁免 CVE（中间件本体 ${mwCrit} 严/${mwHigh} 高 · OS 底层包 ${osCrit} 严/${osHigh} 高）`,
                `Security Notice: ${totalCrit} Critical / ${totalHigh} High unwaived CVEs (Middleware ${mwCrit}C/${mwHigh}H · OS Base ${osCrit}C/${osHigh}H)`,
              )}
        </b>
        <a
          href="#/security/vulns"
          style={{ fontSize: 12, whiteSpace: "nowrap" }}
        >
          {bi("前往安全中心查看 ↗", "Security Center ↗")}
        </a>
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>
        {risks
          .map((r) =>
            mwOnly
              ? `${r.component} ${r.version}（中间件 严 ${r.middleware_critical ?? 0} / 高 ${r.middleware_high ?? 0}）`
              : `${r.component} ${r.version}（中间件 严 ${r.middleware_critical ?? 0}/高 ${r.middleware_high ?? 0}，OS 底层 严 ${r.os_critical ?? 0}/高 ${r.os_high ?? 0}）`,
          )
          .join("；")}
        {bi(
          " — 本提醒不阻断生成交付，建议交付后在集群「安全」页跟进补丁升级或配置缓解演练。",
          " — Non-blocking notice. Follow up in the cluster Security tab after delivery.",
        )}
      </div>
    </div>
  );
}

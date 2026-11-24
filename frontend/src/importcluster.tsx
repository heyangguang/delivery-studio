import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Drawer,
  Input,
  Message,
  Select,
  Skeleton,
  Tag,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCheck,
  IconCheckCircle,
  IconCopy,
  IconDelete,
  IconDownload,
  IconFile,
  IconImage,
  IconPlus,
  IconRefresh,
  IconRight,
  IconSearch,
} from "@arco-design/web-react/icon";
import { api, copy } from "./shared";
import type {
  ClusterView,
  ImportedEndpoint,
  ImportedMeta,
  ImportedPkg,
  InstanceView,
} from "./shared";
import { go } from "./router";
import { AppGlyph, InstanceGraph } from "./ui";
import { bi, useLang } from "./i18n";
import "./importcluster.css";

type RolePreset = { id: string; title: string; title_en?: string };

export type ImportPresetItem = {
  id: string;
  name: string;
  name_en?: string;
  category: string;
  category_title: string;
  category_title_en?: string;
  icon: string;
  color: string;
  summary: string;
  summary_en?: string;
  in_catalog: boolean;
  default_port?: number;
  versions?: string[];
  roles: RolePreset[];
  service_hints?: string[];
  config_hints?: string[];
  data_hints?: string[];
  log_hints?: string[];
};

type PresetsResp = {
  catalog: ImportPresetItem[];
  presets: ImportPresetItem[];
  platforms: { id: string; title: string }[];
  icons: string[];
  ai_enabled: boolean;
};

type HostRow = { name: string; ip: string; role: string; disk?: string };
type ParamRow = { key: string; value: string };

type ImportPayload = {
  id: string;
  component: string;
  display_name?: string;
  category?: string;
  icon?: string;
  color?: string;
  version: string;
  exact_version?: string;
  platform?: string;
  os_detail?: string;
  source_kind?: string;
  deploy_method?: string;
  arch_summary?: string;
  hosts: HostRow[];
  endpoints?: ImportedEndpoint[];
  service_units?: string[];
  config_paths?: string[];
  data_dirs?: string[];
  log_dirs?: string[];
  params?: Record<string, unknown>;
  packages?: ImportedPkg[];
  notes?: string;
  last_probed_at?: string;
};

type ParseResp = {
  draft: {
    suggested_id?: string;
    component?: string;
    display_name?: string;
    version?: string;
    exact_version?: string;
    platform?: string;
    os_detail?: string;
    deploy_method?: string;
    arch_summary?: string;
    hosts: HostRow[];
    endpoints: ImportedEndpoint[];
    service_units: string[];
    config_paths: string[];
    data_dirs: string[];
    log_dirs: string[];
    params: Record<string, unknown>;
    packages: ImportedPkg[];
    notes?: string;
  };
  parser: "ai" | "deterministic";
  ai_used: boolean;
  warnings: string[];
  missing_fields: string[];
};

const CLUSTER_ID_RE = /^[a-z][a-z0-9-]{0,40}$/;

const DEPLOY_METHODS = () => [
  { value: "systemd", label: bi("systemd 系统服务", "systemd Service") },
  { value: "docker", label: bi("Docker / 容器化", "Docker / Container") },
  { value: "binary", label: bi("二进制手工部署", "Binary / Manual") },
  { value: "k8s", label: "Kubernetes" },
  { value: "other", label: bi("其他形态", "Other") },
];

const splitLines = (s: string) =>
  s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

const readFileAsDataURL = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });

function normalizeEndpointRole(role?: string): string {
  switch ((role || "").trim().toLowerCase()) {
    case "readonly":
    case "ro":
    case "read":
    case "reader":
    case "replica":
    case "standby":
    case "slave":
    case "secondary":
    case "follower":
      return "readonly";
    case "admin":
    case "console":
    case "mgmt":
    case "management":
    case "ui":
    case "dashboard":
    case "metrics":
    case "monitor":
    case "web":
      return "admin";
    default:
      return "readwrite";
  }
}

function buildPreviewInstances(
  compID: string,
  displayName: string,
  version: string,
  hosts: HostRow[],
  rolesMeta: RolePreset[],
  endpoints: ImportedEndpoint[],
): InstanceView[] {
  const roles: Record<string, string[]> = {};
  const roleTitles: Record<string, string> = {};
  for (const rm of rolesMeta) roleTitles[rm.id] = rm.title;
  const hostNames: string[] = [];
  for (const h of hosts) {
    const hn = h.name.trim();
    if (!hn) continue;
    hostNames.push(hn);
    const rk = (h.role || rolesMeta[0]?.id || "node").trim();
    if (!roles[rk]) roles[rk] = [];
    roles[rk].push(hn);
    if (!roleTitles[rk]) roleTitles[rk] = rk;
  }
  const flows: InstanceView["flows"] = [];
  if (roles.primary?.length && (roles.replica?.length || roles.secondary?.length || roles.standby?.length)) {
    const target = roles.replica?.length ? "replica" : roles.secondary?.length ? "secondary" : "standby";
    flows.push({ id: "rep", title: bi("主从同步", "Replication"), from: roles.primary, to: roles[target], kind: "replication", sync: false });
  } else if (roles.member?.length && roles.member.length > 1) {
    flows.push({ id: "mesh", title: bi("集群共识", "Quorum"), from: roles.member, to: roles.member, kind: "mesh", sync: true });
  } else if (roles.broker?.length && roles.controller?.length) {
    flows.push({ id: "ctrl", title: bi("元数据协同", "Metadata"), from: roles.broker, to: roles.controller, kind: "replication", sync: false });
  } else if (roles.master?.length && roles.data?.length) {
    flows.push({ id: "sched", title: bi("分片调度", "Shards"), from: roles.master, to: roles.data, kind: "replication", sync: false });
  }
  const fronts: InstanceView["fronts"] = {};
  const eps: InstanceView["endpoints"] = [];
  for (const ep of endpoints) {
    if (!ep.address.trim()) continue;
    const epName = ep.name?.trim() || ep.role || "endpoint";
    const [addr, portStr] = ep.address.trim().split(":");
    const listen = parseInt(portStr || "0", 10) || 0;
    eps.push({
      name: epName,
      title: epName,
      protocol: "tcp",
      port: listen,
      lb: "",
      backends: hosts
        .filter((h) => h.name.trim())
        .map((h) => ({ host: h.name.trim(), ip: h.ip.trim(), port: listen, role: h.role })),
    });
    fronts[epName] = {
      balancer: "external",
      name: epName,
      listen,
      address: addr,
      external: true,
    };
  }
  return [
    {
      id: compID || "middleware",
      component: compID || "middleware",
      title: displayName || compID || "Middleware",
      version: version || "",
      status: "published",
      roles,
      role_titles: roleTitles,
      hosts: hostNames,
      params: {},
      visible: {},
      endpoints: eps,
      fronts,
      flows,
    },
  ];
}

const EMPTY_PLATFORMS: { id: string; title: string }[] = [];

const MiddlewareCard = React.memo(function MiddlewareCard({
  item,
  selected,
  isEn,
  showCatalogBadge,
  onSelect,
}: {
  item: ImportPresetItem;
  selected: boolean;
  isEn: boolean;
  showCatalogBadge: boolean;
  onSelect: (item: ImportPresetItem) => void;
}) {
  return (
    <button
      type="button"
      className={`imp-mw-card ${selected ? "is-selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(item)}
    >
      <AppGlyph id={item.id} icon={item.icon} color={item.color} size={34} />
      <div className="imp-mw-meta">
        <div className="imp-mw-name-row">
          <span className="imp-mw-name">
            {isEn ? item.name_en || item.name : item.name}
          </span>
          {showCatalogBadge && (
            <span className="imp-mw-badge">{bi("目录", "Catalog")}</span>
          )}
        </div>
        <span className="imp-mw-desc">
          {isEn ? item.summary_en || item.summary : item.summary}
        </span>
      </div>
    </button>
  );
});

const Step1PlatformSelects = React.memo(function Step1PlatformSelects({
  platforms,
  platform,
  onPlatformChange,
  deployMethod,
  onDeployMethodChange,
  lang,
}: {
  platforms: { id: string; title: string }[];
  platform: string;
  onPlatformChange: (v: string) => void;
  deployMethod: string;
  onDeployMethodChange: (v: string) => void;
  lang: string;
}) {
  const deployOptions = useMemo(() => DEPLOY_METHODS(), [lang]);
  return (
    <>
      <div className="imp-field">
        <label>{bi("操作系统平台", "OS Platform")}</label>
        <Select
          allowClear
          showSearch
          placeholder={bi("选择或暂不明确", "Select OS platform")}
          value={platform || undefined}
          onChange={(v) => onPlatformChange(v || "")}
        >
          {platforms.map((pl) => (
            <Select.Option key={pl.id} value={pl.id}>
              {pl.title}
            </Select.Option>
          ))}
          <Select.Option value="linux-custom">
            {bi("其他 Linux / 暂不明确", "Other Linux / Unknown")}
          </Select.Option>
        </Select>
      </div>
      <div className="imp-field">
        <label>{bi("部署形态", "Deployment Mode")}</label>
        <Select value={deployMethod} onChange={onDeployMethodChange}>
          {deployOptions.map((dm) => (
            <Select.Option key={dm.value} value={dm.value}>
              {dm.label}
            </Select.Option>
          ))}
        </Select>
      </div>
    </>
  );
});

export function ImportClusterPage({
  component: initialComp,
  onImported,
}: {
  component?: string;
  onImported: (clusterId: string) => Promise<void>;
}) {
  const lang = useLang();
  const isEn = lang === "en-US";
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [presetsData, setPresetsData] = useState<PresetsResp | null>(null);
  const [loadingPresets, setLoadingPresets] = useState(true);

  // Step 1: middleware selection & identity
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [isCustom, setIsCustom] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(initialComp || "postgresql");
  const [customName, setCustomName] = useState("");
  const [customIcon, setCustomIcon] = useState("server");

  const [clusterId, setClusterId] = useState("");
  const [version, setVersion] = useState("");
  const [exactVersion, setExactVersion] = useState("");
  const [platform, setPlatform] = useState("ubuntu-24.04-amd64");
  const [osDetail, setOsDetail] = useState("");
  const [deployMethod, setDeployMethod] = useState("systemd");
  const [archSummary, setArchSummary] = useState("");

  // Step 2: 3-in-1 input mode
  const [inputTab, setInputTab] = useState<"probe" | "ai_doc" | "manual">("probe");
  const [probeScript, setProbeScript] = useState("");
  const [probeFilename, setProbeFilename] = useState("mw-import-probe.sh");
  const [probeSafe, setProbeSafe] = useState(true);
  const [probeLoading, setProbeLoading] = useState(false);

  const [rawText, setRawText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [parsing, setParsing] = useState(false);
  const [parseInfo, setParseInfo] = useState<{
    parser: string;
    warnings: string[];
    missing: string[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Structured baseline state (editable in Step 2 Manual & Step 3 Review)
  const [hosts, setHosts] = useState<HostRow[]>([
    { name: "node-1", ip: "", role: "primary", disk: "" },
  ]);
  const [batchText, setBatchText] = useState("");
  const [showBatch, setShowBatch] = useState(false);
  const [endpoints, setEndpoints] = useState<ImportedEndpoint[]>([]);
  const [serviceUnitsText, setServiceUnitsText] = useState("");
  const [configPathsText, setConfigPathsText] = useState("");
  const [dataDirsText, setDataDirsText] = useState("");
  const [logDirsText, setLogDirsText] = useState("");
  const [paramRows, setParamRows] = useState<ParamRow[]>([]);
  const [packages, setPackages] = useState<ImportedPkg[]>([]);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadingPresets(true);
    api<PresetsResp>("/api/clusters/import/presets")
      .then((res) => {
        if (!alive) return;
        setPresetsData(res);
        if (initialComp) {
          const all = [...res.catalog, ...res.presets];
          if (all.some((x) => x.id === initialComp)) {
            setSelectedId(initialComp);
            setIsCustom(false);
          }
        }
      })
      .catch((e: Error) => Message.error(e.message))
      .finally(() => alive && setLoadingPresets(false));
    return () => {
      alive = false;
    };
  }, [initialComp]);

  const allItems = useMemo(
    () => (presetsData ? [...presetsData.catalog, ...presetsData.presets] : []),
    [presetsData],
  );
  const selectedPreset = useMemo(
    () => (isCustom ? null : allItems.find((x) => x.id === selectedId) || null),
    [allItems, isCustom, selectedId],
  );

  const effectiveCompID = isCustom
    ? customName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "custom-middleware"
    : selectedPreset?.id || selectedId;
  const effectiveDisplayName = isCustom
    ? customName.trim() || bi("自定义中间件", "Custom Middleware")
    : (isEn ? selectedPreset?.name_en || selectedPreset?.name : selectedPreset?.name) || selectedId;
  const effectiveIcon = isCustom ? customIcon : selectedPreset?.icon || "server";
  const effectiveRoles: RolePreset[] = useMemo(
    () =>
      selectedPreset?.roles?.length
        ? selectedPreset.roles
        : [
            { id: "primary", title: bi("主节点", "Primary") },
            { id: "replica", title: bi("从节点", "Replica") },
            { id: "node", title: bi("集群节点", "Node") },
          ],
    [selectedPreset, lang],
  );

  const appliedHintsRef = useRef({
    service: "",
    config: "",
    data: "",
    log: "",
  });

  // Sync default hints when user switches middleware in Step 1 (referentially stable so memoized cards skip re-render)
  const selectMiddleware = useCallback((item: ImportPresetItem) => {
    setIsCustom(false);
    setSelectedId((prev) => (prev === item.id ? prev : item.id));
    const prevHints = appliedHintsRef.current;
    const nextSvc = item.service_hints?.[0] || "";
    const nextCfg = item.config_hints?.[0] || "";
    const nextData = item.data_hints?.[0] || "";
    const nextLog = item.log_hints?.[0] || "";
    appliedHintsRef.current = {
      service: nextSvc,
      config: nextCfg,
      data: nextData,
      log: nextLog,
    };
    setServiceUnitsText((prev) =>
      !prev || prev === prevHints.service ? nextSvc : prev,
    );
    setConfigPathsText((prev) =>
      !prev || prev === prevHints.config ? nextCfg : prev,
    );
    setDataDirsText((prev) =>
      !prev || prev === prevHints.data ? nextData : prev,
    );
    setLogDirsText((prev) =>
      !prev || prev === prevHints.log ? nextLog : prev,
    );
    if (Array.isArray(item.roles) && item.roles.length > 0) {
      setHosts((prev) =>
        prev.length === 1 && !prev[0].ip
          ? [{ name: `${item.id}-1`, ip: "", role: item.roles[0].id, disk: "" }]
          : prev,
      );
    }
  }, []);

  // Load read-only probe script whenever entering Step 2 Probe tab or changing component/deployMethod
  useEffect(() => {
    if (step !== 2 || inputTab !== "probe") return;
    let alive = true;
    setProbeLoading(true);
    api<{ script: string; filename: string; safe: boolean; warnings: string[] }>(
      "/api/clusters/import/probe-script",
      {
        method: "POST",
        body: JSON.stringify({
          component: effectiveCompID,
          display_name: effectiveDisplayName,
          deploy_method: deployMethod,
          service_units: splitLines(serviceUnitsText),
          config_paths: splitLines(configPathsText),
        }),
      },
    )
      .then((res) => {
        if (!alive) return;
        setProbeScript(res.script);
        setProbeFilename(res.filename);
        setProbeSafe(res.safe);
      })
      .catch((e: Error) => Message.error(e.message))
      .finally(() => alive && setProbeLoading(false));
    return () => {
      alive = false;
    };
  }, [step, inputTab, effectiveCompID, deployMethod]);

  const handleImageFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files).slice(0, 4 - images.length);
    const added: string[] = [];
    for (const f of arr) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > 4 * 1024 * 1024) {
        Message.warning(bi("单张截图不能超过 4 MiB", "Each image must be <= 4 MiB"));
        continue;
      }
      try {
        added.push(await readFileAsDataURL(f));
      } catch {
        // ignore unreadable
      }
    }
    if (added.length) setImages((prev) => [...prev, ...added].slice(0, 4));
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      await handleImageFiles(files);
    }
  };

  const runParse = async () => {
    if (!rawText.trim() && images.length === 0) {
      Message.warning(
        bi(
          "请先粘贴采集输出 / 文档 / 配置文本，或上传截图",
          "Paste probe output / document / config text or upload screenshots first",
        ),
      );
      return;
    }
    setParsing(true);
    try {
      const res = await api<ParseResp>("/api/clusters/import/parse", {
        method: "POST",
        body: JSON.stringify({
          component: effectiveCompID,
          display_name: effectiveDisplayName,
          source_kind: inputTab === "probe" ? "probe" : "ai_doc",
          text: rawText,
          images,
        }),
      });
      const d = res.draft;
      if (!clusterId && d.suggested_id && CLUSTER_ID_RE.test(d.suggested_id)) {
        setClusterId(d.suggested_id);
      }
      if (d.version) setVersion(d.version);
      if (d.exact_version) setExactVersion(d.exact_version);
      if (d.platform) setPlatform(d.platform);
      if (d.os_detail) setOsDetail(d.os_detail);
      if (d.deploy_method) setDeployMethod(d.deploy_method);
      if (d.arch_summary) setArchSummary(d.arch_summary);
      if (d.hosts?.length) setHosts(d.hosts);
      if (d.endpoints?.length)
        setEndpoints(
          d.endpoints.map((ep) => ({
            ...ep,
            role: normalizeEndpointRole(ep.role),
          })),
        );
      if (d.service_units?.length) setServiceUnitsText(d.service_units.join("\n"));
      if (d.config_paths?.length) setConfigPathsText(d.config_paths.join("\n"));
      if (d.data_dirs?.length) setDataDirsText(d.data_dirs.join("\n"));
      if (d.log_dirs?.length) setLogDirsText(d.log_dirs.join("\n"));
      if (d.params && Object.keys(d.params).length) {
        setParamRows(
          Object.entries(d.params).map(([k, v]) => ({
            key: k,
            value: typeof v === "string" ? v : JSON.stringify(v),
          })),
        );
      }
      if (d.packages?.length) setPackages(d.packages);
      if (d.notes) setNotes((prev) => (prev ? `${prev}\n${d.notes}` : d.notes!));
      setParseInfo({
        parser: res.parser,
        warnings: res.warnings || [],
        missing: res.missing_fields || [],
      });
      Message.success(
        res.ai_used
          ? bi("AI 解析完成，已自动填充基线草稿", "AI extraction complete; draft populated")
          : bi("内置规则解析完成，已填充基线草稿", "Deterministic parse complete; draft populated"),
      );
      setStep(3);
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
      setParsing(false);
    }
  };

  const applyBatchHosts = () => {
    const parsed: HostRow[] = [];
    for (const raw of batchText.split("\n")) {
      const parts = raw.trim().split(/[\s,;\t|]+/).filter(Boolean);
      if (!parts.length) continue;
      if (parts.length === 1) {
        const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(parts[0]);
        parsed.push({
          name: isIP ? `node-${parsed.length + 1}` : parts[0],
          ip: isIP ? parts[0] : "",
          role: effectiveRoles[parsed.length === 0 ? 0 : Math.min(1, effectiveRoles.length - 1)]?.id || "node",
        });
      } else {
        const firstIsIP = /^\d+\.\d+\.\d+\.\d+$/.test(parts[0]);
        const name = firstIsIP ? parts[1] : parts[0];
        const ip = firstIsIP ? parts[0] : parts[1];
        const role = parts[2] || effectiveRoles[parsed.length === 0 ? 0 : Math.min(1, effectiveRoles.length - 1)]?.id || "node";
        parsed.push({ name, ip, role });
      }
    }
    if (parsed.length) {
      setHosts(parsed);
      setShowBatch(false);
      setBatchText("");
      Message.success(bi(`已批量导入 ${parsed.length} 台节点`, `Parsed ${parsed.length} hosts`));
    }
  };

  const downloadProbe = () => {
    const blob = new Blob([probeScript], { type: "text/x-shellscript;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = probeFilename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const canAdvanceStep1 =
    CLUSTER_ID_RE.test(clusterId.trim()) &&
    (!isCustom || customName.trim().length > 0);

  const validHosts = useMemo(
    () => hosts.filter((h) => h.name.trim() || h.ip.trim()),
    [hosts],
  );

  const submitImport = async () => {
    const cid = clusterId.trim();
    if (!CLUSTER_ID_RE.test(cid)) {
      Message.error(
        bi(
          "请填写规范的集群标识（小写字母开头，仅含小写字母、数字和连字符）",
          "Enter a valid cluster ID (lowercase letters, digits, hyphens, starting with a letter)",
        ),
      );
      setStep(1);
      return;
    }
    if (validHosts.length === 0) {
      Message.error(bi("请至少录入 1 台集群节点", "Add at least one host node"));
      setStep(2);
      return;
    }
    const paramsObj: Record<string, unknown> = {};
    for (const row of paramRows) {
      const k = row.key.trim();
      if (!k) continue;
      paramsObj[k] = row.value.trim();
    }
    const payload: ImportPayload = {
      id: cid,
      component: effectiveCompID,
      display_name: effectiveDisplayName,
      category: selectedPreset?.category || "middleware",
      icon: effectiveIcon,
      color: selectedPreset?.color || "blue",
      version: version.trim() || exactVersion.trim() || "unknown",
      exact_version: exactVersion.trim() || undefined,
      platform: platform.trim() || undefined,
      os_detail: osDetail.trim() || undefined,
      source_kind: inputTab,
      deploy_method: deployMethod,
      arch_summary: archSummary.trim() || undefined,
      hosts: validHosts.map((h, i) => ({
        name: h.name.trim() || `node-${i + 1}`,
        ip: h.ip.trim(),
        role: h.role || effectiveRoles[0]?.id || "node",
        disk: h.disk?.trim() || undefined,
      })),
      endpoints: endpoints.filter((e) => e.address.trim()),
      service_units: splitLines(serviceUnitsText),
      config_paths: splitLines(configPathsText),
      data_dirs: splitLines(dataDirsText),
      log_dirs: splitLines(logDirsText),
      params: paramsObj,
      packages,
      notes: notes.trim() || undefined,
    };
    setSubmitting(true);
    try {
      const res = await api<{ cluster_id: string }>("/api/clusters/import", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      Message.success(
        bi(
          `存量集群 ${res.cluster_id} 已完成纳管建档`,
          `Cluster ${res.cluster_id} onboarded successfully`,
        ),
      );
      await onImported(res.cluster_id);
      window.dispatchEvent(new Event("mh-clusters-changed"));
      go({ name: "deliveries", id: res.cluster_id });
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // Filtered catalog & preset lists
  const qLow = search.trim().toLowerCase();
  const matchFilter = (item: ImportPresetItem) => {
    if (catFilter === "catalog" && !item.in_catalog) return false;
    if (catFilter !== "all" && catFilter !== "catalog" && item.category !== catFilter)
      return false;
    if (!qLow) return true;
    return (
      item.id.toLowerCase().includes(qLow) ||
      item.name.toLowerCase().includes(qLow) ||
      (item.name_en || "").toLowerCase().includes(qLow) ||
      item.summary.toLowerCase().includes(qLow)
    );
  };
  const filteredCatalog = useMemo(
    () => (presetsData?.catalog || []).filter(matchFilter),
    [presetsData, catFilter, qLow],
  );
  const filteredPresets = useMemo(
    () => (presetsData?.presets || []).filter(matchFilter),
    [presetsData, catFilter, qLow],
  );

  const platformList = useMemo(
    () => presetsData?.platforms || EMPTY_PLATFORMS,
    [presetsData],
  );

  const previewInstances = useMemo(
    () =>
      step === 3
        ? buildPreviewInstances(
            effectiveCompID,
            effectiveDisplayName,
            exactVersion || version,
            validHosts,
            effectiveRoles,
            endpoints,
          )
        : [],
    [step, effectiveCompID, effectiveDisplayName, exactVersion, version, validHosts, effectiveRoles, endpoints],
  );

  const CATEGORIES = [
    { id: "all", label: bi("全部", "All") },
    { id: "catalog", label: bi("平台目录", "Platform Catalog") },
    { id: "database", label: bi("数据库", "Database") },
    { id: "cache", label: bi("缓存与协调", "Cache & Coordination") },
    { id: "queue", label: bi("消息队列", "Message Queue") },
    { id: "search", label: bi("搜索", "Search") },
    { id: "storage", label: bi("存储", "Storage") },
    { id: "proxy", label: bi("代理与网关", "Proxy & Gateway") },
    { id: "observability", label: bi("可观测", "Observability") },
    { id: "runtime", label: bi("运行与制品", "Runtime") },
  ];

  return (
    <div className="imp-page enter">
      <div className="imp-shell">
        <header className="imp-topbar">
          <div className="imp-topbar-left">
            <Button
              size="small"
              icon={<IconArrowLeft />}
              onClick={() => go({ name: "deliveries" })}
            >
              {bi("返回集群", "Clusters")}
            </Button>
            <div className="imp-title-group">
              <h1>{bi("导入存量集群", "Import Existing Cluster")}</h1>
              <p>
                {bi(
                  "纳管运行中中间件集群，免首次部署包，直接解锁拓扑档案、变更演练、Word 报告、跨集群推广与安全治理。",
                  "Onboard brownfield middleware clusters without deployment bundles to unlock topology, rehearsals, Word reports, rollouts, and security.",
                )}
              </p>
            </div>
          </div>
          <nav className="imp-stepper" aria-label={bi("导入步骤", "Import steps")}>
            {[
              { n: 1 as const, label: bi("识别中间件", "Middleware") },
              { n: 2 as const, label: bi("采集录入节点", "Onboard Nodes") },
              { n: 3 as const, label: bi("核对基线拓扑", "Review & Topology") },
            ].map((s, idx) => (
              <React.Fragment key={s.n}>
                {idx > 0 && (
                  <span className="imp-step-sep" aria-hidden>
                    <IconRight />
                  </span>
                )}
                <button
                  type="button"
                  className={`imp-step-btn ${step === s.n ? "is-active" : ""} ${step > s.n ? "is-done" : ""}`}
                  disabled={s.n > 1 && !canAdvanceStep1}
                  onClick={() => setStep(s.n)}
                >
                  <span className="imp-step-num">
                    {step > s.n ? <IconCheck /> : s.n}
                  </span>
                  <span>{s.label}</span>
                </button>
              </React.Fragment>
            ))}
          </nav>
        </header>

        {/* ---------------- STEP 1: Middleware Picker & Identity ---------------- */}
        {step === 1 && (
          <>
            <section className="imp-card">
              <div className="imp-card-head">
                <div>
                  <h2>{bi("1. 选择中间件类型", "1. Choose Middleware Type")}</h2>
                  <p>
                    {bi(
                      "支持平台目录已有组件，也支持 30+ 常见企业中间件免包纳管或任意自定义名称。",
                      "Supports platform catalog components as well as 30+ common enterprise middleware presets or custom names.",
                    )}
                  </p>
                </div>
                <Input
                  prefix={<IconSearch />}
                  allowClear
                  style={{ width: 250 }}
                  placeholder={bi("搜索 MySQL、Kafka、Redis…", "Search MySQL, Kafka, Redis…")}
                  value={search}
                  onChange={setSearch}
                />
              </div>

              <div className="imp-picker-toolbar">
                <div className="imp-cat-pills" role="group">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`imp-cat-pill ${catFilter === c.id ? "on" : ""}`}
                      onClick={() => setCatFilter(c.id)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <Button
                  size="small"
                  type={isCustom ? "primary" : "secondary"}
                  icon={<IconPlus />}
                  onClick={() => setIsCustom((v) => !v)}
                >
                  {bi("自定义中间件", "Custom Middleware")}
                </Button>
              </div>

              {isCustom && (
                <div className="imp-custom-box">
                  <div className="imp-field">
                    <label>
                      {bi("中间件名称", "Middleware Name")} <span className="req">*</span>
                    </label>
                    <Input
                      placeholder={bi("例如：ClickHouse / 自研网关 / PolarDB", "e.g. Custom Gateway / PolarDB")}
                      value={customName}
                      onChange={setCustomName}
                    />
                    <span className="imp-field-hint">
                      {bi("组件标识：", "Component slug: ")}
                      <code className="mono">{effectiveCompID}</code>
                    </span>
                  </div>
                  <div className="imp-field">
                    <label>{bi("选择图标", "Select Icon")}</label>
                    <div className="imp-icon-picker">
                      {(presetsData?.icons || ["server", "database", "cache", "queue"]).map(
                        (ic) => (
                          <button
                            key={ic}
                            type="button"
                            className={`imp-icon-opt ${customIcon === ic ? "on" : ""}`}
                            title={ic}
                            onClick={() => setCustomIcon(ic)}
                          >
                            <AppGlyph id={ic} icon={ic} size={24} />
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                </div>
              )}

              {loadingPresets ? (
                <Skeleton text={{ rows: 5 }} animation />
              ) : (
                <>
                  {filteredCatalog.length > 0 && (
                    <>
                      <div className="imp-group-label">
                        <span>{bi("平台目录已有组件", "Platform Catalog Components")}</span>
                        <em>{filteredCatalog.length}</em>
                      </div>
                      <div className="imp-mw-grid">
                        {filteredCatalog.map((item) => (
                          <MiddlewareCard
                            key={item.id}
                            item={item}
                            selected={!isCustom && selectedId === item.id}
                            isEn={isEn}
                            showCatalogBadge
                            onSelect={selectMiddleware}
                          />
                        ))}
                      </div>
                    </>
                  )}

                  {filteredPresets.length > 0 && (
                    <>
                      <div className="imp-group-label">
                        <span>{bi("常见存量中间件预设（免部署包）", "Common Brownfield Presets (Zero-Playbook)")}</span>
                        <em>{filteredPresets.length}</em>
                      </div>
                      <div className="imp-mw-grid">
                        {filteredPresets.map((item) => (
                          <MiddlewareCard
                            key={item.id}
                            item={item}
                            selected={!isCustom && selectedId === item.id}
                            isEn={isEn}
                            showCatalogBadge={false}
                            onSelect={selectMiddleware}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </section>

            <section className="imp-card">
              <div className="imp-card-head">
                <div>
                  <h2>{bi("2. 基本集群身份", "2. Cluster Identity")}</h2>
                  <p>
                    {bi(
                      "填写集群唯一标识与基础形态，版本号与操作系统也可在下一步通过只读采集脚本自动识别回填。",
                      "Provide a unique cluster ID and deployment mode; exact version and OS can also be auto-populated in Step 2.",
                    )}
                  </p>
                </div>
              </div>
              <div className="imp-form-grid">
                <div className="imp-field">
                  <label>
                    {bi("集群标识", "Cluster ID")} <span className="req">*</span>
                  </label>
                  <Input
                    placeholder={`${effectiveCompID}-prod-01`}
                    value={clusterId}
                    onChange={(v) => setClusterId(v.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    status={clusterId && !CLUSTER_ID_RE.test(clusterId) ? "error" : undefined}
                  />
                  <span className="imp-field-hint">
                    {bi("小写字母开头，支持数字与连字符", "Lowercase letters, digits, hyphens")}
                  </span>
                </div>
                <div className="imp-field">
                  <label>{bi("当前版本（选填，可自动采集）", "Version (optional)")}</label>
                  <Input
                    placeholder={
                      selectedPreset?.versions?.[0]
                        ? `${selectedPreset.versions[0]}`
                        : bi("如 8.0 / 3.7 / 17.2", "e.g. 8.0 / 3.7 / 17.2")
                    }
                    value={version}
                    onChange={setVersion}
                  />
                </div>
                <Step1PlatformSelects
                  platforms={platformList}
                  platform={platform}
                  onPlatformChange={setPlatform}
                  deployMethod={deployMethod}
                  onDeployMethodChange={setDeployMethod}
                  lang={lang}
                />
              </div>
              <div className="imp-footer-bar">
                <span className="muted small">
                  {bi("已选：", "Selected: ")}
                  <b>{effectiveDisplayName}</b>
                  {clusterId ? ` · ${clusterId}` : ""}
                </span>
                <Button
                  type="primary"
                  disabled={!canAdvanceStep1}
                  onClick={() => setStep(2)}
                >
                  {bi("下一步：采集或录入节点", "Next: Onboard Nodes")} <IconRight />
                </Button>
              </div>
            </section>
          </>
        )}

        {/* ---------------- STEP 2: 3-in-1 Low-Friction Onboarding ---------------- */}
        {step === 2 && (
          <section className="imp-card" onPaste={handlePaste}>
            <div className="imp-card-head">
              <div>
                <h2>{bi("选择最顺手的录入方式（三选一，可自由切换互补）", "Choose Onboarding Method (Pick Any or Combine)")}</h2>
                <p>
                  {bi(
                    "无需把目标机器接入平台网络；支持离线执行只读脚本粘贴回显、粘贴 CMDB/配置/截图，或 30 秒极简手填。",
                    "No direct platform-to-host connectivity needed: run a read-only probe, paste CMDB/configs/screenshots, or fill a minimal host list.",
                  )}
                </p>
              </div>
            </div>

            <div className="imp-mode-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={inputTab === "probe"}
                className={`imp-mode-tab ${inputTab === "probe" ? "on" : ""}`}
                onClick={() => setInputTab("probe")}
              >
                <div className="imp-mode-tab-head">
                  <b>{bi("一键只读采集脚本", "Read-Only Probe Script")}</b>
                  <span className="imp-rec-tag">{bi("推荐 · 零手填", "Recommended")}</span>
                </div>
                <span>
                  {bi(
                    "生成 100% 静态校验只读 Bash 脚本，自动提取主机、OS、精确版本、路径与 CVE 软件包清单。",
                    "100% statically validated read-only Bash script extracting hosts, OS, versions, paths, and packages.",
                  )}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inputTab === "ai_doc"}
                className={`imp-mode-tab ${inputTab === "ai_doc" ? "on" : ""}`}
                onClick={() => setInputTab("ai_doc")}
              >
                <div className="imp-mode-tab-head">
                  <b>{bi("粘贴文档 / 配置 / 截图", "Paste Doc / Config / Image")}</b>
                </div>
                <span>
                  {bi(
                    "直接粘贴 CMDB 表格、交接文档、my.cnf / patroni.yml 等配置文件或架构截图（支持 Ctrl+V 贴图）。",
                    "Paste CMDB tables, handover docs, config files, or architecture screenshots (Ctrl+V supported).",
                  )}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inputTab === "manual"}
                className={`imp-mode-tab ${inputTab === "manual" ? "on" : ""}`}
                onClick={() => setInputTab("manual")}
              >
                <div className="imp-mode-tab-head">
                  <b>{bi("极简手工建档", "Quick Manual Entry")}</b>
                </div>
                <span>
                  {bi(
                    "只需填主机名、IP 与角色（支持多行批量粘贴），其余路径与参数均选填，30 秒完成建档。",
                    "Enter only hostnames, IPs, and roles (batch paste supported); paths and params are optional.",
                  )}
                </span>
              </button>
            </div>

            {inputTab === "probe" && (
              <>
                <div className="imp-probe-box">
                  <div className="imp-probe-bar">
                    <span className="imp-probe-shield">
                      <IconCheckCircle />
                      {probeSafe
                        ? bi(
                            `已通过 100% 静态只读安全校验 · ${probeFilename}`,
                            `Passed 100% Static Read-Only Safety Check · ${probeFilename}`,
                          )
                        : probeFilename}
                    </span>
                    <div className="row-gap">
                      <Button
                        size="mini"
                        icon={<IconCopy />}
                        onClick={() => {
                          copy(probeScript);
                          Message.success(bi("已复制只读采集脚本", "Probe script copied"));
                        }}
                      >
                        {bi("复制脚本", "Copy Script")}
                      </Button>
                      <Button size="mini" icon={<IconDownload />} onClick={downloadProbe}>
                        {bi("下载 .sh", "Download .sh")}
                      </Button>
                    </div>
                  </div>
                  <pre className="imp-probe-pre">
                    {probeLoading ? bi("正在生成只读采集脚本…", "Generating read-only probe…") : probeScript}
                  </pre>
                </div>

                <div className="imp-field">
                  <label>
                    <span>
                      {isEn ? (
                        <>
                          Run <code>bash {probeFilename}</code> on target nodes and paste terminal output here (multi-node outputs can be concatenated)
                        </>
                      ) : (
                        <>
                          在目标节点执行 <code>bash {probeFilename}</code> 后，把终端输出粘贴到这里（多台节点输出可直接拼接）
                        </>
                      )}
                    </span>
                  </label>
                  <Input.TextArea
                    autoSize={{ minRows: 6, maxRows: 14 }}
                    placeholder={bi(
                      "=== MW_IMPORT_BEGIN ===\nHOSTNAME=...\n可直接 Ctrl+V 粘贴终端文本或截图",
                      "=== MW_IMPORT_BEGIN ===\nHOSTNAME=...\nPaste terminal output or Ctrl+V screenshots",
                    )}
                    value={rawText}
                    onChange={setRawText}
                  />
                </div>
              </>
            )}

            {inputTab === "ai_doc" && (
              <div className="imp-field">
                <label>
                  {bi(
                    "粘贴 CMDB 资产表、交接文档、/etc/hosts 或配置文件内容（密码会自动脱敏，支持直接 Ctrl+V 贴截图）",
                    "Paste CMDB tables, handover docs, /etc/hosts, or config snippets (secrets redacted; Ctrl+V screenshots supported)",
                  )}
                </label>
                <Input.TextArea
                  autoSize={{ minRows: 8, maxRows: 16 }}
                  placeholder={bi(
                    "例如：\nmysql-prod-1  10.20.1.11  primary\nmysql-prod-2  10.20.1.12  replica\nVIP: 10.20.1.100:3306\n版本：MySQL 8.0.36，数据目录 /data/mysql，配置 /etc/my.cnf",
                    "Example:\nmysql-prod-1  10.20.1.11  primary\nmysql-prod-2  10.20.1.12  replica\nVIP: 10.20.1.100:3306\nVersion: MySQL 8.0.36, data /data/mysql, config /etc/my.cnf",
                  )}
                  value={rawText}
                  onChange={setRawText}
                />
              </div>
            )}

            {(inputTab === "probe" || inputTab === "ai_doc") && (
              <>
                <div className="imp-img-strip">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(e) => e.target.files && handleImageFiles(e.target.files)}
                  />
                  <Button
                    size="small"
                    icon={<IconImage />}
                    disabled={images.length >= 4}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {bi(`上传终端 / 架构截图 (${images.length}/4)`, `Attach Screenshots (${images.length}/4)`)}
                  </Button>
                  {images.map((src, idx) => (
                    <div key={idx} className="imp-img-thumb">
                      <img src={src} alt={`screenshot-${idx + 1}`} />
                      <button
                        type="button"
                        className="imp-img-del"
                        aria-label={bi("移除截图", "Remove image")}
                        onClick={() => setImages((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {!presetsData?.ai_enabled && (
                    <span className="muted small">
                      {bi(
                        "当前 AI 未启用：纯文本仍支持内置确定性规则自动提取主机、OS、版本与软件包。",
                        "AI disabled: deterministic parser still extracts hosts, OS, version, and packages from text.",
                      )}
                    </span>
                  )}
                </div>

                <div className="imp-footer-bar">
                  <Button onClick={() => setStep(1)}>
                    <IconArrowLeft /> {bi("上一步", "Back")}
                  </Button>
                  <div className="row-gap">
                    <Button onClick={() => setInputTab("manual")}>
                      {bi("改用手工录入", "Switch to Manual")}
                    </Button>
                    <Button type="primary" loading={parsing} onClick={runParse}>
                      {presetsData?.ai_enabled
                        ? bi("AI 智能解析并进入核对", "Parse with AI & Review")
                        : bi("规则解析并进入核对", "Parse & Review")}
                      <IconRight />
                    </Button>
                  </div>
                </div>
              </>
            )}

            {inputTab === "manual" && (
              <>
                <div className="imp-card-head">
                  <div>
                    <h2 style={{ fontSize: 14 }}>{bi("主机节点与角色", "Cluster Hosts & Roles")}</h2>
                  </div>
                  <div className="row-gap">
                    <Button size="small" icon={<IconFile />} onClick={() => setShowBatch((v) => !v)}>
                      {bi("批量粘贴节点", "Batch Paste Hosts")}
                    </Button>
                    <Button
                      size="small"
                      icon={<IconPlus />}
                      onClick={() =>
                        setHosts((prev) => [
                          ...prev,
                          {
                            name: `${effectiveCompID}-${prev.length + 1}`,
                            ip: "",
                            role:
                              effectiveRoles[Math.min(1, effectiveRoles.length - 1)]?.id || "node",
                            disk: "",
                          },
                        ])
                      }
                    >
                      {bi("添加节点", "Add Host")}
                    </Button>
                  </div>
                </div>

                {showBatch && (
                  <div className="imp-field" style={{ padding: 12, background: "var(--surface-2)", borderRadius: 9 }}>
                    <label>
                      {bi("每行一台，格式：主机名 IP [角色]", "One host per line: hostname IP [role]")}
                    </label>
                    <Input.TextArea
                      autoSize={{ minRows: 3, maxRows: 8 }}
                      placeholder={"db-node-1 10.20.1.11 primary\ndb-node-2 10.20.1.12 replica\ndb-node-3 10.20.1.13 replica"}
                      value={batchText}
                      onChange={setBatchText}
                    />
                    <div className="row-gap">
                      <Button size="small" type="primary" onClick={applyBatchHosts}>
                        {bi("应用到节点列表", "Apply Hosts")}
                      </Button>
                      <Button size="small" onClick={() => setShowBatch(false)}>
                        {bi("取消", "Cancel")}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="imp-table-rows">
                  <div className="imp-host-row imp-col-heads">
                    <span>{bi("主机名", "Hostname")}</span>
                    <span>{bi("IP 地址", "IP Address")}</span>
                    <span>{bi("角色", "Role")}</span>
                    <span>{bi("数据盘（选填）", "Data Disk (opt)")}</span>
                    <span />
                  </div>
                  {hosts.map((h, idx) => (
                    <div key={idx} className="imp-host-row">
                      <Input
                        placeholder="node-1"
                        value={h.name}
                        onChange={(v) =>
                          setHosts((prev) =>
                            prev.map((row, i) => (i === idx ? { ...row, name: v } : row)),
                          )
                        }
                      />
                      <Input
                        placeholder="10.20.1.11"
                        value={h.ip}
                        onChange={(v) =>
                          setHosts((prev) =>
                            prev.map((row, i) => (i === idx ? { ...row, ip: v } : row)),
                          )
                        }
                      />
                      <Select
                        allowCreate
                        value={h.role}
                        onChange={(v) =>
                          setHosts((prev) =>
                            prev.map((row, i) => (i === idx ? { ...row, role: v } : row)),
                          )
                        }
                      >
                        {effectiveRoles.map((r) => (
                          <Select.Option key={r.id} value={r.id}>
                            {isEn ? r.title_en || r.title : r.title} ({r.id})
                          </Select.Option>
                        ))}
                      </Select>
                      <Input
                        placeholder="/dev/vdb"
                        value={h.disk || ""}
                        onChange={(v) =>
                          setHosts((prev) =>
                            prev.map((row, i) => (i === idx ? { ...row, disk: v } : row)),
                          )
                        }
                      />
                      <Button
                        size="small"
                        type="text"
                        status="danger"
                        disabled={hosts.length <= 1}
                        icon={<IconDelete />}
                        onClick={() => setHosts((prev) => prev.filter((_, i) => i !== idx))}
                      />
                    </div>
                  ))}
                </div>

                <div className="imp-footer-bar">
                  <Button onClick={() => setStep(1)}>
                    <IconArrowLeft /> {bi("上一步", "Back")}
                  </Button>
                  <Button
                    type="primary"
                    disabled={validHosts.length === 0}
                    onClick={() => setStep(3)}
                  >
                    {bi("下一步：核对基线与拓扑预览", "Next: Review & Topology")} <IconRight />
                  </Button>
                </div>
              </>
            )}
          </section>
        )}

        {/* ---------------- STEP 3: Baseline Review & Live Topology ---------------- */}
        {step === 3 && (
          <div className="imp-review-grid">
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {parseInfo && (
                <div className="imp-parse-banner">
                  <div>
                    <b>
                      {parseInfo.parser === "ai"
                        ? bi("✓ 已由 AI 提取基线草稿", "✓ Draft extracted by AI")
                        : bi("✓ 已由内置规则提取基线草稿", "✓ Draft extracted by deterministic rules")}
                    </b>
                    {parseInfo.missing.length > 0 && (
                      <div className="muted small" style={{ marginTop: 2 }}>
                        {bi("建议核对补齐：", "Suggested to review: ")}
                        {parseInfo.missing.join(" · ")}
                      </div>
                    )}
                    {parseInfo.warnings.map((w, i) => (
                      <div key={i} className="muted small" style={{ marginTop: 2 }}>
                        {w}
                      </div>
                    ))}
                  </div>
                  <Button size="mini" onClick={() => setStep(2)}>
                    {bi("返回补充采集", "Re-parse")}
                  </Button>
                </div>
              )}

              {/* Identity & Version Review */}
              <section className="imp-card">
                <div className="imp-card-head">
                  <h2>{bi("集群身份与版本基线", "Identity & Version Baseline")}</h2>
                </div>
                <div className="imp-form-grid-2">
                  <div className="imp-field">
                    <label>{bi("集群标识", "Cluster ID")}</label>
                    <Input
                      value={clusterId}
                      onChange={(v) => setClusterId(v.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    />
                  </div>
                  <div className="imp-field">
                    <label>{bi("架构形态摘要", "Architecture Summary")}</label>
                    <Input
                      placeholder={bi("例如：一主两从高可用 / 3节点集群", "e.g. 1 Primary + 2 Replicas HA")}
                      value={archSummary}
                      onChange={setArchSummary}
                    />
                  </div>
                  <div className="imp-field">
                    <label>{bi("主版本 / 精确版本", "Version / Exact Version")}</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Input
                        placeholder={bi("主版本，如 8.0", "Major, e.g. 8.0")}
                        value={version}
                        onChange={setVersion}
                      />
                      <Input
                        placeholder={bi("精确版本，如 8.0.36", "Exact, e.g. 8.0.36")}
                        value={exactVersion}
                        onChange={setExactVersion}
                      />
                    </div>
                  </div>
                  <div className="imp-field">
                    <label>{bi("操作系统 / 部署形态", "OS / Deploy Mode")}</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Select
                        allowClear
                        value={platform || undefined}
                        onChange={(v) => setPlatform(v || "")}
                        style={{ flex: 1 }}
                      >
                        {(presetsData?.platforms || []).map((pl) => (
                          <Select.Option key={pl.id} value={pl.id}>
                            {pl.title}
                          </Select.Option>
                        ))}
                        <Select.Option value="linux-custom">
                          {bi("其他 Linux", "Other Linux")}
                        </Select.Option>
                      </Select>
                      <Select value={deployMethod} onChange={setDeployMethod} style={{ width: 150 }}>
                        {DEPLOY_METHODS().map((dm) => (
                          <Select.Option key={dm.value} value={dm.value}>
                            {dm.label}
                          </Select.Option>
                        ))}
                      </Select>
                    </div>
                  </div>
                </div>
              </section>

              {/* Hosts Review */}
              <section className="imp-card">
                <div className="imp-card-head">
                  <h2>
                    {bi("节点清单", "Cluster Hosts")} ({validHosts.length})
                  </h2>
                  <Button
                    size="small"
                    icon={<IconPlus />}
                    onClick={() =>
                      setHosts((prev) => [
                        ...prev,
                        {
                          name: `${effectiveCompID}-${prev.length + 1}`,
                          ip: "",
                          role: effectiveRoles[Math.min(1, effectiveRoles.length - 1)]?.id || "node",
                        },
                      ])
                    }
                  >
                    {bi("添加节点", "Add Host")}
                  </Button>
                </div>
                <div className="imp-table-rows">
                  {hosts.map((h, idx) => (
                    <div key={idx} className="imp-host-row">
                      <Input
                        placeholder="hostname"
                        value={h.name}
                        onChange={(v) =>
                          setHosts((prev) =>
                            prev.map((r, i) => (i === idx ? { ...r, name: v } : r)),
                          )
                        }
                      />
                      <Input
                        placeholder="IP"
                        value={h.ip}
                        onChange={(v) =>
                          setHosts((prev) =>
                            prev.map((r, i) => (i === idx ? { ...r, ip: v } : r)),
                          )
                        }
                      />
                      <Select
                        allowCreate
                        value={h.role}
                        onChange={(v) =>
                          setHosts((prev) =>
                            prev.map((r, i) => (i === idx ? { ...r, role: v } : r)),
                          )
                        }
                      >
                        {effectiveRoles.map((r) => (
                          <Select.Option key={r.id} value={r.id}>
                            {isEn ? r.title_en || r.title : r.title}
                          </Select.Option>
                        ))}
                      </Select>
                      <Input
                        placeholder="/dev/vdb"
                        value={h.disk || ""}
                        onChange={(v) =>
                          setHosts((prev) =>
                            prev.map((r, i) => (i === idx ? { ...r, disk: v } : r)),
                          )
                        }
                      />
                      <Button
                        size="small"
                        type="text"
                        status="danger"
                        disabled={hosts.length <= 1}
                        icon={<IconDelete />}
                        onClick={() => setHosts((prev) => prev.filter((_, i) => i !== idx))}
                      />
                    </div>
                  ))}
                </div>
              </section>

              {/* Access Endpoints & Runtime Paths */}
              <section className="imp-card">
                <div className="imp-card-head">
                  <h2>{bi("访问入口、运行路径与关键参数（选填）", "Endpoints, Runtime Paths & Key Params (Optional)")}</h2>
                  <Button
                    size="small"
                    icon={<IconPlus />}
                    onClick={() =>
                      setEndpoints((prev) => [
                        ...prev,
                        { name: "writer", address: "", role: "readwrite" },
                      ])
                    }
                  >
                    {bi("添加访问入口", "Add Endpoint")}
                  </Button>
                </div>

                {endpoints.length > 0 && (
                  <div className="imp-table-rows">
                    {endpoints.map((ep, idx) => (
                      <div key={idx} className="imp-ep-row">
                        <Input
                          placeholder="writer"
                          value={ep.name || ""}
                          onChange={(v) =>
                            setEndpoints((prev) =>
                              prev.map((r, i) => (i === idx ? { ...r, name: v } : r)),
                            )
                          }
                        />
                        <Input
                          placeholder={`vip.internal:${selectedPreset?.default_port || 5432}`}
                          value={ep.address}
                          onChange={(v) =>
                            setEndpoints((prev) =>
                              prev.map((r, i) => (i === idx ? { ...r, address: v } : r)),
                            )
                          }
                        />
                        <Select
                          value={normalizeEndpointRole(ep.role)}
                          onChange={(v) =>
                            setEndpoints((prev) =>
                              prev.map((r, i) => (i === idx ? { ...r, role: v } : r)),
                            )
                          }
                        >
                          <Select.Option value="readwrite">{bi("读写入口", "Read/Write")}</Select.Option>
                          <Select.Option value="readonly">{bi("只读入口", "Read-Only")}</Select.Option>
                          <Select.Option value="admin">{bi("管理/控制台", "Admin")}</Select.Option>
                        </Select>
                        <Button
                          size="small"
                          type="text"
                          status="danger"
                          icon={<IconDelete />}
                          onClick={() => setEndpoints((prev) => prev.filter((_, i) => i !== idx))}
                        />
                      </div>
                    ))}
                  </div>
                )}

                <div className="imp-form-grid-2">
                  <div className="imp-field">
                    <label>{bi("系统服务单元", "Service Units")}</label>
                    <Input
                      placeholder={selectedPreset?.service_hints?.join(", ") || "service.name"}
                      value={serviceUnitsText}
                      onChange={setServiceUnitsText}
                    />
                  </div>
                  <div className="imp-field">
                    <label>{bi("配置文件路径", "Config Paths")}</label>
                    <Input
                      placeholder={selectedPreset?.config_hints?.[0] || "/etc/..."}
                      value={configPathsText}
                      onChange={setConfigPathsText}
                    />
                  </div>
                  <div className="imp-field">
                    <label>{bi("数据目录", "Data Directories")}</label>
                    <Input
                      placeholder={selectedPreset?.data_hints?.[0] || "/data/..."}
                      value={dataDirsText}
                      onChange={setDataDirsText}
                    />
                  </div>
                  <div className="imp-field">
                    <label>{bi("日志目录", "Log Directories")}</label>
                    <Input
                      placeholder={selectedPreset?.log_hints?.[0] || "/var/log/..."}
                      value={logDirsText}
                      onChange={setLogDirsText}
                    />
                  </div>
                </div>

                <div className="imp-field">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <label>{bi("关键运行参数（键值对）", "Key Runtime Parameters")}</label>
                    <Button
                      size="mini"
                      icon={<IconPlus />}
                      onClick={() => setParamRows((prev) => [...prev, { key: "", value: "" }])}
                    >
                      {bi("添加参数", "Add Param")}
                    </Button>
                  </div>
                  {paramRows.length > 0 && (
                    <div className="imp-table-rows">
                      {paramRows.map((pr, idx) => (
                        <div key={idx} className="imp-kv-row">
                          <Input
                            placeholder="max_connections"
                            value={pr.key}
                            onChange={(v) =>
                              setParamRows((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, key: v } : r)),
                              )
                            }
                          />
                          <Input
                            placeholder="500"
                            value={pr.value}
                            onChange={(v) =>
                              setParamRows((prev) =>
                                prev.map((r, i) => (i === idx ? { ...r, value: v } : r)),
                              )
                            }
                          />
                          <Button
                            size="small"
                            type="text"
                            status="danger"
                            icon={<IconDelete />}
                            onClick={() => setParamRows((prev) => prev.filter((_, i) => i !== idx))}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {packages.length > 0 && (
                  <div className="imp-field">
                    <label>
                      {bi(`已采集软件包（${packages.length} 项，用于安全 CVE 漏洞扫描）`, `Collected Packages (${packages.length}, used for CVE scanning)`)}
                    </label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {packages.slice(0, 12).map((pk, idx) => (
                        <Tag key={idx} size="small">
                          {pk.name}={pk.version}
                        </Tag>
                      ))}
                      {packages.length > 12 && (
                        <Tag size="small" color="gray">
                          +{packages.length - 12}
                        </Tag>
                      )}
                    </div>
                  </div>
                )}

                <div className="imp-field">
                  <label>{bi("运维备注（业务用途、维护窗口、注意事项）", "Operations Notes")}</label>
                  <Input.TextArea
                    autoSize={{ minRows: 2, maxRows: 5 }}
                    placeholder={bi(
                      "例如：承载核心账务系统；变更窗口为周日 02:00-04:00；已对接公司外部监控",
                      "e.g. Core billing workload; maintenance window Sun 02:00-04:00",
                    )}
                    value={notes}
                    onChange={setNotes}
                  />
                </div>
              </section>
            </div>

            {/* Right Sticky Preview Column */}
            <aside className="imp-review-side">
              <section className="imp-card">
                <div className="imp-card-head">
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <AppGlyph
                      id={effectiveCompID}
                      icon={effectiveIcon}
                      color={selectedPreset?.color}
                      size={32}
                    />
                    <div>
                      <h2>{clusterId || bi("待命名集群", "Unnamed Cluster")}</h2>
                      <p>
                        {effectiveDisplayName} {exactVersion || version || ""} ·{" "}
                        {bi(`${validHosts.length} 台节点`, `${validHosts.length} host(s)`)}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="imp-topo-wrap">
                  {validHosts.length > 0 ? (
                    <InstanceGraph
                      hosts={validHosts.map((h, i) => ({
                        name: h.name.trim() || `node-${i + 1}`,
                        ip: h.ip.trim() || "—",
                      }))}
                      instances={previewInstances}
                      controller={validHosts[0]?.name.trim()}
                    />
                  ) : (
                    <span className="muted small">
                      {bi("录入至少 1 台节点后实时渲染架构拓扑", "Add hosts to preview live topology")}
                    </span>
                  )}
                </div>
              </section>

              <section className="imp-card">
                <div className="imp-card-head">
                  <h2>{bi("完成纳管后立即解锁", "Capabilities Unlocked on Onboarding")}</h2>
                </div>
                <ul className="imp-unlock-list">
                  <li>
                    <span className="imp-unlock-dot" />
                    {bi("变更演练工作台 & 导出 Word 演练与实施方案报告", "Change Rehearsal Studio & Word SOP Reports")}
                  </li>
                  <li>
                    <span className="imp-unlock-dot" />
                    {bi("存量集群纳管基线档案（可随时在线修订与重新探针采集）", "Editable Baseline Archive & Re-Probing")}
                  </li>
                  <li>
                    <span className="imp-unlock-dot" />
                    {bi("同类中间件跨集群变更推广（交付集群 ↔ 纳管集群互通）", "Cross-Cluster Rollout Interoperability")}
                  </li>
                  <li>
                    <span className="imp-unlock-dot" />
                    {bi("安全 CVE 漏洞扫描与升级演练联动", "CVE Vulnerability Scanning & Remediation")}
                  </li>
                  <li>
                    <span className="imp-unlock-dot" />
                    {bi("免首次部署干扰（自动隐藏部署 Tab 与离线安装流程）", "Clean Day-2 Ops UI (Initial Deploy Tab Hidden)")}
                  </li>
                </ul>
                <div className="imp-footer-bar" style={{ paddingTop: 12 }}>
                  <Button onClick={() => setStep(2)}>
                    <IconArrowLeft /> {bi("返回修改", "Back")}
                  </Button>
                  <Button
                    type="primary"
                    loading={submitting}
                    disabled={!canAdvanceStep1 || validHosts.length === 0}
                    onClick={submitImport}
                  >
                    <IconCheck /> {bi("完成纳管建档", "Complete Onboarding")}
                  </Button>
                </div>
              </section>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Reusable Online Baseline Editor & Re-Probe Drawer (for Cluster Overview & Config) ---------- */

export function ImportedBaselineModal({
  visible,
  mode = "edit",
  cluster,
  onClose,
  onSaved,
}: {
  visible: boolean;
  mode?: "edit" | "probe";
  cluster: ClusterView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const lang = useLang();
  const isEn = lang === "en-US";
  const [tab, setTab] = useState<"edit" | "probe">(mode);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<ImportPayload | null>(null);

  const [hosts, setHosts] = useState<HostRow[]>([]);
  const [endpoints, setEndpoints] = useState<ImportedEndpoint[]>([]);
  const [version, setVersion] = useState("");
  const [exactVersion, setExactVersion] = useState("");
  const [platform, setPlatform] = useState("");
  const [deployMethod, setDeployMethod] = useState("systemd");
  const [archSummary, setArchSummary] = useState("");
  const [serviceUnitsText, setServiceUnitsText] = useState("");
  const [configPathsText, setConfigPathsText] = useState("");
  const [dataDirsText, setDataDirsText] = useState("");
  const [logDirsText, setLogDirsText] = useState("");
  const [paramRows, setParamRows] = useState<ParamRow[]>([]);
  const [packages, setPackages] = useState<ImportedPkg[]>([]);
  const [notes, setNotes] = useState("");

  // Re-probe state
  const [probeScript, setProbeScript] = useState("");
  const [probeFilename, setProbeFilename] = useState("mw-import-probe.sh");
  const [probeOutput, setProbeOutput] = useState("");
  const [parsing, setParsing] = useState(false);

  useEffect(() => {
    setTab(mode);
  }, [mode, visible]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setLoading(true);
    api<ImportPayload>(`/api/clusters/${encodeURIComponent(cluster.id)}/baseline`)
      .then((res) => {
        if (!alive) return;
        setData(res);
        setHosts(res.hosts || []);
        setEndpoints(
          (res.endpoints || []).map((ep) => ({
            ...ep,
            role: normalizeEndpointRole(ep.role),
          })),
        );
        setVersion(res.version || "");
        setExactVersion(res.exact_version || "");
        setPlatform(res.platform || "");
        setDeployMethod(res.deploy_method || "systemd");
        setArchSummary(res.arch_summary || "");
        setServiceUnitsText((res.service_units || []).join("\n"));
        setConfigPathsText((res.config_paths || []).join("\n"));
        setDataDirsText((res.data_dirs || []).join("\n"));
        setLogDirsText((res.log_dirs || []).join("\n"));
        setParamRows(
          Object.entries(res.params || {}).map(([k, v]) => ({
            key: k,
            value: typeof v === "string" ? v : (JSON.stringify(v) ?? ""),
          })),
        );
        setPackages(res.packages || []);
        setNotes(res.notes || "");
      })
      .catch((e: Error) => Message.error(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [visible, cluster.id]);

  useEffect(() => {
    if (!visible || tab !== "probe") return;
    let alive = true;
    api<{ script: string; filename: string }>("/api/clusters/import/probe-script", {
      method: "POST",
      body: JSON.stringify({
        component: cluster.app_id,
        display_name: cluster.app_name,
        deploy_method: deployMethod,
        service_units: splitLines(serviceUnitsText),
        config_paths: splitLines(configPathsText),
      }),
    })
      .then((res) => {
        if (!alive) return;
        setProbeScript(res.script);
        setProbeFilename(res.filename);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, tab, cluster.app_id, deployMethod]);

  const parseAndMergeProbe = async () => {
    if (!probeOutput.trim()) {
      Message.warning(bi("请先粘贴采集脚本终端输出", "Paste probe terminal output first"));
      return;
    }
    setParsing(true);
    try {
      const res = await api<ParseResp>("/api/clusters/import/parse", {
        method: "POST",
        body: JSON.stringify({
          component: cluster.app_id,
          display_name: cluster.app_name,
          source_kind: "probe",
          text: probeOutput,
        }),
      });
      const d = res.draft;
      if (d.version) setVersion(d.version);
      if (d.exact_version) setExactVersion(d.exact_version);
      if (d.platform) setPlatform(d.platform);
      if (d.deploy_method) setDeployMethod(d.deploy_method);
      if (d.hosts?.length) setHosts(d.hosts);
      if (d.service_units?.length) setServiceUnitsText(d.service_units.join("\n"));
      if (d.config_paths?.length) setConfigPathsText(d.config_paths.join("\n"));
      if (d.data_dirs?.length) setDataDirsText(d.data_dirs.join("\n"));
      if (d.log_dirs?.length) setLogDirsText(d.log_dirs.join("\n"));
      if (d.packages?.length) setPackages(d.packages);
      Message.success(
        bi("采集输出已解析并合并到表单，请核对后保存基线", "Probe parsed and merged; review and save"),
      );
      setTab("edit");
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
      setParsing(false);
    }
  };

  const saveBaseline = async () => {
    const paramsObj: Record<string, unknown> = {};
    for (const r of paramRows) {
      if (r.key.trim()) paramsObj[r.key.trim()] = r.value.trim();
    }
    setSaving(true);
    try {
      await api(`/api/clusters/${encodeURIComponent(cluster.id)}/baseline`, {
        method: "PUT",
        body: JSON.stringify({
          ...data,
          id: cluster.id,
          component: data?.component || cluster.app_id,
          display_name: data?.display_name || cluster.app_name,
          version: version.trim() || exactVersion.trim() || cluster.version,
          exact_version: exactVersion.trim() || undefined,
          platform: platform.trim() || undefined,
          deploy_method: deployMethod,
          arch_summary: archSummary.trim() || undefined,
          hosts: hosts.filter((h) => h.name.trim() || h.ip.trim()),
          endpoints: endpoints.filter((e) => e.address.trim()),
          service_units: splitLines(serviceUnitsText),
          config_paths: splitLines(configPathsText),
          data_dirs: splitLines(dataDirsText),
          log_dirs: splitLines(logDirsText),
          params: paramsObj,
          packages,
          notes: notes.trim() || undefined,
          last_probed_at: probeOutput.trim() ? new Date().toISOString() : data?.last_probed_at,
        }),
      });
      Message.success(bi("纳管基线档案已保存更新", "Imported baseline updated"));
      window.dispatchEvent(new Event("mh-clusters-changed"));
      await onSaved();
      onClose();
    } catch (e) {
      Message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      visible={visible}
      width={680}
      unmountOnExit
      title={
        tab === "probe"
          ? bi(`重新只读采集 · ${cluster.id}`, `Re-Run Read-Only Probe · ${cluster.id}`)
          : bi(`编辑存量纳管基线 · ${cluster.id}`, `Edit Imported Baseline · ${cluster.id}`)
      }
      onCancel={onClose}
      footer={
        tab === "probe" ? (
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, width: "100%" }}>
            <Button onClick={() => setTab("edit")}>
              {bi("切回手工编辑", "Switch to Edit")}
            </Button>
            <Button type="primary" loading={parsing} onClick={parseAndMergeProbe}>
              <IconRefresh /> {bi("解析回显并合并基线", "Parse & Merge into Baseline")}
            </Button>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, width: "100%" }}>
            <Button onClick={() => setTab("probe")}>
              <IconRefresh /> {bi("使用只读探针刷新", "Refresh via Probe")}
            </Button>
            <div className="row-gap">
              <Button onClick={onClose}>{bi("取消", "Cancel")}</Button>
              <Button type="primary" loading={saving} onClick={saveBaseline}>
                {bi("保存基线变更", "Save Baseline")}
              </Button>
            </div>
          </div>
        )
      }
    >
      {loading ? (
        <Skeleton text={{ rows: 8 }} animation />
      ) : tab === "probe" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="imp-probe-box">
            <div className="imp-probe-bar">
              <span className="imp-probe-shield">
                <IconCheckCircle />
                {bi(`100% 静态只读探针 · ${probeFilename}`, `100% Static Read-Only Probe · ${probeFilename}`)}
              </span>
              <Button
                size="mini"
                icon={<IconCopy />}
                onClick={() => {
                  copy(probeScript);
                  Message.success(bi("已复制脚本", "Copied"));
                }}
              >
                {bi("复制脚本", "Copy")}
              </Button>
            </div>
            <pre className="imp-probe-pre">{probeScript}</pre>
          </div>
          <div className="imp-field">
            <label>{bi("粘贴最新采集终端回显", "Paste Latest Probe Output")}</label>
            <Input.TextArea
              autoSize={{ minRows: 7, maxRows: 14 }}
              placeholder="=== MW_IMPORT_BEGIN === ..."
              value={probeOutput}
              onChange={setProbeOutput}
            />
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="imp-form-grid-2">
            <div className="imp-field">
              <label>{bi("主版本", "Major Version")}</label>
              <Input value={version} onChange={setVersion} />
            </div>
            <div className="imp-field">
              <label>{bi("精确版本", "Exact Version")}</label>
              <Input value={exactVersion} onChange={setExactVersion} />
            </div>
            <div className="imp-field">
              <label>{bi("部署形态", "Deploy Mode")}</label>
              <Select value={deployMethod} onChange={setDeployMethod}>
                {DEPLOY_METHODS().map((dm) => (
                  <Select.Option key={dm.value} value={dm.value}>
                    {dm.label}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <div className="imp-field">
              <label>{bi("架构形态摘要", "Architecture Summary")}</label>
              <Input value={archSummary} onChange={setArchSummary} />
            </div>
          </div>

          <div className="imp-field">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label>{bi("主机节点", "Hosts")}</label>
              <Button
                size="mini"
                icon={<IconPlus />}
                onClick={() =>
                  setHosts((prev) => [
                    ...prev,
                    { name: `${cluster.app_id}-${prev.length + 1}`, ip: "", role: "replica" },
                  ])
                }
              >
                {bi("添加节点", "Add Host")}
              </Button>
            </div>
            <div className="imp-table-rows">
              {hosts.map((h, idx) => (
                <div key={idx} className="imp-host-row">
                  <Input
                    value={h.name}
                    placeholder="hostname"
                    onChange={(v) =>
                      setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, name: v } : r)))
                    }
                  />
                  <Input
                    value={h.ip}
                    placeholder="IP"
                    onChange={(v) =>
                      setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, ip: v } : r)))
                    }
                  />
                  <Input
                    value={h.role}
                    placeholder="role"
                    onChange={(v) =>
                      setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, role: v } : r)))
                    }
                  />
                  <Input
                    value={h.disk || ""}
                    placeholder="/dev/vdb"
                    onChange={(v) =>
                      setHosts((prev) => prev.map((r, i) => (i === idx ? { ...r, disk: v } : r)))
                    }
                  />
                  <Button
                    size="small"
                    type="text"
                    status="danger"
                    disabled={hosts.length <= 1}
                    icon={<IconDelete />}
                    onClick={() => setHosts((prev) => prev.filter((_, i) => i !== idx))}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="imp-field">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label>{bi("访问入口（VIP / LB / 地址）", "Access Endpoints")}</label>
              <Button
                size="mini"
                icon={<IconPlus />}
                onClick={() =>
                  setEndpoints((prev) => [...prev, { name: "writer", address: "", role: "readwrite" }])
                }
              >
                {bi("添加入口", "Add Endpoint")}
              </Button>
            </div>
            <div className="imp-table-rows">
              {endpoints.map((ep, idx) => (
                <div key={idx} className="imp-ep-row">
                  <Input
                    value={ep.name || ""}
                    placeholder="writer"
                    onChange={(v) =>
                      setEndpoints((prev) => prev.map((r, i) => (i === idx ? { ...r, name: v } : r)))
                    }
                  />
                  <Input
                    value={ep.address}
                    placeholder="10.0.0.100:5432"
                    onChange={(v) =>
                      setEndpoints((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, address: v } : r)),
                      )
                    }
                  />
                  <Select
                    value={normalizeEndpointRole(ep.role)}
                    onChange={(v) =>
                      setEndpoints((prev) => prev.map((r, i) => (i === idx ? { ...r, role: v } : r)))
                    }
                  >
                    <Select.Option value="readwrite">{bi("读写", "RW")}</Select.Option>
                    <Select.Option value="readonly">{bi("只读", "RO")}</Select.Option>
                    <Select.Option value="admin">{bi("管理", "Admin")}</Select.Option>
                  </Select>
                  <Button
                    size="small"
                    type="text"
                    status="danger"
                    icon={<IconDelete />}
                    onClick={() => setEndpoints((prev) => prev.filter((_, i) => i !== idx))}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="imp-form-grid-2">
            <div className="imp-field">
              <label>{bi("系统服务单元", "Service Units")}</label>
              <Input value={serviceUnitsText} onChange={setServiceUnitsText} />
            </div>
            <div className="imp-field">
              <label>{bi("配置文件路径", "Config Paths")}</label>
              <Input value={configPathsText} onChange={setConfigPathsText} />
            </div>
            <div className="imp-field">
              <label>{bi("数据目录", "Data Dirs")}</label>
              <Input value={dataDirsText} onChange={setDataDirsText} />
            </div>
            <div className="imp-field">
              <label>{bi("日志目录", "Log Dirs")}</label>
              <Input value={logDirsText} onChange={setLogDirsText} />
            </div>
          </div>

          <div className="imp-field">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label>{bi("关键运行参数", "Key Parameters")}</label>
              <Button
                size="mini"
                icon={<IconPlus />}
                onClick={() => setParamRows((prev) => [...prev, { key: "", value: "" }])}
              >
                {bi("添加参数", "Add Param")}
              </Button>
            </div>
            <div className="imp-table-rows">
              {paramRows.map((pr, idx) => (
                <div key={idx} className="imp-kv-row">
                  <Input
                    value={pr.key}
                    placeholder="key"
                    onChange={(v) =>
                      setParamRows((prev) => prev.map((r, i) => (i === idx ? { ...r, key: v } : r)))
                    }
                  />
                  <Input
                    value={pr.value}
                    placeholder="value"
                    onChange={(v) =>
                      setParamRows((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, value: v } : r)),
                      )
                    }
                  />
                  <Button
                    size="small"
                    type="text"
                    status="danger"
                    icon={<IconDelete />}
                    onClick={() => setParamRows((prev) => prev.filter((_, i) => i !== idx))}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="imp-field">
            <label>{bi("运维备注", "Operations Notes")}</label>
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 5 }}
              value={notes}
              onChange={setNotes}
            />
          </div>
          {isEn ? null : null}
        </div>
      )}
    </Drawer>
  );
}

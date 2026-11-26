import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  InputNumber,
  Message,
  Modal,
  Radio,
  Select,
  Skeleton,
  Switch,
  Tabs,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconCheck,
  IconCode,
  IconCopy,
  IconDelete,
  IconDownload,
  IconExclamationCircle,
  IconFile,
  IconFolder,
  IconLaunch,
  IconPlus,
  IconRefresh,
  IconSave,
  IconSearch,
  IconUndo,
  IconUpload,
} from "@arco-design/web-react/icon";
import { api, can, useMedia } from "../../shared/shared";
import { go } from "../../app/router";
import { AppGlyph } from "../../design/ui";
import { bi, useLang } from "../../app/i18n";
import "./ansiblev2.css";

/* ---------- Studio 2.0 Native Ansible API Types ---------- */

type AssetKind =
  | "single_playbook"
  | "ansible_role"
  | "ansible_collection"
  | "playbook_project";

type AnsibleV2Summary = {
  name: string;
  title: string;
  title_en?: string;
  category: string;
  version: string;
  summary: string;
  summary_en?: string;
  icon?: string;
  color?: string;
  asset_kind: AssetKind;
  source: "builtin" | "custom" | "override";
  origin?: string;
  delivery_modes: string[];
  group_count: number;
  var_count: number;
  step_count: number;
  package_count: number;
  file_count: number;
  valid: boolean;
  tags?: string[];
};

type GroupSpec = {
  name: string;
  title?: string;
  title_en?: string;
  description?: string;
  min?: number;
  max?: number;
  default_count?: number;
  exclusive?: boolean;
};

type SchemeSpec = {
  id: string;
  title: string;
  title_en?: string;
  summary?: string;
  group_counts?: Record<string, number>;
  vars?: Record<string, unknown>;
};

type VarSpec = {
  key: string;
  label?: string;
  label_en?: string;
  group?: string;
  type?: string;
  default?: unknown;
  required?: boolean;
  choices?: string[];
  description?: string;
  source?: string;
};

type PackageHint = {
  name: string;
  platforms?: string[];
  detected_from?: string;
};

type PlayStep = {
  id: string;
  phase: string;
  playbook: string;
  play_name: string;
  hosts: string;
  tag?: string;
  title: string;
  effect: string;
  command: string;
};

type Problem = {
  severity: "error" | "warning";
  path?: string;
  message: string;
};

type Manifest = {
  schema: string;
  name: string;
  title: string;
  title_en?: string;
  category?: string;
  version?: string;
  summary?: string;
  summary_en?: string;
  icon?: string;
  color?: string;
  asset_kind?: AssetKind;
  source?: string;
  delivery_modes?: string[];
  entrypoints: {
    deploy: string;
    verify?: string;
    probe?: string;
    cleanup?: string;
  };
  groups?: GroupSpec[];
  schemes?: SchemeSpec[];
  vars?: VarSpec[];
  packages?: PackageHint[];
  tags?: string[];
};

type InspectionReport = {
  asset_kind: AssetKind;
  manifest: Manifest;
  manifest_yaml: string;
  manifest_auto_generated: boolean;
  playbooks: string[];
  roles: string[];
  requirements?: string[];
  steps: PlayStep[];
  vars: VarSpec[];
  packages: PackageHint[];
  problems: Problem[];
  file_count: number;
  valid: boolean;
};

type FileView = {
  path: string;
  kind: string;
  size: number;
  text?: string;
  binary?: boolean;
};

type AnsibleV2Detail = {
  name: string;
  source: "builtin" | "custom" | "override";
  report: InspectionReport;
  files: FileView[];
};

type RenderHost = {
  name: string;
  ip: string;
  groups: string[];
};

type RenderResult = {
  cluster_id: string;
  component: string;
  version: string;
  delivery_mode: string;
  controller: string;
  inventory_yaml: string;
  group_vars_yaml: string;
  ansible_cfg: string;
  deploy_playbook: string;
  steps: PlayStep[];
  file_paths: string[];
};

/* ---------- Labels & Sample Playbooks ---------- */

const assetKindLabel = (k: AssetKind | string) => {
  switch (k) {
    case "ansible_role":
      return bi("标准 Ansible Role", "Ansible Role");
    case "ansible_collection":
      return bi("Ansible Collection", "Ansible Collection");
    case "playbook_project":
      return bi("Playbook 工程仓库", "Playbook Project");
    case "single_playbook":
      return bi("单文件 Playbook", "Single Playbook");
    default:
      return k;
  }
};

const sourceLabel = (s: "builtin" | "custom" | "override") =>
  s === "builtin"
    ? bi("2.0 内置标杆", "2.0 Built-in")
    : s === "override"
      ? bi("已自定义覆盖", "Overridden")
      : bi("外部导入", "Imported");

const varSourceLabel = (s?: string) => {
  switch (s) {
    case "argument_specs":
      return "meta/argument_specs.yml";
    case "defaults":
      return "defaults/main.yml";
    case "group_vars":
      return "group_vars/all.yml";
    case "manifest":
      return "delivery-studio.yaml";
    default:
      return s || "ansible";
  }
};

const SAMPLE_NODE_EXPORTER = `---
- name: 部署 Prometheus Node Exporter（标准单文件 Playbook）
  hosts: exporters
  become: true
  vars:
    node_exporter_port: 9100
    node_exporter_listen_addr: "0.0.0.0"
  tasks:
    - name: 安装 prometheus-node-exporter 软件包
      ansible.builtin.package:
        name: prometheus-node-exporter
        state: present
      tags: [install]

    - name: 启动并启用服务
      ansible.builtin.systemd:
        name: prometheus-node-exporter
        state: started
        enabled: true
      tags: [service]

    - name: 验证指标监听端口可达
      ansible.builtin.wait_for:
        port: "{{ node_exporter_port }}"
        timeout: 10
      tags: [verify]
`;

const SAMPLE_HAPROXY_LB = `---
- name: 部署 HAProxy 生产负载均衡器
  hosts: loadbalancers
  become: true
  vars:
    haproxy_stats_port: 8404
    haproxy_frontend_port: 5000
    haproxy_maxconn: 4096
  tasks:
    - name: 安装 HAProxy 软件包
      ansible.builtin.package:
        name: haproxy
        state: present
      tags: [install]

    - name: 校验 HAProxy 配置语法
      ansible.builtin.command: haproxy -c -f /etc/haproxy/haproxy.cfg
      changed_when: false
      tags: [verify]

    - name: 启动并设置开机自启
      ansible.builtin.systemd:
        name: haproxy
        state: started
        enabled: true
      tags: [service]
`;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e || bi("操作失败", "Operation failed"));
}

function copyText(text: string) {
  if (!navigator.clipboard) {
    Message.info(bi("请手动复制内容", "Please copy manually"));
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => Message.success(bi("已复制到剪贴板", "Copied to clipboard")))
    .catch(() => Message.error(bi("复制失败", "Copy failed")));
}

/* ---------- Main Engine Switcher Component ---------- */

export function EngineSwitcher({
  engine,
  onChange,
}: {
  engine: "v2" | "v1";
  onChange: (next: "v2" | "v1") => void;
}) {
  useLang();
  return (
    <div
      className="av2-switcher"
      role="tablist"
      aria-label={bi("组件引擎切换", "Component engine switcher")}
    >
      <button
        type="button"
        role="tab"
        aria-selected={engine === "v2"}
        className={`av2-sw-btn ${engine === "v2" ? "is-on" : ""}`}
        onClick={() => onChange("v2")}
      >
        <span className="av2-sw-dot" />
        {bi("Ansible 2.0 原生", "Ansible 2.0 Native")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={engine === "v1"}
        className={`av2-sw-btn ${engine === "v1" ? "is-on" : ""}`}
        onClick={() => onChange("v1")}
      >
        {bi("v1 兼容组件", "v1 Legacy")}
      </button>
    </div>
  );
}

/* ---------- Main Ansible 2.0 Studio ---------- */

export function AnsibleV2Studio({
  onSwitchEngine,
}: {
  onSwitchEngine: (next: "v2" | "v1") => void;
}) {
  const lang = useLang();
  const narrow = useMedia("(max-width: 900px)");
  const canEdit = can("component.edit");
  const canImport = can("component.import") || canEdit;

  const [list, setList] = useState<AnsibleV2Summary[]>([]);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [loadErr, setLoadErr] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [importOpen, setImportOpen] = useState(false);

  const reload = useCallback(async (selectAfter?: string) => {
    try {
      const items = await api<AnsibleV2Summary[]>("/api/v2/ansible/components");
      setList(items);
      setLoad("ready");
      setLoadErr("");
      setSelected((cur) => {
        if (selectAfter && items.some((x) => x.name === selectAfter)) {
          return selectAfter;
        }
        if (cur && items.some((x) => x.name === cur)) return cur;
        return items[0]?.name || "";
      });
    } catch (e) {
      setLoadErr(errMsg(e));
      setLoad((s) => (s === "ready" ? s : "error"));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, lang]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) =>
      `${c.name} ${c.title} ${c.title_en || ""} ${c.category} ${c.summary} ${c.asset_kind} ${(c.tags || []).join(" ")}`
        .toLowerCase()
        .includes(q),
    );
  }, [list, query]);

  const activeSummary = list.find((x) => x.name === selected);

  return (
    <div className="md-split">
      {(!narrow || !selected) && (
        <aside
          className="md-list"
          aria-label={bi("Ansible 2.0 原生组件列表", "Ansible 2.0 Components")}
        >
          <div className="list-head">
            <div className="list-title">
              <h1>{bi("组件", "Components")}</h1>
              {canImport && (
                <Button
                  type="primary"
                  size="small"
                  icon={<IconUpload />}
                  onClick={() => setImportOpen(true)}
                  style={{ whiteSpace: "nowrap", flexShrink: 0 }}
                >
                  {bi("导入 Ansible", "Import Ansible")}
                </Button>
              )}
            </div>
            <EngineSwitcher engine="v2" onChange={onSwitchEngine} />
            <Input
              prefix={<IconSearch />}
              allowClear
              placeholder={bi(
                "搜索 Role / Collection / Playbook 组件",
                "Search Ansible 2.0 components",
              )}
              value={query}
              onChange={setQuery}
            />
          </div>

          {load === "loading" && !list.length ? (
            <div className="list-body">
              {[0, 1, 2].map((i) => (
                <div className="row-skel" key={i}>
                  <Skeleton animation text={{ rows: 2, width: ["52%", "76%"] }} />
                </div>
              ))}
            </div>
          ) : load === "error" && !list.length ? (
            <div className="list-state">
              <IconExclamationCircle className="bad" />
              <p>{loadErr || bi("加载失败", "Failed to load")}</p>
              <Button size="small" icon={<IconRefresh />} onClick={() => void reload()}>
                {bi("重试", "Retry")}
              </Button>
            </div>
          ) : !filtered.length ? (
            <div className="list-state">
              <p>{bi("没有匹配的 Ansible 2.0 组件", "No matching 2.0 components")}</p>
              {query ? (
                <Button size="small" onClick={() => setQuery("")}>
                  {bi("清除搜索", "Clear search")}
                </Button>
              ) : (
                canImport && (
                  <Button
                    type="primary"
                    size="small"
                    icon={<IconUpload />}
                    onClick={() => setImportOpen(true)}
                  >
                    {bi("立即导入首个 Ansible 资产", "Import your first Ansible asset")}
                  </Button>
                )
              )}
            </div>
          ) : (
            <div className="list-body" role="listbox">
              <div className="list-day">
                {bi(
                  `纯 Ansible 原生组件 (${filtered.length})`,
                  `Pure Ansible Components (${filtered.length})`,
                )}
              </div>
              {filtered.map((c) => {
                const title = bi(c.title, c.title_en || c.title);
                return (
                  <button
                    key={c.name}
                    type="button"
                    role="option"
                    aria-selected={c.name === selected}
                    className={`row ${c.name === selected ? "on" : ""}`}
                    onClick={() => setSelected(c.name)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      background: c.name === selected ? undefined : "transparent",
                      border: 0,
                      cursor: "pointer",
                    }}
                  >
                    <AppGlyph
                      id={c.name}
                      icon={c.icon}
                      color={c.color}
                      category={c.category}
                      size={36}
                    />
                    <div className="row-main cr">
                      <div className="row-top">
                        <span className="row-name sans">{title}</span>
                        <span className={`av2-src-pill is-${c.source}`}>
                          {sourceLabel(c.source)}
                        </span>
                      </div>
                      <div className="av2-rail-meta">
                        <span className="av2-kind-pill">
                          {assetKindLabel(c.asset_kind)}
                        </span>
                        <span>
                          {c.group_count} {bi("组", "grp")} · {c.var_count}{" "}
                          {bi("变量", "vars")} · {c.step_count} {bi("步", "steps")}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </aside>
      )}

      {(!narrow || selected) && (
        <section className="md-detail">
          {activeSummary ? (
            <AnsibleV2DetailPane
              key={activeSummary.name}
              name={activeSummary.name}
              canEdit={canEdit}
              narrow={narrow}
              onBack={() => setSelected("")}
              onChanged={(nextSelect) => void reload(nextSelect)}
            />
          ) : (
            <div className="detail-none enter">
              <h2>
                {bi(
                  "Kyndryl Delivery Studio 2.0 · 原生 Ansible 引擎",
                  "Kyndryl Delivery Studio 2.0 · Native Ansible Engine",
                )}
              </h2>
              <p style={{ color: "var(--mute)", maxWidth: 460, textAlign: "center" }}>
                {bi(
                  "直接导入市面上任意标准 Ansible Role、Collection、Playbook 仓库或单文件 YAML，自动解析分组、变量契约与离线包，零魔改一键交付。",
                  "Import any standard Ansible Role, Collection, Playbook repo, or single YAML file. Automatically extracts inventory groups, variables, and offline packages.",
                )}
              </p>
              {canImport && (
                <Button
                  type="primary"
                  icon={<IconUpload />}
                  onClick={() => setImportOpen(true)}
                >
                  {bi("导入 Ansible 资产", "Import Ansible Asset")}
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      <AnsibleV2ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(importedName) => {
          setImportOpen(false);
          void reload(importedName);
        }}
      />
    </div>
  );
}

/* ---------- Detail Pane (Overview / Source Editor / Render & Deliver) ---------- */

function AnsibleV2DetailPane({
  name,
  canEdit,
  narrow,
  onBack,
  onChanged,
}: {
  name: string;
  canEdit: boolean;
  narrow: boolean;
  onBack: () => void;
  onChanged: (nextSelect?: string) => void;
}) {
  const lang = useLang();
  const [detail, setDetail] = useState<AnsibleV2Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [tab, setTab] = useState<"overview" | "files" | "deliver">("overview");
  const deletingRef = useRef(false);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setLoadErr("");
    try {
      const d = await api<AnsibleV2Detail>(
        `/api/v2/ansible/components/${encodeURIComponent(name)}`,
      );
      setDetail(d);
    } catch (e) {
      setLoadErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const handleDeleteOrReset = () => {
    if (!detail || detail.source === "builtin") return;
    const isOverride = detail.source === "override";
    Modal.confirm({
      title: isOverride
        ? bi("恢复内置 2.0 标杆版本？", "Reset to Built-in 2.0 Version?")
        : bi("删除这个导入的 Ansible 2.0 组件？", "Delete this Ansible 2.0 Component?"),
      content: isOverride
        ? bi(
            `将清除对「${detail.name}」的自定义覆盖修改，恢复平台自带的纯 Ansible 标杆版本。`,
            `Custom overrides on "${detail.name}" will be discarded and reverted to the built-in Ansible 2.0 version.`,
          )
        : bi(
            `将永久删除组件「${detail.name}」及其保存的 Ansible 源码（不影响已生成的历史交付）。`,
            `This removes "${detail.name}" and its saved Ansible files (existing deliveries are unaffected).`,
          ),
      okText: isOverride ? bi("确认恢复", "Reset") : bi("确认删除", "Delete"),
      okButtonProps: { status: isOverride ? "warning" : "danger" },
      onOk: async () => {
        if (deletingRef.current) return;
        deletingRef.current = true;
        try {
          await api(`/api/v2/ansible/components/${encodeURIComponent(name)}`, {
            method: "DELETE",
          });
          Message.success(
            isOverride
              ? bi("已恢复内置版本", "Reverted to built-in version")
              : bi("组件已删除", "Component deleted"),
          );
          if (isOverride) {
            await loadDetail();
            onChanged(name);
          } else {
            onChanged();
          }
        } catch (e) {
          Message.error(errMsg(e));
        } finally {
          deletingRef.current = false;
        }
      },
    });
  };

  if (loading && !detail) {
    return (
      <div className="av2-detail">
        <Skeleton animation text={{ rows: 6 }} />
      </div>
    );
  }

  if (loadErr || !detail) {
    return (
      <div className="detail-none">
        <IconExclamationCircle className="bad" style={{ fontSize: 28 }} />
        <p>{loadErr || bi("加载组件详情失败", "Failed to load component")}</p>
        <Button icon={<IconRefresh />} onClick={() => void loadDetail()}>
          {bi("重试", "Retry")}
        </Button>
      </div>
    );
  }

  const m = detail.report.manifest;
  const title = bi(m.title || detail.name, m.title_en || m.title || detail.name);
  const summary = bi(m.summary || "", m.summary_en || m.summary || "");
  const deployCmd = `ansible-playbook -i inventory/hosts.yml ${m.entrypoints.deploy}`;

  return (
    <div className="av2-detail enter">
      <div className="av2-head">
        <div className="av2-head-left">
          {narrow && (
            <Button size="small" onClick={onBack}>
              {bi("返回", "Back")}
            </Button>
          )}
          <AppGlyph
            id={detail.name}
            icon={m.icon}
            color={m.color}
            category={m.category}
            size={44}
          />
          <div className="av2-head-info">
            <div className="av2-head-title-row">
              <h2 className="av2-head-title">{title}</h2>
              <span className="av2-slug">{detail.name}</span>
              <span className="av2-kind-pill">
                {assetKindLabel(detail.report.asset_kind)}
              </span>
              <span className={`av2-src-pill is-${detail.source}`}>
                {sourceLabel(detail.source)}
              </span>
              {m.version && <span className="av2-slug">v{m.version}</span>}
            </div>
            {summary && <p className="av2-summary">{summary}</p>}
          </div>
        </div>

        <div className="av2-head-actions">
          <Button
            type="primary"
            icon={<IconLaunch />}
            onClick={() => setTab("deliver")}
          >
            {bi("配置并生成交付", "Configure & Deliver")}
          </Button>
          <a
            href={`/api/v2/ansible/components/${encodeURIComponent(detail.name)}/export`}
            download={`${detail.name}-ansible-v2.tar.gz`}
            style={{ textDecoration: "none" }}
          >
            <Button icon={<IconDownload />}>
              {bi("导出标准 Ansible 包", "Export Ansible Tarball")}
            </Button>
          </a>
          {canEdit && detail.source !== "builtin" && (
            <Button
              status={detail.source === "override" ? "warning" : "danger"}
              icon={detail.source === "override" ? <IconUndo /> : <IconDelete />}
              onClick={handleDeleteOrReset}
            >
              {detail.source === "override"
                ? bi("恢复内置", "Reset Built-in")
                : bi("删除", "Delete")}
            </Button>
          )}
        </div>
      </div>

      <div className="av2-banner">
        <div className="av2-banner-text">
          <div className="av2-banner-title">
            <IconCode style={{ color: "var(--teal)" }} />
            {bi(
              "100% 标准原生 Ansible 工程 · 脱离平台也可直接执行",
              "100% Standard Native Ansible Project · Runnable Standalone",
            )}
          </div>
          <div className="av2-banner-sub">
            {bi(
              "无私有 DSL、无 mw.* 魔改变量。参数自动提取自 meta/argument_specs.yml 与 defaults/main.yml，交付时直接生成标准 inventory/hosts.yml 与 group_vars/all.yml。",
              "No proprietary DSL or mw.* wrappers. Variables come straight from meta/argument_specs.yml & defaults/main.yml and render into standard inventory/hosts.yml + group_vars/all.yml.",
            )}
          </div>
        </div>
        <div className="av2-cmd-inline">
          <span>{deployCmd}</span>
          <Button
            size="mini"
            type="text"
            icon={<IconCopy />}
            onClick={() => copyText(deployCmd)}
            aria-label={bi("复制命令", "Copy command")}
          />
        </div>
      </div>

      <Tabs
        activeTab={tab}
        onChange={(k) => setTab(k as "overview" | "files" | "deliver")}
        type="line"
      >
        <Tabs.TabPane
          key="overview"
          title={bi("概览与原生契约", "Overview & Contract")}
        >
          <OverviewTab detail={detail} />
        </Tabs.TabPane>
        <Tabs.TabPane
          key="files"
          title={bi(
            `Ansible 源码 (${detail.files.length})`,
            `Ansible Source (${detail.files.length})`,
          )}
        >
          <SourceEditorTab
            detail={detail}
            canEdit={canEdit}
            onSaved={(updated) => {
              setDetail(updated);
              onChanged(updated.name);
            }}
          />
        </Tabs.TabPane>
        <Tabs.TabPane
          key="deliver"
          title={bi("配置预览与生成交付", "Configure, Preview & Deliver")}
        >
          <DeliverTab detail={detail} />
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
}

/* ---------- Tab 1: Overview & Native Contract ---------- */

function OverviewTab({ detail }: { detail: AnsibleV2Detail }) {
  useLang();
  const r = detail.report;
  const m = r.manifest;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 12 }}>
      <div className="av2-grid-2">
        {/* Entrypoints & Structure */}
        <div className="av2-card">
          <div className="av2-card-head">
            <h3 className="av2-card-title">
              <IconFolder /> {bi("Playbook 入口与资产结构", "Playbook Entrypoints & Layout")}
            </h3>
            <span className="av2-card-sub">
              {r.file_count} {bi("个文件", "files")}
              {r.roles?.length ? ` · ${r.roles.length} Role` : ""}
            </span>
          </div>
          <div className="av2-ep-list">
            <div className="av2-ep-row">
              <span className="av2-ep-label">{bi("部署入口 (deploy)", "Deploy")}</span>
              <span className="av2-ep-path">{m.entrypoints.deploy}</span>
            </div>
            {m.entrypoints.verify && (
              <div className="av2-ep-row">
                <span className="av2-ep-label">{bi("验收检查 (verify)", "Verify")}</span>
                <span className="av2-ep-path">{m.entrypoints.verify}</span>
              </div>
            )}
            {m.entrypoints.probe && (
              <div className="av2-ep-row">
                <span className="av2-ep-label">{bi("只读探测 (probe)", "Probe")}</span>
                <span className="av2-ep-path">{m.entrypoints.probe}</span>
              </div>
            )}
            {m.entrypoints.cleanup && (
              <div className="av2-ep-row">
                <span className="av2-ep-label">{bi("清理回收 (cleanup)", "Cleanup")}</span>
                <span className="av2-ep-path">{m.entrypoints.cleanup}</span>
              </div>
            )}
          </div>
          {r.roles && r.roles.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span className="av2-card-sub">{bi("内置 Roles：", "Included Roles:")}</span>
              {r.roles.map((rl) => (
                <span key={rl} className="av2-slug">
                  roles/{rl}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Inventory Groups & Schemes */}
        <div className="av2-card">
          <div className="av2-card-head">
            <h3 className="av2-card-title">
              {bi("标准 Inventory 主机分组", "Standard Inventory Groups")}
            </h3>
            <span className="av2-card-sub">
              {(m.groups || []).length} {bi("个分组", "groups")}
            </span>
          </div>
          <div className="av2-group-list">
            {(m.groups || []).map((g) => (
              <div key={g.name} className="av2-group-item">
                <div className="av2-group-top">
                  <span className="av2-group-name">[{g.name}]</span>
                  <span className="av2-card-sub">
                    {bi(g.title || g.name, g.title_en || g.title || g.name)}
                    {g.min ? ` · ≥${g.min}` : ""}
                    {g.default_count ? ` · ${bi("默认", "default")} ${g.default_count}` : ""}
                  </span>
                </div>
                {g.description && <div className="av2-group-desc">{g.description}</div>}
              </div>
            ))}
          </div>
          {m.schemes && m.schemes.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="av2-card-sub">
                {bi("内置架构方案预设：", "Built-in Topology Schemes:")}
              </span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {m.schemes.map((sc) => (
                  <span key={sc.id} className="av2-kind-pill">
                    {bi(sc.title, sc.title_en || sc.title)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Auto-extracted Playbook Steps */}
      <div className="av2-card">
        <div className="av2-card-head">
          <h3 className="av2-card-title">
            {bi("自动解析的 Ansible 执行步骤", "Auto-Parsed Ansible Play Steps")}
          </h3>
          <span className="av2-card-sub">
            {r.steps.length} {bi("个步骤（支持 --check --diff）", "steps")}
          </span>
        </div>
        <div className="av2-steps">
          {r.steps.map((st) => (
            <div key={st.id} className="av2-step">
              <div className="av2-step-main">
                <div className="av2-step-title">
                  <span>{st.title}</span>
                  <span className="av2-slug">hosts: {st.hosts}</span>
                  {st.tag && <span className="av2-slug">--tags {st.tag}</span>}
                </div>
                <div className="av2-step-cmd">{st.command}</div>
              </div>
              <span
                className={`av2-effect-pill ${st.effect === "read-only" ? "is-ro" : "is-chg"}`}
              >
                {st.effect === "read-only"
                  ? bi("只读检查", "Read-only")
                  : bi("变更执行", "Change")}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Native Variables Contract */}
      <div className="av2-card">
        <div className="av2-card-head">
          <h3 className="av2-card-title">
            {bi("原生 Ansible 变量契约", "Native Ansible Variables")}
          </h3>
          <span className="av2-card-sub">
            {r.vars.length} {bi("个自动提取变量", "discovered variables")}
          </span>
        </div>
        {r.vars.length === 0 ? (
          <div className="av2-card-sub">
            {bi(
              "未在 meta/argument_specs.yml 或 defaults/main.yml 中发现声明变量，交付时仍可按需传入自定义变量。",
              "No variables declared in meta/argument_specs.yml or defaults/main.yml.",
            )}
          </div>
        ) : (
          <div className="av2-table-wrap">
            <table className="av2-table">
              <thead>
                <tr>
                  <th>{bi("变量名 (group_vars)", "Variable Key")}</th>
                  <th>{bi("类型", "Type")}</th>
                  <th>{bi("默认值 / 可选值", "Default / Choices")}</th>
                  <th>{bi("提取来源", "Source")}</th>
                  <th>{bi("说明", "Description")}</th>
                </tr>
              </thead>
              <tbody>
                {r.vars.map((v) => (
                  <tr key={v.key}>
                    <td>
                      <div style={{ fontFamily: "var(--mono)", fontWeight: 600 }}>
                        {v.key}
                      </div>
                      {v.label && v.label !== v.key && (
                        <div style={{ fontSize: 11.5, color: "var(--mute)" }}>
                          {bi(v.label, v.label_en || v.label)}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="av2-slug">{v.type || "string"}</span>
                    </td>
                    <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                      {v.type === "secret"
                        ? "••••••"
                        : v.default !== undefined && v.default !== null
                          ? typeof v.default === "object"
                            ? JSON.stringify(v.default)
                            : String(v.default)
                          : "-"}
                      {v.choices && v.choices.length > 0 && (
                        <div style={{ fontSize: 11, color: "var(--mute)", marginTop: 2 }}>
                          [{v.choices.join(" | ")}]
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="av2-slug">{varSourceLabel(v.source)}</span>
                    </td>
                    <td style={{ color: "var(--ink-2)" }}>{v.description || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Offline OS Packages & Validation */}
      <div className="av2-grid-2">
        <div className="av2-card">
          <div className="av2-card-head">
            <h3 className="av2-card-title">
              {bi("静态扫描的 OS 离线软件包", "Auto-Detected OS Packages")}
            </h3>
            <span className="av2-card-sub">
              {r.packages.length} {bi("个包", "pkgs")}
            </span>
          </div>
          {r.packages.length === 0 ? (
            <div className="av2-card-sub">
              {bi(
                "未静态扫描到 apt/yum/dnf/package 安装项（或由外部变量动态决定）。",
                "No static apt/yum/dnf/package entries detected.",
              )}
            </div>
          ) : (
            <div className="av2-pkg-wrap">
              {r.packages.map((p) => (
                <span key={p.name} className="av2-pkg-tag">
                  <span>{p.name}</span>
                  {p.detected_from && (
                    <span className="av2-pkg-from">{p.detected_from}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="av2-card">
          <div className="av2-card-head">
            <h3 className="av2-card-title">
              {bi("静态规范与安全校验", "Static Validation & Lint")}
            </h3>
            <span className="av2-card-sub">
              {r.valid ? bi("通过", "Valid") : bi("需修正", "Errors")}
            </span>
          </div>
          {r.problems.length === 0 ? (
            <div className="av2-problem-ok">
              <IconCheck />
              {bi(
                "所有 Playbook 语法、Role 引用与安全基线校验全部通过。",
                "All playbooks, role references, and safety checks passed.",
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {r.problems.map((p, i) => (
                <div key={i} className={`av2-problem is-${p.severity}`}>
                  <IconExclamationCircle style={{ marginTop: 2, flexShrink: 0 }} />
                  <div>
                    {p.path && (
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontWeight: 600,
                          marginRight: 6,
                        }}
                      >
                        {p.path}
                      </span>
                    )}
                    <span>{p.message}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Tab 2: Native Ansible Source Editor ---------- */

function SourceEditorTab({
  detail,
  canEdit,
  onSaved,
}: {
  detail: AnsibleV2Detail;
  canEdit: boolean;
  onSaved: (updated: AnsibleV2Detail) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [deleted, setDeleted] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string>(
    () =>
      detail.files.find((f) => f.path === "delivery-studio.yaml")?.path ||
      detail.files[0]?.path ||
      "",
  );
  const [saving, setSaving] = useState(false);
  const [addingFile, setAddingFile] = useState(false);
  const [newPath, setNewPath] = useState("");

  useEffect(() => {
    setDrafts({});
    setDeleted([]);
    setActivePath(
      detail.files.find((f) => f.path === "delivery-studio.yaml")?.path ||
        detail.files[0]?.path ||
        "",
    );
  }, [detail]);

  const filePaths = useMemo(() => {
    const set = new Set<string>();
    detail.files.forEach((f) => {
      if (!deleted.includes(f.path)) set.add(f.path);
    });
    Object.keys(drafts).forEach((p) => {
      if (!deleted.includes(p)) set.add(p);
    });
    return [...set].sort();
  }, [detail.files, drafts, deleted]);

  const originalMap = useMemo(() => {
    const m = new Map<string, FileView>();
    detail.files.forEach((f) => m.set(f.path, f));
    return m;
  }, [detail.files]);

  const currentFile = originalMap.get(activePath);
  const currentText =
    activePath in drafts ? drafts[activePath] : currentFile?.text ?? "";
  const isDirty = Object.keys(drafts).length > 0 || deleted.length > 0;

  const handleSave = async () => {
    if (!canEdit || !isDirty || saving) return;
    setSaving(true);
    try {
      const updated = await api<AnsibleV2Detail>(
        `/api/v2/ansible/components/${encodeURIComponent(detail.name)}`,
        {
          method: "PUT",
          body: JSON.stringify({ files: drafts, delete: deleted }),
        },
      );
      setDrafts({});
      setDeleted([]);
      onSaved(updated);
      Message.success(bi("已通过静态校验并保存", "Validated and saved"));
    } catch (e) {
      Message.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const handleAddFile = () => {
    const clean = newPath.trim().replace(/^\/+/, "").replace(/\\/g, "/");
    if (!clean || clean.includes("..")) {
      Message.warning(bi("请输入有效的相对文件路径", "Enter a valid relative path"));
      return;
    }
    setDeleted((d) => d.filter((x) => x !== clean));
    setDrafts((d) => ({ ...d, [clean]: d[clean] ?? "" }));
    setActivePath(clean);
    setNewPath("");
    setAddingFile(false);
  };

  return (
    <div style={{ paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="av2-files-layout">
        <div className="av2-file-tree">
          <div className="av2-file-tree-head">
            <span>{bi("标准 Ansible 目录树", "Ansible Tree")}</span>
            {canEdit && (
              <Button
                size="mini"
                icon={<IconPlus />}
                onClick={() => setAddingFile((v) => !v)}
              >
                {bi("新建", "New")}
              </Button>
            )}
          </div>
          {addingFile && (
            <div style={{ padding: 8, borderBottom: "1px solid var(--line)", display: "flex", gap: 6 }}>
              <Input
                size="mini"
                placeholder="playbooks/extra.yml"
                value={newPath}
                onChange={setNewPath}
                onPressEnter={handleAddFile}
              />
              <Button size="mini" type="primary" onClick={handleAddFile}>
                {bi("添加", "Add")}
              </Button>
            </div>
          )}
          <div className="av2-file-list">
            {filePaths.map((p) => {
              const dirty = p in drafts;
              return (
                <button
                  key={p}
                  type="button"
                  className={`av2-file-btn ${p === activePath ? "is-on" : ""}`}
                  onClick={() => setActivePath(p)}
                  title={p}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <IconFile style={{ flexShrink: 0 }} />
                    <span className="av2-file-path">{p}</span>
                  </span>
                  {dirty && <span className="av2-dirty-dot" />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="av2-editor-pane">
          <div className="av2-editor-bar">
            <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 600 }}>
              {activePath || "-"}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Button
                size="small"
                icon={<IconCopy />}
                onClick={() => copyText(currentText)}
              >
                {bi("复制", "Copy")}
              </Button>
              {canEdit &&
                activePath &&
                activePath !== "delivery-studio.yaml" &&
                activePath !== detail.report.manifest.entrypoints.deploy && (
                  <Button
                    size="small"
                    status="danger"
                    icon={<IconDelete />}
                    onClick={() => {
                      setDeleted((d) => [...d, activePath]);
                      setDrafts((d) => {
                        const next = { ...d };
                        delete next[activePath];
                        return next;
                      });
                      const rest = filePaths.filter((x) => x !== activePath);
                      setActivePath(rest[0] || "");
                    }}
                  >
                    {bi("删文件", "Remove")}
                  </Button>
                )}
              {canEdit && isDirty && (
                <Button
                  size="small"
                  icon={<IconUndo />}
                  onClick={() => {
                    setDrafts({});
                    setDeleted([]);
                  }}
                >
                  {bi("放弃修改", "Discard")}
                </Button>
              )}
              {canEdit && (
                <Tooltip
                  content={
                    isDirty
                      ? bi("执行 Ansible 校验并保存修改", "Validate and save changes")
                      : bi("当前没有未保存的改动", "No unsaved edits")
                  }
                >
                  <span style={{ display: "inline-flex" }}>
                    <Button
                      size="small"
                      type="primary"
                      icon={<IconSave />}
                      loading={saving}
                      disabled={!isDirty || saving}
                      onClick={() => void handleSave()}
                    >
                      {bi("校验并保存", "Validate & Save")}
                    </Button>
                  </span>
                </Tooltip>
              )}
            </div>
          </div>

          {currentFile?.binary ? (
            <div className="detail-none" style={{ minHeight: 320 }}>
              <p>{bi("二进制文件不支持在线文本编辑", "Binary file cannot be edited inline")}</p>
            </div>
          ) : (
            <textarea
              className="av2-code-area"
              value={currentText}
              readOnly={!canEdit}
              spellCheck={false}
              onChange={(e) => {
                if (!canEdit || !activePath) return;
                const val = e.target.value;
                setDrafts((d) => ({ ...d, [activePath]: val }));
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Tab 3: Live Configure, Standard Ansible Preview & One-Click Deliver ---------- */

function buildInitialHosts(manifest: Manifest, scheme?: SchemeSpec): RenderHost[] {
  const groups = manifest.groups || [];
  if (scheme?.group_counts && Object.keys(scheme.group_counts).length > 0) {
    const out: RenderHost[] = [];
    let seq = 1;
    Object.entries(scheme.group_counts).forEach(([grp, count]) => {
      for (let i = 0; i < Math.max(0, count); i++) {
        out.push({
          name: `${manifest.name.split("-")[0] || "node"}-${String(seq).padStart(2, "0")}`,
          ip: `10.10.0.${10 + seq}`,
          groups: [grp],
        });
        seq++;
      }
    });
    if (out.length > 0) return out;
  }
  const firstGroup = groups[0]?.name || "targets";
  const count = Math.max(1, groups[0]?.default_count || groups[0]?.min || 1);
  return Array.from({ length: count }, (_, idx) => ({
    name: `${manifest.name.split("-")[0] || "node"}-${String(idx + 1).padStart(2, "0")}`,
    ip: `10.10.0.${11 + idx}`,
    groups: [firstGroup],
  }));
}

function buildInitialVars(vars: VarSpec[], scheme?: SchemeSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  vars.forEach((v) => {
    if (v.default !== undefined) out[v.key] = v.default;
  });
  if (scheme?.vars) {
    Object.entries(scheme.vars).forEach(([k, v]) => {
      out[k] = v;
    });
  }
  return out;
}

function DeliverTab({ detail }: { detail: AnsibleV2Detail }) {
  useLang();
  const m = detail.report.manifest;
  const groups = m.groups && m.groups.length > 0 ? m.groups : [{ name: "targets", title: "目标主机" }];
  const schemes = m.schemes || [];

  const [clusterId, setClusterId] = useState(
    () => `${detail.name}-prod`,
  );
  const [platform, setPlatform] = useState("ubuntu-24.04-amd64");
  const [deliveryMode, setDeliveryMode] = useState<"offline" | "automatic">("offline");
  const [activeScheme, setActiveScheme] = useState<string>(schemes[0]?.id || "");
  const [hosts, setHosts] = useState<RenderHost[]>(() =>
    buildInitialHosts(m, schemes[0]),
  );
  const [vars, setVars] = useState<Record<string, unknown>>(() =>
    buildInitialVars(detail.report.vars, schemes[0]),
  );

  const [preview, setPreview] = useState<RenderResult | null>(null);
  const [previewErr, setPreviewErr] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewTab, setPreviewTab] = useState<"inventory" | "vars" | "cfg" | "steps">(
    "inventory",
  );
  const [delivering, setDelivering] = useState(false);

  const applyScheme = (sc: SchemeSpec) => {
    setActiveScheme(sc.id);
    setHosts(buildInitialHosts(m, sc));
    setVars(buildInitialVars(detail.report.vars, sc));
  };

  const runPreview = useCallback(async () => {
    const validHosts = hosts.filter((h) => h.ip.trim() !== "");
    if (validHosts.length === 0) {
      setPreview(null);
      setPreviewErr(bi("请至少填写 1 台目标主机的 IP 地址", "Provide at least 1 target host IP"));
      return;
    }
    setPreviewLoading(true);
    setPreviewErr("");
    try {
      const res = await api<RenderResult>(
        `/api/v2/ansible/components/${encodeURIComponent(detail.name)}/preview`,
        {
          method: "POST",
          body: JSON.stringify({
            cluster_id: clusterId.trim() || `${detail.name}-prod`,
            platform,
            delivery_mode: deliveryMode,
            scheme: activeScheme,
            hosts: validHosts,
            vars,
          }),
        },
      );
      setPreview(res);
    } catch (e) {
      setPreviewErr(errMsg(e));
    } finally {
      setPreviewLoading(false);
    }
  }, [detail.name, clusterId, platform, deliveryMode, activeScheme, hosts, vars]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void runPreview();
    }, 260);
    return () => window.clearTimeout(t);
  }, [runPreview]);

  const toggleHostGroup = (idx: number, gName: string) => {
    setHosts((prev) =>
      prev.map((h, i) => {
        if (i !== idx) return h;
        const has = h.groups.includes(gName);
        const nextGroups = has
          ? h.groups.filter((g) => g !== gName)
          : [...h.groups, gName];
        return {
          ...h,
          groups: nextGroups.length > 0 ? nextGroups : [gName],
        };
      }),
    );
  };

  const handleDeliver = async () => {
    const validHosts = hosts.filter((h) => h.ip.trim() !== "");
    if (!validHosts.length || delivering) return;
    setDelivering(true);
    try {
      const res = await api<{
        job_id: string;
        cluster_id: string;
        archive: string;
        sha256: string;
        steps_count: number;
      }>(`/api/v2/ansible/components/${encodeURIComponent(detail.name)}/deliver`, {
        method: "POST",
        body: JSON.stringify({
          cluster_id: clusterId.trim() || `${detail.name}-prod`,
          platform,
          delivery_mode: deliveryMode,
          scheme: activeScheme,
          hosts: validHosts,
          vars,
        }),
      });
      Message.success(
        bi(
          `已生成原生 Ansible 2.0 交付包 ${res.archive}（${res.steps_count} 步），正在打开交付手册…`,
          `Generated native Ansible 2.0 bundle ${res.archive} (${res.steps_count} steps). Opening Runbook…`,
        ),
      );
      go({ name: "deliveries", id: res.cluster_id, tab: "plans" });
    } catch (e) {
      Message.error(errMsg(e));
    } finally {
      setDelivering(false);
    }
  };

  const previewText = useMemo(() => {
    if (!preview) return "";
    switch (previewTab) {
      case "inventory":
        return preview.inventory_yaml;
      case "vars":
        return preview.group_vars_yaml;
      case "cfg":
        return preview.ansible_cfg;
      case "steps":
        return [
          `# Standalone Run Commands (${preview.cluster_id})`,
          ...preview.steps.map(
            (st, i) => `\n# [${i + 1}] ${st.title} (${st.effect})\n${st.command}`,
          ),
          `\n# Generated Project Files (${preview.file_paths.length}):`,
          ...preview.file_paths.map((p) => `#   - ${p}`),
        ].join("\n");
    }
  }, [preview, previewTab]);

  const canDeliver =
    hosts.some((h) => h.ip.trim() !== "") && !delivering && !previewErr;

  return (
    <div style={{ paddingTop: 12, display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Top Delivery Metadata */}
      <div className="av2-card">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 12,
          }}
        >
          <div className="av2-field">
            <label className="av2-field-label">
              {bi("集群 / 交付标识", "Cluster / Delivery ID")}
            </label>
            <Input
              value={clusterId}
              onChange={setClusterId}
              placeholder={`${detail.name}-prod`}
            />
          </div>
          <div className="av2-field">
            <label className="av2-field-label">
              {bi("目标操作系统平台", "Target OS Platform")}
            </label>
            <Select value={platform} onChange={setPlatform}>
              <Select.Option value="ubuntu-24.04-amd64">
                Ubuntu 24.04 LTS (amd64)
              </Select.Option>
              <Select.Option value="el9-amd64">
                RHEL / Rocky / AlmaLinux 9 (amd64)
              </Select.Option>
              <Select.Option value="kylin-v10-amd64">
                Kylin V10 SP3 (amd64)
              </Select.Option>
            </Select>
          </div>
          <div className="av2-field">
            <label className="av2-field-label">{bi("交付模式", "Delivery Mode")}</label>
            <Radio.Group
              type="button"
              value={deliveryMode}
              onChange={(v) => setDeliveryMode(v as "offline" | "automatic")}
            >
              <Radio value="offline">{bi("离线交付包", "Offline Bundle")}</Radio>
              <Radio value="automatic">{bi("自动编排执行", "Automated Run")}</Radio>
            </Radio.Group>
          </div>
        </div>

        {schemes.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="av2-field-label">
              {bi("快速应用架构方案（自动填充主机分组与变量）", "Quick Topology Presets")}
            </div>
            <div className="av2-scheme-grid">
              {schemes.map((sc) => (
                <button
                  key={sc.id}
                  type="button"
                  className={`av2-scheme-card ${activeScheme === sc.id ? "is-on" : ""}`}
                  onClick={() => applyScheme(sc)}
                >
                  <span className="av2-scheme-title">
                    {bi(sc.title, sc.title_en || sc.title)}
                  </span>
                  {sc.summary && <span className="av2-scheme-desc">{sc.summary}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Main Split: Left Form (Hosts + Native Vars), Right Live Standard Ansible Output */}
      <div className="av2-deliver-grid">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Hosts & Group Assignment */}
          <div className="av2-card">
            <div className="av2-card-head">
              <h3 className="av2-card-title">
                {bi("目标主机与 Ansible 分组", "Target Hosts & Ansible Groups")}
              </h3>
              <Button
                size="mini"
                icon={<IconPlus />}
                onClick={() =>
                  setHosts((prev) => [
                    ...prev,
                    {
                      name: `${detail.name.split("-")[0] || "node"}-${String(prev.length + 1).padStart(2, "0")}`,
                      ip: `10.10.0.${11 + prev.length}`,
                      groups: [groups[0].name],
                    },
                  ])
                }
              >
                {bi("添加主机", "Add Host")}
              </Button>
            </div>
            <div className="av2-host-list">
              {hosts.map((h, idx) => (
                <div key={idx} className="av2-host-row">
                  <div className="av2-host-inputs">
                    <Input
                      size="small"
                      placeholder={bi("主机名", "Hostname")}
                      value={h.name}
                      onChange={(v) =>
                        setHosts((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, name: v } : x)),
                        )
                      }
                    />
                    <Input
                      size="small"
                      placeholder="10.10.0.11"
                      value={h.ip}
                      onChange={(v) =>
                        setHosts((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, ip: v } : x)),
                        )
                      }
                    />
                    <Button
                      size="small"
                      type="text"
                      status="danger"
                      disabled={hosts.length <= 1}
                      icon={<IconDelete />}
                      onClick={() =>
                        setHosts((prev) => prev.filter((_, i) => i !== idx))
                      }
                    />
                  </div>
                  <div className="av2-gchip-row">
                    <span className="av2-card-sub">
                      {bi("所属分组：", "Groups:")}
                    </span>
                    {groups.map((g) => {
                      const on = h.groups.includes(g.name);
                      return (
                        <button
                          key={g.name}
                          type="button"
                          className={`av2-gchip ${on ? "is-on" : ""}`}
                          onClick={() => toggleHostGroup(idx, g.name)}
                        >
                          {on && <IconCheck style={{ fontSize: 11 }} />}
                          <span>{g.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Native Ansible Variables Form */}
          <div className="av2-card">
            <div className="av2-card-head">
              <h3 className="av2-card-title">
                {bi("标准 Ansible 变量 (group_vars/all.yml)", "Ansible Variables")}
              </h3>
              <span className="av2-card-sub">
                {detail.report.vars.length} {bi("项", "vars")}
              </span>
            </div>
            {detail.report.vars.length === 0 ? (
              <div className="av2-card-sub">
                {bi("该组件无需额外变量，可直接生成标准交付。", "No configurable variables needed.")}
              </div>
            ) : (
              <div className="av2-vars-form">
                {detail.report.vars.map((v) => {
                  const val = vars[v.key];
                  const label = bi(v.label || v.key, v.label_en || v.label || v.key);
                  const setVal = (nv: unknown) =>
                    setVars((prev) => ({ ...prev, [v.key]: nv }));

                  return (
                    <div key={v.key} className="av2-field">
                      <label className="av2-field-label">
                        <span>{label}</span>
                        <span className="av2-field-key">{v.key}</span>
                      </label>
                      {v.type === "bool" ? (
                        <div>
                          <Switch
                            size="small"
                            checked={Boolean(val)}
                            onChange={(c) => setVal(c)}
                          />
                        </div>
                      ) : v.type === "select" && v.choices && v.choices.length > 0 ? (
                        <Select
                          size="small"
                          value={val !== undefined ? String(val) : undefined}
                          onChange={(nv) => setVal(nv)}
                        >
                          {v.choices.map((ch) => (
                            <Select.Option key={ch} value={ch}>
                              {ch}
                            </Select.Option>
                          ))}
                        </Select>
                      ) : v.type === "int" || v.type === "port" ? (
                        <InputNumber
                          size="small"
                          value={
                            typeof val === "number"
                              ? val
                              : Number(val || 0)
                          }
                          min={v.type === "port" ? 1 : undefined}
                          max={v.type === "port" ? 65535 : undefined}
                          onChange={(nv) => setVal(nv)}
                          style={{ width: "100%" }}
                        />
                      ) : v.type === "secret" ? (
                        <Input.Password
                          size="small"
                          value={val !== undefined ? String(val) : ""}
                          placeholder={bi("留空则由 Ansible 自动生成或使用默认", "Leave blank for default")}
                          onChange={(nv) => setVal(nv)}
                        />
                      ) : (
                        <Input
                          size="small"
                          value={
                            val === undefined || val === null
                              ? ""
                              : typeof val === "object"
                                ? JSON.stringify(val)
                                : String(val)
                          }
                          onChange={(nv) => setVal(nv)}
                        />
                      )}
                      {v.description && (
                        <span className="av2-field-hint">{v.description}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Live Preview & Deliver Action */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="av2-preview-box">
            <div className="av2-preview-tabs">
              <div className="av2-preview-tab-list">
                {(
                  [
                    ["inventory", "inventory/hosts.yml"],
                    ["vars", "group_vars/all.yml"],
                    ["cfg", "ansible.cfg"],
                    ["steps", bi("执行命令与清单", "Commands")],
                  ] as const
                ).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    className={`av2-ptab ${previewTab === k ? "is-on" : ""}`}
                    onClick={() => setPreviewTab(k)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <Button
                  size="mini"
                  type="text"
                  icon={<IconRefresh spin={previewLoading} />}
                  style={{ color: "var(--term-mute)" }}
                  onClick={() => void runPreview()}
                />
                <Button
                  size="mini"
                  type="text"
                  icon={<IconCopy />}
                  style={{ color: "var(--term-mute)" }}
                  onClick={() => copyText(previewText)}
                />
              </div>
            </div>

            {previewErr ? (
              <div style={{ padding: 16, color: "#fca5a5", fontSize: 12.5 }}>
                {previewErr}
              </div>
            ) : (
              <pre className="av2-preview-pre">
                {previewText || bi("正在渲染标准 Ansible 产物…", "Rendering standard Ansible output…")}
              </pre>
            )}
          </div>

          <div
            className="av2-card"
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                {bi(
                  "一键打包标准 Ansible 2.0 交付工程",
                  "Generate Standard Ansible 2.0 Delivery",
                )}
              </span>
              <span className="av2-card-sub">
                {bi(
                  "自动生成 .tar.gz 独立工程、SHA256SUMS 与交互式交付手册",
                  "Creates standalone .tar.gz, SHA256SUMS & interactive Runbook",
                )}
              </span>
            </div>
            <Tooltip
              content={
                canDeliver
                  ? bi("生成标准交付并跳转到交付手册", "Generate delivery and open Runbook")
                  : bi("请先填写有效的主机 IP 且确保预览无误", "Provide valid host IP first")
              }
            >
              <span style={{ display: "inline-flex" }}>
                <Button
                  type="primary"
                  icon={<IconLaunch />}
                  loading={delivering}
                  disabled={!canDeliver}
                  onClick={() => void handleDeliver()}
                >
                  {bi("生成 2.0 交付并打开手册", "Generate Delivery & Open Runbook")}
                </Button>
              </span>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Universal Market Ansible Asset Importer Modal ---------- */

function AnsibleV2ImportModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (name: string) => void;
}) {
  const [mode, setMode] = useState<"upload" | "git" | "yaml">("upload");
  const [nameHint, setNameHint] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [gitUrl, setGitUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [gitSubdir, setGitSubdir] = useState("");
  const [yamlFilename, setYamlFilename] = useState("deploy.yml");
  const [yamlContent, setYamlContent] = useState("");

  const [inspecting, setInspecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [inspected, setInspected] = useState<{
    report: InspectionReport;
    files: FileView[];
    origin: string;
  } | null>(null);
  const [finalName, setFinalName] = useState("");
  const [manifestYAML, setManifestYAML] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const resetAll = () => {
    setInspected(null);
    setFinalName("");
    setManifestYAML("");
    setUploadFile(null);
    setNameHint("");
  };

  useEffect(() => {
    if (!open) resetAll();
  }, [open]);

  const handleInspect = async () => {
    if (inspecting) return;
    setInspecting(true);
    try {
      let resp: { report: InspectionReport; files: FileView[] };
      let origin = "";
      if (mode === "upload") {
        if (!uploadFile) {
          Message.warning(bi("请先选择 .zip / .tar.gz / .yml 文件", "Choose a file first"));
          setInspecting(false);
          return;
        }
        const fd = new FormData();
        fd.append("file", uploadFile);
        if (nameHint.trim()) fd.append("name", nameHint.trim());
        origin = `upload:${uploadFile.name}`;
        resp = await api<{ report: InspectionReport; files: FileView[] }>(
          "/api/v2/ansible/inspect",
          { method: "POST", body: fd },
        );
      } else if (mode === "git") {
        if (!gitUrl.trim()) {
          Message.warning(bi("请输入 Git 仓库地址", "Enter a Git repository URL"));
          setInspecting(false);
          return;
        }
        origin = gitUrl.trim();
        resp = await api<{ report: InspectionReport; files: FileView[] }>(
          "/api/v2/ansible/inspect",
          {
            method: "POST",
            body: JSON.stringify({
              mode: "git",
              name: nameHint.trim(),
              git_url: gitUrl.trim(),
              branch: gitBranch.trim(),
              subdir: gitSubdir.trim(),
            }),
          },
        );
      } else {
        if (!yamlContent.trim()) {
          Message.warning(bi("请粘贴标准 Ansible Playbook YAML", "Paste Playbook YAML"));
          setInspecting(false);
          return;
        }
        origin = `paste:${yamlFilename.trim() || "deploy.yml"}`;
        resp = await api<{ report: InspectionReport; files: FileView[] }>(
          "/api/v2/ansible/inspect",
          {
            method: "POST",
            body: JSON.stringify({
              mode: "yaml",
              name: nameHint.trim(),
              filename: yamlFilename.trim() || "deploy.yml",
              content: yamlContent,
            }),
          },
        );
      }
      setInspected({ report: resp.report, files: resp.files, origin });
      setFinalName(resp.report.manifest.name);
      setManifestYAML(resp.report.manifest_yaml);
    } catch (e) {
      Message.error(errMsg(e));
    } finally {
      setInspecting(false);
    }
  };

  const handleConfirmImport = async () => {
    if (!inspected || importing) return;
    setImporting(true);
    try {
      const fileMap: Record<string, string> = {};
      inspected.files.forEach((f) => {
        if (!f.binary && f.text !== undefined) {
          fileMap[f.path] = f.text;
        }
      });
      const saved = await api<AnsibleV2Detail>("/api/v2/ansible/import", {
        method: "POST",
        body: JSON.stringify({
          name: finalName.trim() || inspected.report.manifest.name,
          source: inspected.origin,
          manifest_yaml: manifestYAML,
          files: fileMap,
        }),
      });
      Message.success(
        bi(
          `已成功导入 Ansible 2.0 组件「${saved.name}」`,
          `Imported Ansible 2.0 component "${saved.name}"`,
        ),
      );
      onImported(saved.name);
    } catch (e) {
      Message.error(errMsg(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      visible={open}
      onCancel={onClose}
      title={bi(
        "导入市面上任意标准 Ansible 资产为 2.0 组件",
        "Import Any Standard Ansible Asset (2.0)",
      )}
      style={{ width: 780, maxWidth: "94vw" }}
      footer={
        inspected ? (
          <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
            <Button onClick={() => setInspected(null)}>
              {bi("返回重新选择", "Back")}
            </Button>
            <div style={{ display: "flex", gap: 8 }}>
              <Button onClick={onClose}>{bi("取消", "Cancel")}</Button>
              <Button
                type="primary"
                loading={importing}
                disabled={!inspected.report.valid || importing}
                onClick={() => void handleConfirmImport()}
              >
                {bi("确认导入为 2.0 组件", "Confirm Import")}
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={onClose}>{bi("取消", "Cancel")}</Button>
            <Button
              type="primary"
              loading={inspecting}
              onClick={() => void handleInspect()}
            >
              {bi("扫描并解析资产", "Inspect & Parse")}
            </Button>
          </div>
        )
      }
    >
      {!inspected ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="av2-card-sub" style={{ lineHeight: 1.55 }}>
            {bi(
              "原生支持 4 类市面标准 Ansible 形态：标准 Ansible Role、Ansible Collection（galaxy.yml）、完整 Playbook 仓库（如 vitabaks/postgresql_cluster）、以及单文件 Playbook YAML。原文件零修改，自动提取分组、变量与离线包。",
              "Supports all 4 standard Ansible forms: Ansible Role, Collection (galaxy.yml), Playbook Git/Archive repos, and single Playbook YAML. Source code stays untouched.",
            )}
          </div>

          <Tabs
            activeTab={mode}
            onChange={(k) => setMode(k as "upload" | "git" | "yaml")}
            type="rounded"
          >
            <Tabs.TabPane
              key="upload"
              title={bi("上传归档 / 单文件", "Upload Archive / YAML")}
            >
              <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip,.tar.gz,.tgz,.tar,.yml,.yaml"
                  style={{ display: "none" }}
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                />
                <div
                  className="av2-dropzone"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <IconUpload style={{ fontSize: 26, color: "var(--teal)", marginBottom: 6 }} />
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>
                    {uploadFile
                      ? `${uploadFile.name} (${(uploadFile.size / 1024).toFixed(1)} KB)`
                      : bi(
                          "点击选择 .zip / .tar.gz / .tgz / .yml 文件",
                          "Click to choose .zip / .tar.gz / .tgz / .yml",
                        )}
                  </div>
                  <div className="av2-card-sub" style={{ marginTop: 4 }}>
                    {bi(
                      "直接上传 GitHub Download ZIP、Galaxy Role 压缩包或单个 Playbook 文件（上限 32MB）",
                      "Upload GitHub ZIP, Galaxy tarball, or single Playbook YAML (max 32MB)",
                    )}
                  </div>
                </div>
                <Input
                  prefix={<span className="av2-card-sub">{bi("组件标识(可选)", "Slug")}</span>}
                  placeholder={bi("留空则根据文件名/仓库名自动推导", "Auto-inferred if blank")}
                  value={nameHint}
                  onChange={setNameHint}
                />
              </div>
            </Tabs.TabPane>

            <Tabs.TabPane key="git" title={bi("Git 仓库导入", "Git Repository")}>
              <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="av2-field">
                  <label className="av2-field-label">
                    {bi("Git 仓库地址 (HTTPS / HTTP)", "Git Repository URL")}
                  </label>
                  <Input
                    placeholder="https://github.com/geerlingguy/ansible-role-nginx.git"
                    value={gitUrl}
                    onChange={setGitUrl}
                  />
                </div>
                <div className="av2-grid-2">
                  <div className="av2-field">
                    <label className="av2-field-label">
                      {bi("分支 / Tag（可选）", "Branch / Tag (Optional)")}
                    </label>
                    <Input
                      placeholder="main"
                      value={gitBranch}
                      onChange={setGitBranch}
                    />
                  </div>
                  <div className="av2-field">
                    <label className="av2-field-label">
                      {bi("子目录（Monorepo 可选）", "Subdirectory (Optional)")}
                    </label>
                    <Input
                      placeholder="roles/postgresql"
                      value={gitSubdir}
                      onChange={setGitSubdir}
                    />
                  </div>
                </div>
                <Input
                  prefix={<span className="av2-card-sub">{bi("组件标识(可选)", "Slug")}</span>}
                  placeholder={bi("例如 postgresql-cluster", "e.g. postgresql-cluster")}
                  value={nameHint}
                  onChange={setNameHint}
                />
              </div>
            </Tabs.TabPane>

            <Tabs.TabPane key="yaml" title={bi("粘贴 Playbook YAML", "Paste Playbook YAML")}>
              <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="av2-card-sub">{bi("快速体验示例：", "Try sample:")}</span>
                  <Button
                    size="mini"
                    onClick={() => {
                      setNameHint("node-exporter");
                      setYamlFilename("node-exporter.yml");
                      setYamlContent(SAMPLE_NODE_EXPORTER);
                    }}
                  >
                    Node Exporter
                  </Button>
                  <Button
                    size="mini"
                    onClick={() => {
                      setNameHint("haproxy-lb");
                      setYamlFilename("haproxy.yml");
                      setYamlContent(SAMPLE_HAPROXY_LB);
                    }}
                  >
                    HAProxy LB
                  </Button>
                </div>
                <div className="av2-grid-2">
                  <Input
                    prefix={<span className="av2-card-sub">{bi("组件标识", "Slug")}</span>}
                    placeholder="my-service"
                    value={nameHint}
                    onChange={setNameHint}
                  />
                  <Input
                    prefix={<span className="av2-card-sub">{bi("文件名", "File")}</span>}
                    placeholder="deploy.yml"
                    value={yamlFilename}
                    onChange={setYamlFilename}
                  />
                </div>
                <textarea
                  className="av2-code-area"
                  style={{
                    minHeight: 220,
                    border: "1px solid var(--line-strong)",
                    borderRadius: "var(--r)",
                  }}
                  placeholder={bi(
                    "在此粘贴任意标准 Ansible Playbook YAML…",
                    "Paste any standard Ansible Playbook YAML here…",
                  )}
                  value={yamlContent}
                  spellCheck={false}
                  onChange={(e) => setYamlContent(e.target.value)}
                />
              </div>
            </Tabs.TabPane>
          </Tabs>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="av2-banner" style={{ padding: "10px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="av2-kind-pill">
                {assetKindLabel(inspected.report.asset_kind)}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                {inspected.report.manifest_auto_generated
                  ? bi(
                      "已自动推导并生成 delivery-studio.yaml 薄契约（原 Ansible 源码零改动）",
                      "Auto-generated delivery-studio.yaml adapter (original Ansible files untouched)",
                    )
                  : bi("已加载自带的 delivery-studio.yaml", "Loaded existing delivery-studio.yaml")}
              </span>
            </div>
          </div>

          <div className="av2-import-summary">
            <div className="av2-stat-tile">
              <span className="av2-stat-num">{inspected.report.file_count}</span>
              <span className="av2-stat-lbl">{bi("Ansible 文件", "Files")}</span>
            </div>
            <div className="av2-stat-tile">
              <span className="av2-stat-num">
                {(inspected.report.manifest.groups || []).length}
              </span>
              <span className="av2-stat-lbl">{bi("Inventory 分组", "Groups")}</span>
            </div>
            <div className="av2-stat-tile">
              <span className="av2-stat-num">{inspected.report.vars.length}</span>
              <span className="av2-stat-lbl">{bi("提取变量", "Variables")}</span>
            </div>
            <div className="av2-stat-tile">
              <span className="av2-stat-num">{inspected.report.packages.length}</span>
              <span className="av2-stat-lbl">{bi("探测 OS 包", "OS Packages")}</span>
            </div>
          </div>

          {inspected.report.problems.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {inspected.report.problems.map((p, i) => (
                <div key={i} className={`av2-problem is-${p.severity}`}>
                  <IconExclamationCircle style={{ marginTop: 2, flexShrink: 0 }} />
                  <span>
                    {p.path ? `${p.path}: ` : ""}
                    {p.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="av2-field">
            <label className="av2-field-label">
              {bi("导入后的组件标识 (Slug)", "Component Identifier (Slug)")}
            </label>
            <Input
              value={finalName}
              onChange={setFinalName}
              placeholder="my-ansible-component"
            />
          </div>

          <div className="av2-field">
            <label className="av2-field-label">
              <span>delivery-studio.yaml ({bi("可按需微调标题/分组/方案", "Editable adapter")})</span>
            </label>
            <textarea
              className="av2-code-area"
              style={{
                minHeight: 220,
                border: "1px solid var(--line-strong)",
                borderRadius: "var(--r)",
              }}
              value={manifestYAML}
              spellCheck={false}
              onChange={(e) => setManifestYAML(e.target.value)}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}

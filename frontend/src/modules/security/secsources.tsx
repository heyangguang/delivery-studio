import React, { useState } from "react";
import {
  Button,
  Input,
  Message,
  Modal,
  Select,
  Switch,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconCheckCircleFill,
  IconDelete,
  IconEdit,
  IconExclamationCircleFill,
  IconPlus,
  IconRefresh,
  IconSync,
} from "@arco-design/web-react/icon";
import { ago, api, err, fullTime } from "../../shared/shared";
import { bi, useLang } from "../../app/i18n";

export type SecFeedSource = {
  id: string;
  name: string;
  kind: "osv_api" | "json_feed" | "bundle_url" | "cisa_kev" | string;
  url: string;
  enabled: boolean;
  builtin?: boolean;
  ecosystems?: string[];
  auth_header?: string;
  has_auth_token?: boolean;
  insecure_tls?: boolean;
  note?: string;
  last_sync_at?: string;
  last_sync_count?: number;
  last_sync_error?: string;
  last_sync_ms?: number;
};

type TestResult = {
  ok: boolean;
  status_code?: number;
  latency_ms: number;
  sample_count?: number;
  message: string;
};

const KIND_OPTIONS = () => [
  {
    value: "osv_api",
    label: bi("OSV 兼容 API（官方或内网镜像）", "OSV Compatible API (Official / Mirror)"),
    short: "OSV API",
    hint: bi(
      "支持 /v1/querybatch 与 /v1/vulns/{id} 接口，按本平台 SBOM 增量精准查询。",
      "Queries /v1/querybatch & /v1/vulns/{id} matching your platform SBOM.",
    ),
    placeholder: "https://api.osv.dev",
  },
  {
    value: "json_feed",
    label: bi("CVE / OSV JSON 订阅 URL", "CVE / OSV JSON Feed URL"),
    short: bi("JSON 订阅", "JSON Feed"),
    hint: bi(
      "HTTP/HTTPS 返回标准 OSV JSON 数组或本平台 advisories JSON 列表，适合企业自建漏洞通告源。",
      "HTTP/HTTPS endpoint returning OSV JSON array or native advisories list.",
    ),
    placeholder: "https://sec-mirror.internal/cve/advisories.json",
  },
  {
    value: "bundle_url",
    label: bi("离线漏洞库包 URL (.tar.gz)", "Offline Bundle URL (.tar.gz)"),
    short: bi("离线包 URL", "Bundle URL"),
    hint: bi(
      "从内网文件服务器/制品库拉取由另一台 Kyndryl Delivery Studio 导出的 .tar.gz 漏洞库包（自动校验 SHA256SUMS）。",
      "Pulls a SHA256-verified .tar.gz bundle exported from another Kyndryl Delivery Studio instance.",
    ),
    placeholder: "https://artifacts.internal/security/mh-cve-db-latest.tar.gz",
  },
  {
    value: "cisa_kev",
    label: bi("CISA KEV 在野活跃利用目录", "CISA KEV Exploited Catalog"),
    short: "CISA KEV",
    hint: bi(
      "拉取 CISA KEV JSON（或内网镜像），为本地已命中 CVE 标注在野活跃利用高优警示。",
      "Fetches CISA KEV JSON to flag locally matched CVEs as actively exploited.",
    ),
    placeholder:
      "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
  },
];

const PRESETS = () => [
  {
    label: bi("内网 OSV 代理镜像", "Internal OSV Mirror"),
    name: bi("内网 OSV 漏洞镜像", "Internal OSV Mirror"),
    kind: "osv_api",
    url: "https://osv-mirror.internal",
    note: bi("企业内网 OSV API 反向代理", "Internal OSV API reverse proxy"),
  },
  {
    label: bi("企业自建 CVE JSON 源", "Custom JSON Feed"),
    name: bi("企业安全团队自定义 CVE 源", "Enterprise Custom CVE Feed"),
    kind: "json_feed",
    url: "https://security.internal/feeds/osv-advisories.json",
    note: bi("内部安全团队维护的组件/系统漏洞通告", "Internal security advisory feed"),
  },
  {
    label: bi("内网离线包订阅 (.tar.gz)", "Internal Bundle URL"),
    name: bi("内网制品库离线漏洞包", "Internal Artifact CVE Bundle"),
    kind: "bundle_url",
    url: "https://artifacts.internal/security/mh-cve-db.tar.gz",
    note: bi("由 DMZ 同步机定时推送的 SHA256 校验包", "SHA256-verified bundle synced from DMZ"),
  },
];

function kindBadge(kind: string) {
  const hit = KIND_OPTIONS().find((x) => x.value === kind);
  return hit?.short || kind;
}

export function SecSourcesCard({
  sources,
  canScan,
  canManage,
  syncing,
  scanning,
  onSyncAll,
  onSyncOne,
  onScanOnly,
  onSourcesChange,
}: {
  sources: SecFeedSource[];
  canScan: boolean;
  canManage: boolean;
  syncing: boolean;
  scanning: boolean;
  onSyncAll: () => void;
  onSyncOne: (sourceId: string) => Promise<void>;
  onScanOnly: () => void;
  onSourcesChange: (next: SecFeedSource[]) => void;
}) {
  useLang();
  const [testingId, setTestingId] = useState("");
  const [syncingId, setSyncingId] = useState("");
  const [togglingId, setTogglingId] = useState("");

  // Add / edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SecFeedSource | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("json_feed");
  const [urlVal, setUrlVal] = useState("");
  const [ecosText, setEcosText] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [insecureTLS, setInsecureTLS] = useState(false);
  const [note, setNote] = useState("");
  const [enabled, setEnabled] = useState(true);

  const openAdd = () => {
    setEditing(null);
    setName("");
    setKind("json_feed");
    setUrlVal("");
    setEcosText("");
    setAuthHeader("");
    setAuthToken("");
    setClearToken(false);
    setInsecureTLS(false);
    setNote("");
    setEnabled(true);
    setModalOpen(true);
  };

  const openEdit = (s: SecFeedSource) => {
    setEditing(s);
    setName(s.name);
    setKind(s.kind);
    setUrlVal(s.url);
    setEcosText((s.ecosystems || []).join(", "));
    setAuthHeader(s.auth_header || "");
    setAuthToken("");
    setClearToken(false);
    setInsecureTLS(Boolean(s.insecure_tls));
    setNote(s.note || "");
    setEnabled(s.enabled);
    setModalOpen(true);
  };

  const saveSource = async () => {
    if (saving) return;
    if (!name.trim() || !urlVal.trim()) {
      Message.warning(bi("请填写漏洞源名称与 URL 地址", "Please enter source name and URL"));
      return;
    }
    const ecosystems = ecosText
      .split(/[,，\n]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    setSaving(true);
    try {
      if (editing) {
        const res = await api<{ sources: SecFeedSource[] }>(
          `/api/security/sources/${encodeURIComponent(editing.id)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              name: name.trim(),
              kind: editing.builtin ? undefined : kind,
              url: urlVal.trim(),
              enabled,
              has_ecosystems: true,
              ecosystems,
              auth_header: authHeader.trim(),
              auth_token: authToken.trim() || undefined,
              clear_token: clearToken,
              insecure_tls: insecureTLS,
              note: note.trim(),
            }),
          },
        );
        onSourcesChange(res.sources || []);
        Message.success(bi("已更新漏洞源配置", "CVE source updated"));
      } else {
        const res = await api<{ sources: SecFeedSource[] }>("/api/security/sources", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            kind,
            url: urlVal.trim(),
            enabled,
            ecosystems,
            auth_header: authHeader.trim(),
            auth_token: authToken.trim(),
            insecure_tls: insecureTLS,
            note: note.trim(),
          }),
        });
        onSourcesChange(res.sources || []);
        Message.success(bi("已新增 CVE 漏洞源", "CVE source added"));
      }
      setModalOpen(false);
    } catch (e) {
      err(e);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (s: SecFeedSource, next: boolean) => {
    if (togglingId === s.id) return;
    setTogglingId(s.id);
    try {
      const res = await api<{ sources: SecFeedSource[] }>(
        `/api/security/sources/${encodeURIComponent(s.id)}`,
        {
          method: "PUT",
          body: JSON.stringify({ enabled: next }),
        },
      );
      onSourcesChange(res.sources || []);
    } catch (e) {
      err(e);
    } finally {
      setTogglingId("");
    }
  };

  const testSource = async (s: SecFeedSource) => {
    if (testingId) return;
    setTestingId(s.id);
    try {
      const res = await api<TestResult>(
        `/api/security/sources/${encodeURIComponent(s.id)}/test`,
        { method: "POST" },
      );
      if (res.ok) {
        Message.success(`${s.name}：${res.message}`);
      } else {
        Message.error(`${s.name}：${res.message}`);
      }
    } catch (e) {
      err(e);
    } finally {
      setTestingId("");
    }
  };

  const syncSingle = async (s: SecFeedSource) => {
    if (syncing || syncingId) return;
    setSyncingId(s.id);
    try {
      await onSyncOne(s.id);
    } finally {
      setSyncingId("");
    }
  };

  const confirmDelete = (s: SecFeedSource) => {
    let deleting = false;
    Modal.confirm({
      title: bi(`删除漏洞源「${s.name}」？`, `Delete source "${s.name}"?`),
      content: bi(
        "删除后不会清除本地已同步的既有公告记录，但后续在线同步不再从此源拉取。",
        "Existing locally cached advisories remain intact; future syncs will stop fetching from this source.",
      ),
      okText: bi("删除", "Delete"),
      cancelText: bi("取消", "Cancel"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (deleting) return;
        deleting = true;
        try {
          const res = await api<{ sources: SecFeedSource[] }>(
            `/api/security/sources/${encodeURIComponent(s.id)}`,
            { method: "DELETE" },
          );
          onSourcesChange(res.sources || []);
          Message.success(bi("已删除漏洞源", "CVE source deleted"));
        } catch (e) {
          err(e);
        } finally {
          deleting = false;
        }
      },
    });
  };

  const enabledCount = sources.filter((x) => x.enabled).length;
  const kindMeta = KIND_OPTIONS().find((x) => x.value === kind) || KIND_OPTIONS()[0];

  return (
    <section className="sec-card">
      <div className="sec-card-h">
        <div>
          <h2 className="sec-src-title">
            {bi("CVE 漏洞数据源管理", "CVE Vulnerability Feed Sources")}
            <span className="sec-src-cnt num">
              {bi(`已启用 ${enabledCount}/${sources.length}`, `${enabledCount}/${sources.length} enabled`)}
            </span>
          </h2>
          <small className="faint">
            {bi(
              "内置 OSV.dev 官方源与 CISA KEV 目录；可按需新增企业自定义 JSON 源、内网 OSV 代理镜像或离线包订阅地址，在线同步自动聚合所有已启用源。",
              "Includes OSV.dev and CISA KEV presets; add internal mirrors, custom JSON feeds, or .tar.gz bundle URLs to aggregate during online sync.",
            )}
          </small>
        </div>
        <div className="sec-src-head-acts">
          {canManage && (
            <Button size="small" type="outline" icon={<IconPlus />} onClick={openAdd}>
              {bi("新增漏洞源", "Add Source")}
            </Button>
          )}
          {canScan && (
            <>
              <Button
                size="small"
                type="primary"
                icon={<IconSync />}
                loading={syncing && !syncingId}
                disabled={enabledCount === 0}
                onClick={onSyncAll}
              >
                {bi("同步已启用源", "Sync Enabled")}
              </Button>
              <Button
                size="small"
                icon={<IconRefresh />}
                loading={scanning}
                onClick={onScanOnly}
              >
                {bi("仅离线扫描", "Scan Offline")}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="sec-src-table">
        <div className="sec-src-head">
          <span>{bi("数据源名称 / 类型", "Source & Type")}</span>
          <span>{bi("订阅地址与配置", "Endpoint & Options")}</span>
          <span>{bi("最近同步状态", "Last Sync")}</span>
          <span style={{ textAlign: "center" }}>{bi("启用", "Enabled")}</span>
          <span style={{ textAlign: "right" }}>{bi("操作", "Actions")}</span>
        </div>
        {sources.map((s) => (
          <div key={s.id} className={`sec-src-row ${s.enabled ? "" : "is-off"}`}>
            <div className="sec-src-name-col">
              <div className="sec-src-name-line">
                <b>{s.name}</b>
                {s.builtin && (
                  <span className="sec-src-builtin">{bi("内置", "Built-in")}</span>
                )}
              </div>
              <div className="sec-src-tags">
                <span className={`sec-src-kind k-${s.kind}`}>{kindBadge(s.kind)}</span>
                {s.ecosystems && s.ecosystems.length > 0 && (
                  <span className="faint small">
                    {s.ecosystems.slice(0, 2).join(" · ")}
                    {s.ecosystems.length > 2 ? ` +${s.ecosystems.length - 2}` : ""}
                  </span>
                )}
              </div>
            </div>

            <div className="sec-src-url-col">
              <code className="sec-src-url mono" title={s.url}>
                {s.url}
              </code>
              <div className="sec-src-meta-line">
                {s.has_auth_token && (
                  <span className="sec-mini-tag">
                    {bi("已配置鉴权", "Auth set")}
                  </span>
                )}
                {s.insecure_tls && (
                  <span className="sec-mini-tag">
                    {bi("跳过 TLS 校验", "Insecure TLS")}
                  </span>
                )}
                {s.note && (
                  <span className="faint small sec-src-note" title={s.note}>
                    {s.note}
                  </span>
                )}
              </div>
            </div>

            <div className="sec-src-status-col">
              {s.last_sync_error ? (
                <Tooltip content={s.last_sync_error}>
                  <span className="sec-src-st err">
                    <IconExclamationCircleFill />
                    {bi("上次同步失败", "Sync failed")}
                  </span>
                </Tooltip>
              ) : s.last_sync_at ? (
                <>
                  <span className="sec-src-st ok num">
                    <IconCheckCircleFill />
                    {bi(`${s.last_sync_count || 0} 条`, `${s.last_sync_count || 0} items`)}
                  </span>
                  <span className="faint small num" title={fullTime(s.last_sync_at)}>
                    {ago(s.last_sync_at)}
                    {s.last_sync_ms ? ` · ${s.last_sync_ms}ms` : ""}
                  </span>
                </>
              ) : (
                <span className="faint small">{bi("尚未同步", "Not synced yet")}</span>
              )}
            </div>

            <div className="sec-src-switch-col">
              <Switch
                size="small"
                checked={s.enabled}
                loading={togglingId === s.id}
                disabled={!canManage}
                onChange={(v) => void toggleEnabled(s, v)}
              />
            </div>

            <div className="sec-src-acts-col">
              {canScan && (
                <Button
                  size="mini"
                  type="text"
                  loading={testingId === s.id}
                  onClick={() => void testSource(s)}
                >
                  {bi("测试", "Test")}
                </Button>
              )}
              {canScan && (
                <Button
                  size="mini"
                  type="text"
                  loading={syncingId === s.id}
                  disabled={syncing && syncingId !== s.id}
                  onClick={() => void syncSingle(s)}
                >
                  {bi("同步", "Sync")}
                </Button>
              )}
              {canManage && (
                <Button
                  size="mini"
                  type="text"
                  icon={<IconEdit />}
                  onClick={() => openEdit(s)}
                >
                  {bi("编辑", "Edit")}
                </Button>
              )}
              {canManage && !s.builtin && (
                <Button
                  size="mini"
                  type="text"
                  status="danger"
                  icon={<IconDelete />}
                  onClick={() => confirmDelete(s)}
                  aria-label={bi("删除", "Delete")}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <Modal
        visible={modalOpen}
        title={
          editing
            ? bi(`编辑漏洞源：${editing.name}`, `Edit CVE Source: ${editing.name}`)
            : bi("新增 CVE 漏洞数据源", "Add CVE Vulnerability Source")
        }
        onCancel={() => !saving && setModalOpen(false)}
        onOk={() => void saveSource()}
        confirmLoading={saving}
        okText={bi("保存配置", "Save Source")}
        cancelText={bi("取消", "Cancel")}
        style={{ width: 580, maxWidth: "94vw" }}
      >
        <div className="sec-src-form">
          {!editing && (
            <div className="sec-src-presets">
              <span className="faint small">{bi("快速模板：", "Quick presets:")}</span>
              <div className="sec-src-preset-list">
                {PRESETS().map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className="sec-src-preset-chip"
                    onClick={() => {
                      setName(p.name);
                      setKind(p.kind);
                      setUrlVal(p.url);
                      setNote(p.note);
                    }}
                  >
                    + {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="sec-src-form-grid">
            <div className="sec-field">
              <span>{bi("数据源名称", "Source Name")} *</span>
              <Input
                value={name}
                onChange={setName}
                maxLength={80}
                placeholder={bi("例如：企业内网 OSV 漏洞镜像", "e.g. Internal OSV Mirror")}
              />
            </div>
            <div className="sec-field">
              <span>{bi("源协议类型", "Feed Protocol")} *</span>
              <Select
                value={kind}
                disabled={Boolean(editing?.builtin)}
                onChange={(v) => setKind(String(v))}
                options={KIND_OPTIONS().map((o) => ({
                  value: o.value,
                  label: o.label,
                }))}
              />
            </div>
          </div>

          <div className="sec-src-kind-hint">{kindMeta.hint}</div>

          <div className="sec-field">
            <span>{bi("源地址 URL", "Endpoint URL")} *</span>
            <Input
              value={urlVal}
              onChange={setUrlVal}
              placeholder={kindMeta.placeholder}
            />
          </div>

          {kind !== "cisa_kev" && (
            <div className="sec-field">
              <span>
                {bi("生态筛选（可选，留空同步全部资产生态）", "Ecosystem Filter (optional)")}
              </span>
              <Input
                value={ecosText}
                onChange={setEcosText}
                placeholder="Ubuntu:24.04:LTS, Rocky Linux:9, PyPI"
              />
            </div>
          )}

          <div className="sec-src-form-grid">
            <div className="sec-field">
              <span>{bi("鉴权请求头（可选）", "Auth Header (optional)")}</span>
              <Input
                value={authHeader}
                onChange={setAuthHeader}
                placeholder="Authorization / X-API-Key"
              />
            </div>
            <div className="sec-field">
              <span>
                {editing?.has_auth_token
                  ? bi("鉴权密钥（留空保留原密钥）", "Auth Token (blank to keep existing)")
                  : bi("鉴权密钥 / Token（可选）", "Auth Token (optional)")}
              </span>
              <Input.Password
                value={authToken}
                onChange={(v) => {
                  setAuthToken(v);
                  if (v) setClearToken(false);
                }}
                placeholder={
                  editing?.has_auth_token
                    ? bi("已加密保存，输入新值可覆盖", "Saved; enter new value to replace")
                    : "Bearer xxx..."
                }
              />
            </div>
          </div>

          <div className="sec-src-switches">
            <label className="sec-scope-chk">
              <Switch size="small" checked={enabled} onChange={setEnabled} />
              <span>{bi("启用该漏洞源", "Enable source")}</span>
            </label>
            <label className="sec-scope-chk">
              <Switch size="small" checked={insecureTLS} onChange={setInsecureTLS} />
              <span>{bi("允许内网自签名 HTTPS 证书", "Allow self-signed HTTPS")}</span>
            </label>
            {editing?.has_auth_token && (
              <label className="sec-scope-chk">
                <Switch size="small" checked={clearToken} onChange={setClearToken} />
                <span>{bi("清除已保存的鉴权密钥", "Clear saved auth token")}</span>
              </label>
            )}
          </div>

          <div className="sec-field">
            <span>{bi("备注说明（可选）", "Notes (optional)")}</span>
            <Input
              value={note}
              onChange={setNote}
              maxLength={240}
              placeholder={bi("记录该源的维护团队或同步周期说明", "Owner team or sync schedule notes")}
            />
          </div>
        </div>
      </Modal>
    </section>
  );
}

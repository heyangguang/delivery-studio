import React, { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Message,
  Modal,
  Select,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconCheckCircle,
  IconClose,
  IconCopy,
  IconDownload,
  IconLoading,
  IconPlus,
  IconSearch,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import {
  api,
  copy,
  csrfToken,
  err,
  platformShort,
} from "../../shared/shared";
import { bi, useLang, withLang } from "../../app/i18n";
import {
  AgentClusterCatalogItem,
  AutomationBootstrapInfo,
  ClusterAutomationHost,
  UnifiedAgentView,
} from "./execution-types";

type UnifiedEnrollmentResp = {
  agent: UnifiedAgentView;
  token: string;
  bootstrap: AutomationBootstrapInfo;
};

type UnifiedAgentsListResp = {
  agents: UnifiedAgentView[];
  manageable_clusters?: string[];
  cluster_catalog?: AgentClusterCatalogItem[];
  bootstrap: AutomationBootstrapInfo;
};

const isLoopbackURL = (raw: string): boolean => {
  try {
    const h = new URL(raw.trim()).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
};

export const agentBundleSlug = (name: string, ip: string): string => {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const base = cleaned || ip.replace(/\./g, "-") || "agent";
  return base.slice(0, 36).replace(/[-.]+$/, "") || "agent";
};

function matchCatalogCluster(c: AgentClusterCatalogItem, kw: string): boolean {
  if (!kw) return true;
  if (
    c.id.toLowerCase().includes(kw) ||
    c.app_name.toLowerCase().includes(kw) ||
    (c.version || "").toLowerCase().includes(kw) ||
    (c.owner || "").toLowerCase().includes(kw) ||
    (c.platform || "").toLowerCase().includes(kw) ||
    platformShort(c.platform).toLowerCase().includes(kw)
  ) {
    return true;
  }
  if (c.host_ips?.some((ip) => ip.toLowerCase().includes(kw))) return true;
  if (c.host_names?.some((h) => h.toLowerCase().includes(kw))) return true;
  return false;
}

export function EnrollAgentModal({
  visible,
  onClose,
  onEnrolled,
  defaultClusterId,
  defaultHostName,
  defaultHostIP,
  clusterHosts,
  initialCatalog,
  initialBootstrap,
}: {
  visible: boolean;
  onClose: () => void;
  onEnrolled?: (agent: UnifiedAgentView) => void;
  defaultClusterId?: string;
  defaultHostName?: string;
  defaultHostIP?: string;
  clusterHosts?: ClusterAutomationHost[];
  initialCatalog?: AgentClusterCatalogItem[];
  initialBootstrap?: AutomationBootstrapInfo | null;
}) {
  useLang();
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [selectedClusters, setSelectedClusters] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<AgentClusterCatalogItem[]>(
    initialCatalog || [],
  );
  const [bootInfo, setBootInfo] = useState<AutomationBootstrapInfo | null>(
    initialBootstrap || null,
  );
  const [submitBusy, setSubmitBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<UnifiedEnrollmentResp | null>(null);
  const [liveOnline, setLiveOnline] = useState(false);
  const [hubURL, setHubURL] = useState("");
  const [includeCA, setIncludeCA] = useState(true);
  const [bundleBusy, setBundleBusy] = useState(false);

  // Transfer box states
  const [leftKw, setLeftKw] = useState("");
  const [rightKw, setRightKw] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | "same_ip">("all");
  const [appFilter, setAppFilter] = useState("all");
  const [leftChecked, setLeftChecked] = useState<Set<string>>(() => new Set());
  const [rightChecked, setRightChecked] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!visible) return;
    setEnrollment(null);
    setLiveOnline(false);
    setName(defaultHostName || clusterHosts?.[0]?.name || "");
    setIp(defaultHostIP || clusterHosts?.[0]?.ip || "");
    setSelectedClusters(defaultClusterId ? [defaultClusterId] : []);
    setLeftKw("");
    setRightKw("");
    setScopeFilter("all");
    setAppFilter("all");
    setLeftChecked(new Set());
    setRightChecked(new Set());

    if (initialCatalog && initialCatalog.length > 0) {
      setCatalog(initialCatalog);
    }
    if (initialBootstrap) {
      setBootInfo(initialBootstrap);
      const u =
        initialBootstrap.suggested_urls?.[0] ||
        initialBootstrap.origin ||
        window.location.origin;
      setHubURL(u);
      setIncludeCA(Boolean(initialBootstrap.ca_available));
    }

    // Always refresh catalog + bootstrap silently so standalone callers have full IP metadata
    void api<UnifiedAgentsListResp>("/api/executions/unified-agents")
      .then((res) => {
        if (res.cluster_catalog) setCatalog(res.cluster_catalog);
        if (res.bootstrap) {
          setBootInfo(res.bootstrap);
          const u =
            res.bootstrap.suggested_urls?.[0] ||
            res.bootstrap.origin ||
            window.location.origin;
          setHubURL((prev) => prev || u);
          setIncludeCA(Boolean(res.bootstrap.ca_available));
        }
      })
      .catch(() => undefined);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll heartbeat while on Step 2
  useEffect(() => {
    if (!visible || !enrollment) return;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      void api<UnifiedAgentsListResp>("/api/executions/unified-agents")
        .then((res) => {
          const hit = (res.agents || []).find((a) => a.id === enrollment.agent.id);
          if (hit?.online) {
            setLiveOnline(true);
            onEnrolled?.(hit);
          }
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(poll, 2500);
    return () => window.clearInterval(timer);
  }, [visible, enrollment]); // eslint-disable-line react-hooks/exhaustive-deps

  const operableCatalog = useMemo(
    () => catalog.filter((c) => c.can_op),
    [catalog],
  );
  const catalogById = useMemo(
    () => new Map(catalog.map((c) => [c.id, c])),
    [catalog],
  );
  const selectedSet = useMemo(() => new Set(selectedClusters), [selectedClusters]);
  const trimmedIP = ip.trim();

  const allUnbound = useMemo(
    () => operableCatalog.filter((c) => !selectedSet.has(c.id)),
    [operableCatalog, selectedSet],
  );
  const sameIPUnbound = useMemo(
    () =>
      trimmedIP
        ? allUnbound.filter((c) => c.host_ips?.some((x) => x.trim() === trimmedIP))
        : [],
    [allUnbound, trimmedIP],
  );
  const totalSameIPOperable = useMemo(
    () =>
      trimmedIP
        ? operableCatalog.filter((c) =>
            c.host_ips?.some((x) => x.trim() === trimmedIP),
          ).length
        : 0,
    [operableCatalog, trimmedIP],
  );

  const appOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of allUnbound) {
      counts.set(c.app_name, (counts.get(c.app_name) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [allUnbound]);

  const lq = leftKw.trim().toLowerCase();
  const filteredLeft = useMemo(
    () =>
      allUnbound.filter((c) => {
        if (
          scopeFilter === "same_ip" &&
          (!trimmedIP || !c.host_ips?.some((x) => x.trim() === trimmedIP))
        ) {
          return false;
        }
        if (appFilter !== "all" && c.app_name !== appFilter) return false;
        return matchCatalogCluster(c, lq);
      }),
    [allUnbound, scopeFilter, trimmedIP, appFilter, lq],
  );

  const rq = rightKw.trim().toLowerCase();
  const filteredRight = useMemo(
    () =>
      selectedClusters.filter((cid) => {
        if (!rq) return true;
        const m = catalogById.get(cid);
        return m ? matchCatalogCluster(m, rq) : cid.toLowerCase().includes(rq);
      }),
    [selectedClusters, catalogById, rq],
  );

  const validLeftIds = filteredLeft
    .filter((c) => leftChecked.has(c.id))
    .map((c) => c.id);
  const validRightIds = filteredRight.filter((cid) => rightChecked.has(cid));

  const addClusters = (cids: string[]) => {
    if (!cids.length) return;
    setSelectedClusters((prev) => Array.from(new Set([...prev, ...cids])));
    setLeftChecked(new Set());
  };

  const removeClusters = (cids: string[]) => {
    if (!cids.length) return;
    const rm = new Set(cids);
    setSelectedClusters((prev) => prev.filter((x) => !rm.has(x)));
    setRightChecked(new Set());
  };

  const handleSubmit = async () => {
    if (submitBusy) return;
    const cleanName = name.trim();
    const cleanIP = ip.trim();
    if (!cleanName || !cleanIP) {
      Message.warning(
        bi("请填写 Agent 名称和机器 IP 地址", "Enter Agent name and IP address"),
      );
      return;
    }
    setSubmitBusy(true);
    try {
      const res = await api<UnifiedEnrollmentResp>(
        "/api/executions/unified-agents",
        {
          method: "POST",
          body: JSON.stringify({
            name: cleanName,
            ip: cleanIP,
            clusters: selectedClusters,
          }),
        },
      );
      setEnrollment(res);
      const defURL =
        res.bootstrap?.suggested_urls?.[0] ||
        res.bootstrap?.origin ||
        bootInfo?.suggested_urls?.[0] ||
        window.location.origin;
      setHubURL(defURL);
      setIncludeCA(Boolean(res.bootstrap?.ca_available ?? bootInfo?.ca_available));
      onEnrolled?.(res.agent);
    } catch (e) {
      err(e);
    } finally {
      setSubmitBusy(false);
    }
  };

  const handleDownloadBundle = async () => {
    if (!enrollment || bundleBusy) return;
    setBundleBusy(true);
    try {
      const resp = await fetch(withLang("/api/executions/unified-agents/bundle"), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken(),
        },
        body: JSON.stringify({
          agent_id: enrollment.agent.id,
          token: enrollment.token,
          url: hubURL.trim(),
          include_ca: includeCA,
        }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const slug = agentBundleSlug(enrollment.agent.name, enrollment.agent.ip);
      const fname = `ds-agent-${slug}.tar.gz`;
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(u);
      Message.success(bi(`已下载安装包 ${fname}`, `Downloaded ${fname}`));
    } catch (e) {
      err(e);
    } finally {
      setBundleBusy(false);
    }
  };

  const bundleSlug = enrollment
    ? `ds-agent-${agentBundleSlug(enrollment.agent.name, enrollment.agent.ip)}`
    : "ds-agent";
  const installCmd = `tar -xzf ${bundleSlug}.tar.gz && sudo bash ${bundleSlug}/install.sh`;

  return (
    <Modal
      visible={visible}
      onCancel={onClose}
      footer={null}
      style={{ width: 820, maxWidth: "96vw" }}
      title={
        <div className="eam-head">
          <span className="eam-head-title">
            <span className="eam-head-ic">
              <IconThunderbolt />
            </span>
            <span>{bi("接入执行 Agent", "Enroll Execution Agent")}</span>
          </span>
          <div className="eam-steps" aria-label={bi("接入步骤", "Steps")}>
            <span className={`eam-step ${!enrollment ? "is-active" : "is-done"}`}>
              <i>{enrollment ? <IconCheck /> : "1"}</i>
              <span>{bi("登记机器与关联集群", "Host & Clusters")}</span>
            </span>
            <span className="eam-step-line" />
            <span className={`eam-step ${enrollment ? "is-active" : ""}`}>
              <i>2</i>
              <span>{bi("下载安装并连接", "Install & Connect")}</span>
            </span>
          </div>
        </div>
      }
    >
      {!enrollment ? (
        <div className="eam-body">
          {clusterHosts && clusterHosts.length > 0 && (
            <div className="eam-host-picks">
              <span className="eam-sec-lbl">
                {bi(
                  "快捷填入本集群机器（也可手动输入跳板机 / 管理机 IP）：",
                  "Quick-fill a cluster node (or enter a jumpbox IP manually):",
                )}
              </span>
              <div className="eam-host-chips">
                {clusterHosts.map((h) => {
                  const active = ip.trim() === h.ip.trim();
                  return (
                    <button
                      key={`${h.name}-${h.ip}`}
                      type="button"
                      className={`eam-host-chip ${active ? "on" : ""}`}
                      onClick={() => {
                        setName(h.name || h.ip);
                        setIp(h.ip);
                      }}
                    >
                      <b>{h.name}</b>
                      <code className="mono">{h.ip}</code>
                      {h.role && <em>{h.role}</em>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="eam-id-card">
            <label className="ua-field">
              <span>{bi("Agent 名称", "Agent Name")}</span>
              <Input
                value={name}
                onChange={setName}
                placeholder={bi(
                  "例如 prod-jumpbox-01 或 db-node-01",
                  "e.g. prod-jumpbox-01 or db-node-01",
                )}
              />
            </label>
            <label className="ua-field">
              <span>{bi("部署机器 IP 地址", "Machine IP Address")}</span>
              <Input
                value={ip}
                onChange={setIp}
                placeholder={bi(
                  "输入部署该 Agent 的机器实际网卡 IP",
                  "IP address of the host running this Agent",
                )}
              />
            </label>
            {totalSameIPOperable > 0 && (
              <div className="eam-ip-match-bar">
                <IconCheckCircle />
                <span>
                  {bi(
                    `检测到 ${totalSameIPOperable} 个可运维集群包含节点 IP ${trimmedIP}，关联后自动走本机免密直连`,
                    `${totalSameIPOperable} cluster(s) contain IP ${trimmedIP} and will use passwordless local execution`,
                  )}
                </span>
                {sameIPUnbound.length > 0 && (
                  <button
                    type="button"
                    className="iam-text-act"
                    onClick={() => addClusters(sameIPUnbound.map((c) => c.id))}
                  >
                    {bi(
                      `一键加入同机集群 (${sameIPUnbound.length})`,
                      `Add Same-IP (${sameIPUnbound.length})`,
                    )}
                  </button>
                )}
              </div>
            )}
          </div>

          {operableCatalog.length > 0 && (
            <div className="eam-transfer-sec">
              <div className="eam-sec-top">
                <span className="eam-sec-lbl">
                  {bi("关联集群范围（可选，随时可调整）", "Associated Clusters (Optional)")}
                </span>
                <span className="faint small">
                  {bi(
                    "支持按集群名、节点 IP、中间件、系统或创建者搜索",
                    "Search by cluster, node IP, app, OS, or owner",
                  )}
                </span>
              </div>

              <div className="ds-transfer">
                <div className="ds-tf-pane">
                  <div className="ds-tf-head">
                    <label className="ds-tf-head-chk">
                      <Checkbox
                        checked={
                          filteredLeft.length > 0 &&
                          validLeftIds.length === filteredLeft.length
                        }
                        indeterminate={
                          validLeftIds.length > 0 &&
                          validLeftIds.length < filteredLeft.length
                        }
                        disabled={filteredLeft.length === 0}
                        onChange={(chk) => {
                          const next = new Set(leftChecked);
                          for (const c of filteredLeft) {
                            if (chk) next.add(c.id);
                            else next.delete(c.id);
                          }
                          setLeftChecked(next);
                        }}
                      />
                      <b>{bi("可关联集群", "Available")}</b>
                    </label>
                    <span className="ds-tf-cnt num">
                      {validLeftIds.length > 0
                        ? `${validLeftIds.length} / ${filteredLeft.length}`
                        : filteredLeft.length}
                    </span>
                  </div>

                  {(sameIPUnbound.length > 0 || appOptions.length > 1) && (
                    <div className="ds-tf-facets">
                      <div className="ds-tf-scope-pills">
                        <button
                          type="button"
                          className={`ds-tf-pill ${scopeFilter === "all" ? "on" : ""}`}
                          onClick={() => setScopeFilter("all")}
                        >
                          {bi("全部", "All")} ({allUnbound.length})
                        </button>
                        {sameIPUnbound.length > 0 && (
                          <button
                            type="button"
                            className={`ds-tf-pill is-match ${scopeFilter === "same_ip" ? "on" : ""}`}
                            onClick={() => setScopeFilter("same_ip")}
                          >
                            {bi("同机 IP", "Same IP")} ({sameIPUnbound.length})
                          </button>
                        )}
                      </div>
                      {appOptions.length > 1 && (
                        <Select
                          size="mini"
                          style={{ width: 132 }}
                          value={appFilter}
                          onChange={setAppFilter}
                          getPopupContainer={() => document.body}
                          triggerProps={{ autoFitPosition: true }}
                          options={[
                            { value: "all", label: bi("全部组件", "All Apps") },
                            ...appOptions.map(([app, n]) => ({
                              value: app,
                              label: `${app} (${n})`,
                            })),
                          ]}
                        />
                      )}
                    </div>
                  )}

                  <div className="ds-tf-search">
                    <Input
                      size="small"
                      prefix={<IconSearch />}
                      allowClear
                      value={leftKw}
                      onChange={setLeftKw}
                      placeholder={bi(
                        "搜索集群名、节点 IP、中间件或创建者…",
                        "Search cluster, node IP, app, or owner…",
                      )}
                    />
                  </div>

                  <div className="ds-tf-list" style={{ height: 210 }}>
                    {filteredLeft.length === 0 ? (
                      <div className="ds-tf-empty">
                        {allUnbound.length === 0
                          ? bi("全部可运维集群已选入右侧", "All clusters selected")
                          : bi("没有匹配的集群", "No matching clusters")}
                      </div>
                    ) : (
                      filteredLeft.map((c) => {
                        const checked = leftChecked.has(c.id);
                        const ips = c.host_ips || [];
                        const sameIP = Boolean(
                          trimmedIP && ips.some((x) => x.trim() === trimmedIP),
                        );
                        return (
                          <div
                            key={c.id}
                            className={`ds-tf-row ${checked ? "is-checked" : ""}`}
                            onClick={() => {
                              const next = new Set(leftChecked);
                              if (checked) next.delete(c.id);
                              else next.add(c.id);
                              setLeftChecked(next);
                            }}
                          >
                            <Checkbox checked={checked} />
                            <div className="ds-tf-item-col">
                              <div className="ds-tf-item-main">
                                <span className="ds-tf-id mono" title={c.id}>
                                  {c.id}
                                </span>
                                <span className="iam-app-pill">{c.app_name}</span>
                                {sameIP && (
                                  <span className="ua-path-badge is-local">
                                    {bi("同机 IP", "Same IP")}
                                  </span>
                                )}
                              </div>
                              <div className="ds-tf-item-sub">
                                {ips.length > 0 && (
                                  <span>
                                    IP: {ips.slice(0, 2).join(", ")}
                                    {ips.length > 2 ? ` +${ips.length - 2}` : ""}
                                  </span>
                                )}
                                {c.platform && (
                                  <span>· {platformShort(c.platform)}</span>
                                )}
                                {c.owner && <span>· {c.owner}</span>}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="ds-tf-quick-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                addClusters([c.id]);
                              }}
                            >
                              <IconPlus />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="ds-tf-mid">
                  <Button
                    size="small"
                    type="primary"
                    disabled={validLeftIds.length === 0}
                    onClick={() => addClusters(validLeftIds)}
                  >
                    <span>
                      {validLeftIds.length > 0
                        ? bi(`关联 (${validLeftIds.length})`, `Add (${validLeftIds.length})`)
                        : bi("关联", "Add")}
                    </span>
                    <IconArrowRight />
                  </Button>
                  <Button
                    size="small"
                    type="secondary"
                    disabled={validRightIds.length === 0}
                    onClick={() => removeClusters(validRightIds)}
                  >
                    <IconArrowLeft />
                    <span>
                      {validRightIds.length > 0
                        ? bi(`移除 (${validRightIds.length})`, `Remove (${validRightIds.length})`)
                        : bi("移除", "Remove")}
                    </span>
                  </Button>
                </div>

                <div className="ds-tf-pane is-target">
                  <div className="ds-tf-head">
                    <label className="ds-tf-head-chk">
                      <Checkbox
                        checked={
                          filteredRight.length > 0 &&
                          validRightIds.length === filteredRight.length
                        }
                        indeterminate={
                          validRightIds.length > 0 &&
                          validRightIds.length < filteredRight.length
                        }
                        disabled={filteredRight.length === 0}
                        onChange={(chk) => {
                          const next = new Set(rightChecked);
                          for (const cid of filteredRight) {
                            if (chk) next.add(cid);
                            else next.delete(cid);
                          }
                          setRightChecked(next);
                        }}
                      />
                      <b>{bi("初始关联集群", "Selected")}</b>
                    </label>
                    <span className="ds-tf-cnt is-brand num">
                      {selectedClusters.length}
                    </span>
                  </div>

                  <div className="ds-tf-search">
                    <Input
                      size="small"
                      prefix={<IconSearch />}
                      allowClear
                      value={rightKw}
                      onChange={setRightKw}
                      placeholder={bi("筛选已选集群…", "Filter selected…")}
                    />
                  </div>

                  <div className="ds-tf-list" style={{ height: 249 }}>
                    {filteredRight.length === 0 ? (
                      <div className="ds-tf-empty">
                        {selectedClusters.length === 0
                          ? bi(
                              "未选集群时仅接入机器，后续也可随时关联",
                              "Optional — you can also associate clusters anytime later",
                            )
                          : bi("无匹配的已选集群", "No matching clusters")}
                      </div>
                    ) : (
                      filteredRight.map((cid) => {
                        const cMeta = catalogById.get(cid);
                        const checked = rightChecked.has(cid);
                        const ips = cMeta?.host_ips || [];
                        return (
                          <div
                            key={cid}
                            className={`ds-tf-row ${checked ? "is-checked" : ""}`}
                            onClick={() => {
                              const next = new Set(rightChecked);
                              if (checked) next.delete(cid);
                              else next.add(cid);
                              setRightChecked(next);
                            }}
                          >
                            <Checkbox checked={checked} />
                            <div className="ds-tf-item-col">
                              <div className="ds-tf-item-main">
                                <span className="ds-tf-id mono">{cid}</span>
                                {cMeta && (
                                  <span className="iam-app-pill">
                                    {cMeta.app_name}
                                  </span>
                                )}
                              </div>
                              {ips.length > 0 && (
                                <div className="ds-tf-item-sub">
                                  IP: {ips.slice(0, 2).join(", ")}
                                  {ips.length > 2 ? ` +${ips.length - 2}` : ""}
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              className="ds-tf-quick-btn is-rm"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeClusters([cid]);
                              }}
                            >
                              <IconClose />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="eam-foot">
            <Button onClick={onClose}>{bi("取消", "Cancel")}</Button>
            <Button
              type="primary"
              loading={submitBusy}
              onClick={() => void handleSubmit()}
            >
              {bi("下一步：生成安装包与命令", "Next: Generate Installer")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="eam-body">
          <div className={`ua-live-banner ${liveOnline ? "is-ok" : ""}`}>
            {liveOnline ? <IconCheckCircle /> : <IconLoading />}
            <div>
              <b>
                {liveOnline
                  ? bi(
                      "Agent 已成功连接上线并开始同步主机探针！",
                      "Agent Connected & Syncing Host Telemetry!",
                    )
                  : bi(
                      "等待目标机器执行安装脚本并上报首次心跳（自动刷新检测中）…",
                      "Waiting for machine installation & first heartbeat…",
                    )}
              </b>
              <small className="mono">
                {enrollment.agent.name} · {enrollment.agent.ip}
                {enrollment.agent.clusters.length > 0
                  ? bi(
                      ` · 已关联 ${enrollment.agent.clusters.length} 个集群`,
                      ` · ${enrollment.agent.clusters.length} cluster(s) associated`,
                    )
                  : ""}
              </small>
            </div>
          </div>

          <div className="eam-step2-grid">
            <label className="ua-field">
              <span>{bi("1. 确认 Agent 回连平台的 HTTPS 地址", "1. Platform Callback HTTPS URL")}</span>
              <Input
                value={hubURL}
                onChange={setHubURL}
                placeholder="https://192.168.1.10:8443"
              />
              {isLoopbackURL(hubURL) && (
                <small className="warn">
                  {bi(
                    "127.0.0.1 仅限本机测试；远程机器请填写平台所在服务器可达 IP 地址。",
                    "127.0.0.1 only works locally; use a reachable LAN IP for remote hosts.",
                  )}
                </small>
              )}
            </label>

            <div className="eam-dl-card">
              <div>
                <b>{bi("2. 下载自包含离线安装包", "2. Download Self-Contained Bundle")}</b>
                <small>
                  {bi(
                    "内含 Linux 二进制、0600 专属凭证与 systemd 守护服务",
                    "Includes binary, 0600 credentials & systemd unit",
                  )}
                </small>
              </div>
              <Button
                type="primary"
                icon={<IconDownload />}
                loading={bundleBusy}
                onClick={() => void handleDownloadBundle()}
              >
                {bi("下载 .tar.gz", "Download .tar.gz")}
              </Button>
            </div>
          </div>

          <div className="eam-cmd-box">
            <div className="eam-cmd-head">
              <span>
                {bi(
                  "3. 上传至机器任意目录后执行一键安装命令",
                  "3. Upload to host and run one-line installer",
                )}
              </span>
              <Button
                size="mini"
                type="secondary"
                icon={<IconCopy />}
                onClick={() =>
                  copy(installCmd, bi("已复制安装命令", "Copied command"))
                }
              >
                {bi("复制命令", "Copy")}
              </Button>
            </div>
            <pre className="eam-cmd-pre mono">{installCmd}</pre>
          </div>

          <div className="eam-foot">
            <Button type="primary" onClick={onClose}>
              {liveOnline
                ? bi("完成", "Done")
                : bi("完成（后台继续等待上线）", "Close & Wait in Background")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

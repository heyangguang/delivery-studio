import React, { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Message,
  Modal,
  Radio,
  Select,
  Steps,
} from "@arco-design/web-react";
import {
  IconCheck,
  IconCheckCircle,
  IconCopy,
  IconDownload,
  IconLoading,
  IconThunderbolt,
} from "@arco-design/web-react/icon";
import {
  api,
  authToken,
  copy,
  csrfToken,
  err,
  platformShort,
} from "../../shared/shared";
import { ProTransfer, ProTransferItem } from "../../design/transfer";
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

function buildClusterTransferItem(
  c: AgentClusterCatalogItem,
  trimmedAgentIP: string,
): ProTransferItem {
  const ips = c.host_ips || [];
  const sameIP = Boolean(
    trimmedAgentIP && ips.some((x) => x.trim() === trimmedAgentIP),
  );
  const plat = c.platform ? platformShort(c.platform) : "";
  const subParts: string[] = [];
  if (ips.length > 0) {
    subParts.push(
      `IP: ${ips.slice(0, 2).join(", ")}${ips.length > 2 ? ` +${ips.length - 2}` : ""}`,
    );
  }
  if (plat) subParts.push(plat);
  if (c.owner) subParts.push(c.owner);

  return {
    key: c.id,
    title: c.id,
    monoTitle: true,
    badge: [c.app_name, c.version].filter(Boolean).join(" "),
    tag: sameIP ? { text: bi("同机 IP", "Same IP"), tone: "ok" } : undefined,
    subtitle: subParts.join(" · "),
    searchText: [
      c.id,
      c.app_name,
      c.version || "",
      c.owner || "",
      c.platform || "",
      plat,
      ...(c.host_ips || []),
      ...(c.host_names || []),
    ].join(" "),
  };
}

export function EnrollAgentModal({
  visible,
  onClose,
  onEnrolled,
  defaultClusterId,
  clusterMode = "cluster_hosts",
  defaultHostName,
  defaultHostIP,
  clusterHosts,
  existingAgents,
  initialCatalog,
  initialBootstrap,
}: {
  visible: boolean;
  onClose: () => void;
  onEnrolled?: (agent: UnifiedAgentView) => void;
  /** When set, scopes enrollment strictly to THIS cluster (zero other-cluster clutter!) */
  defaultClusterId?: string;
  /** Used when defaultClusterId is set: "cluster_hosts" lists this cluster's machines; "jumpbox" enrolls 1 jumpbox */
  clusterMode?: "cluster_hosts" | "jumpbox";
  defaultHostName?: string;
  defaultHostIP?: string;
  clusterHosts?: ClusterAutomationHost[];
  existingAgents?: UnifiedAgentView[];
  initialCatalog?: AgentClusterCatalogItem[];
  initialBootstrap?: AutomationBootstrapInfo | null;
}) {
  useLang();
  const isClusterScoped = Boolean(defaultClusterId);
  const effectiveClusterMode: "cluster_hosts" | "jumpbox" =
    isClusterScoped && (clusterHosts?.length || 0) > 0
      ? clusterMode
      : "jumpbox";

  // Single-host / global fields
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [selectedClusters, setSelectedClusters] = useState<string[]>([]);

  // Cluster-hosts batch checklist (`cluster_hosts` mode)
  const [checkedHostIPs, setCheckedHostIPs] = useState<Set<string>>(
    () => new Set(),
  );
  const [allPlatformAgents, setAllPlatformAgents] = useState<UnifiedAgentView[]>(
    existingAgents || [],
  );

  // Global catalog (only used when !isClusterScoped)
  const [catalog, setCatalog] = useState<AgentClusterCatalogItem[]>(
    initialCatalog || [],
  );
  const [bootInfo, setBootInfo] = useState<AutomationBootstrapInfo | null>(
    initialBootstrap || null,
  );
  const [scopeFilter, setScopeFilter] = useState<"all" | "same_ip">("all");
  const [appFilter, setAppFilter] = useState("all");

  // Submission & Step 2 results (supports 1 or multiple enrolled cluster nodes!)
  const [submitBusy, setSubmitBusy] = useState(false);
  const [enrollments, setEnrollments] = useState<UnifiedEnrollmentResp[]>([]);
  const [activeTabIdx, setActiveTabIdx] = useState(0);
  const [onlineMap, setOnlineMap] = useState<Record<string, boolean>>({});
  const [hubURL, setHubURL] = useState("");
  const [includeCA, setIncludeCA] = useState(true);
  const [bundleBusy, setBundleBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setEnrollments([]);
    setActiveTabIdx(0);
    setOnlineMap({});
    setScopeFilter("all");
    setAppFilter("all");

    if (isClusterScoped) {
      setSelectedClusters(defaultClusterId ? [defaultClusterId] : []);
      if (effectiveClusterMode === "cluster_hosts" && clusterHosts?.length) {
        const agList = existingAgents || [];
        setAllPlatformAgents(agList);
        // Pre-select all cluster hosts that aren't already bound to this cluster!
        const nextChecked = new Set<string>();
        for (const h of clusterHosts) {
          const alreadyBound = agList.some(
            (a) =>
              a.ip.trim() === h.ip.trim() &&
              a.clusters.includes(defaultClusterId!),
          );
          if (!alreadyBound) {
            nextChecked.add(h.ip.trim());
          }
        }
        if (defaultHostIP && nextChecked.has(defaultHostIP.trim())) {
          setCheckedHostIPs(new Set([defaultHostIP.trim()]));
        } else {
          setCheckedHostIPs(nextChecked);
        }
      } else {
        setName(defaultHostName || "");
        setIp(defaultHostIP || "");
      }
    } else {
      setName(defaultHostName || "");
      setIp(defaultHostIP || "");
      setSelectedClusters([]);
    }

    if (initialCatalog?.length) setCatalog(initialCatalog);
    if (initialBootstrap) {
      setBootInfo(initialBootstrap);
      setHubURL(
        initialBootstrap.suggested_urls?.[0] ||
          initialBootstrap.origin ||
          window.location.origin,
      );
      setIncludeCA(Boolean(initialBootstrap.ca_available));
    }

    void api<UnifiedAgentsListResp>("/api/executions/unified-agents")
      .then((res) => {
        if (res.agents) setAllPlatformAgents(res.agents);
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
    if (!visible || enrollments.length === 0) return;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      void api<UnifiedAgentsListResp>("/api/executions/unified-agents")
        .then((res) => {
          const nextOnline: Record<string, boolean> = {};
          let latestHit: UnifiedAgentView | null = null;
          for (const enr of enrollments) {
            const hit = (res.agents || []).find((a) => a.id === enr.agent.id);
            if (hit?.online) {
              nextOnline[enr.agent.id] = true;
              latestHit = hit;
            }
          }
          setOnlineMap((prev) => ({ ...prev, ...nextOnline }));
          if (latestHit) onEnrolled?.(latestHit);
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(poll, 2500);
    return () => window.clearInterval(timer);
  }, [visible, enrollments]); // eslint-disable-line react-hooks/exhaustive-deps

  const agentByIP = useMemo(() => {
    const m = new Map<string, UnifiedAgentView>();
    for (const a of allPlatformAgents) {
      if (!a.revoked) m.set(a.ip.trim(), a);
    }
    return m;
  }, [allPlatformAgents]);

  // Global transfer items (only when !isClusterScoped)
  const operableCatalog = useMemo(
    () => catalog.filter((c) => c.can_op),
    [catalog],
  );
  const selectedSet = useMemo(() => new Set(selectedClusters), [selectedClusters]);
  const trimmedIP = ip.trim();

  const allUnbound = useMemo(
    () => operableCatalog.filter((c) => !selectedSet.has(c.id)),
    [operableCatalog, selectedSet],
  );
  const sameIPUnboundCount = useMemo(
    () =>
      trimmedIP
        ? allUnbound.filter((c) => c.host_ips?.some((x) => x.trim() === trimmedIP))
            .length
        : 0,
    [allUnbound, trimmedIP],
  );
  const appOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of allUnbound) {
      counts.set(c.app_name, (counts.get(c.app_name) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [allUnbound]);

  const leftTransferItems = useMemo<ProTransferItem[]>(
    () =>
      allUnbound
        .filter((c) => {
          if (
            scopeFilter === "same_ip" &&
            (!trimmedIP || !c.host_ips?.some((x) => x.trim() === trimmedIP))
          ) {
            return false;
          }
          if (appFilter !== "all" && c.app_name !== appFilter) return false;
          return true;
        })
        .map((c) => buildClusterTransferItem(c, trimmedIP)),
    [allUnbound, scopeFilter, trimmedIP, appFilter],
  );

  const rightTransferItems = useMemo<ProTransferItem[]>(() => {
    const byId = new Map(catalog.map((c) => [c.id, c]));
    return selectedClusters.map((cid) => {
      const c = byId.get(cid);
      if (c) return buildClusterTransferItem(c, trimmedIP);
      return { key: cid, title: cid, monoTitle: true, searchText: cid };
    });
  }, [selectedClusters, catalog, trimmedIP]);

  const handleClusterHostsSubmit = async () => {
    if (submitBusy || !defaultClusterId || !clusterHosts?.length) return;
    const chosen = clusterHosts.filter((h) => checkedHostIPs.has(h.ip.trim()));
    if (chosen.length === 0) {
      Message.warning(bi("请至少勾选 1 台本集群机器", "Select at least 1 cluster host"));
      return;
    }
    setSubmitBusy(true);
    try {
      const created: UnifiedEnrollmentResp[] = [];
      let boundExistingCount = 0;
      let lastAgent: UnifiedAgentView | null = null;

      for (const h of chosen) {
        const existing = agentByIP.get(h.ip.trim());
        if (existing) {
          if (!existing.clusters.includes(defaultClusterId)) {
            const updated = await api<UnifiedAgentView>(
              "/api/executions/unified-agents",
              {
                method: "PATCH",
                body: JSON.stringify({
                  id: existing.id,
                  bind_clusters: [defaultClusterId],
                }),
              },
            );
            lastAgent = updated;
            boundExistingCount++;
          }
        } else {
          const res = await api<UnifiedEnrollmentResp>(
            "/api/executions/unified-agents",
            {
              method: "POST",
              body: JSON.stringify({
                name: h.name || h.ip,
                ip: h.ip.trim(),
                clusters: [defaultClusterId],
              }),
            },
          );
          created.push(res);
          lastAgent = res.agent;
        }
      }

      // Persist cluster automation transport preference as per-host ("agent")
      await api(`/api/clusters/${encodeURIComponent(defaultClusterId)}/automation`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true, transport: "agent" }),
      }).catch(() => undefined);

      if (lastAgent) onEnrolled?.(lastAgent);

      if (created.length === 0) {
        Message.success(
          bi(
            `已直接关联 ${boundExistingCount} 台已有机器 Agent`,
            `Associated ${boundExistingCount} existing host Agent(s)`,
          ),
        );
        onClose();
        return;
      }

      const firstBoot = created[0].bootstrap || bootInfo;
      if (firstBoot) {
        setHubURL(
          firstBoot.suggested_urls?.[0] ||
            firstBoot.origin ||
            window.location.origin,
        );
        setIncludeCA(Boolean(firstBoot.ca_available));
      }
      setEnrollments(created);
      setActiveTabIdx(0);
    } catch (e) {
      err(e);
    } finally {
      setSubmitBusy(false);
    }
  };

  const handleSingleSubmit = async () => {
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
      const targetClusters = isClusterScoped
        ? [defaultClusterId!]
        : selectedClusters;
      const res = await api<UnifiedEnrollmentResp>(
        "/api/executions/unified-agents",
        {
          method: "POST",
          body: JSON.stringify({
            name: cleanName,
            ip: cleanIP,
            clusters: targetClusters,
          }),
        },
      );
      if (isClusterScoped && defaultClusterId) {
        await api(
          `/api/clusters/${encodeURIComponent(defaultClusterId)}/automation`,
          {
            method: "PUT",
            body: JSON.stringify({
              enabled: true,
              transport: "node",
              node_id: res.agent.id,
            }),
          },
        ).catch(() => undefined);
      }
      const defURL =
        res.bootstrap?.suggested_urls?.[0] ||
        res.bootstrap?.origin ||
        bootInfo?.suggested_urls?.[0] ||
        window.location.origin;
      setHubURL(defURL);
      setIncludeCA(Boolean(res.bootstrap?.ca_available ?? bootInfo?.ca_available));
      setEnrollments([res]);
      setActiveTabIdx(0);
      onEnrolled?.(res.agent);
    } catch (e) {
      err(e);
    } finally {
      setSubmitBusy(false);
    }
  };

  const activeEnrollment = enrollments[activeTabIdx] || enrollments[0] || null;

  const handleDownloadBundle = async (enr: UnifiedEnrollmentResp) => {
    if (!enr || bundleBusy) return;
    setBundleBusy(true);
    try {
      const tok = authToken();
      const resp = await fetch(withLang("/api/executions/unified-agents/bundle"), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken(),
          ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({
          agent_id: enr.agent.id,
          token: enr.token,
          url: hubURL.trim(),
          include_ca: includeCA,
        }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const slug = agentBundleSlug(enr.agent.name, enr.agent.ip);
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

  const modalWidth = isClusterScoped
    ? effectiveClusterMode === "jumpbox"
      ? 640
      : 680
    : 860;

  const hasStep2 = enrollments.length > 0;
  const activeSlug = activeEnrollment
    ? `ds-agent-${agentBundleSlug(activeEnrollment.agent.name, activeEnrollment.agent.ip)}`
    : "ds-agent";
  const installCmd = `tar -xzf ${activeSlug}.tar.gz && sudo bash ${activeSlug}/install.sh`;
  const onlineTotal = enrollments.filter((e) => onlineMap[e.agent.id]).length;

  return (
    <Modal
      visible={visible}
      onCancel={onClose}
      footer={null}
      style={{ width: modalWidth, maxWidth: "96vw" }}
      title={
        <div className="eam-head">
          <span className="eam-head-title">
            <span className="eam-head-ic">
              <IconThunderbolt />
            </span>
            <span>
              {isClusterScoped
                ? effectiveClusterMode === "cluster_hosts"
                  ? bi("安装本集群节点直连 Agent", "Install Cluster Node Agents")
                  : bi("接入跳板机 / 控制机 Agent", "Enroll Jumpbox Agent")
                : bi("接入执行 Agent", "Enroll Execution Agent")}
            </span>
            {defaultClusterId && (
              <code className="eam-cluster-tag mono">{defaultClusterId}</code>
            )}
          </span>
        </div>
      }
    >
      <div className="eam-steps-bar">
        <Steps size="small" current={hasStep2 ? 1 : 0}>
          <Steps.Step
            title={
              isClusterScoped && effectiveClusterMode === "cluster_hosts"
                ? bi("确认本集群机器", "Select Nodes")
                : bi("登记机器信息", "Register Host")
            }
          />
          <Steps.Step title={bi("下载安装并连接", "Install & Connect")} />
        </Steps>
      </div>

      {!hasStep2 ? (
        isClusterScoped && effectiveClusterMode === "cluster_hosts" ? (
          /* ---- CLUSTER-SCOPED NODE CHECKLIST (ONLY THIS CLUSTER'S MACHINES!) ---- */
          <div className="eam-body">
            <p className="eam-lead-note">
              {bi(
                `以下为集群「${defaultClusterId}」的 ${clusterHosts?.length || 0} 台目标机器。勾选后将直接为这些机器签发免密直连 Agent 安装包并自动绑定本集群：`,
                `Below are the ${clusterHosts?.length || 0} target nodes of cluster "${defaultClusterId}". Selected nodes will receive passwordless local Agent bundles bound automatically to this cluster:`,
              )}
            </p>

            <div className="eam-node-list">
              {(clusterHosts || []).map((h) => {
                const ipKey = h.ip.trim();
                const existing = agentByIP.get(ipKey);
                const alreadyBound = Boolean(
                  existing &&
                    defaultClusterId &&
                    existing.clusters.includes(defaultClusterId),
                );
                const checked = checkedHostIPs.has(ipKey);

                return (
                  <div
                    key={`${h.name}-${ipKey}`}
                    className={`eam-node-row ${
                      alreadyBound
                        ? "is-done"
                        : checked
                          ? "is-checked"
                          : ""
                    }`}
                    onClick={() => {
                      if (alreadyBound || submitBusy) return;
                      setCheckedHostIPs((prev) => {
                        const next = new Set(prev);
                        if (checked) next.delete(ipKey);
                        else next.add(ipKey);
                        return next;
                      });
                    }}
                  >
                    <Checkbox
                      checked={alreadyBound || checked}
                      disabled={alreadyBound || submitBusy}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(v) => {
                        setCheckedHostIPs((prev) => {
                          const next = new Set(prev);
                          if (v) next.add(ipKey);
                          else next.delete(ipKey);
                          return next;
                        });
                      }}
                    />
                    <div className="eam-node-info">
                      <div className="eam-node-top">
                        <b>{h.name}</b>
                        <code className="mono">{ipKey}</code>
                        {h.role && <span className="rha-host-role">{h.role}</span>}
                      </div>
                      <span className="eam-node-sub">
                        {alreadyBound
                          ? bi(
                              `已关联 Agent「${existing?.name}」`,
                              `Already associated ("${existing?.name}")`,
                            )
                          : existing
                            ? bi(
                                `平台已接入该 IP（${existing.name}），勾选后直接关联免重装`,
                                `Existing Agent "${existing.name}" found — will associate directly`,
                              )
                            : bi(
                                "将在该机器本机安装轻量 Agent（免 SSH 密码）",
                                "Will generate local passwordless Agent installer",
                              )}
                      </span>
                    </div>
                    <span
                      className={`ptf-tag ${
                        alreadyBound
                          ? "is-ok"
                          : existing
                            ? "is-cobalt"
                            : ""
                      }`}
                    >
                      {alreadyBound
                        ? bi("已就绪", "Bound")
                        : existing
                          ? bi("直接复用", "Reuse")
                          : bi("待新装", "New")}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="eam-foot">
              <Button onClick={onClose}>{bi("取消", "Cancel")}</Button>
              <Button
                type="primary"
                loading={submitBusy}
                disabled={checkedHostIPs.size === 0}
                onClick={() => void handleClusterHostsSubmit()}
              >
                {bi(
                  `下一步：配置所选 ${checkedHostIPs.size} 台机器`,
                  `Next: Configure ${checkedHostIPs.size} Node(s)`,
                )}
              </Button>
            </div>
          </div>
        ) : (
          /* ---- JUMPBOX MODE (CLUSTER-SCOPED) OR GLOBAL ENROLLMENT ---- */
          <div className="eam-body">
            {isClusterScoped && (
              <p className="eam-lead-note">
                {bi(
                  `在 1 台能通过 SSH / Ansible 访问「${defaultClusterId}」各节点的跳板机或管理机上部署 Agent，接入后自动关联至本集群。`,
                  `Deploy one Agent on a jumpbox/management host with SSH access to "${defaultClusterId}" nodes.`,
                )}
              </p>
            )}

            <div className="eam-id-card">
              <label className="ua-field">
                <span>
                  {isClusterScoped
                    ? bi("跳板机 / 控制机名称", "Jumpbox Name")
                    : bi("Agent 名称", "Agent Name")}
                </span>
                <Input
                  value={name}
                  onChange={setName}
                  placeholder={
                    isClusterScoped
                      ? bi("例如 prod-jumpbox-01", "e.g. prod-jumpbox-01")
                      : bi(
                          "例如 prod-jumpbox-01 或 db-node-01",
                          "e.g. prod-jumpbox-01 or db-node-01",
                        )
                  }
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
            </div>

            {!isClusterScoped && operableCatalog.length > 0 && (
              <div className="eam-transfer-sec">
                <div className="eam-sec-top">
                  <span className="eam-sec-lbl">
                    {bi("初始关联集群（可选）", "Initial Cluster Associations (Optional)")}
                  </span>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {sameIPUnboundCount > 0 && (
                      <Radio.Group
                        type="button"
                        size="small"
                        value={scopeFilter}
                        onChange={(v) => setScopeFilter(v as "all" | "same_ip")}
                      >
                        <Radio value="all">
                          {bi("全部", "All")} ({allUnbound.length})
                        </Radio>
                        <Radio value="same_ip">
                          {bi("同机 IP", "Same IP")} ({sameIPUnboundCount})
                        </Radio>
                      </Radio.Group>
                    )}
                    {appOptions.length > 1 && (
                      <Select
                        size="small"
                        style={{ width: 168 }}
                        value={appFilter}
                        onChange={setAppFilter}
                        getPopupContainer={() => document.body}
                        triggerProps={{ autoFitPosition: true }}
                        options={[
                          { value: "all", label: bi("全部中间件", "All Apps") },
                          ...appOptions.map(([app, n]) => ({
                            value: app,
                            label: `${app} (${n})`,
                          })),
                        ]}
                      />
                    )}
                  </div>
                </div>

                <ProTransfer
                  height={296}
                  leftTitle={bi("可关联集群", "Available Clusters")}
                  rightTitle={bi("初始关联集群", "Selected Clusters")}
                  leftItems={leftTransferItems}
                  rightItems={rightTransferItems}
                  leftPlaceholder={bi(
                    "搜索集群名、节点 IP、中间件、系统或创建者…",
                    "Search cluster, node IP, app, OS, or owner…",
                  )}
                  rightEmptyText={bi(
                    "可不选仅接入机器，后续随时在详情页关联",
                    "Optional — you can also associate clusters later",
                  )}
                  onAdd={(keys) =>
                    setSelectedClusters((prev) =>
                      Array.from(new Set([...prev, ...keys])),
                    )
                  }
                  onRemove={(keys) => {
                    const rm = new Set(keys);
                    setSelectedClusters((prev) => prev.filter((k) => !rm.has(k)));
                  }}
                />
              </div>
            )}

            <div className="eam-foot">
              <Button onClick={onClose}>{bi("取消", "Cancel")}</Button>
              <Button
                type="primary"
                loading={submitBusy}
                onClick={() => void handleSingleSubmit()}
              >
                {bi("下一步：生成安装包与命令", "Next: Generate Installer")}
              </Button>
            </div>
          </div>
        )
      ) : (
        /* ---- STEP 2: INSTALLER BUNDLE & LIVE CONNECTION TABS ---- */
        <div className="eam-body">
          <div
            className={`ua-live-banner ${
              onlineTotal === enrollments.length ? "is-ok" : ""
            }`}
          >
            {onlineTotal === enrollments.length ? (
              <IconCheckCircle />
            ) : (
              <IconLoading />
            )}
            <div>
              <b>
                {onlineTotal === enrollments.length
                  ? bi(
                      enrollments.length > 1
                        ? `全部 ${enrollments.length} 台机器 Agent 已成功连接上线！`
                        : "Agent 已成功连接上线并同步主机探针！",
                      "All enrolled Agent(s) connected & online!",
                    )
                  : bi(
                      enrollments.length > 1
                        ? `正在等待机器执行安装脚本并上报首次心跳（已上线 ${onlineTotal} / ${enrollments.length} 台）…`
                        : "等待目标机器执行安装脚本并上报首次心跳（自动检测中）…",
                      "Waiting for installation & first heartbeat…",
                    )}
              </b>
              {defaultClusterId && (
                <small>
                  {bi(
                    `已自动绑定至集群「${defaultClusterId}」`,
                    `Automatically associated with cluster "${defaultClusterId}"`,
                  )}
                </small>
              )}
            </div>
          </div>

          {enrollments.length > 1 && (
            <div className="eam-enr-tabs" role="tablist">
              {enrollments.map((enr, idx) => {
                const isOn = Boolean(onlineMap[enr.agent.id]);
                return (
                  <button
                    key={enr.agent.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTabIdx === idx}
                    className={`eam-enr-tab ${activeTabIdx === idx ? "on" : ""}`}
                    onClick={() => setActiveTabIdx(idx)}
                  >
                    <span
                      className={`ptf-dot ${isOn ? "is-online" : "is-offline"}`}
                    />
                    <b>{enr.agent.name}</b>
                    <code className="mono">{enr.agent.ip}</code>
                  </button>
                );
              })}
            </div>
          )}

          {activeEnrollment && (
            <>
              <div className="eam-step2-grid">
                <label className="ua-field">
                  <span>
                    {bi(
                      "1. 确认 Agent 回连平台的 HTTPS 地址",
                      "1. Platform Callback HTTPS URL",
                    )}
                  </span>
                  <Input
                    value={hubURL}
                    onChange={setHubURL}
                    placeholder="https://192.168.1.10:8443"
                  />
                  {isLoopbackURL(hubURL) && (
                    <small className="warn">
                      {bi(
                        "127.0.0.1 仅限本机测试；远程机器请改为平台所在服务器可达 IP。",
                        "127.0.0.1 only works locally; use a reachable LAN IP.",
                      )}
                    </small>
                  )}
                </label>

                <div className="eam-dl-card">
                  <div>
                    <b>
                      {bi(
                        `2. 下载 ${activeEnrollment.agent.name} 专属安装包`,
                        `2. Download Bundle (${activeEnrollment.agent.name})`,
                      )}
                    </b>
                    <small className="mono">{activeEnrollment.agent.ip}</small>
                  </div>
                  <Button
                    type="primary"
                    icon={<IconDownload />}
                    loading={bundleBusy}
                    onClick={() => void handleDownloadBundle(activeEnrollment)}
                  >
                    {bi("下载 .tar.gz", "Download .tar.gz")}
                  </Button>
                </div>
              </div>

              <div className="eam-cmd-box">
                <div className="eam-cmd-head">
                  <span>
                    {bi(
                      `3. 上传至 ${activeEnrollment.agent.ip} 后执行一键安装命令`,
                      `3. Upload to ${activeEnrollment.agent.ip} and run installer`,
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
            </>
          )}

          <div className="eam-foot">
            <Button type="primary" onClick={onClose}>
              {onlineTotal === enrollments.length
                ? bi("完成", "Done")
                : bi("完成（后台继续等待上线）", "Close & Wait in Background")}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

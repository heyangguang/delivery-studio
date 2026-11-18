import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Input,
  Message,
  Pagination,
  Popconfirm,
  Select,
  Skeleton,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconDownload,
  IconPoweroff,
  IconRefresh,
  IconRight,
  IconSearch,
} from "@arco-design/web-react/icon";
import { api, can, formatDuration, num, stamp, useConnectivity } from "./shared";
import { RangeBar, rangeOf } from "./rangebar";
import type { Range } from "./rangebar";
import { Segmented, StatusBadge, StatusDot } from "./ui";
import "./aiusage.css";
import "./iam.css";

/* Platform audit log: operations history plus live session and online duration tracking. */

const ACTION: Record<string, [string, string]> = {
  login: ["登录", "账户"],
  "login-failed": ["登录失败", "账户"],
  logout: ["退出登录", "账户"],
  "session-revoke": ["强制下线会话", "账户"],
  "session-expired": ["会话超时结束", "账户"],
  "user-add": ["添加用户", "账户"],
  "user-role": ["修改角色", "账户"],
  "user-password": ["重置密码", "账户"],
  "user-disable": ["停用账户", "账户"],
  "user-enable": ["启用账户", "账户"],
  "user-delete": ["删除账户", "账户"],
  "user-grant": ["分配角色和团队", "账户"],
  "user-deliveries-move": ["转交已删除账户的交付", "账户"],
  "user-quota": ["调整账户存储额度", "账户"],
  "job-create": ["创建交付", "交付"],
  "job-revised": ["修订交付", "交付"],
  "job-sync": ["同步组件修复到交付", "交付"],
  "job-sync-keep": ["保留原组件版本", "交付"],
  "job-succeeded": ["交付生成成功", "交付"],
  "job-failed": ["交付生成失败", "交付"],
  "job-mark": ["标记交付结果", "交付"],
  "job-delete": ["删除交付", "交付"],
  "job-progress-clear": ["清空执行记录", "交付"],
  "job-download": ["下载完整交付包", "交付"],
  "job-file-download": ["下载交付文件", "交付"],
  "job-download-runtime": ["下载运行环境清单", "交付"],
  "job-step": ["记录执行结果", "交付"],
  "job-runlogs": ["上传或写入执行日志", "交付"],
  "job-runlogs-delete": ["清理执行日志", "交付"],
  "execution-node-create": ["登记执行节点", "交付"],
  "execution-node-disable": ["停用或启用执行节点", "交付"],
  "execution-node-delete": ["删除执行节点", "交付"],
  "execution-node-authorize": ["授权执行节点", "交付"],
  "execution-prepare": ["执行节点环境准备", "交付"],
  "execution-create": ["发起自动执行", "交付"],
  "execution-pause": ["暂停自动执行", "交付"],
  "execution-resume": ["恢复自动执行", "交付"],
  "execution-close": ["关闭自动执行", "交付"],
  "target-agent-enroll": ["接入目标机 Agent", "交付"],
  "target-agent-revoke": ["撤销目标机 Agent", "交付"],
  "doc-section": ["编辑文档", "交付"],
  "doc-draft": ["AI 起草文档", "交付"],
  "doc-check": ["AI 检查文档", "交付"],
  "doc-export": ["导出文档", "交付"],
  "doc-rca": ["发起根因分析", "交付"],
  "doc-rca-delete": ["删除根因分析或评估", "交付"],
  "doc-assess": ["新建评估", "交付"],
  "rehearsal-create": ["发起变更演练", "AI"],
  "rehearsal-scope": ["更新变更影响评估", "AI"],
  "rehearsal-probe": ["解析变更采集探针", "AI"],
  "rehearsal-step": ["调整变更演练步骤", "交付"],
  "rehearsal-troubleshoot": ["AI 排障修正演练步骤", "AI"],
  "rehearsal-apply": ["应用变更演练修正建议", "AI"],
  "rehearsal-finalize": ["定稿生产变更实施方案", "交付"],
  "rehearsal-delete": ["删除变更演练", "交付"],
  "report-settings": ["修改交付文档设置", "设置"],
  "report-template": ["上传 Word 模板", "设置"],
  "report-template-delete": ["删除 Word 模板", "设置"],
  "report-banner": ["上传交付文档横幅", "设置"],
  "report-banner-delete": ["删除交付文档横幅", "设置"],
  "component-draft-start": ["开始编辑组件", "组件"],
  "component-draft-drop": ["放弃组件草稿", "组件"],
  "component-publish": ["发布组件", "组件"],
  "component-restore": ["恢复组件修订", "组件"],
  "component-import": ["导入组件", "组件"],
  "component-delete": ["删除组件", "组件"],
  "component-warning-ignore": ["忽略组件检查告警", "组件"],
  "component-version-status": ["调整组件版本状态", "组件"],
  "library-fetch": ["下载软件包", "软件库"],
  "library-delete": ["删除软件包", "软件库"],
  "library-import": ["导入软件包", "软件库"],
  "library-sources": ["修改软件源", "软件库"],
  "library-index-update": ["更新软件源索引", "软件库"],
  "library-index-import": ["导入软件源索引", "软件库"],
  "python-runtime-build": ["构建 Ansible 运行环境", "软件库"],
  "python-runtime-default": ["设置默认运行环境", "软件库"],
  "python-runtime-import": ["导入运行环境", "软件库"],
  "notify-channel": ["保存通知渠道", "通知"],
  "notify-channel-delete": ["删除通知渠道", "通知"],
  "notify-template": ["修改通知模板", "通知"],
  "ai-toggle": ["切换 AI 套件开关", "AI"],
  "ai-settings": ["修改 AI 设置", "AI"],
  "ai-provider": ["保存模型供应商", "AI"],
  "ai-provider-delete": ["删除模型供应商", "AI"],
  "ai-resolve": ["AI 排障记录写入执行记录", "AI"],
  "ai-proposal-accept": ["采纳 AI 提案", "AI"],
  "ai-proposal-reject": ["拒绝 AI 提案", "AI"],
  "ai-amendment-withdraw": ["撤销 AI 补充", "AI"],
  "ai-component-proposal": ["处理组件 AI 提案", "AI"],
  "ai-chat": ["AI 对话", "AI"],
  "ai-fill": ["AI 智能填表", "AI"],
  "ai-prices": ["修改模型价格", "AI"],
  "ai-skills": ["修改 AI 技能", "AI"],
  "ai-skill-script": ["查看或导出技能脚本", "AI"],
  "ai-mcp": ["保存 MCP 服务", "AI"],
  "ai-mcp-delete": ["移除 MCP 服务", "AI"],
  "ai-web": ["修改联网搜索", "AI"],
  "ai-user-mcp": ["个人 MCP 开关", "AI"],
  "ai-sandbox-run": ["AI 在沙箱里运行代码", "AI"],
  "ai-sandbox-shell": ["在隔离沙箱执行命令", "AI"],
  "sandbox-settings": ["修改代码沙箱设置", "平台"],
  "sandbox-check": ["检测代码沙箱", "平台"],
  "storage-settings": ["修改存储空间设置", "平台"],
  "me-password": ["修改自己的密码", "账户"],
  "me-password-failed": ["改密码时当前密码错误", "账户"],
  "me-skills": ["修改我的技能", "AI"],
  "me-mcp": ["保存我的 MCP 服务", "AI"],
  "me-mcp-delete": ["移除我的 MCP 服务", "AI"],
  "me-kb": ["更新知识库资料", "AI"],
  "me-kb-delete": ["删除知识库资料", "AI"],
  "me-files-upload": ["上传文件到我的资料", "AI"],
  "me-files-add": ["新建资料或文件夹", "AI"],
  "me-files-edit": ["修改资料", "AI"],
  "me-files-move": ["重命名或移动资料", "AI"],
  "me-files-delete": ["删除资料", "AI"],
  "me-files-download": ["下载我的文件", "AI"],
  "me-ai-prefs": ["修改 AI 个性化设置", "AI"],
  "me-ai-memory-clear": ["清空 AI 记忆", "AI"],
  "ai-chat-archive": ["归档 AI 对话", "AI"],
  "ai-chat-unarchive": ["取消归档 AI 对话", "AI"],
  "iam-role-add": ["新建角色", "IAM"],
  "iam-role-edit": ["修改角色", "IAM"],
  "iam-role-delete": ["删除角色", "IAM"],
  "iam-team-add": ["新建团队", "IAM"],
  "iam-team-edit": ["修改团队", "IAM"],
  "iam-team-delete": ["删除团队", "IAM"],
  "audit-export": ["导出操作审计", "IAM"],
  "audit-sessions-export": ["导出登录与在线记录", "IAM"],
  "kb-submit": ["提交到团队知识库", "知识库"],
  "kb-approve": ["审核通过资料", "知识库"],
  "kb-reject": ["退回资料", "知识库"],
  "kb-edit": ["编辑团队资料", "知识库"],
  "kb-delete": ["删除团队资料", "知识库"],
};
export const auditLabel = (a: string) => ACTION[a]?.[0] || a;

const VERB: Record<string, string> = {
  POST: "提交",
  PUT: "修改",
  PATCH: "修改",
  DELETE: "删除",
  GET: "读取",
  HEAD: "读取",
};
type Res = { type: string; id?: string; name?: string };
type Row = {
  time: string;
  action: string;
  user: string;
  job: string;
  ip?: string;
  agent?: string;
  method?: string;
  path?: string;
  resource?: Res;
  request?: string;
  status?: number;
  result?: string;
  error?: string;
  ms?: number;
  session_id?: string;
  duration_sec?: number;
};
export type AuditSessionRow = {
  id: string;
  user: string;
  role: string;
  ip?: string;
  agent?: string;
  auth_type: string;
  status: "active" | "closed";
  end_reason: string;
  end_detail?: string;
  created_at: string;
  last_active_at: string;
  expires_at: string;
  ended_at?: string;
  duration_seconds: number;
  active_seconds: number;
  requests: number;
  current?: boolean;
};
type AuditSessionUser = {
  user: string;
  role: string;
  online: boolean;
  active_sessions: number;
  total_sessions: number;
  total_duration_seconds: number;
  total_active_seconds: number;
  login_count: number;
  failed_login_count: number;
  last_login_at?: string;
  last_active_at?: string;
  last_ip?: string;
};
type AuditSessionsResp = {
  rows: AuditSessionRow[];
  total: number;
  page: number;
  size: number;
  users: string[];
  by_user: AuditSessionUser[];
  summary: {
    online_users: number;
    active_sessions: number;
    total_sessions: number;
    avg_duration_seconds: number;
    max_duration_seconds: number;
    failed_logins: number;
  };
};

const RESULT: Record<string, string> = {
  ok: "成功",
  denied: "被拒绝",
  failed: "未通过",
  error: "出错",
};

export const SESSION_REASON: Record<string, [string, string]> = {
  active: ["在线", "ok"],
  logout: ["已退出", "mute"],
  expired: ["已超时", "warn"],
  revoked: ["已下线", "bad"],
  "password-changed": ["改密失效", "warn"],
  disabled: ["账户停用", "bad"],
  deleted: ["账户移除", "bad"],
};

const TONE_STATE: Record<string, string> = {
  ok: "done",
  warn: "warn",
  bad: "failed",
  mute: "void",
};

export const auditText = (r: {
  action: string;
  method?: string;
  resource?: Res;
}) =>
  r.action && r.action !== "http"
    ? auditLabel(r.action)
    : `${VERB[r.method || ""] || r.method || "请求"}${r.resource?.type ? ` ${r.resource.type}` : ""}`;

const what = (r: Row) =>
  r.action && r.action !== "http"
    ? auditLabel(r.action)
    : `${VERB[r.method || ""] || r.method || "请求"}${r.resource?.type ? ` ${r.resource.type}` : ""}`;

/** Browser & OS label in concise words: "Chrome 141 · Windows". */
export function browser(ua?: string) {
  if (!ua) return "";
  const m = /(Edg|Chrome|Firefox|Version)\/(\d+)/.exec(ua);
  const name = m
    ? (
        {
          Edg: "Edge",
          Chrome: "Chrome",
          Firefox: "Firefox",
          Version: "Safari",
        } as Record<string, string>
      )[m[1]] +
      " " +
      m[2]
    : ua.split(" ")[0];
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return [name, os].filter(Boolean).join(" · ");
}

const pretty = (t?: string) =>
  (t || "")
    .split("\n")
    .map((line) => {
      const i = line.indexOf("{");
      if (i < 0) return line;
      try {
        return (
          line.slice(0, i) + JSON.stringify(JSON.parse(line.slice(i)), null, 2)
        );
      } catch {
        return line;
      }
    })
    .join("\n");

export function AuditView() {
  const conn = useConnectivity();
  const [tab, setTab] = useState<"events" | "sessions">("events");
  const [range, setRange] = useState<Range>(() => rangeOf("7d"));
  const [user, setUser] = useState("");
  const [action, setAction] = useState("");
  const [kind, setKind] = useState("");
  const [result, setResult] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Row | null>(null);
  const [d, setD] = useState<{
    rows: Row[];
    total: number;
    users: string[];
    actions: Record<string, number>;
    resources: Record<string, number>;
  } | null>(null);
  const [evLoading, setEvLoading] = useState(true);
  const [evTick, setEvTick] = useState(0);
  const [error, setError] = useState("");

  // Session & online tracking state
  const [sessStatus, setSessStatus] = useState("");
  const [sessPage, setSessPage] = useState(1);
  const [sessResp, setSessResp] = useState<AuditSessionsResp | null>(null);
  const [sessLoading, setSessLoading] = useState(false);
  const [sessErr, setSessErr] = useState("");
  const [sessDetail, setSessDetail] = useState<AuditSessionRow | null>(null);
  const [sessTick, setSessTick] = useState(0);

  // Bidirectional trace context between "登录与在线" and "操作记录"
  const [trace, setTrace] = useState<{
    sid: string;
    user?: string;
    createdAt?: string;
  } | null>(null);

  const size = 50;
  const params = useCallback(() => {
    const p = new URLSearchParams({ from: range.from, to: range.to });
    if (user) p.set("user", user);
    if (action) p.set("action", action);
    if (kind) p.set("resource", kind);
    if (result) p.set("result", result);
    if (q) p.set("q", q);
    return p;
  }, [range, user, action, kind, result, q]);

  const sessParams = useCallback(() => {
    const p = new URLSearchParams({ from: range.from, to: range.to });
    if (user) p.set("user", user);
    if (sessStatus) p.set("status", sessStatus);
    if (q) p.set("q", q);
    return p;
  }, [range, user, sessStatus, q]);

  useEffect(() => setPage(1), [range, user, action, kind, result, q]);
  useEffect(() => setSessPage(1), [range, user, sessStatus, q]);

  useEffect(() => {
    if (tab !== "events") return;
    let live = true;
    setEvLoading(true);
    const t = window.setTimeout(() => {
      const p = params();
      p.set("page", String(page));
      p.set("size", String(size));
      api<typeof d>(`/api/audit?${p}`)
        .then((r) => {
          if (!live) return;
          setD(r);
          setError("");
        })
        .catch((e) => {
          if (!live) return;
          setError((e as Error).message || "加载操作记录失败");
        })
        .finally(() => {
          if (live) setEvLoading(false);
        });
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [tab, params, page, evTick]);

  useEffect(() => {
    if (tab !== "sessions") return;
    let live = true;
    setSessLoading(true);
    const t = window.setTimeout(() => {
      const p = sessParams();
      p.set("page", String(sessPage));
      p.set("size", String(size));
      api<AuditSessionsResp>(`/api/audit/sessions?${p}`)
        .then((r) => {
          if (!live) return;
          setSessResp(r);
          setSessErr("");
        })
        .catch((e) => {
          if (!live) return;
          setSessErr((e as Error).message || "加载会话记录失败");
        })
        .finally(() => {
          if (live) setSessLoading(false);
        });
    }, 130);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [tab, sessParams, sessPage, sessTick]);

  const kickSession = async (row: AuditSessionRow) => {
    try {
      await api(`/api/audit/sessions/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      Message.success(`已下线 ${row.user} 的会话`);
      setSessDetail(null);
      setSessTick((n) => n + 1);
    } catch (e) {
      Message.error((e as Error).message);
    }
  };

  const traceSessionEvents = (
    sid: string,
    opts?: { user?: string; createdAt?: string },
  ) => {
    setAction("");
    setKind("");
    setResult("");
    setUser("");
    setTrace({ sid, user: opts?.user, createdAt: opts?.createdAt });
    setQ(sid);
    setSessDetail(null);
    setOpen(null);
    setTab("events");
  };

  const returnToSessions = () => {
    setQ("");
    setTrace(null);
    setOpen(null);
    setTab("sessions");
  };

  const clearTrace = () => {
    if (trace && q === trace.sid) setQ("");
    setTrace(null);
  };

  const switchTab = (next: "events" | "sessions") => {
    if (next === "sessions" && trace && q === trace.sid) {
      setQ("");
    }
    setOpen(null);
    setSessDetail(null);
    setTab(next);
  };

  const clearFilters = () => {
    setUser("");
    setAction("");
    setKind("");
    setResult("");
    setSessStatus("");
    setQ("");
    setTrace(null);
  };

  const hasFilters =
    tab === "events"
      ? Boolean(user || action || kind || result || q)
      : Boolean(user || sessStatus || q);

  const groups = new Map<string, { value: string; label: string }[]>();
  Object.keys(d?.actions || {}).forEach((a) => {
    const g = a === "http" ? "其他" : ACTION[a]?.[1] || "其他";
    groups.set(g, [
      ...(groups.get(g) || []),
      {
        value: a,
        label: `${a === "http" ? "其他请求" : auditLabel(a)}（${d!.actions[a]}）`,
      },
    ]);
  });

  const canManageUsers = can("iam.user");
  const allUsers =
    tab === "sessions" ? sessResp?.users || [] : d?.users || [];
  const activeTrace = Boolean(trace && q === trace.sid);
  const summary = sessResp?.summary;

  return (
    <article className="au-page enter">
      <header className="iam-h au-h">
        <div>
          <h1>操作审计</h1>
          <p>按时间、成员与资源检索操作记录，查看终端登录与在线时长。</p>
        </div>
        <div className="au-head-acts">
          <Segmented
            size="md"
            label="审计视图"
            value={tab}
            onChange={switchTab}
            options={[
              { value: "events", label: "操作记录" },
              {
                value: "sessions",
                label: "登录与在线",
                count: summary ? summary.online_users : undefined,
              },
            ]}
          />
          <Button
            icon={<IconRefresh />}
            onClick={() =>
              tab === "events"
                ? setEvTick((n) => n + 1)
                : setSessTick((n) => n + 1)
            }
            aria-label="刷新当前列表"
          >
            刷新
          </Button>
          <Button
            icon={<IconDownload />}
            href={
              tab === "events"
                ? `/api/audit/export?${params()}`
                : `/api/audit/sessions/export?${sessParams()}`
            }
          >
            导出表格
          </Button>
        </div>
      </header>

      {conn !== "online" && (
        <Alert
          type="warning"
          showIcon
          className="au-offline"
          content={
            conn === "offline"
              ? "当前处于离线状态，恢复连接后可继续加载或刷新最新审计记录。"
              : "暂无法连接到平台服务，请检查服务状态后重试。"
          }
          action={
            <Button
              size="mini"
              onClick={() =>
                tab === "events"
                  ? setEvTick((n) => n + 1)
                  : setSessTick((n) => n + 1)
              }
            >
              重新检测
            </Button>
          }
        />
      )}

      <div className="au-filters">
        <div className="au-filter-top">
          <RangeBar value={range} onChange={setRange} />
          {hasFilters && (
            <Button
              type="text"
              size="small"
              className="au-clear-btn"
              onClick={clearFilters}
            >
              清空筛选
            </Button>
          )}
        </div>
        <div className="au-row">
          <Input
            allowClear
            prefix={<IconSearch />}
            placeholder={
              tab === "events"
                ? "搜索成员、资源、路径或请求内容"
                : "搜索成员、设备、IP 或会话编号"
            }
            value={q}
            onChange={(val) => {
              setQ(val);
              if (trace && val !== trace.sid) setTrace(null);
            }}
            style={{ width: 260 }}
            aria-label="搜索"
          />
          <Select
            allowClear
            placeholder="成员"
            value={user || undefined}
            onChange={(v) => setUser(v || "")}
            options={allUsers.map((u) => ({ value: u, label: u }))}
            style={{ width: 136 }}
            aria-label="按成员筛选"
          />
          {tab === "events" ? (
            <>
              <Select
                allowClear
                placeholder="资源"
                value={kind || undefined}
                onChange={(v) => setKind(v || "")}
                options={Object.entries(d?.resources || {}).map(([k, n]) => ({
                  value: k,
                  label: `${k}（${n}）`,
                }))}
                style={{ width: 152 }}
                aria-label="按资源筛选"
              />
              <Select
                allowClear
                showSearch
                placeholder="操作类型"
                value={action || undefined}
                onChange={(v) => setAction(v || "")}
                style={{ width: 204 }}
                aria-label="按操作类型筛选"
              >
                {[...groups.entries()].map(([g, opts]) => (
                  <Select.OptGroup key={g} label={g}>
                    {opts.map((o) => (
                      <Select.Option key={o.value} value={o.value}>
                        {o.label}
                      </Select.Option>
                    ))}
                  </Select.OptGroup>
                ))}
              </Select>
              <Select
                allowClear
                placeholder="结果"
                value={result || undefined}
                onChange={(v) => setResult(v || "")}
                options={Object.entries(RESULT).map(([k, v]) => ({
                  value: k,
                  label: v,
                }))}
                style={{ width: 108 }}
                aria-label="按结果筛选"
              />
            </>
          ) : (
            <Select
              allowClear
              placeholder="会话状态"
              value={sessStatus || undefined}
              onChange={(v) => setSessStatus(v || "")}
              options={[
                { value: "active", label: "当前在线" },
                { value: "closed", label: "已结束" },
                { value: "logout", label: "主动退出" },
                { value: "expired", label: "超时结束" },
                { value: "revoked", label: "强制下线" },
                { value: "password-changed", label: "改密失效" },
              ]}
              style={{ width: 150 }}
              aria-label="按会话状态筛选"
            />
          )}
        </div>
      </div>

      {tab === "events" ? (
        <section key="events" className="au-panel">
          {activeTrace && trace && (
            <div className="au-trace-bar" role="status">
              <div className="au-trace-info">
                <StatusDot state="generated" />
                <span>
                  正在查看
                  {trace.user ? (
                    <>
                      {" "}
                      <b>{trace.user}</b>{" "}
                    </>
                  ) : (
                    "该"
                  )}
                  会话的操作记录
                  {trace.createdAt
                    ? `（登录于 ${stamp(trace.createdAt)}）`
                    : ""}
                </span>
              </div>
              <div className="au-trace-acts">
                <Button
                  size="small"
                  icon={<IconArrowLeft />}
                  onClick={returnToSessions}
                >
                  返回登录与在线
                </Button>
                <Button size="small" type="text" onClick={clearTrace}>
                  查看全部记录
                </Button>
              </div>
            </div>
          )}

          {error && (
            <Alert
              type="error"
              showIcon
              className="au-alert"
              content={error}
              action={
                <Button size="mini" onClick={() => setEvTick((n) => n + 1)}>
                  重试
                </Button>
              }
            />
          )}

          <div className="au-count">
            {d ? `共 ${num(d.total)} 条记录` : evLoading ? "正在载入…" : ""}
          </div>

          {evLoading && !d ? (
            <div className="au-skel">
              <Skeleton animation text={{ rows: 6 }} />
            </div>
          ) : d && d.rows.length > 0 ? (
            <div className="au2" role="table" aria-label="操作记录明细">
              <div className="au2-row au2-head" role="row">
                <span>时间</span>
                <span>成员</span>
                <span>操作内容</span>
                <span>对象资源</span>
                <span>结果</span>
              </div>
              {d.rows.map((r, i) => (
                <button
                  key={`${r.time}-${i}`}
                  type="button"
                  className={`au2-row ${open === r ? "on" : ""}`}
                  role="row"
                  onClick={() => setOpen(r)}
                >
                  <span className="au2-time num">{stamp(r.time)}</span>
                  <span className="au2-who">
                    <b>{r.user || "—"}</b>
                    <small className="mono">
                      {r.ip || (r.user === "system" ? "系统自动" : "")}
                    </small>
                  </span>
                  <span className="au2-what">
                    <b>{what(r)}</b>
                    <small className="mono">
                      {r.path ? `${r.method} ${r.path}` : ""}
                      {r.duration_sec && r.duration_sec > 0
                        ? ` · 在线 ${formatDuration(r.duration_sec)}`
                        : ""}
                    </small>
                  </span>
                  <span className="au2-res">
                    {r.resource ? (
                      <>
                        <em>{r.resource.type}</em>
                        <span>
                          {r.resource.name || r.resource.id || r.job || ""}
                        </span>
                      </>
                    ) : (
                      <span className="mono">{r.job || "—"}</span>
                    )}
                  </span>
                  <span className={`au2-st ${r.result || "ok"}`}>
                    {RESULT[r.result || "ok"]}
                    {r.status ? <small className="num">{r.status}</small> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="au-empty-wrap">
              <Empty
                description={
                  hasFilters
                    ? "当前筛选条件下没有匹配的操作记录"
                    : "选定时间范围内暂无操作记录"
                }
              />
              {hasFilters && (
                <Button size="small" onClick={clearFilters}>
                  清空筛选条件
                </Button>
              )}
            </div>
          )}

          {d && d.total > size && (
            <Pagination
              className="au-pager"
              total={d.total}
              pageSize={size}
              current={page}
              onChange={setPage}
              sizeCanChange={false}
              showTotal={false}
            />
          )}
        </section>
      ) : (
        <section key="sessions" className="au-panel">
          {sessErr && (
            <Alert
              type="error"
              showIcon
              className="au-alert"
              content={sessErr}
              action={
                <Button size="mini" onClick={() => setSessTick((n) => n + 1)}>
                  重试
                </Button>
              }
            />
          )}

          <div className="au-strip" aria-label="统计概况">
            <div className="au-stat">
              <span className="au-stat-k">
                <StatusDot
                  state={summary && summary.online_users > 0 ? "done" : "void"}
                />
                当前在线
              </span>
              <strong className="num">
                {summary ? `${summary.online_users} 人` : "—"}
              </strong>
              <small>{summary ? `${summary.active_sessions} 台设备` : ""}</small>
            </div>
            <div className="au-stat">
              <span className="au-stat-k">累计登录</span>
              <strong className="num">
                {summary ? `${num(summary.total_sessions)} 次` : "—"}
              </strong>
              <small>含在线与已结束会话</small>
            </div>
            <div className="au-stat">
              <span className="au-stat-k">平均在线时长</span>
              <strong>
                {summary ? formatDuration(summary.avg_duration_seconds) : "—"}
              </strong>
              <small>
                最长{" "}
                {summary ? formatDuration(summary.max_duration_seconds) : "—"}
              </small>
            </div>
            <div
              className={`au-stat ${(summary?.failed_logins || 0) > 0 ? "is-warn" : ""}`}
            >
              <span className="au-stat-k">异常尝试</span>
              <strong className="num">
                {summary ? `${summary.failed_logins} 次` : "—"}
              </strong>
              <small>密码错误或受限登录</small>
            </div>
          </div>

          <div className="au-split">
            <aside className="au-members" aria-label="按成员筛选">
              <div className="au-members-h">
                <span>成员概览</span>
                {user && (
                  <button
                    type="button"
                    className="au-link-btn"
                    onClick={() => setUser("")}
                  >
                    全部成员
                  </button>
                )}
              </div>
              {sessLoading && !sessResp ? (
                <div className="au-members-skel">
                  <Skeleton animation text={{ rows: 4 }} />
                </div>
              ) : sessResp && sessResp.by_user.length > 0 ? (
                <div className="au-member-list">
                  {sessResp.by_user.map((u) => {
                    const selected = user === u.user;
                    return (
                      <button
                        key={u.user}
                        type="button"
                        className={`au-member-item ${selected ? "on" : ""}`}
                        onClick={() =>
                          setUser((cur) => (cur === u.user ? "" : u.user))
                        }
                      >
                        <div className="au-member-top">
                          <span className="au-member-name">
                            <StatusDot state={u.online ? "done" : "void"} />
                            <b>{u.user}</b>
                          </span>
                          <span
                            className={`au-member-state ${u.online ? "ok" : ""}`}
                          >
                            {u.online ? `${u.active_sessions} 台在线` : "离线"}
                          </span>
                        </div>
                        <div className="au-member-meta num">
                          <span>
                            在线 {formatDuration(u.total_duration_seconds)}
                          </span>
                          <span>
                            活跃 {formatDuration(u.total_active_seconds)} ·{" "}
                            {u.login_count} 次
                            {u.failed_login_count > 0
                              ? ` · 失败 ${u.failed_login_count}`
                              : ""}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="au-members-empty">暂无成员统计</p>
              )}
            </aside>

            <div className="au-ledger">
              <div className="au-ledger-bar">
                <span className="au-count">
                  {sessResp
                    ? `共 ${num(sessResp.total)} 条登录会话`
                    : sessLoading
                      ? "正在载入…"
                      : ""}
                </span>
                {user && (
                  <button
                    type="button"
                    className="au-filter-pill"
                    onClick={() => setUser("")}
                  >
                    成员：{user} ×
                  </button>
                )}
              </div>

              {sessLoading && !sessResp ? (
                <div className="au-skel">
                  <Skeleton animation text={{ rows: 5 }} />
                </div>
              ) : sessResp && sessResp.rows.length > 0 ? (
                <div className="au2" role="table" aria-label="登录会话明细">
                  <div className="au2-row au2-shead au2-head" role="row">
                    <span>状态与设备</span>
                    <span>成员</span>
                    <span>时间跨度</span>
                    <span>在线与活跃</span>
                    <span>操作</span>
                  </div>
                  {sessResp.rows.map((s) => {
                    const meta = SESSION_REASON[s.end_reason] || [
                      s.end_reason || "已结束",
                      "mute",
                    ];
                    const tone = TONE_STATE[meta[1]] || "void";
                    const dev = browser(s.agent) || "未知客户端";
                    return (
                      <div
                        key={s.id}
                        role="button"
                        tabIndex={0}
                        className={`au2-row au2-srow ${sessDetail?.id === s.id ? "on" : ""}`}
                        onClick={() => setSessDetail(s)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSessDetail(s);
                          }
                        }}
                      >
                        <span className="au2-who">
                          <StatusBadge
                            state={tone}
                            label={`${meta[0]}${s.current ? " · 本机" : ""}`}
                          />
                          <small title={s.agent}>{dev}</small>
                        </span>
                        <span className="au2-who">
                          <b>{s.user}</b>
                          <small className="mono">
                            {s.role === "admin" ? "管理员" : "普通用户"}
                            {s.ip ? ` · ${s.ip}` : ""}
                          </small>
                        </span>
                        <span className="au2-what">
                          <b className="num">{stamp(s.created_at)}</b>
                          <small className="num">
                            {s.status === "active"
                              ? `最近活跃 ${stamp(s.last_active_at)}`
                              : `结束 ${stamp(s.ended_at || s.expires_at)}`}
                          </small>
                        </span>
                        <span className="au2-what">
                          <b className="num">
                            {formatDuration(s.duration_seconds)}
                          </b>
                          <small className="num">
                            活跃 {formatDuration(s.active_seconds)} ·{" "}
                            {s.requests} 次请求
                          </small>
                        </span>
                        <span
                          className="au2-sact"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {s.status === "active" &&
                          !s.current &&
                          canManageUsers ? (
                            <Popconfirm
                              title={`确认下线 ${s.user} 的该终端会话？`}
                              onOk={() => kickSession(s)}
                            >
                              <Button
                                size="mini"
                                status="danger"
                                icon={<IconPoweroff />}
                              >
                                下线
                              </Button>
                            </Popconfirm>
                          ) : null}
                          <button
                            type="button"
                            className="au-row-go"
                            aria-label={`查看 ${s.user} 的会话详情`}
                            onClick={() => setSessDetail(s)}
                          >
                            <IconRight />
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="au-empty-wrap">
                  <Empty
                    description={
                      hasFilters
                        ? "当前筛选条件下没有匹配的登录记录"
                        : "选定时间范围内暂无登录记录"
                    }
                  />
                  {hasFilters && (
                    <Button size="small" onClick={clearFilters}>
                      清空筛选条件
                    </Button>
                  )}
                </div>
              )}

              {sessResp && sessResp.total > size && (
                <Pagination
                  className="au-pager"
                  total={sessResp.total}
                  pageSize={size}
                  current={sessPage}
                  onChange={setSessPage}
                  sizeCanChange={false}
                  showTotal={false}
                />
              )}
            </div>
          </div>
        </section>
      )}

      <Drawer
        width={540}
        visible={!!open}
        onCancel={() => setOpen(null)}
        footer={null}
        title={open ? what(open) : ""}
        className="au-drawer"
      >
        {open && (
          <dl className="au-detail">
            <dt>时间</dt>
            <dd className="num">
              {stamp(open.time)}
              {open.ms !== undefined && open.ms > 0
                ? ` · 耗时 ${open.ms} ms`
                : ""}
            </dd>
            <dt>成员</dt>
            <dd>
              <b>{open.user || "—"}</b>
              {open.ip && <span className="mono"> · {open.ip}</span>}
              {open.agent && (
                <small title={open.agent}>{browser(open.agent)}</small>
              )}
            </dd>
            {open.session_id && (
              <>
                <dt>关联会话</dt>
                <dd>
                  <code className="mono">{open.session_id}</code>
                  <div className="au-detail-links">
                    <button
                      type="button"
                      className="iam-link"
                      onClick={() =>
                        traceSessionEvents(open.session_id!, {
                          user: open.user,
                        })
                      }
                    >
                      筛选本次会话操作
                    </button>
                    <button
                      type="button"
                      className="iam-link"
                      onClick={() => {
                        const sid = open.session_id!;
                        setOpen(null);
                        setTrace(null);
                        setQ(sid);
                        setTab("sessions");
                      }}
                    >
                      查看所属会话详情
                    </button>
                  </div>
                </dd>
              </>
            )}
            {open.duration_sec !== undefined && open.duration_sec > 0 && (
              <>
                <dt>累计在线</dt>
                <dd>{formatDuration(open.duration_sec)}</dd>
              </>
            )}
            <dt>对象资源</dt>
            <dd>
              {open.resource ? (
                <>
                  {open.resource.type}
                  {open.resource.name ? ` · ${open.resource.name}` : ""}
                  {open.resource.id &&
                    open.resource.id !== open.resource.name && (
                      <small className="mono">编号 {open.resource.id}</small>
                    )}
                </>
              ) : (
                open.job || "—"
              )}
            </dd>
            <dt>操作细节</dt>
            <dd>
              {what(open)}
              {open.action && open.action !== "http" && (
                <small className="mono">{open.action}</small>
              )}
              {open.path && (
                <small className="mono">
                  {open.method} {open.path}
                </small>
              )}
            </dd>
            {open.job && open.action !== "http" && (
              <>
                <dt>关联对象</dt>
                <dd className="mono">{open.job}</dd>
              </>
            )}
            <dt>请求摘要</dt>
            <dd>
              {open.request ? (
                <pre className="au-req mono">{pretty(open.request)}</pre>
              ) : (
                <span className="faint">无补充请求体</span>
              )}
            </dd>
            <dt>结果</dt>
            <dd>
              <span className={`au2-st ${open.result || "ok"}`}>
                {RESULT[open.result || "ok"]}
              </span>
              {open.status ? (
                <span className="num"> · HTTP {open.status}</span>
              ) : null}
              {open.error && <p className="au-err">{open.error}</p>}
            </dd>
          </dl>
        )}
      </Drawer>

      <Drawer
        width={520}
        visible={!!sessDetail}
        onCancel={() => setSessDetail(null)}
        footer={
          sessDetail ? (
            <div className="au-sdrawer-foot">
              <Button
                type="primary"
                onClick={() =>
                  traceSessionEvents(sessDetail.id, {
                    user: sessDetail.user,
                    createdAt: sessDetail.created_at,
                  })
                }
              >
                查看该会话操作记录
              </Button>
              {sessDetail.status === "active" &&
                !sessDetail.current &&
                canManageUsers && (
                  <Popconfirm
                    title={`确定强制下线 ${sessDetail.user} 的该终端？`}
                    onOk={() => kickSession(sessDetail)}
                  >
                    <Button status="danger" icon={<IconPoweroff />}>
                      强制下线
                    </Button>
                  </Popconfirm>
                )}
            </div>
          ) : null
        }
        title={sessDetail ? `${sessDetail.user} 的登录详情` : ""}
        className="au-drawer"
      >
        {sessDetail && (
          <dl className="au-detail">
            <dt>当前状态</dt>
            <dd>
              <StatusBadge
                state={
                  TONE_STATE[
                    (SESSION_REASON[sessDetail.end_reason] || ["", "mute"])[1]
                  ] || "void"
                }
                label={
                  (SESSION_REASON[sessDetail.end_reason] || [
                    sessDetail.end_reason,
                  ])[0]
                }
              />
              {sessDetail.current && <small>当前正在使用的会话</small>}
              {sessDetail.end_detail && <small>{sessDetail.end_detail}</small>}
            </dd>
            <dt>登录成员</dt>
            <dd>
              <b>{sessDetail.user}</b>
              <small>
                {sessDetail.role === "admin" ? "系统管理员" : "交付成员"}
              </small>
            </dd>
            <dt>登录时间</dt>
            <dd className="num">{stamp(sessDetail.created_at)}</dd>
            <dt>最近活跃</dt>
            <dd className="num">{stamp(sessDetail.last_active_at)}</dd>
            <dt>{sessDetail.status === "active" ? "计划过期" : "结束时间"}</dt>
            <dd className="num">
              {stamp(sessDetail.ended_at || sessDetail.expires_at)}
            </dd>
            <dt>总在线时长</dt>
            <dd className="num">
              {formatDuration(sessDetail.duration_seconds)}
            </dd>
            <dt>活跃与请求</dt>
            <dd className="num">
              活跃 {formatDuration(sessDetail.active_seconds)} · 累计{" "}
              {sessDetail.requests} 次请求
            </dd>
            <dt>设备与网络</dt>
            <dd>
              <span className="mono">{sessDetail.ip || "—"}</span>
              {sessDetail.agent && (
                <small title={sessDetail.agent}>
                  {browser(sessDetail.agent)} · {sessDetail.agent}
                </small>
              )}
            </dd>
            <dt>会话编号</dt>
            <dd className="mono">{sessDetail.id}</dd>
          </dl>
        )}
      </Drawer>
    </article>
  );
}

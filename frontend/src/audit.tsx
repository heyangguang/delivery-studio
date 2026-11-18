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
import { bi, biv, useLang, withLang } from "./i18n";
import "./aiusage.css";
import "./iam.css";

/* Platform audit log: operations history plus live session and online duration tracking. */

const ACTION_DATA: Record<string, [string, string, string, string]> = {
  login: ["登录", "账户", "Sign in", "Account"],
  "login-failed": ["登录失败", "账户", "Sign-in failed", "Account"],
  logout: ["退出登录", "账户", "Sign out", "Account"],
  "session-revoke": ["强制下线会话", "账户", "Revoke session", "Account"],
  "session-expired": ["会话超时结束", "账户", "Session expired", "Account"],
  "user-add": ["添加用户", "账户", "Create user", "Account"],
  "user-role": ["修改角色", "账户", "Change user role", "Account"],
  "user-password": ["重置密码", "账户", "Reset password", "Account"],
  "user-disable": ["停用账户", "账户", "Disable user", "Account"],
  "user-enable": ["启用账户", "账户", "Enable user", "Account"],
  "user-delete": ["删除账户", "账户", "Delete user", "Account"],
  "user-grant": ["分配角色和团队", "账户", "Assign roles & teams", "Account"],
  "user-deliveries-move": [
    "转交已删除账户的交付",
    "账户",
    "Transfer deleted user deliveries",
    "Account",
  ],
  "user-quota": ["调整账户存储额度", "账户", "Adjust user storage quota", "Account"],
  "job-create": ["创建交付", "交付", "Create delivery", "Delivery"],
  "job-revised": ["修订交付", "交付", "Revise delivery", "Delivery"],
  "job-sync": ["同步组件修复到交付", "交付", "Sync component fix to delivery", "Delivery"],
  "job-sync-keep": ["保留原组件版本", "交付", "Keep pinned component version", "Delivery"],
  "job-succeeded": ["交付生成成功", "交付", "Delivery build succeeded", "Delivery"],
  "job-failed": ["交付生成失败", "交付", "Delivery build failed", "Delivery"],
  "job-mark": ["标记交付结果", "交付", "Mark delivery outcome", "Delivery"],
  "job-delete": ["删除交付", "交付", "Delete delivery", "Delivery"],
  "job-progress-clear": ["清空执行记录", "交付", "Clear execution progress", "Delivery"],
  "job-download": ["下载完整交付包", "交付", "Download full delivery bundle", "Delivery"],
  "job-file-download": ["下载交付文件", "交付", "Download delivery file", "Delivery"],
  "job-download-runtime": ["下载运行环境清单", "交付", "Download runtime manifest", "Delivery"],
  "job-step": ["记录执行结果", "交付", "Record step result", "Delivery"],
  "job-runlogs": ["上传或写入执行日志", "交付", "Upload or write run logs", "Delivery"],
  "job-runlogs-delete": ["清理执行日志", "交付", "Clear run logs", "Delivery"],
  "execution-node-create": ["登记执行节点", "交付", "Register execution node", "Delivery"],
  "execution-node-disable": [
    "停用或启用执行节点",
    "交付",
    "Pause or resume execution node",
    "Delivery",
  ],
  "execution-node-delete": ["删除执行节点", "交付", "Delete execution node", "Delivery"],
  "execution-node-authorize": [
    "授权执行节点",
    "交付",
    "Authorize execution node",
    "Delivery",
  ],
  "execution-prepare": ["执行节点环境准备", "交付", "Run execution pre-checks", "Delivery"],
  "execution-create": ["发起自动执行", "交付", "Start automated execution", "Delivery"],
  "execution-pause": ["暂停自动执行", "交付", "Pause automated execution", "Delivery"],
  "execution-resume": ["恢复自动执行", "交付", "Resume automated execution", "Delivery"],
  "execution-close": ["关闭自动执行", "交付", "Close automated execution", "Delivery"],
  "target-agent-enroll": ["接入目标机 Agent", "交付", "Enroll target agent", "Delivery"],
  "target-agent-revoke": ["撤销目标机 Agent", "交付", "Revoke target agent", "Delivery"],
  "doc-section": ["编辑文档", "交付", "Edit document section", "Delivery"],
  "doc-draft": ["AI 起草文档", "交付", "AI draft document", "Delivery"],
  "doc-check": ["AI 检查文档", "交付", "AI review document", "Delivery"],
  "doc-export": ["导出文档", "交付", "Export document", "Delivery"],
  "doc-rca": ["发起根因分析", "交付", "Start root-cause analysis", "Delivery"],
  "doc-rca-delete": ["删除根因分析或评估", "交付", "Delete RCA or assessment", "Delivery"],
  "doc-assess": ["新建评估", "交付", "Create assessment", "Delivery"],
  "rehearsal-create": ["发起变更演练", "AI", "Start change rehearsal", "AI"],
  "rehearsal-scope": ["更新变更影响评估", "AI", "Update change impact scope", "AI"],
  "rehearsal-probe": ["解析变更采集探针", "AI", "Parse change probe", "AI"],
  "rehearsal-step": ["调整变更演练步骤", "交付", "Update rehearsal step", "Delivery"],
  "rehearsal-troubleshoot": ["AI 排障修正演练步骤", "AI", "AI troubleshoot rehearsal step", "AI"],
  "rehearsal-apply": ["应用变更演练修正建议", "AI", "Apply rehearsal fix proposal", "AI"],
  "rehearsal-finalize": ["定稿生产变更实施方案", "交付", "Finalize production change plan", "Delivery"],
  "rehearsal-delete": ["删除变更演练", "交付", "Delete change rehearsal", "Delivery"],
  "report-settings": ["修改交付文档设置", "设置", "Update report settings", "Settings"],
  "report-template": ["上传 Word 模板", "设置", "Upload Word template", "Settings"],
  "report-template-delete": ["删除 Word 模板", "设置", "Delete Word template", "Settings"],
  "report-banner": ["上传交付文档横幅", "设置", "Upload report cover banner", "Settings"],
  "report-banner-delete": ["删除交付文档横幅", "设置", "Delete report cover banner", "Settings"],
  "component-draft-start": ["开始编辑组件", "组件", "Start editing component", "Components"],
  "component-draft-drop": ["放弃组件草稿", "组件", "Discard component draft", "Components"],
  "component-publish": ["发布组件", "组件", "Publish component", "Components"],
  "component-restore": ["恢复组件修订", "组件", "Restore component revision", "Components"],
  "component-import": ["导入组件", "组件", "Import component", "Components"],
  "component-delete": ["删除组件", "组件", "Delete component", "Components"],
  "component-warning-ignore": [
    "忽略组件检查告警",
    "组件",
    "Ignore component check warning",
    "Components",
  ],
  "component-version-status": [
    "调整组件版本状态",
    "组件",
    "Change component version status",
    "Components",
  ],
  "library-fetch": ["下载软件包", "软件库", "Fetch software packages", "Software Library"],
  "library-delete": ["删除软件包", "软件库", "Delete software packages", "Software Library"],
  "library-import": ["导入软件包", "软件库", "Import software packages", "Software Library"],
  "library-sources": ["修改软件源", "软件库", "Update package sources", "Software Library"],
  "library-index-update": [
    "更新软件源索引",
    "软件库",
    "Update repository index",
    "Software Library",
  ],
  "library-index-import": [
    "导入软件源索引",
    "软件库",
    "Import repository index",
    "Software Library",
  ],
  "python-runtime-build": [
    "构建 Ansible 运行环境",
    "软件库",
    "Build Ansible runtime",
    "Software Library",
  ],
  "python-runtime-default": [
    "设置默认运行环境",
    "软件库",
    "Set default runtime",
    "Software Library",
  ],
  "python-runtime-import": ["导入运行环境", "软件库", "Import runtime", "Software Library"],
  "notify-channel": ["保存通知渠道", "通知", "Save notification channel", "Notifications"],
  "notify-channel-delete": [
    "删除通知渠道",
    "通知",
    "Delete notification channel",
    "Notifications",
  ],
  "notify-template": ["修改通知模板", "通知", "Update notification template", "Notifications"],
  "ai-toggle": ["切换 AI 套件开关", "AI", "Toggle AI suite", "AI"],
  "ai-settings": ["修改 AI 设置", "AI", "Update AI settings", "AI"],
  "ai-provider": ["保存模型供应商", "AI", "Save model provider", "AI"],
  "ai-provider-delete": ["删除模型供应商", "AI", "Delete model provider", "AI"],
  "ai-resolve": ["AI 排障记录写入执行记录", "AI", "Save AI fix to run log", "AI"],
  "ai-proposal-accept": ["采纳 AI 提案", "AI", "Accept AI proposal", "AI"],
  "ai-proposal-reject": ["拒绝 AI 提案", "AI", "Reject AI proposal", "AI"],
  "ai-amendment-withdraw": ["撤销 AI 补充", "AI", "Withdraw AI amendment", "AI"],
  "ai-component-proposal": [
    "处理组件 AI 提案",
    "AI",
    "Handle component AI proposal",
    "AI",
  ],
  "ai-chat": ["AI 对话", "AI", "AI chat", "AI"],
  "ai-fill": ["AI 智能填表", "AI", "AI smart fill", "AI"],
  "ai-prices": ["修改模型价格", "AI", "Update model pricing", "AI"],
  "ai-skills": ["修改 AI 技能", "AI", "Update AI skills", "AI"],
  "ai-skill-script": ["查看或导出技能脚本", "AI", "View or export skill script", "AI"],
  "ai-mcp": ["保存 MCP 服务", "AI", "Save MCP server", "AI"],
  "ai-mcp-delete": ["移除 MCP 服务", "AI", "Remove MCP server", "AI"],
  "ai-web": ["修改联网搜索", "AI", "Update web search", "AI"],
  "ai-user-mcp": ["个人 MCP 开关", "AI", "Toggle personal MCP", "AI"],
  "ai-sandbox-run": ["AI 在沙箱里运行代码", "AI", "Run AI code in sandbox", "AI"],
  "ai-sandbox-shell": ["在隔离沙箱执行命令", "AI", "Run shell command in sandbox", "AI"],
  "sandbox-settings": ["修改代码沙箱设置", "平台", "Update code sandbox settings", "Platform"],
  "sandbox-check": ["检测代码沙箱", "平台", "Run sandbox self-check", "Platform"],
  "storage-settings": ["修改存储空间设置", "平台", "Update storage settings", "Platform"],
  "me-password": ["修改自己的密码", "账户", "Change own password", "Account"],
  "me-password-failed": [
    "改密码时当前密码错误",
    "账户",
    "Password change failed (wrong current password)",
    "Account",
  ],
  "me-skills": ["修改我的技能", "AI", "Update personal skills", "AI"],
  "me-mcp": ["保存我的 MCP 服务", "AI", "Save personal MCP server", "AI"],
  "me-mcp-delete": ["移除我的 MCP 服务", "AI", "Remove personal MCP server", "AI"],
  "me-kb": ["更新知识库资料", "AI", "Update personal KB material", "AI"],
  "me-kb-delete": ["删除知识库资料", "AI", "Delete personal KB material", "AI"],
  "me-files-upload": ["上传文件到我的资料", "AI", "Upload to My Files", "AI"],
  "me-files-add": ["新建资料或文件夹", "AI", "Create file or folder", "AI"],
  "me-files-edit": ["修改资料", "AI", "Edit personal file", "AI"],
  "me-files-move": ["重命名或移动资料", "AI", "Rename or move file", "AI"],
  "me-files-delete": ["删除资料", "AI", "Delete personal file", "AI"],
  "me-files-download": ["下载我的文件", "AI", "Download personal file", "AI"],
  "me-ai-prefs": ["修改 AI 个性化设置", "AI", "Update AI preferences", "AI"],
  "me-ai-memory-clear": ["清空 AI 记忆", "AI", "Clear AI memory", "AI"],
  "ai-chat-archive": ["归档 AI 对话", "AI", "Archive AI chat", "AI"],
  "ai-chat-unarchive": ["取消归档 AI 对话", "AI", "Unarchive AI chat", "AI"],
  "iam-role-add": ["新建角色", "IAM", "Create role", "IAM"],
  "iam-role-edit": ["修改角色", "IAM", "Edit role", "IAM"],
  "iam-role-delete": ["删除角色", "IAM", "Delete role", "IAM"],
  "iam-team-add": ["新建团队", "IAM", "Create team", "IAM"],
  "iam-team-edit": ["修改团队", "IAM", "Edit team", "IAM"],
  "iam-team-delete": ["删除团队", "IAM", "Delete team", "IAM"],
  "audit-export": ["导出操作审计", "IAM", "Export audit log", "IAM"],
  "audit-sessions-export": [
    "导出登录与在线记录",
    "IAM",
    "Export session audit log",
    "IAM",
  ],
  "kb-submit": ["提交到团队知识库", "知识库", "Submit to team KB", "Knowledge Base"],
  "kb-approve": ["审核通过资料", "知识库", "Approve KB submission", "Knowledge Base"],
  "kb-reject": ["退回资料", "知识库", "Reject KB submission", "Knowledge Base"],
  "kb-edit": ["编辑团队资料", "知识库", "Edit team KB article", "Knowledge Base"],
  "kb-delete": ["删除团队资料", "知识库", "Delete team KB article", "Knowledge Base"],
};

const actionEntry = (a: string): [string, string] | undefined => {
  const e = ACTION_DATA[a];
  return e ? [bi(e[0], e[2]), bi(e[1], e[3])] : undefined;
};
export const auditLabel = (a: string) => actionEntry(a)?.[0] || a;

const RESOURCE_EN: Record<string, string> = {
  交付: "Delivery",
  用户: "User",
  角色: "Role",
  团队: "Team",
  已删除的用户: "Deleted User",
  组件: "Component",
  运行环境: "Runtime",
  软件库: "Software Library",
  变更演练: "Change Rehearsal",
  集群: "Cluster",
  "MCP 服务": "MCP Server",
  "AI 用量": "AI Usage",
  "AI 设置": "AI Settings",
  执行节点: "Execution Node",
  沙箱设置: "Sandbox Settings",
  存储设置: "Storage Settings",
  交付文档设置: "Report Settings",
  通知设置: "Notification Settings",
  "AI 对话": "AI Chat",
  AI: "AI",
  知识库提交: "KB Submission",
  团队知识库: "Team KB",
  我的知识库: "My KB",
  我的会话: "My Sessions",
  我的账户: "My Account",
  会话审计: "Session Audit",
  操作审计: "Audit Log",
  部署规格: "Deploy Spec",
  登录: "Sign-in",
  其他: "Other",
};
const resourceLabel = (t?: string) => (t ? bi(t, RESOURCE_EN[t] || t) : "");

const VERB: Record<string, string> = {
  get POST() {
    return bi("提交", "Submit");
  },
  get PUT() {
    return bi("修改", "Update");
  },
  get PATCH() {
    return bi("修改", "Update");
  },
  get DELETE() {
    return bi("删除", "Delete");
  },
  get GET() {
    return bi("读取", "Read");
  },
  get HEAD() {
    return bi("读取", "Read");
  },
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
  get ok() {
    return bi("成功", "OK");
  },
  get denied() {
    return bi("被拒绝", "Denied");
  },
  get failed() {
    return bi("未通过", "Failed");
  },
  get error() {
    return bi("出错", "Error");
  },
};

export const SESSION_REASON: Record<string, [string, string]> = {
  get active(): [string, string] {
    return [bi("在线", "Online"), "ok"];
  },
  get logout(): [string, string] {
    return [bi("已退出", "Signed out"), "mute"];
  },
  get expired(): [string, string] {
    return [bi("已超时", "Expired"), "warn"];
  },
  get revoked(): [string, string] {
    return [bi("已下线", "Revoked"), "bad"];
  },
  get "password-changed"(): [string, string] {
    return [bi("改密失效", "Password changed"), "warn"];
  },
  get disabled(): [string, string] {
    return [bi("账户停用", "Disabled"), "bad"];
  },
  get deleted(): [string, string] {
    return [bi("账户移除", "Deleted"), "bad"];
  },
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
    : `${VERB[r.method || ""] || r.method || bi("请求", "Request")}${r.resource?.type ? ` ${resourceLabel(r.resource.type)}` : ""}`;

const what = (r: Row) =>
  r.action && r.action !== "http"
    ? auditLabel(r.action)
    : `${VERB[r.method || ""] || r.method || bi("请求", "Request")}${r.resource?.type ? ` ${resourceLabel(r.resource.type)}` : ""}`;

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
  useLang();
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
          setError((e as Error).message || bi("加载操作记录失败", "Failed to load audit events"));
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
          setSessErr((e as Error).message || bi("加载会话记录失败", "Failed to load session records"));
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
      Message.success(
        bi(`已下线 ${row.user} 的会话`, `Revoked session for ${row.user}`),
      );
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
    const g =
      a === "http"
        ? bi("其他", "Other")
        : actionEntry(a)?.[1] || bi("其他", "Other");
    groups.set(g, [
      ...(groups.get(g) || []),
      {
        value: a,
        label: bi(
          `${a === "http" ? "其他请求" : auditLabel(a)}（${d!.actions[a]}）`,
          `${a === "http" ? "Other Requests" : auditLabel(a)} (${d!.actions[a]})`,
        ),
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
          <h1>{bi("操作审计", "Audit Log")}</h1>
          <p>
            {bi(
              "按时间、成员与资源检索操作记录，查看终端登录与在线时长。",
              "Search activity by time, user, and resource; track sign-in sessions and active durations.",
            )}
          </p>
        </div>
        <div className="au-head-acts">
          <Segmented
            size="md"
            label={bi("审计视图", "Audit view")}
            value={tab}
            onChange={switchTab}
            options={[
              { value: "events", label: bi("操作记录", "Activity") },
              {
                value: "sessions",
                label: bi("登录与在线", "Sessions"),
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
            aria-label={bi("刷新当前列表", "Refresh list")}
          >
            {bi("刷新", "Refresh")}
          </Button>
          <Button
            icon={<IconDownload />}
            href={withLang(
              tab === "events"
                ? `/api/audit/export?${params()}`
                : `/api/audit/sessions/export?${sessParams()}`,
            )}
          >
            {bi("导出表格", "Export CSV")}
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
              ? bi(
                  "当前处于离线状态，恢复连接后可继续加载或刷新最新审计记录。",
                  "You are offline. Refresh once connectivity is restored to load the latest audit logs.",
                )
              : bi(
                  "暂无法连接到平台服务，请检查服务状态后重试。",
                  "Unable to reach the platform service. Check service status and retry.",
                )
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
              {bi("重新检测", "Retry")}
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
              {bi("清空筛选", "Clear Filters")}
            </Button>
          )}
        </div>
        <div className="au-row">
          <Input
            allowClear
            prefix={<IconSearch />}
            placeholder={
              tab === "events"
                ? bi(
                    "搜索成员、资源、路径或请求内容",
                    "Search user, resource, path, or payload",
                  )
                : bi(
                    "搜索成员、设备、IP 或会话编号",
                    "Search user, device, IP, or session ID",
                  )
            }
            value={q}
            onChange={(val) => {
              setQ(val);
              if (trace && val !== trace.sid) setTrace(null);
            }}
            style={{ width: 260 }}
            aria-label={bi("搜索", "Search")}
          />
          <Select
            allowClear
            placeholder={bi("成员", "User")}
            value={user || undefined}
            onChange={(v) => setUser(v || "")}
            options={allUsers.map((u) => ({ value: u, label: u }))}
            style={{ width: 136 }}
            aria-label={bi("按成员筛选", "Filter by user")}
          />
          {tab === "events" ? (
            <>
              <Select
                allowClear
                placeholder={bi("资源", "Resource")}
                value={kind || undefined}
                onChange={(v) => setKind(v || "")}
                options={Object.entries(d?.resources || {}).map(([k, n]) => ({
                  value: k,
                  label: bi(`${k}（${n}）`, `${resourceLabel(k)} (${n})`),
                }))}
                style={{ width: 152 }}
                aria-label={bi("按资源筛选", "Filter by resource")}
              />
              <Select
                allowClear
                showSearch
                placeholder={bi("操作类型", "Action")}
                value={action || undefined}
                onChange={(v) => setAction(v || "")}
                style={{ width: 204 }}
                aria-label={bi("按操作类型筛选", "Filter by action")}
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
                placeholder={bi("结果", "Result")}
                value={result || undefined}
                onChange={(v) => setResult(v || "")}
                options={Object.entries(RESULT).map(([k, v]) => ({
                  value: k,
                  label: v,
                }))}
                style={{ width: 108 }}
                aria-label={bi("按结果筛选", "Filter by result")}
              />
            </>
          ) : (
            <Select
              allowClear
              placeholder={bi("会话状态", "Session Status")}
              value={sessStatus || undefined}
              onChange={(v) => setSessStatus(v || "")}
              options={[
                { value: "active", label: bi("当前在线", "Active Now") },
                { value: "closed", label: bi("已结束", "Ended") },
                { value: "logout", label: bi("主动退出", "Signed Out") },
                { value: "expired", label: bi("超时结束", "Expired") },
                { value: "revoked", label: bi("强制下线", "Revoked") },
                {
                  value: "password-changed",
                  label: bi("改密失效", "Password Changed"),
                },
              ]}
              style={{ width: 150 }}
              aria-label={bi("按会话状态筛选", "Filter by session status")}
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
                  {biv(
                    <>
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
                    </>,
                    <>
                      Showing activity for{" "}
                      {trace.user ? (
                        <>
                          <b>{trace.user}</b>&apos;s{" "}
                        </>
                      ) : (
                        "this "
                      )}
                      session
                      {trace.createdAt
                        ? ` (signed in ${stamp(trace.createdAt)})`
                        : ""}
                    </>,
                  )}
                </span>
              </div>
              <div className="au-trace-acts">
                <Button
                  size="small"
                  icon={<IconArrowLeft />}
                  onClick={returnToSessions}
                >
                  {bi("返回登录与在线", "Back to Sessions")}
                </Button>
                <Button size="small" type="text" onClick={clearTrace}>
                  {bi("查看全部记录", "Show All Events")}
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
                  {bi("重试", "Retry")}
                </Button>
              }
            />
          )}

          <div className="au-count">
            {d
              ? bi(
                  `共 ${num(d.total)} 条记录`,
                  `${num(d.total)} ${d.total === 1 ? "event" : "events"}`,
                )
              : evLoading
                ? bi("正在载入…", "Loading…")
                : ""}
          </div>

          {evLoading && !d ? (
            <div className="au-skel">
              <Skeleton animation text={{ rows: 6 }} />
            </div>
          ) : d && d.rows.length > 0 ? (
            <div
              className="au2"
              role="table"
              aria-label={bi("操作记录明细", "Audit events table")}
            >
              <div className="au2-row au2-head" role="row">
                <span>{bi("时间", "Time")}</span>
                <span>{bi("成员", "User")}</span>
                <span>{bi("操作内容", "Action")}</span>
                <span>{bi("对象资源", "Resource")}</span>
                <span>{bi("结果", "Result")}</span>
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
                      {r.ip ||
                        (r.user === "system" ? bi("系统自动", "System") : "")}
                    </small>
                  </span>
                  <span className="au2-what">
                    <b>{what(r)}</b>
                    <small className="mono">
                      {r.path ? `${r.method} ${r.path}` : ""}
                      {r.duration_sec && r.duration_sec > 0
                        ? bi(
                            ` · 在线 ${formatDuration(r.duration_sec)}`,
                            ` · online ${formatDuration(r.duration_sec)}`,
                          )
                        : ""}
                    </small>
                  </span>
                  <span className="au2-res">
                    {r.resource ? (
                      <>
                        <em>{resourceLabel(r.resource.type)}</em>
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
                    ? bi(
                        "当前筛选条件下没有匹配的操作记录",
                        "No activity records match the current filters",
                      )
                    : bi(
                        "选定时间范围内暂无操作记录",
                        "No activity records in the selected time range",
                      )
                }
              />
              {hasFilters && (
                <Button size="small" onClick={clearFilters}>
                  {bi("清空筛选条件", "Clear Filters")}
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
                  {bi("重试", "Retry")}
                </Button>
              }
            />
          )}

          <div
            className="au-strip"
            aria-label={bi("统计概况", "Session summary")}
          >
            <div className="au-stat">
              <span className="au-stat-k">
                <StatusDot
                  state={summary && summary.online_users > 0 ? "done" : "void"}
                />
                {bi("当前在线", "Online Now")}
              </span>
              <strong className="num">
                {summary
                  ? bi(
                      `${summary.online_users} 人`,
                      `${summary.online_users} ${summary.online_users === 1 ? "user" : "users"}`,
                    )
                  : "—"}
              </strong>
              <small>
                {summary
                  ? bi(
                      `${summary.active_sessions} 台设备`,
                      `${summary.active_sessions} ${summary.active_sessions === 1 ? "device" : "devices"}`,
                    )
                  : ""}
              </small>
            </div>
            <div className="au-stat">
              <span className="au-stat-k">{bi("累计登录", "Total Sign-ins")}</span>
              <strong className="num">
                {summary
                  ? bi(
                      `${num(summary.total_sessions)} 次`,
                      `${num(summary.total_sessions)} ${summary.total_sessions === 1 ? "session" : "sessions"}`,
                    )
                  : "—"}
              </strong>
              <small>
                {bi("含在线与已结束会话", "Includes active & ended sessions")}
              </small>
            </div>
            <div className="au-stat">
              <span className="au-stat-k">
                {bi("平均在线时长", "Avg Session Duration")}
              </span>
              <strong>
                {summary ? formatDuration(summary.avg_duration_seconds) : "—"}
              </strong>
              <small>
                {bi("最长", "Max")}{" "}
                {summary ? formatDuration(summary.max_duration_seconds) : "—"}
              </small>
            </div>
            <div
              className={`au-stat ${(summary?.failed_logins || 0) > 0 ? "is-warn" : ""}`}
            >
              <span className="au-stat-k">
                {bi("异常尝试", "Failed Attempts")}
              </span>
              <strong className="num">
                {summary
                  ? bi(
                      `${summary.failed_logins} 次`,
                      `${summary.failed_logins}`,
                    )
                  : "—"}
              </strong>
              <small>
                {bi(
                  "密码错误或受限登录",
                  "Wrong password or restricted sign-in",
                )}
              </small>
            </div>
          </div>

          <div className="au-split">
            <aside
              className="au-members"
              aria-label={bi("按成员筛选", "Filter by user")}
            >
              <div className="au-members-h">
                <span>{bi("成员概览", "Users")}</span>
                {user && (
                  <button
                    type="button"
                    className="au-link-btn"
                    onClick={() => setUser("")}
                  >
                    {bi("全部成员", "All Users")}
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
                            {u.online
                              ? bi(
                                  `${u.active_sessions} 台在线`,
                                  `${u.active_sessions} online`,
                                )
                              : bi("离线", "Offline")}
                          </span>
                        </div>
                        <div className="au-member-meta num">
                          <span>
                            {bi("在线", "Online")}{" "}
                            {formatDuration(u.total_duration_seconds)}
                          </span>
                          <span>
                            {bi("活跃", "Active")}{" "}
                            {formatDuration(u.total_active_seconds)} ·{" "}
                            {bi(
                              `${u.login_count} 次`,
                              `${u.login_count} ${u.login_count === 1 ? "login" : "logins"}`,
                            )}
                            {u.failed_login_count > 0
                              ? bi(
                                  ` · 失败 ${u.failed_login_count}`,
                                  ` · ${u.failed_login_count} failed`,
                                )
                              : ""}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="au-members-empty">
                  {bi("暂无成员统计", "No user stats")}
                </p>
              )}
            </aside>

            <div className="au-ledger">
              <div className="au-ledger-bar">
                <span className="au-count">
                  {sessResp
                    ? bi(
                        `共 ${num(sessResp.total)} 条登录会话`,
                        `${num(sessResp.total)} ${sessResp.total === 1 ? "session" : "sessions"}`,
                      )
                    : sessLoading
                      ? bi("正在载入…", "Loading…")
                      : ""}
                </span>
                {user && (
                  <button
                    type="button"
                    className="au-filter-pill"
                    onClick={() => setUser("")}
                  >
                    {bi("成员：", "User: ")}
                    {user} ×
                  </button>
                )}
              </div>

              {sessLoading && !sessResp ? (
                <div className="au-skel">
                  <Skeleton animation text={{ rows: 5 }} />
                </div>
              ) : sessResp && sessResp.rows.length > 0 ? (
                <div
                  className="au2"
                  role="table"
                  aria-label={bi("登录会话明细", "Sessions table")}
                >
                  <div className="au2-row au2-shead au2-head" role="row">
                    <span>{bi("状态与设备", "Status & Device")}</span>
                    <span>{bi("成员", "User")}</span>
                    <span>{bi("时间跨度", "Time Span")}</span>
                    <span>{bi("在线与活跃", "Duration & Activity")}</span>
                    <span>{bi("操作", "Actions")}</span>
                  </div>
                  {sessResp.rows.map((s) => {
                    const meta = SESSION_REASON[s.end_reason] || [
                      s.end_reason || bi("已结束", "Ended"),
                      "mute",
                    ];
                    const tone = TONE_STATE[meta[1]] || "void";
                    const dev =
                      browser(s.agent) || bi("未知客户端", "Unknown Client");
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
                            label={`${meta[0]}${s.current ? bi(" · 本机", " · This device") : ""}`}
                          />
                          <small title={s.agent}>{dev}</small>
                        </span>
                        <span className="au2-who">
                          <b>{s.user}</b>
                          <small className="mono">
                            {s.role === "admin"
                              ? bi("管理员", "Admin")
                              : bi("普通用户", "User")}
                            {s.ip ? ` · ${s.ip}` : ""}
                          </small>
                        </span>
                        <span className="au2-what">
                          <b className="num">{stamp(s.created_at)}</b>
                          <small className="num">
                            {s.status === "active"
                              ? bi(
                                  `最近活跃 ${stamp(s.last_active_at)}`,
                                  `Last active ${stamp(s.last_active_at)}`,
                                )
                              : bi(
                                  `结束 ${stamp(s.ended_at || s.expires_at)}`,
                                  `Ended ${stamp(s.ended_at || s.expires_at)}`,
                                )}
                          </small>
                        </span>
                        <span className="au2-what">
                          <b className="num">
                            {formatDuration(s.duration_seconds)}
                          </b>
                          <small className="num">
                            {bi("活跃", "Active")}{" "}
                            {formatDuration(s.active_seconds)} ·{" "}
                            {bi(
                              `${s.requests} 次请求`,
                              `${s.requests} ${s.requests === 1 ? "req" : "reqs"}`,
                            )}
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
                              title={bi(
                                `确认下线 ${s.user} 的该终端会话？`,
                                `Revoke this session for ${s.user}?`,
                              )}
                              onOk={() => kickSession(s)}
                            >
                              <Button
                                size="mini"
                                status="danger"
                                icon={<IconPoweroff />}
                              >
                                {bi("下线", "Revoke")}
                              </Button>
                            </Popconfirm>
                          ) : null}
                          <button
                            type="button"
                            className="au-row-go"
                            aria-label={bi(
                              `查看 ${s.user} 的会话详情`,
                              `View session details for ${s.user}`,
                            )}
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
                        ? bi(
                            "当前筛选条件下没有匹配的登录记录",
                            "No session records match the current filters",
                          )
                        : bi(
                            "选定时间范围内暂无登录记录",
                            "No session records in the selected time range",
                          )
                    }
                  />
                  {hasFilters && (
                    <Button size="small" onClick={clearFilters}>
                      {bi("清空筛选条件", "Clear Filters")}
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
            <dt>{bi("时间", "Time")}</dt>
            <dd className="num">
              {stamp(open.time)}
              {open.ms !== undefined && open.ms > 0
                ? bi(` · 耗时 ${open.ms} ms`, ` · ${open.ms} ms`)
                : ""}
            </dd>
            <dt>{bi("成员", "User")}</dt>
            <dd>
              <b>{open.user || "—"}</b>
              {open.ip && <span className="mono"> · {open.ip}</span>}
              {open.agent && (
                <small title={open.agent}>{browser(open.agent)}</small>
              )}
            </dd>
            {open.session_id && (
              <>
                <dt>{bi("关联会话", "Session")}</dt>
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
                      {bi("筛选本次会话操作", "Filter session activity")}
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
                      {bi("查看所属会话详情", "View session details")}
                    </button>
                  </div>
                </dd>
              </>
            )}
            {open.duration_sec !== undefined && open.duration_sec > 0 && (
              <>
                <dt>{bi("累计在线", "Online Duration")}</dt>
                <dd>{formatDuration(open.duration_sec)}</dd>
              </>
            )}
            <dt>{bi("对象资源", "Resource")}</dt>
            <dd>
              {open.resource ? (
                <>
                  {resourceLabel(open.resource.type)}
                  {open.resource.name ? ` · ${open.resource.name}` : ""}
                  {open.resource.id &&
                    open.resource.id !== open.resource.name && (
                      <small className="mono">
                        {bi("编号", "ID")} {open.resource.id}
                      </small>
                    )}
                </>
              ) : (
                open.job || "—"
              )}
            </dd>
            <dt>{bi("操作细节", "Action Details")}</dt>
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
                <dt>{bi("关联对象", "Target")}</dt>
                <dd className="mono">{open.job}</dd>
              </>
            )}
            <dt>{bi("请求摘要", "Request Payload")}</dt>
            <dd>
              {open.request ? (
                <pre className="au-req mono">{pretty(open.request)}</pre>
              ) : (
                <span className="faint">
                  {bi("无补充请求体", "No request body")}
                </span>
              )}
            </dd>
            <dt>{bi("结果", "Result")}</dt>
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
                {bi("查看该会话操作记录", "View Session Activity")}
              </Button>
              {sessDetail.status === "active" &&
                !sessDetail.current &&
                canManageUsers && (
                  <Popconfirm
                    title={bi(
                      `确定强制下线 ${sessDetail.user} 的该终端？`,
                      `Force sign-out this device for ${sessDetail.user}?`,
                    )}
                    onOk={() => kickSession(sessDetail)}
                  >
                    <Button status="danger" icon={<IconPoweroff />}>
                      {bi("强制下线", "Revoke Session")}
                    </Button>
                  </Popconfirm>
                )}
            </div>
          ) : null
        }
        title={
          sessDetail
            ? bi(
                `${sessDetail.user} 的登录详情`,
                `Session Details · ${sessDetail.user}`,
              )
            : ""
        }
        className="au-drawer"
      >
        {sessDetail && (
          <dl className="au-detail">
            <dt>{bi("当前状态", "Status")}</dt>
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
              {sessDetail.current && (
                <small>{bi("当前正在使用的会话", "Current active session")}</small>
              )}
              {sessDetail.end_detail && <small>{sessDetail.end_detail}</small>}
            </dd>
            <dt>{bi("登录成员", "User")}</dt>
            <dd>
              <b>{sessDetail.user}</b>
              <small>
                {sessDetail.role === "admin"
                  ? bi("系统管理员", "System Admin")
                  : bi("交付成员", "Delivery Member")}
              </small>
            </dd>
            <dt>{bi("登录时间", "Signed In")}</dt>
            <dd className="num">{stamp(sessDetail.created_at)}</dd>
            <dt>{bi("最近活跃", "Last Active")}</dt>
            <dd className="num">{stamp(sessDetail.last_active_at)}</dd>
            <dt>
              {sessDetail.status === "active"
                ? bi("计划过期", "Expires At")
                : bi("结束时间", "Ended At")}
            </dt>
            <dd className="num">
              {stamp(sessDetail.ended_at || sessDetail.expires_at)}
            </dd>
            <dt>{bi("总在线时长", "Total Duration")}</dt>
            <dd className="num">
              {formatDuration(sessDetail.duration_seconds)}
            </dd>
            <dt>{bi("活跃与请求", "Activity & Requests")}</dt>
            <dd className="num">
              {bi("活跃", "Active")} {formatDuration(sessDetail.active_seconds)}{" "}
              ·{" "}
              {bi(
                `累计 ${sessDetail.requests} 次请求`,
                `${sessDetail.requests} ${sessDetail.requests === 1 ? "request" : "requests"}`,
              )}
            </dd>
            <dt>{bi("设备与网络", "Device & Network")}</dt>
            <dd>
              <span className="mono">{sessDetail.ip || "—"}</span>
              {sessDetail.agent && (
                <small title={sessDetail.agent}>
                  {browser(sessDetail.agent)} · {sessDetail.agent}
                </small>
              )}
            </dd>
            <dt>{bi("会话编号", "Session ID")}</dt>
            <dd className="mono">{sessDetail.id}</dd>
          </dl>
        )}
      </Drawer>
    </article>
  );
}

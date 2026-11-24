import React, { useEffect, useMemo, useState } from "react";
import {
  Button,
  Input,
  Message,
  Modal,
  Skeleton,
  Switch,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconDelete,
  IconEdit,
  IconExclamationCircle,
  IconLink,
  IconPlus,
  IconRefresh,
  IconSearch,
} from "@arco-design/web-react/icon";
import {
  ago,
  api,
  cached,
  can,
  err,
  fullTime,
  putCached,
  useMedia,
} from "./shared";
import { go } from "./router";
import { Segmented } from "./ui";
import { bi, useLang } from "./i18n";
import "./respage.css";

/* Outside services the assistant can call (MCP over HTTP): the platform's, kept by those with AI settings, and each
   person's own, which only offer tools that declare they change nothing. */

type Tool = { name: string; description?: string; read_only: boolean };
type Server = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  token_enc?: string;
  allow_write: boolean;
  tools: Tool[] | null;
  disabled_tools?: string[];
  checked?: string;
  error?: string;
  server_name?: string;
  tool_count?: number;
  mine?: boolean;
  brief?: boolean;
};
type Kind = "all" | "mine" | "platform";
type Edit = {
  id?: string;
  mine: boolean;
  name: string;
  url: string;
  token: string;
  token_enc?: string;
  enabled: boolean;
  allow_write: boolean;
};

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

export function MCPPage({
  selected,
  studioNav,
}: {
  selected?: string;
  studioNav?: React.ReactNode;
}) {
  useLang();
  const narrow = useMedia("(max-width: 900px)");
  const admin = can("ai.settings");
  const initMe = cached<{ servers: Server[] }>("/api/me/mcp");
  const initPlat = cached<Server[]>("/api/mcp#platform");
  const initInfo = cached<{ user_mcp: boolean }>("/api/me");
  const [mine, setMine] = useState<Server[] | null>(() =>
    initMe ? initMe.servers.map((x) => ({ ...x, mine: true })) : null,
  );
  const [platform, setPlatform] = useState<Server[]>(() => initPlat ?? []);
  const [allowMine, setAllowMine] = useState(() => initInfo?.user_mcp ?? true);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [busy, setBusy] = useState("");

  const load = () =>
    Promise.all([
      api<{ servers: Server[] }>("/api/me/mcp"),
      admin
        ? api<{ servers: Server[] }>("/api/settings/ai/mcp").then(
            (r) => r.servers,
          )
        : api<{
            mcp: { id: string; name: string; tools: number; mine?: boolean }[];
          }>("/api/ai/options").then((r) =>
            r.mcp
              .filter((m) => !m.mine)
              .map(
                (m) =>
                  ({
                    id: m.id,
                    name: m.name,
                    url: "",
                    enabled: true,
                    allow_write: false,
                    tools: null,
                    brief: true,
                    tool_count: m.tools,
                  }) as Server,
              ),
          ),
      api<{ user_mcp: boolean }>("/api/me"),
    ])
      .then(([me, plat, info]) => {
        putCached("/api/me/mcp", me);
        putCached("/api/mcp#platform", plat);
        setMine(me.servers.map((x) => ({ ...x, mine: true })));
        setPlatform(plat);
        setAllowMine(info.user_mcp);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const all = useMemo(() => [...(mine || []), ...platform], [mine, platform]);
  const t = q.trim().toLowerCase();
  const shown = all.filter(
    (s) =>
      (kind === "all" || (kind === "mine") === !!s.mine) &&
      (!t ||
        `${s.name} ${s.url} ${s.server_name || ""}`.toLowerCase().includes(t)),
  );
  const cur = all.find((s) => s.id === selected);
  const base = (s: { mine?: boolean }) =>
    s.mine ? "/api/me/mcp" : "/api/settings/ai/mcp";
  const mayChange = (s: Server) => !!s.mine || admin;

  const refresh = async (s: Server) => {
    setBusy("refresh");
    try {
      await api(`${base(s)}/${s.id}/refresh`, { method: "POST" });
      Message.success(bi("已重新读取工具", "Tools refreshed"));
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
      load();
    }
  };
  const put = async (s: Server, patch: Partial<Server>) => {
    try {
      await api(`${base(s)}/${s.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...s, ...patch, token: "" }),
      });
      load();
    } catch (e) {
      err(e);
    }
  };
  const save = async () => {
    if (!edit) return;
    setBusy("save");
    try {
      const b = edit.mine ? "/api/me/mcp" : "/api/settings/ai/mcp";
      const r = await api<{ id: string }>(edit.id ? `${b}/${edit.id}` : b, {
        method: edit.id ? "PUT" : "POST",
        body: JSON.stringify({ ...edit, tools: undefined }),
      });
      setEdit(null);
      await api(`${b}/${r.id}/refresh`, { method: "POST" }).catch((e) =>
        Message.warning(
          bi(
            `已保存，但读取工具失败：${(e as Error).message}`,
            `Saved, but failed to fetch tools: ${(e as Error).message}`,
          ),
        ),
      );
      await load();
      go({ name: "mcp", id: r.id }, { replace: true });
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };
  const remove = (s: Server) =>
    Modal.confirm({
      title: bi(`移除「${s.name}」？`, `Remove "${s.name}"?`),
      content: s.mine
        ? bi("你的对话不会再调用它。", "Your chats will no longer use it.")
        : bi(
            "所有人的对话都不会再调用它。",
            "No one's chats will use it anymore.",
          ),
      okText: bi("移除", "Remove"),
      cancelText: bi("取消", "Cancel"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          await api(`${base(s)}/${s.id}`, { method: "DELETE" });
          await load();
          go({ name: "mcp" }, { replace: true });
        } catch (e) {
          err(e);
        }
      },
    });
  const setAllowUsers = async (v: boolean) => {
    try {
      await api("/api/settings/ai/user-mcp", {
        method: "PUT",
        body: JSON.stringify({ allowed: v }),
      });
      setAllowMine(v);
    } catch (e) {
      err(e);
    }
  };
  const startNew = () =>
    setEdit({
      mine: !admin || allowMine,
      name: "",
      url: "",
      token: "",
      enabled: true,
      allow_write: false,
    });
  const canAdd = allowMine || admin;

  return (
    <div className="md-split">
      {(!narrow || !selected) && (
        <aside className="md-list" aria-label={bi("MCP 服务", "MCP servers")}>
          <div className="list-head">
            <div className="list-title">
              <h1>{studioNav ? bi("能力库", "Capabilities") : bi("MCP 服务", "MCP servers")}</h1>
              {canAdd && (
                <Button
                  type="primary"
                  size="small"
                  icon={<IconPlus />}
                  onClick={startNew}
                >
                  {bi("接入", "Connect")}
                </Button>
              )}
            </div>
            {studioNav}
            <Input
              prefix={<IconSearch />}
              allowClear
              placeholder={bi("搜索服务", "Search servers")}
              value={q}
              onChange={setQ}
              aria-label={bi("搜索服务", "Search servers")}
            />
            <Segmented<Kind>
              size="sm"
              label={bi("来源", "Source")}
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: bi("全部", "All"), count: all.length },
                {
                  value: "mine",
                  label: bi("我的", "Mine"),
                  count: mine?.length || 0,
                },
                {
                  value: "platform",
                  label: bi("平台", "Platform"),
                  count: platform.length,
                },
              ]}
            />
          </div>
          {mine === null && !error ? (
            <div className="list-body">
              <Skeleton animation text={{ rows: 4 }} />
            </div>
          ) : error ? (
            <div className="list-state">
              <IconExclamationCircle className="bad" />
              <p>{error}</p>
              <Button size="small" icon={<IconRefresh />} onClick={load}>
                {bi("重试", "Retry")}
              </Button>
            </div>
          ) : shown.length === 0 ? (
            <div className="list-state">
              <p>
                {t
                  ? bi("没有匹配的服务", "No matching servers")
                  : bi("还没有接入服务", "No servers connected yet")}
              </p>
            </div>
          ) : (
            <div
              className="list-body rp-list"
              role="listbox"
              aria-label={bi("MCP 服务", "MCP servers")}
            >
              {(["mine", "platform"] as const).map((g) => {
                const rows = shown.filter((s) => (g === "mine") === !!s.mine);
                if (!rows.length) return null;
                return (
                  <React.Fragment key={g}>
                    <div className="rp-group">
                      {g === "mine"
                        ? bi("我的服务", "My servers")
                        : bi("平台服务", "Platform servers")}
                    </div>
                    {rows.map((s) => {
                      const n = (s.tools || []).filter(
                        (x) => x.read_only || s.allow_write,
                      ).length;
                      return (
                        <a
                          key={s.id}
                          href={`#/mcp/${s.id}`}
                          role="option"
                          aria-selected={selected === s.id}
                          className={`rp-row ${selected === s.id ? "on" : ""} ${s.enabled ? "" : "off"}`}
                          onClick={(e) => {
                            e.preventDefault();
                            go(
                              { name: "mcp", id: s.id },
                              { replace: !!selected },
                            );
                          }}
                        >
                          <span
                            className={`rp-ic ${s.mine ? "k-mine" : "k-mcp"}`}
                          >
                            <IconLink />
                          </span>
                          <span className="rp-t">
                            <b>{s.name}</b>
                            <small>
                              {s.brief
                                ? s.tool_count !== undefined
                                  ? bi(
                                      `${s.tool_count} 个工具`,
                                      `${s.tool_count} tool${s.tool_count === 1 ? "" : "s"}`,
                                    )
                                  : s.server_name
                                : s.error
                                  ? s.error
                                  : s.checked
                                    ? bi(
                                        `${host(s.url)} · ${n} 个工具`,
                                        `${host(s.url)} · ${n} tool${n === 1 ? "" : "s"}`,
                                      )
                                    : host(s.url)}
                            </small>
                          </span>
                          {!s.brief && (
                            <i
                              className={`rp-dot ${s.error ? "bad" : !s.enabled || !s.checked ? "idle" : ""}`}
                              aria-label={
                                s.error
                                  ? bi("连接失败", "Connection failed")
                                  : s.enabled
                                    ? bi("可用", "Available")
                                    : bi("已停用", "Disabled")
                              }
                            />
                          )}
                        </a>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </aside>
      )}
      {(!narrow || selected) && (
        <section className="md-detail">
          <div className="rp-detail">
            {narrow && selected && (
              <Button
                type="text"
                className="back"
                icon={<IconArrowLeft />}
                onClick={() => go({ name: "mcp" })}
              >
                {bi("MCP 服务", "MCP servers")}
              </Button>
            )}
            {cur ? (
              <ServerView
                s={cur}
                admin={admin}
                busy={busy}
                change={mayChange(cur)}
                refresh={() => refresh(cur)}
                put={(p) => put(cur, p)}
                remove={() => remove(cur)}
                edit={() =>
                  setEdit({
                    id: cur.id,
                    mine: !!cur.mine,
                    name: cur.name,
                    url: cur.url,
                    token: "",
                    token_enc: cur.token_enc,
                    enabled: cur.enabled,
                    allow_write: cur.allow_write,
                  })
                }
              />
            ) : selected && mine ? (
              <div className="detail-none enter">
                <h2>{bi("找不到这个服务", "Server not found")}</h2>
                <Button onClick={() => go({ name: "mcp" }, { replace: true })}>
                  {bi("返回", "Back")}
                </Button>
              </div>
            ) : (
              <div className="rp-intro enter">
                <span className="rp-ic xl k-mcp">
                  <IconLink />
                </span>
                <h2>{bi("让 AI 查你们自己的系统", "Let AI query your systems")}</h2>
                <p>
                  {bi(
                    "接入监控、工单、CMDB 这类系统提供的 MCP 服务（HTTP 方式），AI 对话时就能调用它们查数据。个人接入的只给自己的对话用，而且只开放声明为只读的工具。",
                    "Connect HTTP MCP servers from monitoring, ticketing, or CMDB systems so the assistant can look up live data in chat. Personal servers are private to your chats and expose only read-only tools.",
                  )}
                </p>
                {canAdd ? (
                  <Button type="primary" icon={<IconPlus />} onClick={startNew}>
                    {bi("接入一个服务", "Connect a server")}
                  </Button>
                ) : (
                  <p className="faint small">
                    {bi(
                      "管理员关闭了个人接入外部服务。",
                      "Administrators have disabled personal MCP connections.",
                    )}
                  </p>
                )}
                {admin && (
                  <label className="rp-switch rp-allow">
                    <Switch
                      size="small"
                      checked={allowMine}
                      onChange={setAllowUsers}
                      aria-label={bi(
                        "允许每个人接入自己的服务",
                        "Allow users to connect personal servers",
                      )}
                    />
                    {bi(
                      "允许每个人接入自己的服务",
                      "Allow users to connect personal servers",
                    )}
                  </label>
                )}
              </div>
            )}
          </div>
        </section>
      )}
      <Modal
        visible={!!edit}
        title={
          edit?.id
            ? bi("编辑服务", "Edit server")
            : bi("接入 MCP 服务", "Connect MCP server")
        }
        onCancel={() => setEdit(null)}
        okText={
          edit?.id
            ? bi("保存", "Save")
            : bi("接入并读取工具", "Connect & load tools")
        }
        cancelText={bi("取消", "Cancel")}
        confirmLoading={busy === "save"}
        okButtonProps={{ disabled: !edit?.name.trim() || !edit?.url.trim() }}
        onOk={save}
      >
        {edit && (
          <div className="st-form">
            {admin && !edit.id && (
              <div className="st-field">
                <span>{bi("给谁用", "Availability")}</span>
                <Segmented<string>
                  size="sm"
                  label={bi("给谁用", "Availability")}
                  value={edit.mine ? "mine" : "platform"}
                  onChange={(v) => setEdit({ ...edit, mine: v === "mine" })}
                  options={[
                    ...(allowMine
                      ? [{ value: "mine", label: bi("只给我自己", "Only me") }]
                      : []),
                    {
                      value: "platform",
                      label: bi("所有人（平台服务）", "Everyone (platform)"),
                    },
                  ]}
                />
              </div>
            )}
            <div className="st-field">
              <span>{bi("名称", "Name")}</span>
              <Input
                value={edit.name}
                onChange={(v) => setEdit({ ...edit, name: v })}
                placeholder={bi("监控平台", "Monitoring platform")}
                maxLength={40}
                aria-label={bi("名称", "Name")}
              />
            </div>
            <div className="st-field">
              <span>{bi("地址", "URL")}</span>
              <Input
                value={edit.url}
                onChange={(v) => setEdit({ ...edit, url: v })}
                placeholder="https://mcp.example.com/mcp"
                aria-label={bi("地址", "URL")}
              />
              <small>
                {bi(
                  "Streamable HTTP 方式的 MCP 服务地址。",
                  "Streamable HTTP endpoint for the MCP server.",
                )}
              </small>
            </div>
            <div className="st-field">
              <span>{bi("访问令牌（可选）", "Access token (optional)")}</span>
              <Input.Password
                value={edit.token}
                onChange={(v) => setEdit({ ...edit, token: v })}
                placeholder={
                  edit.token_enc
                    ? bi("已保存，留空保持不变", "Saved; leave blank to keep")
                    : bi("以 Bearer 方式发送", "Sent as Bearer token")
                }
                autoComplete="new-password"
                aria-label={bi("访问令牌", "Access token")}
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ServerView({
  s,
  admin,
  busy,
  change,
  refresh,
  put,
  remove,
  edit,
}: {
  s: Server;
  admin: boolean;
  busy: string;
  change: boolean;
  refresh: () => void;
  put: (p: Partial<Server>) => void;
  remove: () => void;
  edit: () => void;
}) {
  useLang();
  const off = new Set(s.disabled_tools || []);
  const tools = s.tools || [];
  const offered = tools.filter(
    (t) => !off.has(t.name) && (t.read_only || (!s.mine && s.allow_write)),
  ).length;
  const briefCount =
    s.tool_count !== undefined
      ? bi(
          `${s.tool_count} 个工具`,
          `${s.tool_count} tool${s.tool_count === 1 ? "" : "s"}`,
        )
      : s.server_name;
  return (
    <article className="rp-doc enter" key={s.id}>
      <header className="rp-head">
        <span className={`rp-ic lg ${s.mine ? "k-mine" : "k-mcp"}`}>
          <IconLink />
        </span>
        <div className="rp-head-t">
          <h1>{s.name}</h1>
          {s.brief ? (
            <p>
              {bi(
                `平台接入的服务，${briefCount}。由管理员维护。`,
                `Platform-connected server (${briefCount}). Managed by administrators.`,
              )}
            </p>
          ) : (
            <div className="rp-meta">
              <span className="mono">{s.url}</span>
              {s.server_name && (
                <span>{bi(`服务名 ${s.server_name}`, `Server: ${s.server_name}`)}</span>
              )}
              {s.error ? (
                <span className="bad">
                  <IconExclamationCircle /> {s.error}
                </span>
              ) : s.checked ? (
                <span title={fullTime(s.checked)}>
                  {bi(
                    `${tools.length} 个工具，开放给 AI ${offered} 个 · ${ago(s.checked)}检查`,
                    `${tools.length} tool${tools.length === 1 ? "" : "s"}, ${offered} enabled for AI · checked ${ago(s.checked)}`,
                  )}
                </span>
              ) : (
                <span>{bi("还没有连接", "Not connected yet")}</span>
              )}
            </div>
          )}
        </div>
        {change && !s.brief && (
          <span className="rp-acts">
            <Button
              icon={<IconRefresh />}
              loading={busy === "refresh"}
              onClick={refresh}
            >
              {bi("重新读取", "Refresh")}
            </Button>
            <Button icon={<IconEdit />} onClick={edit}>
              {bi("编辑", "Edit")}
            </Button>
            <Button
              status="danger"
              icon={<IconDelete />}
              onClick={remove}
              aria-label={bi("移除", "Remove")}
            />
            <label className="rp-switch">
              <Switch
                size="small"
                checked={s.enabled}
                onChange={(v) => put({ enabled: v })}
                aria-label={bi("启用", "Enable")}
              />
              {s.enabled ? bi("已启用", "Enabled") : bi("已停用", "Disabled")}
            </label>
          </span>
        )}
      </header>
      {!s.brief && (
        <div className="rp-body">
          <div className="rp-main">
            <section className="rp-sec">
              <h2>
                {bi("工具", "Tools")} <em className="num">{tools.length}</em>
              </h2>
              {tools.length === 0 ? (
                <p className="faint small">
                  {s.checked
                    ? bi(
                        "这个服务没有提供工具。",
                        "This server provides no tools.",
                      )
                    : bi(
                        "还没有读取到工具，点「重新读取」。",
                        "No tools fetched yet; click Refresh.",
                      )}
                </p>
              ) : (
                <ul className="mcp-tools">
                  {tools.map((t) => {
                    const allowed = t.read_only || (!s.mine && s.allow_write);
                    return (
                      <li key={t.name} className={allowed ? "" : "locked"}>
                        <Switch
                          size="small"
                          checked={allowed && !off.has(t.name)}
                          disabled={!allowed || !change}
                          onChange={(v) =>
                            put({
                              disabled_tools: v
                                ? [...off].filter((x) => x !== t.name)
                                : [...off, t.name],
                            })
                          }
                          aria-label={bi(`开放 ${t.name}`, `Enable ${t.name}`)}
                        />
                        <span className="mcp-tool-t">
                          <b className="mono">{t.name}</b>
                          {t.description && <small>{t.description}</small>}
                        </span>
                        {t.read_only ? (
                          <em className="mcp-ro">{bi("只读", "Read-only")}</em>
                        ) : (
                          <em className="mcp-rw">{bi("可能修改", "May write")}</em>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            {admin && !s.mine && tools.some((t) => !t.read_only) && (
              <section className="rp-sec">
                <label className="mcp-write">
                  <Switch
                    size="small"
                    checked={s.allow_write}
                    onChange={(v) => put({ allow_write: v })}
                    aria-label={bi(
                      "也开放可能修改的工具",
                      "Also allow tools that may modify state",
                    )}
                  />
                  <span>
                    <b>
                      {bi(
                        "也开放可能修改系统的工具",
                        "Also allow tools that may modify systems",
                      )}
                    </b>
                    <small>
                      {bi(
                        "开启后 AI 可以直接调用它们，平台不会再让人确认；只在你信任这个服务、且工具本身有权限控制时开启。",
                        "When enabled, the assistant can invoke them directly without asking for confirmation; only enable if you trust this server and its own access controls.",
                      )}
                    </small>
                  </span>
                </label>
              </section>
            )}
          </div>
          <aside className="rp-side">
            <dl>
              <dt>{bi("给谁用", "Availability")}</dt>
              <dd>
                {s.mine
                  ? bi("只给我自己的对话", "Only my chats")
                  : bi("所有人的对话", "Everyone's chats")}
              </dd>
              <dt>{bi("访问令牌", "Access token")}</dt>
              <dd>
                {s.token_enc
                  ? bi("已保存（加密）", "Saved (encrypted)")
                  : bi("没有", "None")}
              </dd>
              <dt>{bi("能做什么", "Capabilities")}</dt>
              <dd>
                {s.mine
                  ? bi(
                      "个人接入的服务只开放声明为只读的工具。",
                      "Personal servers expose only tools declared as read-only.",
                    )
                  : s.allow_write
                    ? bi(
                        "开放了可能修改系统的工具。",
                        "Tools that may modify systems are enabled.",
                      )
                    : bi(
                        "默认只开放声明为只读的工具，保持「AI 只读不改」。",
                        "By default only read-only tools are exposed, preserving read-only safety.",
                      )}
              </dd>
            </dl>
          </aside>
        </div>
      )}
    </article>
  );
}

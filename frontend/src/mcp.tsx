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

export function MCPPage({ selected }: { selected?: string }) {
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
                    server_name: `${m.tools} 个工具`,
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
      Message.success("已重新读取工具");
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
        Message.warning(`已保存，但读取工具失败：${(e as Error).message}`),
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
      title: `移除「${s.name}」？`,
      content: s.mine
        ? "你的对话不会再调用它。"
        : "所有人的对话都不会再调用它。",
      okText: "移除",
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
        <aside className="md-list" aria-label="MCP 服务">
          <div className="list-head">
            <div className="list-title">
              <h1>MCP 服务</h1>
              {canAdd && (
                <Button
                  type="primary"
                  size="small"
                  icon={<IconPlus />}
                  onClick={startNew}
                >
                  接入
                </Button>
              )}
            </div>
            <Input
              prefix={<IconSearch />}
              allowClear
              placeholder="搜索服务"
              value={q}
              onChange={setQ}
              aria-label="搜索服务"
            />
            <Segmented<Kind>
              size="sm"
              label="来源"
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: "全部", count: all.length },
                { value: "mine", label: "我的", count: mine?.length || 0 },
                { value: "platform", label: "平台", count: platform.length },
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
                重试
              </Button>
            </div>
          ) : shown.length === 0 ? (
            <div className="list-state">
              <p>{t ? "没有匹配的服务" : "还没有接入服务"}</p>
            </div>
          ) : (
            <div
              className="list-body rp-list"
              role="listbox"
              aria-label="MCP 服务"
            >
              {(["mine", "platform"] as const).map((g) => {
                const rows = shown.filter((s) => (g === "mine") === !!s.mine);
                if (!rows.length) return null;
                return (
                  <React.Fragment key={g}>
                    <div className="rp-group">
                      {g === "mine" ? "我的服务" : "平台服务"}
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
                                ? s.server_name
                                : s.error
                                  ? s.error
                                  : s.checked
                                    ? `${host(s.url)} · ${n} 个工具`
                                    : host(s.url)}
                            </small>
                          </span>
                          {!s.brief && (
                            <i
                              className={`rp-dot ${s.error ? "bad" : !s.enabled || !s.checked ? "idle" : ""}`}
                              aria-label={
                                s.error
                                  ? "连接失败"
                                  : s.enabled
                                    ? "可用"
                                    : "已停用"
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
                MCP 服务
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
                <h2>找不到这个服务</h2>
                <Button onClick={() => go({ name: "mcp" }, { replace: true })}>
                  返回
                </Button>
              </div>
            ) : (
              <div className="rp-intro enter">
                <span className="rp-ic xl k-mcp">
                  <IconLink />
                </span>
                <h2>让 AI 查你们自己的系统</h2>
                <p>
                  接入监控、工单、CMDB 这类系统提供的 MCP 服务（HTTP 方式），AI
                  对话时就能调用它们查数据。个人接入的只给自己的对话用，而且只开放声明为只读的工具。
                </p>
                {canAdd ? (
                  <Button type="primary" icon={<IconPlus />} onClick={startNew}>
                    接入一个服务
                  </Button>
                ) : (
                  <p className="faint small">管理员关闭了个人接入外部服务。</p>
                )}
                {admin && (
                  <label className="rp-switch rp-allow">
                    <Switch
                      size="small"
                      checked={allowMine}
                      onChange={setAllowUsers}
                      aria-label="允许每个人接入自己的服务"
                    />
                    允许每个人接入自己的服务
                  </label>
                )}
              </div>
            )}
          </div>
        </section>
      )}
      <Modal
        visible={!!edit}
        title={edit?.id ? "编辑服务" : "接入 MCP 服务"}
        onCancel={() => setEdit(null)}
        okText={edit?.id ? "保存" : "接入并读取工具"}
        confirmLoading={busy === "save"}
        okButtonProps={{ disabled: !edit?.name.trim() || !edit?.url.trim() }}
        onOk={save}
      >
        {edit && (
          <div className="st-form">
            {admin && !edit.id && (
              <div className="st-field">
                <span>给谁用</span>
                <Segmented<string>
                  size="sm"
                  label="给谁用"
                  value={edit.mine ? "mine" : "platform"}
                  onChange={(v) => setEdit({ ...edit, mine: v === "mine" })}
                  options={[
                    ...(allowMine
                      ? [{ value: "mine", label: "只给我自己" }]
                      : []),
                    { value: "platform", label: "所有人（平台服务）" },
                  ]}
                />
              </div>
            )}
            <div className="st-field">
              <span>名称</span>
              <Input
                value={edit.name}
                onChange={(v) => setEdit({ ...edit, name: v })}
                placeholder="监控平台"
                maxLength={40}
                aria-label="名称"
              />
            </div>
            <div className="st-field">
              <span>地址</span>
              <Input
                value={edit.url}
                onChange={(v) => setEdit({ ...edit, url: v })}
                placeholder="https://mcp.example.com/mcp"
                aria-label="地址"
              />
              <small>Streamable HTTP 方式的 MCP 服务地址。</small>
            </div>
            <div className="st-field">
              <span>访问令牌（可选）</span>
              <Input.Password
                value={edit.token}
                onChange={(v) => setEdit({ ...edit, token: v })}
                placeholder={
                  edit.token_enc ? "已保存，留空保持不变" : "以 Bearer 方式发送"
                }
                autoComplete="new-password"
                aria-label="访问令牌"
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
  const off = new Set(s.disabled_tools || []);
  const tools = s.tools || [];
  const offered = tools.filter(
    (t) => !off.has(t.name) && (t.read_only || (!s.mine && s.allow_write)),
  ).length;
  return (
    <article className="rp-doc enter" key={s.id}>
      <header className="rp-head">
        <span className={`rp-ic lg ${s.mine ? "k-mine" : "k-mcp"}`}>
          <IconLink />
        </span>
        <div className="rp-head-t">
          <h1>{s.name}</h1>
          {s.brief ? (
            <p>平台接入的服务，{s.server_name}。由管理员维护。</p>
          ) : (
            <div className="rp-meta">
              <span className="mono">{s.url}</span>
              {s.server_name && <span>服务名 {s.server_name}</span>}
              {s.error ? (
                <span className="bad">
                  <IconExclamationCircle /> {s.error}
                </span>
              ) : s.checked ? (
                <span title={fullTime(s.checked)}>
                  {tools.length} 个工具，开放给 AI {offered} 个 ·{" "}
                  {ago(s.checked)}检查
                </span>
              ) : (
                <span>还没有连接</span>
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
              重新读取
            </Button>
            <Button icon={<IconEdit />} onClick={edit}>
              编辑
            </Button>
            <Button
              status="danger"
              icon={<IconDelete />}
              onClick={remove}
              aria-label="移除"
            />
            <label className="rp-switch">
              <Switch
                size="small"
                checked={s.enabled}
                onChange={(v) => put({ enabled: v })}
                aria-label="启用"
              />
              {s.enabled ? "已启用" : "已停用"}
            </label>
          </span>
        )}
      </header>
      {!s.brief && (
        <div className="rp-body">
          <div className="rp-main">
            <section className="rp-sec">
              <h2>
                工具 <em className="num">{tools.length}</em>
              </h2>
              {tools.length === 0 ? (
                <p className="faint small">
                  {s.checked
                    ? "这个服务没有提供工具。"
                    : "还没有读取到工具，点「重新读取」。"}
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
                          aria-label={`开放 ${t.name}`}
                        />
                        <span className="mcp-tool-t">
                          <b className="mono">{t.name}</b>
                          {t.description && <small>{t.description}</small>}
                        </span>
                        {t.read_only ? (
                          <em className="mcp-ro">只读</em>
                        ) : (
                          <em className="mcp-rw">可能修改</em>
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
                    aria-label="也开放可能修改的工具"
                  />
                  <span>
                    <b>也开放可能修改系统的工具</b>
                    <small>
                      开启后 AI
                      可以直接调用它们，平台不会再让人确认；只在你信任这个服务、且工具本身有权限控制时开启。
                    </small>
                  </span>
                </label>
              </section>
            )}
          </div>
          <aside className="rp-side">
            <dl>
              <dt>给谁用</dt>
              <dd>{s.mine ? "只给我自己的对话" : "所有人的对话"}</dd>
              <dt>访问令牌</dt>
              <dd>{s.token_enc ? "已保存（加密）" : "没有"}</dd>
              <dt>能做什么</dt>
              <dd>
                {s.mine
                  ? "个人接入的服务只开放声明为只读的工具。"
                  : s.allow_write
                    ? "开放了可能修改系统的工具。"
                    : "默认只开放声明为只读的工具，保持「AI 只读不改」。"}
              </dd>
            </dl>
          </aside>
        </div>
      )}
    </article>
  );
}

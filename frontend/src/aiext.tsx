import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Message, Modal, Switch } from "@arco-design/web-react";
import {
  IconBook,
  IconDelete,
  IconEdit,
  IconExclamationCircle,
  IconLink,
  IconPlus,
  IconRefresh,
} from "@arco-design/web-react/icon";
import { ago, api, cached, err, putCached } from "./shared";
import { bi, useLang } from "./i18n";
import { Markdown } from "./aimd";
import "./aiext.css";

/* What the assistant can draw on beyond the platform's own tools: skills (written know-how it reads when a question
   needs it) and MCP services (outside tools an administrator connects). */

type Skill = {
  name: string;
  title: string;
  description: string;
  content?: string;
  builtin: boolean;
  enabled: boolean;
  mine?: boolean;
};

/** Skills: the platform's (for administrators), or a person's own (mine), shown next to the platform's they also get. */
export function SkillsView({ mine }: { mine?: boolean } = {}) {
  const lang = useLang();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [open, setOpen] = useState("");
  const [edit, setEdit] = useState<Skill | null>(null);
  const [busy, setBusy] = useState(false);
  const savingRef = useRef(false);
  const [platform, setPlatform] = useState<Skill[]>([]);
  useEffect(() => {
    let alive = true;
    (mine
      ? api<{ skills: Skill[]; platform: Skill[] }>("/api/me/skills").then(
          (r) => {
            if (!alive) return;
            setSkills(
              r.skills.map((x) => ({ ...x, enabled: true, builtin: false })),
            );
            setPlatform(r.platform);
          },
        )
      : api<{ skills: Skill[] }>("/api/settings/ai/skills").then((r) => {
          if (alive) setSkills(r.skills);
        })
    ).catch((e) => {
      if (alive) err(e);
    });
    return () => {
      alive = false;
    };
  }, [mine, lang]);
  const save = async (next: Skill[]) => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setBusy(true);
    try {
      const custom = next
        .filter((s) => !s.builtin)
        .map(({ name, title, description, content }) => ({
          name,
          title,
          description,
          content,
        }));
      if (mine) {
        const r = await api<{ skills: Skill[] }>("/api/me/skills", {
          method: "PUT",
          body: JSON.stringify({ skills: custom }),
        });
        setSkills(
          r.skills.map((x) => ({ ...x, enabled: true, builtin: false })),
        );
        return true;
      }
      const r = await api<{ skills: Skill[] }>("/api/settings/ai/skills", {
        method: "PUT",
        body: JSON.stringify({
          disabled: next.filter((s) => !s.enabled).map((s) => s.name),
          custom,
        }),
      });
      setSkills(r.skills);
      return true;
    } catch (e) {
      err(e);
      return false;
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };
  const builtin = useMemo(
    () => (mine ? platform : (skills || []).filter((s) => s.builtin)),
    [mine, platform, skills],
  );
  const custom = useMemo(
    () => (skills || []).filter((s) => !s.builtin),
    [skills],
  );
  const row = (s: Skill) => (
    <li key={s.name} className={s.enabled ? "" : "off"}>
      <button
        type="button"
        className="ex-main"
        onClick={() => setOpen(open === s.name ? "" : s.name)}
        aria-expanded={open === s.name}
      >
        <span className={`ex-ic ${s.builtin ? "b" : "c"}`} aria-hidden>
          <IconBook />
        </span>
        <span className="ex-t">
          <b>
            {s.title} <code>{s.name}</code>
          </b>
          <small>{s.description}</small>
        </span>
      </button>
      <span className="ex-acts">
        {!s.builtin && (!mine || custom.includes(s)) && (
          <>
            <Button
              size="small"
              icon={<IconEdit />}
              onClick={() => setEdit({ ...s })}
              aria-label={bi(`编辑 ${s.title}`, `Edit ${s.title}`)}
            />
            <Button
              size="small"
              status="danger"
              icon={<IconDelete />}
              onClick={() =>
                Modal.confirm({
                  title: bi(
                    `删除技能「${s.title}」？`,
                    `Delete skill "${s.title}"?`,
                  ),
                  okText: bi("删除", "Delete"),
                  cancelText: bi("取消", "Cancel"),
                  okButtonProps: { status: "danger" },
                  onOk: () =>
                    save((skills || []).filter((x) => x.name !== s.name)),
                })
              }
              aria-label={bi(`删除 ${s.title}`, `Delete ${s.title}`)}
            />
          </>
        )}
        {!mine && (
          <Switch
            checked={s.enabled}
            disabled={busy}
            onChange={(v) =>
              save(
                (skills || []).map((x) =>
                  x.name === s.name ? { ...x, enabled: v } : x,
                ),
              )
            }
            aria-label={bi(`启用 ${s.title}`, `Enable ${s.title}`)}
          />
        )}
      </span>
      {open === s.name && (
        <div className="ex-body">
          <Markdown text={s.content || ""} />
        </div>
      )}
    </li>
  );
  return (
    <article className={mine ? "me-pane ex-page enter" : "sx-page st-main ex-page enter"}>
      <header className="sx-page-h">
        <div>
          <h1>{mine ? bi("我的技能", "My skills") : bi("技能", "Skills")}</h1>
          <p>
            {mine
              ? bi(
                  "写给 AI 看的你自己的操作手册，只用在你的对话里，别人看不到。平台提供的技能你也都能用。",
                  "Your own playbooks for the assistant, private to your chats. Platform skills are also available to you.",
                )
              : bi(
                  "技能是写给 AI 看的操作手册。对话时 AI 先看到每个技能的一句话说明，遇到相关问题再读取全文，所以加再多技能也不会拖慢回答。在对话的工作过程里能看到它用了哪个技能。",
                  "Skills are playbooks for the assistant. It sees each skill's one-line summary first and loads the full text only when relevant, so adding many won't slow chats down. You can see which skill it used in the thinking timeline.",
                )}
          </p>
        </div>
        <Button
          type="primary"
          icon={<IconPlus />}
          onClick={() =>
            setEdit({
              name: "",
              title: "",
              description: "",
              content: "",
              builtin: false,
              enabled: true,
            })
          }
        >
          {bi("添加技能", "Add skill")}
        </Button>
      </header>
      {!skills && <div className="st-skel" aria-label={bi("载入中", "Loading")} />}
      {skills && (
        <>
          {mine && (
            <section className="sx-sec">
              <h2>
                {bi("我写的", "My custom skills")}{" "}
                <em className="ex-n">{custom.length}</em>
              </h2>
              {custom.length === 0 ? (
                <p className="faint small">
                  {bi(
                    "还没有。可以把你负责的系统的习惯做法、常查的命令写成技能，AI 回答你的问题时会按它来。",
                    "None yet. Turn your runbooks, conventions, and frequent diagnostic commands into skills for the assistant to follow.",
                  )}
                </p>
              ) : (
                <ul className="ex-list">{custom.map(row)}</ul>
              )}
            </section>
          )}
          <section className="sx-sec">
            <h2>
              {mine
                ? bi("平台提供", "Provided by platform")
                : bi("平台内置", "Built-in skills")}{" "}
              <em className="ex-n">{builtin.length}</em>
            </h2>
            <ul className="ex-list">{builtin.map(row)}</ul>
          </section>
          {!mine && (
            <section className="sx-sec">
              <h2>
                {bi("本单位的技能", "Organization skills")}{" "}
                <em className="ex-n">{custom.length}</em>
              </h2>
              {custom.length === 0 ? (
                <p className="faint small">
                  {bi(
                    "还没有。可以把本单位的变更规范、常见故障处理办法写成技能，AI 回答时会按它来。",
                    "None yet. Document your org's change rules or incident playbooks as skills so the assistant follows them.",
                  )}
                </p>
              ) : (
                <ul className="ex-list">{custom.map(row)}</ul>
              )}
            </section>
          )}
        </>
      )}
      <Modal
        visible={!!edit}
        title={
          edit?.builtin === false &&
          skills?.some((s) => s.name === edit?.name && !s.builtin)
            ? bi("编辑技能", "Edit skill")
            : bi("添加技能", "Add skill")
        }
        onCancel={() => setEdit(null)}
        okText={bi("保存", "Save")}
        cancelText={bi("取消", "Cancel")}
        confirmLoading={busy}
        okButtonProps={{
          disabled:
            !edit?.name ||
            !edit?.title ||
            !edit?.description ||
            !edit?.content?.trim(),
        }}
        onOk={async () => {
          if (!edit) return;
          const others = (mine ? skills || [] : skills || []).filter(
            (s) => s.name !== edit.name,
          );
          if (await save([...others, edit])) {
            setEdit(null);
            Message.success(bi("已保存", "Saved"));
          }
        }}
        style={{ width: 720, maxWidth: "96vw" }}
      >
        {edit && (
          <div className="st-form">
            <div className="ai-two">
              <div className="st-field">
                <span>{bi("标识", "Identifier")}</span>
                <Input
                  value={edit.name}
                  onChange={(v) => setEdit({ ...edit, name: v.toLowerCase() })}
                  placeholder="change-window"
                  disabled={skills?.some(
                    (s) => s.name === edit.name && !s.builtin,
                  )}
                  aria-label={bi("标识", "Identifier")}
                />
                <small>
                  {bi(
                    "小写字母开头，只用小写字母、数字和 -",
                    "Start with a lowercase letter; use lowercase letters, digits, and - only",
                  )}
                </small>
              </div>
              <div className="st-field">
                <span>{bi("名称", "Name")}</span>
                <Input
                  value={edit.title}
                  onChange={(v) => setEdit({ ...edit, title: v })}
                  placeholder={bi("本单位变更规范", "Org change policy")}
                  maxLength={40}
                  aria-label={bi("名称", "Name")}
                />
              </div>
            </div>
            <div className="st-field">
              <span>
                {bi(
                  "一句话说明（AI 据此决定什么时候读取它）",
                  "One-line summary (tells the assistant when to load it)",
                )}
              </span>
              <Input
                value={edit.description}
                onChange={(v) => setEdit({ ...edit, description: v })}
                maxLength={300}
                placeholder={bi(
                  "变更窗口、审批要求和回退规范；回答涉及上线或变更时使用",
                  "Change windows, approval rules, and rollback standards; read for go-live or change questions",
                )}
                aria-label={bi("说明", "Summary")}
              />
            </div>
            <div className="st-field">
              <span>{bi("内容（Markdown）", "Content (Markdown)")}</span>
              <Input.TextArea
                value={edit.content}
                onChange={(v) => setEdit({ ...edit, content: v })}
                autoSize={{ minRows: 10, maxRows: 22 }}
                className="mono"
                aria-label={bi("内容", "Content")}
              />
              <small>
                {bi(
                  "不要写密码或密钥，含有这些内容的技能不能保存。",
                  "Do not include passwords or keys; skills containing secrets cannot be saved.",
                )}
              </small>
            </div>
          </div>
        )}
      </Modal>
    </article>
  );
}

/* ---------------------------------------------------------------- MCP */

type MCPTool = { name: string; description?: string; read_only: boolean };
type MCPServer = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  token_enc?: string;
  allow_write: boolean;
  tools: MCPTool[] | null;
  disabled_tools?: string[];
  checked?: string;
  error?: string;
  server_name?: string;
};

/** Outside services: the platform's (for administrators), or a person's own (mine: read-only tools only). */
export function MCPView({ mine }: { mine?: boolean } = {}) {
  useLang();
  const base = mine ? "/api/me/mcp" : "/api/settings/ai/mcp";
  const [list, setList] = useState<MCPServer[] | null>(null);
  const [userMCP, setUserMCP] = useState<boolean | null>(null);
  const [edit, setEdit] = useState<
    (Partial<MCPServer> & { token?: string }) | null
  >(null);
  const [busy, setBusy] = useState("");
  const [togglingUserMCP, setTogglingUserMCP] = useState(false);
  const busyRef = useRef("");
  const puttingRef = useRef<Set<string>>(new Set());
  const load = () =>
    api<{ servers: MCPServer[] }>(base)
      .then((r) => setList(r.servers))
      .catch(err);
  useEffect(() => {
    let alive = true;
    api<{ servers: MCPServer[] }>(base)
      .then((r) => {
        if (alive) setList(r.servers);
      })
      .catch((e) => {
        if (alive) err(e);
      });
    (mine
      ? api<{ user_mcp: boolean }>("/api/me")
      : api<{ no_user_mcp?: boolean }>("/api/settings/ai").then((r) => ({
          user_mcp: !r.no_user_mcp,
        }))
    )
      .then((r) => {
        if (alive) setUserMCP(r.user_mcp);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [mine, base]);
  const setAllowUsers = async (v: boolean) => {
    if (togglingUserMCP) return;
    setTogglingUserMCP(true);
    try {
      await api("/api/settings/ai/user-mcp", {
        method: "PUT",
        body: JSON.stringify({ allowed: v }),
      });
      setUserMCP(v);
    } catch (e) {
      err(e);
    } finally {
      setTogglingUserMCP(false);
    }
  };
  const put = async (sv: MCPServer, patch: Partial<MCPServer>) => {
    if (puttingRef.current.has(sv.id)) return;
    puttingRef.current.add(sv.id);
    try {
      await api(`${base}/${sv.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...sv, ...patch, token: "" }),
      });
      await load();
    } catch (e) {
      err(e);
    } finally {
      puttingRef.current.delete(sv.id);
    }
  };
  const refresh = async (id: string) => {
    if (busyRef.current) return;
    busyRef.current = id;
    setBusy(id);
    try {
      await api(`${base}/${id}/refresh`, { method: "POST" });
    } catch (e) {
      err(e);
    } finally {
      busyRef.current = "";
      setBusy("");
      load();
    }
  };
  const save = async () => {
    if (!edit || busyRef.current) return;
    busyRef.current = "save";
    setBusy("save");
    try {
      const r = await api<{ id: string }>(
        edit.id ? `${base}/${edit.id}` : base,
        {
          method: edit.id ? "PUT" : "POST",
          body: JSON.stringify({ ...edit, enabled: edit.enabled ?? true }),
        },
      );
      setEdit(null);
      busyRef.current = "";
      await refresh(r.id);
    } catch (e) {
      err(e);
    } finally {
      busyRef.current = "";
      setBusy("");
    }
  };
  return (
    <article className={mine ? "me-pane ex-page enter" : "sx-page st-main ex-page enter"}>
      <header className="sx-page-h">
        <div>
          <h1>{mine ? bi("我的 MCP 服务", "My MCP servers") : bi("MCP 服务", "MCP servers")}</h1>
          <p>
            {mine
              ? bi(
                  "接入你自己常用的系统（监控、工单、CMDB 等，MCP 的 HTTP 方式），只用在你的对话里。个人接入的服务只开放只读工具。",
                  "Connect your own systems (monitoring, ticketing, CMDB via HTTP MCP) for your chats only. Personal servers expose only read-only tools.",
                )
              : bi(
                  "接入外部系统提供的工具（Model Context Protocol，HTTP 方式），比如监控、工单、CMDB。AI 对话时可以调用它们查数据。默认只开放声明为只读的工具，保持「AI 只读不改」。",
                  "Connect external Model Context Protocol (HTTP) servers such as monitoring, ticketing, or CMDB so the assistant can look up data in chat. Only read-only tools are enabled by default.",
                )}
          </p>
        </div>
        <Button
          type="primary"
          icon={<IconPlus />}
          disabled={mine && userMCP === false}
          onClick={() =>
            setEdit({ name: "", url: "", enabled: true, allow_write: false })
          }
        >
          {bi("接入服务", "Connect server")}
        </Button>
      </header>
      {!mine && userMCP !== null && (
        <label className="mc-users">
          <Switch
            size="small"
            checked={userMCP}
            loading={togglingUserMCP}
            onChange={setAllowUsers}
            aria-label={bi("允许每个人接入自己的服务", "Allow personal MCP servers")}
          />
          <span>
            {bi(
              "允许每个人在「我的账户」里接入自己的服务",
              "Allow users to connect personal servers in My Account",
            )}
            <small>
              {bi(
                "个人接入的服务只给他自己的对话用，只开放只读工具。平台会替他们去连这些地址。",
                "Personal servers are scoped to each user's own chats and expose only read-only tools. The platform connects to these URLs on their behalf.",
              )}
            </small>
          </span>
        </label>
      )}
      {mine && userMCP === false && (
        <p className="note warn">
          {bi(
            "管理员关闭了个人接入外部服务。已经接入的不再提供给 AI，可以删除。",
            "Administrators have disabled personal MCP connections. Existing servers are no longer exposed to AI and may be deleted.",
          )}
        </p>
      )}
      {!list && <div className="st-skel" aria-label={bi("载入中", "Loading")} />}
      {list && list.length === 0 && (
        <div className="st-empty">
          <IconLink />
          <b>{bi("还没有接入 MCP 服务", "No MCP servers connected yet")}</b>
          <span>
            {bi(
              "填写服务的 HTTP 地址（如 https://mcp.example.com/mcp），平台会读取它提供的工具。",
              "Enter the server's HTTP URL (e.g. https://mcp.example.com/mcp) to discover its tools.",
            )}
          </span>
        </div>
      )}
      {list && list.length > 0 && (
        <ul className="mc-list">
          {list.map((sv) => {
            const off = new Set(sv.disabled_tools || []);
            const tools = sv.tools || [];
            const offered = tools.filter(
              (t) => !off.has(t.name) && (t.read_only || sv.allow_write),
            ).length;
            return (
              <li key={sv.id} className={sv.enabled ? "" : "off"}>
                <div className="mc-head">
                  <span className="ex-ic m" aria-hidden>
                    <IconLink />
                  </span>
                  <span className="ex-t">
                    <b>
                      {sv.name}{" "}
                      {sv.server_name && (
                        <small className="faint">{sv.server_name}</small>
                      )}
                    </b>
                    <small className="mono" title={sv.url}>
                      {sv.url}
                    </small>
                    <small>
                      {sv.error ? (
                        <span className="bad">
                          <IconExclamationCircle /> {sv.error}
                        </span>
                      ) : sv.checked ? (
                        bi(
                          `${tools.length} 个工具，开放给 AI ${offered} 个 · ${ago(sv.checked)}检查`,
                          `${tools.length} tool${tools.length === 1 ? "" : "s"}, ${offered} enabled for AI · checked ${ago(sv.checked)}`,
                        )
                      ) : (
                        bi("还没有连接", "Not connected yet")
                      )}
                    </small>
                  </span>
                  <span className="ex-acts">
                    <Button
                      size="small"
                      icon={<IconRefresh />}
                      loading={busy === sv.id}
                      onClick={() => refresh(sv.id)}
                    >
                      {bi("重新读取", "Refresh")}
                    </Button>
                    <Button
                      size="small"
                      icon={<IconEdit />}
                      onClick={() => setEdit({ ...sv, token: "" })}
                      aria-label={bi("编辑", "Edit")}
                    />
                    <Button
                      size="small"
                      status="danger"
                      icon={<IconDelete />}
                      onClick={() =>
                        Modal.confirm({
                          title: bi(`移除「${sv.name}」？`, `Remove "${sv.name}"?`),
                          okText: bi("移除", "Remove"),
                          cancelText: bi("取消", "Cancel"),
                          okButtonProps: { status: "danger" },
                          onOk: async () => {
                            await api(`${base}/${sv.id}`, { method: "DELETE" });
                            load();
                          },
                        })
                      }
                      aria-label={bi("移除", "Remove")}
                    />
                    <Switch
                      checked={sv.enabled}
                      onChange={(v) => put(sv, { enabled: v })}
                      aria-label={bi(`启用 ${sv.name}`, `Enable ${sv.name}`)}
                    />
                  </span>
                </div>
                {tools.length > 0 && (
                  <div className="mc-tools">
                    {tools.map((t) => {
                      const allowed = t.read_only || (!mine && sv.allow_write);
                      return (
                        <label
                          key={t.name}
                          className={`mc-tool ${!allowed ? "locked" : ""}`}
                          title={t.description}
                        >
                          <Switch
                            size="small"
                            checked={allowed && !off.has(t.name)}
                            disabled={!allowed}
                            onChange={(v) =>
                              put(sv, {
                                disabled_tools: v
                                  ? [...off].filter((x) => x !== t.name)
                                  : [...off, t.name],
                              })
                            }
                            aria-label={bi(`开放 ${t.name}`, `Enable ${t.name}`)}
                          />
                          <span>
                            <code>{t.name}</code>
                            {t.read_only ? (
                              <em className="ro">{bi("只读", "Read-only")}</em>
                            ) : (
                              <em className="rw">{bi("可能修改", "May write")}</em>
                            )}
                            {t.description && <small>{t.description}</small>}
                          </span>
                        </label>
                      );
                    })}
                    {!mine && (
                      <label className="mc-write">
                        <Switch
                          size="small"
                          checked={sv.allow_write}
                          onChange={(v) => put(sv, { allow_write: v })}
                          aria-label={bi(
                            "也开放可能修改的工具",
                            "Also allow tools that may modify state",
                          )}
                        />
                        <span>
                          {bi(
                            "也开放可能修改系统的工具",
                            "Also allow tools that may modify systems",
                          )}
                          <small>
                            {bi(
                              "开启后 AI 可以直接调用它们，平台不会再让人确认；只在你信任这个服务、且工具本身有权限控制时开启。",
                              "When enabled, the assistant can invoke them directly without asking for confirmation; only enable if you trust this server and its own access controls.",
                            )}
                          </small>
                        </span>
                      </label>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Modal
        visible={!!edit}
        title={
          edit?.id
            ? bi("编辑 MCP 服务", "Edit MCP server")
            : bi("接入 MCP 服务", "Connect MCP server")
        }
        onCancel={() => setEdit(null)}
        okText={bi("保存并读取工具", "Save & load tools")}
        cancelText={bi("取消", "Cancel")}
        confirmLoading={busy === "save"}
        okButtonProps={{ disabled: !edit?.name?.trim() || !edit?.url?.trim() }}
        onOk={save}
      >
        {edit && (
          <div className="st-form">
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
                  "支持 Streamable HTTP 方式的 MCP 服务。",
                  "Supports Streamable HTTP MCP servers.",
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
    </article>
  );
}

/* ---------------------------------------------------------------- web */

type WebCfg = {
  enabled: boolean;
  provider: string;
  url?: string;
  key_enc?: string;
  allow_private: boolean;
};
type WebProvider = {
  id: string;
  name: string;
  key: boolean;
  url?: boolean;
  hint: string;
};

export function WebView() {
  const lang = useLang();
  const initWeb = cached<{ web: WebCfg; providers: WebProvider[] }>(
    "/api/settings/ai/web",
  );
  const [d, setD] = useState<{ web: WebCfg; providers: WebProvider[] } | null>(
    () => initWeb ?? null,
  );
  const [w, setW] = useState<WebCfg | null>(() => initWeb?.web ?? null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState("");
  const webBusyRef = useRef("");
  const [q, setQ] = useState("etcd database space exceeded");
  const [res, setRes] = useState<{
    results: { title: string; url: string; snippet: string }[];
    ms: number;
  } | null>(null);
  const load = () =>
    api<{ web: WebCfg; providers: WebProvider[] }>("/api/settings/ai/web")
      .then((r) => {
        putCached("/api/settings/ai/web", r);
        setD(r);
        setW(r.web);
      })
      .catch(err);
  useEffect(() => {
    let alive = true;
    api<{ web: WebCfg; providers: WebProvider[] }>("/api/settings/ai/web")
      .then((r) => {
        putCached("/api/settings/ai/web", r);
        if (!alive) return;
        setD(r);
        setW(r.web);
      })
      .catch((e) => {
        if (alive) err(e);
      });
    return () => {
      alive = false;
    };
  }, [lang]);
  const save = async (next: WebCfg) => {
    if (webBusyRef.current) return;
    webBusyRef.current = "save";
    setBusy("save");
    try {
      await api("/api/settings/ai/web", {
        method: "PUT",
        body: JSON.stringify({ ...next, key }),
      });
      setKey("");
      Message.success(bi("已保存", "Saved"));
      await load();
    } catch (e) {
      err(e);
    } finally {
      webBusyRef.current = "";
      setBusy("");
    }
  };
  const test = async () => {
    if (webBusyRef.current || !q.trim()) return;
    webBusyRef.current = "test";
    setBusy("test");
    setRes(null);
    try {
      setRes(
        await api("/api/settings/ai/web/test", {
          method: "POST",
          body: JSON.stringify({ query: q }),
        }),
      );
    } catch (e) {
      err(e);
    } finally {
      webBusyRef.current = "";
      setBusy("");
    }
  };
  const prov = d?.providers.find((p) => p.id === w?.provider);
  const dirty =
    !!w && !!d && (JSON.stringify(w) !== JSON.stringify(d.web) || !!key);
  return (
    <article className="sx-page st-main ex-page enter">
      <header className="sx-page-h">
        <div>
          <h1>{bi("联网搜索与安全核查", "Web search & security lookup")}</h1>
          <p>
            {bi(
              "开启后，对话输入框中打开「联网」即可启用 3 项内置只读联网工具：网页搜索（web_search）、网页正文读取（web_fetch）、以及官方 CVE/PyPI 软件包安全公告核查（check_package_security）。默认禁止访问内网地址。",
              "When enabled, toggling Web in chat activates 3 read-only online tools: web search (web_search), page reader (web_fetch), and official OSV/PyPI advisory lookup (check_package_security). Private/internal addresses remain blocked by default.",
            )}
          </p>
        </div>
        {w && (
          <Switch
            checked={w.enabled}
            loading={busy === "save"}
            onChange={(v) => void save({ ...w, enabled: v })}
            checkedText={bi("已开启", "On")}
            uncheckedText={bi("未开启", "Off")}
            aria-label={bi("开启联网搜索", "Enable web search")}
          />
        )}
      </header>
      {!d && <div className="st-skel" aria-label={bi("载入中", "Loading")} />}
      {d && w && (
        <>
          <section className="sx-sec">
            <h2>{bi("搜索服务", "Search provider")}</h2>
            <div
              className="wb-provs"
              role="radiogroup"
              aria-label={bi("搜索服务", "Search provider")}
            >
              {d.providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={w.provider === p.id}
                  className={w.provider === p.id ? "on" : ""}
                  onClick={() => setW({ ...w, provider: p.id })}
                >
                  <b>{p.name}</b>
                  <small>{p.hint}</small>
                </button>
              ))}
            </div>
            <div className="st-form wb-form">
              {prov?.key && (
                <div className="st-field">
                  <span>API Key</span>
                  <Input.Password
                    value={key}
                    onChange={setKey}
                    placeholder={
                      w.key_enc && d.web.provider === w.provider
                        ? bi(
                            "已保存，留空保持不变",
                            "Saved; leave blank to keep",
                          )
                        : bi(
                            "填写这个服务的 API Key",
                            "Enter API key for this provider",
                          )
                    }
                    autoComplete="new-password"
                    aria-label="API Key"
                  />
                </div>
              )}
              {prov?.url && (
                <div className="st-field">
                  <span>{bi("SearXNG 地址", "SearXNG URL")}</span>
                  <Input
                    value={w.url}
                    onChange={(v) => setW({ ...w, url: v })}
                    placeholder="http://searxng.intranet:8080"
                    aria-label={bi("SearXNG 地址", "SearXNG URL")}
                  />
                </div>
              )}
              <label className="ai-check">
                <Switch
                  size="small"
                  checked={w.allow_private}
                  onChange={(v) => setW({ ...w, allow_private: v })}
                />{" "}
                {bi(
                  "允许打开内网地址的网页（例如内部 Wiki）。开启前确认内网里没有不该让 AI 读到的页面。",
                  "Allow fetching private/internal network pages (e.g. internal Wiki). Ensure no restricted internal pages are reachable before enabling.",
                )}
              </label>
              <div>
                <Button
                  type="primary"
                  loading={busy === "save"}
                  disabled={!dirty}
                  onClick={() => save(w)}
                >
                  {bi("保存", "Save")}
                </Button>
              </div>
            </div>
          </section>
          <section className="sx-sec">
            <h2>{bi("试一下", "Test search")}</h2>
            <div className="wb-test">
              <Input
                value={q}
                onChange={setQ}
                onPressEnter={test}
                aria-label={bi("搜索词", "Search query")}
              />
              <Button loading={busy === "test"} onClick={test}>
                {bi("搜索", "Search")}
              </Button>
            </div>
            {res && (
              <ol className="wb-res">
                <p className="faint small">
                  {bi(
                    `${res.results.length} 条结果，用时 ${res.ms} ms`,
                    `${res.results.length} result${res.results.length === 1 ? "" : "s"} in ${res.ms} ms`,
                  )}
                </p>
                {res.results.map((r) => (
                  <li key={r.url}>
                    <a href={r.url} target="_blank" rel="noreferrer">
                      {r.title}
                    </a>
                    <small className="mono">{r.url}</small>
                    <p>{r.snippet}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </article>
  );
}

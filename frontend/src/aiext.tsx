import React, { useEffect, useState } from "react";
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
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [open, setOpen] = useState("");
  const [edit, setEdit] = useState<Skill | null>(null);
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState<Skill[]>([]);
  const load = () =>
    (mine
      ? api<{ skills: Skill[]; platform: Skill[] }>("/api/me/skills").then(
          (r) => {
            setSkills(
              r.skills.map((x) => ({ ...x, enabled: true, builtin: false })),
            );
            setPlatform(r.platform);
          },
        )
      : api<{ skills: Skill[] }>("/api/settings/ai/skills").then((r) =>
          setSkills(r.skills),
        )
    ).catch(err);
  useEffect(() => {
    load();
  }, [mine]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (next: Skill[]) => {
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
      setBusy(false);
    }
  };
  const builtin = mine ? platform : (skills || []).filter((s) => s.builtin);
  const custom = (skills || []).filter((s) => !s.builtin);
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
              aria-label={`编辑 ${s.title}`}
            />
            <Button
              size="small"
              status="danger"
              icon={<IconDelete />}
              onClick={() =>
                Modal.confirm({
                  title: `删除技能「${s.title}」？`,
                  okText: "删除",
                  okButtonProps: { status: "danger" },
                  onOk: () =>
                    save((skills || []).filter((x) => x.name !== s.name)),
                })
              }
              aria-label={`删除 ${s.title}`}
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
            aria-label={`启用 ${s.title}`}
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
    <article className={mine ? "me-pane enter" : "sx-page st-main enter"}>
      <header className="sx-page-h">
        <div>
          <h1>{mine ? "我的技能" : "技能"}</h1>
          <p>
            {mine
              ? "写给 AI 看的你自己的操作手册，只用在你的对话里，别人看不到。平台提供的技能你也都能用。"
              : "技能是写给 AI 看的操作手册。对话时 AI 先看到每个技能的一句话说明，遇到相关问题再读取全文，所以加再多技能也不会拖慢回答。在对话的工作过程里能看到它用了哪个技能。"}
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
          添加技能
        </Button>
      </header>
      {!skills && <div className="st-skel" aria-label="载入中" />}
      {skills && (
        <>
          {mine && (
            <section className="sx-sec">
              <h2>
                我写的 <em className="ex-n">{custom.length}</em>
              </h2>
              {custom.length === 0 ? (
                <p className="faint small">
                  还没有。可以把你负责的系统的习惯做法、常查的命令写成技能，AI
                  回答你的问题时会按它来。
                </p>
              ) : (
                <ul className="ex-list">{custom.map(row)}</ul>
              )}
            </section>
          )}
          <section className="sx-sec">
            <h2>
              {mine ? "平台提供" : "平台内置"}{" "}
              <em className="ex-n">{builtin.length}</em>
            </h2>
            <ul className="ex-list">{builtin.map(row)}</ul>
          </section>
          {!mine && (
            <section className="sx-sec">
              <h2>
                本单位的技能 <em className="ex-n">{custom.length}</em>
              </h2>
              {custom.length === 0 ? (
                <p className="faint small">
                  还没有。可以把本单位的变更规范、常见故障处理办法写成技能，AI
                  回答时会按它来。
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
            ? "编辑技能"
            : "添加技能"
        }
        onCancel={() => setEdit(null)}
        okText="保存"
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
            Message.success("已保存");
          }
        }}
        style={{ width: 720, maxWidth: "96vw" }}
      >
        {edit && (
          <div className="st-form">
            <div className="ai-two">
              <div className="st-field">
                <span>标识</span>
                <Input
                  value={edit.name}
                  onChange={(v) => setEdit({ ...edit, name: v.toLowerCase() })}
                  placeholder="change-window"
                  disabled={skills?.some(
                    (s) => s.name === edit.name && !s.builtin,
                  )}
                  aria-label="标识"
                />
                <small>小写字母开头，只用小写字母、数字和 -</small>
              </div>
              <div className="st-field">
                <span>名称</span>
                <Input
                  value={edit.title}
                  onChange={(v) => setEdit({ ...edit, title: v })}
                  placeholder="本单位变更规范"
                  maxLength={40}
                  aria-label="名称"
                />
              </div>
            </div>
            <div className="st-field">
              <span>一句话说明（AI 据此决定什么时候读取它）</span>
              <Input
                value={edit.description}
                onChange={(v) => setEdit({ ...edit, description: v })}
                maxLength={300}
                placeholder="变更窗口、审批要求和回退规范；回答涉及上线或变更时使用"
                aria-label="说明"
              />
            </div>
            <div className="st-field">
              <span>内容（Markdown）</span>
              <Input.TextArea
                value={edit.content}
                onChange={(v) => setEdit({ ...edit, content: v })}
                autoSize={{ minRows: 10, maxRows: 22 }}
                className="mono"
                aria-label="内容"
              />
              <small>不要写密码或密钥，含有这些内容的技能不能保存。</small>
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
  const base = mine ? "/api/me/mcp" : "/api/settings/ai/mcp";
  const [list, setList] = useState<MCPServer[] | null>(null);
  const [userMCP, setUserMCP] = useState<boolean | null>(null);
  const [edit, setEdit] = useState<
    (Partial<MCPServer> & { token?: string }) | null
  >(null);
  const [busy, setBusy] = useState("");
  const load = () =>
    api<{ servers: MCPServer[] }>(base)
      .then((r) => setList(r.servers))
      .catch(err);
  useEffect(() => {
    load();
    (mine
      ? api<{ user_mcp: boolean }>("/api/me")
      : api<{ no_user_mcp?: boolean }>("/api/settings/ai").then((r) => ({
          user_mcp: !r.no_user_mcp,
        }))
    )
      .then((r) => setUserMCP(r.user_mcp))
      .catch(() => undefined);
  }, [mine]); // eslint-disable-line react-hooks/exhaustive-deps
  const setAllowUsers = async (v: boolean) => {
    try {
      await api("/api/settings/ai/user-mcp", {
        method: "PUT",
        body: JSON.stringify({ allowed: v }),
      });
      setUserMCP(v);
    } catch (e) {
      err(e);
    }
  };
  const put = async (sv: MCPServer, patch: Partial<MCPServer>) => {
    try {
      await api(`${base}/${sv.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...sv, ...patch, token: "" }),
      });
      load();
    } catch (e) {
      err(e);
    }
  };
  const refresh = async (id: string) => {
    setBusy(id);
    try {
      await api(`${base}/${id}/refresh`, { method: "POST" });
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
      load();
    }
  };
  const save = async () => {
    if (!edit) return;
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
      await refresh(r.id);
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };
  return (
    <article className={mine ? "me-pane enter" : "sx-page st-main enter"}>
      <header className="sx-page-h">
        <div>
          <h1>{mine ? "我的 MCP 服务" : "MCP 服务"}</h1>
          <p>
            {mine
              ? "接入你自己常用的系统（监控、工单、CMDB 等，MCP 的 HTTP 方式），只用在你的对话里。个人接入的服务只开放只读工具。"
              : "接入外部系统提供的工具（Model Context Protocol，HTTP 方式），比如监控、工单、CMDB。AI 对话时可以调用它们查数据。默认只开放声明为只读的工具，保持「AI 只读不改」。"}
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
          接入服务
        </Button>
      </header>
      {!mine && userMCP !== null && (
        <label className="mc-users">
          <Switch
            size="small"
            checked={userMCP}
            onChange={setAllowUsers}
            aria-label="允许每个人接入自己的服务"
          />
          <span>
            允许每个人在「我的账户」里接入自己的服务
            <small>
              个人接入的服务只给他自己的对话用，只开放只读工具。平台会替他们去连这些地址。
            </small>
          </span>
        </label>
      )}
      {mine && userMCP === false && (
        <p className="note warn">
          管理员关闭了个人接入外部服务。已经接入的不再提供给 AI，可以删除。
        </p>
      )}
      {!list && <div className="st-skel" aria-label="载入中" />}
      {list && list.length === 0 && (
        <div className="st-empty">
          <IconLink />
          <b>还没有接入 MCP 服务</b>
          <span>
            填写服务的 HTTP 地址（如
            https://mcp.example.com/mcp），平台会读取它提供的工具。
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
                    <small className="mono">{sv.url}</small>
                    <small>
                      {sv.error ? (
                        <span className="bad">
                          <IconExclamationCircle /> {sv.error}
                        </span>
                      ) : sv.checked ? (
                        `${tools.length} 个工具，开放给 AI ${offered} 个 · ${ago(sv.checked)}检查`
                      ) : (
                        "还没有连接"
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
                      重新读取
                    </Button>
                    <Button
                      size="small"
                      icon={<IconEdit />}
                      onClick={() => setEdit({ ...sv, token: "" })}
                      aria-label="编辑"
                    />
                    <Button
                      size="small"
                      status="danger"
                      icon={<IconDelete />}
                      onClick={() =>
                        Modal.confirm({
                          title: `移除「${sv.name}」？`,
                          okText: "移除",
                          okButtonProps: { status: "danger" },
                          onOk: async () => {
                            await api(`${base}/${sv.id}`, { method: "DELETE" });
                            load();
                          },
                        })
                      }
                      aria-label="移除"
                    />
                    <Switch
                      checked={sv.enabled}
                      onChange={(v) => put(sv, { enabled: v })}
                      aria-label={`启用 ${sv.name}`}
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
                            aria-label={`开放 ${t.name}`}
                          />
                          <span>
                            <code>{t.name}</code>
                            {t.read_only ? (
                              <em className="ro">只读</em>
                            ) : (
                              <em className="rw">可能修改</em>
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
                          aria-label="也开放可能修改的工具"
                        />
                        <span>
                          也开放可能修改系统的工具
                          <small>
                            开启后 AI
                            可以直接调用它们，平台不会再让人确认；只在你信任这个服务、且工具本身有权限控制时开启。
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
        title={edit?.id ? "编辑 MCP 服务" : "接入 MCP 服务"}
        onCancel={() => setEdit(null)}
        okText="保存并读取工具"
        confirmLoading={busy === "save"}
        okButtonProps={{ disabled: !edit?.name?.trim() || !edit?.url?.trim() }}
        onOk={save}
      >
        {edit && (
          <div className="st-form">
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
              <small>支持 Streamable HTTP 方式的 MCP 服务。</small>
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
  const initWeb = cached<{ web: WebCfg; providers: WebProvider[] }>(
    "/api/settings/ai/web",
  );
  const [d, setD] = useState<{ web: WebCfg; providers: WebProvider[] } | null>(
    () => initWeb ?? null,
  );
  const [w, setW] = useState<WebCfg | null>(() => initWeb?.web ?? null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState("");
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
    load();
  }, []);
  const save = async (next: WebCfg) => {
    setBusy("save");
    try {
      await api("/api/settings/ai/web", {
        method: "PUT",
        body: JSON.stringify({ ...next, key }),
      });
      setKey("");
      Message.success("已保存");
      await load();
    } catch (e) {
      err(e);
    } finally {
      setBusy("");
    }
  };
  const test = async () => {
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
      setBusy("");
    }
  };
  const prov = d?.providers.find((p) => p.id === w?.provider);
  const dirty =
    !!w && !!d && (JSON.stringify(w) !== JSON.stringify(d.web) || !!key);
  return (
    <article className="sx-page st-main enter">
      <header className="sx-page-h">
        <div>
          <h1>联网搜索</h1>
          <p>
            开启后，对话输入框的「+」里可以打开联网搜索：AI
            在平台和交付里查不到时，会去网上搜官方文档、版本说明和报错含义，并能打开网页读正文。默认不允许它访问内网地址。
          </p>
        </div>
        {w && (
          <Switch
            checked={w.enabled}
            onChange={(v) => save({ ...w, enabled: v })}
            checkedText="已开启"
            uncheckedText="未开启"
            aria-label="开启联网搜索"
          />
        )}
      </header>
      {!d && <div className="st-skel" aria-label="载入中" />}
      {d && w && (
        <>
          <section className="sx-sec">
            <h2>搜索服务</h2>
            <div className="wb-provs" role="radiogroup" aria-label="搜索服务">
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
                        ? "已保存，留空保持不变"
                        : "填写这个服务的 API Key"
                    }
                    autoComplete="new-password"
                    aria-label="API Key"
                  />
                </div>
              )}
              {prov?.url && (
                <div className="st-field">
                  <span>SearXNG 地址</span>
                  <Input
                    value={w.url}
                    onChange={(v) => setW({ ...w, url: v })}
                    placeholder="http://searxng.intranet:8080"
                    aria-label="SearXNG 地址"
                  />
                </div>
              )}
              <label className="ai-check">
                <Switch
                  size="small"
                  checked={w.allow_private}
                  onChange={(v) => setW({ ...w, allow_private: v })}
                />{" "}
                允许打开内网地址的网页（例如内部
                Wiki）。开启前确认内网里没有不该让 AI 读到的页面。
              </label>
              <div>
                <Button
                  type="primary"
                  loading={busy === "save"}
                  disabled={!dirty}
                  onClick={() => save(w)}
                >
                  保存
                </Button>
              </div>
            </div>
          </section>
          <section className="sx-sec">
            <h2>试一下</h2>
            <div className="wb-test">
              <Input
                value={q}
                onChange={setQ}
                onPressEnter={test}
                aria-label="搜索词"
              />
              <Button loading={busy === "test"} onClick={test}>
                搜索
              </Button>
            </div>
            {res && (
              <ol className="wb-res">
                <p className="faint small">
                  {res.results.length} 条结果，用时 {res.ms} ms
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

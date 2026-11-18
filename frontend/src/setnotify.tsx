import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  Message,
  Modal,
  Select,
  Switch,
} from "@arco-design/web-react";
import {
  IconCheckCircleFill,
  IconCloseCircleFill,
  IconDelete,
  IconEdit,
  IconNotification,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSend,
} from "@arco-design/web-react/icon";
import { Inline } from "./aimd";
import { Segmented } from "./ui";
import { ago, api, cached, err, putCached, stamp } from "./shared";
import type { Channels, NotifyChannel } from "./shared";
import "./setnotify.css";

/* Notification settings: where messages go (channels), which events are worth a message (rules), and what each says (templates). */

const KIND_HINT: Record<string, string> = {
  webhook:
    "平台以 JSON 发送 {event, title, lines, text, link}，接到你们自己的系统里。",
  wecom: "企业微信群 → 群机器人 → 添加，复制 Webhook 地址。",
  dingtalk:
    "钉钉群 → 智能群助手 → 自定义机器人；安全设置选「加签」时填写密钥。",
  feishu: "飞书群 → 设置 → 群机器人 → 自定义机器人；开启签名校验时填写密钥。",
};

/** The vendors' marks, drawn simply in their colours. */
export function KindMark({ kind, size = 36 }: { kind: string; size?: number }) {
  const box = { width: size, height: size };
  if (kind === "wecom")
    return (
      <svg className="nk" style={box} viewBox="0 0 40 40" aria-hidden>
        <rect width="40" height="40" rx="11" fill="#2f7cf6" />
        <path
          d="M20 9c-6.3 0-11 4.1-11 9.3 0 2.6 1.2 4.9 3.3 6.5-.1 1.1-.5 2.3-1.2 3.2 1.7 0 3.2-.6 4.3-1.5 1.4.5 2.9.7 4.6.7 6.2 0 11-4.1 11-9.3S26.3 9 20 9Z"
          fill="#fff"
        />
        <circle cx="16" cy="18" r="1.4" fill="#2f7cf6" />
        <circle cx="24" cy="18" r="1.4" fill="#2f7cf6" />
      </svg>
    );
  if (kind === "dingtalk")
    return (
      <svg className="nk" style={box} viewBox="0 0 40 40" aria-hidden>
        <rect width="40" height="40" rx="11" fill="#1a9bf0" />
        <path
          d="M28.6 15.2c-.4-1.9-2.9-3.6-6.1-3.9-3.5-.3-6.7 1.1-7.3 3.7-.4 1.7.5 3.2 2 4.3l3.3 1.8h-3.6l5.3 3.6-1.2 3.6 5.6-5.9h-3.4c2.8-1.4 5.9-3.3 5.4-7.2Z"
          fill="#fff"
        />
      </svg>
    );
  if (kind === "feishu")
    return (
      <svg className="nk" style={box} viewBox="0 0 40 40" aria-hidden>
        <rect
          width="40"
          height="40"
          rx="11"
          fill="#fff"
          stroke="rgba(0,0,0,.08)"
        />
        <path
          d="M9 14.5c5.5.4 9.9 3.3 12.9 8.2 1.6-1.9 3.9-3.2 6.4-3.3 1.7-.1 3.1.3 4.2.9-1.5-3.7-5.5-8.2-12.3-9.6-3.2-.6-7.2-.3-11.2.8Z"
          fill="#00d6b9"
        />
        <path
          d="M9 14.5v9.2c0 3.9 3.2 7.1 7.1 7.1 4.5 0 8.4-2.5 9.8-6.2-3-4.2-7.4-9.7-16.9-10.1Z"
          fill="#3370ff"
        />
        <path
          d="M21.9 22.7c1.6-1.9 3.9-3.2 6.4-3.3 1.7-.1 3.1.3 4.2.9-1.4 3.8-5 6.3-8.4 6.4-1.6 0-2.4-.5-3.4-1.4.4-.9.8-1.8 1.2-2.6Z"
          fill="#133c9a"
        />
      </svg>
    );
  return (
    <svg className="nk" style={box} viewBox="0 0 40 40" aria-hidden>
      <rect width="40" height="40" rx="11" fill="#5856d6" />
      <path
        d="M15 14l-6 6 6 6M25 14l6 6-6 6M22 12l-4 16"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const EVENT_LABEL: Record<string, string> = {
  test: "测试",
};

/* ---------------------------------------------------------------- channels */

function ChannelModal({
  open,
  kinds,
  edit,
  close,
  saved,
}: {
  open: boolean;
  kinds: Record<string, string>;
  edit: NotifyChannel | null;
  close: () => void;
  saved: () => void;
}) {
  const blank: Partial<NotifyChannel> = {
    name: "",
    kind: "wecom",
    url: "",
    secret: "",
    enabled: true,
  };
  const [c, setC] = useState<Partial<NotifyChannel>>(blank);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setC(edit ? { ...edit } : blank);
  }, [open, edit]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true);
    try {
      await api(
        edit ? `/api/settings/channels/${edit.id}` : "/api/settings/channels",
        { method: edit ? "PUT" : "POST", body: JSON.stringify(c) },
      );
      Message.success(edit ? "已保存" : "已添加");
      saved();
      close();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      visible={open}
      onCancel={close}
      title={edit ? "编辑通知渠道" : "添加通知渠道"}
      onOk={save}
      confirmLoading={busy}
      okText="保存"
      okButtonProps={{ disabled: !c.name?.trim() || !c.url?.trim() }}
    >
      <div className="st-form">
        <div className="nk-pick" role="radiogroup" aria-label="类型">
          {Object.entries(kinds).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={c.kind === k}
              className={c.kind === k ? "on" : ""}
              onClick={() =>
                setC({
                  ...c,
                  kind: k as NotifyChannel["kind"],
                  name: c.name || label,
                })
              }
            >
              <KindMark kind={k} size={30} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <small className="nk-hint">{KIND_HINT[c.kind || "webhook"]}</small>
        <div className="st-field">
          <span>名称</span>
          <Input
            value={c.name}
            onChange={(v) => setC({ ...c, name: v })}
            placeholder="运维值班群"
            maxLength={40}
            aria-label="名称"
          />
        </div>
        <div className="st-field">
          <span>Webhook 地址</span>
          <Input
            value={c.url}
            onChange={(v) => setC({ ...c, url: v })}
            placeholder="https://"
            aria-label="Webhook 地址"
          />
        </div>
        {(c.kind === "dingtalk" || c.kind === "feishu") && (
          <div className="st-field">
            <span>签名密钥（可选）</span>
            <Input.Password
              value={c.secret}
              onChange={(v) => setC({ ...c, secret: v })}
              placeholder="SEC…"
              aria-label="签名密钥"
            />
          </div>
        )}
        <div className="st-field row">
          <span>启用</span>
          <Switch
            checked={!!c.enabled}
            onChange={(v) => setC({ ...c, enabled: v })}
            aria-label="启用"
          />
        </div>
      </div>
    </Modal>
  );
}

export function ChannelsView() {
  const [d, setD] = useState<Channels | null>(
    () => cached<Channels>("/api/settings/channels") ?? null,
  );
  const [error, setError] = useState("");
  const [modal, setModal] = useState<{ edit: NotifyChannel | null } | null>(
    null,
  );
  const [testing, setTesting] = useState("");
  const load = () =>
    api<Channels>("/api/settings/channels")
      .then((x) => {
        putCached("/api/settings/channels", x);
        setD(x);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);
  const test = async (c: NotifyChannel) => {
    setTesting(c.id);
    try {
      await api(`/api/settings/channels/${c.id}/test`, { method: "POST" });
      Message.success(`测试消息已发到「${c.name}」`);
    } catch (e) {
      Modal.error({ title: "发送失败", content: (e as Error).message });
    } finally {
      setTesting("");
      load();
    }
  };
  const toggle = async (c: NotifyChannel) => {
    try {
      await api(`/api/settings/channels/${c.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...c, enabled: !c.enabled }),
      });
      load();
    } catch (e) {
      err(e);
    }
  };
  const remove = (c: NotifyChannel) =>
    Modal.confirm({
      title: `删除「${c.name}」？`,
      content: "选用了它的功能将不再往这里发送。",
      okButtonProps: { status: "danger" },
      okText: "删除",
      onOk: async () => {
        try {
          await api(`/api/settings/channels/${c.id}`, { method: "DELETE" });
          load();
        } catch (e) {
          err(e);
        }
      },
    });
  const lastOf = (id: string) => d?.log.find((a) => a.channel === id);
  return (
    <article className="sx-page st-main enter">
      <header className="sx-page-h">
        <div>
          <h1>通知渠道</h1>
          <p>
            平台有消息要告诉你们时发到这里；消息怎么写，在「通知模板」里改。
          </p>
        </div>
        <Button
          type="primary"
          icon={<IconPlus />}
          onClick={() => setModal({ edit: null })}
        >
          添加渠道
        </Button>
      </header>
      {error && <div className="note warn">{error}</div>}
      {!d && !error && <div className="st-skel" aria-label="载入中" />}
      {d && d.channels.length === 0 && (
        <div className="st-empty">
          <IconNotification />
          <b>还没有通知渠道</b>
          <span>支持企业微信、钉钉、飞书群机器人，以及通用 Webhook。</span>
          <Button
            type="primary"
            icon={<IconPlus />}
            onClick={() => setModal({ edit: null })}
          >
            添加渠道
          </Button>
        </div>
      )}
      {d && d.channels.length > 0 && (
        <ul className="st-chans">
          {d.channels.map((c) => {
            const last = lastOf(c.id);
            return (
              <li key={c.id} className={c.enabled ? "" : "off"}>
                <KindMark kind={c.kind} size={40} />
                <span className="st-chan-main">
                  <b>{c.name}</b>
                  <small>
                    {d.kinds[c.kind]} ·{" "}
                    <span className="mono">
                      {c.url.replace(/^(https?:\/\/[^/]+).*$/, "$1/…")}
                    </span>
                  </small>
                </span>
                <span className="st-last">
                  {last ? (
                    <span
                      className={last.ok ? "ok" : "bad"}
                      title={last.error || stamp(last.at)}
                    >
                      {last.ok ? (
                        <IconCheckCircleFill />
                      ) : (
                        <IconCloseCircleFill />
                      )}{" "}
                      {ago(last.at)}
                      {last.ok ? "送达" : "失败"}
                    </span>
                  ) : (
                    <span className="faint">还没发过</span>
                  )}
                </span>
                <Switch
                  checked={c.enabled}
                  onChange={() => toggle(c)}
                  aria-label={`启用 ${c.name}`}
                />
                <span className="row-gap">
                  <Button
                    size="small"
                    icon={<IconSend />}
                    loading={testing === c.id}
                    onClick={() => test(c)}
                  >
                    发送测试
                  </Button>
                  <Button
                    size="small"
                    icon={<IconEdit />}
                    aria-label="编辑"
                    onClick={() => setModal({ edit: c })}
                  />
                  <Button
                    size="small"
                    icon={<IconDelete />}
                    status="danger"
                    aria-label="删除"
                    onClick={() => remove(c)}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {d && d.log.length > 0 && (
        <section className="sx-sec">
          <h2>发送记录</h2>
          <ul className="st-log">
            {d.log.slice(0, 50).map((a, i) => (
              <li key={i}>
                <span className="num faint">{stamp(a.at)}</span>
                <span className={a.ok ? "ok" : "bad"}>
                  {a.ok ? <IconCheckCircleFill /> : <IconCloseCircleFill />}
                </span>
                <span className="st-ev">{EVENT_LABEL[a.event] || a.event}</span>
                <b>{a.name}</b>
                <span className="st-log-t">{a.ok ? a.title : a.error}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ChannelModal
        open={!!modal}
        kinds={d?.kinds || {}}
        edit={modal?.edit || null}
        close={() => setModal(null)}
        saved={load}
      />
    </article>
  );
}

/* ---------------------------------------------------------------- templates */

type Tpl = { title: string; body: string };
type NEvent = {
  id: string;
  group: string;
  title: string;
  desc: string;
  vars: { key: string; desc: string }[];
  default: Tpl;
  sample: Record<string, string>;
};

const fill = (t: string, v: Record<string, string>) =>
  t.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in v ? v[k] : m));

const BOT: Record<string, { name: string; hint: string }> = {
  wecom: {
    name: "企业微信",
    hint: "以 Markdown 消息发出：标题加粗，每行是一条引用，末尾带「在平台中查看」链接",
  },
  dingtalk: {
    name: "钉钉",
    hint: "以 Markdown 消息发出：标题加粗，每行是一条引用，末尾带「在平台中查看」链接",
  },
  feishu: {
    name: "飞书",
    hint: "以纯文本消息发出：标题一行，后面每行一条，最后是链接",
  },
  webhook: {
    name: "Webhook",
    hint: "以 JSON 发给你们自己的系统，标题、行和合成的文本都在里面",
  },
};

/** The text of a template, coloured as it is typed: {{variables}} (known ones tinted, unknown ones flagged) and the
 *  Markdown the robots understand (bold, `code`, links, > quotes, # headings, - lists). Only colour changes, never
 *  weight or size, so the text behind lines up exactly with the field in front. */
const MD_TOKEN =
  /(\{\{\w+\}\}|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s)]+)/g;
function Marked({ text, known }: { text: string; known: Set<string> }) {
  return (
    <>
      {text.split("\n").map((line, n) => {
        const lead =
          /^(\s*(?:#{1,6}\s|>\s?|[-*+]\s|\d+\.\s))/.exec(line)?.[1] || "";
        const kind = lead.includes("#")
          ? "h"
          : lead.includes(">")
            ? "q"
            : lead
              ? "li"
              : "";
        const rest = line.slice(lead.length);
        return (
          <React.Fragment key={n}>
            {lead && <span className={`md-${kind}`}>{lead}</span>}
            {rest.split(MD_TOKEN).map((p, i) => {
              const v = /^\{\{(\w+)\}\}$/.exec(p);
              if (v)
                return (
                  <mark key={i} className={known.has(v[1]) ? "ok" : "bad"}>
                    {p}
                  </mark>
                );
              if (p.startsWith("**"))
                return (
                  <span key={i} className="md-b">
                    {p}
                  </span>
                );
              if (p.startsWith("`"))
                return (
                  <span key={i} className="md-c">
                    {p}
                  </span>
                );
              if (p.startsWith("[") || p.startsWith("http"))
                return (
                  <span key={i} className="md-a">
                    {p}
                  </span>
                );
              return (
                <span key={i} className={kind ? `md-${kind}t` : undefined}>
                  {p}
                </span>
              );
            })}
            {"\n"}
          </React.Fragment>
        );
      })}
    </>
  );
}

/** What a message will look like where it lands, for the kind of channel it goes to. */
function Delivered({
  kind,
  title,
  lines,
  link,
}: {
  kind: string;
  title: string;
  lines: string[];
  link: string;
}) {
  if (kind === "webhook") {
    const text = [title, ...lines].join("\n");
    return (
      <pre className="tp-json mono">
        {JSON.stringify(
          {
            event: "test",
            title,
            lines,
            text: link ? `${text}\n${link}` : text,
            link,
            at: new Date().toISOString(),
            source: "middleware-hub",
          },
          null,
          2,
        )}
      </pre>
    );
  }
  if (kind === "feishu")
    return (
      <div className="tp-bot feishu">
        <span className="tp-av">飞</span>
        <div className="tp-bubble plain">
          {[title, ...lines, link].filter(Boolean).map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
      </div>
    );
  return (
    <div className={`tp-bot ${kind}`}>
      <span className="tp-av">{kind === "dingtalk" ? "钉" : "企"}</span>
      <div className="tp-bubble">
        <b>{title || "（标题为空）"}</b>
        {lines.map((l, i) => (
          <blockquote key={i}>
            <Inline text={l} />
          </blockquote>
        ))}
        {link && <a>在平台中查看</a>}
      </div>
    </div>
  );
}

export function TemplatesView() {
  const initChans = cached<Channels>("/api/settings/channels");
  const [d, setD] = useState<{
    events: NEvent[];
    custom: Record<string, Tpl>;
  } | null>(() => cached("/api/settings/templates") ?? null);
  const [channels, setChannels] = useState<NotifyChannel[]>(
    () => initChans?.channels ?? [],
  );
  const [sel, setSel] = useState("test");
  const [drafts, setDrafts] = useState<Record<string, Tpl>>({});
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [kind, setKind] = useState<string>(() => {
    const first =
      initChans?.channels.find((c) => c.enabled) || initChans?.channels[0];
    return first ? first.kind : "wecom";
  });
  const [q, setQ] = useState("");
  const body = useRef<HTMLTextAreaElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState<"title" | "body">("body");
  const load = () =>
    api<NonNullable<typeof d>>("/api/settings/templates")
      .then((r) => {
        putCached("/api/settings/templates", r);
        setD(r);
      })
      .catch((e) => err(e));
  useEffect(() => {
    load();
    api<Channels>("/api/settings/channels")
      .then((r) => {
        putCached("/api/settings/channels", r);
        setChannels(r.channels);
        const first = r.channels.find((c) => c.enabled) || r.channels[0];
        if (first) setKind(first.kind);
      })
      .catch(() => undefined);
  }, []);
  const ev = d?.events.find((e) => e.id === sel);
  const saved = (id: string): Tpl =>
    d?.custom[id] ||
    d?.events.find((e) => e.id === id)?.default || { title: "", body: "" };
  const draft: Tpl = drafts[sel] ?? saved(sel);
  const setDraft = (t: Tpl) => setDrafts((x) => ({ ...x, [sel]: t }));
  const isDirty = (id: string) =>
    !!drafts[id] &&
    (drafts[id].title !== saved(id).title ||
      drafts[id].body !== saved(id).body);
  const dirty = isDirty(sel);
  const custom = d?.custom[sel];
  const known = useMemo(() => new Set(ev?.vars.map((v) => v.key) || []), [ev]);
  const unknown = useMemo(
    () =>
      [
        ...new Set(
          [...(draft.title + draft.body).matchAll(/\{\{(\w+)\}\}/g)].map(
            (m) => m[1],
          ),
        ),
      ].filter((k) => !known.has(k)),
    [draft, known],
  );
  const vars = ev
    ? { ...ev.sample, channel: ev.sample.channel || "运维值班群" }
    : {};
  const preview = useMemo(
    () => ({
      title: fill(draft.title, vars),
      lines: fill(draft.body, vars)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && l !== (vars as Record<string, string>).link),
    }),
    [ev, draft], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const insert = (key: string) => {
    const tag = `{{${key}}}`;
    if (focus === "title") {
      const el = title.current;
      const at = el?.selectionStart ?? draft.title.length;
      setDraft({
        ...draft,
        title:
          draft.title.slice(0, at) +
          tag +
          draft.title.slice(el?.selectionEnd ?? at),
      });
      window.setTimeout(() => {
        el?.focus();
        el?.setSelectionRange(at + tag.length, at + tag.length);
      }, 0);
    } else {
      const el = body.current;
      const at = el?.selectionStart ?? draft.body.length;
      setDraft({
        ...draft,
        body:
          draft.body.slice(0, at) +
          tag +
          draft.body.slice(el?.selectionEnd ?? at),
      });
      window.setTimeout(() => {
        el?.focus();
        el?.setSelectionRange(at + tag.length, at + tag.length);
      }, 0);
    }
  };
  // formatting around the selection in the body, or at the start of its lines
  const wrap = (open: string, close: string, hint: string) => {
    const el = body.current;
    if (!el) return;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    const chosen = draft.body.slice(a, b) || hint;
    setDraft({
      ...draft,
      body:
        draft.body.slice(0, a) + open + chosen + close + draft.body.slice(b),
    });
    window.setTimeout(() => {
      el.focus();
      el.setSelectionRange(a + open.length, a + open.length + chosen.length);
    }, 0);
  };
  const lead = (mark: string) => {
    const el = body.current;
    if (!el) return;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    const from = draft.body.lastIndexOf("\n", a - 1) + 1;
    const block = draft.body
      .slice(from, b)
      .split("\n")
      .map((l) => (l.startsWith(mark) ? l : mark + l))
      .join("\n");
    setDraft({
      ...draft,
      body: draft.body.slice(0, from) + block + draft.body.slice(b),
    });
    window.setTimeout(() => el.focus(), 0);
  };
  const save = async (reset = false) => {
    setBusy(true);
    try {
      await api(`/api/settings/templates/${sel}`, {
        method: "PUT",
        body: JSON.stringify(reset ? { title: "", body: "" } : draft),
      });
      Message.success(reset ? "已恢复默认" : "已保存");
      setDrafts((x) => {
        const n = { ...x };
        delete n[sel];
        return n;
      });
      await load();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const sendTest = async () => {
    if (!target) return Message.warning("先选一个渠道");
    try {
      await api(`/api/settings/templates/${sel}/test`, {
        method: "POST",
        body: JSON.stringify({ channel: target }),
      });
      Message.success("示例消息已发出");
    } catch (e) {
      Modal.error({ title: "发送失败", content: (e as Error).message });
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "s" &&
        dirty &&
        !busy &&
        unknown.length === 0
      ) {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const t = q.trim().toLowerCase();
  const shown = (d?.events || []).filter(
    (e) => !t || `${e.title} ${e.desc} ${e.group}`.toLowerCase().includes(t),
  );
  const groups = [...new Set(shown.map((e) => e.group))];
  const link = (vars as Record<string, string>).link || "";
  return (
    <article className="tp2 enter">
      {!d ? (
        <div className="st-skel" aria-label="载入中" />
      ) : (
        <>
          <aside className="tp2-list" aria-label="消息类型">
            <header>
              <h1>通知模板</h1>
              <p>每类消息的标题和正文都可以改，对所有渠道生效。</p>
            </header>
            <Input
              prefix={<IconSearch />}
              allowClear
              placeholder="搜索消息类型"
              value={q}
              onChange={setQ}
              aria-label="搜索消息类型"
            />
            <div className="tp2-items" role="listbox">
              {groups.map((g) => (
                <div key={g}>
                  <div className="tp-g">{g}</div>
                  {shown
                    .filter((e) => e.group === g)
                    .map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        role="option"
                        aria-selected={e.id === sel}
                        className={e.id === sel ? "on" : ""}
                        onClick={() => setSel(e.id)}
                      >
                        <span>
                          <b>{e.title}</b>
                          <small>{e.desc}</small>
                        </span>
                        {isDirty(e.id) ? (
                          <i className="tp2-dot" title="有没保存的修改" />
                        ) : d.custom[e.id] ? (
                          <em>已自定义</em>
                        ) : null}
                      </button>
                    ))}
                </div>
              ))}
              {shown.length === 0 && (
                <p className="faint small tp2-none">没有匹配的消息类型</p>
              )}
            </div>
          </aside>
          {ev && (
            <>
              <section className="tp2-edit" key={sel}>
                <header className="tp2-h">
                  <div>
                    <h2>{ev.title}</h2>
                    <p>{ev.desc}</p>
                  </div>
                  <span className="row-gap">
                    <Button
                      icon={<IconRefresh />}
                      disabled={!custom || busy}
                      onClick={() => save(true)}
                    >
                      恢复默认
                    </Button>
                    <Button
                      type="primary"
                      loading={busy}
                      disabled={!dirty || unknown.length > 0}
                      onClick={() => save()}
                    >
                      保存
                    </Button>
                  </span>
                </header>
                <div className="tp2-field">
                  <label htmlFor="tp-title">标题</label>
                  <div className="tp2-code one">
                    <pre aria-hidden>
                      <Marked text={draft.title} known={known} />
                    </pre>
                    <input
                      id="tp-title"
                      ref={title}
                      value={draft.title}
                      onChange={(e) =>
                        setDraft({ ...draft, title: e.target.value })
                      }
                      onFocus={() => setFocus("title")}
                      maxLength={120}
                      spellCheck={false}
                      aria-label="标题"
                    />
                  </div>
                </div>
                <div className="tp2-field">
                  <label htmlFor="tp-body">
                    正文<small>每行一条消息内容；空行会被去掉</small>
                  </label>
                  <div className="tp2-tools" role="toolbar" aria-label="格式">
                    <button
                      type="button"
                      onClick={() => wrap("**", "**", "加粗的文字")}
                      title="加粗"
                    >
                      <b>B</b>
                    </button>
                    <button
                      type="button"
                      onClick={() => wrap("`", "`", "代码")}
                      title="代码"
                    >
                      <code>&lt;/&gt;</code>
                    </button>
                    <button
                      type="button"
                      onClick={() => wrap("[", "](https://)", "链接文字")}
                      title="链接"
                    >
                      链接
                    </button>
                    <button
                      type="button"
                      onClick={() => lead("> ")}
                      title="引用"
                    >
                      引用
                    </button>
                    <button
                      type="button"
                      onClick={() => lead("- ")}
                      title="列表"
                    >
                      列表
                    </button>
                    <button
                      type="button"
                      onClick={() => lead("## ")}
                      title="标题"
                    >
                      标题
                    </button>
                    <small>
                      企业微信和钉钉按 Markdown 显示这些格式；飞书和 Webhook
                      里会原样显示符号。
                    </small>
                  </div>
                  <div className="tp2-code">
                    <pre aria-hidden>
                      <Marked text={draft.body} known={known} />
                    </pre>
                    <textarea
                      id="tp-body"
                      ref={body}
                      value={draft.body}
                      onChange={(e) =>
                        setDraft({ ...draft, body: e.target.value })
                      }
                      onFocus={() => setFocus("body")}
                      maxLength={2000}
                      spellCheck={false}
                      aria-label="正文"
                    />
                  </div>
                  <div className="tp2-meta">
                    <span>
                      {draft.body.split("\n").filter((l) => l.trim()).length} 行
                      · {draft.body.length} / 2000 字
                    </span>
                    {unknown.length > 0 && (
                      <span className="bad">
                        没有这些变量：
                        {unknown.map((u) => `{{${u}}}`).join("、")}
                        ，需要改掉才能保存
                      </span>
                    )}
                  </div>
                </div>
                <div className="tp2-vars">
                  <span>变量：点一下，插入到光标处</span>
                  <div>
                    {ev.vars.map((v) => (
                      <button
                        key={v.key}
                        type="button"
                        onClick={() => insert(v.key)}
                        title={`${v.desc}\n示例：${vars[v.key as keyof typeof vars] ?? ""}`}
                      >
                        <code>{`{{${v.key}}}`}</code>
                        <small>{v.desc}</small>
                      </button>
                    ))}
                  </div>
                </div>
              </section>
              <aside className="tp2-prev" aria-label="预览">
                <div className="tp2-prev-h">
                  <b>预览</b>
                  <small>用示例数据</small>
                </div>
                <Segmented
                  size="sm"
                  label="渠道类型"
                  value={kind}
                  onChange={setKind}
                  options={Object.entries(BOT).map(([k, v]) => ({
                    value: k,
                    label: v.name,
                  }))}
                />
                <div className="tp2-stage">
                  <Delivered
                    kind={kind}
                    title={preview.title}
                    lines={preview.lines}
                    link={link}
                  />
                </div>
                <p className="tp2-how">{BOT[kind].hint}</p>
                <div className="tp2-send">
                  <Select
                    placeholder="选一个渠道，发一条示例"
                    value={target || undefined}
                    onChange={setTarget}
                    options={channels.map((c) => ({
                      value: c.id,
                      label: c.name,
                    }))}
                    triggerProps={{
                      autoAlignPopupWidth: false,
                      autoFitPosition: true,
                      position: "tl",
                    }}
                    aria-label="示例发到哪个渠道"
                  />
                  <Button
                    icon={<IconSend />}
                    onClick={sendTest}
                    disabled={!target}
                  >
                    发送示例
                  </Button>
                </div>
                {dirty && (
                  <small className="faint">
                    发出去的是已保存的模板，先保存再发。
                  </small>
                )}
              </aside>
            </>
          )}
        </>
      )}
    </article>
  );
}

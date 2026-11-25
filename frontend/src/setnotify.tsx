import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { bi, useLang } from "./i18n";
import "./setnotify.css";

/* Notification settings: where messages go (channels), which events are worth a message (rules), and what each says (templates). */

const KIND_HINT: Record<string, string> = {
  get webhook() {
    return bi(
      "平台以 JSON 发送 {event, title, lines, text, link}，接到你们自己的系统里。",
      "Posts JSON payload {event, title, lines, text, link} directly to your endpoint.",
    );
  },
  get wecom() {
    return bi(
      "企业微信群 → 群机器人 → 添加，复制 Webhook 地址。",
      "WeCom Group → Group Bots → Add, then copy the Webhook URL.",
    );
  },
  get dingtalk() {
    return bi(
      "钉钉群 → 智能群助手 → 自定义机器人；安全设置选「加签」时填写密钥。",
      "DingTalk Group → Smart Group Assistant → Custom Bot; enter the signing secret if “Sign” security is enabled.",
    );
  },
  get feishu() {
    return bi(
      "飞书群 → 设置 → 群机器人 → 自定义机器人；开启签名校验时填写密钥。",
      "Feishu Group → Settings → Bots → Custom Bot; enter the secret if signature verification is enabled.",
    );
  },
};

const kindName = (k: string, raw?: string) =>
  k === "webhook"
    ? bi("通用 Webhook", "Generic Webhook")
    : k === "wecom"
      ? bi("企业微信机器人", "WeCom Bot")
      : k === "dingtalk"
        ? bi("钉钉机器人", "DingTalk Bot")
        : k === "feishu"
          ? bi("飞书机器人", "Feishu Bot")
          : raw || k;

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
      <rect
        x="0.75"
        y="0.75"
        width="38.5"
        height="38.5"
        rx="10.25"
        fill="#1d1c1a"
        stroke="rgba(255,255,255,.22)"
        strokeWidth="1.5"
      />
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
  get test() {
    return bi("测试", "Test");
  },
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
  useLang();
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
    if (busy || !c.name?.trim() || !c.url?.trim()) return;
    setBusy(true);
    try {
      await api(
        edit ? `/api/settings/channels/${edit.id}` : "/api/settings/channels",
        { method: edit ? "PUT" : "POST", body: JSON.stringify(c) },
      );
      Message.success(edit ? bi("已保存", "Saved") : bi("已添加", "Added"));
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
      title={
        edit
          ? bi("编辑通知渠道", "Edit Notification Channel")
          : bi("添加通知渠道", "Add Notification Channel")
      }
      onOk={save}
      confirmLoading={busy}
      okText={bi("保存", "Save")}
      cancelText={bi("取消", "Cancel")}
      okButtonProps={{ disabled: !c.name?.trim() || !c.url?.trim() }}
    >
      <div className="st-form">
        <div
          className="nk-pick"
          role="radiogroup"
          aria-label={bi("类型", "Type")}
        >
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
                  name: c.name || kindName(k, label),
                })
              }
            >
              <KindMark kind={k} size={30} />
              <span>{kindName(k, label)}</span>
            </button>
          ))}
        </div>
        <small className="nk-hint">{KIND_HINT[c.kind || "webhook"]}</small>
        <div className="st-field">
          <span>{bi("名称", "Name")}</span>
          <Input
            value={c.name}
            onChange={(v) => setC({ ...c, name: v })}
            placeholder={bi("运维值班群", "Ops On-Call")}
            maxLength={40}
            aria-label={bi("名称", "Name")}
          />
        </div>
        <div className="st-field">
          <span>{bi("Webhook 地址", "Webhook URL")}</span>
          <Input
            value={c.url}
            onChange={(v) => setC({ ...c, url: v })}
            placeholder="https://"
            aria-label={bi("Webhook 地址", "Webhook URL")}
          />
        </div>
        {(c.kind === "dingtalk" || c.kind === "feishu") && (
          <div className="st-field">
            <span>{bi("签名密钥（可选）", "Signing Secret (Optional)")}</span>
            <Input.Password
              value={c.secret}
              onChange={(v) => setC({ ...c, secret: v })}
              placeholder="SEC…"
              aria-label={bi("签名密钥", "Signing secret")}
            />
          </div>
        )}
        <div className="st-field row">
          <span>{bi("启用", "Enabled")}</span>
          <Switch
            checked={!!c.enabled}
            onChange={(v) => setC({ ...c, enabled: v })}
            aria-label={bi("启用", "Enabled")}
          />
        </div>
      </div>
    </Modal>
  );
}

export function ChannelsView() {
  const lang = useLang();
  const [d, setD] = useState<Channels | null>(
    () => cached<Channels>("/api/settings/channels") ?? null,
  );
  const [error, setError] = useState("");
  const [modal, setModal] = useState<{ edit: NotifyChannel | null } | null>(
    null,
  );
  const [testing, setTesting] = useState("");
  const [togglingId, setTogglingId] = useState("");
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const load = useCallback(
    () =>
      api<Channels>("/api/settings/channels")
        .then((x) => {
          putCached("/api/settings/channels", x);
          if (!mountedRef.current) return;
          setD(x);
          setError("");
        })
        .catch((e) => {
          if (mountedRef.current) setError((e as Error).message);
        }),
    [],
  );
  useEffect(() => {
    void load();
  }, [lang, load]);
  const test = async (c: NotifyChannel) => {
    if (testing) return;
    setTesting(c.id);
    try {
      await api(`/api/settings/channels/${c.id}/test`, { method: "POST" });
      Message.success(
        bi(`测试消息已发到「${c.name}」`, `Test message sent to “${c.name}”`),
      );
    } catch (e) {
      Modal.error({
        title: bi("发送失败", "Send Failed"),
        content: (e as Error).message,
      });
    } finally {
      if (mountedRef.current) setTesting("");
      void load();
    }
  };
  const toggle = async (c: NotifyChannel) => {
    if (togglingId) return;
    setTogglingId(c.id);
    try {
      await api(`/api/settings/channels/${c.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...c, enabled: !c.enabled }),
      });
      await load();
    } catch (e) {
      err(e);
    } finally {
      if (mountedRef.current) setTogglingId("");
    }
  };
  const remove = (c: NotifyChannel) => {
    let deleting = false;
    Modal.confirm({
      title: bi(`删除「${c.name}」？`, `Delete “${c.name}”?`),
      content: bi(
        "选用了它的功能将不再往这里发送。",
        "Features using this channel will no longer send notifications here.",
      ),
      okButtonProps: { status: "danger" },
      okText: bi("删除", "Delete"),
      cancelText: bi("取消", "Cancel"),
      onOk: async () => {
        if (deleting) return;
        deleting = true;
        try {
          await api(`/api/settings/channels/${c.id}`, { method: "DELETE" });
          await load();
        } catch (e) {
          err(e);
        } finally {
          deleting = false;
        }
      },
    });
  };
  const lastOf = (id: string) => d?.log.find((a) => a.channel === id);
  return (
    <article className="sx-page st-main enter">
      <header className="sx-page-h">
        <div>
          <h1>{bi("通知渠道", "Notification Channels")}</h1>
          <p>
            {bi(
              "平台有消息要告诉你们时发到这里；消息怎么写，在「通知模板」里改。",
              "Platform alerts are delivered to these channels; customize message wording under Notification Templates.",
            )}
          </p>
        </div>
        <Button
          type="primary"
          icon={<IconPlus />}
          onClick={() => setModal({ edit: null })}
        >
          {bi("添加渠道", "Add Channel")}
        </Button>
      </header>
      {error && <div className="note warn">{error}</div>}
      {!d && !error && (
        <div className="st-skel" aria-label={bi("载入中", "Loading")} />
      )}
      {d && d.channels.length === 0 && (
        <div className="st-empty">
          <IconNotification />
          <b>{bi("还没有通知渠道", "No notification channels yet")}</b>
          <span>
            {bi(
              "支持企业微信、钉钉、飞书群机器人，以及通用 Webhook。",
              "Supports WeCom, DingTalk, Feishu group bots, and generic Webhooks.",
            )}
          </span>
          <Button
            type="primary"
            icon={<IconPlus />}
            onClick={() => setModal({ edit: null })}
          >
            {bi("添加渠道", "Add Channel")}
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
                  <b title={c.name}>{c.name}</b>
                  <small title={c.url}>
                    {kindName(c.kind, d.kinds[c.kind])} ·{" "}
                    <span className="mono">
                      {(c.url || "").replace(/^(https?:\/\/[^/]+).*$/, "$1/…")}
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
                      {ago(last.at)}{" "}
                      {last.ok
                        ? bi("送达", "delivered")
                        : bi("失败", "failed")}
                    </span>
                  ) : (
                    <span className="faint">
                      {bi("还没发过", "Not sent yet")}
                    </span>
                  )}
                </span>
                <Switch
                  checked={c.enabled}
                  loading={togglingId === c.id}
                  disabled={Boolean(togglingId) && togglingId !== c.id}
                  onChange={() => void toggle(c)}
                  aria-label={bi(`启用 ${c.name}`, `Enable ${c.name}`)}
                />
                <span className="row-gap">
                  <Button
                    size="small"
                    icon={<IconSend />}
                    loading={testing === c.id}
                    disabled={Boolean(testing) && testing !== c.id}
                    onClick={() => void test(c)}
                  >
                    {bi("发送测试", "Send Test")}
                  </Button>
                  <Button
                    size="small"
                    icon={<IconEdit />}
                    aria-label={bi("编辑", "Edit")}
                    onClick={() => setModal({ edit: c })}
                  />
                  <Button
                    size="small"
                    icon={<IconDelete />}
                    status="danger"
                    aria-label={bi("删除", "Delete")}
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
          <h2>{bi("发送记录", "Delivery Log")}</h2>
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

const BOT: Record<string, { readonly name: string; readonly hint: string }> = {
  wecom: {
    get name() {
      return bi("企业微信", "WeCom");
    },
    get hint() {
      return bi(
        "以 Markdown 消息发出：标题加粗，每行是一条引用，末尾带「在平台中查看」链接",
        "Sent as Markdown: bold title, each line formatted as a blockquote, ending with a “View in Platform” link",
      );
    },
  },
  dingtalk: {
    get name() {
      return bi("钉钉", "DingTalk");
    },
    get hint() {
      return bi(
        "以 Markdown 消息发出：标题加粗，每行是一条引用，末尾带「在平台中查看」链接",
        "Sent as Markdown: bold title, each line formatted as a blockquote, ending with a “View in Platform” link",
      );
    },
  },
  feishu: {
    get name() {
      return bi("飞书", "Feishu");
    },
    get hint() {
      return bi(
        "以纯文本消息发出：标题一行，后面每行一条，最后是链接",
        "Sent as plain text: title on the first line, followed by body lines and link",
      );
    },
  },
  webhook: {
    name: "Webhook",
    get hint() {
      return bi(
        "以 JSON 发给你们自己的系统，标题、行和合成的文本都在里面",
        "Posts JSON to your endpoint containing title, lines, and combined text",
      );
    },
  },
};

const evGroup = (g: string) => (g === "系统" ? bi("系统", "System") : g);
const evTitle = (e: NEvent) =>
  e.id === "test" ? bi("测试消息", "Test Message") : e.title;
const evDesc = (e: NEvent) =>
  e.id === "test"
    ? bi(
        "在渠道里点“发送测试”时发出的消息。",
        "Message sent when clicking “Send Test” on a notification channel.",
      )
    : e.desc;
const varDesc = (v: { key: string; desc: string }) =>
  v.key === "channel"
    ? bi("渠道名称", "Channel name")
    : v.key === "link"
      ? bi("平台地址", "Platform URL")
      : v.desc;

/** The text of a template, coloured as it is typed: {{variables}} (known ones tinted, unknown ones flagged) and the
 *  Markdown the robots understand (bold, `code`, links, > quotes, # headings, - lists). Only colour changes, never
 *  weight or size, so the text behind lines up exactly with the field in front. */
const MD_TOKEN =
  /(\{\{\w+\}\}|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s)]+)/g;
const Marked = React.memo(function Marked({
  text,
  known,
}: {
  text: string;
  known: Set<string>;
}) {
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
});

const SAMPLE_WEBHOOK_AT = "2026-01-15T08:30:00Z";

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
  useLang();
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
            at: SAMPLE_WEBHOOK_AT,
            source: "kyndryl-delivery-studio",
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
        <span className="tp-av">{bi("飞", "F")}</span>
        <div className="tp-bubble plain">
          {[title, ...lines, link].filter(Boolean).map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
      </div>
    );
  return (
    <div className={`tp-bot ${kind}`}>
      <span className="tp-av">
        {kind === "dingtalk" ? bi("钉", "D") : bi("企", "W")}
      </span>
      <div className="tp-bubble">
        <b>{title || bi("（标题为空）", "(Empty title)")}</b>
        {lines.map((l, i) => (
          <blockquote key={i}>
            <Inline text={l} />
          </blockquote>
        ))}
        {link && <a>{bi("在平台中查看", "View in Platform")}</a>}
      </div>
    </div>
  );
}

export function TemplatesView() {
  const lang = useLang();
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
  const [sendingTest, setSendingTest] = useState(false);
  const [target, setTarget] = useState("");
  const [kind, setKind] = useState<string>(() => {
    const first =
      initChans?.channels.find((c) => c.enabled) || initChans?.channels[0];
    return first ? first.kind : "wecom";
  });
  const [q, setQ] = useState("");
  const body = useRef<HTMLTextAreaElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const titlePre = useRef<HTMLPreElement>(null);
  const titleRafRef = useRef<number | null>(null);
  const caretTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const [focus, setFocus] = useState<"title" | "body">("body");
  const syncTitleScrollNow = useCallback((el?: HTMLInputElement | null) => {
    const input = el ?? title.current;
    if (input && titlePre.current) {
      titlePre.current.scrollLeft = input.scrollLeft;
    }
  }, []);
  const syncTitleScroll = useCallback(
    (el?: HTMLInputElement | null) => {
      if (titleRafRef.current !== null) {
        window.cancelAnimationFrame(titleRafRef.current);
      }
      titleRafRef.current = window.requestAnimationFrame(() => {
        titleRafRef.current = null;
        syncTitleScrollNow(el);
      });
    },
    [syncTitleScrollNow],
  );
  const scheduleCaretTask = useCallback((fn: () => void) => {
    if (caretTimerRef.current !== null) {
      window.clearTimeout(caretTimerRef.current);
    }
    caretTimerRef.current = window.setTimeout(() => {
      caretTimerRef.current = null;
      fn();
    }, 0);
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (titleRafRef.current !== null) {
        window.cancelAnimationFrame(titleRafRef.current);
      }
      if (caretTimerRef.current !== null) {
        window.clearTimeout(caretTimerRef.current);
      }
    };
  }, []);
  const load = useCallback(
    () =>
      api<NonNullable<typeof d>>("/api/settings/templates")
        .then((r) => {
          putCached("/api/settings/templates", r);
          if (mountedRef.current) setD(r);
        })
        .catch((e) => {
          if (mountedRef.current) err(e);
        }),
    [],
  );
  useEffect(() => {
    void load();
    api<Channels>("/api/settings/channels")
      .then((r) => {
        putCached("/api/settings/channels", r);
        if (!mountedRef.current) return;
        setChannels(r.channels);
        const first = r.channels.find((c) => c.enabled) || r.channels[0];
        if (first) setKind(first.kind);
      })
      .catch(() => undefined);
  }, [lang, load]);
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
    ? {
        ...ev.sample,
        channel:
          ev.sample.channel === "运维值班群"
            ? bi("运维值班群", "Ops On-Call")
            : ev.sample.channel || bi("运维值班群", "Ops On-Call"),
      }
    : {};
  const preview = useMemo(
    () => ({
      title: fill(draft.title, vars),
      lines: fill(draft.body, vars)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && l !== (vars as Record<string, string>).link),
    }),
    [ev, draft, lang], // eslint-disable-line react-hooks/exhaustive-deps
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
      scheduleCaretTask(() => {
        el?.focus();
        el?.setSelectionRange(at + tag.length, at + tag.length);
        syncTitleScroll(el);
      });
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
      scheduleCaretTask(() => {
        el?.focus();
        el?.setSelectionRange(at + tag.length, at + tag.length);
      });
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
    scheduleCaretTask(() => {
      el.focus();
      el.setSelectionRange(a + open.length, a + open.length + chosen.length);
    });
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
    scheduleCaretTask(() => el.focus());
  };
  const save = async (reset = false) => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/settings/templates/${sel}`, {
        method: "PUT",
        body: JSON.stringify(reset ? { title: "", body: "" } : draft),
      });
      Message.success(
        reset ? bi("已恢复默认", "Restored to default") : bi("已保存", "Saved"),
      );
      setDrafts((x) => {
        const n = { ...x };
        delete n[sel];
        return n;
      });
      await load();
    } catch (e) {
      err(e);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };
  const sendTest = async () => {
    if (sendingTest) return;
    if (!target)
      return Message.warning(bi("先选一个渠道", "Select a channel first"));
    setSendingTest(true);
    try {
      await api(`/api/settings/templates/${sel}/test`, {
        method: "POST",
        body: JSON.stringify({ channel: target }),
      });
      Message.success(bi("示例消息已发出", "Sample message sent"));
    } catch (e) {
      Modal.error({
        title: bi("发送失败", "Send Failed"),
        content: (e as Error).message,
      });
    } finally {
      if (mountedRef.current) setSendingTest(false);
    }
  };
  const shortcutStateRef = useRef({ dirty, busy, hasUnknown: unknown.length > 0, save });
  shortcutStateRef.current = { dirty, busy, hasUnknown: unknown.length > 0, save };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = shortcutStateRef.current;
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "s" &&
        st.dirty &&
        !st.busy &&
        !st.hasUnknown
      ) {
        e.preventDefault();
        void st.save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const input = title.current;
    if (!input) return;
    const onScroll = () => syncTitleScroll(input);
    input.addEventListener("scroll", onScroll, { passive: true });
    return () => input.removeEventListener("scroll", onScroll);
  }, [Boolean(ev), sel, syncTitleScroll]);
  useEffect(() => {
    syncTitleScroll();
  }, [draft.title, sel, syncTitleScroll]);
  const t = q.trim().toLowerCase();
  const shown = (d?.events || []).filter(
    (e) =>
      !t ||
      `${evTitle(e)} ${evDesc(e)} ${evGroup(e.group)} ${e.title} ${e.desc} ${e.group}`
        .toLowerCase()
        .includes(t),
  );
  const groups = [...new Set(shown.map((e) => e.group))];
  const totalEvents = d?.events.length ?? 0;
  const link = (vars as Record<string, string>).link || "";
  return (
    <article className="sx-page tp2-page enter">
      <header className="sx-page-h tp2-page-h">
        <div>
          <h1>{bi("通知模板", "Notification Templates")}</h1>
          <p>
            {bi(
              "自定义各类通知消息的标题与正文，保存后统一对所有推送渠道生效。",
              "Customize title and body templates for each event across all delivery channels.",
            )}
          </p>
        </div>
        {ev && (
          <div className="tp2-head-acts">
            <Button
              icon={<IconRefresh />}
              disabled={!custom || busy}
              onClick={() => save(true)}
            >
              {bi("恢复默认", "Reset Default")}
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={!dirty || unknown.length > 0}
              onClick={() => save()}
            >
              {bi("保存模板", "Save Template")}
            </Button>
          </div>
        )}
      </header>
      {!d ? (
        <div className="st-skel" aria-label={bi("载入中", "Loading")} />
      ) : (
        <>
          <section className="tp2-picker-bar" aria-label={bi("消息类型", "Event types")}>
            <div className="tp2-picker-tabs" role="listbox">
              {groups.map((g) =>
                shown
                  .filter((e) => e.group === g)
                  .map((e) => {
                    const active = e.id === sel;
                    return (
                      <button
                        key={e.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={`tp2-pick-btn ${active ? "on" : ""}`}
                        onClick={() => setSel(e.id)}
                        title={evDesc(e)}
                      >
                        <span className="tp2-pick-grp">{evGroup(g)}</span>
                        <b>{evTitle(e)}</b>
                        {isDirty(e.id) ? (
                          <i
                            className="tp2-dot"
                            title={bi("有未保存修改", "Unsaved changes")}
                          />
                        ) : d.custom[e.id] ? (
                          <em className="tp2-pick-tag">{bi("已自定义", "Custom")}</em>
                        ) : null}
                      </button>
                    );
                  }),
              )}
              {shown.length === 0 && (
                <span className="faint small tp2-none">
                  {bi("没有匹配的消息类型", "No matching event types")}
                </span>
              )}
            </div>
            {totalEvents > 4 && (
              <div className="tp2-picker-search">
                <Input
                  prefix={<IconSearch />}
                  allowClear
                  placeholder={bi("筛选消息类型", "Filter events")}
                  value={q}
                  onChange={setQ}
                  aria-label={bi("搜索消息类型", "Search event types")}
                />
              </div>
            )}
          </section>

          {ev && (
            <div className="tp2-grid" key={sel}>
              <section className="tp2-card tp2-edit">
                <header className="tp2-card-h">
                  <div>
                    <h2>{evTitle(ev)}</h2>
                    <p>{evDesc(ev)}</p>
                  </div>
                  <span
                    className={`tp2-state-pill ${dirty ? "is-dirty" : custom ? "is-custom" : ""}`}
                  >
                    {dirty
                      ? bi("有未保存修改", "Unsaved")
                      : custom
                        ? bi("已自定义", "Custom")
                        : bi("系统默认", "Default")}
                  </span>
                </header>

                <div className="tp2-field">
                  <label htmlFor="tp-title">{bi("消息标题", "Title")}</label>
                  <div className="tp2-code one">
                    <pre ref={titlePre} aria-hidden>
                      <Marked text={draft.title} known={known} />
                    </pre>
                    <input
                      id="tp-title"
                      ref={title}
                      value={draft.title}
                      onChange={(e) => {
                        setDraft({ ...draft, title: e.target.value });
                        syncTitleScroll(e.currentTarget);
                      }}
                      onKeyUp={(e) => syncTitleScroll(e.currentTarget)}
                      onSelect={(e) => syncTitleScroll(e.currentTarget)}
                      onClick={(e) => syncTitleScroll(e.currentTarget)}
                      onFocus={(e) => {
                        setFocus("title");
                        syncTitleScroll(e.currentTarget);
                      }}
                      maxLength={120}
                      spellCheck={false}
                      aria-label={bi("标题", "Title")}
                    />
                  </div>
                </div>

                <div className="tp2-field">
                  <label htmlFor="tp-body">
                    {bi("消息正文", "Body")}
                    <small>
                      {bi(
                        "每行一条内容，空行自动忽略",
                        "One item per line; blank lines are trimmed",
                      )}
                    </small>
                  </label>
                  <div className="tp2-editor-box">
                    <div
                      className="tp2-toolbar"
                      role="toolbar"
                      aria-label={bi("格式", "Formatting")}
                    >
                      <div className="tp2-tool-btns">
                        <button
                          type="button"
                          onClick={() =>
                            wrap("**", "**", bi("加粗的文字", "bold text"))
                          }
                          title={bi("加粗", "Bold")}
                        >
                          <b>B</b>
                        </button>
                        <button
                          type="button"
                          onClick={() => wrap("`", "`", bi("代码", "code"))}
                          title={bi("代码", "Code")}
                        >
                          <code>&lt;/&gt;</code>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            wrap("[", "](https://)", bi("链接文字", "link text"))
                          }
                          title={bi("链接", "Link")}
                        >
                          {bi("链接", "Link")}
                        </button>
                        <button
                          type="button"
                          onClick={() => lead("> ")}
                          title={bi("引用", "Quote")}
                        >
                          {bi("引用", "Quote")}
                        </button>
                        <button
                          type="button"
                          onClick={() => lead("- ")}
                          title={bi("列表", "List")}
                        >
                          {bi("列表", "List")}
                        </button>
                        <button
                          type="button"
                          onClick={() => lead("## ")}
                          title={bi("标题", "Heading")}
                        >
                          {bi("标题", "Heading")}
                        </button>
                      </div>
                      <span className="tp2-tool-note">
                        {bi(
                          "企微 / 钉钉渲染 Markdown，飞书 / Webhook 发原文",
                          "WeCom / DingTalk render Markdown; Feishu / Webhook send plain text",
                        )}
                      </span>
                    </div>
                    <div className="tp2-code in-box">
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
                        aria-label={bi("正文", "Body")}
                      />
                    </div>
                    <div className="tp2-editor-foot">
                      <span className="num">
                        {draft.body.split("\n").filter((l) => l.trim()).length}{" "}
                        {bi("行", "lines")} · {draft.body.length} / 2000{" "}
                        {bi("字", "chars")}
                      </span>
                      {unknown.length > 0 ? (
                        <span className="bad">
                          {bi(
                            `未知变量：${unknown.map((u) => `{{${u}}}`).join("、")}，请移除后保存`,
                            `Unknown variables: ${unknown.map((u) => `{{${u}}}`).join(", ")}. Remove before saving.`,
                          )}
                        </span>
                      ) : (
                        <span className="faint">
                          {bi("Ctrl+S 快速保存", "Ctrl+S to save")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="tp2-vars">
                  <div className="tp2-vars-h">
                    <span>{bi("可用变量", "Available Variables")}</span>
                    <small>{bi("点击插入到当前光标处", "Click to insert at cursor")}</small>
                  </div>
                  <div className="tp2-var-chips">
                    {ev.vars.map((v) => (
                      <button
                        key={v.key}
                        type="button"
                        className="tp2-var-chip"
                        onClick={() => insert(v.key)}
                        title={bi(
                          `${varDesc(v)}\n示例：${vars[v.key as keyof typeof vars] ?? ""}`,
                          `${varDesc(v)}\nExample: ${vars[v.key as keyof typeof vars] ?? ""}`,
                        )}
                      >
                        <code>{`{{${v.key}}}`}</code>
                        <small>{varDesc(v)}</small>
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <aside
                className="tp2-card tp2-prev"
                aria-label={bi("预览", "Preview")}
              >
                <div className="tp2-prev-h">
                  <b>{bi("实时预览", "Live Preview")}</b>
                  <span className="tp2-sample-tag">
                    {bi("示例数据", "Sample Data")}
                  </span>
                </div>
                <div className="tp2-seg-wrap">
                  <Segmented
                    size="sm"
                    label={bi("渠道类型", "Channel type")}
                    value={kind}
                    onChange={setKind}
                    options={Object.entries(BOT).map(([k, v]) => ({
                      value: k,
                      label: v.name,
                    }))}
                  />
                </div>
                <div className="tp2-stage">
                  <Delivered
                    kind={kind}
                    title={preview.title}
                    lines={preview.lines}
                    link={link}
                  />
                </div>
                <p className="tp2-how">{BOT[kind].hint}</p>
                <div className="tp2-send-box">
                  <div className="tp2-send-label">
                    {bi("发送真实示例验证", "Send Sample Test")}
                  </div>
                  <div className="tp2-send">
                    <Select
                      placeholder={bi(
                        "选择通知渠道",
                        "Pick a channel",
                      )}
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
                      aria-label={bi("示例发到哪个渠道", "Target channel for sample")}
                    />
                    <Button
                      icon={<IconSend />}
                      loading={sendingTest}
                      onClick={() => void sendTest()}
                      disabled={!target}
                    >
                      {bi("发送示例", "Send")}
                    </Button>
                  </div>
                  {dirty && (
                    <small className="faint">
                      {bi(
                        "发出去的是已保存的模板，请先保存当前修改。",
                        "Samples use the last saved template; save your changes first.",
                      )}
                    </small>
                  )}
                </div>
              </aside>
            </div>
          )}
        </>
      )}
    </article>
  );
}

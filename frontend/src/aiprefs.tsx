import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  Input,
  Message,
  Modal,
  Select,
  Switch,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconDelete,
  IconEdit,
} from "@arco-design/web-react/icon";
import { api, err } from "./shared";
import { bi, useLang } from "./i18n";
import "./aiprefs.css";

/* Personalization: how the assistant talks to this person, and what it remembers about them. It only changes the
   wording of replies; what the assistant may read or do stays as the administrator set it. */

type Memory = { id: string; text: string; created: string };
type Prefs = {
  tone: string;
  warmth: string;
  enthusiasm: string;
  emoji: string;
  structure: string;
  nickname: string;
  about: string;
  instructions: string;
  memory_off: boolean;
  memories: Memory[];
};

const getTones = () => [
  {
    value: "default",
    label: bi("默认", "Default"),
    hint: bi("平台自带的风格", "Platform default style"),
  },
  {
    value: "professional",
    label: bi("专业", "Professional"),
    hint: bi("严谨、措辞精确", "Rigorous and precise wording"),
  },
  {
    value: "friendly",
    label: bi("亲切", "Friendly"),
    hint: bi("像同事之间聊天", "Conversational, like chatting with a teammate"),
  },
  {
    value: "direct",
    label: bi("直接", "Direct"),
    hint: bi("先说结论，不绕弯", "Lead with the conclusion, no fluff"),
  },
  {
    value: "concise",
    label: bi("简洁", "Concise"),
    hint: bi("只说要点", "Key points only"),
  },
];
const getLevels = () => [
  { value: "less", label: bi("更少", "Less") },
  { value: "default", label: bi("默认", "Default") },
  { value: "more", label: bi("更多", "More") },
];

function Row({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pf-row">
      <div className="pf-lab">
        <b>{title}</b>
        {help && <small>{help}</small>}
      </div>
      <div className="pf-ctl">{children}</div>
    </div>
  );
}

export function AIPrefs({ onBack }: { onBack: () => void }) {
  useLang();
  const [p, setP] = useState<Prefs | null>(null);
  const [state, setState] = useState<"" | "saving" | "saved">("");
  const timer = useRef(0);
  const first = useRef(true);

  useEffect(() => {
    api<Prefs>("/api/me/ai-prefs").then(setP).catch(err);
    return () => window.clearTimeout(timer.current);
  }, []);

  const save = (next: Prefs, wait = 0) => {
    setP(next);
    window.clearTimeout(timer.current);
    setState("saving");
    timer.current = window.setTimeout(async () => {
      try {
        await api("/api/me/ai-prefs", {
          method: "PUT",
          body: JSON.stringify(next),
        });
        setState("saved");
      } catch (e) {
        setState("");
        err(e);
      }
    }, wait);
  };
  const set = (patch: Partial<Prefs>, wait = 0) =>
    p && save({ ...p, ...patch }, wait);

  const editMemory = (m: Memory) => {
    let text = m.text;
    Modal.confirm({
      title: bi("修改这条记忆", "Edit memory"),
      content: (
        <Input.TextArea
          defaultValue={m.text}
          maxLength={300}
          autoSize={{ minRows: 2, maxRows: 6 }}
          onChange={(v) => (text = v)}
          aria-label={bi("记忆内容", "Memory content")}
          autoFocus
        />
      ),
      okText: bi("保存", "Save"),
      cancelText: bi("取消", "Cancel"),
      onOk: async () => {
        try {
          setP(
            await api<Prefs>(`/api/me/ai-prefs/memory/${m.id}`, {
              method: "PUT",
              body: JSON.stringify({ text }),
            }),
          );
        } catch (e) {
          err(e);
          throw e;
        }
      },
    });
  };
  const dropMemory = async (m: Memory) => {
    try {
      setP(
        await api<Prefs>(`/api/me/ai-prefs/memory/${m.id}`, {
          method: "DELETE",
        }),
      );
    } catch (e) {
      err(e);
    }
  };
  const clearMemory = () =>
    Modal.confirm({
      title: bi("清空所有记忆？", "Clear all memories?"),
      content: bi(
        "AI 会忘掉记住的所有事情，不能恢复。",
        "The assistant will forget everything remembered. This cannot be undone.",
      ),
      okText: bi("清空", "Clear"),
      cancelText: bi("取消", "Cancel"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          setP(
            await api<Prefs>("/api/me/ai-prefs/memory", { method: "DELETE" }),
          );
          Message.success(bi("已清空", "Cleared"));
        } catch (e) {
          err(e);
        }
      },
    });

  if (!p) return <div className="pf" aria-busy />;
  const tones = getTones();
  const levels = getLevels();
  const tone = tones.find((t) => t.value === (p.tone || "default"));
  return (
    <div className="pf">
      <div className="pf-in">
        <header>
          <button
            type="button"
            className="pf-back"
            onClick={onBack}
            aria-label={bi("返回对话", "Back to chat")}
          >
            <IconArrowLeft />
          </button>
          <h1>{bi("个性化", "Personalization")}</h1>
          <span className={`pf-state ${state}`} role="status">
            {state === "saving"
              ? bi("正在保存…", "Saving…")
              : state === "saved"
                ? bi("已保存", "Saved")
                : ""}
          </span>
        </header>

        <section>
          <h2>{bi("回答风格", "Response style")}</h2>
          <p className="pf-lead">
            {bi(
              "只影响 AI 说话的方式，不会改变它能看什么、能做什么。",
              "Only affects how the assistant writes replies; what it can view or do stays as configured by the administrator.",
            )}
          </p>
          <Row title={bi("基本风格和语气", "Base style and tone")} help={tone?.hint}>
            <Select
              value={p.tone || "default"}
              onChange={(v) => set({ tone: v })}
              options={tones.map(({ value, label }) => ({ value, label }))}
              aria-label={bi("基本风格和语气", "Base style and tone")}
            />
          </Row>
          <Row
            title={bi("温暖", "Warmth")}
            help={bi("语气里的体贴和鼓励", "Consideration and encouragement in tone")}
          >
            <Select
              value={p.warmth || "default"}
              onChange={(v) => set({ warmth: v })}
              options={levels}
              aria-label={bi("温暖", "Warmth")}
            />
          </Row>
          <Row
            title={bi("热情", "Enthusiasm")}
            help={bi("是否更有活力", "How energetic the tone is")}
          >
            <Select
              value={p.enthusiasm || "default"}
              onChange={(v) => set({ enthusiasm: v })}
              options={levels}
              aria-label={bi("热情", "Enthusiasm")}
            />
          </Row>
          <Row
            title={bi("标题和列表", "Headers and lists")}
            help={bi("回答分条整理的程度", "How structured and bulleted replies are")}
          >
            <Select
              value={p.structure || "default"}
              onChange={(v) => set({ structure: v })}
              options={levels}
              aria-label={bi("标题和列表", "Headers and lists")}
            />
          </Row>
          <Row
            title={bi("表情符号", "Emoji")}
            help={bi("默认不使用", "Disabled by default")}
          >
            <Select
              value={p.emoji || "default"}
              onChange={(v) => set({ emoji: v })}
              options={levels}
              aria-label={bi("表情符号", "Emoji")}
            />
          </Row>
        </section>

        <section>
          <h2>{bi("关于你", "About you")}</h2>
          <p className="pf-lead">
            {bi(
              "这些会在每次对话开始时交给 AI。不要写密码、密钥或 IP 地址，这类内容会被自动去掉。",
              "Shared with the assistant at the start of each chat. Do not include passwords, keys, or IP addresses—they are stripped automatically.",
            )}
          </p>
          <Row title={bi("称呼", "Nickname")}>
            <Input
              value={p.nickname}
              maxLength={30}
              onChange={(v) => set({ nickname: v }, 700)}
              placeholder={bi("AI 怎么称呼你", "How should the assistant address you?")}
              aria-label={bi("称呼", "Nickname")}
            />
          </Row>
          <div className="pf-block">
            <b>{bi("关于我", "About me")}</b>
            <small>
              {bi(
                "职责、负责的环境、熟悉的技术，帮助 AI 判断回答的深浅。",
                "Your role, environments you manage, and familiar technologies to help calibrate technical depth.",
              )}
            </small>
            <Input.TextArea
              value={p.about}
              maxLength={1500}
              showWordLimit
              autoSize={{ minRows: 3, maxRows: 8 }}
              onChange={(v) => set({ about: v }, 700)}
              placeholder={bi(
                "例如：我负责两个机房的数据库运维，熟悉 PostgreSQL，对 Kubernetes 不熟。",
                "e.g. I manage database operations across two DCs, know PostgreSQL well, and am less familiar with Kubernetes.",
              )}
              aria-label={bi("关于我", "About me")}
            />
          </div>
          <div className="pf-block">
            <b>{bi("自定义要求", "Custom instructions")}</b>
            <small>
              {bi(
                "希望 AI 每次都遵循的做法。",
                "Guidelines you want the assistant to follow in every reply.",
              )}
            </small>
            <Input.TextArea
              value={p.instructions}
              maxLength={1500}
              showWordLimit
              autoSize={{ minRows: 3, maxRows: 8 }}
              onChange={(v) => set({ instructions: v }, 700)}
              placeholder={bi(
                "例如：命令一律给出可复制的完整版本；有风险的操作先说明回退办法。",
                "e.g. Always provide full copyable commands; explain rollback steps before any risky operation.",
              )}
              aria-label={bi("自定义要求", "Custom instructions")}
            />
          </div>
        </section>

        <section>
          <h2>{bi("记忆", "Memory")}</h2>
          <Row
            title={bi("允许 AI 记住关于我的信息", "Allow assistant to remember info about me")}
            help={bi(
              "聊天中提到的长期信息（身份、环境、偏好）可以被记下来，下次对话直接用上。不会记密码和 IP。",
              "Long-term details mentioned in chat (role, environment, preferences) can be saved for future conversations. Passwords and IPs are never stored.",
            )}
          >
            <Switch
              checked={!p.memory_off}
              onChange={(v) => set({ memory_off: !v })}
              aria-label={bi(
                "允许 AI 记住关于我的信息",
                "Allow assistant to remember info about me",
              )}
            />
          </Row>
          <div className="pf-mem">
            <div className="pf-mem-h">
              <b>{bi("已记住的内容", "Saved memories")}</b>
              <span className="faint small">
                {bi(`${p.memories.length} / 60 条`, `${p.memories.length} / 60`)}
              </span>
              {p.memories.length > 0 && (
                <Button
                  size="mini"
                  status="danger"
                  type="text"
                  onClick={clearMemory}
                >
                  {bi("清空", "Clear")}
                </Button>
              )}
            </div>
            {p.memories.length === 0 ? (
              <p className="pf-none">
                {p.memory_off
                  ? bi("记忆已关闭。", "Memory is turned off.")
                  : bi(
                      "还没有记住任何事。每次对话后，AI 会自己判断有没有以后用得上的信息（身份、负责的系统、环境习惯、偏好），有就记在这里；你可以随时删掉不需要的。",
                      "Nothing remembered yet. After each conversation, the assistant decides whether any reusable context (role, systems owned, workflow habits, preferences) is worth saving here; you can edit or delete entries anytime.",
                    )}
              </p>
            ) : (
              <ul>
                {p.memories.map((m) => (
                  <li key={m.id}>
                    <span>
                      {m.text}
                      <small>{m.created}</small>
                    </span>
                    <button
                      type="button"
                      aria-label={bi("修改", "Edit")}
                      onClick={() => editMemory(m)}
                    >
                      <IconEdit />
                    </button>
                    <button
                      type="button"
                      aria-label={bi("删除", "Delete")}
                      onClick={() => dropMemory(m)}
                    >
                      <IconDelete />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

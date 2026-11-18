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

const TONES = [
  { value: "default", label: "默认", hint: "平台自带的风格" },
  { value: "professional", label: "专业", hint: "严谨、措辞精确" },
  { value: "friendly", label: "亲切", hint: "像同事之间聊天" },
  { value: "direct", label: "直接", hint: "先说结论，不绕弯" },
  { value: "concise", label: "简洁", hint: "只说要点" },
];
const LEVELS = [
  { value: "less", label: "更少" },
  { value: "default", label: "默认" },
  { value: "more", label: "更多" },
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
      title: "修改这条记忆",
      content: (
        <Input.TextArea
          defaultValue={m.text}
          maxLength={300}
          autoSize={{ minRows: 2, maxRows: 6 }}
          onChange={(v) => (text = v)}
          aria-label="记忆内容"
          autoFocus
        />
      ),
      okText: "保存",
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
      title: "清空所有记忆？",
      content: "AI 会忘掉记住的所有事情，不能恢复。",
      okText: "清空",
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          setP(
            await api<Prefs>("/api/me/ai-prefs/memory", { method: "DELETE" }),
          );
          Message.success("已清空");
        } catch (e) {
          err(e);
        }
      },
    });

  if (!p) return <div className="pf" aria-busy />;
  const tone = TONES.find((t) => t.value === (p.tone || "default"));
  return (
    <div className="pf">
      <div className="pf-in">
        <header>
          <button
            type="button"
            className="pf-back"
            onClick={onBack}
            aria-label="返回对话"
          >
            <IconArrowLeft />
          </button>
          <h1>个性化</h1>
          <span className={`pf-state ${state}`} role="status">
            {state === "saving"
              ? "正在保存…"
              : state === "saved"
                ? "已保存"
                : ""}
          </span>
        </header>

        <section>
          <h2>回答风格</h2>
          <p className="pf-lead">
            只影响 AI 说话的方式，不会改变它能看什么、能做什么。
          </p>
          <Row title="基本风格和语气" help={tone?.hint}>
            <Select
              value={p.tone || "default"}
              onChange={(v) => set({ tone: v })}
              options={TONES.map(({ value, label }) => ({ value, label }))}
              aria-label="基本风格和语气"
            />
          </Row>
          <Row title="温暖" help="语气里的体贴和鼓励">
            <Select
              value={p.warmth || "default"}
              onChange={(v) => set({ warmth: v })}
              options={LEVELS}
              aria-label="温暖"
            />
          </Row>
          <Row title="热情" help="是否更有活力">
            <Select
              value={p.enthusiasm || "default"}
              onChange={(v) => set({ enthusiasm: v })}
              options={LEVELS}
              aria-label="热情"
            />
          </Row>
          <Row title="标题和列表" help="回答分条整理的程度">
            <Select
              value={p.structure || "default"}
              onChange={(v) => set({ structure: v })}
              options={LEVELS}
              aria-label="标题和列表"
            />
          </Row>
          <Row title="表情符号" help="默认不使用">
            <Select
              value={p.emoji || "default"}
              onChange={(v) => set({ emoji: v })}
              options={LEVELS}
              aria-label="表情符号"
            />
          </Row>
        </section>

        <section>
          <h2>关于你</h2>
          <p className="pf-lead">
            这些会在每次对话开始时交给 AI。不要写密码、密钥或 IP
            地址，这类内容会被自动去掉。
          </p>
          <Row title="称呼">
            <Input
              value={p.nickname}
              maxLength={30}
              onChange={(v) => set({ nickname: v }, 700)}
              placeholder="AI 怎么称呼你"
              aria-label="称呼"
            />
          </Row>
          <div className="pf-block">
            <b>关于我</b>
            <small>
              职责、负责的环境、熟悉的技术，帮助 AI 判断回答的深浅。
            </small>
            <Input.TextArea
              value={p.about}
              maxLength={1500}
              showWordLimit
              autoSize={{ minRows: 3, maxRows: 8 }}
              onChange={(v) => set({ about: v }, 700)}
              placeholder="例如：我负责两个机房的数据库运维，熟悉 PostgreSQL，对 Kubernetes 不熟。"
              aria-label="关于我"
            />
          </div>
          <div className="pf-block">
            <b>自定义要求</b>
            <small>希望 AI 每次都遵循的做法。</small>
            <Input.TextArea
              value={p.instructions}
              maxLength={1500}
              showWordLimit
              autoSize={{ minRows: 3, maxRows: 8 }}
              onChange={(v) => set({ instructions: v }, 700)}
              placeholder="例如：命令一律给出可复制的完整版本；有风险的操作先说明回退办法。"
              aria-label="自定义要求"
            />
          </div>
        </section>

        <section>
          <h2>记忆</h2>
          <Row
            title="允许 AI 记住关于我的信息"
            help="聊天中提到的长期信息（身份、环境、偏好）可以被记下来，下次对话直接用上。不会记密码和 IP。"
          >
            <Switch
              checked={!p.memory_off}
              onChange={(v) => set({ memory_off: !v })}
              aria-label="允许 AI 记住关于我的信息"
            />
          </Row>
          <div className="pf-mem">
            <div className="pf-mem-h">
              <b>已记住的内容</b>
              <span className="faint small">{p.memories.length} / 60 条</span>
              {p.memories.length > 0 && (
                <Button
                  size="mini"
                  status="danger"
                  type="text"
                  onClick={clearMemory}
                >
                  清空
                </Button>
              )}
            </div>
            {p.memories.length === 0 ? (
              <p className="pf-none">
                {p.memory_off
                  ? "记忆已关闭。"
                  : "还没有记住任何事。每次对话后，AI 会自己判断有没有以后用得上的信息（身份、负责的系统、环境习惯、偏好），有就记在这里；你可以随时删掉不需要的。"}
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
                      aria-label="修改"
                      onClick={() => editMemory(m)}
                    >
                      <IconEdit />
                    </button>
                    <button
                      type="button"
                      aria-label="删除"
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

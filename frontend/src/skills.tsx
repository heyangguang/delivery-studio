import React, { useEffect, useMemo, useRef, useState } from "react";
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
  IconBook,
  IconCheck,
  IconCode,
  IconCopy,
  IconDelete,
  IconDownload,
  IconDown,
  IconEdit,
  IconExclamationCircle,
  IconEye,
  IconLock,
  IconPlus,
  IconRefresh,
  IconSafe,
  IconSearch,
} from "@arco-design/web-react/icon";
import { api, cached, can, copy, err, putCached, useMedia } from "./shared";
import { go } from "./router";
import { DocToc, StructuredDoc, extractDocSections } from "./docrender";
import { Segmented } from "./ui";
import "./respage.css";

/* Skills: structured operational manuals + optional air-gapped sandbox scripts (Python 3).
   Strict dual-scope isolation:
   - Platform skills (built-in / custom / admin-overridden): managed by ai.settings admins, executed strictly
     under the calling user's own identity & personal file storage (zero confused-deputy privilege escalation).
   - Personal skills (mine): visible & callable only inside the owner's own conversations, never shadowing
     platform skill names, and capped to stricter sandbox limits. */

export type SkillScript = {
  name: string;
  description?: string;
  code: string;
  network?: boolean;
};

type Skill = {
  name: string;
  title: string;
  description: string;
  content?: string;
  scripts?: SkillScript[];
  builtin?: boolean;
  customized?: boolean;
  enabled?: boolean;
  mine?: boolean;
};

type Kind = "all" | "mine" | "platform";

type Draft = {
  orig?: string;
  builtin?: boolean;
  scope: "mine" | "platform";
  name: string;
  title: string;
  description: string;
  content: string;
  scripts: SkillScript[];
};

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,36}\.py$/;

const SCRIPT_TEMPLATES: {
  label: string;
  name: string;
  description: string;
  code: string;
}[] = [
  {
    label: "参数容量核算",
    name: "calc_params.py",
    description: "读取 args 中的机器规格或业务并发参数，输出配置推荐值与安全水位校验",
    code: `import json, sys

# 参数由平台通过 /in/_args.json 注入；沙箱无网络且仅只读挂载运行环境
args = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else {}
memory_gb = float(args.get("memory_gb", 16))
max_conn = int(args.get("max_connections", 200))

result = {
    "memory_gb": memory_gb,
    "max_connections": max_conn,
    "recommended_buffer_mb": int(memory_gb * 1024 * 0.25),
}
print(json.dumps(result, ensure_ascii=False, indent=2))
`,
  },
  {
    label: "现场快照/日志解析",
    name: "parse_snapshot.py",
    description: "解析用户上传到当前会话存储空间的巡检文本或 args.raw_text，提取异常指标",
    code: `import json, os, re, sys

args = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else {}
lines = str(args.get("raw_text", "")).splitlines()

# 仅可读取当前对话用户本人通过 files 传入的文件（位于 /in，不含 _ 前缀内部文件）
for fn in sorted(os.listdir("/in")):
    if not fn.startswith("_"):
        with open(os.path.join("/in", fn), encoding="utf-8", errors="ignore") as f:
            lines.extend(f.read().splitlines())

errors = [ln.strip() for ln in lines if re.search(r"\\b(ERROR|FATAL|CRITICAL|failed)\\b", ln, re.I)]
print(json.dumps({"total_lines": len(lines), "hit_count": len(errors), "samples": errors[:25]}, ensure_ascii=False, indent=2))
`,
  },
  {
    label: "CSV 表格质检",
    name: "inspect_table.py",
    description: "扫描 /in 下的 CSV 文件，核算行数、字段空值率与重复项摘要",
    code: `import csv, json, os, sys

summary = []
for fn in sorted(os.listdir("/in")):
    if fn.startswith("_") or not fn.lower().endswith(".csv"):
        continue
    with open(os.path.join("/in", fn), encoding="utf-8-sig", errors="replace", newline="") as f:
        r = csv.DictReader(f)
        rows = list(r)
        summary.append({"file": fn, "columns": r.fieldnames or [], "rows": len(rows)})

print(json.dumps({"tables": summary}, ensure_ascii=False, indent=2))
`,
  },
];

function serializeScripts(list?: SkillScript[]) {
  return (list || []).map((sc) => ({
    name: sc.name.trim(),
    description: (sc.description || "").trim(),
    code: sc.code,
    ...(sc.network ? { network: true } : {}),
  }));
}

function uniqueForkName(base: string, isTaken: (n: string) => boolean): string {
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  const stem = (`my-${clean || "skill"}`).slice(0, 36).replace(/-+$/, "");
  if (NAME.test(stem) && !isTaken(stem)) return stem;
  for (let i = 2; i <= 99; i++) {
    const cand = `${stem.slice(0, 36)}-${i}`;
    if (NAME.test(cand) && !isTaken(cand)) return cand;
  }
  return `my-skill-${Date.now().toString(36).slice(-5)}`;
}

export function SkillsPage({ selected }: { selected?: string }) {
  const narrow = useMedia("(max-width: 900px)");
  const admin = can("ai.settings");
  const initMe = cached<{ skills: Skill[]; platform: Skill[] }>("/api/me/skills");
  const initAll = admin
    ? cached<{ skills: Skill[] }>("/api/settings/ai/skills")
    : undefined;
  const [mine, setMine] = useState<Skill[] | null>(() =>
    initMe
      ? initMe.skills.map((x) => ({ ...x, mine: true, enabled: true }))
      : null,
  );
  const [platform, setPlatform] = useState<Skill[]>(
    () => (initAll ? initAll.skills : initMe?.platform) ?? [],
  );
  const [error, setError] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [q, setQ] = useState("");
  const [raw, setRaw] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([
      api<{ skills: Skill[]; platform: Skill[] }>("/api/me/skills"),
      admin
        ? api<{ skills: Skill[] }>("/api/settings/ai/skills")
        : Promise.resolve(null),
    ])
      .then(([me, all]) => {
        putCached("/api/me/skills", me);
        if (all) putCached("/api/settings/ai/skills", all);
        setMine(me.skills.map((x) => ({ ...x, mine: true, enabled: true })));
        setPlatform(all ? all.skills : me.platform);
        setError("");
      })
      .catch((e) => setError((e as Error).message));

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setRaw(false);
  }, [selected]);

  const key = (s: Skill) => (s.mine ? `my-${s.name}` : s.name);
  const all = useMemo(() => [...(mine || []), ...platform], [mine, platform]);
  const t = q.trim().toLowerCase();
  const shown = all.filter(
    (s) =>
      (kind === "all" || (kind === "mine") === !!s.mine) &&
      (!t ||
        `${s.title} ${s.name} ${s.description} ${(s.scripts || []).map((x) => x.name).join(" ")}`
          .toLowerCase()
          .includes(t)),
  );
  const cur = all.find((s) => key(s) === selected);

  const curSections = useMemo(
    () =>
      cur && !raw
        ? extractDocSections(cur.content || "", cur.title, `sk-${key(cur)}`)
            .sections
        : [],
    [cur, raw],
  );

  const savePlatform = async (next: Skill[]) => {
    const r = await api<{ skills: Skill[] }>("/api/settings/ai/skills", {
      method: "PUT",
      body: JSON.stringify({
        disabled: next.filter((s) => !s.enabled).map((s) => s.name),
        custom: next
          .filter((s) => !s.builtin)
          .map(({ name, title, description, content, scripts }) => ({
            name,
            title,
            description,
            content,
            scripts: serializeScripts(scripts),
          })),
        overrides: next
          .filter((s) => s.builtin && s.customized)
          .map(({ name, title, description, content, scripts }) => ({
            name,
            title,
            description,
            content,
            scripts: serializeScripts(scripts),
          })),
      }),
    });
    putCached("/api/settings/ai/skills", r);
    setPlatform(r.skills);
  };

  const saveMine = async (next: Skill[]) => {
    const r = await api<{ skills: Skill[] }>("/api/me/skills", {
      method: "PUT",
      body: JSON.stringify({
        skills: next.map(({ name, title, description, content, scripts }) => ({
          name,
          title,
          description,
          content,
          scripts: serializeScripts(scripts),
        })),
      }),
    });
    setMine(r.skills.map((x) => ({ ...x, mine: true, enabled: true })));
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const s: Skill = {
        name: draft.name,
        title: draft.title.trim(),
        description: draft.description.trim(),
        content: draft.content,
        scripts: serializeScripts(draft.scripts),
      };
      if (draft.scope === "mine") {
        await saveMine([
          ...(mine || []).filter((x) => x.name !== (draft.orig || draft.name)),
          s,
        ]);
      } else if (draft.builtin) {
        await savePlatform(
          platform.map((x) =>
            x.name === draft.name
              ? {
                  ...x,
                  ...s,
                  builtin: true,
                  customized: true,
                  enabled: x.enabled !== false,
                }
              : x,
          ),
        );
      } else {
        const prev = platform.find((x) => x.name === (draft.orig || draft.name));
        await savePlatform([
          ...platform.filter((x) => x.name !== (draft.orig || draft.name)),
          {
            ...s,
            builtin: false,
            customized: false,
            enabled: prev ? prev.enabled !== false : true,
          },
        ]);
      }
      setDraft(null);
      Message.success("已保存");
      go(
        {
          name: "skills",
          id: draft.scope === "mine" ? `my-${s.name}` : s.name,
        },
        { replace: true },
      );
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  const resetBuiltin = (s: Skill) =>
    Modal.confirm({
      title: `恢复内置技能「${s.title}」为平台默认？`,
      content:
        "将清除当前对正文与随附脚本的定制修改，恢复为平台出厂内置版本。",
      okText: "恢复默认",
      okButtonProps: { status: "warning" },
      onOk: async () => {
        try {
          await savePlatform(
            platform.map((x) =>
              x.name === s.name ? { ...x, customized: false } : x,
            ),
          );
          Message.success("已恢复平台内置默认内容");
        } catch (e) {
          err(e);
        }
      },
    });

  const remove = (s: Skill) =>
    Modal.confirm({
      title: `删除技能「${s.title}」？`,
      content: s.mine ? "只影响你自己的对话。" : "所有人的对话都不会再用到它。",
      okText: "删除",
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          if (s.mine)
            await saveMine((mine || []).filter((x) => x.name !== s.name));
          else await savePlatform(platform.filter((x) => x.name !== s.name));
          go({ name: "skills" }, { replace: true });
        } catch (e) {
          err(e);
        }
      },
    });

  const toggle = async (s: Skill, on: boolean) => {
    try {
      await savePlatform(
        platform.map((x) => (x.name === s.name ? { ...x, enabled: on } : x)),
      );
    } catch (e) {
      err(e);
    }
  };

  const startNew = () => {
    setDraft({
      scope: "mine",
      name: "",
      title: "",
      description: "",
      content: "",
      scripts: [],
    });
    go({ name: "skills", id: "~new" }, { replace: !!selected });
  };

  const startEdit = (s: Skill) => {
    setDraft({
      orig: s.name,
      builtin: !!s.builtin && !s.mine,
      scope: s.mine ? "mine" : "platform",
      name: s.name,
      title: s.title,
      description: s.description,
      content: s.content || "",
      scripts: (s.scripts || []).map((sc) => ({
        name: sc.name,
        description: sc.description || "",
        code: sc.code || "",
      })),
    });
  };

  const forkToMine = (s: Skill) => {
    const nextName = uniqueForkName(s.name, (n) =>
      all.some((x) => x.name === n),
    );
    setDraft({
      scope: "mine",
      name: nextName,
      title: `${s.title}（个人定制）`.slice(0, 40),
      description: s.description,
      content: s.content || "",
      scripts: (s.scripts || []).map((sc) => ({
        name: sc.name,
        description: sc.description || "",
        code: sc.code || "",
      })),
    });
    go({ name: "skills", id: "~new" }, { replace: !!selected });
  };

  const editing =
    !!draft &&
    (selected === "~new" ||
      (cur &&
        key(cur) === selected &&
        draft.orig === cur.name &&
        (draft.scope === "mine") === !!cur.mine));

  const counts = {
    all: all.length,
    mine: mine?.length || 0,
    platform: platform.length,
  };

  return (
    <div className="md-split">
      {(!narrow || !selected) && (
        <aside className="md-list" aria-label="技能">
          <div className="list-head">
            <div className="list-title">
              <h1>技能</h1>
              <Button
                type="primary"
                size="small"
                icon={<IconPlus />}
                onClick={startNew}
              >
                新建
              </Button>
            </div>
            <Input
              prefix={<IconSearch />}
              allowClear
              placeholder="搜索技能或脚本"
              value={q}
              onChange={setQ}
              aria-label="搜索技能"
            />
            <Segmented<Kind>
              size="sm"
              label="来源"
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: "全部", count: counts.all },
                { value: "mine", label: "我的", count: counts.mine },
                { value: "platform", label: "平台", count: counts.platform },
              ]}
            />
          </div>
          {mine === null && !error ? (
            <div className="list-body">
              <Skeleton animation text={{ rows: 5 }} />
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
              <p>
                {t
                  ? "没有匹配的技能"
                  : kind === "mine"
                    ? "你还没有自己的技能"
                    : "没有技能"}
              </p>
              {kind === "mine" && !t && (
                <Button size="small" type="primary" onClick={startNew}>
                  写一个
                </Button>
              )}
            </div>
          ) : (
            <div className="list-body rp-list" role="listbox" aria-label="技能">
              {(["mine", "platform"] as const).map((g) => {
                const rows = shown.filter((s) => (g === "mine") === !!s.mine);
                if (!rows.length) return null;
                return (
                  <React.Fragment key={g}>
                    <div className="rp-group">
                      {g === "mine" ? "我的技能（仅个人会话）" : "平台技能（全员共享）"}
                    </div>
                    {rows.map((s) => {
                      const scCount = s.scripts?.length || 0;
                      return (
                        <a
                          key={key(s)}
                          href={`#/skills/${key(s)}`}
                          role="option"
                          aria-selected={selected === key(s)}
                          className={`rp-row ${selected === key(s) ? "on" : ""} ${s.enabled === false ? "off" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            setDraft(null);
                            go(
                              { name: "skills", id: key(s) },
                              { replace: !!selected },
                            );
                          }}
                        >
                          <span
                            className={`rp-ic ${s.mine ? "k-mine" : s.builtin ? "k-built" : "k-org"}`}
                          >
                            <IconBook />
                          </span>
                          <span className="rp-t">
                            <b>{s.title}</b>
                            <small>{s.description}</small>
                          </span>
                          <span className="rp-flags">
                            {scCount > 0 && (
                              <em className="rp-flag script" title="含沙箱脚本">
                                脚本 ×{scCount}
                              </em>
                            )}
                            {s.customized && (
                              <em className="rp-flag cust">已定制</em>
                            )}
                            {s.enabled === false && (
                              <em className="rp-flag">已停用</em>
                            )}
                          </span>
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
                onClick={() => go({ name: "skills" })}
              >
                技能
              </Button>
            )}
            {editing && draft ? (
              <SkillEditor
                draft={draft}
                setDraft={setDraft}
                admin={admin}
                taken={(n) =>
                  all.some(
                    (s) =>
                      s.name === n &&
                      !(
                        draft.orig === s.name &&
                        (draft.scope === "mine") === !!s.mine
                      ),
                  )
                }
                busy={busy}
                save={save}
                cancel={() => (
                  setDraft(null),
                  selected === "~new" &&
                    go({ name: "skills" }, { replace: true })
                )}
              />
            ) : cur ? (
              <article className="rp-doc enter" key={key(cur)}>
                <header className="rp-head">
                  <span
                    className={`rp-ic lg ${cur.mine ? "k-mine" : cur.builtin ? "k-built" : "k-org"}`}
                  >
                    <IconBook />
                  </span>
                  <div className="rp-head-t">
                    <div className="rp-title-row">
                      <h1>{cur.title}</h1>
                      <span
                        className={`rp-scope-pill ${cur.mine ? "mine" : cur.builtin ? "built" : "org"}`}
                      >
                        {cur.mine
                          ? "个人隔离技能"
                          : cur.builtin
                            ? cur.customized
                              ? "平台内置 · 已定制"
                              : "平台内置"
                            : "平台自建技能"}
                      </span>
                    </div>
                    <p>{cur.description}</p>
                  </div>
                  <span className="rp-acts">
                    <Button icon={<IconEye />} onClick={() => setRaw(!raw)}>
                      {raw ? "看排版" : "看原文"}
                    </Button>
                    {!cur.mine && (
                      <Button
                        icon={<IconCopy />}
                        onClick={() => forkToMine(cur)}
                      >
                        复制为个人技能
                      </Button>
                    )}
                    {(cur.mine || admin) && (
                      <Button
                        icon={<IconEdit />}
                        onClick={() => startEdit(cur)}
                      >
                        编辑
                      </Button>
                    )}
                    {admin && cur.builtin && cur.customized && (
                      <Button
                        icon={<IconRefresh />}
                        onClick={() => resetBuiltin(cur)}
                      >
                        恢复默认
                      </Button>
                    )}
                    {(cur.mine || (admin && !cur.builtin)) && (
                      <Button
                        status="danger"
                        icon={<IconDelete />}
                        onClick={() => remove(cur)}
                        aria-label="删除"
                      />
                    )}
                    {admin && !cur.mine && (
                      <label className="rp-switch">
                        <Switch
                          size="small"
                          checked={cur.enabled !== false}
                          onChange={(v) => toggle(cur, v)}
                          aria-label="对所有人启用"
                        />
                        {cur.enabled !== false ? "已启用" : "已停用"}
                      </label>
                    )}
                  </span>
                </header>
                <div className="rp-body">
                  <div className="rp-main">
                    {raw ? (
                      <pre className="kb-raw mono">
                        {cur.content || "（没有内容）"}
                      </pre>
                    ) : (
                      <StructuredDoc
                        text={cur.content || ""}
                        docTitle={cur.title}
                        idPrefix={`sk-${key(cur)}`}
                      />
                    )}
                    <SkillScriptsPanel
                      skill={cur}
                      canEdit={!!(cur.mine || admin)}
                      onEdit={() => startEdit(cur)}
                    />
                  </div>
                  <aside className="rp-side">
                    {!raw && <DocToc sections={curSections} />}
                    <div className={`rp-sec-box ${cur.mine ? "mine" : "plat"}`}>
                      <div className="rp-sec-box-h">
                        {cur.mine ? <IconLock /> : <IconSafe />}
                        <span>
                          {cur.mine ? "个人权限隔离边界" : "平台零穿透安全边界"}
                        </span>
                      </div>
                      <ul>
                        {cur.mine ? (
                          <>
                            <li>仅你本人的对话可见与调用，其他成员不可见。</li>
                            <li>不可覆盖同名平台内置安全规范技能。</li>
                            <li>
                              脚本运行于平台内置隔离沙箱（≤60s / 1GB），只能读写你本人的资料文件，网络与执行权限按沙箱策略受控。
                            </li>
                          </>
                        ) : (
                          <>
                            <li>仅具备 AI 设置权限的管理员可修改或启停。</li>
                            <li>
                              调用时严格降权绑定<b>当前提问者本人身份</b>，零跨用户数据穿透。
                            </li>
                            <li>
                              随附脚本复用平台统一代码沙箱隔离执行，绝不直连宿主机或受管生产节点；如需外网须按沙箱策略授权。
                            </li>
                          </>
                        )}
                      </ul>
                    </div>
                    <dl>
                      <dt>标识</dt>
                      <dd className="mono">{cur.name}</dd>
                      <dt>来源与范围</dt>
                      <dd>
                        {cur.mine
                          ? "个人编写 · 仅在我的对话中生效"
                          : cur.builtin
                            ? cur.customized
                              ? "平台内置（已由管理员定制）· 全员可用"
                              : "平台内置 · 全员可用"
                            : "本单位编写 · 全员可用"}
                      </dd>
                      <dt>随附沙箱脚本</dt>
                      <dd>
                        {cur.scripts && cur.scripts.length > 0
                          ? `${cur.scripts.length} 个 Python 脚本（调用平台统一沙箱隔离执行）`
                          : "纯规范文档（可点击「编辑」挂载计算或解析脚本）"}
                      </dd>
                      <dt>AI 怎么用它</dt>
                      <dd>
                        对话时 AI 先看到一句话说明；相关时通过{" "}
                        <code className="mono">use_skill</code> 读取全文，并在沙箱开启时按需调用{" "}
                        <code className="mono">run_skill_script</code>。
                      </dd>
                    </dl>
                  </aside>
                </div>
              </article>
            ) : selected && selected !== "~new" && mine ? (
              <div className="detail-none enter">
                <h2>找不到这个技能</h2>
                <Button
                  onClick={() => go({ name: "skills" }, { replace: true })}
                >
                  返回
                </Button>
              </div>
            ) : (
              <div className="rp-intro enter">
                <span className="rp-ic xl k-built">
                  <IconBook />
                </span>
                <h2>结构化操作手册与安全沙箱脚本</h2>
                <p>
                  把团队规范、排查规程写成技能，并可挂载参数核算、日志解析或表格质检脚本。平台技能全员共享但严格按调用者身份隔离文件权限；个人技能仅在自己的会话中生效。
                </p>
                <Button type="primary" icon={<IconPlus />} onClick={startNew}>
                  写一个技能
                </Button>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function downloadScript(filename: string, code: string) {
  const blob = new Blob([code], { type: "text/x-python;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "script.py";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SkillScriptsPanel({
  skill,
  canEdit,
  onEdit,
}: {
  skill: Skill;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const scripts = skill.scripts || [];
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() =>
    scripts[0] ? { [scripts[0].name]: true } : {},
  );
  const [copiedName, setCopiedName] = useState("");
  const copyTimer = useRef(0);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const prepared = useMemo(
    () =>
      scripts.map((sc) => {
        const trimmed = (sc.code || "").replace(/\n+$/, "");
        return { sc, codeLines: trimmed ? trimmed.split("\n") : [] };
      }),
    [scripts],
  );

  if (scripts.length === 0) return null;

  const toggleScript = (name: string) =>
    setOpenMap((m) => ({ ...m, [name]: !m[name] }));

  return (
    <section className="rp-scripts-sec" aria-label="随附沙箱脚本">
      <header className="rp-scripts-head">
        <div className="rp-scripts-title">
          <span className="rp-scripts-ic">
            <IconCode />
          </span>
          <div>
            <h2>
              随附可执行沙箱脚本 <em>{scripts.length}</em>
            </h2>
            <p>
              调用平台统一代码沙箱隔离执行（默认断网；声明需要网络的脚本须按沙箱策略经客户授权后联网，仍禁止访问本机服务与宿主机目录），仅能读取<b>当前对话发起人自己</b>存储空间中的输入文件。
            </p>
          </div>
        </div>
        {canEdit && (
          <Button size="small" icon={<IconEdit />} onClick={onEdit}>
            管理脚本
          </Button>
        )}
      </header>
      <div className="rp-scripts-list">
        {prepared.map(({ sc, codeLines }) => {
          const open = !!openMap[sc.name];
          return (
            <div
              key={sc.name}
              className={`rp-script-card ${open ? "open" : ""}`}
            >
              <div
                className="rp-script-bar"
                onClick={() => toggleScript(sc.name)}
              >
                <div className="rp-script-meta">
                  <code className="rp-script-fn mono">{sc.name}</code>
                  <span
                    className={`rp-script-tag ${sc.network ? "net" : ""}`}
                  >
                    {sc.network
                      ? "Python 3 · 联网需授权"
                      : "Python 3 · 隔离沙箱"}
                  </span>
                  <span className="rp-script-lines num">
                    {codeLines.length} 行
                  </span>
                </div>
                {sc.description ? (
                  <p className="rp-script-desc" title={sc.description}>
                    {sc.description}
                  </p>
                ) : (
                  <span />
                )}
                <div className="rp-script-acts">
                  {sc.code && (
                    <>
                      <button
                        type="button"
                        className="rp-script-act"
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadScript(sc.name, sc.code);
                        }}
                        title="下载脚本源码"
                      >
                        <IconDownload />
                        <span>下载</span>
                      </button>
                      <button
                        type="button"
                        className={`rp-script-act ${copiedName === sc.name ? "ok" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          copy(sc.code);
                          window.clearTimeout(copyTimer.current);
                          setCopiedName(sc.name);
                          copyTimer.current = window.setTimeout(
                            () => setCopiedName(""),
                            1500,
                          );
                        }}
                      >
                        {copiedName === sc.name ? <IconCheck /> : <IconCopy />}
                        <span>
                          {copiedName === sc.name ? "已复制" : "复制"}
                        </span>
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className={`rp-script-chev ${open ? "open" : ""}`}
                    aria-expanded={open}
                    aria-label={open ? `收起 ${sc.name}` : `展开 ${sc.name}`}
                    title={open ? "收起脚本源码" : "展开脚本源码"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleScript(sc.name);
                    }}
                  >
                    <IconDown />
                  </button>
                </div>
              </div>
              {open && codeLines.length > 0 && (
                <div className="rp-script-code">
                  <pre className="rp-code-pre mono">
                    <code>
                      {codeLines.map((ln, idx) => (
                        <span key={idx} className="rp-code-ln">
                          <i aria-hidden>{idx + 1}</i>
                          <span>{ln || " "}</span>
                        </span>
                      ))}
                    </code>
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SkillEditor({
  draft,
  setDraft,
  admin,
  taken,
  busy,
  save,
  cancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  admin: boolean;
  taken: (n: string) => boolean;
  busy: boolean;
  save: () => void;
  cancel: () => void;
}) {
  const [preview, setPreview] = useState(false);

  const nameErr = !draft.name
    ? ""
    : !NAME.test(draft.name)
      ? "小写字母开头，只用小写字母、数字和 -（2–41 字符）"
      : taken(draft.name)
        ? "这个标识已被平台或你的其他技能占用（个人技能不能覆盖平台技能名）"
        : "";

  const scriptErrors = useMemo(() => {
    const seen = new Set<string>();
    return draft.scripts.map((sc) => {
      const fn = sc.name.trim();
      if (!fn) return "请填写脚本文件名（如 calc_params.py）";
      if (!SCRIPT_NAME.test(fn))
        return "需以字母或数字开头，仅含字母、数字、_ 或 -，且以 .py 结尾（禁止以 _ 开头或包含路径）";
      if (seen.has(fn)) return `脚本文件名重复：${fn}`;
      seen.add(fn);
      if (!sc.code.trim()) return "脚本代码不能为空";
      if (sc.code.length > 64 << 10) return "单个脚本不能超过 64 KiB";
      return "";
    });
  }, [draft.scripts]);

  const hasScriptErr = scriptErrors.some(Boolean);
  const ok =
    draft.name &&
    !nameErr &&
    draft.title.trim() &&
    draft.description.trim() &&
    draft.content.trim() &&
    !hasScriptErr;

  const addScript = (tpl?: (typeof SCRIPT_TEMPLATES)[number]) => {
    if (draft.scripts.length >= 8) {
      Message.warning("单个技能最多挂载 8 个脚本");
      return;
    }
    const used = new Set(draft.scripts.map((s) => s.name.trim()));
    let baseName = tpl ? tpl.name : `helper_${draft.scripts.length + 1}.py`;
    if (used.has(baseName)) {
      const stem = baseName.replace(/\.py$/, "");
      let idx = 2;
      while (used.has(`${stem}_${idx}.py`)) idx++;
      baseName = `${stem}_${idx}.py`;
    }
    setDraft({
      ...draft,
      scripts: [
        ...draft.scripts,
        {
          name: baseName,
          description: tpl ? tpl.description : "",
          code:
            tpl?.code ||
            `import json, sys\n\nargs = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else {}\nprint(json.dumps({"received": args}, ensure_ascii=False, indent=2))\n`,
        },
      ],
    });
  };

  const updateScript = (idx: number, patch: Partial<SkillScript>) => {
    const next = draft.scripts.map((sc, i) =>
      i === idx ? { ...sc, ...patch } : sc,
    );
    setDraft({ ...draft, scripts: next });
  };

  const removeScript = (idx: number) => {
    setDraft({
      ...draft,
      scripts: draft.scripts.filter((_, i) => i !== idx),
    });
  };

  return (
    <div className="rp-edit enter">
      <header className="rp-edit-h">
        <div>
          <h1>
            {draft.builtin
              ? `编辑内置技能 · ${draft.name}`
              : draft.orig
                ? "编辑技能"
                : "新建技能"}
          </h1>
          <p className="rp-edit-sub">
            {draft.scope === "mine"
              ? "个人技能：仅在你本人的会话中可见与运行，严格隔离跨用户文件与平台资源。"
              : draft.builtin
                ? "正在定制平台内置技能：保存后对全员生效，随时可一键「恢复默认」。"
                : "平台共享技能：对全员可用，脚本执行时自动降权绑定当前提问者本人存储空间。"}
          </p>
        </div>
        <span className="rp-acts">
          <Button onClick={cancel}>取消</Button>
          <Button type="primary" loading={busy} disabled={!ok} onClick={save}>
            保存
          </Button>
        </span>
      </header>

      {admin && !draft.orig && (
        <div className="rp-field">
          <span>作用域与权限边界</span>
          <Segmented<"mine" | "platform">
            label="给谁用"
            value={draft.scope}
            onChange={(v) => setDraft({ ...draft, scope: v })}
            options={[
              { value: "mine", label: "个人技能（仅我自己可见与调用）" },
              { value: "platform", label: "平台技能（全员共享 · 调用者降权隔离）" },
            ]}
          />
        </div>
      )}

      <div className="rp-grid2">
        <div className="rp-field">
          <span>名称</span>
          <Input
            value={draft.title}
            onChange={(v) => setDraft({ ...draft, title: v })}
            placeholder="本单位变更规范"
            maxLength={40}
            aria-label="名称"
          />
        </div>
        <div className="rp-field">
          <span>标识</span>
          <Input
            className="mono"
            value={draft.name}
            onChange={(v) => setDraft({ ...draft, name: v.toLowerCase() })}
            placeholder="change-window"
            disabled={!!draft.orig}
            status={nameErr ? "error" : undefined}
            aria-label="标识"
          />
          <small className={nameErr ? "bad" : ""}>
            {nameErr || "小写字母开头，只用小写字母、数字和 -"}
          </small>
        </div>
      </div>

      <div className="rp-field">
        <span>一句话说明（AI 靠它判断什么时候读这个技能）</span>
        <Input
          value={draft.description}
          onChange={(v) => setDraft({ ...draft, description: v })}
          maxLength={300}
          placeholder="变更窗口、审批要求和回退规范；回答涉及上线或变更时使用"
          aria-label="说明"
        />
      </div>

      <div className="rp-field">
        <span className="rp-field-h">
          操作规范正文（Markdown · 自动结构化排版）
          <Segmented<string>
            size="sm"
            label="视图"
            value={preview ? "p" : "e"}
            onChange={(v) => setPreview(v === "p")}
            options={[
              { value: "e", label: "编辑源码" },
              { value: "p", label: "排版预览" },
            ]}
          />
        </span>
        {preview ? (
          <div className="rp-preview">
            <StructuredDoc
              text={draft.content || "（还没有内容）"}
              docTitle={draft.title}
              idPrefix="sk-preview"
            />
          </div>
        ) : (
          <Input.TextArea
            className="mono"
            value={draft.content}
            onChange={(v) => setDraft({ ...draft, content: v })}
            placeholder="建议使用 ## 二级标题划分章节（如 ## 适用边界、## 核查步骤、## 处置要求），AI 与阅读界面都会更清晰。"
            autoSize={{ minRows: 12, maxRows: 30 }}
            aria-label="内容"
          />
        )}
        <small>严禁写入明文口令、Token 或私钥，检测到敏感凭据将拒绝保存。</small>
      </div>

      <div className="rp-scripts-editor">
        <div className="rp-scripts-ed-h">
          <div>
            <h3>
              <IconCode /> 随附可执行沙箱脚本（可选 · {draft.scripts.length}/8）
            </h3>
            <p>
              当技能不仅需要文字规程，还需要精确参数核算、快照解析或表格质检时，可挂载 Python 3 脚本供 AI 调用{" "}
              <code className="mono">run_skill_script</code> 执行。
            </p>
          </div>
          <div className="rp-tpl-btns">
            {SCRIPT_TEMPLATES.map((tpl) => (
              <Button
                key={tpl.name}
                size="small"
                icon={<IconPlus />}
                onClick={() => addScript(tpl)}
              >
                {tpl.label}
              </Button>
            ))}
            <Button size="small" type="outline" onClick={() => addScript()}>
              空白脚本
            </Button>
          </div>
        </div>

        <div className={`rp-sec-guard ${draft.scope}`}>
          {draft.scope === "mine" ? <IconLock /> : <IconSafe />}
          <div>
            <b>
              {draft.scope === "mine"
                ? "个人脚本安全沙箱约束："
                : "平台脚本防权限穿透约束："}
            </b>
            <span>
              脚本调用平台统一代码沙箱隔离执行（只读{" "}
              <code>/rt</code>、禁止访问本机回环服务/宿主机目录/集群凭据，默认断网，开启外网权限后按平台策略由客户授权）；
              {draft.scope === "mine"
                ? "仅你本人的会话可触发，单次运行上限 60 秒 / 1 GB 内存 / 32 进程，仅能读写你自己的资料空间。"
                : "任何成员在对话中触发时，输入 /in 与输出 /out 均强制限定在该成员本人的个人存储空间内，绝不穿透访问管理员或其他成员的文件与交付。"}
            </span>
          </div>
        </div>

        {draft.scripts.length > 0 && (
          <div className="rp-script-ed-list">
            {draft.scripts.map((sc, idx) => (
              <div key={idx} className="rp-script-ed-card">
                <div className="rp-script-ed-top">
                  <div className="rp-field">
                    <span>脚本文件名（.py）</span>
                    <Input
                      className="mono"
                      value={sc.name}
                      onChange={(v) => updateScript(idx, { name: v })}
                      placeholder="calc_params.py"
                      maxLength={40}
                      status={scriptErrors[idx] ? "error" : undefined}
                    />
                  </div>
                  <div className="rp-field rp-script-ed-desc">
                    <span>用途与入参说明（展示给 AI 与阅读者）</span>
                    <Input
                      value={sc.description || ""}
                      onChange={(v) => updateScript(idx, { description: v })}
                      placeholder="例如：读取 args.memory_gb 与 max_connections，输出内存参数核算 JSON"
                      maxLength={200}
                    />
                  </div>
                  <Button
                    status="danger"
                    type="text"
                    icon={<IconDelete />}
                    aria-label="移除脚本"
                    onClick={() => removeScript(idx)}
                  />
                </div>
                <label className="rp-script-ed-net">
                  <Switch
                    size="small"
                    checked={!!sc.network}
                    onChange={(v) => updateScript(idx, { network: v })}
                  />
                  <span>
                    需要访问外部网络（默认离线隔离；开启后运行时按平台沙箱网络策略征得客户授权）
                  </span>
                </label>
                {scriptErrors[idx] && (
                  <small className="bad">{scriptErrors[idx]}</small>
                )}
                <Input.TextArea
                  className="mono rp-script-textarea"
                  value={sc.code}
                  onChange={(v) => updateScript(idx, { code: v })}
                  autoSize={{ minRows: 7, maxRows: 22 }}
                  placeholder='import json, sys\nargs = json.load(open(sys.argv[1], encoding="utf-8"))\nprint(json.dumps(args))'
                />
                <small className="rp-script-hint">
                  约定：<code className="mono">sys.argv[1]</code> 为{" "}
                  <code className="mono">/in/_args.json</code>；用户传入文件位于{" "}
                  <code className="mono">/in/</code>；生成给用户下载的文件写到{" "}
                  <code className="mono">/out/</code>；用{" "}
                  <code className="mono">print()</code> 输出结论给 AI。
                </small>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

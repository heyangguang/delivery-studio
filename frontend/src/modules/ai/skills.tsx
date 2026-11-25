import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { api, cached, can, copy, err, putCached, useMedia } from "../../shared/shared";
import { go } from "../../app/router";
import { DocToc, StructuredDoc, extractDocSections } from "../projects/docrender";
import { Segmented } from "../../design/ui";
import { bi, useLang } from "../../app/i18n";
import "../library/respage.css";
import "./kb.css";

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

const hasFileTransfer = (dt?: DataTransfer | null) =>
  !!dt && Array.from(dt.types || []).includes("Files");

type ScriptTemplate = {
  label: string;
  name: string;
  description: string;
  code: string;
};

const getScriptTemplates = (): ScriptTemplate[] => [
  {
    label: bi("参数容量核算", "Parameter sizing"),
    name: "calc_params.py",
    description: bi(
      "读取 args 中的机器规格或业务并发参数，输出配置推荐值与安全水位校验",
      "Read host specs or concurrency args and output recommended config values and safety checks",
    ),
    code: `import json, sys

# ${bi(
      "参数由平台通过 /in/_args.json 注入；沙箱无网络且仅只读挂载运行环境",
      "Args are injected via /in/_args.json; sandbox is offline with read-only runtime mount",
    )}
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
    label: bi("现场快照/日志解析", "Snapshot / log parser"),
    name: "parse_snapshot.py",
    description: bi(
      "解析用户上传到当前会话存储空间的巡检文本或 args.raw_text，提取异常指标",
      "Parse inspection logs uploaded in chat or args.raw_text to extract anomalies",
    ),
    code: `import json, os, re, sys

args = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else {}
lines = str(args.get("raw_text", "")).splitlines()

# ${bi(
      "仅可读取当前对话用户本人通过 files 传入的文件（位于 /in，不含 _ 前缀内部文件）",
      "Only user-attached files in /in (excluding internal _-prefixed files) are readable",
    )}
for fn in sorted(os.listdir("/in")):
    if not fn.startswith("_"):
        with open(os.path.join("/in", fn), encoding="utf-8", errors="ignore") as f:
            lines.extend(f.read().splitlines())

errors = [ln.strip() for ln in lines if re.search(r"\\b(ERROR|FATAL|CRITICAL|failed)\\b", ln, re.I)]
print(json.dumps({"total_lines": len(lines), "hit_count": len(errors), "samples": errors[:25]}, ensure_ascii=False, indent=2))
`,
  },
  {
    label: bi("CSV 表格质检", "CSV table check"),
    name: "inspect_table.py",
    description: bi(
      "扫描 /in 下的 CSV 文件，核算行数、字段空值率与重复项摘要",
      "Scan CSV files under /in and summarize row counts, columns, and completeness",
    ),
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

const skillKey = (s: Skill) => (s.mine ? `my-${s.name}` : s.name);

export function SkillsPage({
  selected,
  studioNav,
}: {
  selected?: string;
  studioNav?: React.ReactNode;
}) {
  const lang = useLang();
  const narrow = useMedia("(max-width: 900px)");
  const admin = can("ai.settings");
  const mountedRef = useRef(true);
  const saveRef = useRef(false);
  const actionRef = useRef(false);
  const toggleRef = useRef(false);
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
  const [toggling, setToggling] = useState("");

  const load = useCallback(
    () =>
      Promise.all([
        api<{ skills: Skill[]; platform: Skill[] }>("/api/me/skills"),
        admin
          ? api<{ skills: Skill[] }>("/api/settings/ai/skills")
          : Promise.resolve(null),
      ])
        .then(([me, all]) => {
          putCached("/api/me/skills", me);
          if (all) putCached("/api/settings/ai/skills", all);
          if (!mountedRef.current) return;
          setMine(me.skills.map((x) => ({ ...x, mine: true, enabled: true })));
          setPlatform(all ? all.skills : me.platform);
          setError("");
        })
        .catch((e) => {
          if (mountedRef.current) setError((e as Error).message);
        }),
    [admin],
  );

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => {
      mountedRef.current = false;
    };
  }, [lang, load]);

  useEffect(() => {
    setRaw(false);
  }, [selected]);

  const all = useMemo(() => [...(mine || []), ...platform], [mine, platform]);
  const t = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      all.filter(
        (s) =>
          (kind === "all" || (kind === "mine") === !!s.mine) &&
          (!t ||
            `${s.title} ${s.name} ${s.description} ${(s.scripts || []).map((x) => x.name).join(" ")}`
              .toLowerCase()
              .includes(t)),
      ),
    [all, kind, t],
  );
  const groupedRows = useMemo(
    () => ({
      mine: shown.filter((s) => !!s.mine),
      platform: shown.filter((s) => !s.mine),
    }),
    [shown],
  );
  const cur = useMemo(
    () => all.find((s) => skillKey(s) === selected),
    [all, selected],
  );

  const curSections = useMemo(
    () =>
      cur && !raw
        ? extractDocSections(
            cur.content || "",
            cur.title,
            `sk-${skillKey(cur)}`,
          ).sections
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
    if (mountedRef.current) setPlatform(r.skills);
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
    if (mountedRef.current)
      setMine(r.skills.map((x) => ({ ...x, mine: true, enabled: true })));
  };

  const save = async () => {
    if (!draft || saveRef.current) return;
    saveRef.current = true;
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
      if (mountedRef.current) setDraft(null);
      Message.success(bi("已保存", "Saved"));
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
      saveRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const resetBuiltin = (s: Skill) =>
    Modal.confirm({
      title: bi(
        `恢复内置技能「${s.title}」为平台默认？`,
        `Reset built-in skill "${s.title}" to defaults?`,
      ),
      content: bi(
        "将清除当前对正文与随附脚本的定制修改，恢复为平台出厂内置版本。",
        "This discards your customizations to the document and attached scripts and restores the built-in version.",
      ),
      okText: bi("恢复默认", "Reset"),
      cancelText: bi("取消", "Cancel"),
      okButtonProps: { status: "warning" },
      onOk: async () => {
        if (actionRef.current) return;
        actionRef.current = true;
        try {
          await savePlatform(
            platform.map((x) =>
              x.name === s.name ? { ...x, customized: false } : x,
            ),
          );
          Message.success(
            bi("已恢复平台内置默认内容", "Restored built-in defaults"),
          );
        } catch (e) {
          err(e);
          throw e;
        } finally {
          actionRef.current = false;
        }
      },
    });

  const remove = (s: Skill) =>
    Modal.confirm({
      title: bi(`删除技能「${s.title}」？`, `Delete skill "${s.title}"?`),
      content: s.mine
        ? bi("只影响你自己的对话。", "Only affects your own chats.")
        : bi(
            "所有人的对话都不会再用到它。",
            "No one's chats will use it anymore.",
          ),
      okText: bi("删除", "Delete"),
      cancelText: bi("取消", "Cancel"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (actionRef.current) return;
        actionRef.current = true;
        try {
          if (s.mine)
            await saveMine((mine || []).filter((x) => x.name !== s.name));
          else await savePlatform(platform.filter((x) => x.name !== s.name));
          go({ name: "skills" }, { replace: true });
        } catch (e) {
          err(e);
          throw e;
        } finally {
          actionRef.current = false;
        }
      },
    });

  const toggle = async (s: Skill, on: boolean) => {
    if (toggleRef.current) return;
    toggleRef.current = true;
    setToggling(s.name);
    try {
      await savePlatform(
        platform.map((x) => (x.name === s.name ? { ...x, enabled: on } : x)),
      );
    } catch (e) {
      err(e);
    } finally {
      toggleRef.current = false;
      if (mountedRef.current) setToggling("");
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
        ...(sc.network ? { network: true } : {}),
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
      title: bi(`${s.title}（个人定制）`, `${s.title} (Personal)`).slice(0, 40),
      description: s.description,
      content: s.content || "",
      scripts: (s.scripts || []).map((sc) => ({
        name: sc.name,
        description: sc.description || "",
        code: sc.code || "",
        ...(sc.network ? { network: true } : {}),
      })),
    });
    go({ name: "skills", id: "~new" }, { replace: !!selected });
  };

  const editing =
    !!draft &&
    (selected === "~new" ||
      (cur &&
        skillKey(cur) === selected &&
        draft.orig === cur.name &&
        (draft.scope === "mine") === !!cur.mine));

  const counts = useMemo(
    () => ({
      all: all.length,
      mine: mine?.length || 0,
      platform: platform.length,
    }),
    [all.length, mine?.length, platform.length],
  );

  return (
    <div className="md-split sk-split-page">
      {(!narrow || !selected) && (
        <aside className="md-list" aria-label={bi("技能", "Skills")}>
          <div className="list-head">
            <div className="list-title">
              <h1>{studioNav ? bi("能力库", "Capabilities") : bi("技能", "Skills")}</h1>
              <Button
                type="primary"
                size="small"
                icon={<IconPlus />}
                onClick={startNew}
              >
                {bi("新建", "New")}
              </Button>
            </div>
            {studioNav}
            <Input
              prefix={<IconSearch />}
              allowClear
              placeholder={bi("搜索技能或脚本", "Search skills or scripts")}
              value={q}
              onChange={setQ}
              aria-label={bi("搜索技能", "Search skills")}
            />
            <Segmented<Kind>
              size="sm"
              label={bi("来源", "Scope")}
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: bi("全部", "All"), count: counts.all },
                {
                  value: "mine",
                  label: bi("我的", "Mine"),
                  count: counts.mine,
                },
                {
                  value: "platform",
                  label: bi("平台", "Platform"),
                  count: counts.platform,
                },
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
                {bi("重试", "Retry")}
              </Button>
            </div>
          ) : shown.length === 0 ? (
            <div className="list-state">
              <p>
                {t
                  ? bi("没有匹配的技能", "No matching skills")
                  : kind === "mine"
                    ? bi("你还没有自己的技能", "You have no personal skills yet")
                    : bi("没有技能", "No skills")}
              </p>
              {kind === "mine" && !t && (
                <Button size="small" type="primary" onClick={startNew}>
                  {bi("写一个", "Create one")}
                </Button>
              )}
            </div>
          ) : (
            <div
              className="list-body rp-list"
              role="listbox"
              aria-label={bi("技能", "Skills")}
            >
              {(["mine", "platform"] as const).map((g) => {
                const rows = groupedRows[g];
                if (!rows.length) return null;
                return (
                  <React.Fragment key={g}>
                    <div className="rp-group">
                      {g === "mine"
                        ? bi(
                            "我的技能（仅个人会话）",
                            "My skills (personal chats only)",
                          )
                        : bi(
                            "平台技能（全员共享）",
                            "Platform skills (shared)",
                          )}
                    </div>
                    {rows.map((s) => {
                      const scCount = s.scripts?.length || 0;
                      const k = skillKey(s);
                      return (
                        <a
                          key={k}
                          href={`#/skills/${k}`}
                          role="option"
                          aria-selected={selected === k}
                          className={`rp-row ${selected === k ? "on" : ""} ${s.enabled === false ? "off" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            setDraft(null);
                            go(
                              { name: "skills", id: k },
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
                            <b title={s.title}>{s.title}</b>
                            <small title={s.description}>{s.description}</small>
                          </span>
                          <span className="rp-flags">
                            {scCount > 0 && (
                              <em
                                className="rp-flag script num"
                                title={bi("含沙箱脚本", "Includes sandbox scripts")}
                              >
                                {bi(`脚本 ×${scCount}`, `Scripts ×${scCount}`)}
                              </em>
                            )}
                            {s.customized && (
                              <em className="rp-flag cust">
                                {bi("已定制", "Customized")}
                              </em>
                            )}
                            {s.enabled === false && (
                              <em className="rp-flag">
                                {bi("已停用", "Disabled")}
                              </em>
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
                {bi("技能", "Skills")}
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
              <article className="rp-doc sk-doc enter" key={skillKey(cur)}>
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
                          ? bi("个人隔离技能", "Personal isolated skill")
                          : cur.builtin
                            ? cur.customized
                              ? bi(
                                  "平台内置 · 已定制",
                                  "Built-in · Customized",
                                )
                              : bi("平台内置", "Platform built-in")
                            : bi("平台自建技能", "Platform custom skill")}
                      </span>
                    </div>
                    <p>{cur.description}</p>
                  </div>
                  <span className="rp-acts">
                    <Button icon={<IconEye />} onClick={() => setRaw(!raw)}>
                      {raw
                        ? bi("看排版", "Formatted")
                        : bi("看原文", "Raw source")}
                    </Button>
                    {!cur.mine && (
                      <Button
                        icon={<IconCopy />}
                        onClick={() => forkToMine(cur)}
                      >
                        {bi("复制为个人技能", "Fork to mine")}
                      </Button>
                    )}
                    {(cur.mine || admin) && (
                      <Button
                        icon={<IconEdit />}
                        onClick={() => startEdit(cur)}
                      >
                        {bi("编辑", "Edit")}
                      </Button>
                    )}
                    {admin && cur.builtin && cur.customized && (
                      <Button
                        icon={<IconRefresh />}
                        onClick={() => resetBuiltin(cur)}
                      >
                        {bi("恢复默认", "Reset default")}
                      </Button>
                    )}
                    {(cur.mine || (admin && !cur.builtin)) && (
                      <Button
                        status="danger"
                        icon={<IconDelete />}
                        onClick={() => remove(cur)}
                        aria-label={bi("删除", "Delete")}
                      />
                    )}
                    {admin && !cur.mine && (
                      <label className="rp-switch">
                        <Switch
                          size="small"
                          loading={toggling === cur.name}
                          checked={cur.enabled !== false}
                          onChange={(v) => toggle(cur, v)}
                          aria-label={bi("对所有人启用", "Enable for everyone")}
                        />
                        {cur.enabled !== false
                          ? bi("已启用", "Enabled")
                          : bi("已停用", "Disabled")}
                      </label>
                    )}
                  </span>
                </header>
                <div className="rp-body">
                  <div className="rp-main">
                    {raw ? (
                      <pre className="kb-raw mono">
                        {cur.content || bi("（没有内容）", "(No content)")}
                      </pre>
                    ) : (
                      <StructuredDoc
                        text={cur.content || ""}
                        docTitle={cur.title}
                        idPrefix={`sk-${skillKey(cur)}`}
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
                          {cur.mine
                            ? bi("个人权限隔离边界", "Personal isolation boundary")
                            : bi(
                                "平台零穿透安全边界",
                                "Zero-escalation platform boundary",
                              )}
                        </span>
                      </div>
                      <ul>
                        {cur.mine ? (
                          <>
                            <li>
                              {bi(
                                "仅你本人的对话可见与调用，其他成员不可见。",
                                "Visible and callable only in your own chats; hidden from other users.",
                              )}
                            </li>
                            <li>
                              {bi(
                                "不可覆盖同名平台内置安全规范技能。",
                                "Cannot shadow built-in platform safety skills of the same name.",
                              )}
                            </li>
                            <li>
                              {bi(
                                "脚本运行于平台内置隔离沙箱（≤60s / 1GB），只能读写你本人的资料文件，网络与执行权限按沙箱策略受控。",
                                "Scripts run in an isolated sandbox (≤60s / 1 GB), accessing only your own files under sandbox network & execution policies.",
                              )}
                            </li>
                          </>
                        ) : (
                          <>
                            <li>
                              {bi(
                                "仅具备 AI 设置权限的管理员可修改或启停。",
                                "Only admins with AI Settings permission can edit or toggle.",
                              )}
                            </li>
                            <li>
                              {bi(
                                "调用时严格降权绑定",
                                "Strictly scoped at runtime to ",
                              )}
                              <b>
                                {bi("当前提问者本人身份", "the asking user's identity")}
                              </b>
                              {bi("，零跨用户数据穿透。", "—zero cross-user data leakage.")}
                            </li>
                            <li>
                              {bi(
                                "随附脚本复用平台统一代码沙箱隔离执行，绝不直连宿主机或受管生产节点；如需外网须按沙箱策略授权。",
                                "Attached scripts run in the unified sandbox—never directly on the host or managed nodes; outbound network requires policy approval.",
                              )}
                            </li>
                          </>
                        )}
                      </ul>
                    </div>
                    <dl>
                      <dt>{bi("标识", "Identifier")}</dt>
                      <dd className="mono">{cur.name}</dd>
                      <dt>{bi("来源与范围", "Source & scope")}</dt>
                      <dd>
                        {cur.mine
                          ? bi(
                              "个人编写 · 仅在我的对话中生效",
                              "Personal · Active only in my chats",
                            )
                          : cur.builtin
                            ? cur.customized
                              ? bi(
                                  "平台内置（已由管理员定制）· 全员可用",
                                  "Built-in (customized by admin) · Shared",
                                )
                              : bi(
                                  "平台内置 · 全员可用",
                                  "Platform built-in · Shared",
                                )
                            : bi("本单位编写 · 全员可用", "Organization · Shared")}
                      </dd>
                      <dt>{bi("随附沙箱脚本", "Sandbox scripts")}</dt>
                      <dd className="num">
                        {cur.scripts && cur.scripts.length > 0
                          ? bi(
                              `${cur.scripts.length} 个 Python 脚本（调用平台统一沙箱隔离执行）`,
                              `${cur.scripts.length} Python script${cur.scripts.length === 1 ? "" : "s"} (isolated sandbox)`,
                            )
                          : bi(
                              "纯规范文档（可点击「编辑」挂载计算或解析脚本）",
                              "Doc-only skill (click Edit to attach calculation or parsing scripts)",
                            )}
                      </dd>
                      <dt>{bi("AI 怎么用它", "How AI uses it")}</dt>
                      <dd>
                        {bi(
                          "对话时 AI 先看到一句话说明；相关时通过 ",
                          "In chat, AI sees the summary first; when relevant it loads the full doc via ",
                        )}
                        <code className="mono">use_skill</code>
                        {bi(
                          " 读取全文，并在沙箱开启时按需调用 ",
                          " and invokes ",
                        )}
                        <code className="mono">run_skill_script</code>
                        {bi("。", " when sandbox is enabled.")}
                      </dd>
                    </dl>
                  </aside>
                </div>
              </article>
            ) : selected && selected !== "~new" && mine ? (
              <div className="detail-none enter">
                <h2>{bi("找不到这个技能", "Skill not found")}</h2>
                <Button
                  onClick={() => go({ name: "skills" }, { replace: true })}
                >
                  {bi("返回", "Back")}
                </Button>
              </div>
            ) : (
              <div className="rp-intro enter">
                <span className="rp-ic xl k-built">
                  <IconBook />
                </span>
                <h2>
                  {bi(
                    "结构化操作手册与安全沙箱脚本",
                    "Structured playbooks & isolated sandbox scripts",
                  )}
                </h2>
                <p>
                  {bi(
                    "把团队规范、排查规程写成技能，并可挂载参数核算、日志解析或表格质检脚本。平台技能全员共享但严格按调用者身份隔离文件权限；个人技能仅在自己的会话中生效。",
                    "Turn team standards and runbooks into skills, optionally backed by sizing, log parsing, or table check scripts. Platform skills are shared with strict per-user file isolation; personal skills apply only to your chats.",
                  )}
                </p>
                <Button type="primary" icon={<IconPlus />} onClick={startNew}>
                  {bi("写一个技能", "Write a skill")}
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
  a.style.display = "none";
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
  useLang();
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
    <section
      className="rp-scripts-sec"
      aria-label={bi("随附沙箱脚本", "Attached sandbox scripts")}
    >
      <header className="rp-scripts-head">
        <div className="rp-scripts-title">
          <span className="rp-scripts-ic">
            <IconCode />
          </span>
          <div className="sk-scripts-title-body">
            <h2>
              {bi("随附可执行沙箱脚本", "Attached sandbox scripts")}{" "}
              <em className="num">{scripts.length}</em>
            </h2>
            <p>
              {bi(
                "调用平台统一代码沙箱隔离执行（默认断网；声明需要网络的脚本须按沙箱策略经客户授权后联网，仍禁止访问本机服务与宿主机目录），仅能读取",
                "Executed in the unified sandbox (offline by default; network-flagged scripts require user approval per policy and still block host/loopback access), reading only ",
              )}
              <b>{bi("当前对话发起人自己", "the current user's own")}</b>
              {bi("存储空间中的输入文件。", " input files.")}
            </p>
          </div>
        </div>
        {canEdit && (
          <Button
            size="small"
            style={{ flexShrink: 0 }}
            icon={<IconEdit />}
            onClick={onEdit}
          >
            {bi("管理脚本", "Manage scripts")}
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
                  <code className="rp-script-fn mono" title={sc.name}>
                    {sc.name}
                  </code>
                  <span
                    className={`rp-script-tag ${sc.network ? "net" : ""}`}
                  >
                    {sc.network
                      ? bi(
                          "Python 3 · 联网需授权",
                          "Python 3 · Net w/ approval",
                        )
                      : bi("Python 3 · 隔离沙箱", "Python 3 · Isolated sandbox")}
                  </span>
                  <span className="rp-script-lines num">
                    {bi(`${codeLines.length} 行`, `${codeLines.length} lines`)}
                  </span>
                </div>
                {sc.description ? (
                  <p className="rp-script-desc" title={sc.description}>
                    {sc.description}
                  </p>
                ) : (
                  <span className="rp-script-desc is-empty" aria-hidden />
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
                        title={bi("下载脚本源码", "Download script")}
                      >
                        <IconDownload />
                        <span>{bi("下载", "Download")}</span>
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
                          {copiedName === sc.name
                            ? bi("已复制", "Copied")
                            : bi("复制", "Copy")}
                        </span>
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className={`rp-script-chev ${open ? "open" : ""}`}
                    aria-expanded={open}
                    aria-label={
                      open
                        ? bi(`收起 ${sc.name}`, `Collapse ${sc.name}`)
                        : bi(`展开 ${sc.name}`, `Expand ${sc.name}`)
                    }
                    title={
                      open
                        ? bi("收起脚本源码", "Collapse script")
                        : bi("展开脚本源码", "Expand script")
                    }
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
  const lang = useLang();
  const [preview, setPreview] = useState(false);
  const [scriptDrag, setScriptDrag] = useState(false);
  const dragDepthRef = useRef(0);

  useEffect(() => {
    if (!scriptDrag) return;
    const clearDrag = () => {
      dragDepthRef.current = 0;
      setScriptDrag(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") clearDrag();
    };
    window.addEventListener("dragend", clearDrag);
    window.addEventListener("drop", clearDrag);
    window.addEventListener("blur", clearDrag);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragend", clearDrag);
      window.removeEventListener("drop", clearDrag);
      window.removeEventListener("blur", clearDrag);
      window.removeEventListener("keydown", onKey);
    };
  }, [scriptDrag]);

  useEffect(
    () => () => {
      dragDepthRef.current = 0;
    },
    [],
  );

  const nameErr = !draft.name
    ? ""
    : !NAME.test(draft.name)
      ? bi(
          "小写字母开头，只用小写字母、数字和 -（2–41 字符）",
          "Start with a lowercase letter; use lowercase letters, digits, and - (2–41 chars)",
        )
      : taken(draft.name)
        ? bi(
            "这个标识已被平台或你的其他技能占用（个人技能不能覆盖平台技能名）",
            "Identifier already used by a platform or personal skill (personal skills cannot shadow platform names)",
          )
        : "";

  const scriptErrors = useMemo(() => {
    const seen = new Set<string>();
    return draft.scripts.map((sc) => {
      const fn = sc.name.trim();
      if (!fn)
        return bi(
          "请填写脚本文件名（如 calc_params.py）",
          "Enter script filename (e.g. calc_params.py)",
        );
      if (!SCRIPT_NAME.test(fn))
        return bi(
          "需以字母或数字开头，仅含字母、数字、_ 或 -，且以 .py 结尾（禁止以 _ 开头或包含路径）",
          "Must start with letter/digit, contain only letters, digits, _, or -, and end with .py (no leading _ or paths)",
        );
      if (seen.has(fn))
        return bi(`脚本文件名重复：${fn}`, `Duplicate script filename: ${fn}`);
      seen.add(fn);
      if (!sc.code.trim())
        return bi("脚本代码不能为空", "Script code cannot be empty");
      if (sc.code.length > 64 << 10)
        return bi("单个脚本不能超过 64 KiB", "Single script cannot exceed 64 KiB");
      return "";
    });
  }, [draft.scripts, lang]);

  const hasScriptErr = scriptErrors.some(Boolean);
  const ok =
    draft.name &&
    !nameErr &&
    draft.title.trim() &&
    draft.description.trim() &&
    draft.content.trim() &&
    !hasScriptErr;

  const templates = useMemo(() => getScriptTemplates(), [lang]);
  const addScript = (tpl?: ScriptTemplate) => {
    if (draft.scripts.length >= 8) {
      Message.warning(
        bi("单个技能最多挂载 8 个脚本", "A skill can attach at most 8 scripts"),
      );
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

  const dropScriptFiles = async (files: File[]) => {
    const pyFiles = files.filter((f) => f.name.toLowerCase().endsWith(".py"));
    if (!pyFiles.length) {
      Message.warning(
        bi("请拖入 .py Python 脚本文件", "Please drop .py Python script files"),
      );
      return;
    }
    const room = 8 - draft.scripts.length;
    if (room <= 0) {
      Message.warning(
        bi("单个技能最多挂载 8 个脚本", "A skill can attach at most 8 scripts"),
      );
      return;
    }
    const used = new Set(draft.scripts.map((s) => s.name.trim()));
    const additions: SkillScript[] = [];
    for (const f of pyFiles.slice(0, room)) {
      if (f.size > 64 << 10) {
        Message.warning(
          bi(
            `${f.name} 超过 64 KiB，已跳过`,
            `${f.name} exceeds 64 KiB and was skipped`,
          ),
        );
        continue;
      }
      const code = await f.text();
      const rawStem = f.name
        .replace(/\.py$/i, "")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .replace(/^_+/, "")
        .slice(0, 32);
      const stem = rawStem || `script_${draft.scripts.length + additions.length + 1}`;
      let candidate = `${stem}.py`;
      let idx = 2;
      while (used.has(candidate)) {
        candidate = `${stem.slice(0, 30)}_${idx}.py`;
        idx++;
      }
      used.add(candidate);
      additions.push({ name: candidate, description: "", code });
    }
    if (additions.length) {
      setDraft({ ...draft, scripts: [...draft.scripts, ...additions] });
    }
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
    <div className="rp-edit sk-edit-wrap enter">
      <header className="rp-edit-h">
        <div>
          <h1>
            {draft.builtin
              ? bi(
                  `编辑内置技能 · ${draft.name}`,
                  `Edit built-in skill · ${draft.name}`,
                )
              : draft.orig
                ? bi("编辑技能", "Edit skill")
                : bi("新建技能", "New skill")}
          </h1>
          <p className="rp-edit-sub">
            {draft.scope === "mine"
              ? bi(
                  "个人技能：仅在你本人的会话中可见与运行，严格隔离跨用户文件与平台资源。",
                  "Personal skill: visible and runnable only in your own chats, isolated from other users' files and platform resources.",
                )
              : draft.builtin
                ? bi(
                    "正在定制平台内置技能：保存后对全员生效，随时可一键「恢复默认」。",
                    "Customizing a built-in skill: applies to everyone after saving; click Reset default anytime to revert.",
                  )
                : bi(
                    "平台共享技能：对全员可用，脚本执行时自动降权绑定当前提问者本人存储空间。",
                    "Shared platform skill: available to everyone; scripts run scoped strictly to the asking user's storage.",
                  )}
          </p>
        </div>
        <span className="rp-acts">
          <Button disabled={busy} onClick={cancel}>
            {bi("取消", "Cancel")}
          </Button>
          <Button type="primary" loading={busy} disabled={!ok} onClick={save}>
            {bi("保存", "Save")}
          </Button>
        </span>
      </header>

      {admin && !draft.orig && (
        <div className="rp-field">
          <span>{bi("作用域与权限边界", "Scope & isolation boundary")}</span>
          <Segmented<"mine" | "platform">
            label={bi("给谁用", "Availability")}
            value={draft.scope}
            onChange={(v) => setDraft({ ...draft, scope: v })}
            options={[
              {
                value: "mine",
                label: bi(
                  "个人技能（仅我自己可见与调用）",
                  "Personal (only visible & callable by me)",
                ),
              },
              {
                value: "platform",
                label: bi(
                  "平台技能（全员共享 · 调用者降权隔离）",
                  "Platform (shared · caller-isolated)",
                ),
              },
            ]}
          />
        </div>
      )}

      <div className="rp-grid2">
        <div className="rp-field">
          <span>{bi("名称", "Title")}</span>
          <Input
            value={draft.title}
            onChange={(v) => setDraft({ ...draft, title: v })}
            placeholder={bi("本单位变更规范", "Org change policy")}
            maxLength={40}
            aria-label={bi("名称", "Title")}
          />
        </div>
        <div className="rp-field">
          <span>{bi("标识", "Identifier")}</span>
          <Input
            className="mono"
            value={draft.name}
            onChange={(v) => setDraft({ ...draft, name: v.toLowerCase() })}
            placeholder="change-window"
            disabled={!!draft.orig}
            status={nameErr ? "error" : undefined}
            aria-label={bi("标识", "Identifier")}
          />
          <small className={nameErr ? "bad" : ""}>
            {nameErr ||
              bi(
                "小写字母开头，只用小写字母、数字和 -",
                "Start with a lowercase letter; use lowercase letters, digits, and - only",
              )}
          </small>
        </div>
      </div>

      <div className="rp-field">
        <span>
          {bi(
            "一句话说明（AI 靠它判断什么时候读这个技能）",
            "One-line summary (tells the assistant when to load this skill)",
          )}
        </span>
        <Input
          value={draft.description}
          onChange={(v) => setDraft({ ...draft, description: v })}
          maxLength={300}
          placeholder={bi(
            "变更窗口、审批要求和回退规范；回答涉及上线或变更时使用",
            "Change windows, approval rules, and rollback standards; read for go-live or change questions",
          )}
          aria-label={bi("说明", "Summary")}
        />
      </div>

      <div className="rp-field">
        <span className="rp-field-h">
          {bi(
            "操作规范正文（Markdown · 自动结构化排版）",
            "Playbook body (Markdown · auto-structured layout)",
          )}
          <Segmented<string>
            size="sm"
            label={bi("视图", "View")}
            value={preview ? "p" : "e"}
            onChange={(v) => setPreview(v === "p")}
            options={[
              { value: "e", label: bi("编辑源码", "Edit source") },
              { value: "p", label: bi("排版预览", "Preview") },
            ]}
          />
        </span>
        {preview ? (
          <div className="rp-preview">
            <StructuredDoc
              text={draft.content || bi("（还没有内容）", "(No content)")}
              docTitle={draft.title}
              idPrefix="sk-preview"
            />
          </div>
        ) : (
          <Input.TextArea
            className="mono"
            value={draft.content}
            onChange={(v) => setDraft({ ...draft, content: v })}
            placeholder={bi(
              "建议使用 ## 二级标题划分章节（如 ## 适用边界、## 核查步骤、## 处置要求），AI 与阅读界面都会更清晰。",
              "Use ## headings to organize sections (e.g. ## Scope, ## Checks, ## Actions) for clearer AI and reader parsing.",
            )}
            autoSize={{ minRows: 12, maxRows: 30 }}
            aria-label={bi("内容", "Content")}
          />
        )}
        <small>
          {bi(
            "严禁写入明文口令、Token 或私钥，检测到敏感凭据将拒绝保存。",
            "Never include plaintext passwords, tokens, or private keys; saves containing credentials are rejected.",
          )}
        </small>
      </div>

      <div
        className={`rp-scripts-editor sk-scripts-drop ${scriptDrag ? "is-drag" : ""}`}
        onDragEnter={(e) => {
          if (!hasFileTransfer(e.dataTransfer)) return;
          e.preventDefault();
          dragDepthRef.current += 1;
          setScriptDrag(true);
        }}
        onDragOver={(e) => {
          if (!hasFileTransfer(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!scriptDrag) setScriptDrag(true);
        }}
        onDragLeave={(e) => {
          if (!hasFileTransfer(e.dataTransfer)) return;
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (
            dragDepthRef.current === 0 ||
            (e.relatedTarget &&
              !e.currentTarget.contains(e.relatedTarget as Node))
          ) {
            dragDepthRef.current = 0;
            setScriptDrag(false);
          }
        }}
        onDrop={(e) => {
          if (!hasFileTransfer(e.dataTransfer)) return;
          e.preventDefault();
          dragDepthRef.current = 0;
          setScriptDrag(false);
          void dropScriptFiles(Array.from(e.dataTransfer.files || []));
        }}
      >
        <div className="rp-scripts-ed-h">
          <div>
            <h3 className="num">
              <IconCode />{" "}
              {bi(
                `随附可执行沙箱脚本（可选 · ${draft.scripts.length}/8）`,
                `Attached sandbox scripts (optional · ${draft.scripts.length}/8)`,
              )}
            </h3>
            <p>
              {bi(
                "当技能不仅需要文字规程，还需要精确参数核算、快照解析或表格质检时，可挂载或拖入 Python 3 脚本供 AI 调用 ",
                "Attach or drop Python 3 scripts when the skill needs deterministic sizing, log parsing, or table checks via ",
              )}
              <code className="mono">run_skill_script</code>
              {bi(" 执行。", ".")}
            </p>
          </div>
          <div className="rp-tpl-btns">
            {templates.map((tpl) => (
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
              {bi("空白脚本", "Blank script")}
            </Button>
          </div>
        </div>

        <div className={`rp-sec-guard ${draft.scope}`}>
          {draft.scope === "mine" ? <IconLock /> : <IconSafe />}
          <div>
            <b>
              {draft.scope === "mine"
                ? bi("个人脚本安全沙箱约束：", "Personal script sandbox limits: ")
                : bi(
                    "平台脚本防权限穿透约束：",
                    "Platform script isolation boundary: ",
                  )}
            </b>
            <span>
              {bi(
                "脚本调用平台统一代码沙箱隔离执行（只读 ",
                "Scripts run in the unified sandbox (read-only ",
              )}
              <code>/rt</code>
              {bi(
                "、禁止访问本机回环服务/宿主机目录/集群凭据，默认断网，开启外网权限后按平台策略由客户授权）；",
                ", no loopback/host/cluster-credential access, offline by default with policy-gated outbound network); ",
              )}
              {draft.scope === "mine"
                ? bi(
                    "仅你本人的会话可触发，单次运行上限 60 秒 / 1 GB 内存 / 32 进程，仅能读写你自己的资料空间。",
                    "callable only from your chats, capped at 60s / 1 GB RAM / 32 procs, with access only to your own files.",
                  )
                : bi(
                    "任何成员在对话中触发时，输入 /in 与输出 /out 均强制限定在该成员本人的个人存储空间内，绝不穿透访问管理员或其他成员的文件与交付。",
                    "whenever any user invokes it, /in and /out are bound strictly to that caller's own storage—never accessing admins' or other users' files or deliveries.",
                  )}
            </span>
          </div>
        </div>

        {draft.scripts.length > 0 && (
          <div className="rp-script-ed-list">
            {draft.scripts.map((sc, idx) => (
              <div key={idx} className="rp-script-ed-card">
                <div className="rp-script-ed-top">
                  <div className="rp-field">
                    <span>{bi("脚本文件名（.py）", "Script filename (.py)")}</span>
                    <Input
                      className="mono"
                      value={sc.name}
                      onChange={(v) => updateScript(idx, { name: v })}
                      placeholder="calc_params.py"
                      maxLength={40}
                      status={scriptErrors[idx] ? "error" : undefined}
                      aria-label={bi("脚本文件名", "Script filename")}
                    />
                  </div>
                  <div className="rp-field rp-script-ed-desc">
                    <span>
                      {bi(
                        "用途与入参说明（展示给 AI 与阅读者）",
                        "Purpose & args description (shown to AI and readers)",
                      )}
                    </span>
                    <Input
                      value={sc.description || ""}
                      onChange={(v) => updateScript(idx, { description: v })}
                      placeholder={bi(
                        "例如：读取 args.memory_gb 与 max_connections，输出内存参数核算 JSON",
                        "e.g. Read args.memory_gb and max_connections, print recommended memory JSON",
                      )}
                      maxLength={200}
                      aria-label={bi("用途与入参说明", "Purpose & args description")}
                    />
                  </div>
                  <Button
                    status="danger"
                    type="text"
                    icon={<IconDelete />}
                    aria-label={bi("移除脚本", "Remove script")}
                    onClick={() => removeScript(idx)}
                  />
                </div>
                <label className="rp-script-ed-net">
                  <Switch
                    size="small"
                    checked={!!sc.network}
                    onChange={(v) => updateScript(idx, { network: v })}
                    aria-label={bi("需要访问外部网络", "Requires outbound network access")}
                  />
                  <span>
                    {bi(
                      "需要访问外部网络（默认离线隔离；开启后运行时按平台沙箱网络策略征得客户授权）",
                      "Requires outbound network access (offline by default; subject to sandbox network approval at runtime)",
                    )}
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
                  aria-label={bi("脚本源码", "Script source code")}
                />
                <small className="rp-script-hint">
                  {bi("约定：", "Convention: ")}
                  <code className="mono">sys.argv[1]</code>{" "}
                  {bi("为", "is")} <code className="mono">/in/_args.json</code>
                  {bi("；用户传入文件位于", "; input files are in")}{" "}
                  <code className="mono">/in/</code>
                  {bi(
                    "；生成给用户下载的文件写到",
                    "; write downloadable outputs to",
                  )}{" "}
                  <code className="mono">/out/</code>
                  {bi("；用", "; use")} <code className="mono">print()</code>{" "}
                  {bi("输出结论给 AI。", "to return output to AI.")}
                </small>
              </div>
            ))}
          </div>
        )}
        {scriptDrag && (
          <div className="kb-ed-drop-mask">
            {bi(
              "松开即可挂载 .py 脚本（≤ 64 KiB，最多 8 个）",
              "Drop .py script files to attach (≤ 64 KiB, up to 8)",
            )}
          </div>
        )}
      </div>
    </div>
  );
}

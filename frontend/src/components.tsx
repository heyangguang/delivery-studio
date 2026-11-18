import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Drawer,
  Input,
  Message,
  Modal,
  Skeleton,
  Upload,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconBook,
  IconCode,
  IconCopy,
  IconDelete,
  IconDownload,
  IconEdit,
  IconExclamationCircle,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconUndo,
  IconUpload,
} from "@arco-design/web-react/icon";
import {
  can,
  api,
  cached,
  err,
  fetchCached,
  size,
  typing,
  useDelayed,
  useMedia,
} from "./shared";
import type { ApiError } from "./shared";
import type { AppInfo, Session } from "./shared";
import { go } from "./router";
import { AppGlyph, Kbd, Segmented, StatusBadge } from "./ui";
import { Terminal } from "./runbook";
import { ForkModal, NewComponentModal } from "./wbdialogs";
import { ComponentPanes } from "./compview";
import { registerStyles } from "./glyphs";

type Entry = AppInfo & {
  source: "builtin" | "custom" | "override" | "draft";
  broken?: boolean;
  problem?: string;
  has_draft?: boolean;
  rev?: number;
};
type Problem = {
  severity: "error" | "warning";
  path?: string;
  message: string;
};
type Validation = {
  ok: boolean;
  problems: Problem[];
  name?: string;
  versions?: { id: string; status: string }[];
};

const SOURCE: Record<string, string> = {
  builtin: "内置",
  custom: "自定义",
  override: "已修改",
  draft: "未发布",
};
const SOURCE_HELP: Record<string, string> = {
  override:
    "这是内置组件，你改过并发布了自己的版本，平台现在用的是你的版本。要回到原样，打开它点「恢复内置」。",
  custom: "你自己创建或导入的组件。",
  draft: "还没有发布的新组件，只有草稿。",
};
const VERSION_STATE: Record<string, [string, string]> = {
  published: ["done", "已发布"],
  verifying: ["queued", "待验证"],
  draft: ["idle", "草稿"],
};

const TEMPLATE = `schema: mwpack/v1
component: my-app            # 小写字母开头，与目录名一致
short: app                   # 表单默认给实例起的名字
title: 我的应用
category: 其他
summary: 一句话说明
provides: []

roles:
  - {name: node, title: 节点, min: 1, max: 5, default: 1}

params:
  - {key: port, label: 服务端口, type: port, default: 8080}

ports:
  - {name: service, value: =params.port}

versions:
  - id: "1.0"
    status: draft            # draft → verifying → published
    platforms: [ubuntu-24.04-amd64]
    packages: [{name: my-app}]
    artifacts:
      - {name: offline-repo, kind: apt-repo, root: offline-repo, file: offline-repo.tar.gz}

lifecycle:
  install:
    - id: packages
      title: 安装软件包
      tasks:
        - name: 安装
          ansible.builtin.apt:
            name: "{{ mw.packages | map(attribute='spec') | list }}"
            state: present
            update_cache: false
  start:
    - id: start
      title: 启动服务
      tasks:
        - name: 启动
          ansible.builtin.systemd: {name: my-app, enabled: true, state: started}

tests:
  - id: port
    title: 端口可达
    effect: read-only
    tasks:
      - name: 连接服务端口
        ansible.builtin.wait_for: {port: "{{ mw.params.port }}", timeout: 5}
`;

export function ComponentsPage({
  me,
  selected,
}: {
  me: Session;
  selected?: string;
}) {
  const narrow = useMedia("(max-width: 900px)");
  const admin = can("component.edit");
  const [list, setList] = useState<Entry[]>(
    () => cached<Entry[]>("/api/components") ?? [],
  );
  const [load, setLoad] = useState<"loading" | "error" | "ready">(() =>
    cached("/api/components") ? "ready" : "loading",
  );
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [create, setCreate] = useState(false);
  const search = useRef<HTMLInputElement | null>(null);

  const reload = () =>
    fetchCached<Entry[]>("/api/components")
      .then((r) => {
        registerStyles(r);
        setList(r);
        setLoad("ready");
      })
      .catch((e) => {
        setMessage((e as Error).message);
        setLoad((s) => (s === "ready" ? s : "error"));
      });
  useEffect(() => {
    reload();
    const changed = () => {
      void reload();
    };
    window.addEventListener("mw-components-changed", changed);
    return () => window.removeEventListener("mw-components-changed", changed);
  }, []);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      list.filter(
        (c) =>
          !q ||
          `${c.id} ${c.name} ${c.category} ${c.description}`
            .toLowerCase()
            .includes(q),
      ),
    [list, q],
  );
  const groups = useMemo(() => {
    const m = new Map<string, Entry[]>();
    shown.forEach((c) =>
      m.set(c.category || "其他", [...(m.get(c.category || "其他") || []), c]),
    );
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);

  // Desktop always shows a detail; pick the first one when nothing is selected. Not something the user asked for, so no transition.
  useEffect(() => {
    if (!narrow && !selected && load === "ready" && list.length)
      go(
        { name: "components", id: list[0].id },
        { replace: true, instant: true },
      );
  }, [narrow, selected, load, list.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        document.querySelector(".pal-mask,.arco-drawer-wrapper")
      )
        return;
      if (e.key === "/" && !typing(e)) {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      if (typing(e) || !shown.length) return;
      const d =
        e.key === "ArrowDown" || e.key === "j"
          ? 1
          : e.key === "ArrowUp" || e.key === "k"
            ? -1
            : 0;
      if (!d) return;
      e.preventDefault();
      const curId = selected || (!narrow ? list[0]?.id : undefined);
      const i = shown.findIndex((c) => c.id === curId);
      const next =
        shown[Math.max(0, Math.min(shown.length - 1, i < 0 ? 0 : i + d))];
      if (next) go({ name: "components", id: next.id }, { replace: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, selected, narrow, list]);

  // on a wide screen the first component is drawn straight away; the address catches up without a second paint
  const shownId = selected || (!narrow ? list[0]?.id : undefined);
  const current = list.find((c) => c.id === shownId);
  const slowList = useDelayed(load === "loading");
  return (
    <div className="md-split">
      {(!narrow || !selected) && (
        <aside className="md-list" aria-label="组件列表">
          <div className="list-head">
            <div className="list-title">
              <h1>组件</h1>
              {(admin || can("component.import")) && (
                <span className="row-gap">
                  {can("component.import") && (
                    <Button
                      size="small"
                      icon={<IconUpload />}
                      onClick={() => setOpen(true)}
                    >
                      导入
                    </Button>
                  )}
                  {admin && (
                    <Button
                      type="primary"
                      size="small"
                      icon={<IconPlus />}
                      onClick={() => setCreate(true)}
                    >
                      新建
                    </Button>
                  )}
                </span>
              )}
            </div>
            <Input
              ref={(r) => {
                search.current =
                  (r as unknown as { dom?: HTMLInputElement })?.dom ?? null;
              }}
              prefix={<IconSearch />}
              suffix={!query ? <Kbd>/</Kbd> : undefined}
              allowClear
              placeholder="搜索组件"
              value={query}
              onChange={setQuery}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (query) setQuery("");
                  (e.target as HTMLElement).blur();
                }
              }}
              aria-label="搜索组件"
            />
            {admin && (
              <a
                className="list-guide"
                href="#/components/platform-shared/edit/files"
              >
                <IconCode /> 平台公共流程
              </a>
            )}
            <a
              className="list-guide"
              href="#/components/guide"
              onClick={(e) => {
                e.preventDefault();
                go({ name: "components", id: "guide" });
              }}
            >
              <IconBook /> 怎么编写和修改组件
            </a>
          </div>
          {load === "loading" && !list.length ? (
            <div className="list-body">
              {[0, 1, 2].map((i) => (
                <div
                  className="row-skel"
                  key={i}
                  style={{ visibility: slowList ? "visible" : "hidden" }}
                >
                  <Skeleton
                    animation
                    text={{ rows: 2, width: ["45%", "65%"] }}
                  />
                </div>
              ))}
            </div>
          ) : load === "error" && !list.length ? (
            <div className="list-state">
              <IconExclamationCircle className="bad" />
              <p>{message || "组件加载失败"}</p>
              <Button size="small" icon={<IconRefresh />} onClick={reload}>
                重试
              </Button>
            </div>
          ) : !shown.length ? (
            <div className="list-state">
              <p>没有匹配的组件</p>
              <Button size="small" onClick={() => setQuery("")}>
                清除搜索
              </Button>
            </div>
          ) : (
            <div className="list-body" role="listbox" aria-label="组件">
              {groups.map(([cat, items]) => (
                <React.Fragment key={cat}>
                  <div className="list-day">{cat}</div>
                  {items.map((c) => (
                    <a
                      key={c.id}
                      href={`#/components/${c.id}`}
                      role="option"
                      aria-selected={c.id === shownId}
                      className={`row ${c.id === shownId ? "on" : ""}`}
                      onClick={(e) => {
                        e.preventDefault();
                        go(
                          { name: "components", id: c.id },
                          { replace: !!selected },
                        );
                      }}
                    >
                      <AppGlyph
                        id={c.id}
                        category={c.category}
                        size={36}
                        muted={!c.available}
                      />
                      <div className="row-main cr">
                        <div className="row-top">
                          <span className="row-name sans">{c.name}</span>
                          <CompMarks c={c} />
                          {!c.broken && c.source !== "draft" && (
                            <span className="cr-ver mono">
                              {c.versions.map((v) => v.id).join(" · ")}
                            </span>
                          )}
                        </div>
                        {c.broken || c.source === "draft" ? (
                          <div className="cr-meta">
                            {c.broken
                              ? c.source === "override"
                                ? "已回退内置版，编辑或恢复内置可修复"
                                : "已跳过，修复或删除后恢复"
                              : "尚未发布"}
                          </div>
                        ) : (
                          <div className="cr-meta">
                            <span
                              className={`cr-state ${c.available ? "ok" : c.kind === "external" ? "ext" : "bad"}`}
                              title={c.available ? "可以生成交付" : c.reason}
                            >
                              {c.available
                                ? c.kind === "external"
                                  ? "只出配置"
                                  : "可生成"
                                : "缺软件包"}
                            </span>
                            {c.roles.length > 0 && (
                              <span
                                className="cr-roles"
                                title={c.roles
                                  .map(
                                    (r) =>
                                      `${r.title || r.name}：${r.max && r.min === r.max ? `固定 ${r.min} 台` : `${r.min} 台起，常用 ${r.default ?? r.min} 台`}${r.odd ? "，建议奇数" : ""}`,
                                  )
                                  .join("\n")}
                              >
                                {c.roles
                                  .map(
                                    (r) =>
                                      `${r.title || r.name} ${r.default ?? r.min}`,
                                  )
                                  .join(" + ")}{" "}
                                台起步
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </a>
                  ))}
                </React.Fragment>
              ))}
            </div>
          )}
        </aside>
      )}
      {(!narrow || selected) && (
        <section className="md-detail">
          {current ? (
            <ComponentDetail
              key={current.id}
              c={current}
              admin={admin}
              narrow={narrow}
              changed={reload}
            />
          ) : selected && load === "ready" ? (
            <div className="detail-none enter">
              <h2>找不到这个组件</h2>
              <Button
                onClick={() => go({ name: "components" }, { replace: true })}
              >
                返回组件列表
              </Button>
            </div>
          ) : null}
        </section>
      )}
      <NewComponentModal open={create} close={() => setCreate(false)} />
      <ImportDrawer
        open={open}
        onClose={() => setOpen(false)}
        narrow={narrow}
        done={async (name) => {
          setOpen(false);
          await reload();
          go({ name: "components", id: name }, { replace: true });
        }}
      />
    </div>
  );
}

/** What is different about a component: whether the built-in one was changed, and whether there are unpublished edits. */
function CompMarks({ c }: { c: Entry }) {
  if (c.broken) {
    return (
      <>
        <span className="cm cm-bad">
          {c.source === "override" ? "覆盖版有误" : "无法载入"}
        </span>
        {c.has_draft && (
          <span
            className="cm cm-draft"
            title="有改动还没发布，在发布之前新建集群和生成交付都还用原来的内容"
          >
            <i />
            未发布
          </span>
        )}
      </>
    );
  }
  return (
    <>
      {c.source === "custom" && (
        <span className="cm cm-own" title={SOURCE_HELP.custom}>
          <IconCode />
          {SOURCE.custom}
        </span>
      )}
      {c.source === "draft" && <span className="cm cm-draft">草稿</span>}
      {c.has_draft && c.source !== "draft" && (
        <span
          className="cm cm-draft"
          title="有改动还没发布，在发布之前新建集群和生成交付都还用原来的内容"
        >
          <i />
          未发布
        </span>
      )}
    </>
  );
}

function ComponentDetail({
  c,
  admin,
  narrow,
  changed,
}: {
  c: Entry;
  admin: boolean;
  narrow: boolean;
  changed: () => void;
}) {
  const [yaml, setYaml] = useState<string | null>(
    () =>
      cached<{ yaml: string }>(`/api/components/${c.id}/manifest`)?.yaml ??
      null,
  );
  const [error, setError] = useState("");
  const loadManifest = (force = false) => {
    if (c.source === "draft") return;
    setError("");
    const req = force
      ? api<{ yaml: string }>(`/api/components/${c.id}/manifest`)
      : fetchCached<{ yaml: string }>(`/api/components/${c.id}/manifest`);
    req
      .then((r) => setYaml(r.yaml))
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => {
    loadManifest(false);
  }, [c.id, c.source]); // eslint-disable-line react-hooks/exhaustive-deps
  const [fork, setFork] = useState(false);
  const edit = () => go({ name: "components", id: c.id, edit: "overview" });
  const remove = () =>
    Modal.confirm({
      title:
        c.source === "override" ? `恢复内置的 ${c.name}？` : `删除 ${c.name}？`,
      content:
        c.source === "override"
          ? "你的覆盖版本和未发布的草稿会被移除，恢复为内置的同名组件（历史修订仍可查看）。已生成的交付不受影响。"
          : "删除后不能再用它生成新的交付，草稿和修订历史也一并删除；已生成的交付不受影响。",
      okText: c.source === "override" ? "恢复内置" : "删除",
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          await api(`/api/components/${c.id}`, { method: "DELETE" });
          Message.success("已删除");
          changed();
          go({ name: "components" }, { replace: true });
        } catch (e) {
          err(e);
        }
      },
    });
  return (
    <article className="detail enter">
      {narrow && (
        <Button
          type="text"
          className="back"
          icon={<IconArrowLeft />}
          onClick={() => go({ name: "components" })}
        >
          组件
        </Button>
      )}
      <header className="detail-head flat">
        <AppGlyph
          id={c.id}
          category={c.category}
          size={48}
          muted={!c.available}
        />
        <div className="detail-title">
          <h1>
            {c.name} <span className="mono small faint">{c.id}</span>
          </h1>
          <p className="muted">{c.description}</p>
          <div className="row-gap">
            <CompMarks c={c} />
            {c.provides?.map((p) => (
              <span className="flag" key={p} title="提供的能力">
                提供 {p}
              </span>
            ))}
            {c.kind === "external" && (
              <span className="flag warn">由客户运维，平台只出配置清单</span>
            )}
          </div>
        </div>
        <div className="detail-actions">
          {admin && c.source === "builtin" && (
            <>
              <Button type="primary" icon={<IconEdit />} onClick={edit}>
                修改…
              </Button>
              <Button icon={<IconCopy />} onClick={() => setFork(true)}>
                复制为自定义组件
              </Button>
            </>
          )}
          {admin && c.source !== "builtin" && (
            <Button type="primary" icon={<IconEdit />} onClick={edit}>
              {c.has_draft ? "继续编辑草稿" : "编辑"}
            </Button>
          )}
          {c.source !== "draft" && (
            <Button
              icon={<IconDownload />}
              href={`/api/components/${c.id}/pack`}
              download={`${c.id}.tar.gz`}
            >
              导出组件包
            </Button>
          )}
          {can("component.publish") && c.source === "override" && (
            <Button icon={<IconUndo />} onClick={remove}>
              恢复内置
            </Button>
          )}
          {can("component.publish") && c.source === "custom" && (
            <Button status="danger" icon={<IconDelete />} onClick={remove}>
              删除
            </Button>
          )}
        </div>
      </header>

      {c.source === "draft" && (
        <div className="note">
          这是一个还没有发布的新组件，只有草稿。
          {admin
            ? "继续编辑，检查、试生成之后发布，它才会出现在可用的组件里。"
            : "由管理员编辑并发布后才能使用。"}
        </div>
      )}
      {c.has_draft && c.source !== "draft" && (
        <div className="note">
          这个组件有一份未发布的草稿，不影响现在生成的交付。
          {admin && (
            <button type="button" className="wb-link" onClick={edit}>
              继续编辑
            </button>
          )}
        </div>
      )}
      {c.broken && (
        <div className="cv-err-panel" role="alert">
          <div className="cv-err-head">
            <IconExclamationCircle className="cv-err-ic" />
            <div>
              <b>
                {c.source === "override"
                  ? "自定义覆盖版本无法载入，当前已回退使用内置版本"
                  : "自定义组件清单无法载入，当前已跳过"}
              </b>
              <p>
                {/\$file|common|shared|公共|引用|not found|no such file|不存在/i.test(
                  c.problem || "",
                )
                  ? "检测到引用的共享流程或外部片段缺失，请检查平台公共流程（platform-shared）或组件内的引用文件。"
                  : c.source === "override"
                    ? "请进入编辑器修正后重新发布，或点击右上角「恢复内置」回到内置原样。"
                    : "请进入编辑器或修正组件清单后重新导入，不影响其他组件运行。"}
              </p>
            </div>
          </div>
          {c.problem && <pre className="cv-err-detail mono">{c.problem}</pre>}
          <div className="cv-err-acts">
            {admin && (
              <Button
                size="small"
                type="primary"
                icon={<IconEdit />}
                onClick={edit}
              >
                {c.has_draft ? "继续编辑草稿" : "打开编辑器修复"}
              </Button>
            )}
            {admin && (
              <Button
                size="small"
                icon={<IconCode />}
                onClick={() =>
                  go({
                    name: "components",
                    id: "platform-shared",
                    edit: "files",
                  })
                }
              >
                检查平台公共流程
              </Button>
            )}
            <Button
              size="small"
              icon={<IconRefresh />}
              onClick={() => {
                changed();
                loadManifest(true);
              }}
            >
              重新检测
            </Button>
          </div>
        </div>
      )}
      {c.source !== "draft" && (
        <ComponentPanes
          entry={c}
          yaml={yaml}
          admin={admin}
          error={error}
          onRetry={() => loadManifest(true)}
        />
      )}
      <ForkModal from={c.id} open={fork} close={() => setFork(false)} />
    </article>
  );
}

/* ---------------------------------------------------------------- import */

function ImportDrawer({
  open,
  onClose,
  narrow,
  done,
}: {
  open: boolean;
  onClose: () => void;
  narrow: boolean;
  done: (name: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"pack" | "yaml">("pack");
  const [file, setFile] = useState<File | undefined>();
  const [text, setText] = useState(TEMPLATE);
  const [result, setResult] = useState<Validation | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setResult(null);
  }, [open]);

  const validate = async () => {
    setBusy(true);
    try {
      setResult(
        await api<Validation>("/api/components/validate", {
          method: "POST",
          body: JSON.stringify({ yaml: text }),
        }),
      );
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      let r: Validation;
      if (mode === "pack") {
        if (!file) return err(new Error("请选择组件包"));
        const f = new FormData();
        f.set("pack", file);
        r = await api<Validation>("/api/components/import", {
          method: "POST",
          body: f,
        });
      } else {
        r = await api<Validation>("/api/components/import", {
          method: "POST",
          body: JSON.stringify({ yaml: text }),
        });
      }
      Message.success(`已导入 ${r.name || "组件"}`);
      await done(r.name || "");
    } catch (e) {
      // A refused manifest answers 422 with the full list of problems.
      const body = (e as ApiError).body as Validation | undefined;
      if ((e as ApiError).status === 422 && body?.problems) setResult(body);
      else err(e);
    } finally {
      setBusy(false);
    }
  };
  const errors = result?.problems.filter((p) => p.severity === "error") || [];
  const warns = result?.problems.filter((p) => p.severity === "warning") || [];
  return (
    <Drawer
      width={narrow ? "100%" : 680}
      visible={open}
      onCancel={onClose}
      title="导入组件"
      footer={
        <div className="review-foot">
          <span className="muted small">
            导入后立即可用于新的交付；已生成的交付不受影响
          </span>
          <div className="row-gap">
            {mode === "yaml" && (
              <Button loading={busy} onClick={validate}>
                校验
              </Button>
            )}
            <Button
              type="primary"
              loading={busy}
              disabled={mode === "pack" ? !file : !text.trim()}
              onClick={submit}
            >
              导入
            </Button>
          </div>
        </div>
      }
    >
      <Segmented
        label="导入方式"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setResult(null);
        }}
        options={[
          { value: "pack", label: "上传组件包" },
          { value: "yaml", label: "粘贴清单 YAML" },
        ]}
      />
      {mode === "pack" ? (
        <div className="import-body">
          <p className="muted small">
            .tar.gz 或 .zip，含 <code>component.yaml</code>，可带{" "}
            <code>roles/</code>（Ansible 角色）、<code>templates/</code>
            （配置模板）、<code>files/</code>
            。可先在“组件”页导出一个现有组件作为样板。
          </p>
          <Upload
            drag
            autoUpload={false}
            limit={1}
            accept=".gz,.tgz,.zip"
            fileList={
              file
                ? [
                    {
                      uid: "pack",
                      name: file.name,
                      originFile: file,
                      status: "done",
                    },
                  ]
                : []
            }
            onChange={(l) => setFile(l[0]?.originFile)}
            tip="单个包不超过 8 MiB"
          />
        </div>
      ) : (
        <div className="import-body">
          <p className="muted small">
            只含 component.yaml
            的纯声明式组件可以直接粘贴；需要配置模板或自写角色时请用组件包。步骤只允许
            ansible.builtin 里的安全模块，不允许 shell 和 ignore_errors。
          </p>
          <textarea
            className="yaml-edit mono"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="组件清单 YAML"
          />
        </div>
      )}
      {result && (
        <div className="import-result">
          {result.ok ? (
            <div className="note">
              校验通过{result.name ? `：${result.name}` : ""}。
            </div>
          ) : (
            <div className="note warn">
              有 {errors.length} 处错误，不能导入。
            </div>
          )}
          {[...errors, ...warns].map((p, i) => (
            <div className={`issue-line ${p.severity}`} key={i}>
              {p.path && <code>{p.path}</code>}
              <span>{p.message}</span>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}

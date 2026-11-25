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
} from "../../shared/shared";
import type { ApiError } from "../../shared/shared";
import type { AppInfo, Session } from "../../shared/shared";
import { go } from "../../app/router";
import { AppGlyph, Kbd, Segmented, StatusBadge } from "../../design/ui";
import { Terminal } from "../projects/runbook";
import { ForkModal, NewComponentModal } from "./wbdialogs";
import { ComponentPanes } from "./compview";
import { registerStyles } from "../../design/glyphs";
import { bi, canonicalCat, catLabel, useLang, withLang } from "../../app/i18n";

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

const sourceLabel = (s: string) =>
  s === "builtin"
    ? bi("内置", "Built-in")
    : s === "custom"
      ? bi("自定义", "Custom")
      : s === "override"
        ? bi("已修改", "Modified")
        : s === "draft"
          ? bi("未发布", "Unpublished")
          : s;
const sourceHelp = (s: string) =>
  s === "override"
    ? bi(
        "这是内置组件，你改过并发布了自己的版本，平台现在用的是你的版本。要回到原样，打开它点「恢复内置」。",
        "This built-in component has a published custom override. Click Reset to Built-in to revert.",
      )
    : s === "custom"
      ? bi("你自己创建或导入的组件。", "A component you created or imported.")
      : s === "draft"
        ? bi("还没有发布的新组件，只有草稿。", "An unpublished new component with only a draft.")
        : "";

const getTemplate = () =>
  bi(
    `schema: mwpack/v1
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
`,
    `schema: mwpack/v1
component: my-app            # lowercase start, matches directory name
short: app                   # default instance prefix in deploy form
title: My App
category: Other
summary: Short one-line summary
provides: []

roles:
  - {name: node, title: Node, min: 1, max: 5, default: 1}

params:
  - {key: port, label: Service Port, type: port, default: 8080}

ports:
  - {name: service, value: =params.port}

versions:
  - id: "1.0"
    status: draft            # draft -> verifying -> published
    platforms: [ubuntu-24.04-amd64]
    packages: [{name: my-app}]
    artifacts:
      - {name: offline-repo, kind: apt-repo, root: offline-repo, file: offline-repo.tar.gz}

lifecycle:
  install:
    - id: packages
      title: Install packages
      tasks:
        - name: Install
          ansible.builtin.apt:
            name: "{{ mw.packages | map(attribute='spec') | list }}"
            state: present
            update_cache: false
  start:
    - id: start
      title: Start service
      tasks:
        - name: Start
          ansible.builtin.systemd: {name: my-app, enabled: true, state: started}

tests:
  - id: port
    title: Port reachable
    effect: read-only
    tasks:
      - name: Connect to service port
        ansible.builtin.wait_for: {port: "{{ mw.params.port }}", timeout: 5}
`,
  );

export function ComponentsPage({
  me,
  selected,
}: {
  me: Session;
  selected?: string;
}) {
  const lang = useLang();
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
  }, [lang]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      list.filter(
        (c) =>
          !q ||
          `${c.id} ${c.name} ${c.category} ${catLabel(c.category)} ${c.description}`
            .toLowerCase()
            .includes(q),
      ),
    [list, q, lang],
  );
  const groups = useMemo(() => {
    const m = new Map<string, Entry[]>();
    shown.forEach((c) => {
      const k = canonicalCat(c.category) || "__other__";
      m.set(k, [...(m.get(k) || []), c]);
    });
    const labelOf = (k: string) =>
      k === "__other__" ? bi("其他", "Other") : catLabel(k);
    return [...m.entries()]
      .map(([k, items]) => [labelOf(k), items, k] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown, lang]);

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
        <aside className="md-list" aria-label={bi("组件列表", "Component list")}>
          <div className="list-head">
            <div className="list-title">
              <h1>{bi("组件", "Components")}</h1>
              {(admin || can("component.import")) && (
                <span className="row-gap" style={{ gap: 6, flexShrink: 0 }}>
                  {can("component.import") && (
                    <Button
                      size="small"
                      icon={<IconUpload />}
                      onClick={() => setOpen(true)}
                      style={{ padding: "0 8px" }}
                    >
                      {bi("导入", "Import")}
                    </Button>
                  )}
                  {admin && (
                    <Button
                      type="primary"
                      size="small"
                      icon={<IconPlus />}
                      onClick={() => setCreate(true)}
                      style={{ padding: "0 8px" }}
                    >
                      {bi("新建", "New")}
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
              placeholder={bi("搜索组件", "Search components")}
              value={query}
              onChange={setQuery}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (query) setQuery("");
                  (e.target as HTMLElement).blur();
                }
              }}
              aria-label={bi("搜索组件", "Search components")}
            />
            <div className="list-guides">
              {admin && (
                <a
                  className="list-guide"
                  href="#/components/platform-shared/edit/files"
                >
                  <IconCode /> {bi("平台公共流程", "Platform Shared Flows")}
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
                <IconBook /> {bi("怎么编写和修改组件", "How to build & customize")}
              </a>
            </div>
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
              <p>{message || bi("组件加载失败", "Failed to load components")}</p>
              <Button size="small" icon={<IconRefresh />} onClick={reload}>
                {bi("重试", "Retry")}
              </Button>
            </div>
          ) : !shown.length ? (
            <div className="list-state">
              <p>{bi("没有匹配的组件", "No matching components")}</p>
              <Button size="small" onClick={() => setQuery("")}>
                {bi("清除搜索", "Clear search")}
              </Button>
            </div>
          ) : (
            <div className="list-body" role="listbox" aria-label={bi("组件", "Components")}>
              {groups.map(([cat, items, rawCat]) => (
                <React.Fragment key={rawCat}>
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
                                ? bi("已回退内置版，编辑或恢复内置可修复", "Fell back to built-in; edit or reset to fix")
                                : bi("已跳过，修复或删除后恢复", "Skipped; fix or delete to recover")
                              : bi("尚未发布", "Unpublished")}
                          </div>
                        ) : (
                          <div className="cr-meta">
                            <span
                              className={`cr-state ${c.available ? "ok" : c.kind === "external" ? "ext" : "bad"}`}
                              title={c.available ? bi("可以生成交付", "Ready to generate deliveries") : c.reason}
                            >
                              {c.available
                                ? c.kind === "external"
                                  ? bi("只出配置", "Config only")
                                  : bi("可生成", "Ready")
                                : bi("缺软件包", "Missing pkgs")}
                            </span>
                            {c.roles.length > 0 && (
                              <span
                                className="cr-roles"
                                title={c.roles
                                  .map(
                                    (r) =>
                                      `${r.title || r.name}: ${
                                        r.max && r.min === r.max
                                          ? bi(`固定 ${r.min} 台`, `Fixed ${r.min}`)
                                          : bi(
                                              `${r.min} 台起，常用 ${r.default ?? r.min} 台`,
                                              `≥ ${r.min}, default ${r.default ?? r.min}`,
                                            )
                                      }${r.odd ? bi("，建议奇数", ", odd advised") : ""}`,
                                  )
                                  .join("\n")}
                              >
                                {c.roles
                                  .map(
                                    (r) =>
                                      `${r.title || r.name} ${r.default ?? r.min}`,
                                  )
                                  .join(" + ")}
                                {bi(" 台起步", "+ nodes")}
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
              <h2>{bi("找不到这个组件", "Component not found")}</h2>
              <Button
                onClick={() => go({ name: "components" }, { replace: true })}
              >
                {bi("返回组件列表", "Back to Components")}
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
  useLang();
  const draftTip = bi(
    "有改动还没发布，在发布之前新建集群和生成交付都还用原来的内容",
    "Unpublished changes exist; new clusters and deliveries still use the published version",
  );
  if (c.broken) {
    return (
      <>
        <span className="cm cm-bad">
          {c.source === "override"
            ? bi("覆盖版有误", "Override error")
            : bi("无法载入", "Load error")}
        </span>
        {c.has_draft && (
          <span className="cm cm-draft" title={draftTip}>
            <i />
            {bi("未发布", "Unpublished")}
          </span>
        )}
      </>
    );
  }
  return (
    <>
      {c.source === "custom" && (
        <span className="cm cm-own" title={sourceHelp("custom")}>
          <IconCode />
          {sourceLabel("custom")}
        </span>
      )}
      {c.source === "draft" && (
        <span className="cm cm-draft">{bi("草稿", "Draft")}</span>
      )}
      {c.has_draft && c.source !== "draft" && (
        <span className="cm cm-draft" title={draftTip}>
          <i />
          {bi("未发布", "Unpublished")}
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
  const lang = useLang();
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
  }, [c.id, c.source, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const [fork, setFork] = useState(false);
  const deletingLockRef = useRef(false);
  const edit = () => go({ name: "components", id: c.id, edit: "overview" });
  const remove = () =>
    Modal.confirm({
      title:
        c.source === "override"
          ? bi(`恢复内置的 ${c.name}？`, `Reset ${c.name} to built-in?`)
          : bi(`删除 ${c.name}？`, `Delete ${c.name}?`),
      content:
        c.source === "override"
          ? bi(
              "你的覆盖版本和未发布的草稿会被移除，恢复为内置的同名组件（历史修订仍可查看）。已生成的交付不受影响。",
              "Your override and unpublished draft will be removed, restoring the built-in component (revision history stays viewable). Existing deliveries are unaffected.",
            )
          : bi(
              "删除后不能再用它生成新的交付，草稿和修订历史也一并删除；已生成的交付不受影响。",
              "Deletes this component, its draft, and revision history; existing deliveries are unaffected.",
            ),
      okText:
        c.source === "override"
          ? bi("恢复内置", "Reset to Built-in")
          : bi("删除", "Delete"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (deletingLockRef.current) return;
        deletingLockRef.current = true;
        try {
          await api(`/api/components/${c.id}`, { method: "DELETE" });
          Message.success(bi("已删除", "Deleted"));
          changed();
          go({ name: "components" }, { replace: true });
        } catch (e) {
          err(e);
        } finally {
          deletingLockRef.current = false;
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
          {bi("组件", "Components")}
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
          {(c.broken ||
            c.source === "custom" ||
            c.source === "draft" ||
            c.has_draft ||
            (c.provides && c.provides.length > 0) ||
            c.kind === "external") && (
            <div className="row-gap cv-head-tags">
              <CompMarks c={c} />
              {c.provides?.map((p) => (
                <span className="flag" key={p} title={bi("提供的能力", "Provided capability")}>
                  {bi(`提供 ${p}`, `Provides ${p}`)}
                </span>
              ))}
              {c.kind === "external" && (
                <span className="flag warn">
                  {bi("由客户运维，平台只出配置清单", "Customer-managed; platform outputs config only")}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="detail-actions">
          {admin && c.source === "builtin" && (
            <>
              <Button type="primary" icon={<IconEdit />} onClick={edit}>
                {bi("修改…", "Modify...")}
              </Button>
              <Button icon={<IconCopy />} onClick={() => setFork(true)}>
                {bi("复制为自定义组件", "Copy as Custom")}
              </Button>
            </>
          )}
          {admin && c.source !== "builtin" && (
            <Button type="primary" icon={<IconEdit />} onClick={edit}>
              {c.has_draft ? bi("继续编辑草稿", "Resume Draft") : bi("编辑", "Edit")}
            </Button>
          )}
          {c.source !== "draft" && (
            <Button
              icon={<IconDownload />}
              href={withLang(`/api/components/${c.id}/pack`)}
              download={`${c.id}.tar.gz`}
            >
              {bi("导出组件包", "Export Pack")}
            </Button>
          )}
          {can("component.publish") && c.source === "override" && (
            <Button icon={<IconUndo />} onClick={remove}>
              {bi("恢复内置", "Reset to Built-in")}
            </Button>
          )}
          {can("component.publish") && c.source === "custom" && (
            <Button status="danger" icon={<IconDelete />} onClick={remove}>
              {bi("删除", "Delete")}
            </Button>
          )}
        </div>
      </header>

      {c.source === "draft" && (
        <div className="note cv-draft-note">
          <span>
            {bi("这是一个还没有发布的新组件，只有草稿。", "This new component is an unpublished draft. ")}
            {admin
              ? bi(
                  "继续编辑，检查、试生成之后发布，它才会出现在可用的组件里。",
                  "Continue editing, check, trial-generate, and publish to make it available in the catalog.",
                )
              : bi("由管理员编辑并发布后才能使用。", "Available after an administrator edits and publishes it.")}
          </span>
        </div>
      )}
      {c.has_draft && c.source !== "draft" && (
        <div className="note cv-draft-note">
          <span>
            {bi(
              "这个组件有一份未发布的草稿，不影响现在生成的交付。",
              "This component has an unpublished draft; current deliveries are unaffected.",
            )}
          </span>
          {admin && (
            <button type="button" className="wb-link" onClick={edit}>
              {bi("继续编辑", "Resume editing")}
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
                  ? bi("自定义覆盖版本无法载入，当前已回退使用内置版本", "Custom override failed to load; reverted to built-in version")
                  : bi("自定义组件清单无法载入，当前已跳过", "Custom component manifest failed to load; skipped")}
              </b>
              <p>
                {/\$file|common|shared|reference|missing|公共|引用|not found|no such file|不存在/i.test(
                  c.problem || "",
                )
                  ? bi(
                      "检测到引用的共享流程或外部片段缺失，请检查平台公共流程（platform-shared）或组件内的引用文件。",
                      "Missing shared flow or external fragment reference; check platform-shared or referenced files inside the component.",
                    )
                  : c.source === "override"
                    ? bi(
                        "请进入编辑器修正后重新发布，或点击右上角「恢复内置」回到内置原样。",
                        "Fix and republish in the editor, or click Reset to Built-in above.",
                      )
                    : bi(
                        "请进入编辑器或修正组件清单后重新导入，不影响其他组件运行。",
                        "Open the editor or fix and re-import the manifest; other components are unaffected.",
                      )}
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
                {c.has_draft ? bi("继续编辑草稿", "Resume Draft") : bi("打开编辑器修复", "Fix in Editor")}
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
                {bi("检查平台公共流程", "Check Platform Shared Flows")}
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
              {bi("重新检测", "Re-check")}
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
  const lang = useLang();
  const [mode, setMode] = useState<"pack" | "yaml">("pack");
  const [file, setFile] = useState<File | undefined>();
  const [text, setText] = useState(getTemplate);
  const [edited, setEdited] = useState(false);
  const [result, setResult] = useState<Validation | null>(null);
  const [busy, setBusy] = useState(false);
  const busyLockRef = useRef(false);
  useEffect(() => {
    if (open) setResult(null);
  }, [open]);
  useEffect(() => {
    if (!edited) setText(getTemplate());
  }, [lang, edited]);

  const validate = async () => {
    if (busyLockRef.current) return;
    busyLockRef.current = true;
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
      busyLockRef.current = false;
      setBusy(false);
    }
  };
  const submit = async () => {
    if (busyLockRef.current) return;
    busyLockRef.current = true;
    setBusy(true);
    setResult(null);
    try {
      let r: Validation;
      if (mode === "pack") {
        if (!file) return err(new Error(bi("请选择组件包", "Please select a component pack")));
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
      Message.success(bi(`已导入 ${r.name || "组件"}`, `Imported ${r.name || "component"}`));
      await done(r.name || "");
    } catch (e) {
      // A refused manifest answers 422 with the full list of problems.
      const body = (e as ApiError).body as Validation | undefined;
      if ((e as ApiError).status === 422 && body?.problems) setResult(body);
      else err(e);
    } finally {
      busyLockRef.current = false;
      setBusy(false);
    }
  };
  const errors = result?.problems.filter((p) => p.severity === "error") || [];
  const warns = result?.problems.filter((p) => p.severity === "warning") || [];
  return (
    <Drawer
      width={narrow ? "100%" : "min(680px, 100vw)"}
      visible={open}
      onCancel={onClose}
      title={bi("导入组件", "Import Component")}
      footer={
        <div className="review-foot">
          <span className="muted small">
            {bi(
              "导入后立即可用于新的交付；已生成的交付不受影响",
              "Available immediately for new deliveries after import; existing deliveries are unaffected",
            )}
          </span>
          <div className="row-gap">
            {mode === "yaml" && (
              <Button loading={busy} onClick={validate}>
                {bi("校验", "Validate")}
              </Button>
            )}
            <Button
              type="primary"
              loading={busy}
              disabled={mode === "pack" ? !file : !text.trim()}
              onClick={submit}
            >
              {bi("导入", "Import")}
            </Button>
          </div>
        </div>
      }
    >
      <Segmented
        label={bi("导入方式", "Import Method")}
        value={mode}
        onChange={(m) => {
          setMode(m);
          setResult(null);
        }}
        options={[
          { value: "pack", label: bi("上传组件包", "Upload Component Pack") },
          { value: "yaml", label: bi("粘贴清单 YAML", "Paste Manifest YAML") },
        ]}
      />
      {mode === "pack" ? (
        <div className="import-body">
          <p className="muted small">
            {bi(".tar.gz 或 .zip，含 ", ".tar.gz or .zip containing ")}
            <code>component.yaml</code>
            {bi("，可带 ", ", optionally with ")}
            <code>roles/</code>
            {bi("（Ansible 角色）、", " (Ansible roles), ")}
            <code>templates/</code>
            {bi("（配置模板）、", " (config templates), and ")}
            <code>files/</code>
            {bi(
              "。可先在“组件”页导出一个现有组件作为样板。",
              ". Export an existing component from Components as a starting example.",
            )}
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
            tip={bi("单个包不超过 8 MiB", "Max 8 MiB per pack")}
          />
        </div>
      ) : (
        <div className="import-body">
          <p className="muted small">
            {bi(
              "只含 component.yaml 的纯声明式组件可以直接粘贴；需要配置模板或自写角色时请用组件包。步骤只允许 ansible.builtin 里的安全模块，不允许 shell 和 ignore_errors。",
              "Declarative-only components with just component.yaml can be pasted directly; use a component pack if you need templates or custom roles. Steps allow only safe ansible.builtin modules; shell and ignore_errors are disallowed.",
            )}
          </p>
          <textarea
            className="yaml-edit mono"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setEdited(true);
              setText(e.target.value);
            }}
            aria-label={bi("组件清单 YAML", "Component manifest YAML")}
          />
        </div>
      )}
      {result && (
        <div className="import-result">
          {result.ok ? (
            <div className="note">
              {bi("校验通过", "Validation passed")}
              {result.name ? `: ${result.name}` : ""}.
            </div>
          ) : (
            <div className="note warn">
              {bi(
                `有 ${errors.length} 处错误，不能导入。`,
                `${errors.length} error(s) found; cannot import.`,
              )}
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

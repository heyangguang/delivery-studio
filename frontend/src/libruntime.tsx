import React, { useEffect, useRef, useState } from "react";
import { OsLogo, OsName } from "./oslogo";
import {
  Button,
  Checkbox,
  Dropdown,
  Input,
  Menu,
  Message,
  Modal,
  Select,
  Switch,
  Upload,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconCode,
  IconDelete,
  IconDown,
  IconExport,
  IconImport,
  IconInfoCircle,
  IconMore,
  IconPlus,
} from "@arco-design/web-react/icon";
import { ago, api, can, err, size, useAIStatus } from "./shared";
import type { ApiError, FetchTask } from "./shared";
import { Spark } from "./aichat";
import { go } from "./router";
import { TaskCard } from "./libtask";
import { bi, useLang, withLang } from "./i18n";
import "./settings.css";
import "./libruntime.css";

function askRuntimeAI(prompt: string, needWeb = true) {
  try {
    sessionStorage.setItem(
      "mw-ai-seed",
      JSON.stringify({ text: prompt, web: needWeb, at: Date.now() }),
    );
  } catch {
    /* ignore storage failures */
  }
  go({ name: "ai" });
}

type Wheel = {
  file: string;
  name: string;
  version: string;
  sha256: string;
  size: number;
  via: string;
};
type RuntimeView = {
  id: string;
  ansible: string;
  python: string;
  wheels: Wheel[];
  note?: string;
  created: string;
  created_by?: string;
  default: string[];
  size: number;
};
type State = {
  runtimes: RuntimeView[];
  wheels: number;
  defaults: Record<string, string>;
  platforms: { id: string; title: string }[];
  python: string;
};

const short = (t: string) => {
  const s = t.replace(/\s*[\(（].*$/, "").trim();
  const el =
    /^(?:Red\s*Hat|RedHat|RHEL)\s*(?:系|family)?\s*(\d+)(?:\s*family)?/i.exec(
      s,
    );
  return el ? bi(`RHEL ${el[1]} 系`, `RHEL ${el[1]} family`) : s;
};

const platMeta = (t: string) => {
  const am = /\s*[（(](amd64|arm64|x86_64|aarch64|ppc64le|s390x)[）)]\s*$/i.exec(t);
  return {
    name: short(t),
    arch: am ? am[1].toLowerCase() : "",
  };
};

function NewRuntime({
  open,
  close,
  st,
  started,
}: {
  open: boolean;
  close: () => void;
  st: State;
  started: (t: FetchTask) => void;
}) {
  useLang();
  const [versions, setVersions] = useState<string[] | null>(null);
  const [verErr, setVerErr] = useState("");
  const [ansible, setAnsible] = useState("");
  const [pins, setPins] = useState("");
  const [offline, setOffline] = useState(false);
  const [defs, setDefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const busyLockRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    setPins("");
    setDefs([]);
    api<string[]>("/api/library/python/versions?name=ansible-core")
      .then((v) => {
        setVersions(v);
        setAnsible((a) => a || v[0] || "");
        setVerErr("");
      })
      .catch((e) => {
        setVersions([]);
        setVerErr((e as Error).message);
        setOffline(true);
      });
  }, [open]);
  const submit = async () => {
    if (!ansible || busyLockRef.current) return;
    const p: Record<string, string> = {};
    for (const line of pins.split(/\n|,/)) {
      const m = /^\s*([A-Za-z0-9._-]+)\s*==\s*([0-9][^\s]*)\s*$/.exec(line);
      if (m) p[m[1]] = m[2];
      else if (line.trim())
        return Message.error(
          bi(
            `看不懂这一行：${line.trim()}（写成 包名==版本）`,
            `Invalid line: ${line.trim()} (expected pkg==version)`,
          ),
        );
    }
    busyLockRef.current = true;
    setBusy(true);
    try {
      const t = await api<FetchTask>("/api/library/python/build", {
        method: "POST",
        body: JSON.stringify({ ansible, pins: p, offline, set_default: defs }),
      });
      started(t);
      close();
    } catch (e) {
      err(e);
    } finally {
      busyLockRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      visible={open}
      onCancel={close}
      title={bi("新建运行环境", "New Runtime")}
      onOk={submit}
      okText={bi("开始准备", "Build")}
      confirmLoading={busy}
      okButtonProps={{ disabled: !ansible }}
      style={{ width: 520, maxWidth: "94vw" }}
    >
      <div className="st-form">
        <div className="st-field">
          <span>{bi("ansible-core 版本", "ansible-core version")}</span>
          {versions && versions.length > 0 ? (
            <Select
              value={ansible}
              onChange={setAnsible}
              options={versions}
              showSearch
              aria-label={bi("ansible-core 版本", "ansible-core version")}
            />
          ) : (
            <Input
              value={ansible}
              onChange={setAnsible}
              placeholder="2.20.10"
              aria-label={bi("ansible-core 版本", "ansible-core version")}
            />
          )}
          <small>
            {verErr
              ? bi(
                  `读不到 PyPI（${verErr}），只能用软件库里已有的包，手动填写版本。`,
                  `Unable to reach PyPI (${verErr}); enter a version manually using packages already in the library.`,
                )
              : bi(
                  `控制节点 Python ${st.python}；依赖由 pip 自动解析。`,
                  `Controller Python ${st.python}; dependencies resolved automatically by pip.`,
                )}
          </small>
        </div>
        <div className="st-field">
          <span>{bi("固定某些包的版本（可选）", "Pin package versions (optional)")}</span>
          <Input.TextArea
            value={pins}
            onChange={setPins}
            placeholder={"pip==26.2\njinja2==3.1.6"}
            autoSize={{ minRows: 2, maxRows: 5 }}
            aria-label={bi("固定版本", "Pin versions")}
          />
          <small>
            {bi(
              "每行一个 包名==版本，用于显式锁定依赖版本。",
              "One pkg==version per line to explicitly lock dependency versions.",
            )}
          </small>
        </div>
        <div className="st-field row">
          <span>{bi("只用软件库里已有的包（不联网）", "Use library packages only (offline)")}</span>
          <Switch
            checked={offline}
            onChange={setOffline}
            aria-label={bi("只用软件库里已有的包", "Use library packages only")}
          />
        </div>
        <div className="st-field">
          <span>{bi("准备好后设为默认", "Set as default when ready")}</span>
          <Checkbox.Group
            className="rtl-os-checks"
            value={defs}
            onChange={setDefs}
            options={st.platforms.map((p) => ({
              value: p.id,
              label: <OsName id={p.id} title={p.title} size={16} />,
            }))}
          />
          <small>
            {bi(
              "设为默认后，这个系统新生成的交付都带它。",
              "New deliveries for selected OS platforms will use this runtime by default.",
            )}
          </small>
        </div>
      </div>
    </Modal>
  );
}

/** One group per ansible-core version: the default/newest build leads; sibling builds fold into the group's footer tray. */
function groupRuntimes(list: RuntimeView[]): [RuntimeView, RuntimeView[]][] {
  const by = new Map<string, RuntimeView[]>();
  for (const r of list) by.set(r.ansible, [...(by.get(r.ansible) || []), r]);
  return [...by.values()].map((g) => {
    const sorted = [...g].sort((a, b) => b.created.localeCompare(a.created));
    const main = sorted.find((r) => r.default.length) || sorted[0];
    return [main, sorted.filter((r) => r !== main)];
  });
}

/** Shorten raw 24+ char hex job/delivery IDs inside notes for display while preserving the full string in tooltips. */
const formatNote = (note: string) =>
  note.replace(/\b([0-9a-f]{8})[0-9a-f]{16,}\b/gi, "$1…");

const viaLabel = (via?: string) =>
  via === "pypi"
    ? bi("来自 PyPI", "PyPI")
    : via === "imported"
      ? bi("导入", "Imported")
      : via === "runtime-archive"
        ? bi("原运行环境", "Original")
        : bi("软件库", "Library");

function RuntimeGroup({
  main,
  twins,
  st,
  admin,
  onTask,
  changed,
}: {
  main: RuntimeView;
  twins: RuntimeView[];
  st: State;
  admin: boolean;
  onTask?: (t: FetchTask) => void;
  changed: () => void;
}) {
  useLang();
  const [siblingsOpen, setSiblingsOpen] = useState(false);
  return (
    <li className={`rtl-group ${main.default.length ? "is-default" : ""}`}>
      <RuntimeRow
        r={main}
        st={st}
        admin={admin}
        onTask={onTask}
        changed={changed}
      />
      {twins.length > 0 && (
        <div className={`rtl-siblings ${siblingsOpen ? "open" : ""}`}>
          <button
            type="button"
            className="rtl-siblings-bar"
            aria-expanded={siblingsOpen}
            onClick={() => setSiblingsOpen(!siblingsOpen)}
          >
            <span className="rtl-siblings-left">
              <span className="rtl-siblings-head">
                <span className="rtl-siblings-dot" aria-hidden />
                <span className="rtl-siblings-label">
                  {siblingsOpen
                    ? bi(
                        `同版本历史构建（仅快照留档，当前生效为上方默认版）`,
                        `Historical builds of v${main.ansible} (archived snapshots; default above is active)`,
                      )
                    : bi(
                        `同版本另有 ${twins.length} 个历史构建`,
                        `${twins.length} historical ${twins.length === 1 ? "build" : "builds"} of v${main.ansible}`,
                      )}
                </span>
              </span>
              {siblingsOpen ? (
                <em className="rtl-siblings-count num">{twins.length}</em>
              ) : (
                <span className="rtl-siblings-previews">
                  {twins.slice(0, 3).map((t) => (
                    <code key={t.id} className="rtl-mini-id mono">
                      {t.id.slice(0, 8)}
                    </code>
                  ))}
                  {twins.length > 3 && (
                    <span className="faint small">+{twins.length - 3}</span>
                  )}
                </span>
              )}
            </span>
            <span className="rtl-siblings-toggle">
              {siblingsOpen ? bi("收起", "Collapse") : bi("展开", "Expand")}
              <IconDown className={`so-caret ${siblingsOpen ? "flip" : ""}`} />
            </span>
          </button>
          {siblingsOpen && (
            <ul className="rtl-sibling-list">
              {twins.map((r) => (
                <RuntimeRow
                  key={r.id}
                  r={r}
                  baseline={main}
                  isSibling
                  st={st}
                  admin={admin}
                  onTask={onTask}
                  changed={changed}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function RuntimeRow({
  r,
  baseline,
  isSibling = false,
  st,
  admin,
  changed,
}: {
  r: RuntimeView;
  baseline?: RuntimeView;
  isSibling?: boolean;
  st: State;
  admin: boolean;
  onTask?: (t: FetchTask) => void;
  changed: () => void;
}) {
  useLang();
  const aiStatus = useAIStatus();
  const canUseAI =
    aiStatus.enabled &&
    !!aiStatus.features?.library &&
    !!aiStatus.features?.assistant &&
    can("ai.use");
  const [open, setOpen] = useState(false);
  const defaultLockRef = useRef(false);
  const removeLockRef = useRef(false);
  const setDefault = async (pl: string) => {
    if (defaultLockRef.current) return;
    defaultLockRef.current = true;
    try {
      await api("/api/library/python/default", {
        method: "PUT",
        body: JSON.stringify({ platform: pl, runtime: r.id }),
      });
      Message.success(bi("已设为默认", "Set as default"));
      changed();
    } catch (e) {
      err(e);
    } finally {
      defaultLockRef.current = false;
    }
  };
  const remove = () =>
    Modal.confirm({
      title: bi(`清理历史构建 ${r.id.slice(0, 10)}？`, `Delete runtime build ${r.id.slice(0, 10)}?`),
      content: bi(
        "已经生成的历史交付不受影响；底层 wheel 包仍保留在软件库中，仅删除此历史运行环境快照。",
        "Existing deliveries are unaffected; underlying wheels remain in the library.",
      ),
      okText: bi("确认清理", "Delete"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (removeLockRef.current) return;
        removeLockRef.current = true;
        try {
          await api(`/api/library/python/runtimes/${r.id}`, {
            method: "DELETE",
          });
          Message.success(bi("已清理历史构建", "Historical build deleted"));
          changed();
        } catch (e) {
          err(e);
        } finally {
          removeLockRef.current = false;
        }
      },
    });

  const baseVersions = baseline
    ? new Map(baseline.wheels.map((w) => [w.name, w.version]))
    : null;
  const wheelDiffs = baseVersions
    ? r.wheels.filter((w) => baseVersions.get(w.name) !== w.version)
    : [];
  const baseIdShort = baseline?.id.slice(0, 8) || "";
  const baseIsDefault = Boolean(baseline && baseline.default.length > 0);
  const baseLabel = baseIsDefault
    ? bi("当前默认版", "current default")
    : bi("最新构建", "latest build");
  const diffSummary = baseline
    ? wheelDiffs.length
      ? bi(
          `与${baseLabel}差异 ${wheelDiffs.length} 项：${wheelDiffs
            .slice(0, 2)
            .map((w) => `${w.name} ${w.version}（默认 ${baseVersions!.get(w.name) ?? "无"}）`)
            .join("、")}${wheelDiffs.length > 2 ? " 等" : ""}`,
          `${wheelDiffs.length} diff vs ${baseLabel}: ${wheelDiffs
            .slice(0, 2)
            .map((w) => `${w.name} ${w.version} (default ${baseVersions!.get(w.name) ?? "none"})`)
            .join(", ")}${wheelDiffs.length > 2 ? ", etc." : ""}`,
        )
      : bi(`与${baseLabel}依赖完全一致`, `Same wheels as ${baseLabel}`)
    : "";

  const askDiffAI = () => {
    const isHist = Boolean(isSibling || baseline);
    const lines = [
      isHist
        ? bi(
            `请帮我评估软件库中的 Ansible 运行环境历史构建：`,
            `Please review this historical Ansible runtime build in the library:`,
          )
        : bi(
            `请帮我评估软件库中的 Ansible 运行环境构建（检查是否存在已知安全漏洞或建议升级的依赖）：`,
            `Please audit this Ansible runtime build in the library for known CVEs or recommended wheel upgrades:`,
          ),
      `- ansible-core ${r.ansible} · Python ${r.python || st.python}`,
      `- ${isHist ? bi("此历史构建", "This historical build") : bi("当前构建", "This build")}: ${r.id} (${r.note || bi("无备注", "no note")})`,
      r.default.length
        ? `- ${bi("当前作为以下系统的默认构建", "Default build for OS")}: ${r.default.join(", ")}`
        : "",
      baseline
        ? `- ${bi("当前默认/主构建", "Current default/primary build")}: ${baseline.id} (${baseline.note || bi("无备注", "no note")})`
        : "",
      wheelDiffs.length
        ? bi(
            `- 依赖版本差异（此历史构建 vs 当前默认构建）：\n${wheelDiffs.map((w) => `  - ${w.name}: 此构建=${w.version}, 当前默认=${baseVersions!.get(w.name) ?? "无"}`).join("\n")}`,
            `- Dependency diffs (this build vs current default):\n${wheelDiffs.map((w) => `  - ${w.name}: this=${w.version}, default=${baseVersions!.get(w.name) ?? "none"}`).join("\n")}`,
          )
        : bi("- 依赖列表：\n", "- Wheel list:\n") +
          r.wheels.map((w) => `  - ${w.name}==${w.version} (${viaLabel(w.via)})`).join("\n"),
      isHist
        ? bi(
            "请用直白的语言告诉我：1）这些包的版本差异有什么实际影响（尤其是是否涉及安全漏洞 CVE 修复或兼容性）？2）这个历史构建现在还需要保留吗，能否安全清理删除？3）当前默认构建里的这些依赖包有没有建议继续升级的？",
            "Please explain plainly: 1) What is the practical impact of these version differences (CVEs/security or compatibility)? 2) Is it safe to delete this historical build? 3) Should any wheels in the current default build be upgraded?",
          )
        : bi(
            "请用直白的语言告诉我：1）当前构建里的这些依赖版本是否存在已知安全漏洞（CVE）或兼容性风险？2）有哪些包建议继续升级？3）软件库里如有其他历史构建，哪些可以安全清理？",
            "Please explain plainly: 1) Do any wheels in this build have known CVEs or compatibility risks? 2) Which packages should be upgraded? 3) Which historical builds in the library can be safely deleted?",
          ),
    ].filter(Boolean);
    askRuntimeAI(lines.join("\n"), true);
  };

  const sourceCounts = r.wheels.reduce<Record<string, number>>((acc, w) => {
    const key = w.via || "lib";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const Wrap = isSibling ? "li" : "div";

  return (
    <Wrap
      className={`rtl-item ${isSibling ? "is-sibling" : "is-primary"} ${open ? "open" : ""} ${r.default.length ? "is-default" : ""}`}
    >
      <div className="rtl-head">
        <button
          type="button"
          className="rtl-main"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {isSibling ? (
            <span className="rtl-sub-marker" aria-hidden>
              <i />
            </span>
          ) : (
            <span className="rtl-ic" aria-hidden>
              <IconCode />
              {r.default.length > 0 && <i className="rtl-ic-dot" />}
            </span>
          )}
          <span className="rtl-name">
            <span
              className={`rtl-title-line ${r.default.length > 0 || diffSummary ? "has-tags" : ""}`}
            >
              <span className="rtl-title-id">
                {isSibling ? (
                  <>
                    <span className="rtl-sub-title">
                      {bi("历史构建", "Historical build")}
                    </span>
                    <code className="rtl-id mono is-strong" title={r.id}>
                      {r.id.slice(0, 10)}
                    </code>
                  </>
                ) : (
                  <>
                    <b>ansible-core {r.ansible}</b>
                    <code className="rtl-id mono" title={r.id}>
                      {r.id.slice(0, 8)}
                    </code>
                  </>
                )}
              </span>
              {(r.default.length > 0 || Boolean(diffSummary)) && (
                <span className="rtl-title-tags">
                  {r.default.map((pl) => (
                    <span key={pl} className="rtl-os-badge">
                      <OsLogo id={pl} size={14} />
                      {short(st.platforms.find((p) => p.id === pl)?.title || pl)}{" "}
                      {bi("默认", "Default")}
                    </span>
                  ))}
                  {diffSummary && (
                    <span
                      className={`rtl-diff-pill ${wheelDiffs.length ? "has-diff" : ""}`}
                    >
                      {diffSummary}
                    </span>
                  )}
                </span>
              )}
            </span>
            <span className="rtl-meta-line">
              <span>
                {bi(
                  `${r.wheels.length} 个依赖包`,
                  `${r.wheels.length} ${r.wheels.length === 1 ? "pkg" : "pkgs"}`,
                )}
              </span>
              <i className="rtl-sep" aria-hidden />
              <span className="num">{size(r.size)}</span>
              {r.python && (
                <>
                  <i className="rtl-sep" aria-hidden />
                  <span>Python {r.python}</span>
                </>
              )}
              <i className="rtl-sep" aria-hidden />
              <span>{ago(r.created)}</span>
            </span>
            {r.note && (
              <span className="rtl-note-line" title={r.note}>
                <i className="rtl-note-dot" aria-hidden />
                <span>{formatNote(r.note)}</span>
              </span>
            )}
          </span>
          <span className="rtl-expand-pill" aria-hidden>
            <span>{open ? bi("收起依赖", "Hide") : bi("查看依赖", "Wheels")}</span>
            <em className="num">{r.wheels.length}</em>
            <IconDown className="so-caret" />
          </span>
        </button>
        {admin && (
          <span className="rtl-acts">
            <Dropdown
              trigger="click"
              position="br"
              droplist={
                <Menu
                  onClickMenuItem={(k) =>
                    k === "del"
                      ? remove()
                      : k === "export"
                        ? (location.href = withLang(
                            `/api/library/python/export?ids=${r.id}`,
                          ))
                        : setDefault(k)
                  }
                >
                  {st.platforms
                    .filter((p) => !r.default.includes(p.id))
                    .map((p) => (
                      <Menu.Item key={p.id}>
                        {bi(
                          `设为 ${short(p.title)} 的默认`,
                          `Set default for ${short(p.title)}`,
                        )}
                      </Menu.Item>
                    ))}
                  <Menu.Item key="export">
                    {bi("导出（带去内网）", "Export (for air-gapped)")}
                  </Menu.Item>
                  <Menu.Item key="del" disabled={r.default.length > 0}>
                    {bi("删除", "Delete")}
                  </Menu.Item>
                </Menu>
              }
            >
              <Button
                type="text"
                className="rtl-more-btn"
                icon={<IconMore />}
                aria-label={bi("更多操作", "More actions")}
              />
            </Dropdown>
          </span>
        )}
      </div>
      {open && (
        <div className="rtl-wheels-wrap">
          {isSibling && baseline && (
            <div className="rtl-diff-explain">
              <div className="rtl-diff-explain-text">
                <IconInfoCircle />
                <span>
                  {wheelDiffs.length > 0
                    ? bi(
                        `这是早期保留的历史快照，并非异常报错。${baseLabel}（${baseIdShort}）正在生效，无需修复；仅当需要回滚到此旧依赖组合时才保留，否则可直接清理（不影响已生成的历史交付）。`,
                        `This is an archived historical snapshot, not an error. The ${baseLabel} (${baseIdShort}) is currently active—no fix is needed. Keep only for rollback, or delete safely (existing deliveries are unaffected).`,
                      )
                    : bi(
                        `此历史快照与${baseLabel}（${baseIdShort}）的依赖版本完全一致，如需精简列表可直接清理（不影响已生成的历史交付）。`,
                        `This historical snapshot has identical wheels to the ${baseLabel} (${baseIdShort}) and can be safely deleted.`,
                      )}
                </span>
              </div>
              <div className="rtl-diff-explain-acts">
                {canUseAI && (
                  <Button
                    shape="round"
                    className="ai-pill"
                    icon={<Spark size={14} rainbow />}
                    onClick={askDiffAI}
                  >
                    {bi("AI 解读差异与建议", "Ask AI to Explain")}
                  </Button>
                )}
                {admin && r.default.length === 0 && (
                  <Button
                    status="danger"
                    type="secondary"
                    icon={<IconDelete />}
                    onClick={remove}
                  >
                    {bi("清理此旧构建", "Delete Old Build")}
                  </Button>
                )}
              </div>
            </div>
          )}
          <div className="rtl-manifest">
            <div className="rtl-manifest-head">
              <span className="rtl-manifest-title">
                {bi("Python 依赖清单", "Python wheel manifest")}
                <em className="num">{r.wheels.length}</em>
              </span>
              <span className="rtl-manifest-stats">
                {wheelDiffs.length > 0 && (
                  <span className="rtl-diff-count num">
                    {bi(
                      `${wheelDiffs.length} 项与默认版不同`,
                      `${wheelDiffs.length} differ from default`,
                    )}
                  </span>
                )}
                {Object.entries(sourceCounts).map(([via, cnt]) => (
                  <span key={via} className={`rtl-via-tag via-${via}`}>
                    {viaLabel(via)} <em className="num">{cnt}</em>
                  </span>
                ))}
                {!isSibling && canUseAI && (
                  <Button
                    shape="round"
                    className="ai-pill"
                    icon={<Spark size={14} rainbow />}
                    onClick={askDiffAI}
                  >
                    {bi("AI 依赖安全体检", "AI Security Audit")}
                  </Button>
                )}
              </span>
            </div>
            <ul className="rtl-wheels">
              {r.wheels.map((w) => {
                const baseVer = baseVersions?.get(w.name);
                const isChanged = baseVersions !== null && baseVer !== w.version;
                return (
                  <li key={w.file} className={isChanged ? "is-diff" : ""}>
                    <span className="rtl-pkg-id">
                      <span className="mono rtl-w">{w.name}</span>
                      <span className="rtl-pkg-vers">
                        <span className="mono rtl-ver">{w.version}</span>
                        {isChanged && (
                          <span
                            className="rtl-ver-diff mono"
                            title={bi(
                              `当前默认构建（${baseIdShort}）使用版本：${baseVer ?? "无"}`,
                              `Current default build (${baseIdShort}) uses: ${baseVer ?? "none"}`,
                            )}
                          >
                            {bi(`当前默认 ${baseVer ?? "无"}`, `default ${baseVer ?? "none"}`)}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="rtl-via">
                      <span className={`rtl-via-tag via-${w.via || "lib"}`}>
                        {viaLabel(w.via)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </Wrap>
  );
}

/** The Ansible runtimes deliveries carry: assembled from wheels in the library, chosen per operating system. */
export function RuntimesView({
  admin,
  narrow,
}: {
  admin: boolean;
  narrow: boolean;
}) {
  const lang = useLang();
  const aiStatus = useAIStatus();
  const canUseAI =
    aiStatus.enabled &&
    !!aiStatus.features?.library &&
    !!aiStatus.features?.assistant &&
    can("ai.use");
  const [st, setSt] = useState<State | null>(null);
  const [task, setTask] = useState<FetchTask | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const importLockRef = useRef(false);
  const load = () =>
    api<State>("/api/library/python")
      .then(setSt)
      .catch(() => undefined);
  useEffect(() => {
    load();
  }, [lang]);
  useEffect(() => {
    if (!task || task.state !== "running") return;
    let inFlight = false;
    const poll = () => {
      if (document.visibilityState !== "visible" || inFlight) return;
      inFlight = true;
      api<FetchTask>(`/api/library/tasks/${task.id}`)
        .then((x) => {
          setTask(x);
          if (x.state !== "running") {
            load();
            x.state === "done"
              ? Message.success(bi("运行环境已准备好", "Runtime is ready"))
              : Message.error(
                  bi("准备没有完成，详情见下方", "Build incomplete; see details below"),
                );
          }
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    const t = setInterval(poll, 1000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [task?.id, task?.state]);
  const doImport = async (file: File) => {
    if (importLockRef.current) return;
    importLockRef.current = true;
    setImporting(true);
    try {
      const f = new FormData();
      f.set("pack", file);
      await api("/api/library/python/import", { method: "POST", body: f });
      Message.success(bi("已导入", "Imported"));
      load();
    } catch (e) {
      Modal.error({
        title: bi("导入失败", "Import failed"),
        content: (e as ApiError).message,
      });
    } finally {
      importLockRef.current = false;
      setImporting(false);
    }
  };
  const askOverviewAI = () => {
    if (!st) return;
    const groups = groupRuntimes(st.runtimes);
    const platSummary = st.platforms.map((p) => {
      const r = st.runtimes.find((x) => x.id === st.defaults[p.id]);
      return r
        ? `  - ${p.title}: ansible-core ${r.ansible} (${r.id.slice(0, 10)})`
        : `  - ${p.title}: ${bi("未配置默认运行环境", "unconfigured")}`;
    });
    const groupSummary = groups.map(([main, twins]) => {
      const baseVers = new Map(main.wheels.map((w) => [w.name, w.version]));
      const wheelStr = main.wheels.map((w) => `${w.name}==${w.version}`).join(", ");
      const twinLines = twins.map((tw) => {
        const diffs = tw.wheels
          .filter((w) => baseVers.get(w.name) !== w.version)
          .map((w) => `${w.name} ${w.version} (默认 ${baseVers.get(w.name) ?? "无"})`);
        return `    - 历史构建 ${tw.id.slice(0, 10)} (${tw.note || "无备注"}): ${
          diffs.length ? diffs.join(", ") : "与默认版依赖一致"
        }`;
      });
      return [
        `  - 主/默认构建 ansible-core ${main.ansible} (${main.id.slice(0, 10)}, Python ${main.python || st.python}): ${wheelStr}`,
        ...twinLines,
      ].join("\n");
    });
    askRuntimeAI(
      [
        bi(
          "请帮我全面体检当前软件库中的 Ansible 运行环境（Python 依赖与历史构建）：",
          "Please audit the Ansible runtimes (Python wheels and historical builds) in my library:",
        ),
        bi("1. 各系统当前默认运行环境：", "1. Default runtime per OS:"),
        ...platSummary,
        bi("2. 全部运行环境与历史构建清单：", "2. All runtimes and historical builds:"),
        ...groupSummary,
        bi(
          "请给出直白、可落地的建议：\n1）当前默认运行环境的依赖包是否有已知安全风险（CVE）或建议升级的版本？\n2）列表中的历史旧构建哪些可以直接清理，哪些有保留必要？\n3）各系统的默认配置是否健康、有无遗漏？",
          "Please give plain, actionable advice:\n1) Do any wheels in active default runtimes have known CVEs or recommended upgrades?\n2) Which historical builds can be safely deleted vs kept?\n3) Are all OS defaults healthy or missing anything?",
        ),
      ].join("\n"),
    );
  };
  return (
    <article className="sx-page enter">
      {narrow && (
        <Button
          type="text"
          className="back"
          icon={<IconArrowLeft />}
          onClick={() => go({ name: "library" })}
        >
          {bi("软件库", "Library")}
        </Button>
      )}
      <header className="sx-page-h rtl-page-head">
        <div className="rtl-page-title">
          <h1>{bi("Ansible 运行环境", "Ansible Runtimes")}</h1>
          <p>
            {bi(
              "交付里带给控制节点的离线 Ansible。由软件库里的 Python 包（wheel）按版本组成，生成交付时当场拼装。",
              "Offline Ansible bundled for the control node in each delivery. Assembled on demand from Python wheels stored in the library.",
            )}
          </p>
        </div>
        {(admin || canUseAI) && (
          <span className="row-gap rtl-page-acts">
            {canUseAI && (
              <Button
                shape="round"
                className="ai-pill"
                icon={<Spark size={14} rainbow />}
                onClick={askOverviewAI}
                disabled={!st?.runtimes.length}
              >
                {bi("AI 依赖审计", "AI Audit")}
              </Button>
            )}
            {admin && (
              <>
                <Upload
                  autoUpload={false}
                  showUploadList={false}
                  accept=".gz,.tgz"
                  onChange={(l) =>
                    l[l.length - 1]?.originFile &&
                    doImport(l[l.length - 1].originFile!)
                  }
                >
                  <Button icon={<IconImport />} loading={importing}>
                    {bi("导入", "Import")}
                  </Button>
                </Upload>
                <Button
                  icon={<IconExport />}
                  href={withLang("/api/library/python/export")}
                  disabled={!st?.runtimes.length}
                >
                  {bi("全部导出", "Export all")}
                </Button>
                <Button
                  type="primary"
                  icon={<IconPlus />}
                  onClick={() => setCreating(true)}
                >
                  {bi("新建运行环境", "New Runtime")}
                </Button>
              </>
            )}
          </span>
        )}
      </header>
      {task && <TaskCard task={task} onClose={() => setTask(null)} />}
      {st && (
        <section className="sx-sec">
          <h2>{bi("各系统使用的运行环境", "Default Runtime per OS")}</h2>
          <ul className="rtl-defs">
            {st.platforms.map((p) => {
              const r = st.runtimes.find((x) => x.id === st.defaults[p.id]);
              const meta = platMeta(p.title);
              return (
                <li key={p.id} className={`rtl-def-card ${r ? "ok" : "miss"}`}>
                  <div className="rtl-def-top">
                    <OsLogo id={p.id} size={28} />
                    <div className="rtl-def-os">
                      <b>{meta.name}</b>
                      {meta.arch && (
                        <span className="rtl-arch mono">{meta.arch}</span>
                      )}
                    </div>
                    <span className={`rtl-def-badge ${r ? "ok" : "warn"}`}>
                      {r
                        ? bi("默认已配置", "Default active")
                        : bi("未设置", "Unconfigured")}
                    </span>
                  </div>
                  {r ? (
                    <div className="rtl-def-meta">
                      <span className="rtl-def-ver">
                        ansible-core {r.ansible}
                      </span>
                      <code className="rtl-id mono" title={r.id}>
                        {r.id.slice(0, 10)}
                      </code>
                      <span className="rtl-def-size">
                        {bi(`${r.wheels.length} 个包`, `${r.wheels.length} pkgs`)}{" "}
                        · {size(r.size)}
                      </span>
                    </div>
                  ) : (
                    <div className="rtl-def-empty warn">
                      {bi(
                        "还没有设置默认运行环境，暂时不能为这个系统生成交付",
                        "Not configured yet; deliveries cannot be built for this OS",
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section className="sx-sec">
        <h2>
          {bi("全部运行环境", "All Runtimes")}{" "}
          <em className="faint num">{st?.runtimes.length ?? ""}</em>
        </h2>
        {st && st.runtimes.length === 0 ? (
          <div className="sx-empty">
            {bi(
              "还没有运行环境。点「新建运行环境」从 PyPI 准备，或导入联网平台导出的包。",
              'No runtimes yet. Click "New Runtime" to build from PyPI, or import a bundle exported from an online instance.',
            )}
          </div>
        ) : (
          <ul className="rtl">
            {groupRuntimes(st?.runtimes || []).map(([main, twins]) => (
              <RuntimeGroup
                key={main.id}
                main={main}
                twins={twins}
                st={st!}
                admin={admin}
                onTask={setTask}
                changed={load}
              />
            ))}
          </ul>
        )}
      </section>
      {st && (
        <NewRuntime
          open={creating}
          close={() => setCreating(false)}
          st={st}
          started={setTask}
        />
      )}
    </article>
  );
}

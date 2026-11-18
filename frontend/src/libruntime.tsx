import React, { useEffect, useState } from "react";
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
  IconDown,
  IconExport,
  IconImport,
  IconMore,
  IconPlus,
} from "@arco-design/web-react/icon";
import { ago, api, err, size } from "./shared";
import type { ApiError, FetchTask } from "./shared";
import { go } from "./router";
import { TaskCard } from "./libtask";
import { bi, useLang, withLang } from "./i18n";
import "./settings.css";
import "./libruntime.css";

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
  const el = /^RedHat(?:\s*系|\s*family)?\s*(\d+)/i.exec(s);
  return el ? bi(`RHEL ${el[1]} 系`, `RHEL ${el[1]} family`) : s;
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

/** One row per ansible-core version: the one in use, else the newest. Other builds of the same version are folded away. */
function groupRuntimes(list: RuntimeView[]): [RuntimeView, RuntimeView[]][] {
  const by = new Map<string, RuntimeView[]>();
  for (const r of list) by.set(r.ansible, [...(by.get(r.ansible) || []), r]);
  return [...by.values()].map((g) => {
    const main =
      g.find((r) => r.default.length) ||
      [...g].sort((a, b) => b.created.localeCompare(a.created))[0];
    return [main, g.filter((r) => r !== main)];
  });
}

function Twins({ children }: { children: React.ReactNode }) {
  useLang();
  const [open, setOpen] = useState(false);
  const n = React.Children.count(children);
  return (
    <li className="rtl-twins">
      <button
        type="button"
        className="link quiet"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {bi(
          `同一版本的另 ${n} 个构建`,
          `${n} other ${n === 1 ? "build" : "builds"} of this version`,
        )}{" "}
        <IconDown className={open ? "flip" : ""} />
      </button>
      {open && <ul className="rtl">{children}</ul>}
    </li>
  );
}

function RuntimeRow({
  r,
  st,
  admin,
  changed,
}: {
  r: RuntimeView;
  st: State;
  admin: boolean;
  onTask?: (t: FetchTask) => void;
  changed: () => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const setDefault = async (pl: string) => {
    try {
      await api("/api/library/python/default", {
        method: "PUT",
        body: JSON.stringify({ platform: pl, runtime: r.id }),
      });
      Message.success(bi("已设为默认", "Set as default"));
      changed();
    } catch (e) {
      err(e);
    }
  };
  const remove = () =>
    Modal.confirm({
      title: bi(`删除运行环境 ${r.id}？`, `Delete runtime ${r.id}?`),
      content: bi(
        "已经生成的交付不受影响；它的 wheel 仍保留在软件库里。",
        "Existing deliveries are unaffected; its wheels remain in the library.",
      ),
      okText: bi("删除", "Delete"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          await api(`/api/library/python/runtimes/${r.id}`, {
            method: "DELETE",
          });
          changed();
        } catch (e) {
          err(e);
        }
      },
    });
  // two builds of the same ansible-core look alike; say how they differ so they are not taken for duplicates
  const twin = (() => {
    const o = st.runtimes.find((x) => x.id !== r.id && x.ansible === r.ansible);
    if (!o) return "";
    const ov = new Map(o.wheels.map((w) => [w.name, w.version]));
    const diff = r.wheels
      .filter((w) => ov.get(w.name) !== w.version)
      .map((w) => `${w.name} ${ov.get(w.name) ?? bi("无", "none")}→${w.version}`);
    return diff.length
      ? bi(
          `与 ${o.id.slice(0, 8)} 的区别：${diff.slice(0, 3).join("，")}${diff.length > 3 ? " 等" : ""}`,
          `Differs from ${o.id.slice(0, 8)}: ${diff.slice(0, 3).join(", ")}${diff.length > 3 ? ", etc." : ""}`,
        )
      : bi(
          `与 ${o.id.slice(0, 8)} 内容相同`,
          `Same contents as ${o.id.slice(0, 8)}`,
        );
  })();
  return (
    <li
      className={`rtl-row ${open ? "open" : ""} ${r.default.length ? "is-default" : ""}`}
    >
      <div className="rtl-head">
        <button
          type="button"
          className="rtl-main"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="rtl-ic" aria-hidden>
            <IconCode />
          </span>
          <span className="rtl-name">
            <b>ansible-core {r.ansible}</b>
            <small>
              <span className="mono">{r.id}</span> ·{" "}
              {bi(
                `${r.wheels.length} 个包`,
                `${r.wheels.length} ${r.wheels.length === 1 ? "pkg" : "pkgs"}`,
              )}{" "}
              · {size(r.size)} · {ago(r.created)}
              {r.note ? ` · ${r.note}` : ""}
              {twin ? ` · ${twin}` : ""}
            </small>
          </span>
          <span className="rtl-def">
            {r.default.map((pl) => (
              <span key={pl} className="cm cm-mod">
                <OsLogo id={pl} size={13} />{" "}
                {short(st.platforms.find((p) => p.id === pl)?.title || pl)}{" "}
                {bi("默认", "default")}
              </span>
            ))}
          </span>
          <IconDown className="so-caret" />
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
              <Button icon={<IconMore />} aria-label={bi("更多操作", "More actions")} />
            </Dropdown>
          </span>
        )}
      </div>
      {open && (
        <ul className="rtl-wheels">
          {r.wheels.map((w) => (
            <li key={w.file}>
              <span className="mono rtl-w">{w.name}</span>
              <span className="mono faint">{w.version}</span>
              <span className="faint small">
                {w.via === "pypi"
                  ? bi("来自 PyPI", "From PyPI")
                  : w.via === "imported"
                    ? bi("导入", "Imported")
                    : w.via === "runtime-archive"
                      ? bi("原运行环境", "Original runtime")
                      : bi("软件库", "Library")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
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
  useLang();
  const [st, setSt] = useState<State | null>(null);
  const [task, setTask] = useState<FetchTask | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const load = () =>
    api<State>("/api/library/python")
      .then(setSt)
      .catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!task || task.state !== "running") return;
    const t = setInterval(() => {
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
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(t);
  }, [task?.id, task?.state]);
  const doImport = async (file: File) => {
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
      setImporting(false);
    }
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
      <header className="sx-page-h">
        <div>
          <h1>{bi("Ansible 运行环境", "Ansible Runtimes")}</h1>
          <p>
            {bi(
              "交付里带给控制节点的离线 Ansible。由软件库里的 Python 包（wheel）按版本组成，生成交付时当场拼装。",
              "Offline Ansible bundled for the control node in each delivery. Assembled on demand from Python wheels stored in the library.",
            )}
          </p>
        </div>
        {admin && (
          <span className="row-gap">
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
              return (
                <li key={p.id}>
                  <b>
                    <OsName id={p.id} title={p.title} />
                  </b>
                  {r ? (
                    <span>
                      ansible-core {r.ansible}{" "}
                      <span className="mono faint">{r.id}</span>
                    </span>
                  ) : (
                    <span className="warn">
                      {bi(
                        "还没有，暂时不能为这个系统生成交付",
                        "Not configured yet; deliveries cannot be built for this OS",
                      )}
                    </span>
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
              <React.Fragment key={main.id}>
                <RuntimeRow
                  r={main}
                  st={st!}
                  admin={admin}
                  onTask={setTask}
                  changed={load}
                />
                {twins.length > 0 && (
                  <Twins>
                    {twins.map((r) => (
                      <RuntimeRow
                        key={r.id}
                        r={r}
                        st={st!}
                        admin={admin}
                        onTask={setTask}
                        changed={load}
                      />
                    ))}
                  </Twins>
                )}
              </React.Fragment>
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

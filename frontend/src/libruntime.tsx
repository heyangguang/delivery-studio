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

const short = (t: string) => t.replace(/\s*[\(（].*$/, "");

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
        return Message.error(`看不懂这一行：${line.trim()}（写成 包名==版本）`);
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
      title="新建运行环境"
      onOk={submit}
      okText="开始准备"
      confirmLoading={busy}
      okButtonProps={{ disabled: !ansible }}
    >
      <div className="st-form">
        <div className="st-field">
          <span>ansible-core 版本</span>
          {versions && versions.length > 0 ? (
            <Select
              value={ansible}
              onChange={setAnsible}
              options={versions}
              showSearch
              aria-label="ansible-core 版本"
            />
          ) : (
            <Input
              value={ansible}
              onChange={setAnsible}
              placeholder="2.20.10"
              aria-label="ansible-core 版本"
            />
          )}
          <small>
            {verErr
              ? `读不到 PyPI（${verErr}），只能用软件库里已有的包，手动填写版本。`
              : `控制节点 Python ${st.python}；依赖由 pip 自动解析。`}
          </small>
        </div>
        <div className="st-field">
          <span>固定某些包的版本（可选）</span>
          <Input.TextArea
            value={pins}
            onChange={setPins}
            placeholder={"pip==26.2\njinja2==3.1.6"}
            autoSize={{ minRows: 2, maxRows: 5 }}
            aria-label="固定版本"
          />
          <small>每行一个 包名==版本，用于显式锁定依赖版本。</small>
        </div>
        <div className="st-field row">
          <span>只用软件库里已有的包（不联网）</span>
          <Switch
            checked={offline}
            onChange={setOffline}
            aria-label="只用软件库里已有的包"
          />
        </div>
        <div className="st-field">
          <span>准备好后设为默认</span>
          <Checkbox.Group
            value={defs}
            onChange={setDefs}
            options={st.platforms.map((p) => ({
              value: p.id,
              label: <OsName id={p.id} title={p.title} size={16} />,
            }))}
          />
          <small>设为默认后，这个系统新生成的交付都带它。</small>
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
        同一版本的另 {n} 个构建 <IconDown className={open ? "flip" : ""} />
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
  const [open, setOpen] = useState(false);
  const setDefault = async (pl: string) => {
    try {
      await api("/api/library/python/default", {
        method: "PUT",
        body: JSON.stringify({ platform: pl, runtime: r.id }),
      });
      Message.success("已设为默认");
      changed();
    } catch (e) {
      err(e);
    }
  };
  const remove = () =>
    Modal.confirm({
      title: `删除运行环境 ${r.id}？`,
      content: "已经生成的交付不受影响；它的 wheel 仍保留在软件库里。",
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
      .map((w) => `${w.name} ${ov.get(w.name) ?? "无"}→${w.version}`);
    return diff.length
      ? `与 ${o.id.slice(0, 8)} 的区别：${diff.slice(0, 3).join("，")}${diff.length > 3 ? " 等" : ""}`
      : `与 ${o.id.slice(0, 8)} 内容相同`;
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
              <span className="mono">{r.id}</span> · {r.wheels.length} 个包 ·{" "}
              {size(r.size)} · {ago(r.created)}
              {r.note ? ` · ${r.note}` : ""}
              {twin ? ` · ${twin}` : ""}
            </small>
          </span>
          <span className="rtl-def">
            {r.default.map((pl) => (
              <span key={pl} className="cm cm-mod">
                <OsLogo id={pl} size={13} />{" "}
                {short(st.platforms.find((p) => p.id === pl)?.title || pl)} 默认
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
                        ? (location.href = `/api/library/python/export?ids=${r.id}`)
                        : setDefault(k)
                  }
                >
                  {st.platforms
                    .filter((p) => !r.default.includes(p.id))
                    .map((p) => (
                      <Menu.Item key={p.id}>
                        设为 {short(p.title)} 的默认
                      </Menu.Item>
                    ))}
                  <Menu.Item key="export">导出（带去内网）</Menu.Item>
                  <Menu.Item key="del" disabled={r.default.length > 0}>
                    删除
                  </Menu.Item>
                </Menu>
              }
            >
              <Button icon={<IconMore />} aria-label="更多操作" />
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
                  ? "来自 PyPI"
                  : w.via === "imported"
                    ? "导入"
                    : w.via === "runtime-archive"
                      ? "原运行环境"
                      : "软件库"}
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
              ? Message.success("运行环境已准备好")
              : Message.error("准备没有完成，详情见下方");
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
      Message.success("已导入");
      load();
    } catch (e) {
      Modal.error({ title: "导入失败", content: (e as ApiError).message });
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
          软件库
        </Button>
      )}
      <header className="sx-page-h">
        <div>
          <h1>Ansible 运行环境</h1>
          <p>
            交付里带给控制节点的离线 Ansible。由软件库里的 Python
            包（wheel）按版本组成，生成交付时当场拼装。
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
                导入
              </Button>
            </Upload>
            <Button
              icon={<IconExport />}
              href="/api/library/python/export"
              disabled={!st?.runtimes.length}
            >
              全部导出
            </Button>
            <Button
              type="primary"
              icon={<IconPlus />}
              onClick={() => setCreating(true)}
            >
              新建运行环境
            </Button>
          </span>
        )}
      </header>
      {task && <TaskCard task={task} onClose={() => setTask(null)} />}
      {st && (
        <section className="sx-sec">
          <h2>各系统使用的运行环境</h2>
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
                      还没有，暂时不能为这个系统生成交付
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
          全部运行环境{" "}
          <em className="faint num">{st?.runtimes.length ?? ""}</em>
        </h2>
        {st && st.runtimes.length === 0 ? (
          <div className="sx-empty">
            还没有运行环境。点「新建运行环境」从 PyPI
            准备，或导入联网平台导出的包。
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

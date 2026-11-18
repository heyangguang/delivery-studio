import { useEffect, useState } from "react";
import { Input, Modal } from "@arco-design/web-react";
import { api, cached, err, fetchCached } from "./shared";
import { go } from "./router";
import { StylePicker } from "./wbstyle";
import "./workbench.css";

/* ---------------------------------------------------------------- dialogs used from the component list */

export function ForkModal({
  from,
  open,
  close,
}: {
  from: string;
  open: boolean;
  close: () => void;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = /^[a-z][a-z0-9-]{0,40}$/.test(name);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/api/components/${from}/fork`, {
        method: "POST",
        body: JSON.stringify({ name, title }),
      });
      close();
      go({ name: "components", id: name, edit: "overview" });
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
      title={`复制 ${from} 为自定义组件`}
      okText="创建草稿"
      confirmLoading={busy}
      okButtonProps={{ disabled: !ok }}
      onOk={submit}
      style={{ width: 480, maxWidth: "94vw" }}
    >
      <div className="wb-newfile">
        <div className="wb-field w-l">
          <span className="wb-flabel">
            新组件名<i className="req">必填</i>
          </span>
          <Input
            value={name}
            onChange={setName}
            placeholder={`如 ${from}-lab`}
            aria-label="新组件名"
          />
          <span className="wb-fhint">
            小写字母开头，只能用字母、数字、短横线。创建后不能再改。
          </span>
        </div>
        <div className="wb-field w-l">
          <span className="wb-flabel">显示名称</span>
          <Input
            value={title}
            onChange={setTitle}
            placeholder="留空沿用原来的"
            aria-label="显示名称"
          />
        </div>
        <p className="wb-fhint">
          会复制它的清单、角色任务文件和模板；角色目录若与原组件同名会一并改名。创建的是草稿，发布后才出现在组件列表里。
        </p>
      </div>
    </Modal>
  );
}

type Kind = { id: string; title: string; text: string; roles: string };

/** A small picture of what each starting structure looks like. */
function KindArt({ kind }: { kind: string }) {
  const box = (x: number, y: number, lead = false) => (
    <rect
      x={x}
      y={y}
      width="26"
      height="16"
      rx="3"
      className={lead ? "ka-box lead" : "ka-box"}
    />
  );
  return (
    <svg viewBox="0 0 120 64" className="wb-kind-art" aria-hidden>
      {kind === "single" && (
        <>
          {box(8, 24)}
          {box(47, 24)}
          {box(86, 24)}
        </>
      )}
      {kind === "primary-replica" && (
        <>
          <path d="M60 22v10M60 32H34v8M60 32h26v8" className="ka-line" />
          {box(47, 6, true)}
          {box(21, 40)}
          {box(73, 40)}
        </>
      )}
      {kind === "cluster" && (
        <>
          <path d="M60 22 34 42M60 22l26 20M47 50h26" className="ka-line" />
          {box(47, 6)}
          {box(21, 42)}
          {box(73, 42)}
        </>
      )}
    </svg>
  );
}

export function NewComponentModal({
  open,
  close,
}: {
  open: boolean;
  close: () => void;
}) {
  const [kinds, setKinds] = useState<Kind[]>(
    () => cached<Kind[]>("/api/components/templates") ?? [],
  );
  const [kind, setKind] = useState("primary-replica");
  const [f, setF] = useState({
    name: "",
    title: "",
    package: "",
    service: "",
    port: "",
  });
  const [look, setLook] = useState<{ icon: string; color: string }>({
    icon: "",
    color: "",
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open)
      fetchCached<Kind[]>("/api/components/templates")
        .then(setKinds)
        .catch(() => undefined);
  }, [open]);
  // the structure suggests a logo until the person picks their own
  const suggestion = {
    single: ["server", "blue"],
    "primary-replica": ["database", "indigo"],
    cluster: ["cluster", "teal"],
  }[kind] || ["container", "slate"];
  const icon = look.icon || suggestion[0];
  const color = look.color || suggestion[1];
  const set = (k: keyof typeof f) => (v: string) =>
    setF((x) => ({ ...x, [k]: v }));
  const ok =
    /^[a-z][a-z0-9-]{0,40}$/.test(f.name) &&
    f.title.trim() &&
    /^[a-z0-9][a-z0-9.+-]*$/.test(f.package) &&
    Number(f.port) > 0 &&
    Number(f.port) < 65536;
  const submit = async () => {
    setBusy(true);
    try {
      await api("/api/components/new", {
        method: "POST",
        body: JSON.stringify({
          name: f.name,
          title: f.title.trim(),
          kind,
          package: f.package,
          service: f.service || f.package,
          port: Number(f.port),
          icon,
          color,
        }),
      });
      close();
      go({ name: "components", id: f.name, edit: "overview" });
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
      title="新建组件"
      okText="创建草稿"
      confirmLoading={busy}
      okButtonProps={{ disabled: !ok }}
      onOk={submit}
      style={{ width: 820, maxWidth: "96vw" }}
      className="wb-newmodal"
    >
      <div className="wb-newfile">
        <section>
          <h3 className="wb-nh">从哪种结构开始</h3>
          <div className="wb-kinds" role="radiogroup" aria-label="结构">
            {kinds.map((k) => (
              <button
                type="button"
                key={k.id}
                role="radio"
                aria-checked={kind === k.id}
                className={kind === k.id ? "on" : ""}
                onClick={() => setKind(k.id)}
              >
                <KindArt kind={k.id} />
                <b>{k.title}</b>
                <span>{k.text}</span>
                <em>角色：{k.roles}</em>
              </button>
            ))}
          </div>
          <p className="wb-fhint">
            只决定起始的角色和配置模板，之后随时可以在「角色与关系」里增删角色、改台数。单机运行不用单独选：「主
            + 从」里从节点最少 0 台，预设里自带「单节点」。
          </p>
        </section>
        <section>
          <h3 className="wb-nh">基本信息</h3>
          <div className="wb-grid">
            <div className="wb-field w-m">
              <span className="wb-flabel">
                显示名称<i className="req">必填</i>
              </span>
              <Input
                value={f.title}
                onChange={set("title")}
                placeholder="如 我的缓存"
                aria-label="显示名称"
              />
            </div>
            <div className="wb-field w-m">
              <span className="wb-flabel">
                组件名<i className="req">必填</i>
              </span>
              <Input
                className="wb-mono"
                value={f.name}
                onChange={set("name")}
                placeholder="如 my-cache（创建后不能改）"
                aria-label="组件名"
              />
            </div>
            <div className="wb-field w-s">
              <span className="wb-flabel">
                软件包名<i className="req">必填</i>
              </span>
              <Input
                className="wb-mono"
                value={f.package}
                onChange={set("package")}
                placeholder="如 redis-server"
                aria-label="软件包名"
              />
            </div>
            <div className="wb-field w-s">
              <span className="wb-flabel">服务名</span>
              <Input
                className="wb-mono"
                value={f.service}
                onChange={set("service")}
                placeholder="默认同包名"
                aria-label="服务名"
              />
            </div>
            <div className="wb-field w-s">
              <span className="wb-flabel">
                默认端口<i className="req">必填</i>
              </span>
              <Input
                className="wb-mono"
                value={f.port}
                onChange={set("port")}
                placeholder="6379"
                aria-label="默认端口"
              />
            </div>
          </div>
        </section>
        <section>
          <h3 className="wb-nh">图标与颜色</h3>
          <StylePicker
            id={f.name || "new"}
            icon={icon}
            color={color}
            onChange={(i, c) => setLook({ icon: i, color: c })}
          />
        </section>
        <p className="wb-fhint">
          会生成一个能直接走通流程的最小组件：装包、写配置、起服务、检查端口。软件包版本需要到「版本」页签从软件库里选一个真实存在的，之后按你的中间件改配置模板和步骤。
        </p>
      </div>
    </Modal>
  );
}

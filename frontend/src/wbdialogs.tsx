import { useEffect, useState } from "react";
import { Input, Modal, Popover, Tooltip } from "@arco-design/web-react";
import { IconEdit, IconInfoCircle } from "@arco-design/web-react/icon";
import { api, cached, err, fetchCached } from "./shared";
import { go } from "./router";
import { AppGlyph } from "./ui";
import { COLORS, ICONS, iconShape } from "./glyphs";
import { bi, useLang } from "./i18n";
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
  useLang();
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
      title={bi(`复制 ${from} 为自定义组件`, `Copy ${from} as Custom Component`)}
      okText={bi("创建草稿", "Create Draft")}
      confirmLoading={busy}
      okButtonProps={{ disabled: !ok }}
      onOk={submit}
      style={{ width: 480, maxWidth: "94vw" }}
    >
      <div className="wb-newfile">
        <div className="wb-field w-l">
          <span className="wb-flabel">
            {bi("新组件名", "New Component ID")}
            <i className="req">{bi("必填", "Required")}</i>
          </span>
          <Input
            value={name}
            onChange={setName}
            placeholder={bi(`如 ${from}-lab`, `e.g. ${from}-lab`)}
            aria-label={bi("新组件名", "New component ID")}
          />
          <span className="wb-fhint">
            {bi(
              "小写字母开头，只能用字母、数字、短横线。创建后不能再改。",
              "Start with a lowercase letter; use only lowercase letters, digits, and hyphens. Cannot be changed later.",
            )}
          </span>
        </div>
        <div className="wb-field w-l">
          <span className="wb-flabel">{bi("显示名称", "Display Name")}</span>
          <Input
            value={title}
            onChange={setTitle}
            placeholder={bi("留空沿用原来的", "Leave blank to keep original")}
            aria-label={bi("显示名称", "Display name")}
          />
        </div>
        <p className="wb-fhint">
          {bi(
            "会复制它的清单、角色任务文件和模板；角色目录若与原组件同名会一并改名。创建的是草稿，发布后才出现在组件列表里。",
            "Copies its manifest, role task files, and templates; role directories named after the original component are renamed automatically. Creates a draft that appears in the catalog after publishing.",
          )}
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
  const lang = useLang();
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
  const [pickOpen, setPickOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open)
      fetchCached<Kind[]>("/api/components/templates")
        .then(setKinds)
        .catch(() => undefined);
  }, [open, lang]);
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
  const nameValid = !f.name || /^[a-z][a-z0-9-]{0,40}$/.test(f.name);
  const pkgValid = !f.package || /^[a-z0-9][a-z0-9.+-]*$/.test(f.package);
  const portValid =
    !f.port || (Number(f.port) > 0 && Number(f.port) < 65536 && /^\d+$/.test(f.port));
  const ok =
    /^[a-z][a-z0-9-]{0,40}$/.test(f.name) &&
    !!f.title.trim() &&
    /^[a-z0-9][a-z0-9.+-]*$/.test(f.package) &&
    /^\d+$/.test(f.port) &&
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
  const iconPopover = (
    <div className="wb-new-pop">
      <div className="wb-new-pop-sec">
        <span className="wb-new-pop-label">{bi("颜色", "Color")}</span>
        <div
          className="wb-swatches wb-swatches-compact"
          role="radiogroup"
          aria-label={bi("颜色", "Color")}
        >
          {COLORS.map((c) => (
            <button
              type="button"
              key={c.id}
              role="radio"
              aria-checked={color === c.id}
              aria-label={c.label}
              title={c.label}
              className={color === c.id ? "on" : ""}
              style={{ background: `linear-gradient(${c.tile.join(",")})` }}
              onClick={() => setLook({ icon, color: c.id })}
            />
          ))}
        </div>
      </div>
      {[
        { key: "general", title: bi("通用图标", "General"), list: ICONS.filter((i) => !i.group) },
        { key: "middleware", title: bi("常见中间件", "Middleware"), list: ICONS.filter((i) => i.group) },
      ].map(({ key, title, list }) => (
        <div key={key} className="wb-new-pop-sec">
          <span className="wb-new-pop-label">{title}</span>
          <div
            className="wb-icons wb-icons-compact"
            role="radiogroup"
            aria-label={title}
          >
            {list.map((i) => (
              <button
                type="button"
                key={i.id}
                role="radio"
                aria-checked={icon === i.id}
                aria-label={i.label}
                title={i.label}
                className={icon === i.id ? "on" : ""}
                onClick={() => setLook({ icon: i.id, color })}
              >
                <svg viewBox="0 0 40 40" width="21" height="21" aria-hidden>
                  {iconShape(i.id)}
                </svg>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
  return (
    <Modal
      visible={open}
      onCancel={close}
      title={bi("新建组件", "New Component")}
      okText={bi("创建草稿", "Create Draft")}
      confirmLoading={busy}
      okButtonProps={{ disabled: !ok }}
      onOk={submit}
      style={{ width: 680, maxWidth: "94vw" }}
      className="wb-newmodal"
    >
      <div className="wb-new-body">
        {/* Identity Bar: Clickable Glyph + Display Name + Component ID */}
        <section className="wb-new-idbar">
          <Popover
            trigger="click"
            position="bl"
            getPopupContainer={() => document.body}
            popupVisible={pickOpen}
            onVisibleChange={setPickOpen}
            content={iconPopover}
          >
            <Tooltip content={bi("点击更换图标与颜色", "Click to customize icon & color")} mini>
              <button
                type="button"
                className="wb-new-glyph-btn"
                aria-label={bi("更换图标与颜色", "Customize icon and color")}
              >
                <AppGlyph id={`pick-${f.name || "new"}`} icon={icon} color={color} size={46} />
                <span className="wb-new-glyph-edit" aria-hidden>
                  <IconEdit />
                </span>
              </button>
            </Tooltip>
          </Popover>

          <div className="wb-new-idfields">
            <div className="wb-new-field">
              <label className="wb-new-label">
                {bi("显示名称", "Display Name")} <span className="wb-req-star">*</span>
              </label>
              <Input
                value={f.title}
                onChange={set("title")}
                placeholder={bi("如 我的缓存", "e.g. My Cache")}
                aria-label={bi("显示名称", "Display name")}
              />
            </div>
            <div className="wb-new-field">
              <label className="wb-new-label">
                {bi("组件标识", "Component ID")} <span className="wb-req-star">*</span>
                <span className="wb-new-sub">{bi("小写字母/数字/短横线，创建后不可改", "lowercase, immutable")}</span>
              </label>
              <Input
                className="wb-mono"
                status={nameValid ? undefined : "error"}
                value={f.name}
                onChange={set("name")}
                placeholder={bi("如 my-cache", "e.g. my-cache")}
                aria-label={bi("组件名", "Component ID")}
              />
            </div>
          </div>
        </section>

        {/* Starting Structure — Compact 3-Card Radio Row */}
        <section className="wb-new-sec">
          <div className="wb-new-sec-head">
            <h3 className="wb-nh">{bi("起始结构", "Starting Structure")}</h3>
            <Tooltip
              content={bi(
                "仅决定初始角色与模板，后续可随时在「角色与关系」里增删调整；「主 + 从」允许 0 个从节点，已含单机预设。",
                "Sets only the initial roles and templates; adjust anytime under Roles & Relations. Primary + Replica allows 0 replicas.",
              )}
            >
              <span className="wb-new-info-ico" tabIndex={0}>
                <IconInfoCircle />
                <span>{bi("创建后可随时调整角色", "Editable anytime after creation")}</span>
              </span>
            </Tooltip>
          </div>
          <div
            className="wb-kinds wb-kinds-compact"
            role="radiogroup"
            aria-label={bi("结构", "Structure")}
          >
            {kinds.map((k) => (
              <button
                type="button"
                key={k.id}
                role="radio"
                aria-checked={kind === k.id}
                className={kind === k.id ? "on" : ""}
                title={k.text}
                onClick={() => setKind(k.id)}
              >
                <div className="wb-kind-top">
                  <KindArt kind={k.id} />
                  <div className="wb-kind-head">
                    <b>{k.title}</b>
                    <em>{k.roles}</em>
                  </div>
                </div>
                <span className="wb-kind-desc">{k.text}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Runtime Basics — Single 3-Column Row */}
        <section className="wb-new-sec">
          <div className="wb-new-sec-head">
            <h3 className="wb-nh">{bi("软件包与服务", "Package & Service")}</h3>
          </div>
          <div className="wb-new-row3">
            <div className="wb-new-field">
              <label className="wb-new-label">
                {bi("软件包名", "Package Name")} <span className="wb-req-star">*</span>
              </label>
              <Input
                className="wb-mono"
                status={pkgValid ? undefined : "error"}
                value={f.package}
                onChange={set("package")}
                placeholder={bi("如 redis-server", "e.g. redis-server")}
                aria-label={bi("软件包名", "Package name")}
              />
            </div>
            <div className="wb-new-field">
              <label className="wb-new-label">
                {bi("服务名", "Service Name")}
                <span className="wb-new-sub">{bi("可选", "Optional")}</span>
              </label>
              <Input
                className="wb-mono"
                value={f.service}
                onChange={set("service")}
                placeholder={bi("默认同包名", "Defaults to package")}
                aria-label={bi("服务名", "Service name")}
              />
            </div>
            <div className="wb-new-field">
              <label className="wb-new-label">
                {bi("默认端口", "Default Port")} <span className="wb-req-star">*</span>
              </label>
              <Input
                className="wb-mono"
                status={portValid ? undefined : "error"}
                value={f.port}
                onChange={set("port")}
                placeholder="6379"
                aria-label={bi("默认端口", "Default port")}
              />
            </div>
          </div>
        </section>

        <p className="wb-new-foot-note">
          {bi(
            "将生成可运行的最小组件草稿（装包、配置、启服务、验端口）；创建后在「版本」页绑定软件库版本即可试生成。",
            "Generates a minimal runnable draft (install, configure, start, port check); bind a Software Library package on the Versions tab to run trial generation.",
          )}
        </p>
      </div>
    </Modal>
  );
}

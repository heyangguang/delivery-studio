import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Dropdown,
  Input,
  Menu,
  Message,
  Modal,
} from "@arco-design/web-react";
import {
  IconDelete,
  IconDownload,
  IconEdit,
  IconFile,
  IconFolder,
  IconFolderAdd,
  IconImage,
  IconMore,
  IconPlus,
  IconRight,
  IconSearch,
  IconUpload,
} from "@arco-design/web-react/icon";
import { ago, api, err, useAIStatus } from "./shared";
import "./myfiles.css";

/* A person's storage space: folders, documents and files of any kind. What they attach in a conversation is kept here
   too (folder 对话附件). Each person has a quota that an administrator can change. */

export type FileNode = {
  id: string;
  parent?: string;
  name: string;
  kind: "folder" | "doc" | "file";
  mime?: string;
  size: number;
  created: string;
  updated: string;
  source?: string;
  text?: boolean;
  note?: string;
};
export type Usage = { used: number; quota: number; max_file: number };
type Listing = { nodes: FileNode[]; path: FileNode[]; usage: Usage };

export const bytesText = (n: number) =>
  n >= 1 << 30
    ? `${(n / (1 << 30)).toFixed(1)} GB`
    : n >= 1 << 20
      ? `${(n / (1 << 20)).toFixed(1)} MB`
      : n >= 1024
        ? `${Math.round(n / 1024)} KB`
        : `${n} 字节`;
export const isImage = (n: { mime?: string }) => !!n.mime?.startsWith("image/");
export const rawUrl = (id: string) => `/api/me/files/${id}/raw`;

/** Puts files into the storage space; `chat` marks what came from a conversation. */
export async function uploadFiles(
  files: File[],
  parent = "",
  source = "",
): Promise<{ added: FileNode[]; failed: string[] }> {
  const f = new FormData();
  files.forEach((x) => f.append("file", x));
  const q = new URLSearchParams();
  if (parent) q.set("parent", parent);
  if (source) q.set("source", source);
  const r = await api<{ added: FileNode[]; failed: string[] }>(
    `/api/me/files?${q}`,
    { method: "POST", body: f },
  );
  return { added: r.added || [], failed: r.failed || [] };
}

export function FileIcon({ n, size = 36 }: { n: FileNode; size?: number }) {
  if (n.kind === "folder")
    return (
      <span className="mf-ic mf-folder" style={{ width: size, height: size }}>
        <IconFolder />
      </span>
    );
  if (isImage(n) && n.size < 8 << 20)
    return (
      <span className="mf-ic mf-thumb" style={{ width: size, height: size }}>
        <img src={rawUrl(n.id)} alt="" loading="lazy" />
      </span>
    );
  return (
    <span
      className={`mf-ic ${isImage(n) ? "mf-img" : "mf-other"}`}
      style={{ width: size, height: size }}
    >
      {isImage(n) ? <IconImage /> : <IconFile />}
    </span>
  );
}

export function UsageBar({ u }: { u: Usage | null }) {
  if (!u) return null;
  const pct = u.quota > 0 ? Math.min(100, (u.used / u.quota) * 100) : 0;
  return (
    <div
      className={`mf-usage ${pct >= 90 ? "full" : ""}`}
      role="img"
      aria-label={`已用 ${bytesText(u.used)}，共 ${bytesText(u.quota)}`}
    >
      <div className="mf-usage-bar">
        <i style={{ width: `${Math.max(pct, u.used > 0 ? 1 : 0)}%` }} />
      </div>
      <span>
        已用 {bytesText(u.used)} / {bytesText(u.quota)}
      </span>
    </div>
  );
}

function useListing(parent: string, name = "") {
  const [data, setData] = useState<Listing | null>(null);
  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (parent) q.set("parent", parent);
    if (name) q.set("name", name);
    return api<Listing>(`/api/me/files?${q}`)
      .then(setData)
      .catch((e) => {
        err(e);
        setData(
          (d) =>
            d || {
              nodes: [],
              path: [],
              usage: { used: 0, quota: 0, max_file: 0 },
            },
        );
      });
  }, [parent, name]);
  useEffect(() => {
    const t = window.setTimeout(load, name ? 200 : 0);
    return () => window.clearTimeout(t);
  }, [load, name]);
  return [data, load] as const;
}

function Crumbs({
  path,
  onGo,
}: {
  path: FileNode[];
  onGo: (id: string) => void;
}) {
  return (
    <nav className="mf-crumbs" aria-label="所在位置">
      <button
        type="button"
        onClick={() => onGo("")}
        aria-current={path.length === 0 ? "page" : undefined}
      >
        全部资料
      </button>
      {path.map((p, i) => (
        <React.Fragment key={p.id}>
          <IconRight aria-hidden />
          <button
            type="button"
            onClick={() => onGo(p.id)}
            aria-current={i === path.length - 1 ? "page" : undefined}
          >
            {p.name}
          </button>
        </React.Fragment>
      ))}
    </nav>
  );
}

/** Picks a folder to move into: walk down, then "移动到这里". */
function FolderPicker({
  visible,
  moving,
  onClose,
  onPick,
}: {
  visible: boolean;
  moving: FileNode | null;
  onClose: () => void;
  onPick: (parent: string) => void;
}) {
  const [at, setAt] = useState("");
  const [data] = useListing(at);
  useEffect(() => {
    if (visible) setAt("");
  }, [visible]);
  const folders = (data?.nodes || []).filter(
    (n) => n.kind === "folder" && n.id !== moving?.id,
  );
  return (
    <Modal
      visible={visible}
      title={`移动「${moving?.name || ""}」`}
      onCancel={onClose}
      okText="移动到这里"
      onOk={() => onPick(at)}
      style={{ width: 460, maxWidth: "96vw" }}
    >
      <Crumbs path={data?.path || []} onGo={setAt} />
      <ul className="mf-pick">
        {folders.map((f) => (
          <li key={f.id}>
            <button type="button" onClick={() => setAt(f.id)}>
              <FileIcon n={f} size={28} />
              <span>{f.name}</span>
              <IconRight />
            </button>
          </li>
        ))}
        {data && folders.length === 0 && (
          <li className="mf-pick-none">这里没有子文件夹</li>
        )}
      </ul>
    </Modal>
  );
}

export function MyFiles({ open }: { open: (n: FileNode) => void }) {
  const [parent, setParent] = useState("");
  const [q, setQ] = useState("");
  const [data, load] = useListing(parent, q.trim());
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [moving, setMoving] = useState<FileNode | null>(null);
  const pick = useRef<HTMLInputElement>(null);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const r = await uploadFiles(files, parent);
      if (r.added.length) Message.success(`已放入 ${r.added.length} 个文件`);
      r.failed.forEach((m) => Message.warning(m));
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
      load();
    }
  };
  const ask = (
    title: string,
    init: string,
    ok: (v: string) => Promise<unknown>,
  ) => {
    let v = init;
    Modal.confirm({
      title,
      content: (
        <Input
          defaultValue={init}
          maxLength={120}
          onChange={(x) => (v = x)}
          aria-label={title}
          autoFocus
        />
      ),
      okText: "好",
      onOk: async () => {
        try {
          await ok(v.trim());
          load();
        } catch (e) {
          err(e);
          throw e;
        }
      },
    });
  };
  const newFolder = () =>
    ask("新建文件夹", "", (name) =>
      api("/api/me/files", {
        method: "POST",
        body: JSON.stringify({ kind: "folder", name, parent }),
      }),
    );
  const rename = (n: FileNode) =>
    ask("重命名", n.name, (name) =>
      api(`/api/me/files/${n.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    );
  const remove = (n: FileNode) =>
    Modal.confirm({
      title: `删除「${n.name}」？`,
      content:
        n.kind === "folder"
          ? "文件夹和里面的所有内容都会删除，不能恢复。"
          : "删除后不能恢复。",
      okText: "删除",
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          await api(`/api/me/files/${n.id}`, { method: "DELETE" });
          load();
        } catch (e) {
          err(e);
        }
      },
    });
  const move = async (to: string) => {
    if (!moving) return;
    try {
      await api(`/api/me/files/${moving.id}`, {
        method: "PATCH",
        body: JSON.stringify({ parent: to }),
      });
      setMoving(null);
      load();
    } catch (e) {
      err(e);
    }
  };

  const aiStatus = useAIStatus();
  const nodes = data?.nodes || [];
  const searching = q.trim() !== "";
  return (
    <div
      className={`mf ${drag ? "drag" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        upload(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="mf-head">
        <div>
          <h2>我的资料</h2>
          <p>
            {aiStatus.enabled
              ? "你自己的文档、图片和文件。和 AI 对话时发送的文件也会存在这里，AI 可以查阅其中的文字内容。"
              : "你自己的文档、图片、配置和现场文件。"}
          </p>
        </div>
        <span className="mf-actions">
          <Button icon={<IconFolderAdd />} onClick={newFolder}>
            新建文件夹
          </Button>
          <Button
            icon={<IconEdit />}
            onClick={() =>
              open({
                id: "~new:" + parent,
                name: "",
                kind: "doc",
                size: 0,
                created: "",
                updated: "",
              })
            }
          >
            写文档
          </Button>
          <Button
            type="primary"
            icon={<IconUpload />}
            loading={busy}
            onClick={() => pick.current?.click()}
          >
            上传
          </Button>
        </span>
        <input
          ref={pick}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) upload(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </header>
      <div className="mf-bar">
        {searching ? (
          <span className="mf-found">搜索「{q.trim()}」</span>
        ) : (
          <Crumbs path={data?.path || []} onGo={setParent} />
        )}
        <Input
          className="mf-search"
          prefix={<IconSearch />}
          allowClear
          placeholder="按名称搜索"
          value={q}
          onChange={setQ}
          aria-label="按名称搜索"
        />
        <UsageBar u={data?.usage || null} />
      </div>
      {data && nodes.length === 0 ? (
        <div className="mf-empty">
          <span className="mf-ic mf-folder mf-big">
            <IconFolder />
          </span>
          <b>{searching ? "没有名称匹配的文件" : "这里还是空的"}</b>
          <p>
            {searching
              ? "换个关键词试试。"
              : "把文件拖到这个区域，或点右上角的「上传」。图片、PDF、Word、Excel、日志和配置文件都可以。"}
          </p>
        </div>
      ) : (
        <ul className="mf-list" aria-label="文件列表">
          {nodes.map((n) => (
            <li key={n.id} className="mf-row">
              <button
                type="button"
                className="mf-main"
                onClick={() =>
                  n.kind === "folder" ? (setQ(""), setParent(n.id)) : open(n)
                }
              >
                <FileIcon n={n} />
                <span className="mf-name">
                  <b>{n.name}</b>
                  <small>
                    {n.kind === "folder" ? "文件夹" : bytesText(n.size)}
                    {n.source === "chat" && " · 来自对话"}
                    {n.kind === "file" && !n.text && !isImage(n) && n.note
                      ? ` · ${n.note}`
                      : ""}
                  </small>
                </span>
                <span className="mf-when">{ago(n.updated)}</span>
              </button>
              <Dropdown
                trigger="click"
                position="br"
                droplist={
                  <Menu
                    onClickMenuItem={(k) => {
                      if (k === "rename") rename(n);
                      else if (k === "move") setMoving(n);
                      else if (k === "down")
                        window.open(rawUrl(n.id) + "?download=1", "_blank");
                      else remove(n);
                    }}
                  >
                    <Menu.Item key="rename">
                      <IconEdit /> 重命名
                    </Menu.Item>
                    <Menu.Item key="move">
                      <IconFolder /> 移动到…
                    </Menu.Item>
                    {n.kind !== "folder" && (
                      <Menu.Item key="down">
                        <IconDownload /> 下载
                      </Menu.Item>
                    )}
                    <Menu.Item key="del" className="danger-item">
                      <IconDelete /> 删除
                    </Menu.Item>
                  </Menu>
                }
              >
                <button
                  type="button"
                  className="mf-more"
                  aria-label={`${n.name} 的更多操作`}
                >
                  <IconMore />
                </button>
              </Dropdown>
            </li>
          ))}
        </ul>
      )}
      {drag && (
        <div className="mf-drop">
          松开即可上传到「
          {data?.path.length
            ? data.path[data.path.length - 1].name
            : "全部资料"}
          」
        </div>
      )}
      <FolderPicker
        visible={!!moving}
        moving={moving}
        onClose={() => setMoving(null)}
        onPick={move}
      />
    </div>
  );
}

/** One file that is not a plain document: a picture, a PDF, anything else. */
export function FileView({
  id,
  changed,
  gone,
}: {
  id: string;
  changed: () => void;
  gone: () => void;
}) {
  const aiStatus = useAIStatus();
  const [d, setD] = useState<{
    node: FileNode;
    path: FileNode[];
    text?: string;
    truncated?: boolean;
  } | null>(null);
  useEffect(() => {
    setD(null);
    api<typeof d>(`/api/me/files/${id}`)
      .then(setD)
      .catch((e) => {
        err(e);
        gone();
      });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="mf-view" aria-busy />;
  const n = d.node;
  return (
    <article className="mf-view">
      <header>
        <FileIcon n={n} size={44} />
        <div>
          <h2>{n.name}</h2>
          <p>
            {bytesText(n.size)} · {n.mime || "文件"} · 更新于 {ago(n.updated)}
            {n.source === "chat" && " · 来自对话"}
          </p>
        </div>
        <span className="mf-actions">
          <Button
            icon={<IconDownload />}
            onClick={() => window.open(rawUrl(n.id) + "?download=1", "_blank")}
          >
            下载
          </Button>
          <Button
            status="danger"
            icon={<IconDelete />}
            onClick={() =>
              Modal.confirm({
                title: `删除「${n.name}」？`,
                content: "删除后不能恢复。",
                okText: "删除",
                okButtonProps: { status: "danger" },
                onOk: async () => {
                  try {
                    await api(`/api/me/files/${n.id}`, { method: "DELETE" });
                    changed();
                    gone();
                  } catch (e) {
                    err(e);
                  }
                },
              })
            }
          >
            删除
          </Button>
        </span>
      </header>
      {isImage(n) && (
        <div className="mf-preview">
          <img src={rawUrl(n.id)} alt={n.name} />
        </div>
      )}
      {d.text ? (
        <section className="mf-text">
          <h3>提取出的文字{d.truncated ? "（只显示开头一部分）" : ""}</h3>
          {aiStatus.enabled && (
            <p className="faint small">AI 查阅这份文件时读到的就是下面的文字。</p>
          )}
          <pre>{d.text}</pre>
        </section>
      ) : (
        !isImage(n) && (
          <p className="mf-note">
            {n.note ||
              (aiStatus.enabled
                ? "这个文件里没有可以提取的文字，AI 查不到它的内容。"
                : "这个文件里没有可以提取的文字预览。")}
          </p>
        )
      )}
    </article>
  );
}

/** Choose files already in the storage space, to attach to a message. */
export function FilePicker({
  visible,
  onClose,
  onPick,
  images,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (n: FileNode[]) => void;
  images?: boolean;
}) {
  const [parent, setParent] = useState("");
  const [q, setQ] = useState("");
  const [data] = useListing(parent, q.trim());
  const [sel, setSel] = useState<Record<string, FileNode>>({});
  useEffect(() => {
    if (visible) {
      setSel({});
      setParent("");
      setQ("");
    }
  }, [visible]);
  const nodes = (data?.nodes || []).filter(
    (n) => n.kind === "folder" || !images || isImage(n),
  );
  const chosen = Object.values(sel);
  return (
    <Modal
      visible={visible}
      title="从我的资料选择"
      onCancel={onClose}
      okText={chosen.length ? `添加 ${chosen.length} 个` : "添加"}
      okButtonProps={{ disabled: !chosen.length }}
      onOk={() => onPick(chosen)}
      style={{ width: 520, maxWidth: "96vw" }}
    >
      <Input
        prefix={<IconSearch />}
        allowClear
        placeholder="按名称搜索"
        value={q}
        onChange={setQ}
        aria-label="按名称搜索"
      />
      {!q.trim() && <Crumbs path={data?.path || []} onGo={setParent} />}
      <ul className="mf-pick tall">
        {nodes.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              aria-pressed={!!sel[n.id]}
              className={sel[n.id] ? "on" : ""}
              onClick={() => {
                if (n.kind === "folder") {
                  setQ("");
                  setParent(n.id);
                } else
                  setSel((s) =>
                    s[n.id]
                      ? Object.fromEntries(
                          Object.entries(s).filter(([k]) => k !== n.id),
                        )
                      : { ...s, [n.id]: n },
                  );
              }}
            >
              <FileIcon n={n} size={28} />
              <span>
                {n.name}{" "}
                {n.kind !== "folder" && (
                  <small className="faint">{bytesText(n.size)}</small>
                )}
              </span>
              {n.kind === "folder" ? (
                <IconRight />
              ) : sel[n.id] ? (
                <IconPlus
                  className="ok"
                  style={{ transform: "rotate(45deg)" }}
                />
              ) : null}
            </button>
          </li>
        ))}
        {data && nodes.length === 0 && (
          <li className="mf-pick-none">
            {q.trim() ? "没有匹配的文件" : "这里没有可选的文件"}
          </li>
        )}
      </ul>
    </Modal>
  );
}

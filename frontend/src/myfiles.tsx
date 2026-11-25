import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Dropdown,
  Input,
  Menu,
  Message,
  Modal,
  Skeleton,
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
import { bi, useLang, withLang } from "./i18n";
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
        : bi(`${n} 字节`, `${n} B`);
export const isImage = (n: { mime?: string }) => !!n.mime?.startsWith("image/");
export const rawUrl = (id: string, download = false) =>
  withLang(`/api/me/files/${id}/raw${download ? "?download=1" : ""}`);

const hasFileTransfer = (dt?: DataTransfer | null) =>
  !!dt && Array.from(dt.types || []).includes("Files");

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
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [n.id]);
  if (n.kind === "folder")
    return (
      <span className="mf-ic mf-folder" style={{ width: size, height: size }}>
        <IconFolder />
      </span>
    );
  if (isImage(n) && n.size < 8 << 20 && !broken)
    return (
      <span className="mf-ic mf-thumb" style={{ width: size, height: size }}>
        <img
          src={rawUrl(n.id)}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
        />
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
  useLang();
  if (!u) return null;
  const pct = u.quota > 0 ? Math.min(100, (u.used / u.quota) * 100) : 0;
  return (
    <div
      className={`mf-usage ${pct >= 90 ? "full" : ""}`}
      role="img"
      aria-label={bi(
        `已用 ${bytesText(u.used)}，共 ${bytesText(u.quota)}`,
        `Used ${bytesText(u.used)} of ${bytesText(u.quota)}`,
      )}
    >
      <div className="mf-usage-bar">
        <i style={{ width: `${Math.max(pct, u.used > 0 ? 1 : 0)}%` }} />
      </div>
      <span>
        {bi(
          `已用 ${bytesText(u.used)} / ${bytesText(u.quota)}`,
          `${bytesText(u.used)} / ${bytesText(u.quota)} used`,
        )}
      </span>
    </div>
  );
}

function useListing(parent: string, name = "") {
  const [data, setData] = useState<Listing | null>(null);
  const reqSeq = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const load = useCallback(() => {
    const seq = ++reqSeq.current;
    const q = new URLSearchParams();
    if (parent) q.set("parent", parent);
    if (name) q.set("name", name);
    return api<Listing>(`/api/me/files?${q}`)
      .then((res) => {
        if (mountedRef.current && seq === reqSeq.current) setData(res);
      })
      .catch((e) => {
        if (!mountedRef.current || seq !== reqSeq.current) return;
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
  useLang();
  return (
    <nav className="mf-crumbs" aria-label={bi("所在位置", "Location")}>
      <button
        type="button"
        onClick={() => onGo("")}
        aria-current={path.length === 0 ? "page" : undefined}
      >
        {bi("全部资料", "All files")}
      </button>
      {path.map((p, i) => (
        <React.Fragment key={p.id}>
          <IconRight aria-hidden />
          <button
            type="button"
            title={p.name}
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
  loading,
  onClose,
  onPick,
}: {
  visible: boolean;
  moving: FileNode | null;
  loading?: boolean;
  onClose: () => void;
  onPick: (parent: string) => void;
}) {
  useLang();
  const [at, setAt] = useState("");
  const [data] = useListing(at);
  useEffect(() => {
    if (visible) setAt("");
  }, [visible]);
  const folders = useMemo(
    () =>
      (data?.nodes || []).filter(
        (n) => n.kind === "folder" && n.id !== moving?.id,
      ),
    [data?.nodes, moving?.id],
  );
  return (
    <Modal
      visible={visible}
      title={bi(
        `移动「${moving?.name || ""}」`,
        `Move "${moving?.name || ""}"`,
      )}
      onCancel={() => {
        if (!loading) onClose();
      }}
      maskClosable={!loading}
      escToExit={!loading}
      confirmLoading={loading}
      okText={bi("移动到这里", "Move here")}
      cancelText={bi("取消", "Cancel")}
      onOk={() => onPick(at)}
      style={{ width: 460, maxWidth: "96vw" }}
    >
      <Crumbs path={data?.path || []} onGo={setAt} />
      <ul className="mf-pick">
        {folders.map((f) => (
          <li key={f.id}>
            <button type="button" onClick={() => setAt(f.id)}>
              <FileIcon n={f} size={28} />
              <span title={f.name}>{f.name}</span>
              <IconRight />
            </button>
          </li>
        ))}
        {data && folders.length === 0 && (
          <li className="mf-pick-none">
            {bi("这里没有子文件夹", "No subfolders here")}
          </li>
        )}
      </ul>
    </Modal>
  );
}

export function MyFiles({ open }: { open: (n: FileNode) => void }) {
  useLang();
  const [parent, setParent] = useState("");
  const [q, setQ] = useState("");
  const [data, load] = useListing(parent, q.trim());
  const [busy, setBusy] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [moving, setMoving] = useState<FileNode | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const movingRef = useRef(false);
  const deletingRef = useRef(false);
  const askingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      dragDepthRef.current = 0;
    };
  }, []);

  useEffect(() => {
    if (!drag) return;
    const clearDrag = () => {
      dragDepthRef.current = 0;
      setDrag(false);
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
  }, [drag]);

  const upload = async (files: File[]) => {
    if (!files.length || uploadingRef.current) return;
    uploadingRef.current = true;
    setBusy(true);
    try {
      const r = await uploadFiles(files, parent);
      if (r.added.length)
        Message.success(
          bi(
            `已放入 ${r.added.length} 个文件`,
            `Uploaded ${r.added.length} file${r.added.length === 1 ? "" : "s"}`,
          ),
        );
      r.failed.forEach((m) => Message.warning(m));
    } catch (e) {
      err(e);
    } finally {
      uploadingRef.current = false;
      if (mountedRef.current) setBusy(false);
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
      okText: bi("好", "OK"),
      cancelText: bi("取消", "Cancel"),
      onOk: async () => {
        if (askingRef.current) return;
        const trimmed = v.trim();
        if (!trimmed) {
          Message.warning(bi("请输入名称", "Please enter a name"));
          throw new Error("empty");
        }
        askingRef.current = true;
        try {
          await ok(trimmed);
          load();
        } catch (e) {
          err(e);
          throw e;
        } finally {
          askingRef.current = false;
        }
      },
    });
  };
  const newFolder = () =>
    ask(bi("新建文件夹", "New folder"), "", (name) =>
      api("/api/me/files", {
        method: "POST",
        body: JSON.stringify({ kind: "folder", name, parent }),
      }),
    );
  const rename = (n: FileNode) =>
    ask(bi("重命名", "Rename"), n.name, (name) =>
      api(`/api/me/files/${n.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    );
  const remove = (n: FileNode) =>
    Modal.confirm({
      title: bi(`删除「${n.name}」？`, `Delete "${n.name}"?`),
      content:
        n.kind === "folder"
          ? bi(
              "文件夹和里面的所有内容都会删除，不能恢复。",
              "This folder and everything inside it will be permanently deleted.",
            )
          : bi("删除后不能恢复。", "This cannot be undone."),
      okText: bi("删除", "Delete"),
      cancelText: bi("取消", "Cancel"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (deletingRef.current) return;
        deletingRef.current = true;
        try {
          await api(`/api/me/files/${n.id}`, { method: "DELETE" });
          load();
        } catch (e) {
          err(e);
          throw e;
        } finally {
          deletingRef.current = false;
        }
      },
    });
  const move = async (to: string) => {
    if (!moving || movingRef.current) return;
    movingRef.current = true;
    setMoveBusy(true);
    try {
      await api(`/api/me/files/${moving.id}`, {
        method: "PATCH",
        body: JSON.stringify({ parent: to }),
      });
      if (mountedRef.current) setMoving(null);
      load();
    } catch (e) {
      err(e);
    } finally {
      movingRef.current = false;
      if (mountedRef.current) setMoveBusy(false);
    }
  };

  const aiStatus = useAIStatus();
  const nodes = data?.nodes || [];
  const searching = q.trim() !== "";
  return (
    <div
      className={`mf ${drag ? "drag" : ""}`}
      onDragEnter={(e) => {
        if (!hasFileTransfer(e.dataTransfer)) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setDrag(true);
      }}
      onDragOver={(e) => {
        if (!hasFileTransfer(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!drag) setDrag(true);
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
          setDrag(false);
        }
      }}
      onDrop={(e) => {
        if (!hasFileTransfer(e.dataTransfer)) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        setDrag(false);
        upload(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="mf-head">
        <div>
          <h2>{bi("我的资料", "My Files")}</h2>
          <p>
            {aiStatus.enabled
              ? bi(
                  "你自己的文档、图片和文件。和 AI 对话时发送的文件也会存在这里，AI 可以查阅其中的文字内容。",
                  "Your own documents, images, and files. Files sent in AI chats are stored here too, and the assistant can read text inside them.",
                )
              : bi(
                  "你自己的文档、图片、配置和现场文件。",
                  "Your own documents, images, configs, and site files.",
                )}
          </p>
        </div>
        <span className="mf-actions">
          <Button icon={<IconFolderAdd />} onClick={newFolder}>
            {bi("新建文件夹", "New folder")}
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
            {bi("写文档", "New doc")}
          </Button>
          <Button
            type="primary"
            icon={<IconUpload />}
            loading={busy}
            onClick={() => pick.current?.click()}
          >
            {bi("上传", "Upload")}
          </Button>
        </span>
        <input
          ref={pick}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = "";
            if (files.length) upload(files);
          }}
        />
      </header>
      <div className="mf-bar">
        {searching ? (
          <span className="mf-found" title={q.trim()}>
            {bi(`搜索「${q.trim()}」`, `Search "${q.trim()}"`)}
          </span>
        ) : (
          <Crumbs path={data?.path || []} onGo={setParent} />
        )}
        <Input
          className="mf-search"
          prefix={<IconSearch />}
          allowClear
          placeholder={bi("按名称搜索", "Search by name")}
          value={q}
          onChange={setQ}
          aria-label={bi("按名称搜索", "Search by name")}
        />
        <UsageBar u={data?.usage || null} />
      </div>
      {data && nodes.length === 0 ? (
        <div className="mf-empty">
          <span className="mf-ic mf-folder mf-big">
            <IconFolder />
          </span>
          <b>
            {searching
              ? bi("没有名称匹配的文件", "No files match that name")
              : bi("这里还是空的", "Nothing here yet")}
          </b>
          <p>
            {searching
              ? bi("换个关键词试试。", "Try another keyword.")
              : bi(
                  "把文件拖到这个区域，或点右上角的「上传」。图片、PDF、Word、Excel、日志和配置文件都可以。",
                  "Drag files here or click Upload above. Images, PDF, Word, Excel, logs, and config files are all supported.",
                )}
          </p>
        </div>
      ) : (
        <ul className="mf-list" aria-label={bi("文件列表", "File list")}>
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
                  <b title={n.name}>{n.name}</b>
                  <small>
                    {n.kind === "folder"
                      ? bi("文件夹", "Folder")
                      : bytesText(n.size)}
                    {n.source === "chat" && bi(" · 来自对话", " · From chat")}
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
                    className="mf-menu"
                    onClickMenuItem={(k) => {
                      if (k === "rename") rename(n);
                      else if (k === "move") setMoving(n);
                      else if (k === "down")
                        window.open(
                          rawUrl(n.id, true),
                          "_blank",
                          "noopener,noreferrer",
                        );
                      else remove(n);
                    }}
                  >
                    <Menu.Item key="rename">
                      <IconEdit /> {bi("重命名", "Rename")}
                    </Menu.Item>
                    <Menu.Item key="move">
                      <IconFolder /> {bi("移动到…", "Move to…")}
                    </Menu.Item>
                    {n.kind !== "folder" && (
                      <Menu.Item key="down">
                        <IconDownload /> {bi("下载", "Download")}
                      </Menu.Item>
                    )}
                    <Menu.Item key="del" className="danger-item">
                      <IconDelete /> {bi("删除", "Delete")}
                    </Menu.Item>
                  </Menu>
                }
              >
                <button
                  type="button"
                  className="mf-more"
                  aria-label={bi(
                    `${n.name} 的更多操作`,
                    `More actions for ${n.name}`,
                  )}
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
          {bi(
            `松开即可上传到「${
              data?.path.length
                ? data.path[data.path.length - 1].name
                : "全部资料"
            }」`,
            `Drop to upload to "${
              data?.path.length
                ? data.path[data.path.length - 1].name
                : "All files"
            }"`,
          )}
        </div>
      )}
      <FolderPicker
        visible={!!moving}
        moving={moving}
        loading={moveBusy}
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
  useLang();
  const aiStatus = useAIStatus();
  const deletingRef = useRef(false);
  const [d, setD] = useState<{
    node: FileNode;
    path: FileNode[];
    text?: string;
    truncated?: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setD(null);
    api<typeof d>(`/api/me/files/${id}`)
      .then((res) => {
        if (!cancelled) setD(res);
      })
      .catch((e) => {
        if (cancelled) return;
        err(e);
        gone();
      });
    return () => {
      cancelled = true;
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d)
    return (
      <div className="mf-view" aria-busy>
        <Skeleton animation text={{ rows: 5 }} />
      </div>
    );
  const n = d.node;
  return (
    <article className="mf-view enter">
      <header>
        <FileIcon n={n} size={44} />
        <div>
          <h2>{n.name}</h2>
          <p>
            {bytesText(n.size)} · {n.mime || bi("文件", "File")} ·{" "}
            {bi(`更新于 ${ago(n.updated)}`, `Updated ${ago(n.updated)}`)}
            {n.source === "chat" && bi(" · 来自对话", " · From chat")}
          </p>
        </div>
        <span className="mf-actions">
          <Button
            icon={<IconDownload />}
            onClick={() =>
              window.open(rawUrl(n.id, true), "_blank", "noopener,noreferrer")
            }
          >
            {bi("下载", "Download")}
          </Button>
          <Button
            status="danger"
            icon={<IconDelete />}
            onClick={() =>
              Modal.confirm({
                title: bi(`删除「${n.name}」？`, `Delete "${n.name}"?`),
                content: bi("删除后不能恢复。", "This cannot be undone."),
                okText: bi("删除", "Delete"),
                cancelText: bi("取消", "Cancel"),
                okButtonProps: { status: "danger" },
                onOk: async () => {
                  if (deletingRef.current) return;
                  deletingRef.current = true;
                  try {
                    await api(`/api/me/files/${n.id}`, { method: "DELETE" });
                    changed();
                    gone();
                  } catch (e) {
                    err(e);
                    throw e;
                  } finally {
                    deletingRef.current = false;
                  }
                },
              })
            }
          >
            {bi("删除", "Delete")}
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
          <h3>
            {bi("提取出的文字", "Extracted text")}
            {d.truncated
              ? bi("（只显示开头一部分）", " (showing beginning only)")
              : ""}
          </h3>
          {aiStatus.enabled && (
            <p className="faint small">
              {bi(
                "AI 查阅这份文件时读到的就是下面的文字。",
                "This is the text the assistant reads when inspecting this file.",
              )}
            </p>
          )}
          <pre>{d.text}</pre>
        </section>
      ) : (
        !isImage(n) && (
          <p className="mf-note">
            {n.note ||
              (aiStatus.enabled
                ? bi(
                    "这个文件里没有可以提取的文字，AI 查不到它的内容。",
                    "No extractable text in this file; the assistant cannot read its contents.",
                  )
                : bi(
                    "这个文件里没有可以提取的文字预览。",
                    "No extractable text preview available for this file.",
                  ))}
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
  useLang();
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
  const nodes = useMemo(
    () =>
      (data?.nodes || []).filter(
        (n) => n.kind === "folder" || !images || isImage(n),
      ),
    [data?.nodes, images],
  );
  const chosen = useMemo(() => Object.values(sel), [sel]);
  return (
    <Modal
      visible={visible}
      title={bi("从我的资料选择", "Choose from My Files")}
      onCancel={onClose}
      okText={
        chosen.length
          ? bi(`添加 ${chosen.length} 个`, `Add ${chosen.length}`)
          : bi("添加", "Add")
      }
      cancelText={bi("取消", "Cancel")}
      okButtonProps={{ disabled: !chosen.length }}
      onOk={() => onPick(chosen)}
      style={{ width: 520, maxWidth: "96vw" }}
    >
      <Input
        prefix={<IconSearch />}
        allowClear
        placeholder={bi("按名称搜索", "Search by name")}
        value={q}
        onChange={setQ}
        aria-label={bi("按名称搜索", "Search by name")}
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
              <span title={n.name}>{n.name}</span>
              {n.kind !== "folder" && (
                <em className="mf-pick-size">{bytesText(n.size)}</em>
              )}
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
            {q.trim()
              ? bi("没有匹配的文件", "No matching files")
              : bi("这里没有可选的文件", "No selectable files here")}
          </li>
        )}
      </ul>
    </Modal>
  );
}

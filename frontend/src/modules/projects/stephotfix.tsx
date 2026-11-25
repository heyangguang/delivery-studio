import React, { useEffect, useMemo, useState } from "react";
import {
  Button,
  Drawer,
  Input,
  Message,
  Modal,
  Tooltip,
} from "@arco-design/web-react";
import {
  IconCheckCircleFill,
  IconCode,
  IconCopy,
  IconDownload,
  IconPlayArrow,
  IconRefresh,
  IconSearch,
  IconUndo,
  IconUpload,
} from "@arco-design/web-react/icon";
import { bi, useLang, withLang } from "../../app/i18n";
import { ago, api, can, copy, err } from "../../shared/shared";
import "./stephotfix.css";

export type ExecLaunchIntent = {
  jobId: string;
  mode: "single" | "from" | "failed";
  stepKey?: string;
  ts: number;
};

const LAUNCH_INTENT_KEY = "mh-exec-launch-intent";

export function dispatchExecLaunchIntent(
  intent: Omit<ExecLaunchIntent, "ts">,
) {
  const full: ExecLaunchIntent = { ...intent, ts: Date.now() };
  try {
    sessionStorage.setItem(LAUNCH_INTENT_KEY, JSON.stringify(full));
  } catch {
    /* ignore storage quota */
  }
  window.dispatchEvent(
    new CustomEvent("mh-execution-launch-preset", { detail: full }),
  );
}

export function consumeExecLaunchIntent(jobId: string): ExecLaunchIntent | null {
  try {
    const raw = sessionStorage.getItem(LAUNCH_INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ExecLaunchIntent;
    if (
      !parsed ||
      parsed.jobId !== jobId ||
      Date.now() - (parsed.ts || 0) > 60000
    ) {
      return null;
    }
    sessionStorage.removeItem(LAUNCH_INTENT_KEY);
    return parsed;
  } catch {
    return null;
  }
}

type DeliveryFileItem = {
  path: string;
  size: number;
  related?: boolean;
  patched?: boolean;
  patch_id?: string;
  patch_by?: string;
  patch_at?: string;
  patch_note?: string;
};

type DeliveryPatchRecord = {
  id: string;
  path: string;
  reason?: string;
  by: string;
  at: string;
};

type FileListResp = {
  files: DeliveryFileItem[];
  patches: DeliveryPatchRecord[];
  revision: string;
  delivery_mode?: string;
  sync_count?: number;
};

type FileContentResp = {
  path: string;
  content: string;
  original: string;
  patched: boolean;
  patch?: DeliveryPatchRecord | null;
  diff?: string;
};

type SaveHotfixResp = {
  patch: DeliveryPatchRecord;
  sync: { n: number; update?: string; update_sha?: string };
  patches: DeliveryPatchRecord[];
  revision: string;
  verify_cmd?: string;
  update_url?: string;
  sha_url?: string;
  diff?: string;
};

function splitPath(p: string): { name: string; dir: string } {
  const idx = p.lastIndexOf("/");
  if (idx < 0) return { name: p, dir: "" };
  return { name: p.slice(idx + 1), dir: p.slice(0, idx) };
}

function buildSimpleLineDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= start && eb >= start && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  const ctxStart = Math.max(0, start - 2);
  const ctxEndA = Math.min(a.length - 1, ea + 2);
  const ctxEndB = Math.min(b.length - 1, eb + 2);
  const out: string[] = [
    `@@ -${ctxStart + 1},${ctxEndA - ctxStart + 1} +${ctxStart + 1},${ctxEndB - ctxStart + 1} @@`,
  ];
  for (let i = ctxStart; i < start; i++) out.push(" " + a[i]);
  for (let i = start; i <= ea; i++) out.push("-" + a[i]);
  for (let i = start; i <= eb; i++) out.push("+" + b[i]);
  for (let i = ea + 1; i <= ctxEndA; i++) out.push(" " + a[i]);
  return out.join("\n");
}

export function StepHotfixDrawer({
  open,
  jobId,
  stepKey,
  stepTitle,
  deliveryMode,
  onClose,
  onPatched,
  onLaunchStep,
}: {
  open: boolean;
  jobId: string;
  stepKey?: string;
  stepTitle?: string;
  deliveryMode?: string;
  onClose: () => void;
  onPatched?: (res: { revision?: string; patchCount?: number }) => void;
  onLaunchStep?: (mode: "single" | "from", stepKey: string) => void;
}) {
  useLang();
  const canEdit = can("delivery.run");
  const canPromote = can("component.edit");

  const [loadingList, setLoadingList] = useState(false);
  const [files, setFiles] = useState<DeliveryFileItem[]>([]);
  const [patches, setPatches] = useState<DeliveryPatchRecord[]>([]);
  const [mode, setMode] = useState(deliveryMode || "");
  const [query, setQuery] = useState("");

  const [selectedPath, setSelectedPath] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileMeta, setFileMeta] = useState<FileContentResp | null>(null);
  const [draft, setDraft] = useState("");
  const [reason, setReason] = useState("");
  const [viewMode, setViewMode] = useState<"edit" | "diff">("edit");

  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [savedBanner, setSavedBanner] = useState<SaveHotfixResp | null>(null);

  const isAuto = (mode || deliveryMode) === "automatic";

  const loadList = async (keepSelected?: string) => {
    setLoadingList(true);
    try {
      const qs = stepKey ? `?step=${encodeURIComponent(stepKey)}` : "";
      const res = await api<FileListResp>(
        `/api/jobs/${encodeURIComponent(jobId)}/scripts${qs}`,
      );
      setFiles(res.files || []);
      setPatches(res.patches || []);
      if (res.delivery_mode) setMode(res.delivery_mode);
      const nextSel =
        keepSelected && (res.files || []).some((f) => f.path === keepSelected)
          ? keepSelected
          : (res.files || [])[0]?.path || "";
      setSelectedPath(nextSel);
    } catch (e) {
      err(e);
    } finally {
      setLoadingList(false);
    }
  };

  const loadFile = async (rel: string) => {
    if (!rel) {
      setFileMeta(null);
      setDraft("");
      return;
    }
    setLoadingFile(true);
    try {
      const res = await api<FileContentResp>(
        `/api/jobs/${encodeURIComponent(jobId)}/scripts/content?path=${encodeURIComponent(rel)}`,
      );
      setFileMeta(res);
      setDraft(res.content);
      setViewMode("edit");
    } catch (e) {
      err(e);
    } finally {
      setLoadingFile(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setSavedBanner(null);
    setReason("");
    setQuery("");
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, jobId, stepKey]);

  useEffect(() => {
    if (!open || !selectedPath) return;
    void loadFile(selectedPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedPath, jobId]);

  const filteredFiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, query]);

  const relatedFiles = useMemo(
    () => filteredFiles.filter((f) => f.related),
    [filteredFiles],
  );
  const otherFiles = useMemo(
    () => filteredFiles.filter((f) => !f.related),
    [filteredFiles],
  );

  const isDirty = Boolean(fileMeta && draft !== fileMeta.content);

  const liveDiff = useMemo(() => {
    if (!fileMeta) return "";
    if (draft !== fileMeta.original) {
      return buildSimpleLineDiff(fileMeta.original, draft);
    }
    return fileMeta.diff || "";
  }, [fileMeta, draft]);

  const selectFile = (nextPath: string) => {
    if (nextPath === selectedPath) return;
    if (isDirty) {
      Modal.confirm({
        title: bi("放弃当前未保存的修改？", "Discard unsaved edits?"),
        content: bi(
          `文件 ${selectedPath} 有未保存修改，切换文件将丢弃这些内容。`,
          `Unsaved edits to ${selectedPath} will be discarded.`,
        ),
        okText: bi("切换文件", "Switch"),
        onOk: () => {
          setSelectedPath(nextPath);
        },
      });
      return;
    }
    setSelectedPath(nextPath);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving && !reverting && !promoting) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, reverting, promoting, onClose]);

  const handleSave = async () => {
    if (!fileMeta || !canEdit || saving) return;
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      Message.warning(
        bi("请填写简短的修改原因（记入交付审计日志）", "Please enter a brief modification reason"),
      );
      return;
    }
    setSaving(true);
    try {
      const res = await api<SaveHotfixResp>(
        `/api/jobs/${encodeURIComponent(jobId)}/scripts/content`,
        {
          method: "PUT",
          body: JSON.stringify({
            path: fileMeta.path,
            content: draft,
            reason: trimmedReason,
          }),
        },
      );
      setSavedBanner(res);
      setReason("");
      Message.success(
        isAuto
          ? bi(
              "热修补丁已保存！下次续跑将自动推送到执行节点。",
              "Hotfix saved! Next resume will auto-push updated scripts.",
            )
          : bi(
              "热修补丁已保存，并已生成离线增量更新包。",
              "Hotfix saved & incremental update archive built.",
            ),
      );
      await loadList(fileMeta.path);
      await loadFile(fileMeta.path);
      onPatched?.({
        revision: res.revision,
        patchCount: res.patches?.length,
      });
    } catch (e) {
      err(e);
    } finally {
      setSaving(false);
    }
  };

  const handleRevert = () => {
    if (!fileMeta || !fileMeta.patched || !canEdit) return;
    Modal.confirm({
      title: bi("还原为原始交付文件？", "Revert to original file?"),
      content: bi(
        `将撤销对 ${fileMeta.path} 的本交付热修补丁，并重新生成更新包。`,
        `Reverts all hotfix patches on ${fileMeta.path} and rebuilds the update archive.`,
      ),
      okText: bi("确认还原", "Revert"),
      okButtonProps: { status: "warning" },
      onOk: async () => {
        if (reverting) return;
        setReverting(true);
        try {
          const res = await api<{
            patches: DeliveryPatchRecord[];
            revision: string;
          }>(
            `/api/jobs/${encodeURIComponent(jobId)}/patches?path=${encodeURIComponent(fileMeta.path)}`,
            { method: "DELETE" },
          );
          setSavedBanner(null);
          Message.success(bi("已还原为原始交付文件", "Reverted to original file"));
          await loadList(fileMeta.path);
          await loadFile(fileMeta.path);
          onPatched?.({
            revision: res.revision,
            patchCount: res.patches?.length,
          });
        } catch (e) {
          err(e);
        } finally {
          setReverting(false);
        }
      },
    });
  };

  const handlePromote = () => {
    if (!fileMeta || !canPromote) return;
    Modal.confirm({
      title: bi("沉淀本次热修到组件工作区草稿？", "Promote hotfix to component draft?"),
      content: bi(
        `会把 ${fileMeta.path} 的当前内容写入对应组件的工作区草稿（不会立即影响已发布版本，你可以在组件工作台复核、验证后再发布）。`,
        `Copies ${fileMeta.path} into the corresponding component's workspace draft for review and testing before publishing.`,
      ),
      okText: bi("写入组件草稿", "Save to Draft"),
      onOk: async () => {
        if (promoting) return;
        setPromoting(true);
        try {
          const res = await api<{ component: string; path: string }>(
            `/api/jobs/${encodeURIComponent(jobId)}/patches/promote-draft`,
            {
              method: "POST",
              body: JSON.stringify({ path: fileMeta.path }),
            },
          );
          Message.success(
            bi(
              `已沉淀到组件「${res.component}」工作区草稿（${res.path}）`,
              `Promoted to component "${res.component}" draft (${res.path})`,
            ),
          );
        } catch (e) {
          err(e);
        } finally {
          setPromoting(false);
        }
      },
    });
  };

  const patchedFileCount = useMemo(
    () => new Set(patches.map((p) => p.path)).size,
    [patches],
  );

  const renderFileBtn = (f: DeliveryFileItem) => {
    const { name, dir } = splitPath(f.path);
    const active = f.path === selectedPath;
    return (
      <button
        key={f.path}
        type="button"
        className={`shf-file-btn ${active ? "on" : ""}`}
        onClick={() => selectFile(f.path)}
        title={
          f.patched
            ? `${f.path} · ${bi("已热修", "Patched")}${f.patch_note ? ` (${f.patch_note})` : ""}`
            : f.path
        }
      >
        <div className="shf-file-top">
          <span className="shf-file-name">{name}</span>
          {f.patched && (
            <span className="shf-patch-dot">{bi("已热修", "Patched")}</span>
          )}
        </div>
        {dir && <span className="shf-file-dir">{dir}</span>}
      </button>
    );
  };

  return (
    <Drawer
      className="shf-drawer"
      visible={open}
      width={980}
      style={{ maxWidth: "96vw" }}
      footer={null}
      onCancel={onClose}
      title={
        <div className="shf-head-title">
          <IconCode />
          <span>
            {stepTitle
              ? bi(`脚本查看与热修 · ${stepTitle}`, `Step Scripts & Hotfix · ${stepTitle}`)
              : bi("交付脚本查看与热修", "Delivery Scripts & Hotfix")}
          </span>
          <span className={`shf-mode-pill ${isAuto ? "auto" : ""}`}>
            {isAuto
              ? bi("自动执行 · 下次续跑自动推送补丁", "Auto-run · Auto-pushes on resume")
              : bi("离线手动 · 保存即生成增量更新包", "Offline · Builds update archive")}
          </span>
          {patchedFileCount > 0 && (
            <span className="shf-mode-pill patched">
              {bi(`本交付已热修 ${patchedFileCount} 个文件`, `${patchedFileCount} patched`)}
            </span>
          )}
        </div>
      }
    >
      <div className="shf-shell">
        {/* Left File Rail */}
        <aside className="shf-rail">
          <div className="shf-rail-search">
            <Input
              size="small"
              allowClear
              prefix={<IconSearch />}
              value={query}
              onChange={setQuery}
              placeholder={bi("筛选 Playbook / Role / 变量…", "Filter files…")}
            />
          </div>
          <div className="shf-rail-list">
            {loadingList && files.length === 0 ? (
              <div className="shf-empty">{bi("正在加载交付文件…", "Loading files…")}</div>
            ) : filteredFiles.length === 0 ? (
              <div className="shf-empty">{bi("没有匹配的可编辑文件", "No matching files")}</div>
            ) : (
              <>
                {relatedFiles.length > 0 && (
                  <div className="shf-rail-group">
                    <div className="shf-rail-cap">
                      <span>{bi("本步直接关联脚本", "Related to this step")}</span>
                      <span className="num">{relatedFiles.length}</span>
                    </div>
                    {relatedFiles.map(renderFileBtn)}
                  </div>
                )}
                {otherFiles.length > 0 && (
                  <div className="shf-rail-group">
                    <div className="shf-rail-cap">
                      <span>
                        {relatedFiles.length > 0
                          ? bi("其他可编辑交付文件", "Other delivery files")
                          : bi("可编辑交付文件", "Editable delivery files")}
                      </span>
                      <span className="num">{otherFiles.length}</span>
                    </div>
                    {otherFiles.map(renderFileBtn)}
                  </div>
                )}
              </>
            )}
          </div>
        </aside>

        {/* Right Editor & Diff Pane */}
        <section className="shf-main">
          {!selectedPath ? (
            <div className="shf-empty">
              {bi("请在左侧选择一个 Playbook、Role 或变量文件", "Select a file from the left")}
            </div>
          ) : (
            <>
              <div className="shf-toolbar">
                <div className="shf-toolbar-path">
                  <code title={selectedPath}>{selectedPath}</code>
                  {isDirty && (
                    <span className="shf-dirty-tag">
                      {bi("未保存修改", "Unsaved")}
                    </span>
                  )}
                </div>
                <div className="shf-toolbar-acts">
                  <Button.Group>
                    <Button
                      size="mini"
                      type={viewMode === "edit" ? "primary" : "secondary"}
                      onClick={() => setViewMode("edit")}
                    >
                      {canEdit ? bi("编辑代码", "Edit") : bi("查看代码", "Code")}
                    </Button>
                    <Button
                      size="mini"
                      type={viewMode === "diff" ? "primary" : "secondary"}
                      disabled={!liveDiff}
                      onClick={() => setViewMode("diff")}
                    >
                      {bi("Diff 对比", "Diff")}
                    </Button>
                  </Button.Group>
                  {fileMeta?.patched && canPromote && selectedPath.startsWith("roles/") && (
                    <Tooltip
                      content={bi(
                        "把本次热修沉淀回组件工作区草稿，避免下次新建交付再踩坑",
                        "Copy this hotfix into the component's workspace draft",
                      )}
                      mini
                    >
                      <Button
                        size="mini"
                        icon={<IconUpload />}
                        loading={promoting}
                        onClick={handlePromote}
                      >
                        {bi("沉淀回组件草稿", "Promote to Draft")}
                      </Button>
                    </Tooltip>
                  )}
                  {fileMeta?.patched && canEdit && (
                    <Button
                      size="mini"
                      status="warning"
                      icon={<IconUndo />}
                      loading={reverting}
                      onClick={handleRevert}
                    >
                      {bi("还原原始文件", "Revert")}
                    </Button>
                  )}
                  <Tooltip content={bi("刷新内容", "Reload")} mini>
                    <Button
                      size="mini"
                      icon={<IconRefresh />}
                      loading={loadingFile}
                      onClick={() => void loadFile(selectedPath)}
                    />
                  </Tooltip>
                </div>
              </div>

              {fileMeta?.patched && fileMeta.patch && (
                <div className="shf-patch-banner">
                  <span>
                    <strong>{bi("已热修", "Patched")}</strong>
                    {" · "}
                    {fileMeta.patch.by} · {ago(fileMeta.patch.at)}
                    {fileMeta.patch.reason ? ` — ${fileMeta.patch.reason}` : ""}
                  </span>
                  <span className="faint small">
                    {bi("仅影响当前交付，不影响组件库已发布版本", "Scoped to this delivery only")}
                  </span>
                </div>
              )}

              {savedBanner && (
                <div className="shf-saved-banner" role="status">
                  <div className="shf-saved-head">
                    <span className="shf-saved-title">
                      <IconCheckCircleFill />
                      {isAuto
                        ? bi(
                            "热修补丁已保存 — 下次执行将自动推送最新脚本到执行节点（免重新预检环境）",
                            "Hotfix saved — next run auto-pushes updated scripts without re-running host prep",
                          )
                        : bi(
                            `热修补丁已保存 — 已生成离线增量更新包 ${savedBanner.sync?.update || ""}`,
                            `Hotfix saved — built offline update archive ${savedBanner.sync?.update || ""}`,
                          )}
                    </span>
                    {isAuto && stepKey && onLaunchStep && can("delivery.execute") && (
                      <div className="shf-saved-acts">
                        <Button
                          size="mini"
                          type="outline"
                          icon={<IconPlayArrow />}
                          onClick={() => {
                            onClose();
                            onLaunchStep("single", stepKey);
                          }}
                        >
                          {bi("仅重跑当前步", "Retry This Step")}
                        </Button>
                        <Button
                          size="mini"
                          type="primary"
                          icon={<IconPlayArrow />}
                          onClick={() => {
                            onClose();
                            onLaunchStep("from", stepKey);
                          }}
                        >
                          {bi("从此步续跑", "Resume From Here")}
                        </Button>
                      </div>
                    )}
                  </div>
                  {!isAuto && savedBanner.verify_cmd && (
                    <div className="shf-saved-cmd">
                      <code>{savedBanner.verify_cmd}</code>
                      <Button
                        size="mini"
                        icon={<IconCopy />}
                        onClick={() => {
                          copy(savedBanner.verify_cmd!);
                          Message.success(bi("已复制覆盖命令", "Command copied"));
                        }}
                      >
                        {bi("复制命令", "Copy")}
                      </Button>
                    </div>
                  )}
                  {!isAuto && savedBanner.update_url && (
                    <div className="shf-saved-links">
                      <a
                        href={withLang(savedBanner.update_url)}
                        download={savedBanner.sync?.update}
                      >
                        <IconDownload />
                        {savedBanner.sync?.update}
                      </a>
                      {savedBanner.sha_url && (
                        <a
                          href={withLang(savedBanner.sha_url)}
                          download={`${savedBanner.sync?.update}.sha256`}
                        >
                          <IconDownload />
                          {`${savedBanner.sync?.update}.sha256`}
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="shf-editor-wrap">
                {loadingFile ? (
                  <div className="shf-empty">{bi("正在读取文件内容…", "Loading content…")}</div>
                ) : viewMode === "diff" ? (
                  <div className="shf-diff-box">
                    {liveDiff ? (
                      liveDiff.split("\n").map((line, i) => {
                        const cls = line.startsWith("@@")
                          ? "hunk"
                          : line.startsWith("+")
                            ? "add"
                            : line.startsWith("-")
                              ? "del"
                              : "";
                        return (
                          <div key={i} className={`shf-diff-line ${cls}`}>
                            {line || " "}
                          </div>
                        );
                      })
                    ) : (
                      <div className="shf-empty">
                        {bi("当前内容与原始交付文件一致，暂无差异", "Identical to original delivery file")}
                      </div>
                    )}
                  </div>
                ) : (
                  <textarea
                    className="shf-textarea"
                    spellCheck={false}
                    readOnly={!canEdit}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Tab" && canEdit) {
                        e.preventDefault();
                        const el = e.currentTarget;
                        const s = el.selectionStart;
                        const end = el.selectionEnd;
                        const next = draft.slice(0, s) + "  " + draft.slice(end);
                        setDraft(next);
                        requestAnimationFrame(() => {
                          el.selectionStart = el.selectionEnd = s + 2;
                        });
                      }
                    }}
                  />
                )}
              </div>

              {canEdit && (
                <div className="shf-footer">
                  <Input
                    size="small"
                    className="shf-reason-input"
                    value={reason}
                    onChange={setReason}
                    placeholder={bi(
                      "填写本次热修原因（必填，记入交付审计日志与执行报告）",
                      "Modification reason (required for audit trail)",
                    )}
                  />
                  {isDirty && (
                    <Button
                      size="small"
                      disabled={saving}
                      onClick={() => fileMeta && setDraft(fileMeta.content)}
                    >
                      {bi("撤销编辑", "Reset")}
                    </Button>
                  )}
                  <Button
                    size="small"
                    type="primary"
                    loading={saving}
                    disabled={!isDirty || !reason.trim()}
                    onClick={() => void handleSave()}
                  >
                    {bi("保存热修补丁", "Save Hotfix")}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </Drawer>
  );
}

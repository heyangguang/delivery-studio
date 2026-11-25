import React, { useEffect, useRef, useState } from "react";
import { Button, Input, Message, Modal, Skeleton } from "@arco-design/web-react";
import {
  IconDelete,
  IconDownload,
  IconUpload,
} from "@arco-design/web-react/icon";
import { api, cached, can, csrfToken, downloadFile, err, putCached } from "../../shared/shared";
import { lazySubView } from "./topology";
import { Segmented } from "../../design/ui";
import { bi, biv, getLang, useLang, withLang } from "../../app/i18n";
import "../settings/storageview.css";
import "./docs.css";

const LazySecReportTemplatesSection = lazySubView(() =>
  import("../security/secreport").then((m) => ({ default: m.SecReportTemplatesSection })),
);

/* Settings -> Report template: controls the enterprise manual cover, TOC, version-control page, visual palette,
   header/footer variables, and custom .docx corporate templates for every exported cluster document. */

type RS = {
  use_template: boolean;
  template?: string;
  org: string;
  project?: string;
  slogan?: string;
  doc_version?: string;
  author?: string;
  reviewer?: string;
  theme?: string;
  banner?: string;
  confidential: string;
  header: string;
  footer: string;
  note: string;
};

const THEMES: readonly {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly accent: string;
}[] = [
  {
    id: "teal",
    get name() {
      return bi("深青标准", "Teal Standard");
    },
    color: "#115248",
    accent: "#EBF2F1",
  },
  {
    id: "navy",
    get name() {
      return bi("经典藏蓝", "Classic Navy");
    },
    color: "#1E3A5F",
    accent: "#EDF2F7",
  },
  {
    id: "indigo",
    get name() {
      return bi("科技靛紫", "Tech Indigo");
    },
    color: "#3730A3",
    accent: "#EEF0FA",
  },
  {
    id: "slate",
    get name() {
      return bi("石墨深灰", "Slate Graphite");
    },
    color: "#27272A",
    accent: "#F1F3F5",
  },
];

export function ReportView() {
  useLang();
  const initReport = cached<RS>("/api/settings/report");
  const [saved, setSaved] = useState<RS | null>(() => initReport ?? null);
  const [v, setV] = useState<RS | null>(() => initReport ?? null);
  const [busy, setBusy] = useState(false);
  const [bannerBust, setBannerBust] = useState(() => Date.now());
  const [mode, setMode] = useState<"delivery" | "security">("delivery");
  const canSecView = can("security.view");

  const syncState = (r: RS) => {
    putCached("/api/settings/report", r);
    setSaved(r);
    setV(r);
  };

  useEffect(() => {
    api<RS>("/api/settings/report")
      .then(syncState)
      .catch(err);
  }, []);

  const set = (p: Partial<RS>) => setV((x) => (x ? { ...x, ...p } : x));
  const pick = useRef<HTMLInputElement>(null);
  const pickBanner = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [removingBanner, setRemovingBanner] = useState(false);
  const removingTplRef = useRef(false);

  const upload = async (f: File) => {
    if (uploading) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch(withLang("/api/settings/report/template"), {
        method: "POST",
        body: fd,
        headers: { "X-CSRF-Token": csrfToken(), "X-Lang": getLang() },
        credentials: "same-origin",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || bi("上传失败", "Upload failed"));
      syncState(body);
      Message.success(
        bi(
          "模板已上传并启用，之后导出的文档都会使用它",
          "Template uploaded and enabled for future exports",
        ),
      );
    } catch (e) {
      err(e);
    } finally {
      setUploading(false);
      if (pick.current) pick.current.value = "";
    }
  };

  const remove = () =>
    Modal.confirm({
      title: bi("删除上传的模板？", "Delete uploaded template?"),
      content: bi(
        "删除后导出改用平台内置企业公文模板。",
        "Exports will revert to the built-in corporate document template.",
      ),
      okText: bi("删除", "Delete"),
      cancelText: bi("取消", "Cancel"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        if (removingTplRef.current) return;
        removingTplRef.current = true;
        try {
          const r = await api<RS>("/api/settings/report/template", {
            method: "DELETE",
          });
          syncState(r);
          Message.success(
            bi("已切回平台内置模板", "Reverted to built-in template"),
          );
        } catch (e) {
          err(e);
        } finally {
          removingTplRef.current = false;
        }
      },
    });

  const uploadBanner = async (f: File) => {
    if (uploadingBanner) return;
    setUploadingBanner(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch(withLang("/api/settings/report/banner"), {
        method: "POST",
        body: fd,
        headers: { "X-CSRF-Token": csrfToken(), "X-Lang": getLang() },
        credentials: "same-origin",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || bi("上传失败", "Upload failed"));
      syncState(body);
      setBannerBust(Date.now());
      Message.success(bi("封面横幅已更新", "Cover banner updated"));
    } catch (e) {
      err(e);
    } finally {
      setUploadingBanner(false);
      if (pickBanner.current) pickBanner.current.value = "";
    }
  };

  const removeBanner = async () => {
    if (removingBanner) return;
    setRemovingBanner(true);
    try {
      const r = await api<RS>("/api/settings/report/banner", {
        method: "DELETE",
      });
      syncState(r);
      Message.success(bi("已移除封面横幅", "Cover banner removed"));
    } catch (e) {
      err(e);
    } finally {
      setRemovingBanner(false);
    }
  };

  const dirty = !!v && JSON.stringify(v) !== JSON.stringify(saved);
  const save = async () => {
    if (!v || busy) return;
    setBusy(true);
    try {
      const r = await api<RS>("/api/settings/report", {
        method: "PUT",
        body: JSON.stringify(v),
      });
      syncState(r);
      Message.success(
        bi(
          "已保存，之后导出的文档都会使用新规范",
          "Saved; future exports will use the updated specification",
        ),
      );
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };

  const activeTheme = v?.theme || "teal";

  return (
    <article className="sx-page st-main enter">
      <header className="sx-page-h">
        <div>
          <h1>{bi("报告模板与公文规范", "Report Template & Spec")}</h1>
          <p>
            {biv(
              <>
                统一控制导出的 Word 封面、目录、版本控制信息、图表配色及页眉页脚。文本字段支持{" "}
                <code>{"{org}"}</code>、<code>{"{project}"}</code>、
                <code>{"{cluster}"}</code>、<code>{"{title}"}</code>、
                <code>{"{version}"}</code>、<code>{"{app}"}</code>、
                <code>{"{date}"}</code>。
              </>,
              <>
                Configure exported Word covers, table of contents, version
                control, palette, headers, and footers. Text fields support{" "}
                <code>{"{org}"}</code>, <code>{"{project}"}</code>,{" "}
                <code>{"{cluster}"}</code>, <code>{"{title}"}</code>,{" "}
                <code>{"{version}"}</code>, <code>{"{app}"}</code>,{" "}
                <code>{"{date}"}</code>.
              </>,
            )}
          </p>
        </div>
        {mode === "delivery" && (
          <Button type="primary" loading={busy} disabled={!dirty} onClick={save}>
            {bi("保存设置", "Save Settings")}
          </Button>
        )}
      </header>
      {canSecView && (
        <div style={{ marginBottom: 16 }}>
          <Segmented<"delivery" | "security">
            value={mode}
            onChange={setMode}
            label={bi("报告模板类型", "Report template category")}
            options={[
              {
                value: "delivery",
                label: bi("交付文档模板（Word 封面与公文规范）", "Delivery Doc Template"),
              },
              {
                value: "security",
                label: bi("安全报告模板（Word / Excel / HTML）", "Security Report Templates"),
              },
            ]}
          />
        </div>
      )}
      {mode === "security" ? (
        <React.Suspense fallback={<Skeleton animation text={{ rows: 5 }} />}>
          <LazySecReportTemplatesSection embeddedInCard={false} />
        </React.Suspense>
      ) : (
        <>
      {!v && <div className="st-skel" aria-label={bi("载入中", "Loading")} />}
      {v && (
        <>
          <section className="sx-sec">
            <h2>{bi("模板引擎", "Template Engine")}</h2>
            <div className="rpt-tpl">
              <Segmented<"builtin" | "custom">
                value={v.use_template ? "custom" : "builtin"}
                onChange={(x) =>
                  x === "custom" && !v.template
                    ? pick.current?.click()
                    : set({ use_template: x === "custom" })
                }
                label={bi("使用的模板", "Active template")}
                options={[
                  {
                    value: "builtin",
                    label: bi("平台标准版式", "Built-in Standard"),
                  },
                  {
                    value: "custom",
                    label: bi("自定义 .docx 模板", "Custom .docx Template"),
                  },
                ]}
              />
              {v.template ? (
                <span className="rpt-file">
                  <b>{v.template}</b>
                  <Button
                    size="small"
                    icon={<IconUpload />}
                    loading={uploading}
                    onClick={() => pick.current?.click()}
                  >
                    {bi("替换", "Replace")}
                  </Button>
                  <Button
                    size="small"
                    icon={<IconDownload />}
                    onClick={() => {
                      void downloadFile(
                        withLang("/api/settings/report/template"),
                        "report-template.docx",
                      );
                    }}
                  >
                    {bi("下载当前模板", "Download Current")}
                  </Button>
                  <Button
                    size="small"
                    status="danger"
                    icon={<IconDelete />}
                    onClick={remove}
                  >
                    {bi("删除", "Delete")}
                  </Button>
                </span>
              ) : (
                <Button
                  icon={<IconUpload />}
                  loading={uploading}
                  onClick={() => pick.current?.click()}
                >
                  {bi("上传 .docx 模板", "Upload .docx Template")}
                </Button>
              )}
              <Button
                icon={<IconDownload />}
                onClick={() => {
                  Message.info(
                    bi("正在生成标准 Word 模板…", "Downloading starter Word template…"),
                  );
                  void downloadFile(
                    withLang("/api/settings/report/starter-template"),
                    "starter-template.docx",
                  );
                }}
              >
                {bi(
                  "下载可编辑标准模板 (.docx)",
                  "Download Starter Template (.docx)",
                )}
              </Button>
              <input
                ref={pick}
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                hidden
                onChange={(e) =>
                  e.target.files?.[0] && upload(e.target.files[0])
                }
              />
            </div>
            <p className="faint small rpt-help">
              {biv(
                <>
                  建议先点击“下载可编辑标准模板”，在 Word / WPS 中微调单位 Logo 或字体后上传。若使用贵司既有模板：在正文插入单独段落{" "}
                  <code>{"{{content}}"}</code> 即可保留模板封面与修订记录页（模板已含目录域时不会重复生成目录）；任何段落、文本框、页眉页脚均可使用{" "}
                  <code>{"{{title}}"}</code> <code>{"{{subtitle}}"}</code>{" "}
                  <code>{"{{project}}"}</code> <code>{"{{cluster}}"}</code>{" "}
                  <code>{"{{version}}"}</code> <code>{"{{org}}"}</code>{" "}
                  <code>{"{{author}}"}</code> <code>{"{{reviewer}}"}</code>{" "}
                  <code>{"{{slogan}}"}</code> <code>{"{{date}}"}</code>{" "}
                  <code>{"{{confidential}}"}</code>。支持英文及中文 Word 内置样式（标题 1~4、目录 1~3、页眉、页脚）。
                </>,
                <>
                  Tip: download the starter template first, adjust your logo or
                  fonts in Word/WPS, and upload it back. For an existing
                  corporate template, place a standalone{" "}
                  <code>{"{{content}}"}</code> paragraph to preserve its cover
                  and revision history (existing TOC fields won&apos;t be
                  duplicated). Any paragraph, text box, header, or footer may
                  use <code>{"{{title}}"}</code> <code>{"{{subtitle}}"}</code>{" "}
                  <code>{"{{project}}"}</code> <code>{"{{cluster}}"}</code>{" "}
                  <code>{"{{version}}"}</code> <code>{"{{org}}"}</code>{" "}
                  <code>{"{{author}}"}</code> <code>{"{{reviewer}}"}</code>{" "}
                  <code>{"{{slogan}}"}</code> <code>{"{{date}}"}</code>{" "}
                  <code>{"{{confidential}}"}</code>. Supports both English and
                  Chinese built-in Word styles (Heading 1–4, TOC 1–3, Header,
                  Footer).
                </>,
              )}
            </p>
          </section>

          <section className="sx-sec">
            <h2>{bi("主题配色与封面配图", "Color Theme & Cover Banner")}</h2>
            <div
              className="rpt-themes"
              role="radiogroup"
              aria-label={bi("文档配色主题", "Document color theme")}
            >
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={activeTheme === t.id}
                  className={`rpt-swatch${activeTheme === t.id ? " on" : ""}`}
                  onClick={() => set({ theme: t.id })}
                >
                  <span
                    className="rpt-swatch-chip"
                    style={{
                      background: t.color,
                      boxShadow: `inset 0 -8px 0 ${t.accent}`,
                    }}
                  />
                  <span>{t.name}</span>
                </button>
              ))}
            </div>
            <div className="rpt-banner-box">
              <div className="rpt-banner-info">
                <b>{bi("封面横幅（可选）", "Cover Banner (Optional)")}</b>
                <p className="faint small">
                  {v.banner
                    ? bi(
                        `当前使用：${v.banner}，在封面上方全宽展示`,
                        `Active: ${v.banner}, displayed full-width at the top of the cover`,
                      )
                    : bi(
                        "未上传。封面只显示主题色标题栏和文字，不带任何配图；如需公司 Logo 或品牌图，可在此上传。",
                        "None uploaded. The cover shows only the themed header bar and text; upload a corporate logo or brand banner here if needed.",
                      )}
                </p>
                <div className="rpt-banner-acts">
                  <Button
                    size="small"
                    icon={<IconUpload />}
                    loading={uploadingBanner}
                    onClick={() => pickBanner.current?.click()}
                  >
                    {v.banner
                      ? bi("更换图片", "Replace Image")
                      : bi("上传横幅 (PNG/JPG)", "Upload Banner (PNG/JPG)")}
                  </Button>
                  {v.banner && (
                    <Button
                      size="small"
                      status="danger"
                      icon={<IconDelete />}
                      loading={removingBanner}
                      onClick={removeBanner}
                    >
                      {bi("移除横幅", "Remove Banner")}
                    </Button>
                  )}
                  <input
                    ref={pickBanner}
                    type="file"
                    accept="image/png,image/jpeg,image/gif"
                    hidden
                    onChange={(e) =>
                      e.target.files?.[0] && uploadBanner(e.target.files[0])
                    }
                  />
                </div>
              </div>
              {v.banner && (
                <img
                  className="rpt-banner-thumb"
                  src={withLang(`/api/settings/report/banner?v=${bannerBust}`)}
                  alt={bi("自定义封面横幅预览", "Custom cover banner preview")}
                />
              )}
            </div>
          </section>

          <section className="sx-sec">
            <h2>{bi("封面与版本控制信息", "Cover & Version Control")}</h2>
            <div className="sv-fields rpt-fields">
              <label>
                <span>{bi("项目名称", "Project Name")}</span>
                <Input
                  value={v.project || ""}
                  onChange={(x) => set({ project: x })}
                  placeholder={bi(
                    "{app}（留空默认取应用名或集群 ID）",
                    "{app} (blank defaults to app name or cluster ID)",
                  )}
                  maxLength={120}
                  aria-label={bi("项目名称", "Project name")}
                />
              </label>
              <label>
                <span>{bi("封面主标语", "Cover Slogan")}</span>
                <Input
                  value={v.slogan || ""}
                  onChange={(x) => set({ slogan: x })}
                  placeholder={bi(
                    "标准化部署与高可用运维体系",
                    "Standardized Deployment & High-Availability Operations",
                  )}
                  maxLength={120}
                  aria-label={bi("封面主标语", "Cover slogan")}
                />
              </label>
              <label>
                <span>{bi("单位 / 编写团队名称", "Organization / Author Team")}</span>
                <Input
                  value={v.org}
                  onChange={(x) => set({ org: x })}
                  placeholder={bi(
                    "例如：某某信息科技有限公司",
                    "e.g., Acme Cloud Infrastructure Team",
                  )}
                  maxLength={120}
                  aria-label={bi("单位名称", "Organization name")}
                />
              </label>
              <label>
                <span>{bi("默认文档版本号", "Default Document Version")}</span>
                <Input
                  value={v.doc_version || ""}
                  onChange={(x) => set({ doc_version: x })}
                  placeholder="V1.0"
                  maxLength={120}
                  aria-label={bi("默认文档版本号", "Default document version")}
                />
              </label>
              <label>
                <span>{bi("默认作者", "Default Author")}</span>
                <Input
                  value={v.author || ""}
                  onChange={(x) => set({ author: x })}
                  placeholder={bi(
                    "留空默认取导出人员账号",
                    "Blank defaults to exporter username",
                  )}
                  maxLength={120}
                  aria-label={bi("默认作者", "Default author")}
                />
              </label>
              <label>
                <span>{bi("默认审核人", "Default Reviewer")}</span>
                <Input
                  value={v.reviewer || ""}
                  onChange={(x) => set({ reviewer: x })}
                  placeholder={bi(
                    "例如：基础架构组",
                    "e.g., Infrastructure Architecture Group",
                  )}
                  maxLength={120}
                  aria-label={bi("默认审核人", "Default reviewer")}
                />
              </label>
              <label>
                <span>{bi("密级标识", "Classification")}</span>
                <Input
                  value={v.confidential}
                  onChange={(x) => set({ confidential: x })}
                  placeholder={bi(
                    "例如：内部、秘密；留空不显示",
                    "e.g., Internal, Confidential (blank to hide)",
                  )}
                  maxLength={120}
                  aria-label={bi("密级标识", "Classification")}
                />
              </label>
              <label className="wide">
                <span>{bi("封面备注", "Cover Note")}</span>
                <Input.TextArea
                  value={v.note}
                  onChange={(x) => set({ note: x })}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  style={{ resize: "none" }}
                  placeholder={bi(
                    "例如：本文档基于 {cluster} 实际交付基线自动生成，供项目验收与日常运维使用。",
                    "e.g., Auto-generated from the {cluster} delivery baseline for acceptance and daily operations.",
                  )}
                  maxLength={1000}
                  aria-label={bi("封面备注", "Cover note")}
                />
              </label>
            </div>
          </section>

          <section className="sx-sec">
            <h2>{bi("页眉与页脚", "Headers & Footers")}</h2>
            <div className="sv-fields rpt-fields">
              <label>
                <span>{bi("正文页眉", "Body Header")}</span>
                <Input
                  value={v.header}
                  onChange={(x) => set({ header: x })}
                  placeholder="{cluster} · {title}"
                  maxLength={120}
                  aria-label={bi("正文页眉", "Body header")}
                />
              </label>
              <label>
                <span>
                  {bi(
                    "正文页脚（系统自动附加居中页码）",
                    "Body Footer (centered page number appended automatically)",
                  )}
                </span>
                <Input
                  value={v.footer}
                  onChange={(x) => set({ footer: x })}
                  placeholder="{org}"
                  maxLength={120}
                  aria-label={bi("正文页脚", "Body footer")}
                />
              </label>
            </div>
            <p className="faint small">
              {bi(
                "双节排版规范：封面、目录与版本控制页不显示正文页眉，底部使用罗马页码角标（I, II, ...）；自第 1 章正文起自动续编阿拉伯页码（第 N 页）。目录在 Word 打开时自动刷新；WPS 中若页码暂未显示，右键目录选择“更新域”。使用自定义模板时，以模板自身的页眉页脚为准。",
                "Two-section layout: cover, TOC, and revision pages omit the body header and use Roman numerals (I, II, ...); body chapters starting at Chapter 1 use Arabic page numbers. The TOC auto-updates when opened in Word (in WPS, right-click the TOC and choose Update Field if needed). Custom .docx templates use their own headers and footers.",
              )}
            </p>
          </section>
        </>
      )}
        </>
      )}
    </article>
  );
}

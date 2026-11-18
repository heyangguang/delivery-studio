import React, { useEffect, useRef, useState } from "react";
import { Button, Input, Message, Modal } from "@arco-design/web-react";
import {
  IconDelete,
  IconDownload,
  IconUpload,
} from "@arco-design/web-react/icon";
import { api, cached, csrfToken, err, putCached } from "./shared";
import { Segmented } from "./ui";
import "./storageview.css";
import "./docs.css";

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

const THEMES = [
  { id: "teal", name: "深青标准", color: "#115248", accent: "#EBF2F1" },
  { id: "navy", name: "经典藏蓝", color: "#1E3A5F", accent: "#EDF2F7" },
  { id: "indigo", name: "科技靛紫", color: "#3730A3", accent: "#EEF0FA" },
  { id: "slate", name: "石墨深灰", color: "#27272A", accent: "#F1F3F5" },
] as const;

export function ReportView() {
  const initReport = cached<RS>("/api/settings/report");
  const [saved, setSaved] = useState<RS | null>(() => initReport ?? null);
  const [v, setV] = useState<RS | null>(() => initReport ?? null);
  const [busy, setBusy] = useState(false);
  const [bannerBust, setBannerBust] = useState(() => Date.now());

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

  const upload = async (f: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/settings/report/template", {
        method: "POST",
        body: fd,
        headers: { "X-CSRF-Token": csrfToken() },
        credentials: "same-origin",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "上传失败");
      syncState(body);
      Message.success("模板已上传并启用，之后导出的文档都会使用它");
    } catch (e) {
      err(e);
    } finally {
      setUploading(false);
      if (pick.current) pick.current.value = "";
    }
  };

  const remove = () =>
    Modal.confirm({
      title: "删除上传的模板？",
      content: "删除后导出改用平台内置企业公文模板。",
      okText: "删除",
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          const r = await api<RS>("/api/settings/report/template", {
            method: "DELETE",
          });
          syncState(r);
          Message.success("已切回平台内置模板");
        } catch (e) {
          err(e);
        }
      },
    });

  const uploadBanner = async (f: File) => {
    setUploadingBanner(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/settings/report/banner", {
        method: "POST",
        body: fd,
        headers: { "X-CSRF-Token": csrfToken() },
        credentials: "same-origin",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "上传失败");
      syncState(body);
      setBannerBust(Date.now());
      Message.success("封面横幅已更新");
    } catch (e) {
      err(e);
    } finally {
      setUploadingBanner(false);
      if (pickBanner.current) pickBanner.current.value = "";
    }
  };

  const removeBanner = async () => {
    try {
      const r = await api<RS>("/api/settings/report/banner", {
        method: "DELETE",
      });
      syncState(r);
      Message.success("已移除封面横幅");
    } catch (e) {
      err(e);
    }
  };

  const dirty = !!v && JSON.stringify(v) !== JSON.stringify(saved);
  const save = async () => {
    if (!v) return;
    setBusy(true);
    try {
      const r = await api<RS>("/api/settings/report", {
        method: "PUT",
        body: JSON.stringify(v),
      });
      syncState(r);
      Message.success("已保存，之后导出的文档都会使用新规范");
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
          <h1>报告模板与公文规范</h1>
          <p>
            统一控制导出的 Word 封面、目录、版本控制信息、图表配色及页眉页脚。文本字段支持{" "}
            <code>{"{org}"}</code>、<code>{"{project}"}</code>、
            <code>{"{cluster}"}</code>、<code>{"{title}"}</code>、
            <code>{"{version}"}</code>、<code>{"{app}"}</code>、
            <code>{"{date}"}</code>。
          </p>
        </div>
        <Button type="primary" loading={busy} disabled={!dirty} onClick={save}>
          保存设置
        </Button>
      </header>
      {!v && <div className="st-skel" aria-label="载入中" />}
      {v && (
        <>
          <section className="sx-sec">
            <h2>模板引擎</h2>
            <div className="rpt-tpl">
              <Segmented<"builtin" | "custom">
                value={v.use_template ? "custom" : "builtin"}
                onChange={(x) =>
                  x === "custom" && !v.template
                    ? pick.current?.click()
                    : set({ use_template: x === "custom" })
                }
                label="使用的模板"
                options={[
                  { value: "builtin", label: "平台标准版式" },
                  { value: "custom", label: "自定义 .docx 模板" },
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
                    替换
                  </Button>
                  <Button
                    size="small"
                    icon={<IconDownload />}
                    href="/api/settings/report/template"
                  >
                    下载当前模板
                  </Button>
                  <Button
                    size="small"
                    status="danger"
                    icon={<IconDelete />}
                    onClick={remove}
                  >
                    删除
                  </Button>
                </span>
              ) : (
                <Button
                  icon={<IconUpload />}
                  loading={uploading}
                  onClick={() => pick.current?.click()}
                >
                  上传 .docx 模板
                </Button>
              )}
              <Button
                icon={<IconDownload />}
                href="/api/settings/report/starter-template"
              >
                下载可编辑标准模板 (.docx)
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
              建议先点击“下载可编辑标准模板”，在 Word / WPS 中微调单位 Logo 或字体后上传。若使用贵司既有模板：在正文插入单独段落{" "}
              <code>{"{{content}}"}</code> 即可保留模板封面与修订记录页（模板已含目录域时不会重复生成目录）；任何段落、文本框、页眉页脚均可使用{" "}
              <code>{"{{title}}"}</code> <code>{"{{subtitle}}"}</code>{" "}
              <code>{"{{project}}"}</code> <code>{"{{cluster}}"}</code>{" "}
              <code>{"{{version}}"}</code> <code>{"{{org}}"}</code>{" "}
              <code>{"{{author}}"}</code> <code>{"{{reviewer}}"}</code>{" "}
              <code>{"{{slogan}}"}</code> <code>{"{{date}}"}</code>{" "}
              <code>{"{{confidential}}"}</code>。支持英文及中文 Word 内置样式（标题 1~4、目录 1~3、页眉、页脚）。
            </p>
          </section>

          <section className="sx-sec">
            <h2>主题配色与封面配图</h2>
            <div className="rpt-themes" role="radiogroup" aria-label="文档配色主题">
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
                <b>封面横幅（可选）</b>
                <p className="faint small">
                  {v.banner
                    ? `当前使用：${v.banner}，在封面上方全宽展示`
                    : "未上传。封面只显示主题色标题栏和文字，不带任何配图；如需公司 Logo 或品牌图，可在此上传。"}
                </p>
                <div className="rpt-banner-acts">
                  <Button
                    size="small"
                    icon={<IconUpload />}
                    loading={uploadingBanner}
                    onClick={() => pickBanner.current?.click()}
                  >
                    {v.banner ? "更换图片" : "上传横幅 (PNG/JPG)"}
                  </Button>
                  {v.banner && (
                    <Button
                      size="small"
                      status="danger"
                      icon={<IconDelete />}
                      onClick={removeBanner}
                    >
                      移除横幅
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
                  src={`/api/settings/report/banner?v=${bannerBust}`}
                  alt="自定义封面横幅预览"
                />
              )}
            </div>
          </section>

          <section className="sx-sec">
            <h2>封面与版本控制信息</h2>
            <div className="sv-fields rpt-fields">
              <label>
                <span>项目名称</span>
                <Input
                  value={v.project || ""}
                  onChange={(x) => set({ project: x })}
                  placeholder="{app}（留空默认取应用名或集群 ID）"
                  maxLength={120}
                  aria-label="项目名称"
                />
              </label>
              <label>
                <span>封面主标语</span>
                <Input
                  value={v.slogan || ""}
                  onChange={(x) => set({ slogan: x })}
                  placeholder="标准化部署与高可用运维体系"
                  maxLength={120}
                  aria-label="封面主标语"
                />
              </label>
              <label>
                <span>单位 / 编写团队名称</span>
                <Input
                  value={v.org}
                  onChange={(x) => set({ org: x })}
                  placeholder="例如：某某信息科技有限公司"
                  maxLength={120}
                  aria-label="单位名称"
                />
              </label>
              <label>
                <span>默认文档版本号</span>
                <Input
                  value={v.doc_version || ""}
                  onChange={(x) => set({ doc_version: x })}
                  placeholder="V1.0"
                  maxLength={120}
                  aria-label="默认文档版本号"
                />
              </label>
              <label>
                <span>默认作者</span>
                <Input
                  value={v.author || ""}
                  onChange={(x) => set({ author: x })}
                  placeholder="留空默认取导出人员账号"
                  maxLength={120}
                  aria-label="默认作者"
                />
              </label>
              <label>
                <span>默认审核人</span>
                <Input
                  value={v.reviewer || ""}
                  onChange={(x) => set({ reviewer: x })}
                  placeholder="例如：基础架构组"
                  maxLength={120}
                  aria-label="默认审核人"
                />
              </label>
              <label>
                <span>密级标识</span>
                <Input
                  value={v.confidential}
                  onChange={(x) => set({ confidential: x })}
                  placeholder="例如：内部、秘密；留空不显示"
                  maxLength={120}
                  aria-label="密级标识"
                />
              </label>
              <label className="wide">
                <span>封面备注</span>
                <Input.TextArea
                  value={v.note}
                  onChange={(x) => set({ note: x })}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  style={{ resize: "none" }}
                  placeholder="例如：本文档基于 {cluster} 实际交付基线自动生成，供项目验收与日常运维使用。"
                  maxLength={1000}
                  aria-label="封面备注"
                />
              </label>
            </div>
          </section>

          <section className="sx-sec">
            <h2>页眉与页脚</h2>
            <div className="sv-fields rpt-fields">
              <label>
                <span>正文页眉</span>
                <Input
                  value={v.header}
                  onChange={(x) => set({ header: x })}
                  placeholder="{cluster} · {title}"
                  maxLength={120}
                  aria-label="正文页眉"
                />
              </label>
              <label>
                <span>正文页脚（系统自动附加居中页码）</span>
                <Input
                  value={v.footer}
                  onChange={(x) => set({ footer: x })}
                  placeholder="{org}"
                  maxLength={120}
                  aria-label="正文页脚"
                />
              </label>
            </div>
            <p className="faint small">
              双节排版规范：封面、目录与版本控制页不显示正文页眉，底部使用罗马页码角标（I, II, ...）；自第 1 章正文起自动续编阿拉伯页码（第 N 页）。目录在 Word 打开时自动刷新；WPS 中若页码暂未显示，右键目录选择“更新域”。使用自定义模板时，以模板自身的页眉页脚为准。
            </p>
          </section>
        </>
      )}
    </article>
  );
}

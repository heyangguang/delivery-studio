import React, { useEffect, useState } from "react";
import {
  Button,
  Input,
  InputNumber,
  Message,
  Modal,
} from "@arco-design/web-react";
import { IconEdit } from "@arco-design/web-react/icon";
import { api, cached, can, err, putCached, useAIStatus } from "./shared";
import { UsageBar, bytesText } from "./myfiles";
import { bi, useLang } from "./i18n";
import "./storageview.css";

/* Settings → Storage: how much room each person gets for the files they keep and attach in conversations. */

type Row = { user: string; used: number; quota: number; override?: number };
type Data = {
  settings: {
    default_gb: number;
    max_file_mb: number;
    overrides: Record<string, number>;
  };
  users: Row[];
  total_used: number;
};

/** Asks for one person's quota; blank goes back to the default. Resolves with the new numbers. */
export function editQuota(
  user: string,
  current: { quota: number; custom: boolean },
  done: () => void,
) {
  let v: number | undefined = current.custom
    ? +(current.quota / (1 << 30)).toFixed(2)
    : undefined;
  Modal.confirm({
    title: bi(`${user} 的存储额度`, `Storage quota for ${user}`),
    content: (
      <div className="sv-q">
        <InputNumber
          min={0}
          max={100000}
          precision={2}
          defaultValue={v}
          placeholder={bi("留空 = 用默认额度", "Blank = default quota")}
          suffix="GB"
          onChange={(x) =>
            (v = x === undefined || x === null ? undefined : Number(x))
          }
          style={{ width: "100%" }}
          aria-label={bi("额度（GB）", "Quota (GB)")}
          autoFocus
        />
        <small>
          {bi(
            "留空表示使用平台的默认额度；填 0 表示不让这个账户再存新文件。",
            "Leave blank to use the platform default; enter 0 to block new file uploads for this account.",
          )}
        </small>
      </div>
    ),
    okText: bi("保存", "Save"),
    cancelText: bi("取消", "Cancel"),
    onOk: async () => {
      try {
        await api(`/api/users/${encodeURIComponent(user)}/quota`, {
          method: "PUT",
          body: JSON.stringify({ gb: v === undefined ? -1 : v }),
        });
        Message.success(
          v === undefined
            ? bi("已改回默认额度", "Reverted to default quota")
            : bi(`已调整为 ${v} GB`, `Updated to ${v} GB`),
        );
        done();
      } catch (e) {
        err(e);
        throw e;
      }
    },
  });
}

export function StorageView() {
  useLang();
  const initStorage = cached<Data>("/api/settings/storage");
  const [d, setD] = useState<Data | null>(() => initStorage ?? null);
  const [gb, setGb] = useState(() => initStorage?.settings.default_gb ?? 20);
  const [mb, setMb] = useState(() => initStorage?.settings.max_file_mb ?? 200);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<Data>("/api/settings/storage")
      .then((r) => {
        putCached("/api/settings/storage", r);
        setD(r);
        setGb(r.settings.default_gb);
        setMb(r.settings.max_file_mb);
      })
      .catch(err);
  useEffect(() => {
    load();
  }, []);
  const dirty =
    !!d && (gb !== d.settings.default_gb || mb !== d.settings.max_file_mb);
  const save = async () => {
    if (!d) return;
    setBusy(true);
    try {
      await api("/api/settings/storage", {
        method: "PUT",
        body: JSON.stringify({
          ...d.settings,
          default_gb: gb,
          max_file_mb: mb,
        }),
      });
      Message.success(bi("已保存", "Saved"));
      load();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const aiStatus = useAIStatus();
  const rows = (d?.users || [])
    .filter(
      (r) => !q.trim() || r.user.toLowerCase().includes(q.trim().toLowerCase()),
    )
    .sort((a, b) => b.used - a.used);
  return (
    <article className="sx-page st-main enter">
      <header className="sx-page-h">
        <div>
          <h1>{bi("存储空间", "Storage")}</h1>
          <p>
            {aiStatus.enabled
              ? bi(
                  "每个人都有自己的存储空间，存放自己上传的文件、图片和文档，在 AI 对话里发送的附件也会存进去。这里设置默认额度，也可以给某个人单独调整。",
                  "Each user has personal storage for uploaded files, images, and documents, including AI chat attachments. Set default quotas here or adjust per user.",
                )
              : bi(
                  "每个人都有自己的存储空间，存放自己上传的文件、图片和文档。这里设置默认额度，也可以给某个人单独调整。",
                  "Each user has personal storage for uploaded files, images, and documents. Set default quotas here or adjust per user.",
                )}
          </p>
        </div>
        <Button type="primary" loading={busy} disabled={!dirty} onClick={save}>
          {bi("保存", "Save")}
        </Button>
      </header>
      {!d && <div className="st-skel" aria-label={bi("载入中", "Loading")} />}
      {d && (
        <>
          <section className="sx-sec">
            <h2>{bi("默认设置", "Default Settings")}</h2>
            <div className="sv-fields">
              <label>
                <span>{bi("每人默认额度", "Default quota per user")}</span>
                <InputNumber
                  min={0.1}
                  max={100000}
                  precision={1}
                  value={gb}
                  onChange={(v) => setGb(Number(v) || 20)}
                  suffix="GB"
                  aria-label={bi("每人默认额度", "Default quota per user")}
                />
              </label>
              <label>
                <span>{bi("单个文件上限", "Max file size")}</span>
                <InputNumber
                  min={1}
                  max={102400}
                  precision={0}
                  value={mb}
                  onChange={(v) => setMb(Number(v) || 200)}
                  suffix="MB"
                  aria-label={bi("单个文件上限", "Max file size")}
                />
              </label>
            </div>
            <p className="faint small">
              {bi(
                `已使用 ${bytesText(d.total_used)}（所有账户合计）。调低默认额度不会删除任何文件，只是超出额度的人不能再上传。`,
                `${bytesText(d.total_used)} used across all accounts. Lowering the default quota does not delete existing files, but prevents new uploads once exceeded.`,
              )}
            </p>
          </section>
          <section className="sx-sec">
            <div className="sv-h">
              <h2>{bi("每个人的使用情况", "Usage by User")}</h2>
              <Input
                allowClear
                placeholder={bi("按账户名筛选", "Filter by username")}
                value={q}
                onChange={setQ}
                style={{ width: 200 }}
                aria-label={bi("按账户名筛选", "Filter by username")}
              />
            </div>
            <div
              className="sv-table"
              role="table"
              aria-label={bi("每个人的使用情况", "Usage by user")}
            >
              <div className="sv-row head" role="row">
                <span>{bi("账户", "Account")}</span>
                <span>{bi("已用 / 额度", "Used / Quota")}</span>
                <span>{bi("额度来源", "Source")}</span>
                <span />
              </div>
              {rows.map((r) => (
                <div key={r.user} className="sv-row" role="row">
                  <b>{r.user}</b>
                  <UsageBar u={{ used: r.used, quota: r.quota, max_file: 0 }} />
                  <span className="faint small">
                    {r.override !== undefined
                      ? bi("单独设置", "Custom")
                      : bi("默认", "Default")}
                  </span>
                  {can("settings.storage") && (
                    <Button
                      size="small"
                      icon={<IconEdit />}
                      onClick={() =>
                        editQuota(
                          r.user,
                          { quota: r.quota, custom: r.override !== undefined },
                          load,
                        )
                      }
                    >
                      {bi("调整", "Adjust")}
                    </Button>
                  )}
                </div>
              ))}
              {rows.length === 0 && (
                <p className="faint small">
                  {bi("没有匹配的账户。", "No matching accounts.")}
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </article>
  );
}

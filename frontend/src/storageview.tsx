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
    title: `${user} 的存储额度`,
    content: (
      <div className="sv-q">
        <InputNumber
          min={0}
          max={100000}
          precision={2}
          defaultValue={v}
          placeholder="留空 = 用默认额度"
          suffix="GB"
          onChange={(x) =>
            (v = x === undefined || x === null ? undefined : Number(x))
          }
          style={{ width: "100%" }}
          aria-label="额度（GB）"
          autoFocus
        />
        <small>
          留空表示使用平台的默认额度；填 0 表示不让这个账户再存新文件。
        </small>
      </div>
    ),
    okText: "保存",
    onOk: async () => {
      try {
        await api(`/api/users/${encodeURIComponent(user)}/quota`, {
          method: "PUT",
          body: JSON.stringify({ gb: v === undefined ? -1 : v }),
        });
        Message.success(
          v === undefined ? "已改回默认额度" : `已调整为 ${v} GB`,
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
      Message.success("已保存");
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
          <h1>存储空间</h1>
          <p>
            {aiStatus.enabled
              ? "每个人都有自己的存储空间，存放自己上传的文件、图片和文档，在 AI 对话里发送的附件也会存进去。这里设置默认额度，也可以给某个人单独调整。"
              : "每个人都有自己的存储空间，存放自己上传的文件、图片和文档。这里设置默认额度，也可以给某个人单独调整。"}
          </p>
        </div>
        <Button type="primary" loading={busy} disabled={!dirty} onClick={save}>
          保存
        </Button>
      </header>
      {!d && <div className="st-skel" aria-label="载入中" />}
      {d && (
        <>
          <section className="sx-sec">
            <h2>默认设置</h2>
            <div className="sv-fields">
              <label>
                <span>每人默认额度</span>
                <InputNumber
                  min={0.1}
                  max={100000}
                  precision={1}
                  value={gb}
                  onChange={(v) => setGb(Number(v) || 20)}
                  suffix="GB"
                  aria-label="每人默认额度"
                />
              </label>
              <label>
                <span>单个文件上限</span>
                <InputNumber
                  min={1}
                  max={102400}
                  precision={0}
                  value={mb}
                  onChange={(v) => setMb(Number(v) || 200)}
                  suffix="MB"
                  aria-label="单个文件上限"
                />
              </label>
            </div>
            <p className="faint small">
              已使用 {bytesText(d.total_used)}
              （所有账户合计）。调低默认额度不会删除任何文件，只是超出额度的人不能再上传。
            </p>
          </section>
          <section className="sx-sec">
            <div className="sv-h">
              <h2>每个人的使用情况</h2>
              <Input
                allowClear
                placeholder="按账户名筛选"
                value={q}
                onChange={setQ}
                style={{ width: 200 }}
                aria-label="按账户名筛选"
              />
            </div>
            <div
              className="sv-table"
              role="table"
              aria-label="每个人的使用情况"
            >
              <div className="sv-row head" role="row">
                <span>账户</span>
                <span>已用 / 额度</span>
                <span>额度来源</span>
                <span />
              </div>
              {rows.map((r) => (
                <div key={r.user} className="sv-row" role="row">
                  <b>{r.user}</b>
                  <UsageBar u={{ used: r.used, quota: r.quota, max_file: 0 }} />
                  <span className="faint small">
                    {r.override !== undefined ? "单独设置" : "默认"}
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
                      调整
                    </Button>
                  )}
                </div>
              ))}
              {rows.length === 0 && (
                <p className="faint small">没有匹配的账户。</p>
              )}
            </div>
          </section>
        </>
      )}
    </article>
  );
}

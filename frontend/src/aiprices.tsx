import React, { useEffect, useMemo, useState } from "react";
import {
  Button,
  Input,
  InputNumber,
  Message,
  Modal,
  Select,
} from "@arco-design/web-react";
import {
  IconDelete,
  IconDownload,
  IconPlus,
  IconUpload,
} from "@arco-design/web-react/icon";
import { api, cached, copy, err, putCached } from "./shared";
import { Segmented } from "./ui";
import "./aiprices.css";

/* Model prices: what the vendors publish (shipped with the platform, with where it came from), and the ones this site
   sets itself. A price typed on a model beats both. */

export type PriceEntry = {
  vendor: string;
  models: string[];
  in: number;
  cached: number;
  out: number;
  currency: string;
  source?: string;
  note?: string;
};
type Book = {
  updated: string;
  builtin: PriceEntry[];
  custom: PriceEntry[];
  display: string;
  rate: number;
};

const SYM: Record<string, string> = { USD: "$", CNY: "¥" };
const n = (v: number) =>
  v === 0 ? "0" : v >= 100 ? String(v) : String(+v.toFixed(4));

export const priceText = (e: {
  in: number;
  cached: number;
  out: number;
  currency: string;
}) =>
  `${SYM[e.currency] || ""}${n(e.in)} / ${SYM[e.currency] || ""}${n(e.cached)} / ${SYM[e.currency] || ""}${n(e.out)}`;

export function PricesView() {
  const initBook = cached<Book>("/api/settings/ai/prices");
  const [d, setD] = useState<Book | null>(() => initBook ?? null);
  const [custom, setCustom] = useState<PriceEntry[]>(
    () => initBook?.custom ?? [],
  );
  const [display, setDisplay] = useState(() => initBook?.display ?? "CNY");
  const [rate, setRate] = useState(() => initBook?.rate ?? 7.2);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [io, setIo] = useState<"" | "export" | "import">("");
  const [text, setText] = useState("");
  const dirty =
    !!d &&
    (JSON.stringify(custom) !== JSON.stringify(d.custom) ||
      display !== d.display ||
      rate !== d.rate);
  const load = () =>
    api<Book>("/api/settings/ai/prices")
      .then((r) => {
        putCached("/api/settings/ai/prices", r);
        setD(r);
        setCustom(r.custom);
        setDisplay(r.display);
        setRate(r.rate);
      })
      .catch(err);
  useEffect(() => {
    load();
  }, []);
  const save = async () => {
    setBusy(true);
    try {
      await api("/api/settings/ai/prices", {
        method: "PUT",
        body: JSON.stringify({ custom, display, rate }),
      });
      Message.success("已保存");
      await load();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  };
  const patch = (i: number, f: Partial<PriceEntry>) =>
    setCustom((c) => c.map((x, k) => (k === i ? { ...x, ...f } : x)));
  const fromBuiltin = (e: PriceEntry) =>
    setCustom((c) => [...c, { ...e, vendor: "自定义", source: "", note: "" }]);
  const builtin = useMemo(
    () =>
      (d?.builtin || []).filter(
        (e) =>
          !q.trim() ||
          (e.vendor + e.models.join(" "))
            .toLowerCase()
            .includes(q.trim().toLowerCase()),
      ),
    [d, q],
  );
  const vendors = [...new Set(builtin.map((e) => e.vendor))];
  return (
    <article className="sx-page st-main enter">
      <header className="sx-page-h">
        <div>
          <h1>模型价格</h1>
          <p>
            每百万 Token 的单价，用来估算费用。平台内置各家官方公布的 API
            价格作为默认；你可以加自己的价格（例如有协议折扣），在模型上直接填的价格优先级最高。费用只是估算，以厂商账单为准。
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
            <h2>费用怎么显示</h2>
            <div className="pr-disp">
              <Segmented
                size="lg"
                label="显示币种"
                value={display}
                onChange={setDisplay}
                options={[
                  { value: "CNY", label: "人民币 ¥" },
                  { value: "USD", label: "美元 $" },
                ]}
              />
              <label>
                汇率
                <span>1 美元 =</span>
                <InputNumber
                  min={0.1}
                  max={1000}
                  precision={4}
                  step={0.05}
                  value={rate}
                  onChange={(v) => setRate(Number(v) || 7.2)}
                  style={{ width: 110 }}
                  aria-label="汇率"
                />
                <span>人民币</span>
              </label>
              <small className="faint">
                用量与成本页把不同币种的费用换算成同一种币种再相加。
              </small>
            </div>
          </section>

          <section className="sx-sec">
            <div className="pr-h">
              <h2>我的价格 {custom.length > 0 && <em>{custom.length}</em>}</h2>
              <span className="pr-sp" />
              <Button
                size="small"
                icon={<IconUpload />}
                onClick={() => (setText(""), setIo("import"))}
              >
                导入
              </Button>
              <Button
                size="small"
                icon={<IconDownload />}
                onClick={() => (
                  setText(JSON.stringify(custom, null, 2)),
                  setIo("export")
                )}
                disabled={!custom.length}
              >
                导出
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<IconPlus />}
                onClick={() =>
                  setCustom((c) => [
                    ...c,
                    {
                      vendor: "自定义",
                      models: [],
                      in: 0,
                      cached: 0,
                      out: 0,
                      currency: display,
                    },
                  ])
                }
              >
                添加
              </Button>
            </div>
            {custom.length === 0 ? (
              <p className="faint small">
                还没有。下面的官方价格可以直接用；需要改（比如折扣价）就点它右边的「改价」，或在这里添加。
              </p>
            ) : (
              <div className="pr-table" role="table" aria-label="我的价格">
                <div className="pr-row head" role="row">
                  <span>名称</span>
                  <span>模型（逗号分隔；写前缀，如 gpt-6.1-sol）</span>
                  <span>输入</span>
                  <span>缓存命中</span>
                  <span>输出</span>
                  <span>币种</span>
                  <span />
                </div>
                {custom.map((e, i) => (
                  <div key={i} className="pr-row" role="row">
                    <Input
                      size="small"
                      value={e.vendor}
                      onChange={(v) => patch(i, { vendor: v })}
                      aria-label="名称"
                    />
                    <Input
                      size="small"
                      value={e.models.join(", ")}
                      onChange={(v) =>
                        patch(i, {
                          models: v.split(/[,，\s]+/).filter(Boolean),
                        })
                      }
                      placeholder="gpt-6.1-sol"
                      aria-label="模型"
                    />
                    <InputNumber
                      size="small"
                      min={0}
                      precision={4}
                      hideControl
                      value={e.in}
                      onChange={(v) => patch(i, { in: Number(v) || 0 })}
                      aria-label="输入价"
                    />
                    <InputNumber
                      size="small"
                      min={0}
                      precision={4}
                      hideControl
                      value={e.cached}
                      onChange={(v) => patch(i, { cached: Number(v) || 0 })}
                      aria-label="缓存价"
                    />
                    <InputNumber
                      size="small"
                      min={0}
                      precision={4}
                      hideControl
                      value={e.out}
                      onChange={(v) => patch(i, { out: Number(v) || 0 })}
                      aria-label="输出价"
                    />
                    <Select
                      size="small"
                      value={e.currency}
                      onChange={(v) => patch(i, { currency: v })}
                      options={[
                        { value: "CNY", label: "¥" },
                        { value: "USD", label: "$" },
                      ]}
                      triggerProps={{
                        autoAlignPopupWidth: false,
                        autoFitPosition: true,
                      }}
                      aria-label="币种"
                    />
                    <Button
                      size="small"
                      status="danger"
                      icon={<IconDelete />}
                      onClick={() =>
                        setCustom((c) => c.filter((_, k) => k !== i))
                      }
                      aria-label="删除"
                    />
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="sx-sec">
            <div className="pr-h">
              <h2>
                官方价格 <em>{d.builtin.length}</em>
              </h2>
              <small className="faint">
                平台内置，{d.updated} 取自各厂商官网；随平台版本更新
              </small>
              <span className="pr-sp" />
              <Input
                size="small"
                allowClear
                placeholder="筛选模型或厂商"
                value={q}
                onChange={setQ}
                style={{ width: 200 }}
                aria-label="筛选"
              />
            </div>
            {vendors.map((v) => (
              <div key={v} className="pr-group">
                <h3>{v}</h3>
                <div className="pr-table" role="table">
                  <div className="pr-row b head" role="row">
                    <span>模型</span>
                    <span>输入</span>
                    <span>缓存命中</span>
                    <span>输出</span>
                    <span>备注与来源</span>
                    <span />
                  </div>
                  {builtin
                    .filter((e) => e.vendor === v)
                    .map((e, i) => (
                      <div key={i} className="pr-row b" role="row">
                        <span className="pr-models">
                          {e.models.map((m) => (
                            <code key={m}>{m}</code>
                          ))}
                        </span>
                        <span className="num">
                          {SYM[e.currency]}
                          {n(e.in)}
                        </span>
                        <span className="num">
                          {SYM[e.currency]}
                          {n(e.cached)}
                        </span>
                        <span className="num">
                          {SYM[e.currency]}
                          {n(e.out)}
                        </span>
                        <span className="pr-note">
                          {e.note && <small>{e.note}</small>}
                          {e.source && (
                            <a href={e.source} target="_blank" rel="noreferrer">
                              官网
                            </a>
                          )}
                        </span>
                        <Button size="small" onClick={() => fromBuiltin(e)}>
                          改价
                        </Button>
                      </div>
                    ))}
                </div>
              </div>
            ))}
            <p className="faint small pr-foot">
              Kimi、通义千问等厂商的价格页是动态渲染的，没能自动读取，没有内置；用到时在上面「添加」，或直接填在模型上。
            </p>
          </section>
        </>
      )}
      <Modal
        visible={!!io}
        title={io === "export" ? "导出我的价格" : "导入价格"}
        onCancel={() => setIo("")}
        okText={io === "export" ? "复制" : "导入"}
        onOk={() => {
          if (io === "export") {
            copy(text);
            Message.success("已复制");
            return setIo("");
          }
          try {
            const arr = JSON.parse(text);
            if (!Array.isArray(arr)) throw new Error("需要是一个数组");
            setCustom((c) => [
              ...c,
              ...arr.map((x: PriceEntry) => ({
                vendor: x.vendor || "自定义",
                models: x.models || [],
                in: +x.in || 0,
                cached: +x.cached || 0,
                out: +x.out || 0,
                currency: x.currency === "USD" ? "USD" : "CNY",
                source: x.source,
                note: x.note,
              })),
            ]);
            setIo("");
            Message.success("已导入，记得保存");
          } catch (e) {
            Message.error("格式不对：" + (e as Error).message);
          }
        }}
      >
        <Input.TextArea
          value={text}
          onChange={setText}
          readOnly={io === "export"}
          autoSize={{ minRows: 8, maxRows: 18 }}
          style={{ resize: "none" }}
          placeholder='[{"vendor":"自家","models":["gpt-6.1-sol"],"in":1,"cached":0.5,"out":3,"currency":"CNY"}]'
          aria-label="价格 JSON"
        />
      </Modal>
    </article>
  );
}

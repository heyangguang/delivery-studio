import React, { useState } from "react";
import { Button, Checkbox, Modal, Spin } from "@arco-design/web-react";
import { api, useAIStatus } from "./shared";
import { bi, useLang } from "./i18n";

type Result = { ok: boolean; incomplete: boolean; scope: string[]; results: string[] };
export function CrossCheck({ name, flush }: { name: string; flush: () => Promise<unknown> }) {
  useLang();
  const aiStatus = useAIStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<{ name: string; title: string }[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  async function show() {
    setOpen(true); setBusy(true); setError(""); setResult(null);
    try {
      await flush();
      const [components, shared] = await Promise.all([
        api<{ id: string; name: string; has_draft?: boolean; broken?: boolean; source: string }[]>("/api/components"),
        api<{ draft?: { exists: boolean } }>("/api/components/platform-shared/workspace"),
      ]);
      const choices = components.filter(c => c.has_draft && !c.broken && c.source !== "draft").map(c => ({ name: c.id, title: c.name }));
      if (shared.draft?.exists) choices.unshift({ name: "platform-shared", title: "" });
      setOptions(choices); setNames(choices.some(c => c.name === name) ? [name] : []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true); setError(""); setResult(null);
    try {
      await flush();
      setResult(await api<Result>("/api/components/cross-check", { method: "POST", body: JSON.stringify({ names }) }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <>
    <Button onClick={show}>{bi("联合检查", "Cross-check")}</Button>
    <Modal title={bi("公共流程与组件联合检查", "Shared Flows & Components Cross-check")} visible={open} onCancel={() => setOpen(false)} footer={null} style={{ width: "min(720px, calc(100vw - 32px))" }}>
      <p>
        {aiStatus.enabled
          ? bi("选择这次一起修改的草稿，其余组件使用已发布版本。AI 提案需要先采纳；未采纳的修改不会进入检查。", "Select the drafts modified together; remaining components use published versions. AI proposals must be accepted first to be included.")
          : bi("选择这次一起修改的草稿，其余组件使用已发布版本。", "Select the drafts modified together; remaining components use published versions.")}
      </p>
      <Spin loading={busy} style={{ width: "100%" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, margin: "16px 0" }}>
          {options.map(c => <Checkbox key={c.name} disabled={busy} checked={names.includes(c.name)} onChange={checked => {setResult(null); setNames(old => checked ? [...old, c.name] : old.filter(n => n !== c.name));}}>{c.name === "platform-shared" ? bi("平台公共流程", "Platform Shared Flows") : (c.title || c.name)}</Checkbox>)}
        </div>
        {!options.length && !busy && <p>{bi("暂无可联合检查的已发布组件草稿。", "No published component drafts available for cross-check.")}</p>}
        <Button type="primary" disabled={!names.length || busy} onClick={run}>{bi("开始联合检查", "Run Cross-check")}</Button>
      </Spin>
      {error && <p role="alert" style={{ color: "var(--red)" }}>{error}</p>}
      {result && <section aria-live="polite" style={{ marginTop: 20, maxHeight: "45vh", overflow: "auto" }}>
        <h3>{!result.ok ? bi("联合检查发现问题", "Cross-check found issues") : result.incomplete ? bi("未发现新增错误，部分方案待验证", "No new errors; some schemes pending verification") : bi("联合检查通过", "Cross-check passed")}</h3>
        <ul>{result.results.map((line, i) => <li key={i} style={{ marginBottom: 8, overflowWrap: "anywhere" }}>{line}</li>)}</ul>
      </section>}
      <p className="muted" style={{ marginTop: 16 }}>{bi("检查包含静态校验和各部署方案的默认版本试生成，不会发布或执行部署。现场运行和数据迁移仍需单独验收。", "Covers static validation and dry-run generation for each scheme's default version without publishing or deploying. Runtime behavior and data migration still require separate verification.")}</p>
    </Modal>
  </>;
}

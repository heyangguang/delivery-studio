import React, { useState } from "react";
import { Button, Checkbox, Modal, Spin } from "@arco-design/web-react";
import {
  IconCheckCircleFill,
  IconCloseCircleFill,
  IconExclamationCircleFill,
  IconLaunch,
} from "@arco-design/web-react/icon";
import { api, useAIStatus } from "./shared";
import { go } from "./router";
import { bi, useLang } from "./i18n";

type CrossProblem = {
  severity: "error" | "warning" | string;
  file?: string;
  line?: number;
  message: string;
};

type CrossEntry = {
  component: string;
  kind: "static" | "render" | string;
  preset?: string;
  status: "ok" | "error" | "warn" | string;
  summary: string;
  files?: number;
  problems?: CrossProblem[];
};

type Result = {
  ok: boolean;
  incomplete: boolean;
  scope: string[];
  results: string[];
  entries?: CrossEntry[];
};

const compLabel = (
  id: string,
  options: { name: string; title: string }[],
): string => {
  if (id === "platform-shared") {
    return bi("平台公共流程", "Platform Shared Flows");
  }
  return options.find((o) => o.name === id)?.title || id;
};

export function CrossCheck({
  name,
  flush,
}: {
  name: string;
  flush: () => Promise<unknown>;
}) {
  useLang();
  const aiStatus = useAIStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<{ name: string; title: string }[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");

  async function show() {
    setOpen(true);
    setBusy(true);
    setError("");
    setResult(null);
    try {
      await flush();
      const [components, shared] = await Promise.all([
        api<
          {
            id: string;
            name: string;
            has_draft?: boolean;
            broken?: boolean;
            source: string;
          }[]
        >("/api/components"),
        api<{ draft?: { exists: boolean } }>(
          "/api/components/platform-shared/workspace",
        ),
      ]);
      const choices = components
        .filter((c) => c.has_draft && !c.broken && c.source !== "draft")
        .map((c) => ({ name: c.id, title: c.name }));
      if (shared.draft?.exists) {
        choices.unshift({ name: "platform-shared", title: "" });
      }
      setOptions(choices);
      setNames(choices.some((c) => c.name === name) ? [name] : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      await flush();
      setResult(
        await api<Result>("/api/components/cross-check", {
          method: "POST",
          body: JSON.stringify({ names }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const staticEntries = (result?.entries || []).filter(
    (e) => e.kind === "static",
  );
  const renderEntries = (result?.entries || []).filter(
    (e) => e.kind === "render",
  );
  const totalErrors = staticEntries.reduce(
    (acc, e) =>
      acc +
      (e.problems?.filter((p) => p.severity === "error").length ||
        (e.status === "error" ? 1 : 0)),
    renderEntries.filter((e) => e.status === "error").length,
  );
  const totalWarnings = staticEntries.reduce(
    (acc, e) =>
      acc + (e.problems?.filter((p) => p.severity !== "error").length || 0),
    renderEntries.filter((e) => e.status === "warn").length,
  );

  return (
    <>
      <Button onClick={show}>{bi("联合检查", "Cross-check")}</Button>
      <Modal
        title={bi("公共流程与组件联合检查", "Shared Flows & Components Cross-check")}
        visible={open}
        onCancel={() => setOpen(false)}
        footer={null}
        className="cc-modal"
        style={{ width: "min(760px, calc(100vw - 32px))" }}
      >
        <p className="cc-lead">
          {aiStatus.enabled
            ? bi(
                "选择本次要一起验证的草稿（其余组件保持已发布版本）；AI 修改提案需先采纳才会进入检查。",
                "Select drafts modified together (remaining components use published versions). Accept AI proposals first to include them.",
              )
            : bi(
                "选择本次要一起验证的草稿，其余组件保持已发布版本。",
                "Select drafts modified together; remaining components use published versions.",
              )}
        </p>

        <Spin loading={busy} style={{ width: "100%" }}>
          <div className="cc-toolbar">
            <div className="cc-picks">
              {options.map((c) => {
                const checked = names.includes(c.name);
                return (
                  <label
                    key={c.name}
                    className={`cc-pick ${checked ? "on" : ""}`}
                  >
                    <Checkbox
                      disabled={busy}
                      checked={checked}
                      onChange={(v) => {
                        setResult(null);
                        setNames((old) =>
                          v
                            ? [...old, c.name]
                            : old.filter((n) => n !== c.name),
                        );
                      }}
                    >
                      <span>{compLabel(c.name, options)}</span>
                      <code className="mono">{c.name}</code>
                    </Checkbox>
                  </label>
                );
              })}
              {!options.length && !busy && (
                <span className="muted">
                  {bi(
                    "暂无可联合检查的已发布组件草稿。",
                    "No published component drafts available for cross-check.",
                  )}
                </span>
              )}
            </div>
            <Button
              type="primary"
              disabled={!names.length || busy}
              loading={busy}
              onClick={run}
            >
              {bi("开始联合检查", "Run Cross-check")}
            </Button>
          </div>
        </Spin>

        {error && (
          <div className="cc-banner bad" role="alert">
            <IconCloseCircleFill />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <section className="cc-results" aria-live="polite">
            <div
              className={`cc-banner ${!result.ok ? "bad" : result.incomplete || totalWarnings > 0 ? "warn" : "ok"}`}
            >
              {!result.ok ? (
                <IconCloseCircleFill />
              ) : result.incomplete || totalWarnings > 0 ? (
                <IconExclamationCircleFill />
              ) : (
                <IconCheckCircleFill />
              )}
              <div className="cc-banner-text">
                <b>
                  {!result.ok
                    ? bi("联合检查发现问题", "Cross-check found issues")
                    : result.incomplete
                      ? bi(
                          "未发现新增错误，部分方案待验证",
                          "No new errors; some schemes pending verification",
                        )
                      : bi("联合检查通过", "Cross-check passed")}
                </b>
                <span className="cc-banner-counts">
                  {totalErrors > 0 && (
                    <em className="bad">
                      {bi(`${totalErrors} 项错误`, `${totalErrors} errors`)}
                    </em>
                  )}
                  {totalWarnings > 0 && (
                    <em className="warn">
                      {bi(`${totalWarnings} 项提醒`, `${totalWarnings} warnings`)}
                    </em>
                  )}
                  {renderEntries.length > 0 && (
                    <em className="ok">
                      {bi(
                        `${renderEntries.filter((e) => e.status === "ok").length}/${renderEntries.length} 个方案试生成通过`,
                        `${renderEntries.filter((e) => e.status === "ok").length}/${renderEntries.length} schemes rendered`,
                      )}
                    </em>
                  )}
                </span>
              </div>
            </div>

            {staticEntries.length > 0 && (
              <div className="cc-group">
                <div className="cc-group-head">
                  {bi("草稿静态校验", "Draft Static Validation")}
                </div>
                <div className="cc-cards">
                  {staticEntries.map((entry, idx) => (
                    <div
                      key={`${entry.component}-${idx}`}
                      className={`cc-card st-${entry.status}`}
                    >
                      <div className="cc-card-head">
                        <span className="cc-card-title">
                          {entry.status === "error" ? (
                            <IconCloseCircleFill className="ic bad" />
                          ) : entry.status === "warn" ? (
                            <IconExclamationCircleFill className="ic warn" />
                          ) : (
                            <IconCheckCircleFill className="ic ok" />
                          )}
                          <b>{compLabel(entry.component, options)}</b>
                          <code className="mono">{entry.component}</code>
                        </span>
                        <span className="cc-card-right">
                          <span className={`cc-pill st-${entry.status}`}>
                            {entry.summary}
                          </span>
                          {entry.component !== name && (
                            <Button
                              size="mini"
                              type="text"
                              icon={<IconLaunch />}
                              onClick={() => {
                                setOpen(false);
                                go({
                                  name: "components",
                                  id: entry.component,
                                  edit: "files",
                                });
                              }}
                            >
                              {bi("去工作台查看", "Open")}
                            </Button>
                          )}
                        </span>
                      </div>

                      {!!entry.problems?.length && (
                        <ul className="cc-prob-list">
                          {entry.problems.map((pr, pi) => {
                            const isErr = pr.severity === "error";
                            return (
                              <li
                                key={pi}
                                className={`cc-prob ${isErr ? "bad" : "warn"}`}
                              >
                                <span
                                  className={`cc-sev ${isErr ? "bad" : "warn"}`}
                                >
                                  {isErr
                                    ? bi("错误", "Error")
                                    : bi("提醒", "Warn")}
                                </span>
                                <div className="cc-prob-body">
                                  {pr.file && (
                                    <code className="cc-loc mono">
                                      {pr.file}
                                      {pr.line ? `:${pr.line}` : ""}
                                    </code>
                                  )}
                                  <span className="cc-prob-msg">
                                    {pr.message}
                                  </span>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {renderEntries.length > 0 && (
              <div className="cc-group">
                <div className="cc-group-head">
                  {bi("部署方案试生成", "Scheme Dry-Run Generation")}
                </div>
                <ul className="cc-render-list">
                  {renderEntries.map((entry, idx) => (
                    <li
                      key={`${entry.component}-${entry.preset}-${idx}`}
                      className={`cc-render-row st-${entry.status}`}
                    >
                      {entry.status === "error" ? (
                        <IconCloseCircleFill className="ic bad" />
                      ) : entry.status === "warn" ? (
                        <IconExclamationCircleFill className="ic warn" />
                      ) : (
                        <IconCheckCircleFill className="ic ok" />
                      )}
                      <span className="cc-render-name">
                        <b>{compLabel(entry.component, options)}</b>
                        {entry.preset && (
                          <code className="mono">{entry.preset}</code>
                        )}
                      </span>
                      <span className="cc-render-msg">{entry.summary}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {staticEntries.length === 0 &&
              renderEntries.length === 0 &&
              result.results.length > 0 && (
                <ul className="cc-fallback-list">
                  {result.results.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}
          </section>
        )}

        <p className="cc-foot muted">
          {bi(
            "检查包含静态校验与各部署方案默认版本的试生成，不会发布组件或执行部署；现场运行和数据迁移仍需单独验收。",
            "Covers static validation and dry-run generation for each scheme without publishing or deploying. Runtime behavior and data migration still require separate verification.",
          )}
        </p>
      </Modal>
    </>
  );
}

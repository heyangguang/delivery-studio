import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  InputNumber,
  Input,
  InputTag,
  Select,
  Switch,
  Tooltip,
} from "@arco-design/web-react";
import { IconUndo } from "@arco-design/web-react/icon";
import type { ParamDef } from "./shared";
import { bi, useLang } from "../app/i18n";

export const FLUSH_INPUTS_EVENT = "mh-flush-inputs";
const EMPTY_STRINGS: string[] = [];
const CIDR_SEPARATORS = [",", "，", ";", "；", " "];

function BufferedParamInput({
  value,
  onCommit,
  unit,
  label,
  bad,
}: {
  value: string;
  onCommit: (v: string) => void;
  unit?: string;
  label: string;
  bad?: string;
}) {
  const [text, setText] = useState(value);
  const committedRef = useRef(value);
  const draftRef = useRef(value);
  const pendingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!pendingRef.current) return;
    pendingRef.current = false;
    const trimmed = draftRef.current.trim();
    committedRef.current = trimmed;
    onCommitRef.current(trimmed);
  }, []);

  useEffect(() => {
    if (value !== committedRef.current) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = false;
      committedRef.current = value;
      draftRef.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    window.addEventListener(FLUSH_INPUTS_EVENT, flush);
    return () => {
      window.removeEventListener(FLUSH_INPUTS_EVENT, flush);
      flush();
    };
  }, [flush]);

  return (
    <Input
      value={text}
      onChange={(next) => {
        draftRef.current = next;
        pendingRef.current = true;
        setText(next);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(flush, 120);
      }}
      onBlur={flush}
      onPressEnter={flush}
      className="mono-in"
      suffix={unit}
      aria-label={label}
      status={bad ? "error" : undefined}
    />
  );
}

/** One labelled row of a form. ai names the field for the form assistant, which marks what it changed. */
export function Row({
  label,
  hint,
  children,
  wide,
  ai,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
  ai?: string;
}) {
  return (
    <div className={`frow ${wide ? "wide" : ""}`} data-ai={ai}>
      <label className="frow-label">{label}</label>
      <div className="frow-control">
        {children}
        {hint && <span className="frow-hint">{hint}</span>}
      </div>
    </div>
  );
}

const UNITS = ["kB", "MB", "GB", "TB"];

export function SizeInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  useLang();
  const raw = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(kB|MB|GB|TB)\s*$/i.exec(value);
  const amount = raw ? raw[1] : "";
  const unit = raw
    ? UNITS.find((u) => u.toLowerCase() === raw[2].toLowerCase()) || "MB"
    : "MB";
  return (
    <div className="size-in">
      <InputNumber
        value={amount === "" ? undefined : Number(amount)}
        min={0}
        precision={amount.includes(".") ? 2 : 0}
        onChange={(n) => onChange(`${n ?? ""}${unit}`)}
        aria-label={label}
      />
      <Select
        value={unit}
        onChange={(u) => onChange(`${amount || 0}${u}`)}
        options={UNITS}
        aria-label={bi(`${label} 单位`, `${label} unit`)}
      />
    </div>
  );
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export const isExpr = (v: unknown) =>
  typeof v === "string" && v.startsWith("=");

function genStrongSecret(len = 16): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*";
  const arr = new Uint32Array(len);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * chars.length);
  }
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}
export const showValue = (v: unknown): string =>
  Array.isArray(v)
    ? v.join(bi("、", ", "))
    : v === true
      ? bi("开启", "On")
      : v === false
        ? bi("关闭", "Off")
        : v === undefined || v === null || v === ""
          ? "—"
          : String(v);

/** A parameter control chosen by the declared type. Values keep their JSON types (numbers stay numbers). */
export const ParamField = React.memo(function ParamField({
  d,
  value,
  changed,
  bad,
  set,
  reset,
  instanceId,
  onParamChange,
  onParamReset,
  ai,
  was,
}: {
  ai?: string;
  /** What the parameter was in the base delivery being revised, shown beside the new value. */
  was?: string;
  d: ParamDef;
  value: unknown;
  changed: boolean;
  bad?: string;
  set?: (v: unknown) => void;
  reset?: () => void;
  instanceId?: string;
  onParamChange?: (id: string, key: string, v: unknown) => void;
  onParamReset?: (id: string, key: string) => void;
}) {
  useLang();
  const commit = useCallback(
    (v: unknown) => {
      if (onParamChange && instanceId !== undefined)
        onParamChange(instanceId, d.key, v);
      else set?.(v);
    },
    [onParamChange, instanceId, d.key, set],
  );
  const doReset = useCallback(() => {
    if (onParamReset && instanceId !== undefined)
      onParamReset(instanceId, d.key);
    else reset?.();
  }, [onParamReset, instanceId, d.key, reset]);

  let control: React.ReactNode;
  switch (d.type) {
    case "bool":
      control = (
        <Switch
          checked={value === true}
          onChange={(c) => commit(c)}
          aria-label={d.label}
        />
      );
      break;
    case "enum":
      control = (
        <Select
          value={String(value ?? "")}
          onChange={(v) => commit(v)}
          options={d.options}
          aria-label={d.label}
        />
      );
      break;
    case "size":
      control = (
        <SizeInput
          value={String(value ?? "")}
          onChange={(v) => commit(v)}
          label={d.label}
        />
      );
      break;
    case "int":
    case "port":
    case "float":
      control = (
        <InputNumber
          value={num(value)}
          min={num(d.min) ?? (d.type === "port" ? 1 : undefined)}
          max={num(d.max) ?? (d.type === "port" ? 65535 : undefined)}
          precision={d.type === "float" ? 2 : 0}
          step={d.type === "float" ? 0.05 : 1}
          suffix={d.unit}
          onChange={(n) => commit(n === undefined || n === null ? "" : n)}
          aria-label={d.label}
        />
      );
      break;
    case "cidr-list": {
      const list = Array.isArray(value) ? (value as string[]) : EMPTY_STRINGS;
      control = (
        <InputTag
          className="mono-in cidr-tag-in"
          allowClear
          saveOnBlur
          animation={false}
          tokenSeparators={CIDR_SEPARATORS}
          value={list}
          placeholder={bi("10.20.0.0/16，输入后回车", "10.20.0.0/16, press Enter")}
          status={bad ? "error" : undefined}
          validate={(inputVal, curVals) => {
            const s = (inputVal || "").trim();
            if (!s) return false;
            return curVals.some((x) => {
              const existing =
                typeof x === "string"
                  ? x
                  : String((x as { value?: unknown })?.value ?? "");
              return existing === s;
            })
              ? false
              : s;
          }}
          onChange={(vals) => {
            const next = Array.from(
              new Set(vals.map((x) => String(x).trim()).filter(Boolean)),
            );
            commit(next);
          }}
          {...({ "aria-label": d.label } as Record<string, string>)}
        />
      );
      break;
    }
    case "list": {
      const list = Array.isArray(value)
        ? (value as unknown[]).map((x) => String(x))
        : typeof value === "string" && value.trim()
          ? value
              .split(/\r?\n|,/)
              .map((s) => s.trim())
              .filter(Boolean)
          : EMPTY_STRINGS;
      control = (
        <InputTag
          className="mono-in"
          allowClear
          saveOnBlur
          animation={false}
          tokenSeparators={[",", "，", ";", "；"]}
          value={list}
          placeholder={bi("输入后回车添加多项", "Type item and press Enter")}
          status={bad ? "error" : undefined}
          onChange={(vals) => {
            const next = vals.map((x) => String(x).trim()).filter(Boolean);
            commit(next);
          }}
          {...({ "aria-label": d.label } as Record<string, string>)}
        />
      );
      break;
    }
    case "dict": {
      const strVal =
        value === undefined || value === null
          ? ""
          : typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2);
      control = (
        <Input.TextArea
          autoSize={{ minRows: 2, maxRows: 6 }}
          className="mono-in"
          placeholder='{"key": "value"}'
          value={strVal}
          status={bad ? "error" : undefined}
          onChange={(nv) => {
            try {
              commit(JSON.parse(nv));
            } catch {
              commit(nv);
            }
          }}
          aria-label={d.label}
        />
      );
      break;
    }
    case "secret":
      control = (
        <div style={{ display: "flex", gap: 6, alignItems: "center", width: "100%" }}>
          <Input.Password
            value={String(value ?? "")}
            placeholder={bi("留空则使用默认或自动生成", "Leave blank for default")}
            onChange={(nv) => commit(nv)}
            status={bad ? "error" : undefined}
            aria-label={d.label}
            style={{ flex: 1 }}
          />
          <Button
            size="small"
            type="secondary"
            style={{ whiteSpace: "nowrap", flexShrink: 0 }}
            onClick={() => commit(genStrongSecret())}
          >
            {bi("随机生成", "Generate")}
          </Button>
        </div>
      );
      break;
    default:
      control = (
        <BufferedParamInput
          value={String(value ?? "")}
          onCommit={commit}
          unit={d.unit}
          label={d.label}
          bad={bad}
        />
      );
  }
  const def =
    d.default === undefined || isExpr(d.default)
      ? undefined
      : showValue(d.default);
  return (
    <div
      className={`param ${changed ? "is-changed" : ""} ${bad ? "is-bad" : ""}`}
      data-ai={ai}
    >
      <div className="param-text">
        <div className="param-label">
          <label>{d.label}</label>
          {d.when && (
            <span
              className="flag"
              title={bi(`由 Ansible 条件自动联动显现：${d.when}`, `Dynamically shown by Ansible condition: ${d.when}`)}
              style={{ whiteSpace: "nowrap" }}
            >
              {bi("条件联动", "Dynamic")}
            </span>
          )}
          {d.restart && <span className="flag">{bi("重启生效", "Restart req.")}</span>}
          {d.required && <span className="flag req">{bi("必填", "Required")}</span>}
        </div>
        <div className="param-key">
          <code>{d.key}</code>
          <span className={bad ? "bad" : ""}>
            {bad || d.hint || (def ? bi(`默认 ${def}`, `Default ${def}`) : "")}
          </span>
          {changed && was !== undefined && (
            <span className="param-was">
              {bi("原来", "Was")} <s>{was || bi("（空）", "(empty)")}</s> → {bi("现在", "Now")} <b>{showValue(value)}</b>
            </span>
          )}
        </div>
      </div>
      <div className="param-control">
        {control}
        <Tooltip content={def ? bi(`恢复默认 ${def}`, `Reset to ${def}`) : bi("恢复默认", "Reset to default")} mini>
          <button
            type="button"
            className={`reset ${changed ? "" : "hidden"}`}
            onClick={doReset}
            aria-label={bi(`${d.label} 恢复默认`, `Reset ${d.label} to default`)}
            tabIndex={changed ? 0 : -1}
          >
            <IconUndo />
          </button>
        </Tooltip>
      </div>
    </div>
  );
});

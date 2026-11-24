import React, { useEffect, useState } from "react";
import { Input, InputNumber, Select, Switch } from "@arco-design/web-react";
import { IconDown } from "@arco-design/web-react/icon";
import type { HostSpec } from "./shared";
import { bi, useLang } from "./i18n";
export type HostParam = {
  key: string;
  label: string;
  type: "string" | "path" | "bool" | "int" | "enum";
  default: unknown;
  required?: boolean;
  help?: string;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
};
export type Condition = { field: string; equals: unknown };
export type HostRule = {
  id: string;
  when: Condition;
  require: Condition[];
  hide?: string[];
  message: string;
};
export type HostContract = {
  schema: string;
  parameters: HostParam[];
  rules: HostRule[];
};
export const CONTRACT_FILE = "manifest/host-parameters.yaml";
export function hostValue(
  h: HostSpec,
  c: HostContract,
  field: string,
): unknown {
  if (field.startsWith("params.")) {
    const key = field.slice(7);
    return h.params?.[key] ?? c.parameters.find((p) => p.key === key)?.default;
  }
  return field === "initialize"
    ? !!h.initialize
    : ((h as unknown as Record<string, unknown>)[field] ?? "");
}
export function hiddenHostFields(h: HostSpec, c: HostContract): Set<string> {
  return new Set(
    c.rules
      .filter((r) => hostValue(h, c, r.when.field) === r.when.equals)
      .flatMap((r) => r.hide || []),
  );
}
export function changeHostParam(
  h: HostSpec,
  c: HostContract,
  key: string,
  value: unknown,
): HostSpec {
  const next = { ...h, params: { ...h.params, [key]: value } };
  for (const r of c.rules) {
    if (hostValue(next, c, r.when.field) !== r.when.equals) continue;
    for (const v of r.require || []) {
      if (!(r.hide || []).includes(v.field)) continue;
      if (v.field.startsWith("params."))
        next.params[v.field.slice(7)] = v.equals;
      else if (v.field === "initialize") next.initialize = v.equals as boolean;
      else if (v.field === "disk" || v.field === "partition")
        next[v.field] = v.equals as string;
    }
  }
  return next;
}
export function HostParameterFields({
  host,
  contract,
  onChange,
  disabled = false,
  index,
  hasError = false,
}: {
  host: HostSpec;
  contract: HostContract;
  onChange: (h: HostSpec) => void;
  disabled?: boolean;
  index: number;
  hasError?: boolean;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (hasError) setOpen(true);
  }, [hasError]);

  const hidden = hiddenHostFields(host, contract);
  const visible = contract.parameters.filter(
    (p) => !hidden.has("params." + p.key),
  );
  if (visible.length === 0) return null;

  const storageMode = hostValue(host, contract, "params.storage_mode");
  const customized = visible.some(
    (p) => hostValue(host, contract, "params." + p.key) !== p.default,
  );
  const summaryItems = visible
    .filter((p) => {
      if (
        p.key === "data_min_free_mb" &&
        storageMode === "dedicated_disk" &&
        hostValue(host, contract, "params." + p.key) === p.default
      ) {
        return false;
      }
      return true;
    })
    .map((p) => {
      const value = hostValue(host, contract, "params." + p.key);
      if (p.type === "enum") {
        const opt = (p.options || []).find((o) => o.value === value);
        return { key: p.key, text: opt?.label || String(value ?? ""), mono: false };
      }
      if (p.type === "bool") {
        return {
          key: p.key,
          text: `${p.label}: ${value === true ? bi("开", "On") : bi("关", "Off")}`,
          mono: false,
        };
      }
      if (p.key === "data_min_free_mb") {
        return {
          key: p.key,
          text: bi(`≥ ${value} MiB`, `≥ ${value} MiB`),
          mono: true,
        };
      }
      return {
        key: p.key,
        text: String(value ?? ""),
        mono: p.type === "path" || p.type === "int",
      };
    });

  return (
    <div className={`host-params-wrap ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="host-params-bar"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="host-params-k">{bi("存储", "Storage")}</span>
        <span className="host-params-chips">
          {summaryItems.map((it) => (
            <span
              key={it.key}
              className={`host-params-chip ${it.mono ? "mono" : ""}`}
            >
              {it.text}
            </span>
          ))}
          {customized && (
            <span className="host-params-mod">{bi("已调整", "Custom")}</span>
          )}
        </span>
        <span className="host-params-tog">
          <span>{open ? bi("收起", "Hide") : bi("调整参数", "Configure")}</span>
          <IconDown className="host-params-chev" />
        </span>
      </button>
      {open && (
        <div className="host-parameters">
          {visible.map((p) => {
            const value = hostValue(host, contract, "params." + p.key);
            const label = bi(
              `机器 ${index + 1} ${p.label}`,
              `Host ${index + 1} ${p.label}`,
            );
            return (
              <div key={p.key} className="host-parameter">
                <span className="host-parameter-label">{p.label}</span>
                {p.type === "enum" ? (
                  <Select
                    aria-label={label}
                    disabled={disabled}
                    value={value as string}
                    options={p.options || []}
                    onChange={(v) =>
                      onChange(changeHostParam(host, contract, p.key, v))
                    }
                  />
                ) : p.type === "bool" ? (
                  <div className="host-parameter-switch">
                    <Switch
                      aria-label={label}
                      disabled={disabled}
                      checked={value === true}
                      onChange={(v) =>
                        onChange(changeHostParam(host, contract, p.key, v))
                      }
                    />
                    <span>
                      {value === true ? bi("开启", "On") : bi("关闭", "Off")}
                    </span>
                  </div>
                ) : p.type === "int" ? (
                  <InputNumber
                    aria-label={label}
                    disabled={disabled}
                    value={value as number}
                    min={p.min}
                    max={p.max}
                    className="mono-in"
                    onChange={(v) =>
                      onChange(changeHostParam(host, contract, p.key, v))
                    }
                  />
                ) : (
                  <Input
                    aria-label={label}
                    disabled={disabled}
                    value={String(value ?? "")}
                    className={p.type === "path" ? "mono-in" : undefined}
                    onChange={(v) =>
                      onChange(changeHostParam(host, contract, p.key, v))
                    }
                  />
                )}
                {p.help && <span className="host-parameter-help">{p.help}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

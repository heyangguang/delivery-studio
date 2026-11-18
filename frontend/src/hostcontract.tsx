import React from "react";
import { Input, InputNumber, Select, Switch } from "@arco-design/web-react";
import type { HostSpec } from "./shared";
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
}: {
  host: HostSpec;
  contract: HostContract;
  onChange: (h: HostSpec) => void;
  disabled?: boolean;
  index: number;
}) {
  const hidden = hiddenHostFields(host, contract);
  return (
    <div
      className="host-parameters"
    >
      {contract.parameters
        .filter((p) => !hidden.has("params." + p.key))
        .map((p) => {
          const value = hostValue(host, contract, "params." + p.key);
          const label = "机器 " + (index + 1) + " " + p.label;
          return (
            <div
              key={p.key}
              className="host-parameter"
            >
              <span>{p.label}</span>
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
                <div className="host-parameter-switch"><Switch
                  aria-label={label}
                  disabled={disabled}
                  checked={value === true}
                  onChange={(v) =>
                    onChange(changeHostParam(host, contract, p.key, v))
                  }
                /><span>{value === true ? "开启" : "关闭"}</span></div>
              ) : p.type === "int" ? (
                <InputNumber
                  aria-label={label}
                  disabled={disabled}
                  value={value as number}
                  min={p.min}
                  max={p.max}
                  onChange={(v) =>
                    onChange(changeHostParam(host, contract, p.key, v))
                  }
                />
              ) : (
                <Input
                  aria-label={label}
                  disabled={disabled}
                  value={String(value ?? "")}
                  onChange={(v) =>
                    onChange(changeHostParam(host, contract, p.key, v))
                  }
                />
              )}
              {p.help && <span className="muted small">{p.help}</span>}
            </div>
          );
        })}
    </div>
  );
}

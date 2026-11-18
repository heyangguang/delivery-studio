import React from "react";
import { DatePicker } from "@arco-design/web-react";
import { Segmented } from "./ui";

export type Range = { preset: string; from: string; to: string };

const DAY = 86400000;
export const rangeOf = (preset: string, custom?: [string, string]): Range => {
  const now = new Date();
  const to = new Date(now.getTime() + 60000);
  const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case "today":
      return { preset, from: sod.toISOString(), to: to.toISOString() };
    case "24h":
      return {
        preset,
        from: new Date(now.getTime() - DAY).toISOString(),
        to: to.toISOString(),
      };
    case "30d":
      return {
        preset,
        from: new Date(sod.getTime() - 29 * DAY).toISOString(),
        to: to.toISOString(),
      };
    case "custom":
      return {
        preset,
        from: new Date(custom![0]).toISOString(),
        to: new Date(custom![1]).toISOString(),
      };
    default:
      return {
        preset: "7d",
        from: new Date(sod.getTime() - 6 * DAY).toISOString(),
        to: to.toISOString(),
      };
  }
};

/** The time range of a page: a few presets, or any span. */
export function RangeBar({
  value,
  onChange,
}: {
  value: Range;
  onChange: (r: Range) => void;
}) {
  return (
    <div className="au-range">
      <Segmented
        size="lg"
        label="时间范围"
        value={value.preset}
        onChange={(v) =>
          onChange(v === "custom" ? { ...value, preset: "custom" } : rangeOf(v))
        }
        options={[
          { value: "today", label: "今天" },
          { value: "24h", label: "24 小时" },
          { value: "7d", label: "7 天" },
          { value: "30d", label: "30 天" },
          { value: "custom", label: "自定义" },
        ]}
      />
      {value.preset === "custom" ? (
        <DatePicker.RangePicker
          showTime={{ format: "HH:mm" }}
          format="YYYY-MM-DD HH:mm"
          style={{ width: 330 }}
          allowClear={false}
          value={[value.from, value.to]}
          onChange={(_, d) => {
            if (d && d[0] && d[1]) {
              const c: [string, string] = [
                d[0] as unknown as string,
                d[1] as unknown as string,
              ];
              onChange(rangeOf("custom", c));
            }
          }}
          aria-label="自定义时间范围"
        />
      ) : null}
    </div>
  );
}

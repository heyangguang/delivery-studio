import React from "react";
import { DatePicker } from "@arco-design/web-react";
import { Segmented } from "./ui";
import { bi, useLang } from "./i18n";

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
  useLang();
  return (
    <div className="au-range">
      <Segmented
        size="lg"
        label={bi("时间范围", "Time range")}
        value={value.preset}
        onChange={(v) =>
          onChange(v === "custom" ? { ...value, preset: "custom" } : rangeOf(v))
        }
        options={[
          { value: "today", label: bi("今天", "Today") },
          { value: "24h", label: bi("24 小时", "24h") },
          { value: "7d", label: bi("7 天", "7d") },
          { value: "30d", label: bi("30 天", "30d") },
          { value: "custom", label: bi("自定义", "Custom") },
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
          aria-label={bi("自定义时间范围", "Custom time range")}
        />
      ) : null}
    </div>
  );
}

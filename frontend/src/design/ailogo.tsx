import React, { useId, useMemo } from "react";
import { PROVIDER_LOGOS } from "./providerlogos";

/** A provider's mark: its own picture or a vendor logo it borrows, a vendor's logo for a known preset, else a tinted letter. */
export function ProviderLogo({
  preset,
  name,
  icon,
  color,
  size = 28,
}: {
  preset: string;
  name?: string;
  icon?: string;
  color?: string;
  size?: number;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const box: React.CSSProperties = { width: size, height: size, flexShrink: 0 };
  const rawSvg =
    PROVIDER_LOGOS[icon?.startsWith("preset:") ? icon.slice(7) : preset];
  const scopedSvg = useMemo(() => {
    if (!rawSvg) return "";
    return rawSvg.replace(/_R_0_/g, `_${uid}_`);
  }, [rawSvg, uid]);
  if (icon?.startsWith("data:"))
    return (
      <img className="ai-logo pic" style={box} src={icon} alt="" aria-hidden />
    );
  if (scopedSvg)
    return (
      <span
        className="ai-logo"
        style={box}
        aria-hidden
        dangerouslySetInnerHTML={{ __html: scopedSvg }}
      />
    );
  const letter =
    (name || "")
      .replace(/[（(].*$/, "")
      .trim()
      .slice(0, 1)
      .toUpperCase() || "+";
  return (
    <span
      className="ai-logo plain"
      style={{
        ...box,
        fontSize: Math.round(size * 0.48),
        background: color || undefined,
      }}
      aria-hidden
    >
      {letter}
    </span>
  );
}

import React from "react";
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
  const box = { width: size, height: size };
  if (icon?.startsWith("data:"))
    return (
      <img className="ai-logo pic" style={box} src={icon} alt="" aria-hidden />
    );
  const svg =
    PROVIDER_LOGOS[icon?.startsWith("preset:") ? icon.slice(7) : preset];
  if (svg)
    return (
      <span
        className="ai-logo"
        style={box}
        aria-hidden
        dangerouslySetInnerHTML={{ __html: svg }}
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

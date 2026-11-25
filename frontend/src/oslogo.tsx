import React from "react";
import { bi, getLang, useLang } from "./i18n";

/* Marks for the operating systems a delivery targets, so systems are told apart at a glance instead of by reading.
   Drawn simply in each distribution's colours; ids follow mwpack/platforms.go. */

export const osKind = (id: string) =>
  id.startsWith("ubuntu")
    ? "ubuntu"
    : id.startsWith("debian")
      ? "debian"
      : /^(el|rhel|rocky|alma|centos)/.test(id)
        ? "redhat"
        : "linux";

/** Formats a platform title in the active UI language. */
export const osTitle = (title: string) => {
  if (getLang() !== "en-US") return title;
  return title
    .replace(/^RedHat\s*系\s*(\d+)/, "RHEL $1 family")
    .replace(/（/g, " (")
    .replace(/）/g, ")")
    .replace(/\s+/g, " ")
    .trim();
};

/** "RedHat 系 9（RHEL / Rocky / Alma）(amd64)" → "RHEL 9 系" / "RHEL 9 family"; "Ubuntu 24.04 (amd64)" → "Ubuntu 24.04". */
export const osShort = (title: string) => {
  const t = title.replace(/\s*\((amd64|arm64)\)\s*$/, "");
  const el = /^RedHat(?:\s*系|\s*family)?\s*(\d+)/i.exec(t);
  if (el) return bi(`RHEL ${el[1]} 系`, `RHEL ${el[1]} family`);
  return t.replace(/（.*?）/, "").trim();
};
/** The distributions a family covers, when the title names them. */
export const osVariants = (title: string) => /（(.*?)）/.exec(title)?.[1] || "";

export function OsLogo({ id, size = 18 }: { id: string; size?: number }) {
  const k = osKind(id);
  const box: React.CSSProperties = { width: size, height: size, flexShrink: 0 };
  if (k === "ubuntu")
    return (
      <svg className="os-logo" style={box} viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="12" fill="#E95420" />
        <circle
          cx="12"
          cy="12"
          r="5.4"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
        />
        {[
          [12, 5.2],
          [6.1, 15.4],
          [17.9, 15.4],
        ].map(([x, y]) => (
          <g key={x}>
            <circle cx={x} cy={y} r="3.1" fill="#E95420" />
            <circle cx={x} cy={y} r="2.1" fill="#fff" />
          </g>
        ))}
      </svg>
    );
  if (k === "redhat")
    return (
      <svg className="os-logo" style={box} viewBox="0 0 24 24" aria-hidden>
        <rect width="24" height="24" rx="6" fill="#EE0000" />
        <path
          d="M7.4 12.1c.4-2.6 1.4-5 2.9-5.1.8 0 1.2.6 2 .6.9 0 1.5-.8 2.5-.6 1.5.3 2.2 3 2.5 5.2-1.6.5-3.6.8-5.4.7-1.7-.1-3.3-.4-4.5-.8Z"
          fill="#fff"
        />
        <path
          d="M4.3 12.6c1.3 1.1 4.6 2.2 8.2 2.2 3.1 0 5.7-.7 6.9-1.8.6.4.8.8.8 1.2 0 1.8-3.6 3.4-8.2 3.4-4.1 0-7.6-1.4-7.6-3.3 0-.7.3-1.3-.1-1.7Z"
          fill="#fff"
        />
      </svg>
    );
  if (k === "debian")
    return (
      <svg className="os-logo" style={box} viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="12" fill="#A80030" />
        <path
          d="M14.6 16.4a5 5 0 1 1 1.9-6.6 3.4 3.4 0 1 0-3.3 4.3"
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  return (
    <svg className="os-logo" style={box} viewBox="0 0 24 24" aria-hidden>
      <rect width="24" height="24" rx="6" fill="#3a3a3c" />
      <path
        d="M8 16.5h8M9 7.5h6v6H9z"
        stroke="#fff"
        strokeWidth="1.8"
        fill="none"
      />
    </svg>
  );
}

/** A system named with its mark: the short name, and the full title on hover. */
export function OsName({
  id,
  title,
  size,
}: {
  id: string;
  title: string;
  size?: number;
}) {
  useLang();
  return (
    <span className="os-name" title={osTitle(title)}>
      <OsLogo id={id} size={size} />
      <span>{osShort(title)}</span>
    </span>
  );
}

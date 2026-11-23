import React, { useSyncExternalStore } from "react";

export type Lang = "zh-CN" | "en-US";

const LANG_KEY = "mh-lang";

function detectInitialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "zh-CN" || saved === "en-US") return saved;
  } catch {
    /* ignore */
  }
  if (typeof navigator !== "undefined") {
    const raw =
      (Array.isArray(navigator.languages) && navigator.languages[0]) ||
      navigator.language ||
      "";
    if (/^zh\b/i.test(raw)) return "zh-CN";
    if (raw) return "en-US";
  }
  return "zh-CN";
}

let currentLang: Lang = detectInitialLang();
const listeners = new Set<() => void>();

function applyHtmlLang(l: Lang) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = l === "en-US" ? "en" : "zh-CN";
  }
}
applyHtmlLang(currentLang);

export const getLang = (): Lang => currentLang;

export function setLang(next: Lang) {
  if (next === currentLang) return;
  currentLang = next;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    /* ignore */
  }
  applyHtmlLang(next);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("mh-lang-change", { detail: next }));
  }
  listeners.forEach((fn) => fn());
}

export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reactive language hook; components using useLang() or useI18n() re-render live on switch. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}

/** Concise bilingual inline helper for static & reactive expressions. */
export const bi = (zh: string, en: string): string =>
  currentLang === "en-US" ? en : zh;

/** Variant of bi() returning arbitrary values (numbers, JSX nodes, arrays) by active language. */
export const biv = <T,>(zh: T, en: T): T => (currentLang === "en-US" ? en : zh);

export function useI18n() {
  const lang = useLang();
  return {
    lang,
    isEn: lang === "en-US",
    setLang,
    bi: (zh: string, en: string) => (lang === "en-US" ? en : zh),
    biv: <T,>(zh: T, en: T): T => (lang === "en-US" ? en : zh),
  };
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  useLang();
  return <>{children}</>;
}

/** Appends ?lang=<currentLang> (or replaces existing) onto direct file/export URLs. */
export function withLang(url: string): string {
  if (!url) return url;
  const sep = url.includes("?") ? "&" : "?";
  if (/[?&]lang=/.test(url)) {
    return url.replace(/([?&]lang=)[^&]*/i, `$1${encodeURIComponent(currentLang)}`);
  }
  return `${url}${sep}lang=${encodeURIComponent(currentLang)}`;
}

const CAT_EN: Record<string, string> = {
  数据库: "Database",
  缓存: "Cache",
  消息队列: "Messaging",
  对象存储: "Object Storage",
  搜索: "Search",
  协调服务: "Coordination",
  负载均衡: "Load Balancing",
  网络: "Networking",
  草稿: "Draft",
  无法载入: "Unloadable",
};

const CAT_ZH: Record<string, string> = Object.fromEntries(
  Object.entries(CAT_EN).map(([zh, en]) => [en.toLowerCase(), zh]),
);

/** Normalizes component category label to the current UI language (or canonical key if requested). */
export function catLabel(category?: string): string {
  if (!category) return "";
  if (currentLang === "en-US") return CAT_EN[category] || category;
  return CAT_ZH[category.toLowerCase()] || category;
}

/** Maps both English and Chinese category names back to canonical key for icons/tints. */
export function canonicalCat(category?: string): string {
  if (!category) return "";
  return CAT_ZH[category.toLowerCase()] || category;
}

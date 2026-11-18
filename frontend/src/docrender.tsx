import React, { useMemo } from "react";
import { Markdown } from "./aimd";

export type DocSectionTone =
  | "neutral"
  | "warn"
  | "info"
  | "cause"
  | "ok"
  | "danger";

export type DocSection = {
  id: string;
  index: number;
  title: string;
  level: number;
  tone: DocSectionTone;
  badge?: string;
  body: string;
};

const BARE_CMD_RE =
  /^(?:sudo\s+)?(?:umount|mount|wipefs|parted|partprobe|mkfs(?:\.[a-z0-9]+)?|blkid|lsblk|df|du|free|fuser|lsof|ss|netstat|ip|ping|curl|wget|ssh|scp|rsync|systemctl|journalctl|chmod|chown|mkdir|cp|mv|rm|cat|grep|awk|sed|tar|gzip|gunzip|find|sysctl|ulimit|crontab|etcdctl|patronictl|psql|pg_isready|pg_basebackup|pg_ctl|redis-cli|haproxy|keepalived|ansible-playbook|ansible-inventory|docker|podman|kubectl|helm|dnf|yum|apt|apt-get|rpm|dpkg|export|set)\b(?:\s+[-/$a-zA-Z0-9_.:=@'"<>*%+]+)+$/;

const PRESERVED_INLINE_RE =
  /(`[^`\n]+`|\[[^\]]+\]\([^)\n]+\)|https?:\/\/[^\s)<>，。；）]+|\\\([^\n]+?\\\)|\$\$[^\n]+?\$\$|\$[^\s$](?:[^$\n]*?[^$\s])?\$(?!\d))/g;

const TECH_TOKEN_RE =
  /((?<![a-zA-Z0-9_/-])(?:(?:\.\.\/)+|\/|(?:bin|sbin|etc|var|usr|opt|srv|tmp|root|home|proc|sys|dev|roles|inventory|group_vars|host_vars)\/)(?:[a-zA-Z0-9_.*-]+|<[^>\s]{1,18}>)(?:\/(?:[a-zA-Z0-9_.*-]+|<[^>\s]{1,18}>))*|\b(?:fuser|ssh|scp|systemctl|journalctl|etcdctl|patronictl|psql|redis-cli|parted|wipefs|mkfs(?:\.[a-z0-9]+)?|ansible-playbook|ansible-inventory)(?:\s+-[a-zA-Z0-9-]+)+(?:\s+[a-zA-Z0-9_./:@-]+)*|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5}|\/\d{1,2})?\b|\b[a-zA-Z_][a-zA-Z0-9_.-]*=[a-zA-Z0-9_./:<>,+-]+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-zA-Z0-9_-]+\.(?:ya?ml|json|toml|conf|cfg|ini|service|sh|py|sql|md|tar\.gz|rpm|deb|csv|xlsx)\b)/g;

function normalizeHeadingCompare(s: string): string {
  return s
    .trim()
    .replace(/^[#\s]+|[#\s]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isBareCommandLine(raw: string): boolean {
  const t = raw.trim();
  if (!t || t.length > 220) return false;
  if (/^(?:[-*+]|\d+[.)]|#{1,6}\s|>|\||```|~~~)/.test(t)) return false;
  if (/[。；！？]/.test(t)) return false;
  const cjk = t.match(/[\u4e00-\u9fff]/g);
  if (cjk && cjk.length > 4) return false;
  return BARE_CMD_RE.test(t);
}

function enrichPlainSegment(seg: string): string {
  // Highlight workflow / menu sequences inside 「A → B → C」
  let s = seg.replace(/「([^」\n]+(?:\s*→\s*[^」\n]+)+)」/g, (_m, inner: string) => {
    const steps = inner
      .split(/\s*→\s*/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => `**${x}**`);
    return `「${steps.join(" → ")}」`;
  });
  s = s.replace(TECH_TOKEN_RE, (m) => `\`${m}\``);
  return s;
}

function enrichProseLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  if (/^\s*(?:#{1,6}\s|```|~~~|\|)/.test(line)) return line;

  // Preserve leading list marker or blockquote marker before checking lead labels
  let prefix = "";
  let rest = line;
  const listMatch = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(line);
  const quoteMatch = !listMatch ? /^(\s*>\s?)(.*)$/.exec(line) : null;
  if (listMatch) {
    prefix = listMatch[1];
    rest = listMatch[2];
  } else if (quoteMatch) {
    prefix = quoteMatch[1];
    rest = quoteMatch[2];
  }

  // Highlight scenario / rule lead label: e.g. "已有 root SSH：使用现场配置..."
  let lead = "";
  const leadMatch = /^([^\s`*#\[：:][^`*\n：:]{1,18})：(\S.+)$/.exec(rest.trim());
  if (leadMatch && !/[，。；！？、]/.test(leadMatch[1])) {
    const lbl = leadMatch[1].trim();
    const parts = lbl.split(PRESERVED_INLINE_RE);
    const enrichedLbl = parts
      .map((p, idx) => (idx % 2 === 0 ? enrichPlainSegment(p) : p))
      .join("");
    lead = `**${enrichedLbl}：**`;
    rest = leadMatch[2];
  }

  const parts = rest.split(PRESERVED_INLINE_RE);
  const enrichedRest = parts
    .map((p, idx) => (idx % 2 === 0 ? enrichPlainSegment(p) : p))
    .join("");

  return `${prefix}${lead}${enrichedRest}`;
}

export function preprocessManualMarkdown(src: string, docTitle?: string): string {
  if (!src) return "";
  let lines = src.replace(/\r\n/g, "\n").split("\n");

  // 1. Strip optional YAML frontmatter if present
  if (lines[0]?.trim() === "---") {
    const endIdx = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
    if (endIdx > 0 && endIdx <= 15) {
      lines = lines.slice(endIdx + 1);
    }
  }

  // 2. Strip duplicate leading H1 if it repeats or abbreviates docTitle
  if (docTitle) {
    const firstNonEmpty = lines.findIndex((l) => l.trim() !== "");
    if (firstNonEmpty >= 0) {
      const m = /^#\s+(.+)$/.exec(lines[firstNonEmpty].trim());
      if (m) {
        const h1 = normalizeHeadingCompare(m[1]);
        const dt = normalizeHeadingCompare(docTitle);
        if (
          h1 === dt ||
          (h1.length >= 3 && dt.length >= 3 && (dt.includes(h1) || h1.includes(dt)))
        ) {
          lines.splice(firstNonEmpty, 1);
        }
      }
    }
  }

  // 3. Auto-fence bare shell command blocks & enrich prose lines outside existing code fences
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^\s*(```|~~~)/.exec(l);
    if (fence) {
      const marker = fence[1];
      out.push(l);
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        out.push(lines[i++]);
      }
      if (i < lines.length) out.push(lines[i++]);
      continue;
    }

    if (isBareCommandLine(l)) {
      let j = i + 1;
      while (j < lines.length && isBareCommandLine(lines[j])) j++;
      const prevLine = out.length > 0 ? out[out.length - 1].trim() : "";
      const afterColon = /[：:]$/.test(prevLine);
      if (j - i >= 2 || afterColon) {
        if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
        out.push("```bash");
        for (let k = i; k < j; k++) out.push(lines[k].trim());
        out.push("```");
        out.push("");
        i = j;
        continue;
      }
    }

    const enriched = enrichProseLine(l);
    out.push(enriched);

    // Separate dense single-newline operational rules (complete Chinese clauses ending in 。)
    const curTrim = l.trim();
    const nextRaw = lines[i + 1];
    if (
      nextRaw !== undefined &&
      curTrim !== "" &&
      nextRaw.trim() !== "" &&
      !/^\s*(?:[-*+]|\d+[.)]|#{1,6}\s|>|\||```|~~~)/.test(l) &&
      !/^\s*(?:[-*+]|\d+[.)]|#{1,6}\s|>|\||```|~~~)/.test(nextRaw) &&
      !isBareCommandLine(nextRaw) &&
      (/[。]$/.test(curTrim) || /^([^\s`*#\[：:][^`*\n：:]{1,18})：\S/.test(nextRaw.trim()))
    ) {
      out.push("");
    }
    i++;
  }

  return out.join("\n").trim();
}

function classifySectionTone(title: string): {
  tone: DocSectionTone;
  badge?: string;
} {
  const t = title.trim();
  if (/^(现象|症状|故障现象|报错|异常表现|问题概述)/.test(t))
    return { tone: "warn", badge: "现象" };
  if (/^(证据|日志|现场证据|排查证据|核查依据|采集结果)/.test(t))
    return { tone: "info", badge: "证据" };
  if (/^(原因|根因|根本原因|原因分析)/.test(t))
    return { tone: "cause", badge: "根因" };
  if (/^(处理|修复|解决方案|处置步骤|恢复步骤|处置与验证)/.test(t))
    return { tone: "ok", badge: "处置" };
  if (/^(待跟进|红线|禁忌|高危|风险提示|安全约束)/.test(t))
    return { tone: "danger", badge: "注意" };
  return { tone: "neutral" };
}

export function extractDocSections(
  rawText: string,
  docTitle?: string,
  idPrefix = "sdoc",
): { intro: string; sections: DocSection[]; normalized: string } {
  const normalized = preprocessManualMarkdown(rawText, docTitle);
  if (!normalized) return { intro: "", sections: [], normalized: "" };

  const lines = normalized.split("\n");
  // Determine primary split heading level (prefer H2; fallback to H1 or H3 if no H2 outside fences)
  let inFence = "";
  const levels = new Set<number>();
  for (const l of lines) {
    const f = /^\s*(```|~~~)/.exec(l);
    if (f) {
      inFence = inFence ? (l.trim().startsWith(inFence) ? "" : inFence) : f[1];
      continue;
    }
    if (inFence) continue;
    const hm = /^(#{1,3})\s+(.+)$/.exec(l);
    if (hm) levels.add(hm[1].length);
  }
  const splitLevel = levels.has(2) ? 2 : levels.has(1) ? 1 : levels.has(3) ? 3 : 0;
  if (!splitLevel) {
    return { intro: normalized, sections: [], normalized };
  }

  const introLines: string[] = [];
  const sections: DocSection[] = [];
  let curTitle = "";
  let curBody: string[] = [];
  inFence = "";

  const flush = () => {
    if (!curTitle) return;
    const idx = sections.length + 1;
    const { tone, badge } = classifySectionTone(curTitle);
    sections.push({
      id: `${idPrefix}-sec-${idx}`,
      index: idx,
      title: curTitle,
      level: splitLevel,
      tone,
      badge,
      body: curBody.join("\n").trim(),
    });
  };

  for (const l of lines) {
    const f = /^\s*(```|~~~)/.exec(l);
    if (f) {
      inFence = inFence ? (l.trim().startsWith(inFence) ? "" : inFence) : f[1];
      if (curTitle) curBody.push(l);
      else introLines.push(l);
      continue;
    }
    if (!inFence) {
      const hm = /^(#{1,3})\s+(.+)$/.exec(l);
      if (hm && hm[1].length === splitLevel) {
        flush();
        curTitle = hm[2].replace(/\s*#+\s*$/, "").trim();
        curBody = [];
        continue;
      }
    }
    if (curTitle) curBody.push(l);
    else introLines.push(l);
  }
  flush();

  let intro = introLines.join("\n").trim();
  // When a document already has ## sections, a lone leading # title with no prose is redundant with the page header.
  if (
    splitLevel === 2 &&
    sections.length > 0 &&
    intro &&
    /^#{1,3}\s+[^\n]+(?:\n+#{1,3}\s+[^\n]+)*$/.test(intro)
  ) {
    intro = "";
  }

  return {
    intro,
    sections,
    normalized,
  };
}

export function StructuredDoc({
  text,
  docTitle,
  idPrefix = "sdoc",
  className = "",
}: {
  text: string;
  docTitle?: string;
  idPrefix?: string;
  className?: string;
}) {
  const parsed = useMemo(
    () => extractDocSections(text, docTitle, idPrefix),
    [text, docTitle, idPrefix],
  );

  if (!parsed.normalized) {
    return <div className="rp-sdoc-empty">（暂无内容）</div>;
  }

  if (parsed.sections.length === 0) {
    return (
      <div className={`rp-sdoc ${className}`.trim()}>
        <div className="rp-sdoc-card">
          <Markdown text={parsed.normalized} className="rp-md rp-sdoc-md" />
        </div>
      </div>
    );
  }

  return (
    <div className={`rp-sdoc ${className}`.trim()}>
      {parsed.intro && (
        <section className="rp-sdoc-sec rp-sdoc-intro" aria-label="导读">
          <header className="rp-sdoc-sec-h">
            <span className="rp-sdoc-num tone-intro" aria-hidden>
              <svg viewBox="0 0 16 16" fill="none">
                <rect
                  x="2.25"
                  y="2.25"
                  width="11.5"
                  height="11.5"
                  rx="2.6"
                  stroke="currentColor"
                  strokeWidth="1.45"
                />
                <path
                  d="M5.25 6.25h5.5M5.25 9.25h3.75"
                  stroke="currentColor"
                  strokeWidth="1.45"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <h2>导读</h2>
          </header>
          <div className="rp-sdoc-sec-b">
            <Markdown text={parsed.intro} className="rp-md rp-sdoc-md" />
          </div>
        </section>
      )}
      {parsed.sections.map((sec) => (
        <section
          key={sec.id}
          id={sec.id}
          className={`rp-sdoc-sec tone-${sec.tone}`}
        >
          <header className="rp-sdoc-sec-h">
            <span className={`rp-sdoc-num tone-${sec.tone}`}>
              {sec.badge || String(sec.index).padStart(2, "0")}
            </span>
            <h2>{sec.title}</h2>
          </header>
          <div className="rp-sdoc-sec-b">
            {sec.body ? (
              <Markdown text={sec.body} className="rp-md rp-sdoc-md" />
            ) : (
              <p className="rp-sdoc-muted">（本节无补充正文）</p>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

export function DocToc({
  sections,
  title = "章节目录",
}: {
  sections: DocSection[];
  title?: string;
}) {
  if (sections.length < 2) return null;
  return (
    <nav className="rp-toc" aria-label={title}>
      <div className="rp-toc-title">
        <span>{title}</span>
        <em>{sections.length} 节</em>
      </div>
      <ol className="rp-toc-list">
        {sections.map((sec) => (
          <li key={sec.id}>
            <a
              href={`#${sec.id}`}
              onClick={(e) => {
                e.preventDefault();
                document
                  .getElementById(sec.id)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              <span className={`rp-toc-idx tone-${sec.tone}`}>
                {String(sec.index).padStart(2, "0")}
              </span>
              <span className="rp-toc-txt">{sec.title}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

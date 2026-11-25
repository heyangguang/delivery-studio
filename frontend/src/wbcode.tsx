import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { search } from "@codemirror/search";
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
  indentUnit,
} from "@codemirror/language";
import { setDiagnostics, lintGutter, type Diagnostic } from "@codemirror/lint";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { python } from "@codemirror/lang-python";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { jinja2 } from "@codemirror/legacy-modes/mode/jinja2";
import { tags as t } from "@lezer/highlight";
import { parseDocument } from "yaml";
import type { Problem } from "./wbdoc";
import { getLang, useLang } from "./i18n";
import type { Lang as UILang } from "./i18n";

/* One editor for every file of a component. Colours come from the app's CSS variables, so light and dark follow the
   rest of the page; problems are shown as markers on the line they belong to. */

const highlight = HighlightStyle.define([
  {
    tag: [t.comment, t.lineComment],
    color: "var(--faint)",
    fontStyle: "italic",
  },
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword],
    color: "var(--brand-ink)",
  },
  { tag: [t.string, t.special(t.string)], color: "var(--ok)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--warn)" },
  {
    tag: [t.propertyName, t.definition(t.propertyName), t.labelName],
    color: "var(--ink)",
    fontWeight: "600",
  },
  { tag: [t.meta, t.processingInstruction, t.tagName], color: "var(--brand)" },
  {
    tag: [t.variableName, t.definition(t.variableName)],
    color: "var(--ink-2)",
  },
  { tag: [t.punctuation, t.separator, t.bracket], color: "var(--mute)" },
  { tag: t.invalid, color: "var(--bad)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12.5px",
    background: "var(--surface)",
    color: "var(--ink)",
  },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--brand)", padding: "10px 0" },
  ".cm-gutters": {
    background: "var(--surface-2)",
    color: "var(--faint)",
    border: "none",
    borderRight: "1px solid var(--line)",
  },
  ".cm-activeLine": { background: "var(--hover)" },
  ".cm-activeLineGutter": { background: "var(--hover)", color: "var(--ink-2)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--brand)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection":
    { background: "var(--brand-soft) !important" },
  ".cm-tooltip": {
    background: "var(--surface)",
    border: "1px solid var(--line-strong)",
    borderRadius: "8px",
    boxShadow: "var(--shadow-md)",
    color: "var(--ink)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    background: "var(--brand-soft)",
    color: "var(--ink)",
  },
  ".cm-panels": {
    background: "var(--surface)",
    color: "var(--ink)",
    borderColor: "var(--line)",
  },
  ".cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-search": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px 8px",
    padding: "8px 36px 8px 12px",
    fontFamily: "inherit",
    fontSize: "12.5px",
  },
  ".cm-search br": { display: "none" },
  ".cm-search .cm-textfield": {
    height: "28px",
    minWidth: "180px",
    margin: "0",
    padding: "0 10px",
    border: "1px solid var(--line-strong)",
    borderRadius: "6px",
    background: "var(--surface)",
    color: "var(--ink)",
    fontSize: "12.5px",
    outline: "none",
  },
  ".cm-search .cm-textfield:focus": {
    borderColor: "var(--brand)",
    boxShadow: "var(--ring)",
  },
  ".cm-search .cm-button": {
    height: "28px",
    margin: "0",
    padding: "0 10px",
    border: "1px solid var(--line)",
    borderRadius: "6px",
    background: "var(--surface-2)",
    backgroundImage: "none",
    color: "var(--ink-2)",
    fontSize: "12px",
    cursor: "pointer",
  },
  ".cm-search .cm-button:hover": { background: "var(--hover)" },
  ".cm-search label": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    color: "var(--mute)",
    fontSize: "12px",
  },
  ".cm-search button[name=close]": {
    position: "absolute",
    top: "10px",
    right: "10px",
    width: "22px",
    height: "22px",
    border: "0",
    borderRadius: "6px",
    background: "transparent",
    color: "var(--mute)",
    fontSize: "16px",
    cursor: "pointer",
  },
  ".cm-searchMatch": {
    background: "color-mix(in srgb, var(--warn) 28%, transparent)",
    borderRadius: "2px",
  },
  ".cm-searchMatch-selected": {
    background: "color-mix(in srgb, var(--brand) 35%, transparent)",
  },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--bad)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warn)" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--bad)",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--warn)",
    textUnderlineOffset: "3px",
  },
});

export type Lang =
  "yaml" | "manifest" | "template" | "python" | "shell" | "text";
const langFor = (l: Lang) => {
  switch (l) {
    case "yaml":
    case "manifest":
      return yamlLang();
    case "template":
      return StreamLanguage.define(jinja2);
    case "python":
      return python();
    case "shell":
      return StreamLanguage.define(shell);
    default:
      return [];
  }
};

/** Syntax errors of a YAML text, located, for files that have no server-side check of their own. */
function yamlSyntax(text: string): Diagnostic[] {
  const doc = parseDocument(text);
  return doc.errors.map((e) => ({
    from: Math.min(e.pos[0], text.length),
    to: Math.min(Math.max(e.pos[1], e.pos[0] + 1), text.length),
    severity: "error" as const,
    message: e.message.split("\n")[0],
  }));
}

const cmPhrases = (l: UILang) =>
  l === "en-US"
    ? {
        Find: "Find",
        Replace: "Replace",
        next: "next",
        previous: "previous",
        all: "all",
        "match case": "match case",
        regexp: "regexp",
        "by word": "by word",
        replace: "replace",
        "replace all": "replace all",
        close: "close",
        "current match": "current match",
        "on line": "on line",
        "Go to line": "Go to line",
        go: "go",
      }
    : {
        Find: "查找",
        Replace: "替换",
        next: "下一个",
        previous: "上一个",
        all: "全部",
        "match case": "区分大小写",
        regexp: "正则",
        "by word": "全词",
        replace: "替换",
        "replace all": "全部替换",
        close: "关闭",
        "current match": "当前",
        "on line": "第",
        "Go to line": "跳到行",
        go: "跳转",
      };

export function CodeEditor({
  value,
  lang,
  onChange,
  problems = [],
  readOnly,
  onSave,
  jumpTo,
  label,
}: {
  value: string;
  lang: Lang;
  onChange?: (v: string) => void;
  problems?: Problem[];
  readOnly?: boolean;
  onSave?: () => void;
  jumpTo?: { line: number; n: number };
  label: string;
}) {
  const uiLang = useLang();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };
  const lint = useRef<Problem[]>([]);
  lint.current = problems;
  const ro = useRef(new Compartment());
  const uiComp = useRef(new Compartment());

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          search({ top: true }),
          theme,
          syntaxHighlighting(highlight),
          langFor(lang),
          lintGutter(),
          indentUnit.of("  "),
          uiComp.current.of([
            EditorState.phrases.of(cmPhrases(getLang())),
            EditorView.contentAttributes.of({ "aria-label": label }),
          ]),
          keymap.of([
            indentWithTab,
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                cb.current.onSave?.();
                return true;
              },
            },
          ]),
          ro.current.of([
            EditorState.readOnly.of(!!readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // the editor is created once per file (the parent keys it by path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: uiComp.current.reconfigure([
        EditorState.phrases.of(cmPhrases(uiLang)),
        EditorView.contentAttributes.of({ "aria-label": label }),
      ]),
    });
  }, [uiLang, label]);

  useEffect(() => {
    view.current?.dispatch({
      effects: ro.current.reconfigure([
        EditorState.readOnly.of(!!readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  // An outside change (a form edit, a restore) replaces the text; an edit made here comes back as the same text.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value)
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
      });
  }, [value]);

  const lintFirstRun = useRef(true);
  useEffect(() => {
    const run = () => {
      const v = view.current;
      if (!v) return;
      const doc = v.state.doc;
      const diags: Diagnostic[] = [];
      for (const p of problems) {
        if (!p.line || p.line < 1 || p.line > doc.lines) continue;
        const l = doc.line(p.line);
        diags.push({
          from: l.from,
          to: Math.max(l.to, l.from + 1 > doc.length ? l.from : l.from + 1),
          severity: p.severity,
          message: p.message,
        });
      }
      if (lang === "yaml" || lang === "manifest") {
        for (const d of yamlSyntax(doc.toString())) diags.push(d);
      }
      v.dispatch(setDiagnostics(v.state, diags));
    };
    if (lintFirstRun.current) {
      lintFirstRun.current = false;
      run();
      return;
    }
    const timer = window.setTimeout(run, lang === "yaml" || lang === "manifest" ? 120 : 0);
    return () => window.clearTimeout(timer);
  }, [problems, value, lang]);

  useEffect(() => {
    const v = view.current;
    if (!v || !jumpTo || jumpTo.line < 1 || jumpTo.line > v.state.doc.lines)
      return;
    const l = v.state.doc.line(jumpTo.line);
    v.dispatch({
      selection: { anchor: l.from },
      effects: EditorView.scrollIntoView(l.from, { y: "center" }),
    });
    v.focus();
  }, [jumpTo?.line, jumpTo?.n]);

  return <div className="wb-cm" ref={host} />;
}

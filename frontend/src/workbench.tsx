import { CrossCheck } from "./crosscheck";
import { PlatformParameters } from "./platformparams";
import { CONTRACT_FILE } from "./hostcontract";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Button,
  Checkbox,
  Drawer,
  Dropdown,
  Input,
  Menu,
  Message,
  Modal,
  Skeleton,
  Spin,
} from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconBulb,
  IconCheckCircle,
  IconCloseCircle,
  IconExclamationCircle,
  IconDelete,
  IconDownload,
  IconHistory,
  IconMore,
  IconThunderbolt,
  IconUpload,
} from "@arco-design/web-react/icon";
import {
  can,
  ago,
  api,
  cached,
  err,
  fetchCached,
  size,
  useAIStatus,
} from "./shared";
import { AIDock, Spark, useAIDock } from "./aichat";
import type { ApiError, Session } from "./shared";
import { go } from "./router";
import { Segmented } from "./ui";
import {
  Wb,
  change,
  addItem,
  moveItem,
  parseManifest,
  removeItem,
  setValue,
} from "./wbdoc";
import type { Doc, Ops, Problem, WbCtx } from "./wbdoc";
import { expandFiles, editManifestFiles } from "./wbfragments";
import { CodeEditor } from "./wbcode";
import {
  EndpointsTab,
  OverviewTab,
  SchemesTab,
  ParamsTab,
  RelationsTab,
  VersionsTab,
} from "./wbsections";
import { StepsTab, TestsTab } from "./wbsteps";
import { FilesTab } from "./wbfiles";
import { Diff, PreviewDrawer, ProblemList } from "./wbpreview";
import { ForkModal } from "./wbdialogs";
import { AIStage, diffDrafts } from "./wbai";
import type { AIChange } from "./wbai";
import type { Check } from "./wbpreview";
import { flushSync } from "react-dom";
import { bi, useLang, withLang } from "./i18n";
import "./workbench.css";

/* The component workbench: edit a draft of a component with forms, files and source, check it, trial-generate it,
   and publish it as a new revision. Nothing here affects deliveries until a draft is published. */

type Workspace = {
  name: string;
  exists: boolean;
  source: "builtin" | "custom" | "override" | "none";
  builtin: boolean;
  rev: number;
  draft: {
    exists: boolean;
    meta?: { source: string; base_rev: number; updated: string; user: string };
    added: string[];
    removed: string[];
    changed: string[];
    stale: boolean;
  };
  revisions: Rev[];
  ansible: { ready: boolean; version?: string; reason?: string };
};
type Rev = {
  rev: number;
  time: string;
  user: string;
  note?: string;
  files: number;
  added: number;
  removed: number;
  changed: number;
};
type DraftFile = {
  path: string;
  kind: string;
  size: number;
  text?: string;
  binary?: boolean;
};
type DraftResp = {
  meta: { updated: string; user: string; source: string; base_rev: number };
  files: DraftFile[];
};

const TAB_IDS = [
  "overview",
  "schemes",
  "versions",
  "params",
  "relations",
  "endpoints",
  "steps",
  "tests",
  "files",
  "source",
] as const;
type Tab = (typeof TAB_IDS)[number];
const tabLabel = (id: string): string => {
  switch (id) {
    case "overview":
      return bi("概览", "Overview");
    case "schemes":
      return bi("部署方案", "Schemes");
    case "versions":
      return bi("版本", "Versions");
    case "params":
      return bi("参数", "Parameters");
    case "relations":
      return bi("角色与关系", "Roles & Relations");
    case "endpoints":
      return bi("入口与密钥", "Endpoints & Secrets");
    case "steps":
      return bi("部署步骤", "Deploy Steps");
    case "tests":
      return bi("测试与清理", "Tests & Cleanup");
    case "files":
      return bi("文件", "Files");
    case "source":
      return bi("源码", "Source");
    default:
      return id;
  }
};

/** Which tab a problem on component.yaml belongs to, from its path ("versions[3.5].params[x].default" → params). */
function tabOfPath(path = ""): Tab {
  if (path.startsWith("detail.presets")) return "schemes";
  const p = path.replace(/^versions\[[^\]]*\]\.?/, "");
  if (/^versions/.test(path) && !p) return "versions";
  const head = p.split(/[.[]/)[0];
  switch (head) {
    case "packages":
    case "artifacts":
    case "versions":
    case "extends":
    case "status":
    case "platforms":
    case "remove":
      return "versions";
    case "params":
    case "groups":
    case "rules":
    case "ports":
      return "params";
    case "roles":
    case "flows":
    case "requires":
    case "addons":
      return "relations";
    case "endpoints":
    case "secrets":
    case "inputs":
    case "lb":
      return "endpoints";
    case "lifecycle":
    case "shared_files":
      return "steps";
    case "tests":
    case "cleanup":
      return "tests";
    default:
      return "overview";
  }
}

const defaultPlatforms = () => [
  { id: "ubuntu-24.04-amd64", title: "Ubuntu 24.04" },
  { id: "el9-amd64", title: bi("Red Hat 系 9", "RHEL 9 family") },
];

/** Arriving from a delivery's suggestion: the assistant window opens with the question already written, for the person to
 *  read and send. */
function WbPrefill({ name, title }: { name: string; title: string }) {
  useLang();
  const dock = useAIDock();
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem("mh-wb-prefill");
    } catch {
      return;
    }
    if (!raw || !dock) return;
    try {
      const v = JSON.parse(raw) as { name: string; text: string };
      if (v.name !== name) return;
      sessionStorage.removeItem("mh-wb-prefill");
      dock.open({
        key: "comp",
        title,
        context: bi("组件工作台", "Component Workbench"),
        prefill: v.text,
      });
    } catch {
      sessionStorage.removeItem("mh-wb-prefill");
    }
  }, [dock, name, title]);
  return null;
}

export function WorkbenchPage({
  me,
  name,
  tab: tabParam,
}: {
  me: Session;
  name: string;
  tab?: string;
}) {
  const lang = useLang();
  const admin = can("component.edit");
  const tab: Tab =
    name === "platform-shared"
      ? tabParam === "params"
        ? "params"
        : "files"
      : TAB_IDS.includes(tabParam as Tab)
        ? (tabParam as Tab)
        : "overview";
  // what the assistant just wrote into the draft: walked through tab by tab, marked until the person confirms
  const [aiRun, setAiRun] = useState<{
    before: Record<string, string>;
    after: Record<string, string>;
    changes: AIChange[];
  } | null>(null);
  const [aiPlaying, setAiPlaying] = useState(false);
  // while the assistant's change is shown: the part on screen, the parts walked through, and whether every tab is shown
  const [aiNow, setAiNow] = useState("");
  const [aiShown, setAiShown] = useState<Set<string>>(new Set());
  const [aiAllTabs, setAiAllTabs] = useState(false);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [wsError, setWsError] = useState("");
  const [files, setFiles] = useState<Record<string, string>>({});
  const [binaries, setBinaries] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [save, setSave] = useState<
    "saved" | "dirty" | "saving" | "error" | "conflict"
  >("saved");
  const [savedAt, setSavedAt] = useState(Date.now());
  const [check, setCheck] = useState<Check | null>(null);
  const [checkStale, setCheckStale] = useState(false);
  const checkRevision = useRef(0);
  const [active, setActive] = useState(
    name === "platform-shared"
      ? "roles/mw_preflight/tasks/main.yml"
      : "component.yaml",
  );
  const [jump, setJump] = useState<
    { file: string; line: number; n: number } | undefined
  >();
  const [panel, setPanel] = useState<"" | "problems" | "preview" | "revisions">(
    "",
  );
  const [publishing, setPublishing] = useState(false);
  const [apiPlatforms, setApiPlatforms] = useState<
    { id: string; title: string }[] | null
  >(null);
  const platforms = apiPlatforms ?? defaultPlatforms();

  const filesRef = useRef(files);
  filesRef.current = files;
  const pending = useRef<Record<string, string | null>>({});
  const updated = useRef("");
  const timer = useRef<number | undefined>(undefined);
  const checkTimer = useRef<number | undefined>(undefined);
  const inflight = useRef<Promise<void>>(Promise.resolve());
  const leaveEditor = useRef<() => Promise<void>>(async () => {});
  const editorEpoch = useRef(0);

  const reloadWs = useCallback(async () => {
    try {
      const w = await api<Workspace>(`/api/components/${name}/workspace`);
      setWs(w);
      setWsError("");
      return w;
    } catch (e) {
      setWsError((e as Error).message);
      return null;
    }
  }, [name]);

  const loadDraft = useCallback(async () => {
    const d = await api<DraftResp>(`/api/components/${name}/draft`);
    const m: Record<string, string> = {};
    const bin: string[] = [];
    d.files.forEach((f) =>
      f.binary ? bin.push(f.path) : (m[f.path] = f.text || ""),
    );
    pending.current = {};
    updated.current = d.meta.updated;
    setFiles(m);
    setBinaries(bin);
    setLoaded(true);
    setSave("saved");
    return m;
  }, [name]);

  const runCheck = useCallback(async () => {
    const revision=++checkRevision.current;
    try {
      const c = await api<Check>(`/api/components/${name}/draft/check`, {
        method: "POST",
        body: "{}",
      });
      if(revision!==checkRevision.current)return;
      setCheck(c);
      setCheckStale(false);
    } catch (e) {
      err(e);
    }
  }, [name]);

  useEffect(() => {
    setWs(null);
    setLoaded(false);
    setCheck(null);
    reloadWs().then((w) => {
      if (w?.draft.exists) loadDraft().then(runCheck).catch(err);
    });
    fetchCached<{ platforms: { id: string; title: string }[] }>("/api/library")
      .then(
        (r) =>
          r.platforms?.length &&
          setApiPlatforms(r.platforms.map((p) => ({ id: p.id, title: p.title }))),
      )
      .catch(() => undefined);
    return () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(checkTimer.current);
    };
  }, [name, reloadWs, loadDraft, runCheck]);

  const prevLang = useRef(lang);
  useEffect(() => {
    if (prevLang.current === lang) return;
    prevLang.current = lang;
    void reloadWs();
    if (loaded) void runCheck();
    fetchCached<{ platforms: { id: string; title: string }[] }>("/api/library")
      .then(
        (r) =>
          r.platforms?.length &&
          setApiPlatforms(r.platforms.map((p) => ({ id: p.id, title: p.title }))),
      )
      .catch(() => undefined);
  }, [lang, loaded, reloadWs, runCheck]);

  /* ---- saving ---- */
  const saveNow = useCallback((): Promise<void> => {
    window.clearTimeout(timer.current);
    const run = async () => {
      const sent = pending.current;
      if (!Object.keys(sent).length) return;
      pending.current = {};
      setSave("saving");
      try {
        const r = await api<{ meta: { updated: string } }>(
          `/api/components/${name}/draft`,
          {
            method: "PUT",
            body: JSON.stringify({ files: sent, if_updated: updated.current }),
          },
        );
        updated.current = r.meta.updated;
        setSavedAt(Date.now());
        setSave(Object.keys(pending.current).length ? "dirty" : "saved");
        setCheckStale(true);
        window.clearTimeout(checkTimer.current);
        checkTimer.current = window.setTimeout(() => {
          runCheck();
          reloadWs();
        }, 500);
      } catch (e) {
        pending.current = { ...sent, ...pending.current };
        if ((e as ApiError).status === 409) setSave("conflict");
        else {
          setSave("error");
          err(e);
        }
      }
    };
    inflight.current = inflight.current.then(run);
    return inflight.current.then(() => {
      if (Object.keys(pending.current).length)
        throw new Error(
          bi("草稿尚未保存成功，请先重试保存再继续", "Draft not saved yet; retry saving before continuing"),
        );
    });
  }, [name, runCheck, reloadWs]);

  const touch = useCallback(
    (path: string, text: string | null) => {
      checkRevision.current++;
      setCheckStale(true);
      pending.current[path] = text;
      setSave("dirty");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        void saveNow().catch(() => {});
      }, 800);
    },
    [saveNow],
  );

  const editFile = useCallback(
    (path: string, text: string) => {
      filesRef.current = { ...filesRef.current, [path]: text };
      setCheckStale(true);
      setFiles((f) => ({ ...f, [path]: text }));
      touch(path, text);
    },
    [touch],
  );
  const createFile = useCallback(
    (path: string, text: string) => editFile(path, text),
    [editFile],
  );
  const removeFile = useCallback(
    (path: string) => {
      setFiles((f) => {
        const n = { ...f };
        delete n[path];
        return n;
      });
      setBinaries((b) => b.filter((x) => x !== path));
      touch(path, null);
      setActive("component.yaml");
    },
    [touch],
  );

  const renameFile = useCallback(
    (from: string, to: string) => {
      const text = filesRef.current[from];
      if (text === undefined) return;
      setFiles((f) => {
        const n = { ...f, [to]: text };
        delete n[from];
        return n;
      });
      touch(to, text);
      touch(from, null);
      setActive(to);
    },
    [touch],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void saveNow().catch(() => {});
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onLeave);
      // leaving the page saves what is still waiting
      if (Object.keys(pending.current).length) void saveNow().catch(() => {});
    };
  }, [saveNow]);

  /* ---- the manifest as a document ---- */
  const manifest = files["component.yaml"] ?? "";
  const parsed = useMemo(() => {
    try {
      const { doc } = expandFiles(files);
      return { js: doc.toJS() || {}, broken: "" };
    } catch (error) {
      return { js: {} as any, broken: String(error) };
    }
  }, [files, lang]);

  const ops: Ops = useMemo(() => {
    const apply = (fn: (d: Doc) => void) => {
      const changes = editManifestFiles(filesRef.current, fn);
      for (const [file, text] of Object.entries(changes)) editFile(file, text);
    };
    return {
      js: parsed.js,
      broken: parsed.broken,
      set: (path, value) => apply((d) => setValue(d, path, value)),
      add: (path, item, at) => apply((d) => addItem(d, path, item, at)),
      remove: (path, i) => apply((d) => removeItem(d, path, i)),
      move: (path, from, to) => apply((d) => moveItem(d, path, from, to)),
      batch: apply,
    };
  }, [parsed, editFile]);

  const js = parsed.js;
  const openProblem = useCallback(
    (
      file: string,
      line: number | undefined,
      mpath: string | undefined,
      source: boolean,
    ) => {
      setPanel("");
      if (file === "component.yaml" && mpath && !source)
        go({ name: "components", id: name, edit: tabOfPath(mpath) });
      else openFile(file, line);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name],
  );
  const openFile = useCallback(
    (path: string, line?: number) => {
      if (path === "component.yaml" && !line) {
        go({ name: "components", id: name, edit: "source" });
        return;
      }
      setActive(path);
      setJump({ file: path, line: line || 0, n: Date.now() });
      go({
        name: "components",
        id: name,
        edit: path === "component.yaml" ? "source" : "files",
      });
      setPanel("");
    },
    [name],
  );

  const tasks = useMemo(() => {
    const t: Record<string, string[]> = {};
    Object.keys(files).forEach((p) => {
      const m = p.match(/^roles\/([^/]+)\/tasks\/([^/]+)\.ya?ml$/);
      if (m) (t[m[1]] ||= []).push(m[2]);
    });
    Object.values(t).forEach((l) => l.sort());
    return t;
  }, [files]);

  const problems: Problem[] = check?.problems || [];
  const ignoreWarning = useCallback(
    async (p: Problem, undo?: boolean) => {
      try {
        const c = await api<Check>(`/api/components/${name}/draft/ignore`, {
          method: "POST",
          body: JSON.stringify({
            file: p.file || "",
            message: p.message,
            undo,
          }),
        });
        setCheck(c);
        Message.success(
          undo
            ? bi("已恢复这条提醒", "Warning restored")
            : bi("已忽略，以后不再提醒", "Ignored; won't warn again"),
        );
      } catch (e) {
        err(e);
      }
    },
    [name],
  );
  const ctx: WbCtx = useMemo(
    () => ({
      ops,
      files: Object.keys(files),
      problems,
      roles: ((js.roles || []) as { name: string }[])
        .map((r) => r.name)
        .filter(Boolean),
      groups: ((js.groups || []) as { id: string; label: string }[]).map(
        (g) => ({ id: g.id, label: g.label || g.id }),
      ),
      params: (
        (js.params || []) as { key: string; label: string; type: string }[]
      ).map((p) => ({ key: p.key, label: p.label, type: p.type })),
      versions: ((js.versions || []) as { id: string }[]).map((v) =>
        String(v.id),
      ),
      platforms,
      openFile,
      tasks,
      readOnly: !admin,
      ignoreWarning,
      aiMarks: aiRun?.changes
        .filter((c) => c.file === "component.yaml")
        .map((c) => c.path),
      aiFiles: aiRun?.changes
        .filter((c) => c.file !== "component.yaml")
        .map((c) => c.file),
    }),
    [
      ops,
      files,
      problems,
      js,
      platforms,
      openFile,
      tasks,
      admin,
      aiRun,
      ignoreWarning,
    ],
  );

  /* ---- the assistant's accepted change, shown the way the delivery form shows its fills ---- */
  // every change of view while the assistant's work is shown moves smoothly, as the delivery form does
  const smooth = useCallback((f: () => void) => {
    const d = document as unknown as {
      startViewTransition?: (cb: () => void) => { finished: Promise<void> };
    };
    if (
      !d.startViewTransition ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      f();
      return Promise.resolve();
    }
    return d
      .startViewTransition(() => flushSync(f))
      .finished.catch(() => undefined);
  }, []);
  const goTab = useCallback(
    (t: string) =>
      smooth(() =>
        go(
          { name: "components", id: name, edit: t },
          { replace: true, instant: true },
        ),
      ),
    [name, smooth],
  );
  const flashTab = useCallback(
    async (t: string, list: AIChange[], step: number) => {
      const reduce = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const wait = (ms: number) =>
        new Promise((r) => window.setTimeout(r, reduce ? 0 : ms));
      setAiNow(t);
      await goTab(t);
      await wait(260);
      for (const c of list.filter((x) => x.tab === t).slice(0, 10)) {
        let el: HTMLElement | null = null;
        if (c.file !== "component.yaml") {
          setActive(c.file);
          await wait(220);
          el = document.querySelector<HTMLElement>(".wb-editor");
        } else {
          let best = -1;
          document.querySelectorAll<HTMLElement>("[data-wb]").forEach((x) => {
            const k = x.dataset.wb || "";
            if (
              (c.path === k || c.path.startsWith(k + ".")) &&
              k.length > best
            ) {
              best = k.length;
              el = x;
            }
          });
        }
        if (!el) continue;
        const node = el as HTMLElement;
        node.scrollIntoView({
          block: "center",
          behavior: reduce ? "auto" : "smooth",
        });
        node.setAttribute("data-wb-flash", "");
        window.setTimeout(() => node.removeAttribute("data-wb-flash"), 1400);
        await wait(step);
      }
      setAiShown((x) => new Set(x).add(t));
    },
    [goTab],
  );
  const play = useCallback(
    async (changes: AIChange[]) => {
      setAiPlaying(true);
      setAiShown(new Set());
      try {
        for (const t of [...new Set(changes.map((c) => c.tab))])
          await flashTab(t, changes, Math.max(260, 620 - changes.length * 20));
      } finally {
        setAiNow("");
        setAiPlaying(false);
      }
    },
    [flashTab],
  );
  // what the assistant changed is kept on the server until confirmed, so a reload or a restart shows it again
  const loadReview = useCallback(
    async (after: Record<string, string>) => {
      const rv = await api<{ before?: Record<string, string | null> }>(
        `/api/components/${name}/ai/review`,
      );
      if (!rv.before || !Object.keys(rv.before).length) return null;
      const before = { ...after };
      for (const [p, t] of Object.entries(rv.before)) {
        if (t === null) delete before[p];
        else before[p] = t;
      }
      const changes = diffDrafts(before, after, (p) =>
        tabOfPath(
          p[0] === "versions" && p.length > 2
            ? p.slice(2).join(".")
            : p[0] === "versions"
              ? "versions"
              : p.join("."),
        ),
      );
      return changes.length ? { before, after, changes } : null;
    },
    [name],
  );
  const aiStatus = useAIStatus();
  const compAIOn =
    aiStatus.enabled && !!aiStatus.features?.component && can("ai.use");
  const reviewLoaded = useRef(false);
  useEffect(() => {
    if (!loaded || !compAIOn || reviewLoaded.current) return;
    reviewLoaded.current = true;
    loadReview(filesRef.current)
      .then((r) => {
        if (!r) return;
        setAiRun(r);
        setAiShown(new Set(r.changes.map((c) => c.tab)));
      })
      .catch(() => undefined);
  }, [loaded, compAIOn, loadReview]);
  useEffect(() => {
    const h = async (e: Event) => {
      const d = (e as CustomEvent<{ name: string }>).detail;
      if (d?.name !== name) return;
      try {
        const after = await loadDraft();
        const r = await loadReview(after);
        if (!r) return;
        // the conversation steps aside and the workbench becomes the view of what the assistant did
        window.dispatchEvent(new CustomEvent("mh-ai-dock", { detail: "min" }));
        await smooth(() => {
          setAiAllTabs(false);
          setAiRun(r);
        });
        await play(r.changes);
      } catch (e) {
        err(e);
      }
    };
    window.addEventListener("mh-ai-wrote", h);
    return () => window.removeEventListener("mh-ai-wrote", h);
  }, [name, loadDraft, loadReview, play, smooth]);
  const aiDisplayChanges = useMemo(
    () =>
      aiRun
        ? diffDrafts(aiRun.before, aiRun.after, (p) =>
            tabOfPath(
              p[0] === "versions" && p.length > 2
                ? p.slice(2).join(".")
                : p[0] === "versions"
                  ? "versions"
                  : p.join("."),
            ),
          )
        : [],
    [aiRun, lang],
  );
  const endReview = async () => {
    await api(`/api/components/${name}/ai/review`, { method: "DELETE" }).catch(
      () => undefined,
    );
    await smooth(() => setAiRun(null));
  };
  const undoAI = async () => {
    if (!aiRun) return;
    for (const f of new Set([
      ...Object.keys(aiRun.before),
      ...Object.keys(aiRun.after),
    ])) {
      if (aiRun.before[f] === aiRun.after[f]) continue;
      if (aiRun.before[f] === undefined) removeFile(f);
      else editFile(f, aiRun.before[f]);
    }
    await saveNow();
    await endReview();
    Message.info(
      bi("已撤销，草稿回到 AI 改动之前", "Undone; draft reverted to before AI changes"),
    );
  };

  leaveEditor.current = async () => {
    await saveNow();
    if (!updated.current) return;
    await api("/api/components/" + name + "/draft/leave", {
      method: "POST",
      body: JSON.stringify({ if_updated: updated.current }),
      keepalive: true,
    });
    window.dispatchEvent(new Event("mw-components-changed"));
  };
  useEffect(() => {
    const epoch = ++editorEpoch.current;
    return () => {
      const leave = leaveEditor.current;
      queueMicrotask(() => {
        if (editorEpoch.current === epoch) void leave().catch(err);
      });
    };
  }, [name]);
  const backFromEditor = async () => {
    try {
      await leaveEditor.current();
      go({
        name: "components",
        id: name === "platform-shared" ? undefined : name,
      });
    } catch (e) {
      err(e);
    }
  };
  const tabTitle = (t: string) => tabLabel(t);

  const perTab = useMemo(() => {
    const m: Record<string, { e: number; w: number }> = {};
    problems.forEach((p) => {
      const t =
        p.file === "component.yaml" || !p.file ? tabOfPath(p.path) : "files";
      m[t] ||= { e: 0, w: 0 };
      if (p.severity === "error") m[t].e++;
      else m[t].w++;
    });
    return m;
  }, [problems]);

  /* ---- draft actions ---- */
  const start = async (from: "live" | "builtin") => {
    try {
      await api(`/api/components/${name}/draft`, {
        method: "POST",
        body: JSON.stringify({ from }),
      });
      await reloadWs();
      await loadDraft();
      runCheck();
    } catch (e) {
      err(e);
    }
  };
  // arriving with something for the assistant to do (a suggestion from a delivery): go straight into editing — the
  // person's own draft when there is one, otherwise a new one from what is published — no choice to make first
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!ws || ws.draft.exists || autoStarted.current || !admin) return;
    let want = false;
    try {
      const raw = sessionStorage.getItem("mh-wb-prefill");
      want = !!raw && (JSON.parse(raw) as { name?: string }).name === name;
    } catch {
      want = false;
    }
    if (!want) return;
    autoStarted.current = true;
    start(ws.source === "builtin" ? "builtin" : "live");
  }, [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  const discard = () =>
    Modal.confirm({
      title: bi("放弃这份草稿？", "Discard this draft?"),
      content: bi(
        "草稿里没有发布的修改会全部丢失。已发布的内容不受影响。",
        "All unpublished edits in this draft will be lost. Published content is unaffected.",
      ),
      okText: bi("放弃草稿", "Discard Draft"),
      okButtonProps: { status: "danger" },
      onOk: async () => {
        try {
          pending.current = {};
          window.clearTimeout(timer.current);
          await api(`/api/components/${name}/draft`, { method: "DELETE" });
          Message.success(bi("已放弃草稿", "Draft discarded"));
          if (ws?.exists)
            go({ name: "components", id: name }, { replace: true });
          else go({ name: "components" }, { replace: true });
        } catch (e) {
          err(e);
        }
      },
    });

  const render = async (path: string, preset: string, host: string) => {
    await saveNow();
    return api<{ ok: boolean; text?: string; error?: string }>(
      `/api/components/${name}/draft/render`,
      {
        method: "POST",
        body: JSON.stringify({ template: path, preset, host }),
      },
    );
  };

  /* ---- render ---- */
  if (!admin)
    return (
      <Gate
        title={bi("只有管理员可以编辑组件", "Only administrators can edit components")}
        back={name}
      />
    );
  if (wsError && !ws)
    return (
      <Gate
        title={bi("找不到这个组件", "Component not found")}
        text={wsError}
        back=""
      />
    );
  if (!ws)
    return (
      <div className="wb">
        <div className="wb-load">
          <Skeleton animation text={{ rows: 6 }} />
        </div>
      </div>
    );

  if (!ws.draft.exists)
    return (
      <div className="wb enter">
        <StartPanel
          ws={ws}
          start={start}
          openRevisions={() => setPanel("revisions")}
        />
        <RevisionsDrawer
          name={name}
          ws={ws}
          open={panel === "revisions"}
          close={() => setPanel("")}
          hasDraft={false}
          onRestored={async () => {
            setPanel("");
            await reloadWs();
            await loadDraft();
            runCheck();
          }}
        />
      </div>
    );

  const errors = check?.errors ?? 0;
  const saveLabel = {
    saved: bi(
      `已保存 ${ago(new Date(savedAt).toISOString())}`,
      `Saved ${ago(new Date(savedAt).toISOString())}`,
    ),
    dirty: bi("有未保存的修改…", "Unsaved changes..."),
    saving: bi("保存中…", "Saving..."),
    error: bi("保存失败，点击重试", "Save failed; click to retry"),
    conflict: bi("草稿在别处被改过", "Draft modified elsewhere"),
  }[save];
  const body = !loaded ? (
    <div className="wb-load">
      <Skeleton animation text={{ rows: 6 }} />
    </div>
  ) : name === "platform-shared" && tab === "params" ? (
    <PlatformParameters
      text={files[CONTRACT_FILE] || ""}
      onSource={(line) => openFile(CONTRACT_FILE, line)}
      onChange={(text) => editFile(CONTRACT_FILE, text)}
    />
  ) : tab === "files" ? (
    <FilesTab
      files={files}
      binaries={binaries}
      active={
        files[active] === undefined && !binaries.includes(active)
          ? "component.yaml"
          : active
      }
      setActive={setActive}
      edit={editFile}
      create={createFile}
      remove={removeFile}
      rename={renameFile}
      jump={jump}
      readOnly={
        !admin ||
        (name === "platform-shared" &&
          (active === "component.yaml" ||
            active === "files/platform-contract.md"))
      }
      onSave={saveNow}
      render={render}
      ansibleReady={ws.ansible.ready}
      ansibleWhy={ws.ansible.reason || ""}
    />
  ) : tab === "source" ? (
    <div className="wb-source">
      {Object.keys(files).some((f) => f.startsWith("manifest/")) && (
        <div className="note" style={{ margin: "10px 16px" }}>
          {bi(
            "component.yaml 是组件入口。方案、公共定义和动作在独立文件中，点击文件即可编辑。",
            "component.yaml is the entry point. Schemes, shared definitions, and actions live in separate files—click any to edit.",
          )}
          <div>
            {Object.keys(files)
              .filter((f) => f.startsWith("manifest/"))
              .sort()
              .map((f) => (
                <Button
                  key={f}
                  type="text"
                  size="mini"
                  onClick={() => openFile(f)}
                >
                  {f.replace("manifest/", "")}
                </Button>
              ))}
          </div>
        </div>
      )}
      <div className="wb-editor-main">
        <CodeEditor
          label="component.yaml"
          value={manifest}
          lang="manifest"
          onChange={(v) => editFile("component.yaml", v)}
          problems={problems.filter((p) => p.file === "component.yaml")}
          onSave={saveNow}
          jumpTo={jump?.file === "component.yaml" ? jump : undefined}
        />
      </div>
    </div>
  ) : (
    <div className="wb-forms">
      {!parsed.broken && (
        <TabProblems
          tab={tab}
          problems={problems}
          onSource={(line) => openFile("component.yaml", line)}
        />
      )}
      {parsed.broken ? (
        <div className="note warn">
          {bi(
            `component.yaml 现在有语法错误，表单暂时不能用：${parsed.broken}。到`,
            `component.yaml has a syntax error, so forms are disabled: ${parsed.broken}. Fix it in the `,
          )}
          <button
            type="button"
            className="wb-link"
            onClick={() => go({ name: "components", id: name, edit: "source" })}
          >
            {bi("源码", "Source")}
          </button>
          {bi("页签修正。", " tab.")}
        </div>
      ) : tab === "overview" ? (
        <OverviewTab />
      ) : tab === "schemes" ? (
        <SchemesTab />
      ) : tab === "versions" ? (
        <VersionsTab />
      ) : tab === "params" ? (
        <ParamsTab />
      ) : tab === "relations" ? (
        <RelationsTab />
      ) : tab === "endpoints" ? (
        <EndpointsTab />
      ) : tab === "steps" ? (
        <StepsTab />
      ) : (
        <TestsTab />
      )}
    </div>
  );

  return (
    <Wb.Provider value={ctx}>
      <AIDock
        key={name}
        scope={{ kind: "comp", name, beforeSend: saveNow }}
        start={{
          key: "comp",
          title: js.title || name,
          context: bi("组件工作台", "Component Workbench"),
        }}
        onChanged={() => loadDraft().then(runCheck)}
      >
        <WbPrefill name={name} title={js.title || name} />
        <div
          className={`wb enter ${tab === "files" || tab === "source" ? "wb-fill" : ""} ${aiRun ? "ai-mode" : ""}`}
        >
          <header className="wb-head">
            <Button
              type="text"
              className="wb-back"
              icon={<IconArrowLeft />}
              onClick={backFromEditor}
            >
              {name}
            </Button>
            <div className="wb-title">
              <h1>
                {js.title || name}{" "}
                <span className="flag">
                  {ws.draft.meta?.source?.startsWith("template")
                    ? bi("新组件草稿", "New Component Draft")
                    : ws.exists
                      ? bi("编辑草稿", "Editing Draft")
                      : bi("未发布的新组件", "Unpublished Component")}
                </span>
              </h1>
              <button
                type="button"
                className={`wb-save ${save}`}
                onClick={() =>
                  save === "error" || save === "dirty" ? saveNow() : undefined
                }
                aria-live="polite"
              >
                <i /> {saveLabel}
              </button>
            </div>
            <div className="wb-actions">
              <Button
                type="text"
                icon={<IconHistory />}
                onClick={() => setPanel("revisions")}
              >
                {bi("修订", "Revisions")}
                {ws.rev ? ` ${ws.rev}` : ""}
              </Button>
              <Button
                type={errors ? "outline" : "text"}
                status={errors ? "danger" : undefined}
                icon={errors ? <IconCloseCircle /> : <IconCheckCircle />}
                onClick={() => setPanel("problems")}
              >
                {checkStale || save !== "saved"
                  ? bi("修改后待检查", "Edited · re-checking")
                  : check
                    ? errors
                      ? bi(`${errors} 处错误`, `${errors} error(s)`)
                      : check.warnings
                        ? bi(`${check.warnings} 个提醒`, `${check.warnings} warning(s)`)
                        : bi("检查通过", "Checks passed")
                    : bi("检查", "Check")}
              </Button>
              <Button
                icon={<IconThunderbolt />}
                onClick={() => setPanel("preview")}
              >
                {bi("试生成", "Trial Generate")}
              </Button>
              <CrossCheck name={name} flush={saveNow} />
              <AssistButton flush={saveNow} />
              <Button
                type="primary"
                onClick={() =>
                  saveNow()
                    .then(() => setPublishing(true))
                    .catch(err)
                }
              >
                {bi("发布…", "Publish...")}
              </Button>
              <Dropdown
                trigger="click"
                position="br"
                droplist={
                  <Menu>
                    <Menu.Item
                      key="pack"
                      onClick={() =>
                        saveNow().then(() =>
                          window.open(withLang(`/api/components/${name}/pack`)),
                        )
                      }
                      disabled={!ws.exists}
                    >
                      <IconDownload /> {bi("导出已发布的组件包", "Export Published Pack")}
                    </Menu.Item>
                    <Menu.Item key="discard" onClick={discard}>
                      <IconDelete /> {bi("放弃草稿", "Discard Draft")}
                    </Menu.Item>
                  </Menu>
                }
              >
                <Button type="text" icon={<IconMore />} aria-label={bi("更多", "More")} />
              </Dropdown>
            </div>
          </header>
          {save === "conflict" && (
            <div className="note warn wb-banner">
              {bi(
                "这份草稿在别处被保存过，你的修改没有写入，以免覆盖对方的内容。",
                "This draft was saved elsewhere; your edits were not written to avoid overwriting it.",
              )}
              <Button size="mini" onClick={() => loadDraft().then(runCheck)}>
                {bi("载入最新内容（丢弃这里未保存的修改）", "Load latest (discard local unsaved edits)")}
              </Button>
            </div>
          )}
          {ws.draft.stale && (
            <div className="note warn wb-banner">
              {bi(
                "已发布的内容在这份草稿开始之后又变过。现在发布会覆盖那次修改——先到「试生成」里对照，或在「修订」里看那次改了什么。",
                "The published version changed after this draft started. Publishing now will overwrite those changes—check Trial Generate or Revisions first.",
              )}
            </div>
          )}
          {compAIOn && aiRun && (
            <AIStage
              changes={aiDisplayChanges}
              tabTitle={tabTitle}
              playing={aiPlaying}
              current={aiNow || (aiPlaying ? "" : tab)}
              shown={aiShown}
              onTab={(t) => flashTab(t, aiDisplayChanges, 380)}
              onChat={() =>
                window.dispatchEvent(
                  new CustomEvent("mh-ai-dock", { detail: "open" }),
                )
              }
              onReplay={() => play(aiDisplayChanges)}
              onAll={() => smooth(() => setAiAllTabs((v) => !v))}
              onUndo={undoAI}
              onConfirm={async () => {
                await endReview();
                Message.success(bi("已确认 AI 的改动", "Confirmed AI changes"));
              }}
            />
          )}
          <div className="note" style={{ margin: "12px 24px" }}>
            {name === "platform-shared" ? (
              <>
                {bi(
                  "这里管理所有交付共享的预检、数据盘、离线源和密钥流程。修改先存草稿；发布后用于新生成与同步的交付，不会自动执行到集群。参数说明见 ",
                  "Manages shared preflight, data disk, offline repo, and secret flows across all deliveries. Edits save as draft; once published they apply to new/synced deliveries without altering running clusters. See ",
                )}
                <button
                  className="wb-link"
                  onClick={() => openFile("files/platform-contract.md")}
                >
                  {bi("平台参数契约", "Platform Parameter Contract")}
                </button>
                {bi("。", ".")}
              </>
            ) : (
              <>
                {bi(
                  "涉及预检、数据盘或离线源的问题，",
                  "For issues related to preflight, data disks, or offline repos, ",
                )}
                {aiStatus.enabled && !!aiStatus.features?.component && can("ai.use")
                  ? bi("可以让 AI 读取公共流程，或打开 ", "ask AI to inspect shared flows or open ")
                  : bi("可以打开 ", "open ")}
                <a href="#/components/platform-shared/edit/files" target="_blank" rel="noopener noreferrer">
                  {bi("平台公共流程", "Platform Shared Flows")}
                </a>{" "}
                {bi("单独编辑。", "to edit separately.")}
              </>
            )}
          </div>
          <nav
            className="wb-tabs"
            aria-label={bi("编辑内容", "Edit sections")}
            hidden={!!aiRun && !aiAllTabs}
          >
            {(name === "platform-shared"
              ? TAB_IDS.filter((id) => id === "files" || id === "params").map(
                  (id) =>
                    [
                      id,
                      id === "params" ? bi("参数与规则", "Parameters & Rules") : tabLabel(id),
                    ] as const,
                )
              : TAB_IDS.map((id) => [id, tabLabel(id)] as const)
            ).map(([id, label]) => (
              <a
                key={id}
                href={`#/components/${name}/edit/${id}`}
                className={`${tab === id ? "on" : ""} ${aiRun?.changes.some((c) => c.tab === id) ? "ai-wrote" : ""}`}
                aria-current={tab === id ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  go(
                    { name: "components", id: name, edit: id },
                    { replace: true, instant: true },
                  );
                }}
              >
                {label}
                {perTab[id]?.e ? (
                  <i className="wb-tabdot bad">{perTab[id].e}</i>
                ) : perTab[id]?.w ? (
                  <i className="wb-tabdot warn">{perTab[id].w}</i>
                ) : null}
              </a>
            ))}
          </nav>
          <div
            className={`wb-body ${tab === "files" || tab === "source" ? "wide" : ""} ${aiPlaying ? "ai-playing" : ""}`}
          >
            {body}
          </div>

          <Drawer
            width="min(560px, 100vw)"
            visible={panel === "problems"}
            onCancel={() => setPanel("")}
            footer={null}
            title={bi("检查结果", "Check Results")}
          >
            <ProblemList
              check={check}
              stale={checkStale}
              open={openProblem}
              ignore={ignoreWarning}
            />
            <div className="wb-note">
              {bi(
                "静态检查只看文件本身；是否真的能部署，要靠「试生成」和在空环境里的验证。",
                "Static checks inspect files only; deployment readiness requires Trial Generate and clean-environment verification.",
              )}
            </div>
          </Drawer>
          <PreviewDrawer
            name={name}
            open={panel === "preview"}
            close={() => setPanel("")}
            flush={saveNow}
            openFile={openFile}
          />
          <RevisionsDrawer
            name={name}
            ws={ws}
            open={panel === "revisions"}
            close={() => setPanel("")}
            hasDraft
            onRestored={async () => {
              setPanel("");
              await reloadWs();
              await loadDraft();
              runCheck();
            }}
          />
          <PublishModal
            name={name}
            ws={ws}
            open={publishing}
            close={() => setPublishing(false)}
            check={check}
            showProblems={() => setPanel("problems")}
            done={async (rev) => {
              setPublishing(false);
              Message.success(bi(`已发布，修订 ${rev}`, `Published revision ${rev}`));
              go({ name: "components", id: name }, { replace: true });
            }}
          />
        </div>
      </AIDock>
    </Wb.Provider>
  );
}

/** The checks that belong to the tab being edited, always on that tab, so an error is never only visible in the YAML. */
function TabProblems({
  tab,
  problems,
  onSource,
}: {
  tab: Tab;
  problems: Problem[];
  onSource: (line?: number) => void;
}) {
  useLang();
  const mine = problems.filter(
    (p) =>
      (p.file === "component.yaml" || !p.file) && tabOfPath(p.path) === tab,
  );
  if (!mine.length) return null;
  return (
    <div className="wb-tabprob" role="alert">
      {mine.map((p, i) => (
        <div key={i} className={p.severity}>
          {p.severity === "error" ? (
            <IconCloseCircle />
          ) : (
            <IconExclamationCircle />
          )}
          <span>
            {p.message}
            {p.path && <code>{p.path}</code>}
          </span>
          {p.line ? (
            <button
              type="button"
              className="wb-link"
              onClick={() => onSource(p.line)}
            >
              {bi(`源码第 ${p.line} 行`, `Source line ${p.line}`)}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Gate({
  title,
  text,
  back,
}: {
  title: string;
  text?: string;
  back: string;
}) {
  useLang();
  return (
    <div className="wb enter">
      <div className="detail-none">
        <h2>{title}</h2>
        {text && <p className="muted">{text}</p>}
        <Button
          onClick={() => go({ name: "components", id: back || undefined })}
        >
          {bi("返回", "Back")}
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- nothing being edited yet */

function StartPanel({
  ws,
  start,
  openRevisions,
}: {
  ws: Workspace;
  start: (from: "live" | "builtin") => Promise<void>;
  openRevisions: () => void;
}) {
  useLang();
  const aiStatus = useAIStatus();
  const [fork, setFork] = useState(false);
  if (ws.name === "platform-shared")
    return (
      <div className="wb-start">
        <Button
          type="text"
          icon={<IconArrowLeft />}
          onClick={() => go({ name: "components" })}
        >
          {bi("返回组件", "Back to Components")}
        </Button>
        <h1>{bi("平台公共流程", "Platform Shared Flows")}</h1>
        <p className="muted">
          {aiStatus.enabled && !!aiStatus.features?.component && can("ai.use")
            ? bi(
                "所有交付共享的部署预检、数据盘准备、离线源、软件安装与密钥流程。可以手工编辑文件，也可以让 AI 提出修改。",
                "Shared preflight, data disk setup, offline repos, package install, and secret flows across all deliveries. Edit files manually or ask AI to propose changes.",
              )
            : bi(
                "所有交付共享的部署预检、数据盘准备、离线源、软件安装与密钥流程。",
                "Shared preflight, data disk setup, offline repos, package install, and secret flows across all deliveries.",
              )}
        </p>
        <div className="wb-choices">
          <button className="wb-choice" onClick={() => start("live")}>
            <b>{bi("开始编辑公共流程", "Edit Shared Flows")}</b>
            <span>
              {bi(
                "先存草稿，检查和试生成后再发布；不会自动修改运行中的集群。",
                "Saves as a draft first; check and trial-generate before publishing. Running clusters are unaffected.",
              )}
            </span>
          </button>
        </div>
        {ws.revisions.length > 0 && (
          <Button type="text" onClick={openRevisions}>
            {bi("查看历史修订", "View Revision History")}
          </Button>
        )}
      </div>
    );
  return (
    <div className="wb-start">
      <Button
        type="text"
        className="wb-back"
        icon={<IconArrowLeft />}
        onClick={() => go({ name: "components", id: ws.name })}
      >
        {ws.name}
      </Button>
      <h1>{bi("修改 " + ws.name, "Modify " + ws.name)}</h1>
      {ws.source === "builtin" ? (
        <>
          <p className="muted">
            {bi(
              "内置组件随平台一起升级，不能原地改。改动会保存成一份同名的自定义版本，你有两种办法：",
              "Built-in components upgrade with the platform and cannot be modified in place. Your changes save as a custom override; choose an option:",
            )}
          </p>
          <div className="wb-choices">
            <button
              type="button"
              className="wb-choice"
              onClick={() => start("builtin")}
            >
              <b>{bi("修改这个组件", "Modify This Component")}</b>
              <span>
                {bi(
                  "从内置的原样开始改。发布后，新的交付用你改过的这份；随时可以「恢复内置」回到原样。适合改默认值、加一个软件版本。",
                  "Start from the built-in definition. New deliveries use your override once published, and you can reset to built-in anytime. Best for default tweaks or adding versions.",
                )}
              </span>
            </button>
            <button
              type="button"
              className="wb-choice"
              onClick={() => setFork(true)}
            >
              <b>{bi("复制为自定义组件", "Copy as Custom Component")}</b>
              <span>
                {bi(
                  "用一个新名字复制一份，和内置的互不影响。适合在它的基础上做一个不同的中间件。",
                  "Fork under a new ID, completely independent of the built-in. Best for creating a separate variant.",
                )}
              </span>
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            {ws.source === "override"
              ? bi("这是覆盖了内置组件的自定义版本。", "This is a custom override of a built-in component.")
              : bi("这是一个自定义组件。", "This is a custom component.")}
            {bi(
              "草稿只存在于这里，发布之前不会影响任何交付。",
              " Drafts stay isolated here and do not affect deliveries until published.",
            )}
          </p>
          <div className="wb-choices">
            <button
              type="button"
              className="wb-choice"
              onClick={() => start("live")}
            >
              <b>{bi("开始编辑", "Start Editing")}</b>
              <span>
                {bi(
                  "从当前已发布的内容开始，改完检查、试生成，满意后再发布。",
                  "Start from the currently published content; check and trial-generate before publishing.",
                )}
              </span>
            </button>
          </div>
        </>
      )}
      {ws.revisions.length > 0 && (
        <p>
          <button type="button" className="wb-link" onClick={openRevisions}>
            {bi(
              `查看 ${ws.revisions.length} 个历史修订`,
              `View ${ws.revisions.length} past revision(s)`,
            )}
          </button>
        </p>
      )}
      <ForkModal from={ws.name} open={fork} close={() => setFork(false)} />
    </div>
  );
}

/* ---------------------------------------------------------------- publish */

function PublishModal({
  name,
  ws,
  open,
  close,
  check,
  done,
  showProblems,
}: {
  name: string;
  ws: Workspace;
  open: boolean;
  close: () => void;
  check: Check | null;
  done: (rev: number) => void;
  showProblems: () => void;
}) {
  useLang();
  const aiStatus = useAIStatus();
  const canCompAI =
    aiStatus.enabled && !!aiStatus.features?.component && can("ai.use");
  const [modes,setModes]=useState<string[]>([]);
  const [originalModes,setOriginalModes]=useState<string[]>([]);
  const [automaticProblems,setAutomaticProblems]=useState<{path:string;message:string}[]>([]);
  const [configurationProblems,setConfigurationProblems]=useState<{path:string;message:string}[]>([]);
  const modesChanged=JSON.stringify([...modes].sort())!==JSON.stringify([...originalModes].sort());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // the note is written from what changed; the person keeps it, edits it or writes their own
  const [writing, setWriting] = useState(false);
  const generation = useRef(0);
  const noteEdit = useRef(0);
  const [loadError, setLoadError] = useState("");
  const [reviewedAt, setReviewedAt] = useState("");
  const writeNote = async (quiet = false) => {
    if (writing || busy) return;
    const current = generation.current;
    const edit = noteEdit.current;
    setWriting(true);
    try {
      const r = await api<{ note: string }>(
        `/api/components/${name}/draft/note`,
        { method: "POST", body: "{}" },
      );
      if (current === generation.current && edit === noteEdit.current)
        setNote((cur) => (quiet && cur ? cur : r.note));
    } catch (e) {
      if (current === generation.current) err(e);
    } finally {
      if (current === generation.current) setWriting(false);
    }
  };
  const [force, setForce] = useState(false);
  const [pick, setPick] = useState(0);
  const d = ws.draft;
  const errors = check?.errors ?? 0;
  const errList = (check?.problems || []).filter((p) => p.severity === "error");
  const [diffs, setDiffs] = useState<
    { path: string; status: string; diff?: string }[] | null
  >(null);
  useEffect(() => {
    const current = ++generation.current;
    if (!open) return;
    setNote("");
    setForce(false);
    setWriting(false);
    setLoadError("");
    setReviewedAt("");
    setDiffs(null);
    setPick(0);
    api<{
      delivery_modes: string[];
      automatic_problems: {path:string;message:string}[];
      configuration_problems: {path:string;message:string}[];
      updated: string;
      diffs: { path: string; status: string; diff?: string }[];
    }>(`/api/components/${name}/draft/diff`, { method: "POST", body: "{}" })
      .then((r) => {
        if (current !== generation.current) return;
        setModes(r.delivery_modes||[]);setOriginalModes(r.delivery_modes||[]);setAutomaticProblems(r.automatic_problems||[]);setConfigurationProblems(r.configuration_problems||[]);
        setReviewedAt(r.updated);
        setDiffs(r.diffs);
        if (r.diffs.length && canCompAI) writeNote(true);
      })
      .catch((e) => {
        if (current === generation.current)
          setLoadError((e as Error).message || bi("读取修改失败，请关闭后重试", "Failed to load changes; close and retry"));
      });
    return () => {
      generation.current++;
    };
  }, [open, name]);
  const blocked =
    busy ||
    writing ||
    diffs === null ||
    !!loadError ||
    !reviewedAt ||
    errors > 0 ||
    (d.stale && !force) ||
    (diffs.length === 0 && !modesChanged) ||
    (name!=="platform-shared" && (!modes.length || (modes.includes("automatic") && automaticProblems.length>0) || (modes.includes("configuration") && configurationProblems.length>0))) ||
    !note.trim();
  const submit = async () => {
    if (blocked) return;
    setBusy(true);
    try {
      const r = await api<{ rev: number }>(
        `/api/components/${name}/draft/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            delivery_modes: name==="platform-shared"?undefined:modes,
            note: note.trim(),
            force,
            if_updated: reviewedAt,
          }),
        },
      );
      setNote("");
      done(r.rev);
    } catch (e) {
      const body = (e as ApiError).body as { check?: Check } | undefined;
      if (body?.check) Message.error((e as Error).message);
      else err(e);
    } finally {
      setBusy(false);
    }
  };
  const cur = diffs?.[Math.min(pick, (diffs?.length || 1) - 1)];
  const diffStatusLabel = (st: string) =>
    st === "added"
      ? bi("新增", "Added")
      : st === "changed"
        ? bi("修改", "Modified")
        : st === "removed"
          ? bi("删除", "Deleted")
          : st;
  return (
    <Modal
      visible={open}
      onCancel={() => {
        if (!busy) close();
      }}
      maskClosable={!busy}
      closable={!busy}
      cancelButtonProps={{ disabled: busy }}
      title={ws.exists ? bi("发布新修订", "Publish New Revision") : bi("发布组件", "Publish Component")}
      okText={bi("发布", "Publish")}
      confirmLoading={busy}
      okButtonProps={{
        disabled: blocked,
      }}
      onOk={submit}
      style={{ width: 900, maxWidth: "96vw" }}
    >
      <div className="wb-publish">
        {name!=="platform-shared" && <section className="wb-delivery-capabilities">
          <h3>{bi("这个修订支持哪些交付方式", "Delivery Modes Supported by This Revision")}</h3>
          <p className="muted">
            {bi(
              "可以多选。发布只更新组件能力；已有交付和现场机器不会自动变化。",
              "Multiple selections allowed. Publishing updates component capabilities only; existing deliveries and live hosts are untouched.",
            )}
          </p>
          <div className="exec-actions">{[
            {id:"offline",label:bi("离线部署", "Offline Deploy")},
            {id:"automatic",label:bi("自动执行", "Automatic Execution")},
            {id:"configuration",label:bi("仅出配置", "Config Only")},
          ].map(m=><Checkbox key={m.id} checked={modes.includes(m.id)} onChange={v=>setModes(old=>v?[...old,m.id]:old.filter(x=>x!==m.id))}>{m.label}</Checkbox>)}</div>
          {modes.includes("automatic")&&automaticProblems.length>0&&<div className="exec-warning"><b>{bi(`自动执行还缺少 ${automaticProblems.length} 项契约`, `Automatic execution is missing ${automaticProblems.length} contract item(s)`)}</b><ul>{automaticProblems.slice(0,5).map((p,i)=><li key={i}>{p.path}: {p.message}</li>)}</ul><p>{bi("请在“部署步骤 / 测试与清理”填写执行超时、完成条件和判据后重新校验。", "Fill in timeouts, postconditions, and checks under Deploy Steps / Tests & Cleanup and re-check.")}</p></div>}
          {modes.includes("configuration")&&<p className="muted small">{bi("软件组件需要在“概览 → 配置文件”定义输出内容。仅出配置不包含安装或现场执行。", "Software components must define output files under Overview → Configuration Files. Config Only excludes installation and remote execution.")}</p>}
          {modes.includes("configuration")&&configurationProblems.length>0&&<div className="exec-warning" role="alert"><b>{bi("配置输出尚未完成", "Configuration output incomplete")}</b><ul>{configurationProblems.map((p,i)=><li key={i}>{p.message}</li>)}</ul></div>}
          {modesChanged&&<p>{bi("本次同时修改交付能力，请把这项变化写入修订说明。", "Delivery modes changed; please note this in the revision summary.")}</p>}
        </section>}

        {loadError && (
          <p role="alert" className="warn">
            {bi(`读取修改失败：${loadError}。请关闭后重试。`, `Failed to load changes: ${loadError}. Close and retry.`)}
          </p>
        )}
        {writing && (
          <p role="status">
            {bi(
              "AI 正在生成修订说明，请完成后再发布；也可以取消并稍后重试。",
              "AI is generating a revision note; wait for it to finish before publishing, or cancel and retry.",
            )}
          </p>
        )}
        {!writing && diffs && diffs.length > 0 && !note.trim() && (
          <p className="muted">
            {bi("填写修订说明后才能发布，方便以后追溯这次修改。", "Enter a revision note before publishing so changes are traceable later.")}
          </p>
        )}
        {diffs?.length === 0 && !modesChanged ? (
          <div className="wb-pub-empty">
            <IconCheckCircle />
            <b>{bi("草稿和已发布的内容完全一样", "Draft matches the published version")}</b>
            <span>
              {bi(
                "没有需要发布的修改。改完再来发布；不需要这份草稿的话，可以在页头“更多”里放弃它。",
                "No changes to publish. Edit first, or discard this draft from the More menu in the header.",
              )}
            </span>
          </div>
        ) : errors > 0 ? (
          <div className="wb-pub-err" role="alert">
            <IconCloseCircle />
            <div>
              <b>{bi(`还有 ${errors} 处错误，修好之后才能发布`, `${errors} error(s) remain; fix them before publishing`)}</b>
              <ul>
                {errList.slice(0, 4).map((p, i) => (
                  <li key={i}>{p.message}</li>
                ))}
              </ul>
              <button
                type="button"
                className="wb-link"
                onClick={() => {
                  close();
                  showProblems();
                }}
              >
                {bi("查看全部检查结果", "View all check results")}
              </button>
            </div>
          </div>
        ) : (
          <p className="muted">
            {bi(
              "发布后，之后新建的集群都使用这份内容；已经生成的不受影响，仍可复现。发布前的内容保存为修订，随时可以回到。",
              "After publishing, new clusters use this revision; existing deliveries stay reproducible. Previous state is saved as a revision you can restore anytime.",
            )}
          </p>
        )}
        {diffs?.length !== 0 && (
          <div className="wb-pub-diff">
            <ul className="wb-pub-files" aria-label={bi("变化的文件", "Changed files")}>
              {diffs === null && <li className="muted small">{bi("读取中…", "Loading...")}</li>}
              {diffs?.length === 0 && (
                <li className="muted small">{bi("和已发布的内容没有差别。", "No differences from published.")}</li>
              )}
              {diffs?.map((f, i) => (
                <li key={f.path}>
                  <button
                    type="button"
                    className={i === pick ? "on" : ""}
                    onClick={() => setPick(i)}
                  >
                    <i className={`wb-st ${f.status}`}>{diffStatusLabel(f.status)}</i>
                    <span className="mono" title={f.path}>
                      {f.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="wb-pub-view">
              {cur ? (
                cur.diff ? (
                  <Diff text={cur.diff} />
                ) : (
                  <p className="muted small">
                    {cur.status === "removed"
                      ? bi("这个文件被删除了。", "This file was deleted.")
                      : bi("没有可显示的内容。", "Nothing to display.")}
                  </p>
                )
              ) : null}
            </div>
          </div>
        )}
        {d.stale && (
          <label className="wb-check warn">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
            />{" "}
            {bi(
              "已发布的内容在草稿开始后又变过，我确认用草稿覆盖它",
              "Published content changed after this draft began; I confirm overwriting it",
            )}
          </label>
        )}
        {diffs?.length !== 0 && (
          <div className="wb-field w-l">
            <span className="wb-flabel wb-note-label">
              {bi("修订说明", "Revision Note")}
              {canCompAI && (
                <Button
                  size="mini"
                  type="text"
                  loading={writing}
                  disabled={busy || writing || !diffs?.length || !!loadError}
                  icon={<Spark size={12} rainbow />}
                  onClick={() => writeNote()}
                >
                  {note ? bi("让 AI 重写", "Rewrite with AI") : bi("让 AI 写", "Draft with AI")}
                </Button>
              )}
            </span>
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 4 }}
              maxLength={200}
              showWordLimit
              value={note}
              disabled={busy}
              onChange={(value) => {
                noteEdit.current++;
                setNote(value);
              }}
              placeholder={bi("这次改了什么、为什么，如：etcd 增加 3.6 版本", "What changed and why, e.g. Add etcd 3.6")}
              aria-label={bi("修订说明", "Revision note")}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- revisions */

function RevisionsDrawer({
  name,
  ws,
  open,
  close,
  hasDraft,
  onRestored,
}: {
  name: string;
  ws: Workspace;
  open: boolean;
  close: () => void;
  hasDraft: boolean;
  onRestored: () => void;
}) {
  useLang();
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<{
    meta: Rev;
    diffs: { path: string; status: string; diff?: string }[];
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    setSel(null);
    setDetail(null);
  }, [open]);
  useEffect(() => {
    if (sel === null) return;
    setDetail(null);
    api<{
      meta: Rev;
      diffs: { path: string; status: string; diff?: string }[];
    }>(`/api/components/${name}/revisions/${sel}`)
      .then(setDetail)
      .catch(err);
  }, [sel, name]);
  const restore = (rev: number) => {
    const doIt = async () => {
      try {
        await api(`/api/components/${name}/revisions/${rev}/restore`, {
          method: "POST",
          body: JSON.stringify({ replace: true }),
        });
        onRestored();
      } catch (e) {
        err(e);
      }
    };
    if (hasDraft)
      Modal.confirm({
        title: bi(`用修订 ${rev} 替换当前草稿？`, `Replace current draft with revision ${rev}?`),
        content: bi("草稿里没有发布的修改会丢失。", "Unpublished changes in the current draft will be lost."),
        okText: bi("替换草稿", "Replace Draft"),
        onOk: doIt,
      });
    else doIt();
  };
  const revs = [...ws.revisions].reverse();
  return (
    <Drawer
      width="min(640px, 100vw)"
      visible={open}
      onCancel={close}
      footer={null}
      title={bi("修订历史", "Revision History")}
    >
      {revs.length === 0 ? (
        <p className="muted">
          {bi(
            "还没有修订。每次发布都会保存一份，之后可以在这里对照和回到。",
            "No revisions yet. Every publish saves a snapshot here for comparison or restore.",
          )}
        </p>
      ) : (
        <ol className="wb-revs">
          {revs.map((r) => (
            <li key={r.rev} className={sel === r.rev ? "on" : ""}>
              <button
                type="button"
                onClick={() => setSel(sel === r.rev ? null : r.rev)}
                aria-expanded={sel === r.rev}
              >
                <b>{bi(`修订 ${r.rev}`, `Rev ${r.rev}`)}</b>
                {r.rev === ws.rev && <span className="flag">{bi("当前", "Current")}</span>}
                <span className="muted small">
                  {r.user} · {ago(r.time)}
                </span>
                <span className="wb-rev-note">{r.note || bi("（无说明）", "(No note)")}</span>
                <span className="faint small">
                  {[
                    [
                      r.added ? `+${r.added}` : "",
                      r.changed ? `~${r.changed}` : "",
                      r.removed ? `-${r.removed}` : "",
                    ]
                      .filter(Boolean)
                      .join(" "),
                    bi(`${r.files} 个文件`, `${r.files} file(s)`),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
              {sel === r.rev && (
                <div className="wb-rev-detail">
                  {!detail ? (
                    <Spin />
                  ) : (
                    <>
                      <div className="wb-rev-actions">
                        <Button
                          size="small"
                          icon={<IconUpload />}
                          onClick={() => restore(r.rev)}
                        >
                          {bi("以此为基础编辑（放进草稿）", "Edit from this revision (load into draft)")}
                        </Button>
                      </div>
                      {detail.diffs.length === 0 && (
                        <p className="muted small">
                          {bi("和上一修订没有差别。", "No differences from the previous revision.")}
                        </p>
                      )}
                      {detail.diffs.map((f) => (
                        <details key={f.path} open={detail.diffs.length <= 3}>
                          <summary>
                            <span className="mono">{f.path}</span>
                            <i className={`wb-st ${f.status}`}>
                              {
                                {
                                  added: bi("新增", "Added"),
                                  changed: bi("修改", "Modified"),
                                  removed: bi("删除", "Deleted"),
                                }[f.status]
                              }
                            </i>
                          </summary>
                          {f.diff && <Diff text={f.diff} />}
                        </details>
                      ))}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  );
}

/** Opens the assistant on this component, after saving what is typed so it reads the latest draft. */
function AssistButton({ flush }: { flush: () => Promise<void> }) {
  useLang();
  const dock = useAIDock();
  if (!dock?.available("comp")) return null;
  return (
    <Button
      shape="round"
      className="ai-pill"
      icon={<Spark size={14} rainbow />}
      onClick={() => flush().then(() => dock.open())}
    >
      {bi("AI 助手", "AI Assistant")}
    </Button>
  );
}

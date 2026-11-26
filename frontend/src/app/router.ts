import { useSyncExternalStore } from "react";
import { NEW_DELIVERY_INTENT } from "../modules/catalog/formdraft";

export type Route =
  /** A cluster (id), one of its tabs, and one of its deliveries, rehearsals, or documents. */
  | {
      name: "deliveries";
      id?: string;
      tab?: "config" | "plans" | "docs" | "rehearsal" | "security" | "automation";
      plan?: string;
      doc?: string;
      rehearsal?: string;
      source?: string;
      section?: string;
    }
  /** chat brings back a form conversation (from the assistant page). When app is omitted, opens the component & architecture picker. */
  | {
      name: "new";
      app?: string;
      from?: string;
      revise?: string;
      plan?: string;
      chat?: string;
      verify?: string;
      ver?: string;
      platform?: string;
    }
  | { name: "import"; component?: string }
  | { name: "apps"; id?: string }
  | {
      name: "executions";
      view?: "runs" | "nodes";
      fleet?: "controllers" | "agents";
      id?: string;
      run?: string;
      step?: string;
    }
  | { name: "components"; id?: string; edit?: string }
  | { name: "library"; id?: string }
  | {
      name: "security";
      tab?: "overview" | "vulns" | "clusters" | "reports" | "db";
      q?: string;
    }
  | { name: "accounts"; id?: string }
  | { name: "me"; id?: string }
  | { name: "kb"; id?: string }
  | { name: "skills"; id?: string }
  | { name: "mcp"; id?: string }
  | { name: "settings"; id?: string }
  | {
      name: "ai";
      id?: string;
      job?: string;
      comp?: string;
      key?: string;
      hist?: string;
    };

export function parse(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const p = path.split("/").filter(Boolean).map(part=>{try{return decodeURIComponent(part)}catch{return part}});
  const q = new URLSearchParams(query);
  if (p[0] === "d")
    return p[2] === "config"
      ? {
          name: "deliveries",
          id: p[1],
          tab: "config",
          source: q.get("source") || undefined,
          section: q.get("section") || undefined,
        }
      : p[2] === "plans"
        ? { name: "deliveries", id: p[1], tab: "plans", plan: p[3] }
        : p[2] === "docs"
          ? { name: "deliveries", id: p[1], tab: "docs", doc: p[3] }
          : p[2] === "rehearsal"
            ? { name: "deliveries", id: p[1], tab: "rehearsal", rehearsal: p[3] }
            : p[2] === "security"
              ? { name: "deliveries", id: p[1], tab: "security" }
              : p[2] === "automation"
                ? { name: "deliveries", id: p[1], tab: "automation" }
                : { name: "deliveries", id: p[1] };
  if (p[0] === "new")
    return {
      name: "new",
      app: p[1] || undefined,
      from: q.get("from") || undefined,
      revise: q.get("revise") || undefined,
      plan: q.get("plan") || undefined,
      chat: q.get("chat") || undefined,
      verify: q.get("verify") || undefined,
      ver: q.get("ver") || undefined,
      platform: q.get("platform") || undefined,
    };
  if (p[0] === "import")
    return { name: "import", component: p[1] || undefined };
  if (p[0] === "apps") return { name: "apps", id: p[1] };
  if (p[0] === "executions") {
    if (p[1] === "nodes") {
      return {
        name: "executions",
        view: "nodes",
        fleet: q.get("fleet") === "agents" ? "agents" : undefined,
      };
    }
    return {
      name: "executions",
      view: "runs",
      id: p[1] === "runs" ? undefined : p[1],
      run: q.get("run") || undefined,
      step: q.get("step") || undefined,
    };
  }
  if (p[0] === "library") return { name: "library", id: p[1] };
  if (p[0] === "security") {
    const t = p[1];
    const tab =
      t === "vulns" ||
      t === "clusters" ||
      t === "reports" ||
      t === "db" ||
      t === "overview"
        ? t
        : undefined;
    return { name: "security", tab, q: q.get("q") || undefined };
  }
  if (p[0] === "components")
    return p[2] === "edit"
      ? { name: "components", id: p[1], edit: p[3] || "overview" }
      : { name: "components", id: p[1] };
  if (p[0] === "accounts" || p[0] === "iam")
    return { name: "accounts", id: p[1] };
  if (p[0] === "me") return { name: "me", id: p[1] };
  if (p[0] === "kb") return { name: "kb", id: p[1] };
  if (p[0] === "skills") return { name: "skills", id: p[1] };
  if (p[0] === "mcp") return { name: "mcp", id: p[1] };
  if (p[0] === "settings") {
    if (p[1] === "execution-nodes" || p[1] === "nodes") {
      return { name: "executions", view: "nodes" };
    }
    return { name: "settings", id: p[1] };
  }
  if (p[0] === "ai")
    return {
      name: "ai",
      id: p[1],
      job: q.get("job") || undefined,
      comp: q.get("comp") || undefined,
      key: q.get("key") || undefined,
      hist: q.get("hist") || undefined,
    };
  return { name: "deliveries" };
}

export const href = (r: Route): string => {
  switch (r.name) {
    case "deliveries":
      if (r.id && r.tab === "config") {
        const q = new URLSearchParams();
        if (r.source) q.set("source", r.source);
        if (r.section) q.set("section", r.section);
        return `#/d/${encodeURIComponent(r.id)}/config${q.size ? `?${q}` : ""}`;
      }
      return r.id
        ? `#/d/${encodeURIComponent(r.id)}${r.tab ? `/${r.tab}${r.plan || r.doc || r.rehearsal ? `/${encodeURIComponent((r.plan || r.doc || r.rehearsal)!)}` : ""}` : ""}`
        : "#/";
    case "new": {
      if (!r.app) return "#/new";
      const q = new URLSearchParams();
      if (r.revise) q.set("revise", r.revise);
      else if (r.from) q.set("from", r.from);
      else if (r.plan) q.set("plan", r.plan);
      else if (r.chat) q.set("chat", r.chat);
      if (r.verify) q.set("verify", r.verify);
      if (r.ver) q.set("ver", r.ver);
      if (r.platform) q.set("platform", r.platform);
      return `#/new/${encodeURIComponent(r.app)}${q.size ? `?${q}` : ""}`;
    }
    case "import":
      return r.component
        ? `#/import/${encodeURIComponent(r.component)}`
        : "#/import";
    case "apps":
      return r.id ? `#/apps/${encodeURIComponent(r.id)}` : "#/apps";
    case "executions": {
      if (r.view === "nodes") {
        return r.fleet === "agents"
          ? "#/executions/nodes?fleet=agents"
          : "#/executions/nodes";
      }
      const q = new URLSearchParams();
      if (r.run) q.set("run", r.run);
      if (r.step) q.set("step", r.step);
      return r.id
        ? `#/executions/${encodeURIComponent(r.id)}${q.size ? `?${q}` : ""}`
        : "#/executions";
    }
    case "library":
      return r.id ? `#/library/${encodeURIComponent(r.id)}` : "#/library";
    case "security": {
      const sq = new URLSearchParams();
      if (r.q) sq.set("q", r.q);
      return `#/security${r.tab && r.tab !== "overview" ? `/${r.tab}` : ""}${sq.size ? `?${sq}` : ""}`;
    }
    case "components":
      return r.id
        ? `#/components/${encodeURIComponent(r.id)}${r.edit !== undefined ? `/edit/${encodeURIComponent(r.edit)}` : ""}`
        : "#/components";
    case "accounts":
      return r.id ? `#/iam/${encodeURIComponent(r.id)}` : "#/iam";
    case "me":
      return r.id ? `#/me/${encodeURIComponent(r.id)}` : "#/me";
    case "kb":
      return r.id ? `#/kb/${encodeURIComponent(r.id)}` : "#/kb";
    case "skills":
      return r.id ? `#/skills/${encodeURIComponent(r.id)}` : "#/skills";
    case "mcp":
      return r.id ? `#/mcp/${encodeURIComponent(r.id)}` : "#/mcp";
    case "settings":
      return r.id ? `#/settings/${encodeURIComponent(r.id)}` : "#/settings";
    case "ai": {
      const q = new URLSearchParams();
      if (r.job) {
        q.set("job", r.job);
        if (r.key) q.set("key", r.key);
      } else if (r.comp) {
        q.set("comp", r.comp);
        if (r.key) q.set("key", r.key);
        if (r.hist) q.set("hist", r.hist);
      }
      return `#/ai${r.id ? `/${r.id}` : ""}${q.size ? `?${q}` : ""}`;
    }
  }
};

/* ---------- store ---------- */

let current: Route = parse(location.hash);
const subs = new Set<() => void>();
const apply = (next: Route) => {
  current = next;
  subs.forEach((f) => f());
};

type Kind = "pane" | "forward" | "back" | "swap";
/** How deep a route sits: list pages 0, an opened object 1, the creation flow 2. */
const depth = (r: Route) =>
  r.name === "new"
    ? r.app
      ? 3
      : 2
    : r.name === "import"
      ? 2
      : r.name === "components" && r.edit !== undefined
      ? 2
      : "id" in r && r.id
        ? 1
        : 0;
function kindOf(a: Route, b: Route): Kind {
  // Master-detail pages swap only the detail pane; the apps page opens a full product page instead.
  if (
    a.name === "components" &&
    b.name === "components" &&
    (a.edit !== undefined || b.edit !== undefined)
  )
    return a.edit !== undefined && b.edit !== undefined && a.id === b.id
      ? "pane"
      : depth(b) > depth(a)
        ? "forward"
        : depth(b) < depth(a)
          ? "back"
          : "swap";
  if (
    a.name === b.name &&
    a.name !== "apps" &&
    "id" in a &&
    "id" in b &&
    a.id &&
    b.id
  )
    return "pane";
  // On a wide screen a list page and its detail share the screen, so moving between an overview (no id) and an item, or back,
  // only swaps the detail. Sliding the whole page made the list beside it jump.
  if (
    a.name === b.name &&
    a.name !== "apps" &&
    a.name !== "new" &&
    "id" in a &&
    "id" in b &&
    !window.matchMedia("(max-width: 900px)").matches
  )
    return "pane";
  // sections of one page (platform settings) are switched in place, like the panes of a list
  if (
    a.name === b.name &&
    (a.name === "settings" || a.name === "ai" || a.name === "me")
  )
    return "pane";
  // Switching between different top-level sections is a calm horizontal swap;
  // only intra-section drill-downs or the creation wizard slide forward/back.
  if (
    a.name !== b.name &&
    a.name !== "new" &&
    b.name !== "new" &&
    !(a.name === "components" && a.edit !== undefined) &&
    !(b.name === "components" && b.edit !== undefined)
  )
    return "swap";
  const [da, db] = [depth(a), depth(b)];
  return db > da ? "forward" : db < da ? "back" : "swap";
}

const MAX_SCROLL_HISTORY = 200;
const scrolls = new Map<string, number>();
/** Pages open at the top; going back returns to where the page was left. */
const settle = (kind: Kind | "none", to: Route) => {
  if (kind !== "pane") {
    const top = kind === "back" ? scrolls.get(href(to)) || 0 : 0;
    window.scrollTo({ top, left: 0, behavior: "instant" as ScrollBehavior });
  }
};

let skipNext = false;

window.addEventListener("hashchange", () => {
  const next = parse(location.hash);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  const instant = skipNext;
  skipNext = false;
  const kind = kindOf(current, next);
  const prevHref = href(current);
  if (scrolls.has(prevHref)) scrolls.delete(prevHref);
  else if (scrolls.size >= MAX_SCROLL_HISTORY) {
    const oldest = scrolls.keys().next().value;
    if (oldest !== undefined) scrolls.delete(oldest);
  }
  scrolls.set(prevHref, window.scrollY);
  apply(next);
  if (!instant) settle(kind, next);
});

const subscribe = (l: () => void) => {
  subs.add(l);
  return () => subs.delete(l);
};
export const useRoute = () => useSyncExternalStore(subscribe, () => current);

/** Navigate. `instant` skips the transition, for automatic redirects the user did not ask for. */
export function go(
  r: Route,
  opts: { replace?: boolean; instant?: boolean } = {},
) {
  const target = href(r);
  if (target === (location.hash || "#/")) {
    if (r.name === "new") window.dispatchEvent(new Event(NEW_DELIVERY_INTENT));
    return;
  }
  skipNext = !!opts.instant;
  if (opts.replace) {
    history.replaceState(null, "", target);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else location.hash = target;
}

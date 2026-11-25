import type { Deployment } from "./shared";

export type FormDraft = {
  dep: Deployment;
  plan: string;
  section?: string;
  mode?: "choose" | "form" | "ai";
  aiView?: string;
  updated?: string;
};
export const NEW_DELIVERY_INTENT = "mh-new-delivery";

/** Keep plain new drafts compatible; copied deliveries, revisions, verification runs and named AI chats have separate lifetimes. */
export const draftScope = (o: {
  from?: string;
  revise?: string;
  chat?: string;
  verify?: boolean;
  initialVer?: string;
  initialPlatform?: string;
}) =>
  o.revise
    ? `revise:${o.revise}`
    : o.from
      ? `copy:${o.from}`
      : o.verify
        ? `verify:${o.initialVer || ""}:${o.initialPlatform || ""}`
        : o.chat
          ? `chat:${o.chat}`
          : "";
export const draftKey = (app: string, scope = "") =>
  `mh-draft2-${app}${scope ? `:${encodeURIComponent(scope)}` : ""}`;
export const formChatKey = (app: string, scope = "") =>
  `mh-formchat-${app}${scope ? `:${encodeURIComponent(scope)}` : ""}`;

export function readFormDraft(app: string, scope = ""): FormDraft | null {
  try {
    const draft = JSON.parse(
      sessionStorage.getItem(draftKey(app, scope)) || "null",
    ) as FormDraft | null;
    if (!draft) return null;
    const dep = draft.dep;
    if (
      !dep ||
      typeof dep.id !== "string" ||
      !Array.isArray(dep.hosts) ||
      !dep.hosts.every(
        (h) => h && typeof h.name === "string" && typeof h.ip === "string",
      ) ||
      !Array.isArray(dep.instances) ||
      !dep.instances.every(
        (i) =>
          i &&
          typeof i.id === "string" &&
          typeof i.component === "string" &&
          (!i.placement ||
            Object.values(i.placement).every(
              (hosts) =>
                Array.isArray(hosts) &&
                hosts.every((h) => typeof h === "string"),
            )),
      )
    )
      return null;
    return {
      ...draft,
      plan: typeof draft.plan === "string" ? draft.plan : "",
      section: typeof draft.section === "string" ? draft.section : undefined,
      aiView: typeof draft.aiView === "string" ? draft.aiView : undefined,
      mode: ["choose", "form", "ai"].includes(draft.mode || "")
        ? draft.mode
        : undefined,
      updated:
        typeof draft.updated === "string" &&
        Number.isFinite(Date.parse(draft.updated))
          ? draft.updated
          : undefined,
    };
  } catch {
    return null;
  }
}

export function saveFormDraft(
  app: string,
  scope: string,
  draft: FormDraft,
): boolean {
  try {
    sessionStorage.setItem(draftKey(app, scope), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearFormDraft(app: string, scope = "") {
  try {
    sessionStorage.removeItem(draftKey(app, scope));
    sessionStorage.removeItem(formChatKey(app, scope));
  } catch {
    /* The in-memory form remains usable if storage is unavailable. */
  }
}

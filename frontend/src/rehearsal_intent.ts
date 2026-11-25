import { go } from "./router";
import type { RehearsalSecurityContext } from "./shared";

export type RehearsalPresetKind = "upgrade" | "scale" | "tune" | "switch";
export type RehearsalModeChoice = "auto" | "quick" | "light" | "full";

export const REHEARSAL_INTENT_KEY = "mh-rehearsal-intent";
export const REHEARSAL_INTENT_EVENT = "mh-rehearsal-intent";

export type RehearsalSourceContext = {
  source: "ai_chat" | "overview" | "security" | string;
  badge: string;
  subject?: string;
  tags?: string[];
  note?: string;
};

export type RehearsalIntentPayload = {
  cluster: string;
  kind?: RehearsalPresetKind;
  mode?: RehearsalModeChoice;
  create?: boolean;
  title?: string;
  goal?: string;
  sourceContext?: RehearsalSourceContext;
  securityContext?: RehearsalSecurityContext;
};

export function hasRehearsalIntentFor(clusterId: string): boolean {
  if (!clusterId) return false;
  try {
    const raw = sessionStorage.getItem(REHEARSAL_INTENT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<RehearsalIntentPayload> | null;
    return Boolean(
      parsed && typeof parsed === "object" && parsed.cluster === clusterId,
    );
  } catch {
    return false;
  }
}

function dispatchRehearsalIntent(payload: RehearsalIntentPayload) {
  if (!payload.cluster) return;
  try {
    sessionStorage.setItem(REHEARSAL_INTENT_KEY, JSON.stringify(payload));
  } catch {
    /* ignore storage limits */
  }
  go({ name: "deliveries", id: payload.cluster, tab: "rehearsal" });
  try {
    window.dispatchEvent(
      new CustomEvent(REHEARSAL_INTENT_EVENT, {
        detail: { cluster: payload.cluster },
      }),
    );
  } catch {
    /* ignore */
  }
}

export function launchRehearsalIntent(
  clusterId: string,
  kind?: RehearsalPresetKind,
  opts?: {
    mode?: RehearsalModeChoice;
    title?: string;
    goal?: string;
    sourceContext?: RehearsalSourceContext;
  },
) {
  dispatchRehearsalIntent({
    cluster: clusterId,
    create: true,
    ...(kind ? { kind } : {}),
    ...(opts?.mode ? { mode: opts.mode } : {}),
    ...(opts?.title ? { title: opts.title } : {}),
    ...(opts?.goal ? { goal: opts.goal } : {}),
    ...(opts?.sourceContext ? { sourceContext: opts.sourceContext } : {}),
  });
}

export function launchSecurityRehearsalIntent(
  clusterId: string,
  payload: {
    title: string;
    goal: string;
    securityContext: RehearsalSecurityContext;
  },
) {
  dispatchRehearsalIntent({
    cluster: clusterId,
    create: true,
    title: payload.title,
    goal: payload.goal,
    securityContext: payload.securityContext,
  });
}

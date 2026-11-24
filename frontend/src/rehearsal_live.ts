import { useEffect, useSyncExternalStore } from "react";

export type RehearsalTaskKind =
  | "create"
  | "refine"
  | "scope"
  | "probe"
  | "verify";

export type RehearsalLiveTask<TLive = unknown, TResult = unknown> = {
  key: string;
  kind: RehearsalTaskKind;
  clusterId: string;
  rehearsalId?: string;
  stepId?: string;
  probeAction?: "analyze" | "diagnose";
  status: "running" | "done" | "error";
  live: TLive;
  ac: AbortController;
  result?: TResult;
  draft?: Record<string, unknown>;
  finishedAt?: number;
  notified?: boolean;
};

export const rehearsalTaskKey = {
  create: (clusterId: string) => `create:${clusterId}`,
  refine: (clusterId: string, rehearsalId: string) =>
    `refine:${clusterId}:${rehearsalId}`,
  scope: (clusterId: string, rehearsalId: string) =>
    `scope:${clusterId}:${rehearsalId}`,
  probe: (clusterId: string, rehearsalId: string) =>
    `probe:${clusterId}:${rehearsalId}`,
  verify: (clusterId: string, rehearsalId: string, stepId: string) =>
    `verify:${clusterId}:${rehearsalId}:${stepId}`,
};

export function isRehearsalTaskLive(
  task?: RehearsalLiveTask<unknown, unknown>,
): boolean {
  return Boolean(
    task && (task.status === "running" || task.status === "error"),
  );
}

const tasksMap = new Map<string, RehearsalLiveTask<unknown, unknown>>();
const mountedKeyCounts = new Map<string, number>();
const listeners = new Set<() => void>();
let runningSnapshot: RehearsalLiveTask<unknown, unknown>[] = [];

function emit() {
  runningSnapshot = Array.from(tasksMap.values()).filter(
    (t) => t.status === "running",
  );
  listeners.forEach((fn) => fn());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRehearsalTask<TLive = unknown, TResult = unknown>(
  key: string,
): RehearsalLiveTask<TLive, TResult> | undefined {
  return tasksMap.get(key) as RehearsalLiveTask<TLive, TResult> | undefined;
}

export function clearRehearsalTask(key: string): void {
  if (!tasksMap.has(key)) return;
  tasksMap.delete(key);
  emit();
}

export function abortRehearsalTask(key: string): boolean {
  const cur = tasksMap.get(key);
  if (!cur) return false;
  tasksMap.delete(key);
  try {
    cur.ac.abort();
  } catch {
    // ignore abort exceptions
  }
  emit();
  return true;
}

export function startRehearsalTask<TLive, TResult>(opts: {
  key: string;
  kind: RehearsalTaskKind;
  clusterId: string;
  rehearsalId?: string;
  stepId?: string;
  probeAction?: "analyze" | "diagnose";
  initialLive: TLive;
  draft?: Record<string, unknown>;
  run: (
    updateLive: (updater: (prev: TLive) => TLive) => void,
    signal: AbortSignal,
  ) => Promise<TResult>;
  markError: (prev: TLive, err: unknown) => TLive;
  onSuccessPersist?: (result: TResult) => void;
  onBackgroundDone?: (result: TResult) => void;
  onBackgroundError?: (err: unknown) => void;
}): AbortController {
  // Abort any previous in-flight task with the exact same key before starting fresh
  const existing = tasksMap.get(opts.key);
  if (existing && existing.status === "running") {
    try {
      existing.ac.abort();
    } catch {
      // ignore
    }
  }

  const ac = new AbortController();
  const initialEntry: RehearsalLiveTask<TLive, TResult> = {
    key: opts.key,
    kind: opts.kind,
    clusterId: opts.clusterId,
    rehearsalId: opts.rehearsalId,
    stepId: opts.stepId,
    probeAction: opts.probeAction,
    status: "running",
    live: opts.initialLive,
    ac,
    draft: opts.draft,
  };
  tasksMap.set(opts.key, initialEntry);
  emit();

  const updateLive = (updater: (prev: TLive) => TLive) => {
    const cur = tasksMap.get(opts.key) as
      | RehearsalLiveTask<TLive, TResult>
      | undefined;
    if (!cur || cur.ac !== ac || cur.status !== "running") return;
    const nextLive = updater(cur.live);
    if (nextLive === cur.live) return;
    tasksMap.set(opts.key, { ...cur, live: nextLive });
    emit();
  };

  void opts
    .run(updateLive, ac.signal)
    .then((result) => {
      const cur = tasksMap.get(opts.key) as
        | RehearsalLiveTask<TLive, TResult>
        | undefined;
      if (ac.signal.aborted || !cur || cur.ac !== ac) return;
      try {
        opts.onSuccessPersist?.(result);
      } catch {
        // never break completion transition on cache/event side-effects
      }
      const isMounted = (mountedKeyCounts.get(opts.key) || 0) > 0;
      const doneEntry: RehearsalLiveTask<TLive, TResult> = {
        ...cur,
        status: "done",
        result,
        finishedAt: Date.now(),
        notified: !isMounted,
      };
      tasksMap.set(opts.key, doneEntry);
      emit();

      if (!isMounted && opts.onBackgroundDone) {
        opts.onBackgroundDone(result);
      }

      // Garbage-collect unconsumed completed results after 10 minutes
      window.setTimeout(() => {
        const latest = tasksMap.get(opts.key);
        if (latest && latest.ac === ac && latest.status === "done") {
          tasksMap.delete(opts.key);
          emit();
        }
      }, 10 * 60 * 1000);
    })
    .catch((rawErr) => {
      const cur = tasksMap.get(opts.key) as
        | RehearsalLiveTask<TLive, TResult>
        | undefined;
      if (
        ac.signal.aborted ||
        (rawErr as Error)?.name === "AbortError" ||
        !cur ||
        cur.ac !== ac
      ) {
        if (cur && cur.ac === ac) {
          tasksMap.delete(opts.key);
          emit();
        }
        return;
      }
      const isMounted = (mountedKeyCounts.get(opts.key) || 0) > 0;
      const errEntry: RehearsalLiveTask<TLive, TResult> = {
        ...cur,
        status: "error",
        live: opts.markError(cur.live, rawErr),
        finishedAt: Date.now(),
        notified: !isMounted,
      };
      tasksMap.set(opts.key, errEntry);
      emit();
      if (!isMounted && opts.onBackgroundError) {
        opts.onBackgroundError(rawErr);
      }
    });

  return ac;
}

export function useRehearsalTask<TLive = unknown, TResult = unknown>(
  key: string,
): RehearsalLiveTask<TLive, TResult> | undefined {
  useEffect(() => {
    mountedKeyCounts.set(key, (mountedKeyCounts.get(key) || 0) + 1);
    return () => {
      const next = (mountedKeyCounts.get(key) || 1) - 1;
      if (next <= 0) mountedKeyCounts.delete(key);
      else mountedKeyCounts.set(key, next);
    };
  }, [key]);

  return useSyncExternalStore(subscribe, () => getRehearsalTask<TLive, TResult>(key));
}

export function useActiveRehearsalTasks(): RehearsalLiveTask<unknown, unknown>[] {
  return useSyncExternalStore(subscribe, () => runningSnapshot);
}

export function hasRunningTaskForCluster(
  tasks: RehearsalLiveTask<unknown, unknown>[],
  clusterId: string,
): boolean {
  return tasks.some((t) => t.status === "running" && t.clusterId === clusterId);
}

export function hasRunningTaskForSession(
  tasks: RehearsalLiveTask<unknown, unknown>[],
  clusterId: string,
  rehearsalId: string,
): boolean {
  return tasks.some(
    (t) =>
      t.status === "running" &&
      t.clusterId === clusterId &&
      t.rehearsalId === rehearsalId,
  );
}

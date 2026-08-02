import type {
  JourneyProjectionDelta,
  JourneyProjectionSnapshot,
  NativeApi,
  ThreadId,
} from "@clui/contracts";

import { onServerWelcome } from "../wsNativeApi";

export type JourneyDeltaApplication =
  | { readonly kind: "applied"; readonly snapshot: JourneyProjectionSnapshot }
  | { readonly kind: "duplicate"; readonly snapshot: JourneyProjectionSnapshot }
  | { readonly kind: "gap"; readonly snapshot: JourneyProjectionSnapshot };

export function applyJourneyProjectionDelta(
  current: JourneyProjectionSnapshot,
  delta: JourneyProjectionDelta,
): JourneyDeltaApplication {
  if (delta.threadId !== current.threadId) return { kind: "duplicate", snapshot: current };
  if (delta.toRevision <= current.journeyRevision) return { kind: "duplicate", snapshot: current };
  if (delta.fromRevision !== current.journeyRevision) return { kind: "gap", snapshot: current };
  const changed = delta.changedEntities;
  return {
    kind: "applied",
    snapshot: {
      ...current,
      journeyRevision: delta.toRevision,
      globalEventWatermark: Math.max(current.globalEventWatermark, delta.globalEventWatermark),
      journey: changed.journey ?? current.journey,
      runs: changed.runs ?? current.runs,
      attempts: changed.attempts ?? current.attempts,
      approvals: changed.approvals ?? current.approvals,
      steering: changed.steering ?? current.steering,
    },
  };
}

/**
 * Projection-only reconnect/catch-up controller. It never dispatches a command,
 * so replay and reconnect cannot accidentally launch work.
 */
export function subscribeJourneyProjection(input: {
  readonly api: NativeApi;
  readonly threadId: ThreadId;
  readonly onSnapshot: (snapshot: JourneyProjectionSnapshot) => void;
  readonly onError?: (error: Error) => void;
}) {
  let disposed = false;
  let current: JourneyProjectionSnapshot | null = null;
  let pending: Promise<void> = Promise.resolve();

  const reportError = (cause: unknown) => {
    if (!disposed) input.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
  };

  const replace = (snapshot: JourneyProjectionSnapshot) => {
    if (disposed) return;
    if (
      current?.threadId === snapshot.threadId &&
      snapshot.journeyRevision < current.journeyRevision
    ) {
      return;
    }
    current = snapshot;
    input.onSnapshot(snapshot);
  };

  const catchUp = async () => {
    if (!current || disposed) return;
    const result = await input.api.orchestration.getJourneyDeltas({
      threadId: input.threadId,
      afterJourneyRevision: current.journeyRevision,
    });
    if (disposed) return;
    if (result.kind === "reset") {
      replace(result.snapshot);
      return;
    }
    for (const delta of result.deltas) {
      if (!current) return;
      const application = applyJourneyProjectionDelta(current, delta);
      if (application.kind === "gap") {
        replace(await input.api.orchestration.getJourneyProjection({ threadId: input.threadId }));
        return;
      }
      if (application.kind === "applied") replace(application.snapshot);
    }
  };

  const acceptDelta = async (delta: JourneyProjectionDelta) => {
    if (disposed || delta.threadId !== input.threadId) return;
    if (!current) {
      replace(await input.api.orchestration.getJourneyProjection({ threadId: input.threadId }));
    }
    if (!current) return;
    const application = applyJourneyProjectionDelta(current, delta);
    if (application.kind === "applied") replace(application.snapshot);
    if (application.kind === "gap") await catchUp();
  };

  const unsubscribe = input.api.orchestration.onJourneyProjection((delta) => {
    pending = pending.then(() => acceptDelta(delta)).catch(reportError);
  });
  const unsubscribeWelcome = onServerWelcome(() => {
    pending = pending.then(catchUp).catch(reportError);
  });

  const ready = input.api.orchestration
    .getJourneyProjection({ threadId: input.threadId })
    .then(replace)
    .catch(reportError);

  return {
    ready,
    catchUp: () => {
      pending = pending.then(catchUp).catch(reportError);
      return pending;
    },
    dispose: () => {
      disposed = true;
      unsubscribe();
      unsubscribeWelcome();
    },
  };
}

import type { OrchestrationThread, ThreadId } from "@clui/contracts";

export const AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseIsoTime(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function isThreadBusy(thread: OrchestrationThread): boolean {
  return (
    thread.terminalStatus === "active" ||
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running"
  );
}

export function shouldAutoArchiveThread(
  thread: OrchestrationThread,
  inactiveDays: number,
  now: Date,
): boolean {
  if (inactiveDays <= 0) return false;
  if (thread.deletedAt !== null || thread.archivedAt !== null) return false;
  if (isThreadBusy(thread)) return false;

  const updatedAt = parseIsoTime(thread.updatedAt);
  if (updatedAt === null) return false;

  const cutoff = now.getTime() - inactiveDays * MS_PER_DAY;
  return updatedAt <= cutoff;
}

export function findAutoArchivableThreads(
  threads: readonly OrchestrationThread[],
  inactiveDays: number,
  now: Date,
): ThreadId[] {
  return threads
    .filter((thread) => shouldAutoArchiveThread(thread, inactiveDays, now))
    .map((thread) => thread.id);
}

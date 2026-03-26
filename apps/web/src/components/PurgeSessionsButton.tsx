import type { ThreadId } from "@clui/contracts";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { disposeAllExcept } from "../lib/claudeTerminalCache";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { SidebarMenuButton } from "./ui/sidebar";

/** Hook statuses that indicate the thread is busy and should not be purged. */
const BUSY_HOOK_STATUSES = new Set(["working", "needsInput", "pendingApproval"]);

export function PurgeSessionsButton({ routeThreadId }: { routeThreadId: string | null }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ sessionsKilled: number; snapshotsCleared: number } | null>(null);

  const handlePurge = async () => {
    const api = readNativeApi();
    if (!api) return;

    // Collect protected thread IDs: current thread + busy threads
    const threads = useStore.getState().threads;
    const excludeThreadIds: ThreadId[] = [];
    if (routeThreadId) {
      excludeThreadIds.push(routeThreadId as ThreadId);
    }
    for (const thread of threads) {
      if (thread.terminalStatus === "active") {
        excludeThreadIds.push(thread.id as ThreadId);
        continue;
      }
      if (thread.hookStatus && BUSY_HOOK_STATUSES.has(thread.hookStatus)) {
        excludeThreadIds.push(thread.id as ThreadId);
      }
    }
    const excludeSet = new Set(excludeThreadIds);

    try {
      const res = await api.server.purgeInactiveSessions({ excludeThreadIds });

      // Dispose client-side terminals for purged threads
      disposeAllExcept(excludeSet);

      setResult(res);
      setTimeout(() => {
        setResult(null);
        setOpen(false);
      }, 2000);
    } catch (err) {
      console.error("Failed to purge sessions:", err);
      setOpen(false);
    }
  };

  return (
    <>
      <SidebarMenuButton
        size="sm"
        className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Trash2Icon className="size-3.5" />
        <span className="text-xs">Purge sessions</span>
      </SidebarMenuButton>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          {result ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Sessions purged</AlertDialogTitle>
                <AlertDialogDescription>
                  Killed {result.sessionsKilled} session
                  {result.sessionsKilled !== 1 ? "s" : ""}, cleared{" "}
                  {result.snapshotsCleared} snapshot
                  {result.snapshotsCleared !== 1 ? "s" : ""}.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Done</AlertDialogClose>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Purge inactive sessions?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will kill dormant terminal processes and clear cached scrollback for inactive
                  threads. Claude Code conversation history is not affected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                <Button variant="destructive" onClick={handlePurge}>
                  Purge
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

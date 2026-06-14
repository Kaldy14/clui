import { TreePineIcon } from "lucide-react";

import { cn } from "../lib/utils";

export function WorktreeIndicator({
  className,
  iconClassName,
  worktreePath,
}: {
  className?: string;
  iconClassName?: string;
  worktreePath: string | null | undefined;
}) {
  if (!worktreePath) return null;

  return (
    <span
      role="img"
      aria-label="Worktree"
      title="Worktree"
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-emerald-500/70 dark:text-emerald-400/70",
        className,
      )}
    >
      <TreePineIcon aria-hidden="true" className={cn("size-3", iconClassName)} />
    </span>
  );
}

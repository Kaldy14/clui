import type { MouseEventHandler } from "react";
import { SplitIcon, TreePineIcon } from "lucide-react";

import { cn } from "../lib/utils";

export function WorktreeIndicator({
  ariaLabel = "Worktree",
  className,
  iconClassName,
  onClick,
  title = ariaLabel,
  variant = "default",
  worktreePath,
}: {
  ariaLabel?: string | undefined;
  className?: string | undefined;
  iconClassName?: string | undefined;
  onClick?: MouseEventHandler<HTMLButtonElement> | undefined;
  title?: string | undefined;
  variant?: "default" | "sidebar" | undefined;
  worktreePath: string | null | undefined;
}) {
  if (!worktreePath) return null;

  const content =
    variant === "sidebar" ? (
      <SplitIcon aria-hidden="true" className={cn("size-[11px] rotate-90", iconClassName)} />
    ) : (
      <TreePineIcon aria-hidden="true" className={cn("size-3", iconClassName)} />
    );
  const baseClassName = cn(
    "inline-flex shrink-0 items-center justify-center",
    variant === "sidebar"
      ? "text-muted-foreground/45"
      : "text-emerald-500/70 dark:text-emerald-400/70",
    onClick &&
      "rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-emerald-500/10 hover:text-emerald-600 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none dark:hover:text-emerald-300",
    className,
  );

  if (onClick) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        title={title}
        className={baseClassName}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return (
    <span role="img" aria-label={ariaLabel} title={title} className={baseClassName}>
      {content}
    </span>
  );
}

import type { ThreadId } from "@clui/contracts";
import { useMutation } from "@tanstack/react-query";
import { MessageSquareTextIcon, SendIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";

export interface DiffQuickAskSelection {
  readonly x: number;
  readonly y: number;
  readonly filePath: string;
  readonly lineNumber: number | null;
  readonly contextPatch: string;
  readonly selectedText?: string | undefined;
  readonly initialPrompt?: string | undefined;
  readonly autoAsk?: boolean | undefined;
}

interface DiffQuickAskPopoverProps {
  threadId: ThreadId | null;
  selection: DiffQuickAskSelection;
  onClose: () => void;
  initialPrompt?: string | undefined;
  autoAsk?: boolean | undefined;
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Pi could not answer this question.";
}

const QUICK_PROMPTS = [
  "Explain this change.",
  "What review risks do you see?",
  "Suggest a cleaner implementation.",
] as const;

const SELECTION_QUICK_PROMPTS = [
  "Explain this selected code.",
  "What could break around this selection?",
  "Suggest a cleaner version of this selection.",
] as const;

export default function DiffQuickAskPopover({
  threadId,
  selection,
  onClose,
  initialPrompt,
  autoAsk = false,
}: DiffQuickAskPopoverProps) {
  const quickPrompts = selection.selectedText ? SELECTION_QUICK_PROMPTS : QUICK_PROMPTS;
  const [prompt, setPrompt] = useState<string>(initialPrompt ?? quickPrompts[0]);
  const autoAskedRef = useRef(false);
  const position = useMemo(() => {
    const width = 420;
    const height = 420;
    const left = Math.max(12, Math.min(selection.x, window.innerWidth - width - 12));
    const top = Math.max(12, Math.min(selection.y, window.innerHeight - height - 12));
    return { left, top };
  }, [selection.x, selection.y]);

  const askMutation = useMutation({
    mutationFn: async (question: string) => {
      if (!threadId) {
        throw new Error("Select a thread before asking Pi about a diff block.");
      }
      const api = ensureNativeApi();
      return await api.orchestration.askDiffReview({
        threadId,
        filePath: selection.filePath,
        lineNumber: selection.lineNumber,
        prompt: question,
        contextPatch: selection.contextPatch,
      });
    },
  });

  const ask = (question: string) => {
    const trimmed = question.trim();
    if (trimmed.length === 0 || askMutation.isPending) return;
    setPrompt(trimmed);
    askMutation.mutate(trimmed);
  };

  useEffect(() => {
    if (!autoAsk || autoAskedRef.current) return;
    autoAskedRef.current = true;
    ask(initialPrompt ?? quickPrompts[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk, initialPrompt]);

  return (
    <div className="fixed inset-0 z-[70]" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <section
        className="absolute flex max-h-[420px] w-[420px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        style={position}
        onClick={(event) => event.stopPropagation()}
        data-diff-quick-ask
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/70 px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex size-6 items-center justify-center rounded-md bg-blue-500/12 text-blue-600 dark:text-blue-300">
                <MessageSquareTextIcon className="size-3.5" />
              </span>
              <div className="min-w-0">
                <h3 className="font-semibold text-xs text-foreground">Ask Pi about this change</h3>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {selection.filePath}:{selection.lineNumber ?? "selection"}
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onClose}
            title="Close"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="flex flex-wrap gap-1.5">
            {quickPrompts.map((quickPrompt) => (
              <button
                key={quickPrompt}
                type="button"
                className="rounded-full border border-border/70 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground disabled:opacity-50"
                onClick={() => ask(quickPrompt)}
                disabled={askMutation.isPending}
              >
                {quickPrompt}
              </button>
            ))}
          </div>

          {selection.selectedText && (
            <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 p-2">
              <p className="mb-1 font-medium text-[11px] text-foreground/80">Selected code</p>
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
                {selection.selectedText}
              </pre>
            </div>
          )}

          <label className="mt-3 block">
            <span className="mb-1 block font-medium text-[11px] text-foreground/80">Question</span>
            <textarea
              className="min-h-[72px] w-full resize-none rounded-lg border border-border/70 bg-background px-2.5 py-2 text-[12px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-blue-500/60"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  ask(prompt);
                }
              }}
              placeholder="Ask about this diff block…"
            />
          </label>

          {askMutation.isPending && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/70 bg-muted/20 p-2 text-[12px] text-muted-foreground">
              <SparklesIcon className="size-3.5 animate-pulse text-blue-500" />
              Pi is reading the selected diff…
            </div>
          )}

          {askMutation.isError && (
            <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/[0.06] p-2 text-[12px] leading-relaxed text-red-600 dark:text-red-300">
              {asErrorMessage(askMutation.error)}
            </div>
          )}

          {askMutation.data && (
            <div className="mt-3 rounded-lg border border-border/70 bg-card/70 p-3 text-[12px] leading-relaxed text-foreground/90 whitespace-pre-wrap">
              {askMutation.data.answer}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-3 py-2">
          <span className="text-[10px] text-muted-foreground">⌘ Enter to ask</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            onClick={() => ask(prompt)}
            disabled={askMutation.isPending || prompt.trim().length === 0}
          >
            Ask
            <SendIcon className="size-3" />
          </button>
        </div>
      </section>
    </div>
  );
}

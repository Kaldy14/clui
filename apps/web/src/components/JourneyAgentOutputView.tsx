import type { CodingHarness, JourneyAttemptFence, ThreadId } from "@clui/contracts";
import {
  BotIcon,
  BrainCircuitIcon,
  CircleAlertIcon,
  FileCode2Icon,
  ListChecksIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { codexExecOutputEntries, type CodexExecOutputEntry } from "../lib/codexExecJsonl";
import { registerHarnessOutputSubscription } from "../lib/harnessOutputSubscriptions";
import { subscribeJourneyRunOutput } from "../lib/journeyRunOutputSubscription";
import { cn } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import PiHtmlThreadView from "./PiHtmlThreadView";

const MAX_CODEX_OUTPUT_ENTRIES = 200;

const ENTRY_PRESENTATION = {
  agent: { label: "Codex", icon: BotIcon, className: "text-sky-600 dark:text-sky-300" },
  reasoning: {
    label: "Reasoning",
    icon: BrainCircuitIcon,
    className: "text-violet-600 dark:text-violet-300",
  },
  command: {
    label: "Command",
    icon: TerminalIcon,
    className: "text-amber-600 dark:text-amber-300",
  },
  fileChange: {
    label: "File changes",
    icon: FileCode2Icon,
    className: "text-emerald-600 dark:text-emerald-300",
  },
  tool: { label: "Tool", icon: WrenchIcon, className: "text-cyan-600 dark:text-cyan-300" },
  search: {
    label: "Search",
    icon: SearchIcon,
    className: "text-blue-600 dark:text-blue-300",
  },
  plan: {
    label: "Plan",
    icon: ListChecksIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  error: { label: "Error", icon: CircleAlertIcon, className: "text-red-600 dark:text-red-300" },
} satisfies Record<
  CodexExecOutputEntry["kind"],
  { label: string; icon: typeof BotIcon; className: string }
>;

function CodexOutputEntry({ entry }: { entry: CodexExecOutputEntry }) {
  const presentation = ENTRY_PRESENTATION[entry.kind];
  const Icon = presentation.icon;
  const isProse = entry.kind === "agent" || entry.kind === "reasoning" || entry.kind === "plan";

  return (
    <article className="border-b border-border/45 px-4 py-3 last:border-b-0">
      <header className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide">
        <Icon className={cn("size-3.5", presentation.className)} aria-hidden="true" />
        <span className={presentation.className}>{presentation.label}</span>
        {entry.status && (
          <span className="ml-auto font-normal normal-case tracking-normal text-muted-foreground">
            {entry.status}
          </span>
        )}
      </header>
      {entry.title !== presentation.label && (
        <p className="mb-1 break-words font-mono text-[11px] font-medium text-foreground">
          {entry.title}
        </p>
      )}
      {entry.detail &&
        (isProse ? (
          <div className="journey-markdown prose prose-sm max-w-none break-words text-xs leading-5 text-foreground dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.detail}</ReactMarkdown>
          </div>
        ) : (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/35 p-2 font-mono text-[11px] leading-4 text-foreground">
            {entry.detail}
          </pre>
        ))}
    </article>
  );
}

function CodexJourneyAgentOutput({ threadId }: { threadId: ThreadId }) {
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      setError("Clui is not connected to the server.");
      return;
    }

    setOutput("");
    setError(null);
    let cancelled = false;
    let hydrated = false;
    let lastOffset = 0;
    const pendingOutput: Array<{ data: string; offset: number }> = [];
    const subscription = registerHarnessOutputSubscription(api, "codexCli", threadId);
    const unsubscribe = api.claude.onSessionEvent((event) => {
      if (event.threadId !== threadId || event.type !== "output") return;
      if (!hydrated) {
        pendingOutput.push({ data: event.data, offset: event.offset });
        return;
      }
      if (event.offset <= lastOffset) return;
      lastOffset = event.offset;
      setOutput((current) => current + event.data);
    });

    void subscription.ready
      .then(() => api.claude.getScrollback({ threadId }))
      .then((snapshot) => {
        if (cancelled) return;
        let nextOutput = snapshot.scrollback ?? "";
        lastOffset = snapshot.offset;
        for (const event of pendingOutput) {
          if (event.offset <= lastOffset) continue;
          nextOutput += event.data;
          lastOffset = event.offset;
        }
        pendingOutput.length = 0;
        hydrated = true;
        setOutput(nextOutput);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        hydrated = true;
        setError(cause instanceof Error ? cause.message : "Failed to load Codex output.");
      });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
      unsubscribe();
    };
  }, [threadId]);

  const entries = useMemo(
    () => codexExecOutputEntries(output).slice(-MAX_CODEX_OUTPUT_ENTRIES),
    [output],
  );

  useLayoutEffect(() => {
    if (!atBottomRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live="polite"
      className="h-full overflow-y-auto bg-background"
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      {entries.map((entry) => (
        <CodexOutputEntry key={entry.id} entry={entry} />
      ))}
      {entries.length === 0 && !error && (
        <p className="px-4 py-3 text-xs text-muted-foreground">Waiting for Codex output…</p>
      )}
      {error && (
        <p className="m-3 rounded-md border border-red-500/35 bg-red-500/8 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function SelectedJourneyRunOutput({
  fence,
  harness,
}: {
  fence: JourneyAttemptFence;
  harness: Extract<CodingHarness, "pi" | "codexCli">;
}) {
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      setError("Clui is not connected to the server.");
      return;
    }
    setOutput("");
    setError(null);
    const subscription = subscribeJourneyRunOutput({
      api,
      fence,
      onOutput: (state) => setOutput(state.data),
      onError: (cause) => setError(cause.message),
    });
    return subscription.dispose;
  }, [fence]);

  const entries = useMemo(
    () =>
      harness === "codexCli" ? codexExecOutputEntries(output).slice(-MAX_CODEX_OUTPUT_ENTRIES) : [],
    [harness, output],
  );

  useLayoutEffect(() => {
    if (!atBottomRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries, output]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live="polite"
      className="h-full overflow-y-auto bg-background"
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      {harness === "codexCli" ? (
        entries.map((entry) => <CodexOutputEntry key={entry.id} entry={entry} />)
      ) : output ? (
        <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-5 text-foreground">
          {output}
        </pre>
      ) : null}
      {!output && !error && (
        <p className="px-4 py-3 text-xs text-muted-foreground">Waiting for agent output…</p>
      )}
      {error && (
        <p className="m-3 rounded-md border border-red-500/35 bg-red-500/8 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

export function JourneyAgentOutputView({
  threadId,
  harness,
  fence,
  legacy = false,
}: {
  threadId: ThreadId;
  harness: Extract<CodingHarness, "pi" | "codexCli">;
  /** Selected physical attempt for authoritative Journey v2 output. */
  fence?: JourneyAttemptFence | null;
  /** Explicit opt-in for pre-projection Journey v1 sessions. */
  legacy?: boolean;
}) {
  if (fence) return <SelectedJourneyRunOutput fence={fence} harness={harness} />;
  if (!legacy) {
    return (
      <div role="status" className="px-4 py-3 text-xs text-muted-foreground">
        No output yet.
      </div>
    );
  }
  return harness === "pi" ? (
    <PiHtmlThreadView threadId={threadId} />
  ) : (
    <CodexJourneyAgentOutput threadId={threadId} />
  );
}

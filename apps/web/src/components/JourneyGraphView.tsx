import type {
  ClaudeSessionEvent,
  CodingHarness,
  JourneyNode,
  JourneyNodeStatus,
  JourneyNodeType,
  JourneyQuestionnaireAnswer,
  JourneyQuestionnaireField,
  JourneySnapshot,
  PiSessionEvent,
  ThreadId,
} from "@clui/contracts";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleDotIcon,
  FileCode2Icon,
  FlagIcon,
  FlaskConicalIcon,
  HelpCircleIcon,
  LightbulbIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MessageSquareTextIcon,
  NetworkIcon,
  PanelRightOpenIcon,
  StickyNoteIcon,
  PlayIcon,
  RotateCcwIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareCheckBigIcon,
  XIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  buildJourneyAgentPrompt,
  JOURNEY_NODE_EXPANDED_WIDTH,
  JOURNEY_NODE_WIDTH,
  layoutJourneyNodes,
  makeInitialJourney,
  parseJourneyAgentResponse,
  settleJourneyAgentSnapshot,
  withJourneyNode,
} from "../lib/journeyGraph";
import { latestCodexExecAgentMessage } from "../lib/codexExecJsonl";
import { registerHarnessOutputSubscription } from "../lib/harnessOutputSubscriptions";
import { cn, newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { updateThread, useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { JourneyAgentOutputView } from "./JourneyAgentOutputView";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

type JourneyNodeData = {
  journeyNode: JourneyNode;
  direction: JourneySnapshot["layoutDirection"];
  expanded: boolean;
  agentWorking: boolean;
  onToggleExpanded: (nodeId: string) => void;
  onToggleTodo: (nodeId: string, todoId: string, completed: boolean) => void;
  onSubmitInteraction: (
    nodeId: string,
    answers: Record<string, JourneyQuestionnaireAnswer>,
  ) => void;
  onRunAgent: (nodeId: string, message?: string) => void;
  onOpenAgentOutput: (nodeId: string) => void;
};

type JourneyFlowNode = Node<JourneyNodeData, "journey">;
type JourneyHarness = Extract<CodingHarness, "pi" | "codexCli">;

const NODE_TYPE_PRESENTATION: Record<
  JourneyNodeType,
  { label: string; className: string; icon: typeof FlagIcon }
> = {
  goal: {
    label: "Goal",
    className: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
    icon: FlagIcon,
  },
  question: {
    label: "Question",
    className: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
    icon: HelpCircleIcon,
  },
  proposal: {
    label: "Proposal",
    className: "bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300",
    icon: LightbulbIcon,
  },
  task: {
    label: "Task",
    className: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
    icon: SquareCheckBigIcon,
  },
  todoGroup: {
    label: "Todos",
    className: "bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
    icon: ListChecksIcon,
  },
  research: {
    label: "Research",
    className: "bg-teal-500/12 text-teal-700 dark:text-teal-300",
    icon: FlaskConicalIcon,
  },
  implementation: {
    label: "Implementation",
    className: "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300",
    icon: FileCode2Icon,
  },
  review: {
    label: "Review",
    className: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    icon: ShieldCheckIcon,
  },
  note: {
    label: "Note",
    className: "bg-slate-500/12 text-slate-700 dark:text-slate-300",
    icon: StickyNoteIcon,
  },
};

const NODE_STATUS_PRESENTATION: Record<
  JourneyNodeStatus,
  { label: string; className: string; icon: typeof CircleDotIcon; pulse?: boolean }
> = {
  draft: {
    label: "Draft",
    className: "border-slate-400/50 text-slate-600 dark:text-slate-300",
    icon: CircleDashedIcon,
  },
  ready: {
    label: "Ready",
    className: "border-blue-500/55 text-blue-700 dark:text-blue-300",
    icon: PlayIcon,
  },
  running: {
    label: "Agent working",
    className: "border-sky-500 text-sky-700 shadow-sky-500/10 dark:text-sky-300",
    icon: LoaderCircleIcon,
    pulse: true,
  },
  waitingForUser: {
    label: "Waiting for you",
    className: "border-amber-500 text-amber-700 shadow-amber-500/10 dark:text-amber-300",
    icon: MessageSquareTextIcon,
  },
  blocked: {
    label: "Blocked",
    className: "border-slate-400 border-dashed text-slate-600 dark:text-slate-300",
    icon: CircleAlertIcon,
  },
  completed: {
    label: "Completed",
    className: "border-emerald-500/55 text-emerald-700 dark:text-emerald-300",
    icon: CheckCircle2Icon,
  },
  failed: {
    label: "Failed",
    className: "border-red-500/60 text-red-700 dark:text-red-300",
    icon: XCircleIcon,
  },
  cancelled: {
    label: "Cancelled",
    className: "border-slate-400/40 text-slate-500",
    icon: XCircleIcon,
  },
  superseded: {
    label: "Superseded",
    className: "border-slate-400/40 text-slate-500",
    icon: RotateCcwIcon,
  },
};

function isRequiredFieldMissing(field: JourneyQuestionnaireField, value: unknown): boolean {
  if (!field.required) return false;
  if (field.type === "boolean") return typeof value !== "boolean";
  if (field.type === "multiChoice") return !Array.isArray(value) || value.length === 0;
  return typeof value !== "string" || value.trim().length === 0;
}

function JourneyInteractionForm({
  node,
  onSubmit,
}: {
  node: JourneyNode;
  onSubmit: (answers: Record<string, JourneyQuestionnaireAnswer>) => void;
}) {
  const interaction = node.interaction;
  const [stepIndex, setStepIndex] = useState(() => {
    if (!interaction?.activeStepId) return 0;
    return Math.max(
      0,
      interaction.steps.findIndex((step) => step.id === interaction.activeStepId),
    );
  });
  const [answers, setAnswers] = useState<Record<string, JourneyQuestionnaireAnswer>>(
    interaction?.answers ?? {},
  );
  if (!interaction) return null;

  const step = interaction.steps[Math.min(stepIndex, interaction.steps.length - 1)];
  if (!step) return null;
  const missingRequired = step.fields.some((field) =>
    isRequiredFieldMissing(field, answers[field.id]),
  );
  const isLastStep = stepIndex >= interaction.steps.length - 1;

  const updateAnswer = (fieldId: string, value: JourneyQuestionnaireAnswer) => {
    setAnswers((current) => ({ ...current, [fieldId]: value }));
  };

  return (
    <div className="nodrag nowheel space-y-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-foreground">{interaction.title}</p>
          {interaction.steps.length > 1 && (
            <span className="text-[10px] text-muted-foreground">
              {stepIndex + 1}/{interaction.steps.length}
            </span>
          )}
        </div>
        {interaction.description && (
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {interaction.description}
          </p>
        )}
      </div>
      <div>
        <p className="text-xs font-medium text-foreground">{step.title}</p>
        {step.description && (
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{step.description}</p>
        )}
      </div>
      <div className="space-y-3">
        {step.fields.map((field) => (
          <label key={field.id} className="block space-y-1.5 text-[11px] text-foreground">
            <span className="font-medium">
              {field.label}
              {field.required ? <span className="ml-1 text-amber-600">*</span> : null}
            </span>
            {field.description && (
              <span className="block text-muted-foreground">{field.description}</span>
            )}
            {field.type === "text" &&
              (field.multiline ? (
                <Textarea
                  className="min-h-20 text-xs"
                  value={typeof answers[field.id] === "string" ? (answers[field.id] as string) : ""}
                  placeholder={field.placeholder}
                  onChange={(event) => updateAnswer(field.id, event.target.value)}
                />
              ) : (
                <Input
                  className="h-8 text-xs"
                  value={typeof answers[field.id] === "string" ? (answers[field.id] as string) : ""}
                  placeholder={field.placeholder}
                  onChange={(event) => updateAnswer(field.id, event.target.value)}
                />
              ))}
            {field.type === "boolean" && (
              <span className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5">
                <Checkbox
                  checked={answers[field.id] === true}
                  onCheckedChange={(checked) => updateAnswer(field.id, checked === true)}
                />
                <span>{answers[field.id] === true ? "Yes" : "No"}</span>
              </span>
            )}
            {(field.type === "singleChoice" || field.type === "multiChoice") && (
              <span className="grid gap-1.5">
                {field.options.map((option) => {
                  const selected =
                    field.type === "singleChoice"
                      ? answers[field.id] === option.value
                      : Array.isArray(answers[field.id]) &&
                        (answers[field.id] as unknown[]).includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={selected}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-left transition-colors",
                        selected
                          ? "border-primary/60 bg-primary/10 text-foreground"
                          : "border-border/50 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                      )}
                      onClick={() => {
                        if (field.type === "singleChoice") {
                          updateAnswer(field.id, option.value);
                          return;
                        }
                        const current = Array.isArray(answers[field.id])
                          ? (answers[field.id] as string[])
                          : [];
                        updateAnswer(
                          field.id,
                          selected
                            ? current.filter((value) => value !== option.value)
                            : [...current, option.value],
                        );
                      }}
                    >
                      <span className="block font-medium">{option.label}</span>
                      {option.description && (
                        <span className="mt-0.5 block text-[10px] leading-4 opacity-75">
                          {option.description}
                        </span>
                      )}
                    </button>
                  );
                })}
              </span>
            )}
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={stepIndex === 0}
          onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
        >
          Back
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={missingRequired}
          onClick={() => {
            if (isLastStep) {
              onSubmit(answers);
            } else {
              setStepIndex((current) => current + 1);
            }
          }}
        >
          {isLastStep ? interaction.submitLabel : "Next"}
        </Button>
      </div>
    </div>
  );
}

function JourneyNodeCard({ data }: NodeProps<JourneyFlowNode>) {
  const node = data.journeyNode;
  const type = NODE_TYPE_PRESENTATION[node.type];
  const status = NODE_STATUS_PRESENTATION[node.status];
  const TypeIcon = type.icon;
  const StatusIcon = status.icon;
  const targetPosition = data.direction === "TB" ? Position.Top : Position.Left;
  const sourcePosition = data.direction === "TB" ? Position.Bottom : Position.Right;
  const completedTodos = node.todos.filter((todo) => todo.completed).length;
  const hasAgentOutput = data.agentWorking || node.activity.some((entry) => entry.kind === "agent");

  return (
    <article
      aria-label={`${type.label}: ${node.title}. ${status.label}`}
      className={cn(
        "group overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-[border-color,box-shadow,opacity]",
        status.className,
        data.expanded ? "shadow-lg" : "hover:shadow-md",
        node.status === "cancelled" || node.status === "superseded" ? "opacity-60" : "",
      )}
      style={{ width: data.expanded ? JOURNEY_NODE_EXPANDED_WIDTH : JOURNEY_NODE_WIDTH }}
    >
      <Handle
        type="target"
        position={targetPosition}
        className="!size-2 !border-0 !bg-muted-foreground/45"
      />
      <button
        type="button"
        className="nodrag flex w-full items-start gap-3 p-3 text-left"
        onClick={() => data.onToggleExpanded(node.id)}
      >
        <span className={cn("mt-0.5 rounded-md p-1.5", type.className)}>
          <TypeIcon className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <Badge variant="outline" size="sm" className={cn("border-0", type.className)}>
              {type.label}
            </Badge>
            <span className="inline-flex min-w-0 items-center gap-1 text-[10px] font-medium">
              <StatusIcon
                className={cn(
                  "size-3",
                  status.pulse ? "animate-spin motion-reduce:animate-none" : "",
                )}
                aria-hidden="true"
              />
              <span className="truncate">{data.agentWorking ? "Agent working" : status.label}</span>
            </span>
          </span>
          <span className="mt-2 block text-sm font-semibold leading-5 text-foreground">
            {node.title}
          </span>
          {node.summary && (
            <span className="mt-1 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">
              {node.summary}
            </span>
          )}
          {node.todos.length > 0 && (
            <span className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
              <ListChecksIcon className="size-3" /> {completedTodos}/{node.todos.length}
            </span>
          )}
        </span>
        <ChevronDownIcon
          className={cn(
            "mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform",
            data.expanded && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {data.expanded && (
        <div className="nodrag nowheel max-h-[560px] space-y-3 overflow-y-auto border-t border-border/50 p-3">
          {hasAgentOutput && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                "w-full justify-between",
                data.agentWorking &&
                  "border-sky-500/40 bg-sky-500/8 text-sky-700 hover:bg-sky-500/12 dark:text-sky-300",
              )}
              onClick={() => data.onOpenAgentOutput(node.id)}
            >
              <span className="flex items-center gap-2">
                <BotIcon className="size-3.5" />
                {data.agentWorking ? "View live agent output" : "View agent output"}
              </span>
              <PanelRightOpenIcon className="size-3.5" />
            </Button>
          )}

          {node.detailMarkdown && (
            <div className="journey-markdown prose prose-sm max-w-none text-xs leading-5 text-foreground dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.detailMarkdown}</ReactMarkdown>
            </div>
          )}

          {node.todos.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted/25 p-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Todos
              </p>
              {node.todos.map((todo) => (
                <label key={todo.id} className="flex items-start gap-2 text-xs text-foreground">
                  <Checkbox
                    checked={todo.completed}
                    onCheckedChange={(checked) =>
                      data.onToggleTodo(node.id, todo.id, checked === true)
                    }
                  />
                  <span
                    className={cn(
                      "leading-4",
                      todo.completed && "text-muted-foreground line-through",
                    )}
                  >
                    {todo.title}
                    {todo.note && (
                      <span className="mt-0.5 block text-[10px] text-muted-foreground">
                        {todo.note}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}

          {node.interaction && node.status === "waitingForUser" && (
            <JourneyInteractionForm
              key={node.interaction.id}
              node={node}
              onSubmit={(answers) => data.onSubmitInteraction(node.id, answers)}
            />
          )}

          {node.activity.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Activity
              </p>
              {node.activity.slice(-5).map((entry) => (
                <div key={entry.id} className="flex gap-2 text-[11px] leading-4">
                  {entry.kind === "agent" ? (
                    <BotIcon className="mt-0.5 size-3 shrink-0 text-sky-500" />
                  ) : entry.kind === "human" ? (
                    <MessageSquareTextIcon className="mt-0.5 size-3 shrink-0 text-amber-500" />
                  ) : (
                    <CircleDotIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span>
                    <span className="text-foreground">{entry.summary}</span>
                    {entry.detailMarkdown && (
                      <span className="mt-0.5 block text-muted-foreground">
                        {entry.detailMarkdown}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {node.status !== "waitingForUser" && node.status !== "running" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => data.onRunAgent(node.id)}
            >
              <SparklesIcon className="size-3.5" /> Continue with agent
            </Button>
          )}
        </div>
      )}
      <Handle
        type="source"
        position={sourcePosition}
        className="!size-2 !border-0 !bg-muted-foreground/45"
      />
    </article>
  );
}

const NODE_TYPES = { journey: JourneyNodeCard };

function JourneyAgentOutputPanel({
  threadId,
  harness,
  node,
  running,
  onClose,
}: {
  threadId: ThreadId;
  harness: JourneyHarness;
  node: JourneyNode | null;
  running: boolean;
  onClose: () => void;
}) {
  const type = node ? NODE_TYPE_PRESENTATION[node.type] : null;
  const TypeIcon = type?.icon ?? BotIcon;

  return (
    <aside
      aria-label="Journey agent output"
      className="absolute inset-y-0 right-0 z-20 flex w-[min(100%,42rem)] min-w-0 flex-col border-l border-border/70 bg-background shadow-[-16px_0_32px_-24px_rgb(0_0_0/0.45)] lg:relative lg:z-auto lg:w-[min(42vw,42rem)] lg:min-w-96 lg:shadow-none"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
        <span className={cn("rounded-lg p-2", type?.className ?? "bg-sky-500/12 text-sky-500")}>
          <TypeIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-foreground">Agent output</p>
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[10px] font-medium",
                running ? "text-sky-600 dark:text-sky-300" : "text-muted-foreground",
              )}
            >
              {running && (
                <span className="size-1.5 animate-pulse rounded-full bg-sky-500 motion-reduce:animate-none" />
              )}
              {running ? "Live" : "Latest run"}
            </span>
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {node?.title ?? "Journey agent"} · {harness === "pi" ? "Pi" : "Codex"}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close agent output"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        <JourneyAgentOutputView threadId={threadId} harness={harness} />
      </div>
    </aside>
  );
}

function JourneyCanvasControls({
  onDirectionChange,
}: {
  onDirectionChange: (direction: "TB" | "LR") => void;
}) {
  const { fitView } = useReactFlow<JourneyFlowNode>();
  return (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-lg border border-border/60 bg-background/90 p-1 shadow-sm backdrop-blur">
      <button
        type="button"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Top to bottom"
        aria-label="Arrange top to bottom"
        onClick={() => onDirectionChange("TB")}
      >
        <ArrowDownIcon className="size-3.5" />
      </button>
      <button
        type="button"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Left to right"
        aria-label="Arrange left to right"
        onClick={() => onDirectionChange("LR")}
      >
        <ArrowRightIcon className="size-3.5" />
      </button>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <button
        type="button"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Fit graph"
        aria-label="Fit graph"
        onClick={() => void fitView({ padding: 0.18, duration: 250 })}
      >
        <Maximize2Icon className="size-3.5" />
      </button>
    </div>
  );
}

function latestAssistantItem(
  items: readonly { id: string; role: string; text: string; createdAt: string | null }[],
): { id: string; text: string; createdAt: string | null } | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.role === "assistant" && item.text.trim()) {
      return { id: item.id, text: item.text, createdAt: item.createdAt };
    }
  }
  return null;
}

function journeyHarnessForThread(harness: CodingHarness | undefined): JourneyHarness {
  return harness === "codexCli" ? "codexCli" : "pi";
}

export default function JourneyGraphView({ threadId }: { threadId: ThreadId }) {
  const thread = useStore((state) => state.threads.find((entry) => entry.id === threadId));
  const project = useStore((state) =>
    state.projects.find((entry) => entry.id === thread?.projectId),
  );
  const initialDestination = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, threadId).newThreadPromptDraft,
  );
  const clearNewThreadPromptDraft = useTerminalStateStore(
    (state) => state.clearNewThreadPromptDraft,
  );
  const dangerouslySkipPermissions = useTerminalStateStore(
    (state) => selectThreadTerminalState(state.terminalStateByThreadId, threadId).yoloMode,
  );
  const bootstrapDestinationRef = useRef(initialDestination.trim());
  const [destination, setDestination] = useState(initialDestination);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [agentMessage, setAgentMessage] = useState("");
  const [agentOutputNodeId, setAgentOutputNodeId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [agentRunNodeId, setAgentRunNodeId] = useState<string | null>(null);
  const pendingRunRef = useRef<{
    nodeId: string;
    finishing: boolean;
    baselineAssistantId: string | null;
    baselineAssistantText: string | null;
  } | null>(null);
  const journey = thread?.journey ?? null;
  const journeyHarness = journeyHarnessForThread(thread?.harness);

  const persistJourney = useCallback(
    async (snapshot: JourneySnapshot) => {
      const api = readNativeApi();
      if (!api) throw new Error("Clui is not connected to the server.");
      useStore.setState((state) => {
        const threads = updateThread(state.threads, threadId, (entry) => ({
          ...entry,
          journey: snapshot,
          updatedAt: snapshot.updatedAt,
        }));
        return threads === state.threads ? state : { threads };
      });
      await api.orchestration.dispatchCommand({
        type: "thread.journey.update",
        commandId: newCommandId(),
        threadId,
        journey: snapshot,
        createdAt: new Date().toISOString(),
      });
    },
    [threadId],
  );

  const failPendingRun = useCallback(
    async (error: unknown) => {
      const pending = pendingRunRef.current;
      pendingRunRef.current = null;
      setAgentRunNodeId(null);
      const message = error instanceof Error ? error.message : "The journey agent failed.";
      const current = useStore.getState().threads.find((entry) => entry.id === threadId)?.journey;
      if (pending && current) {
        const now = new Date().toISOString();
        const failed = withJourneyNode(current, pending.nodeId, (node) => ({
          ...node,
          status: "failed",
          activity: [
            ...node.activity,
            {
              id: `agent-error-${crypto.randomUUID()}`,
              kind: "system",
              summary: "Agent run failed",
              detailMarkdown: message,
              createdAt: now,
            },
          ],
          updatedAt: now,
        }));
        await persistJourney({ ...failed, activeNodeId: pending.nodeId }).catch(() => undefined);
      }
      toastManager.add({ type: "error", title: "Journey agent failed", description: message });
    },
    [persistJourney, threadId],
  );

  const finishAgentRun = useCallback(async () => {
    const pending = pendingRunRef.current;
    if (!pending || pending.finishing) return;
    pending.finishing = true;
    try {
      const api = readNativeApi();
      if (!api) throw new Error("Clui is not connected to the server.");
      let responseText: string | null = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (journeyHarness === "pi") {
          const transcript = await api.pi.getTranscript({ threadId });
          const candidate = latestAssistantItem(transcript.items);
          if (
            candidate &&
            (candidate.id !== pending.baselineAssistantId ||
              candidate.text !== pending.baselineAssistantText)
          ) {
            responseText = candidate.text;
            break;
          }
        } else {
          const scrollback = await api.claude.getScrollback({ threadId });
          responseText = latestCodexExecAgentMessage(scrollback.scrollback ?? "");
          if (responseText) break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
      if (!responseText) throw new Error("The journey agent completed without a new response.");
      const settled = settleJourneyAgentSnapshot(parseJourneyAgentResponse(responseText));
      const currentDirection =
        useStore.getState().threads.find((entry) => entry.id === threadId)?.journey
          ?.layoutDirection ?? settled.layoutDirection;
      await persistJourney({ ...settled, layoutDirection: currentDirection });
      pendingRunRef.current = null;
      setAgentRunNodeId(null);
      if (settled.activeNodeId) setExpandedNodeId(settled.activeNodeId);
    } catch (error) {
      await failPendingRun(error);
    }
  }, [failPendingRun, journeyHarness, persistJourney, threadId]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    const outputSubscription = registerHarnessOutputSubscription(api, journeyHarness, threadId);
    const handleSessionEvent = (event: ClaudeSessionEvent | PiSessionEvent) => {
      if (event.threadId !== threadId) return;
      if (event.type === "hookStatus" && event.hookStatus === "completed") {
        void finishAgentRun();
      }
      if ((event.type === "exited" || event.type === "hibernated") && pendingRunRef.current) {
        void finishAgentRun();
      }
      if (event.type === "error" && pendingRunRef.current) {
        void failPendingRun(new Error(event.message));
      }
    };
    const unsubscribe =
      journeyHarness === "pi"
        ? api.pi.onSessionEvent(handleSessionEvent)
        : api.claude.onSessionEvent(handleSessionEvent);
    return () => {
      outputSubscription.unsubscribe();
      unsubscribe();
    };
  }, [failPendingRun, finishAgentRun, journeyHarness, threadId]);

  useEffect(() => {
    const activeNode = journey?.nodes.find((node) => node.id === journey.activeNodeId);
    if (
      !activeNode ||
      !thread ||
      activeNode.status !== "running" ||
      thread.terminalStatus === "new" ||
      pendingRunRef.current
    ) {
      return;
    }

    let cancelled = false;
    const resumePendingRun = async () => {
      const api = readNativeApi();
      if (!api) return;
      if (journeyHarness === "codexCli") {
        const scrollback = await api.claude.getScrollback({ threadId });
        const hasCompletedResponse =
          latestCodexExecAgentMessage(scrollback.scrollback ?? "") !== null &&
          (thread.hookStatus === "completed" || thread.terminalStatus === "dormant");
        if (cancelled || pendingRunRef.current) return;
        pendingRunRef.current = {
          nodeId: activeNode.id,
          finishing: false,
          baselineAssistantId: null,
          baselineAssistantText: null,
        };
        setAgentRunNodeId(activeNode.id);
        if (hasCompletedResponse || thread.hookStatus === "completed") {
          await finishAgentRun();
          return;
        }
        if (thread.terminalStatus === "dormant") {
          throw new Error("The Codex journey agent stopped before returning a graph update.");
        }
        return;
      }

      const baselineItem = latestAssistantItem((await api.pi.getTranscript({ threadId })).items);
      const hasCompletedResponse =
        baselineItem?.createdAt != null &&
        baselineItem.createdAt >= activeNode.updatedAt &&
        (thread.hookStatus === "completed" || thread.terminalStatus === "dormant");
      if (cancelled || pendingRunRef.current) return;
      pendingRunRef.current = {
        nodeId: activeNode.id,
        finishing: false,
        baselineAssistantId: hasCompletedResponse ? null : (baselineItem?.id ?? null),
        baselineAssistantText: hasCompletedResponse ? null : (baselineItem?.text ?? null),
      };
      setAgentRunNodeId(activeNode.id);
      if (hasCompletedResponse) {
        await finishAgentRun();
        return;
      }
      if (thread.terminalStatus === "dormant") {
        throw new Error("The journey agent stopped before returning a graph update.");
      }
      if (
        useStore.getState().threads.find((entry) => entry.id === threadId)?.hookStatus ===
        "completed"
      ) {
        const latestItem = latestAssistantItem((await api.pi.getTranscript({ threadId })).items);
        if (
          latestItem &&
          (latestItem.id !== baselineItem?.id || latestItem.text !== baselineItem?.text)
        ) {
          await finishAgentRun();
        }
      }
    };
    void resumePendingRun().catch(failPendingRun);
    return () => {
      cancelled = true;
    };
  }, [failPendingRun, finishAgentRun, journey, journeyHarness, thread, threadId]);

  const runAgent = useCallback(
    async (snapshot: JourneySnapshot, nodeId: string, message = "") => {
      if (!thread || !project || pendingRunRef.current) return;
      const api = readNativeApi();
      if (!api) return;
      const cwd = thread.worktreePath ?? project.cwd;
      const now = new Date().toISOString();
      const runningSnapshot = {
        ...withJourneyNode(snapshot, nodeId, (node) => ({
          ...node,
          status: "running",
          activity: [
            ...node.activity,
            {
              id: `agent-start-${crypto.randomUUID()}`,
              kind: "agent" as const,
              summary: "Agent started working",
              detailMarkdown: message.trim(),
              createdAt: now,
            },
          ],
          updatedAt: now,
        })),
        activeNodeId: nodeId,
      } satisfies JourneySnapshot;
      pendingRunRef.current = {
        nodeId,
        finishing: false,
        baselineAssistantId: null,
        baselineAssistantText: null,
      };
      setAgentRunNodeId(nodeId);

      try {
        await persistJourney(runningSnapshot);
        const prompt = buildJourneyAgentPrompt({
          snapshot: runningSnapshot,
          focusNodeId: nodeId,
          userMessage: message,
        });

        if (journeyHarness === "codexCli") {
          await api.claude.start({
            threadId,
            cwd,
            cols: 120,
            rows: 32,
            executionMode: "exec",
            initialPrompt: prompt,
            ...(thread.claudeSessionId ? { resumeSessionId: thread.claudeSessionId } : {}),
            ...(dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
          });
          return;
        }

        const baselineTranscript = await api.pi.getTranscript({ threadId });
        const baselineAssistant = latestAssistantItem(baselineTranscript.items);
        if (pendingRunRef.current?.nodeId === nodeId) {
          pendingRunRef.current.baselineAssistantId = baselineAssistant?.id ?? null;
          pendingRunRef.current.baselineAssistantText = baselineAssistant?.text ?? null;
        }
        if (thread.terminalStatus === "active") {
          await api.pi.prompt({ threadId, message: prompt });
        } else {
          await api.pi.start({
            threadId,
            cwd,
            cols: 120,
            rows: 32,
            htmlMode: true,
            initialPrompt: prompt,
            ...(thread.piSessionFile ? { resumeSessionFile: thread.piSessionFile } : {}),
          });
        }
      } catch (error) {
        await failPendingRun(error);
      }
    },
    [
      dangerouslySkipPermissions,
      failPendingRun,
      journeyHarness,
      persistJourney,
      project,
      thread,
      threadId,
    ],
  );

  const handleStartJourney = useCallback(async () => {
    if (!destination.trim() || starting) return;
    setStarting(true);
    clearNewThreadPromptDraft(threadId);
    const snapshot = makeInitialJourney(destination);
    try {
      await persistJourney(snapshot);
      setExpandedNodeId("destination");
      await runAgent(
        snapshot,
        "destination",
        "Define the initial journey and its first useful frontier.",
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start journey",
        description: error instanceof Error ? error.message : "The journey could not be saved.",
      });
    } finally {
      setStarting(false);
    }
  }, [clearNewThreadPromptDraft, destination, persistJourney, runAgent, starting, threadId]);

  useEffect(() => {
    if (journey || !bootstrapDestinationRef.current) return;
    bootstrapDestinationRef.current = "";
    void handleStartJourney();
  }, [handleStartJourney, journey]);

  const handleToggleTodo = useCallback(
    (nodeId: string, todoId: string, completed: boolean) => {
      if (!journey) return;
      const updated = withJourneyNode(journey, nodeId, (node) => ({
        ...node,
        todos: node.todos.map((todo) => (todo.id === todoId ? { ...todo, completed } : todo)),
        updatedAt: new Date().toISOString(),
      }));
      void persistJourney(updated);
    },
    [journey, persistJourney],
  );

  const handleSubmitInteraction = useCallback(
    (nodeId: string, answers: Record<string, JourneyQuestionnaireAnswer>) => {
      if (!journey) return;
      const now = new Date().toISOString();
      const updated = withJourneyNode(journey, nodeId, (node) => ({
        ...node,
        status: "ready",
        interaction: node.interaction
          ? { ...node.interaction, answers, submittedAt: now }
          : node.interaction,
        activity: [
          ...node.activity,
          {
            id: `human-answer-${crypto.randomUUID()}`,
            kind: "human",
            summary: "Answered questionnaire",
            detailMarkdown: JSON.stringify(answers),
            createdAt: now,
          },
        ],
        updatedAt: now,
      }));
      void persistJourney(updated).then(() =>
        runAgent(updated, nodeId, `The user answered: ${JSON.stringify(answers)}`),
      );
    },
    [journey, persistJourney, runAgent],
  );

  const handleDirectionChange = useCallback(
    (layoutDirection: "TB" | "LR") => {
      if (!journey || journey.layoutDirection === layoutDirection) return;
      void persistJourney({ ...journey, layoutDirection, updatedAt: new Date().toISOString() });
    },
    [journey, persistJourney],
  );

  const layouts = useMemo(
    () => (journey ? layoutJourneyNodes(journey, expandedNodeId) : []),
    [expandedNodeId, journey],
  );
  const flowNodes = useMemo<JourneyFlowNode[]>(() => {
    if (!journey) return [];
    const layoutById = new Map(layouts.map((layout) => [layout.id, layout]));
    return journey.nodes.map((node) => {
      const layout = layoutById.get(node.id) ?? {
        x: 0,
        y: 0,
        width: JOURNEY_NODE_WIDTH,
        height: 146,
      };
      return {
        id: node.id,
        type: "journey",
        position: { x: layout.x, y: layout.y },
        data: {
          journeyNode: node,
          direction: journey.layoutDirection,
          expanded: expandedNodeId === node.id,
          agentWorking: journey.activeNodeId === node.id && agentRunNodeId === node.id,
          onToggleExpanded: (nodeId) =>
            setExpandedNodeId((current) => (current === nodeId ? null : nodeId)),
          onToggleTodo: handleToggleTodo,
          onSubmitInteraction: handleSubmitInteraction,
          onRunAgent: (nodeId, message) => void runAgent(journey, nodeId, message),
          onOpenAgentOutput: setAgentOutputNodeId,
        },
        draggable: true,
        selectable: true,
        style: { width: layout.width },
      };
    });
  }, [
    agentRunNodeId,
    expandedNodeId,
    handleSubmitInteraction,
    handleToggleTodo,
    journey,
    layouts,
    runAgent,
  ]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!journey) return [];
    return journey.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: "smoothstep",
      animated: edge.relation === "spawns",
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: {
        stroke:
          edge.relation === "dependsOn"
            ? "var(--muted-foreground)"
            : edge.relation === "spawns"
              ? "var(--primary)"
              : "var(--border)",
        strokeWidth: edge.relation === "dependsOn" ? 1.5 : 1.25,
      },
      labelStyle: { fontSize: 10, fill: "var(--muted-foreground)" },
      labelBgStyle: { fill: "var(--background)", fillOpacity: 0.92 },
    }));
  }, [journey]);

  const agentOutputNode = agentOutputNodeId
    ? (journey?.nodes.find((node) => node.id === agentOutputNodeId) ?? null)
    : null;
  const agentOutputRunning =
    agentOutputNode !== null &&
    journey?.activeNodeId === agentOutputNode.id &&
    (agentRunNodeId === agentOutputNode.id || agentOutputNode.status === "running");

  if (!thread || !project) return null;

  if (!journey) {
    return (
      <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_center,color-mix(in_srgb,var(--primary)_7%,transparent),transparent_58%)] p-6">
        <div className="w-full max-w-xl rounded-2xl border border-border/60 bg-card p-6 shadow-sm">
          <div className="mb-5 flex items-start gap-3">
            <span className="rounded-xl bg-primary/10 p-2.5 text-primary">
              <NetworkIcon className="size-5" />
            </span>
            <h1 className="pt-2 text-base font-semibold text-foreground">Start a journey</h1>
          </div>
          <Textarea
            autoFocus
            rows={6}
            value={destination}
            placeholder="What do you want to figure out, decide, or build?"
            onChange={(event) => setDestination(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleStartJourney();
              }
            }}
          />
          <div className="mt-4 flex justify-end">
            <Button
              disabled={!destination.trim() || starting}
              onClick={() => void handleStartJourney()}
            >
              {starting ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <SparklesIcon className="size-4" />
              )}
              Start journey
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="rounded-lg bg-primary/10 p-1.5 text-primary">
            <NetworkIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{journey.destination}</p>
            <p className="text-[10px] text-muted-foreground">
              {journey.nodes.length} nodes ·{" "}
              {journey.nodes.filter((node) => node.status === "waitingForUser").length} waiting for
              you · {journeyHarness === "pi" ? "Pi" : "Codex"}
            </p>
          </div>
        </div>
        <div className="flex min-w-[min(100%,28rem)] flex-1 items-center gap-1.5 sm:max-w-xl">
          <Input
            className="h-8 text-xs"
            value={agentMessage}
            placeholder="Ask the agent to adjust or advance the journey…"
            disabled={agentRunNodeId !== null}
            onChange={(event) => setAgentMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !agentMessage.trim()) return;
              const target = journey.activeNodeId ?? journey.nodes[0]?.id;
              if (!target) return;
              const message = agentMessage;
              setAgentMessage("");
              void runAgent(journey, target, message);
            }}
          />
          <Button
            type="button"
            size="sm"
            aria-label="Send to journey agent"
            disabled={!agentMessage.trim() || agentRunNodeId !== null}
            onClick={() => {
              const target = journey.activeNodeId ?? journey.nodes[0]?.id;
              if (!target) return;
              const message = agentMessage;
              setAgentMessage("");
              void runAgent(journey, target, message);
            }}
          >
            {agentRunNodeId ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <SendIcon className="size-3.5" />
            )}
          </Button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ReactFlowProvider>
            <ReactFlow<JourneyFlowNode>
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              fitView
              fitViewOptions={{ padding: 0.18, maxZoom: 1.05 }}
              minZoom={0.18}
              maxZoom={1.6}
              nodesConnectable={false}
              elementsSelectable
              proOptions={{ hideAttribution: false }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={1}
                color="var(--border)"
              />
              <MiniMap
                pannable
                zoomable
                className="!border !border-border/60 !bg-background/90"
                nodeColor={(node) => {
                  const status = (node.data as JourneyNodeData).journeyNode.status;
                  if (status === "waitingForUser") return "#f59e0b";
                  if (status === "running") return "#0ea5e9";
                  if (status === "completed") return "#10b981";
                  if (status === "failed") return "#ef4444";
                  return "#64748b";
                }}
              />
              <Controls showInteractive={false} position="bottom-left" />
              <JourneyCanvasControls onDirectionChange={handleDirectionChange} />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
        {agentOutputNodeId && (
          <JourneyAgentOutputPanel
            threadId={threadId}
            harness={journeyHarness}
            node={agentOutputNode}
            running={agentOutputRunning}
            onClose={() => setAgentOutputNodeId(null)}
          />
        )}
      </div>
    </div>
  );
}

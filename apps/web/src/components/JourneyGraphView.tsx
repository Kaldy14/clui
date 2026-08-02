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
  CornerDownRightIcon,
  FileCode2Icon,
  FlagIcon,
  FlaskConicalIcon,
  FocusIcon,
  HelpCircleIcon,
  LightbulbIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MessageSquareTextIcon,
  Minimize2Icon,
  NetworkIcon,
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
  JOURNEY_NODE_FOCUSED_WIDTH,
  JOURNEY_NODE_HEIGHT,
  JOURNEY_NODE_WIDTH,
  journeyNodeZIndex,
  layoutJourneyNodes,
  makeInitialJourney,
  nextAutomaticJourneyNodeId,
  parseJourneyAgentResponse,
  settleJourneyAgentSnapshot,
  toggleJourneyNodeFocusState,
  withJourneyNode,
} from "../lib/journeyGraph";
import { latestCodexExecAgentMessage } from "../lib/codexExecJsonl";
import { registerHarnessOutputSubscription } from "../lib/harnessOutputSubscriptions";
import { cn, newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { updateThread, useStore } from "../store";
import {
  selectThreadTerminalState,
  useTerminalStateStore,
  type JourneyPromptQueueItem,
} from "../terminalStateStore";
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
  focused: boolean;
  agentWorking: boolean;
  agentOutputOpen: boolean;
  onToggleExpanded: (nodeId: string) => void;
  onToggleFocus: (nodeId: string) => void;
  onToggleTodo: (nodeId: string, todoId: string, completed: boolean) => void;
  onSubmitInteraction: (
    nodeId: string,
    answers: Record<string, JourneyQuestionnaireAnswer>,
  ) => void;
  onRunAgent: (nodeId: string, message?: string) => void;
  onOpenAgentOutput: (nodeId: string) => void;
  onHeightChange: (nodeId: string, height: number, expanded: boolean, focused: boolean) => void;
};

type JourneyFlowNode = Node<JourneyNodeData, "journey">;
type JourneyHarness = Extract<CodingHarness, "pi" | "codexCli">;

const EMPTY_JOURNEY_PROMPT_QUEUE: readonly JourneyPromptQueueItem[] = [];

const JOURNEY_MINIMAP_NODE_COLORS: Record<JourneyNodeStatus, string> = {
  draft: "#64748b",
  ready: "#8b5cf6",
  running: "#0ea5e9",
  waitingForUser: "#f59e0b",
  blocked: "#94a3b8",
  completed: "#10b981",
  failed: "#ef4444",
  cancelled: "#64748b",
  superseded: "#64748b",
};

function journeyMiniMapNodeColor(node: JourneyFlowNode): string {
  return JOURNEY_MINIMAP_NODE_COLORS[node.data.journeyNode.status];
}

const NODE_TYPE_PRESENTATION: Record<
  JourneyNodeType,
  { label: string; className: string; textClassName: string; icon: typeof FlagIcon }
> = {
  goal: {
    label: "Goal",
    className: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
    textClassName: "text-violet-700 dark:text-violet-300",
    icon: FlagIcon,
  },
  question: {
    label: "Question",
    className: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
    textClassName: "text-amber-700 dark:text-amber-300",
    icon: HelpCircleIcon,
  },
  proposal: {
    label: "Proposal",
    className: "bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300",
    textClassName: "text-fuchsia-700 dark:text-fuchsia-300",
    icon: LightbulbIcon,
  },
  task: {
    label: "Task",
    className: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
    textClassName: "text-blue-700 dark:text-blue-300",
    icon: SquareCheckBigIcon,
  },
  todoGroup: {
    label: "Todos",
    className: "bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
    textClassName: "text-cyan-700 dark:text-cyan-300",
    icon: ListChecksIcon,
  },
  research: {
    label: "Research",
    className: "bg-teal-500/12 text-teal-700 dark:text-teal-300",
    textClassName: "text-teal-700 dark:text-teal-300",
    icon: FlaskConicalIcon,
  },
  implementation: {
    label: "Implementation",
    className: "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300",
    textClassName: "text-indigo-700 dark:text-indigo-300",
    icon: FileCode2Icon,
  },
  review: {
    label: "Review",
    className: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    textClassName: "text-emerald-700 dark:text-emerald-300",
    icon: ShieldCheckIcon,
  },
  note: {
    label: "Note",
    className: "bg-slate-500/12 text-slate-700 dark:text-slate-300",
    textClassName: "text-slate-700 dark:text-slate-300",
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
    <section className="nodrag nowheel space-y-5" aria-label={interaction.title}>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{interaction.title}</p>
          {interaction.description && (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {interaction.description}
            </p>
          )}
        </div>
        {interaction.steps.length > 1 && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {stepIndex + 1} of {interaction.steps.length}
          </span>
        )}
      </header>

      <div className="border-l-2 border-amber-500/60 pl-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300">
          {step.title}
        </p>
        {step.description && (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.description}</p>
        )}
      </div>

      <div className="space-y-5">
        {step.fields.map((field) => {
          const inputId = `journey-${node.id}-${field.id}`;
          return (
            <div key={field.id} className="space-y-2 text-xs text-foreground">
              <div>
                <label
                  htmlFor={field.type === "text" ? inputId : undefined}
                  className="font-medium"
                >
                  {field.label}
                  {field.required ? <span className="ml-1 text-amber-600">*</span> : null}
                </label>
                {field.description && (
                  <p className="mt-1 leading-5 text-muted-foreground">{field.description}</p>
                )}
              </div>

              {field.type === "text" &&
                (field.multiline ? (
                  <Textarea
                    id={inputId}
                    className="min-h-24 resize-y text-xs"
                    value={
                      typeof answers[field.id] === "string" ? (answers[field.id] as string) : ""
                    }
                    placeholder={field.placeholder}
                    onChange={(event) => updateAnswer(field.id, event.target.value)}
                  />
                ) : (
                  <Input
                    id={inputId}
                    className="h-9 text-xs"
                    value={
                      typeof answers[field.id] === "string" ? (answers[field.id] as string) : ""
                    }
                    placeholder={field.placeholder}
                    onChange={(event) => updateAnswer(field.id, event.target.value)}
                  />
                ))}

              {field.type === "boolean" && (
                <label className="flex items-center gap-2 py-1 text-muted-foreground">
                  <Checkbox
                    checked={answers[field.id] === true}
                    onCheckedChange={(checked) => updateAnswer(field.id, checked === true)}
                  />
                  <span>{answers[field.id] === true ? "Yes" : "No"}</span>
                </label>
              )}

              {(field.type === "singleChoice" || field.type === "multiChoice") && (
                <fieldset className="divide-y divide-border/50 border-y border-border/50">
                  <legend className="sr-only">{field.label}</legend>
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
                          "flex w-full items-start gap-3 py-3 text-left transition-colors",
                          selected
                            ? "text-foreground"
                            : "text-muted-foreground hover:text-foreground",
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
                        <span
                          className={cn(
                            "mt-1 size-2 shrink-0 rounded-full border border-current",
                            selected && "bg-amber-500 text-amber-500",
                          )}
                          aria-hidden="true"
                        />
                        <span className="min-w-0">
                          <span className="block font-medium">{option.label}</span>
                          {option.description && (
                            <span className="mt-1 block text-[11px] leading-4 opacity-75">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </fieldset>
              )}
            </div>
          );
        })}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border/50 pt-4">
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
      </footer>
    </section>
  );
}

function JourneyNodeCard({ data }: NodeProps<JourneyFlowNode>) {
  const node = data.journeyNode;
  const articleRef = useRef<HTMLElement>(null);
  const type = NODE_TYPE_PRESENTATION[node.type];
  const status = NODE_STATUS_PRESENTATION[node.status];
  const StatusIcon = status.icon;
  const targetPosition = data.direction === "TB" ? Position.Top : Position.Left;
  const sourcePosition = data.direction === "TB" ? Position.Bottom : Position.Right;
  const hasAgentOutput = data.agentWorking || node.activity.some((entry) => entry.kind === "agent");
  const { expanded, focused, onHeightChange } = data;

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const reportHeight = () => onHeightChange(node.id, article.offsetHeight, expanded, focused);
    reportHeight();
    const observer = new ResizeObserver(reportHeight);
    observer.observe(article);
    return () => observer.disconnect();
  }, [expanded, focused, node.id, onHeightChange]);

  return (
    <article
      ref={articleRef}
      aria-label={`${type.label}: ${node.title}. ${status.label}`}
      className={cn(
        "group rounded-xl border bg-card text-card-foreground shadow-sm transition-[border-color,box-shadow,opacity]",
        status.className,
        data.focused
          ? "shadow-xl ring-2 ring-primary/20"
          : data.expanded
            ? "shadow-lg"
            : "hover:shadow-md",
        node.status === "cancelled" || node.status === "superseded" ? "opacity-60" : "",
      )}
      style={{
        width: data.focused
          ? JOURNEY_NODE_FOCUSED_WIDTH
          : data.expanded
            ? JOURNEY_NODE_EXPANDED_WIDTH
            : JOURNEY_NODE_WIDTH,
      }}
    >
      <Handle
        type="target"
        position={targetPosition}
        className="!size-2 !border-0 !bg-muted-foreground/45"
      />
      <div className="flex items-start gap-1.5 px-3 py-2.5">
        <button
          type="button"
          className="nodrag min-w-0 flex-1 text-left"
          onClick={() => data.onToggleExpanded(node.id)}
        >
          <span className="block min-w-0">
            <span className="flex items-center gap-1.5 text-[10px] font-semibold leading-3.5">
              <span className={cn("truncate", type.textClassName)}>{type.label}</span>
              <span className="h-2.5 w-px shrink-0 bg-border/70" aria-hidden="true" />
              <span className="inline-flex min-w-0 items-center gap-1">
                <StatusIcon
                  className={cn(
                    "size-2.5 shrink-0",
                    status.pulse ? "animate-spin motion-reduce:animate-none" : "",
                  )}
                  aria-hidden="true"
                />
                <span className="truncate">
                  {data.agentWorking ? "Agent working" : status.label}
                </span>
              </span>
            </span>
            <span className="mt-1 block break-words text-[13px] font-semibold leading-4 text-foreground">
              {node.title}
            </span>
          </span>
        </button>
        <div className="nodrag flex shrink-0 items-center gap-0.5">
          {hasAgentOutput && (
            <button
              type="button"
              className={cn(
                "rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                data.agentOutputOpen &&
                  "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
              )}
              title={data.agentWorking ? "View live agent output" : "View agent output"}
              aria-label={`${data.agentWorking ? "View live agent output" : "View agent output"}: ${node.title}`}
              aria-pressed={data.agentOutputOpen}
              onClick={() => data.onOpenAgentOutput(node.id)}
            >
              <BotIcon className="size-3" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className={cn(
              "rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              data.focused && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
            )}
            title={data.focused ? "Close node and return to graph" : "Focus node"}
            aria-label={
              data.focused
                ? `Close node and return to graph: ${node.title}`
                : `Focus node: ${node.title}`
            }
            aria-pressed={data.focused}
            onClick={() => data.onToggleFocus(node.id)}
          >
            {data.focused ? (
              <Minimize2Icon className="size-3" aria-hidden="true" />
            ) : (
              <FocusIcon className="size-3" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={data.expanded ? "Collapse node" : "Expand node"}
            aria-label={
              data.expanded ? `Collapse node: ${node.title}` : `Expand node: ${node.title}`
            }
            aria-expanded={data.expanded}
            onClick={() => data.onToggleExpanded(node.id)}
          >
            <ChevronDownIcon
              className={cn("size-3 transition-transform", data.expanded && "rotate-180")}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {data.expanded && (
        <div className="nodrag nowheel space-y-4 border-t border-border/50 px-3 py-3">
          {node.summary && (
            <p className="text-xs leading-4 text-muted-foreground">{node.summary}</p>
          )}

          {node.detailMarkdown && (
            <div className="journey-markdown prose prose-sm max-w-none text-xs leading-5 text-foreground dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.detailMarkdown}</ReactMarkdown>
            </div>
          )}

          {node.todos.length > 0 && (
            <section className="space-y-2 border-t border-border/50 pt-3">
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
            </section>
          )}

          {node.interaction && node.status === "waitingForUser" && (
            <div className="border-t border-border/50 pt-3">
              <JourneyInteractionForm
                key={node.interaction.id}
                node={node}
                onSubmit={(answers) => data.onSubmitInteraction(node.id, answers)}
              />
            </div>
          )}

          {node.activity.length > 0 && (
            <section className="space-y-2 border-t border-border/50 pt-3">
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
            </section>
          )}

          {node.status === "failed" && (
            <footer className="flex justify-end border-t border-border/50 pt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  data.onRunAgent(
                    node.id,
                    `Retry the failed work in "${node.title}". Inspect the recorded failure first and either complete the work or record the concrete blocker.`,
                  )
                }
              >
                <RotateCcwIcon className="size-3.5" /> Retry failed node
              </Button>
            </footer>
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
          <p className="break-words text-[11px] leading-4 text-muted-foreground">
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

function JourneyViewportFocus({
  focusedNodeId,
  revision,
}: {
  focusedNodeId: string | null;
  revision: string;
}) {
  const { fitView } = useReactFlow<JourneyFlowNode>();
  const previousFocusedNodeIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (previousFocusedNodeIdRef.current === focusedNodeId && !focusedNodeId) return;
    previousFocusedNodeIdRef.current = focusedNodeId;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        void fitView(
          focusedNodeId
            ? {
                nodes: [{ id: focusedNodeId }],
                padding: 0.08,
                minZoom: 0.7,
                maxZoom: 1.85,
                duration: 320,
              }
            : { padding: 0.18, maxZoom: 1.05, duration: 280 },
        );
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [fitView, focusedNodeId, revision]);

  return null;
}

function JourneyHeaderControls({
  direction,
  focusedNodeId,
  onClearFocus,
  onDirectionChange,
}: {
  direction: "TB" | "LR";
  focusedNodeId: string | null;
  onClearFocus: () => void;
  onDirectionChange: (direction: "TB" | "LR") => void;
}) {
  const { fitView } = useReactFlow<JourneyFlowNode>();
  const controlClassName = (active: boolean) =>
    cn(
      "rounded-md p-1.5 transition-colors hover:bg-muted hover:text-foreground",
      active ? "bg-muted text-foreground" : "text-muted-foreground",
    );
  const changeDirection = (nextDirection: "TB" | "LR") => {
    onDirectionChange(nextDirection);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void fitView({ padding: 0.18, maxZoom: 1.05, duration: 250 });
      });
    });
  };
  return (
    <div className="flex shrink-0 items-center gap-0.5" aria-label="Journey graph layout controls">
      <button
        type="button"
        className={controlClassName(direction === "TB")}
        title="Top to bottom"
        aria-label="Arrange top to bottom"
        aria-pressed={direction === "TB"}
        onClick={() => changeDirection("TB")}
      >
        <ArrowDownIcon className="size-3.5" />
      </button>
      <button
        type="button"
        className={controlClassName(direction === "LR")}
        title="Left to right"
        aria-label="Arrange left to right"
        aria-pressed={direction === "LR"}
        onClick={() => changeDirection("LR")}
      >
        <ArrowRightIcon className="size-3.5" />
      </button>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <button
        type="button"
        className={controlClassName(false)}
        title="Fit graph"
        aria-label="Fit graph"
        onClick={() => {
          onClearFocus();
          if (!focusedNodeId) void fitView({ padding: 0.18, maxZoom: 1.05, duration: 250 });
        }}
      >
        <Maximize2Icon className="size-3.5" />
      </button>
    </div>
  );
}

function JourneyPromptComposer({
  message,
  queue,
  agentBusy,
  expanded,
  onMessageChange,
  onExpandedChange,
  onRemoveQueuedPrompt,
  onSubmit,
}: {
  message: string;
  queue: readonly JourneyPromptQueueItem[];
  agentBusy: boolean;
  expanded: boolean;
  onMessageChange: (message: string) => void;
  onExpandedChange: (expanded: boolean) => void;
  onRemoveQueuedPrompt: (promptId: string) => void;
  onSubmit: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !expanded) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 80), 176)}px`;
  }, [expanded, message]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-auto w-full max-w-3xl overflow-hidden rounded-xl border border-border/70 bg-background/96 shadow-xl backdrop-blur-md"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        const focusRemainsInside =
          nextTarget instanceof Node && containerRef.current?.contains(nextTarget);
        if (message.trim().length === 0 && !focusRemainsInside) {
          onExpandedChange(false);
        }
      }}
    >
      {queue.length > 0 && (
        <div
          className="max-h-48 divide-y divide-border/50 overflow-y-auto border-b border-border/60"
          aria-live="polite"
        >
          {queue.map((item, index) => (
            <div key={item.id} className="flex h-9 items-center gap-2 px-3 text-xs">
              <CornerDownRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground">{item.message}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {index === 0 ? "Next" : `Queued ${index + 1}`}
              </span>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={`Remove queued prompt: ${item.message}`}
                title="Remove from queue"
                onClick={() => onRemoveQueuedPrompt(item.id)}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        className={cn(
          "flex items-end gap-2 transition-[padding]",
          expanded ? "p-2.5" : "p-1.5 pl-3",
        )}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={message}
          aria-label="Prompt the Journey agent"
          placeholder={agentBusy ? "Add a prompt to the agent queue…" : "Prompt the Journey agent…"}
          className={cn(
            "min-w-0 flex-1 resize-none bg-transparent px-0 py-1.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground/60",
            expanded ? "min-h-20" : "h-8 overflow-hidden whitespace-nowrap",
          )}
          onFocus={() => onExpandedChange(true)}
          onClick={() => onExpandedChange(true)}
          onChange={(event) => onMessageChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && message.trim().length === 0) {
              onExpandedChange(false);
              event.currentTarget.blur();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <Button
          type="submit"
          size="icon-sm"
          className="mb-0.5 shrink-0"
          disabled={!message.trim()}
          aria-label={agentBusy ? "Queue prompt" : "Send prompt"}
          title={agentBusy ? "Queue prompt" : "Send prompt"}
        >
          <SendIcon className="size-3.5" />
        </Button>
      </form>
      {expanded && (
        <div className="flex items-center justify-between border-t border-border/50 px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>
            {agentBusy ? "The agent is working · this prompt will be queued" : "Agent ready"}
          </span>
          <span>Enter to send · Shift+Enter for newline</span>
        </div>
      )}
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
  const journeyPromptQueue = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, threadId).journeyPromptQueue ??
      EMPTY_JOURNEY_PROMPT_QUEUE,
  );
  const enqueueJourneyPrompt = useTerminalStateStore((state) => state.enqueueJourneyPrompt);
  const removeJourneyPrompt = useTerminalStateStore((state) => state.removeJourneyPrompt);
  const dangerouslySkipPermissions = useTerminalStateStore(
    (state) => selectThreadTerminalState(state.terminalStateByThreadId, threadId).yoloMode,
  );
  const bootstrapDestinationRef = useRef(initialDestination.trim());
  const [destination, setDestination] = useState(initialDestination);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [agentMessage, setAgentMessage] = useState("");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [agentOutputNodeId, setAgentOutputNodeId] = useState<string | null>(null);
  const [nodeMeasurements, setNodeMeasurements] = useState<
    Record<string, { height: number; expanded: boolean; focused: boolean }>
  >({});
  const [starting, setStarting] = useState(false);
  const [agentRunNodeId, setAgentRunNodeId] = useState<string | null>(null);
  const pendingRunRef = useRef<{
    nodeId: string;
    finishing: boolean;
    baselineJourneyUpdatedAt: string;
    baselineAssistantId: string | null;
    baselineAssistantText: string | null;
  } | null>(null);
  const queueLaunchRef = useRef<string | null>(null);
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
      const readModel = await api.orchestration.getSnapshot();
      const serverJourney =
        readModel.threads.find((entry) => entry.id === threadId)?.journey ?? null;
      const hasLiveToolUpdates =
        serverJourney !== null && serverJourney.updatedAt !== pending.baselineJourneyUpdatedAt;
      let settled: JourneySnapshot;
      if (hasLiveToolUpdates) {
        settled = settleJourneyAgentSnapshot(serverJourney);
      } else {
        if (!responseText) throw new Error("The journey agent completed without a graph update.");
        settled = settleJourneyAgentSnapshot(parseJourneyAgentResponse(responseText));
      }
      const currentDirection = serverJourney?.layoutDirection ?? settled.layoutDirection;
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
    const declaredActiveNode = journey?.nodes.find((node) => node.id === journey.activeNodeId);
    const activeNode =
      declaredActiveNode?.status === "running"
        ? declaredActiveNode
        : journey?.nodes.find((node) => node.status === "running");
    if (
      !journey ||
      !activeNode ||
      !thread ||
      activeNode.status !== "running" ||
      thread.terminalStatus === "new" ||
      pendingRunRef.current
    ) {
      return;
    }
    const baselineJourneyUpdatedAt = journey.updatedAt;

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
          baselineJourneyUpdatedAt,
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
        baselineJourneyUpdatedAt,
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
      if (!thread || !project || pendingRunRef.current) return false;
      const api = readNativeApi();
      if (!api) return false;
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
        baselineJourneyUpdatedAt: runningSnapshot.updatedAt,
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
          return true;
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
        return true;
      } catch (error) {
        await failPendingRun(error);
        return true;
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

  const queueAgentPrompt = useCallback(
    (nodeId: string, message?: string) => {
      const normalizedMessage = message?.trim() || "Continue working from this node.";
      enqueueJourneyPrompt(threadId, {
        id: `journey-prompt-${crypto.randomUUID()}`,
        message: normalizedMessage,
        nodeId,
        createdAt: new Date().toISOString(),
      });
    },
    [enqueueJourneyPrompt, threadId],
  );

  useEffect(() => {
    const nextPrompt = journeyPromptQueue[0];
    const automaticNodeId = journey ? nextAutomaticJourneyNodeId(journey) : null;
    if (
      !journey ||
      (!nextPrompt && !automaticNodeId) ||
      queueLaunchRef.current ||
      pendingRunRef.current ||
      agentRunNodeId !== null ||
      journey.nodes.some((node) => node.status === "running")
    ) {
      return;
    }

    const nodeId = nextPrompt
      ? journey.nodes.some((node) => node.id === nextPrompt.nodeId)
        ? nextPrompt.nodeId
        : (journey.activeNodeId ?? journey.nodes[0]?.id)
      : automaticNodeId;
    if (!nodeId) {
      if (nextPrompt) removeJourneyPrompt(threadId, nextPrompt.id);
      return;
    }

    const automaticNode = journey.nodes.find((node) => node.id === nodeId);
    queueLaunchRef.current =
      nextPrompt?.id ?? `automatic:${nodeId}:${automaticNode?.updatedAt ?? ""}`;
    const launch = runAgent(
      journey,
      nodeId,
      nextPrompt?.message ??
        `Continue the concrete work in "${automaticNode?.title ?? nodeId}" autonomously. Do not create future placeholder nodes; perform the work now and record the real result.`,
    );
    void launch
      .then((consumed) => {
        if (consumed && nextPrompt) removeJourneyPrompt(threadId, nextPrompt.id);
      })
      .finally(() => {
        queueLaunchRef.current = null;
      });
  }, [agentRunNodeId, journey, journeyPromptQueue, removeJourneyPrompt, runAgent, threadId]);

  const handleSubmitAgentMessage = useCallback(() => {
    const message = agentMessage.trim();
    if (!message || !journey) return;
    const target = journey.activeNodeId ?? journey.nodes[0]?.id;
    if (!target) return;
    queueAgentPrompt(target, message);
    setAgentMessage("");
    setComposerExpanded(false);
  }, [agentMessage, journey, queueAgentPrompt]);

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
        "Start concrete work toward the destination now. Create only nodes for work you are actively starting, real results, or genuine human/external blockers; do not prebuild a roadmap of future placeholder nodes.",
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
      queueAgentPrompt(nodeId, `The user answered: ${JSON.stringify(answers)}`);
      void persistJourney(updated);
    },
    [journey, persistJourney, queueAgentPrompt],
  );

  const handleDirectionChange = useCallback(
    (layoutDirection: "TB" | "LR") => {
      if (!journey || journey.layoutDirection === layoutDirection) return;
      void persistJourney({ ...journey, layoutDirection, updatedAt: new Date().toISOString() });
    },
    [journey, persistJourney],
  );

  const handleToggleNodeExpanded = useCallback(
    (nodeId: string) => {
      const collapsing = expandedNodeId === nodeId;
      setExpandedNodeId(collapsing ? null : nodeId);
      if (collapsing && focusedNodeId === nodeId) setFocusedNodeId(null);
    },
    [expandedNodeId, focusedNodeId],
  );

  const handleToggleNodeFocus = useCallback(
    (nodeId: string) => {
      const next = toggleJourneyNodeFocusState(nodeId, focusedNodeId);
      setFocusedNodeId(next.focusedNodeId);
      setExpandedNodeId(next.expandedNodeId);
      if (next.focusedNodeId) {
        setAgentOutputNodeId(null);
      }
    },
    [focusedNodeId],
  );

  useEffect(() => {
    if (!focusedNodeId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFocusedNodeId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusedNodeId]);

  useEffect(() => {
    if (focusedNodeId && !journey?.nodes.some((node) => node.id === focusedNodeId)) {
      setFocusedNodeId(null);
    }
  }, [focusedNodeId, journey]);

  const handleNodeHeightChange = useCallback(
    (nodeId: string, height: number, expanded: boolean, focused: boolean) => {
      const roundedHeight = Math.ceil(height);
      setNodeMeasurements((current) => {
        const previous = current[nodeId];
        if (
          previous?.height === roundedHeight &&
          previous.expanded === expanded &&
          previous.focused === focused
        ) {
          return current;
        }
        return { ...current, [nodeId]: { height: roundedHeight, expanded, focused } };
      });
    },
    [],
  );

  const measuredHeights = useMemo<Record<string, number>>(() => {
    if (!journey) return {};
    const heights: Record<string, number> = {};
    for (const node of journey.nodes) {
      const measurement = nodeMeasurements[node.id];
      if (
        measurement &&
        measurement.expanded === (expandedNodeId === node.id) &&
        measurement.focused === (focusedNodeId === node.id)
      ) {
        heights[node.id] = measurement.height;
      }
    }
    return heights;
  }, [expandedNodeId, focusedNodeId, journey, nodeMeasurements]);

  const layouts = useMemo(
    () =>
      journey ? layoutJourneyNodes(journey, expandedNodeId, focusedNodeId, measuredHeights) : [],
    [expandedNodeId, focusedNodeId, journey, measuredHeights],
  );
  const flowNodes = useMemo<JourneyFlowNode[]>(() => {
    if (!journey) return [];
    const layoutById = new Map(layouts.map((layout) => [layout.id, layout]));
    return journey.nodes.map((node) => {
      const layout = layoutById.get(node.id) ?? {
        x: 0,
        y: 0,
        width: JOURNEY_NODE_WIDTH,
        height: JOURNEY_NODE_HEIGHT,
      };
      return {
        id: node.id,
        type: "journey",
        position: { x: layout.x, y: layout.y },
        data: {
          journeyNode: node,
          direction: journey.layoutDirection,
          expanded: expandedNodeId === node.id,
          focused: focusedNodeId === node.id,
          agentWorking:
            agentRunNodeId !== null &&
            journey.activeNodeId === node.id &&
            node.status === "running",
          agentOutputOpen: agentOutputNodeId === node.id,
          onToggleExpanded: handleToggleNodeExpanded,
          onToggleFocus: handleToggleNodeFocus,
          onToggleTodo: handleToggleTodo,
          onSubmitInteraction: handleSubmitInteraction,
          onRunAgent: queueAgentPrompt,
          onOpenAgentOutput: setAgentOutputNodeId,
          onHeightChange: handleNodeHeightChange,
        },
        draggable: focusedNodeId !== node.id,
        selectable: true,
        zIndex: journeyNodeZIndex(expandedNodeId === node.id, focusedNodeId === node.id),
        width: layout.width,
        height: layout.height,
      };
    });
  }, [
    agentRunNodeId,
    agentOutputNodeId,
    expandedNodeId,
    focusedNodeId,
    handleSubmitInteraction,
    handleToggleNodeExpanded,
    handleToggleNodeFocus,
    handleToggleTodo,
    handleNodeHeightChange,
    journey,
    layouts,
    queueAgentPrompt,
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
    <ReactFlowProvider>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <span className="rounded-md bg-primary/10 p-1 text-primary">
            <NetworkIcon className="size-3.5" />
          </span>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <p className="min-w-0 truncate text-xs font-semibold text-foreground">
              {journey.destination}
            </p>
            <p className="hidden shrink-0 text-[10px] text-muted-foreground sm:block">
              {journey.nodes.length} nodes ·{" "}
              {journey.nodes.filter((node) => node.status === "waitingForUser").length} waiting ·{" "}
              {journeyHarness === "pi" ? "Pi" : "Codex"}
              {journeyPromptQueue.length > 0 ? ` · ${journeyPromptQueue.length} queued` : ""}
            </p>
          </div>
          <JourneyHeaderControls
            direction={journey.layoutDirection}
            focusedNodeId={focusedNodeId}
            onClearFocus={() => setFocusedNodeId(null)}
            onDirectionChange={handleDirectionChange}
          />
        </header>

        <div className="relative flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
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
              elevateNodesOnSelect={false}
              proOptions={{ hideAttribution: false }}
            >
              <JourneyViewportFocus
                focusedNodeId={focusedNodeId}
                revision={focusedNodeId ? journey.updatedAt : ""}
              />
              <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={1}
                color="var(--border)"
              />
              <MiniMap<JourneyFlowNode>
                pannable
                zoomable
                ariaLabel="Journey graph overview"
                className="journey-minimap"
                bgColor="color-mix(in srgb, var(--background) 96%, var(--foreground))"
                maskColor="color-mix(in srgb, var(--background) 38%, transparent)"
                maskStrokeColor="color-mix(in srgb, var(--foreground) 36%, transparent)"
                maskStrokeWidth={1.5}
                nodeBorderRadius={10}
                nodeColor={journeyMiniMapNodeColor}
                nodeStrokeColor={journeyMiniMapNodeColor}
                nodeStrokeWidth={2}
              />
              <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3 sm:px-5">
              <JourneyPromptComposer
                message={agentMessage}
                queue={journeyPromptQueue}
                agentBusy={
                  agentRunNodeId !== null || journey.nodes.some((node) => node.status === "running")
                }
                expanded={composerExpanded}
                onMessageChange={setAgentMessage}
                onExpandedChange={setComposerExpanded}
                onRemoveQueuedPrompt={(promptId) => removeJourneyPrompt(threadId, promptId)}
                onSubmit={handleSubmitAgentMessage}
              />
            </div>
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
    </ReactFlowProvider>
  );
}

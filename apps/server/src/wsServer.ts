/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import http from "node:http";
import type { Duplex } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  type ClientOrchestrationCommand,
  type ClaudeSessionEvent,
  type OrchestrationCommand,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  MCP_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ThreadId,
  TerminalEvent,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  WsPush,
  WsResponse,
} from "@clui/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
  Struct,
} from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { ClaudeSessionManager } from "./terminal/Services/ClaudeSession.ts";
import { Keybindings } from "./keybindings";
import { searchWorkspaceEntries } from "./workspaceEntries";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { CheckpointReactor } from "./orchestration/Services/CheckpointReactor";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { clamp } from "effect/Number";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { expandHomePath } from "./os-jank.ts";
import {
  readRequestBody,
  buildStopEvents,
  buildNotificationEvents,
  buildUserPromptSubmitEvents,
  buildPermissionRequestEvents,
  buildPostToolUseEvents,
} from "./hooks/hookReceiver";
import { extractPromptText } from "./terminal/titleGenerator";
import { ProjectionThreadRepository } from "./persistence/Services/ProjectionThreads.ts";
import { TextGeneration } from "./git/Services/TextGeneration.ts";

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError,
    Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<void, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/wsServer/Server") {}

const isServerNotRunningError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
}

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks: string[] = [];
    for (const chunk of raw) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
        continue;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        continue;
      }
      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(new Uint8Array(chunk)).toString("utf8"));
        continue;
      }
      return null;
    }
    return chunks.join("");
  }
  return null;
}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

/**
 * Walk up from `startDir` to find the nearest directory containing `.git`.
 * Returns the git root path, or `startDir` if no `.git` is found within 10 levels.
 */
function findGitRoot(
  startDir: string,
  pathModule: Path.Path,
  fs: FileSystem.FileSystem,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    let candidate = pathModule.resolve(startDir);
    for (let i = 0; i < 10; i++) {
      const gitDir = pathModule.join(candidate, ".git");
      const exists = yield* fs
        .stat(gitDir)
        .pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)));
      if (exists) return candidate;
      const parent = pathModule.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    return startDir;
  });
}

function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const absolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, absolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    absolutePath,
    relativePath: relativeToRoot,
  });
}

function inferLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    json: "json", css: "css", html: "html", md: "markdown",
    py: "python", rs: "rust", go: "go", yaml: "yaml", yml: "yaml",
    sh: "shell", bash: "shell", zsh: "shell",
    sql: "sql", graphql: "graphql", xml: "xml", svg: "xml",
  };
  return langMap[ext] ?? "text";
}

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

function messageFromCause(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  const message = squashed instanceof Error ? squashed.message.trim() : String(squashed).trim();
  return message.length > 0 ? message : Cause.pretty(cause);
}

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | OrchestrationReactor
  | CheckpointReactor;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | GitManager
  | GitCore
  | TextGeneration
  | TerminalManager
  | ClaudeSessionManager
  | Keybindings
  | Open
  | AnalyticsService
  | ProjectionThreadRepository;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
}) {}

export const createServer = Effect.fn(function* (): Effect.fn.Return<
  http.Server,
  ServerLifecycleError,
  Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const {
    port,
    cwd,
    keybindingsConfigPath,
    staticDir,
    devUrl,
    authToken,
    host,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;
  const availableEditors = resolveAvailableEditors();

  const textGeneration = yield* TextGeneration;
  const gitManager = yield* GitManager;

  const terminalManager = yield* TerminalManager;
  const claudeSessionManager = yield* ClaudeSessionManager;
  const keybindingsManager = yield* Keybindings;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );

  const clients = yield* Ref.make(new Set<WebSocket>());
  const logger = createLogger("ws");

  function logOutgoingPush(push: WsPush, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      recipients,
      payload: push.data,
    });
  }

  const encodePush = Schema.encodeEffect(Schema.fromJsonString(WsPush));
  const broadcastPush = Effect.fnUntraced(function* (push: WsPush) {
    const message = yield* encodePush(push);
    let recipients = 0;
    for (const client of yield* Ref.get(clients)) {
      if (client.readyState === client.OPEN) {
        client.send(message);
        recipients += 1;
      }
    }
    logOutgoingPush(push, recipients);
  });

  const onTerminalEvent = Effect.fnUntraced(function* (event: TerminalEvent) {
    yield* broadcastPush({
      type: "push",
      channel: WS_CHANNELS.terminalEvent,
      data: event,
    });
  });

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
  }) {
    const normalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
      const normalizedWorkspaceRoot = path.resolve(yield* expandHomePath(workspaceRoot.trim()));
      const workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!workspaceStat) {
        return yield* new RouteRequestError({
          message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
        });
      }
      if (workspaceStat.type !== "Directory") {
        return yield* new RouteRequestError({
          message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
        });
      }
      return normalizedWorkspaceRoot;
    });

    if (input.command.type === "project.create") {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type === "project.meta.update" && input.command.workspaceRoot !== undefined) {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new RouteRequestError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new RouteRequestError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* new RouteRequestError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            stateDir: serverConfig.stateDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new RouteRequestError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

  // Track threads that have already been auto-titled (in-memory, per server session)
  const autoTitledThreads = new Set<string>();

  // Track pending approval requestIds per thread so we can dispatch matching
  // approval.resolved activities when post-tool-use or stop hooks fire.
  // Uses a Set to handle multiple pending approvals (e.g. when a user rejects
  // a tool — no post-tool-use fires — and Claude proposes another).
  const pendingApprovalRequestIdsByThread = new Map<string, Set<string>>();

  const dispatchApprovalActivity = (
    threadId: string,
    kind: "approval.requested" | "approval.resolved",
    requestId: string,
    detail?: string,
  ) => {
    const createdAt = new Date().toISOString();
    void Effect.runPromise(
      orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`hook:${kind}:${crypto.randomUUID()}`),
        threadId: ThreadId.makeUnsafe(threadId),
        activity: {
          id: EventId.makeUnsafe(crypto.randomUUID()),
          tone: "approval",
          kind,
          summary: kind === "approval.requested" ? "Approval requested" : "Approval resolved",
          payload: {
            requestId,
            ...(kind === "approval.requested" ? { requestKind: "command" } : { decision: "accept" }),
            ...(detail ? { detail } : {}),
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("approval activity dispatch failed", { cause: error }),
        ),
      ),
    );
  };

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer((req, res) => {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body?: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    // Handle hook callbacks outside Effect pipeline for minimal overhead
    const rawUrl = req.url ?? "/";
    if (req.method === "POST" && rawUrl.startsWith("/hooks/")) {
      const hookUrl = new URL(rawUrl, `http://localhost:${port}`);
      const hookPath = hookUrl.pathname;
      const threadId = hookUrl.searchParams.get("thread");
      if (!threadId) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing thread query param");
        return;
      }

      void (async () => {
        try {
          const body = await readRequestBody(req);
          let events: ClaudeSessionEvent[] = [];

          if (hookPath === "/hooks/user-prompt-submit") {
            events = buildUserPromptSubmitEvents(threadId);

            // A new prompt clears any lingering pending approvals (user may
            // have interrupted or the approval was granted via the terminal).
            const pendingIds = pendingApprovalRequestIdsByThread.get(threadId);
            if (pendingIds?.size) {
              for (const id of pendingIds) {
                dispatchApprovalActivity(threadId, "approval.resolved", id);
              }
              pendingApprovalRequestIdsByThread.delete(threadId);
            }

            // Capture baseline checkpoint for diff comparison
            Effect.runPromise(
              checkpointReactor.ensureBaseline({
                threadId: ThreadId.makeUnsafe(threadId),
              }),
            ).catch((err) => logger.warn("ensureBaseline promise rejected", { threadId, error: String(err) }));

            // Auto-title: generate a thread title from the first prompt
            if (!autoTitledThreads.has(threadId)) {
              const promptText = extractPromptText(body);
              if (promptText) {
                autoTitledThreads.add(threadId);

                const fallbackTitle = promptText.length <= 50
                  ? promptText
                  : `${promptText.slice(0, 49)}\u2026`;

                void Effect.runPromise(
                  textGeneration
                    .generateThreadTitle({ promptText })
                    .pipe(
                      Effect.map(({ title }) => title),
                      Effect.catch((error) => {
                        logger.warn("auto-title AI failed, using fallback", { threadId, error: String(error) });
                        return Effect.succeed(fallbackTitle);
                      }),
                      Effect.flatMap((title) =>
                        orchestrationEngine.dispatch({
                          type: "thread.meta.update",
                          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
                          threadId: ThreadId.makeUnsafe(threadId),
                          title,
                          titleSource: "auto",
                        }),
                      ),
                      Effect.catch((error) => {
                        autoTitledThreads.delete(threadId);
                        return Effect.logError("auto-title dispatch failed", { cause: error });
                      }),
                    ),
                );
              }
            }
          } else if (hookPath === "/hooks/permission-request") {
            events = buildPermissionRequestEvents(threadId, body);

            // Dispatch a persistent approval activity so the sidebar badge
            // survives page refresh / reconnection. Only for real approval
            // requests — ask tools emit needsInput, not pendingApproval.
            const isPendingApproval = events.some(
              (e) => e.type === "hookStatus" && e.hookStatus === "pendingApproval",
            );
            if (isPendingApproval) {
              const requestId = crypto.randomUUID();
              let pending = pendingApprovalRequestIdsByThread.get(threadId);
              if (!pending) {
                pending = new Set();
                pendingApprovalRequestIdsByThread.set(threadId, pending);
              }
              pending.add(requestId);
              dispatchApprovalActivity(threadId, "approval.requested", requestId);
            }
          } else if (hookPath === "/hooks/post-tool-use") {
            events = buildPostToolUseEvents(threadId);

            // Resolve the most recent pending approval activity so the badge clears.
            const pendingIds = pendingApprovalRequestIdsByThread.get(threadId);
            if (pendingIds?.size) {
              // Pop the most recently added (the tool that just ran).
              const lastId = [...pendingIds].pop()!;
              pendingIds.delete(lastId);
              if (pendingIds.size === 0) pendingApprovalRequestIdsByThread.delete(threadId);
              dispatchApprovalActivity(threadId, "approval.resolved", lastId);
            }
          } else if (hookPath === "/hooks/stop") {
            events = buildStopEvents(threadId);

            // On stop, resolve ALL lingering pending approvals (covers
            // rejected tools whose post-tool-use never fired).
            const pendingIds = pendingApprovalRequestIdsByThread.get(threadId);
            if (pendingIds?.size) {
              for (const id of pendingIds) {
                dispatchApprovalActivity(threadId, "approval.resolved", id);
              }
              pendingApprovalRequestIdsByThread.delete(threadId);
            }

            // Capture checkpoint and compute diff for the DiffPanel
            Effect.runPromise(
              checkpointReactor.captureTerminalTurnCheckpoint({
                threadId: ThreadId.makeUnsafe(threadId),
              }),
            ).catch((err) => logger.warn("captureTerminalTurnCheckpoint promise rejected", { threadId, error: String(err) }));
          } else if (hookPath === "/hooks/notification") {
            events = buildNotificationEvents(threadId, body);
          } else {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Unknown hook");
            return;
          }

          logger.info("hook received", { hookPath, threadId, eventCount: events.length });

          for (const event of events) {
            void Effect.runPromise(
              broadcastPush({
                type: "push",
                channel: WS_CHANNELS.claudeSessionEvent,
                data: event,
              }).pipe(
                Effect.catch((error) =>
                  Effect.logError("hook broadcast failed", { cause: error }),
                ),
              ),
            );
          }

          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("OK");
        } catch (error) {
          logger.warn("hook handler error", {
            hookPath,
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Internal error");
          }
        }
      })();
      return;
    }

    void Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
          const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
          if (!normalizedRelativePath) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
            return;
          }

          const isIdLookup =
            !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
          const filePath = isIdLookup
            ? resolveAttachmentPathById({
                stateDir: serverConfig.stateDir,
                attachmentId: normalizedRelativePath,
              })
            : resolveAttachmentRelativePath({
                stateDir: serverConfig.stateDir,
                relativePath: normalizedRelativePath,
              });
          if (!filePath) {
            respond(
              isIdLookup ? 404 : 400,
              { "Content-Type": "text/plain" },
              isIdLookup ? "Not Found" : "Invalid attachment path",
            );
            return;
          }

          const fileInfo = yield* fileSystem
            .stat(filePath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }

          const contentType = Mime.getType(filePath) ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          const streamExit = yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
            Effect.sync(() => {
              if (!res.destroyed) {
                res.write(chunk);
              }
            }),
          ).pipe(Effect.exit);
          if (streamExit._tag === "Failure") {
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        // In dev mode, redirect to Vite dev server
        if (devUrl) {
          respond(302, { Location: devUrl.href });
          return;
        }

        // Serve static files from the web app build
        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");
        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
            return;
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
          return;
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
          return;
        }
        respond(200, { "Content-Type": contentType }, data);
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  });

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
    wss.close((error) => {
      if (error && !isServerNotRunningError(error)) {
        resume(
          Effect.fail(
            new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error }),
          ),
        );
      } else {
        resume(Effect.void);
      }
    });
  });

  const closeAllClients = Ref.get(clients).pipe(
    Effect.flatMap(Effect.forEach((client) => Effect.sync(() => client.close()))),
    Effect.flatMap(() => Ref.set(clients, new Set())),
  );

  const listenOptions = host ? { host, port } : { port };

  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const orchestrationReactor = yield* OrchestrationReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const { openInEditor } = yield* Open;
  const projectionThreadRepository = yield* ProjectionThreadRepository;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    broadcastPush({
      type: "push",
      channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
      data: event,
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(keybindingsManager.changes, (event) =>
    broadcastPush({
      type: "push",
      channel: WS_CHANNELS.serverConfigUpdated,
      data: {
        issues: event.issues,
        providers: [],
      },
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);

  // Phase 5: Reset stale active terminal statuses on startup.
  // After a crash or unclean shutdown, threads may still be marked 'active' in the DB
  // even though no PTY processes are running. Set them to 'dormant' so the UI is correct.
  // Also seed autoTitledThreads from the projection so we don't re-generate titles for
  // threads that were already titled in a previous server session.
  yield* Effect.gen(function* () {
    const snapshot = yield* projectionReadModelQuery.getSnapshot();
    const staleActiveThreads = snapshot.threads.filter(
      (thread) => thread.terminalStatus === "active" && thread.deletedAt === null,
    );
    yield* Effect.forEach(
      staleActiveThreads,
      (thread) =>
        orchestrationEngine.dispatch({
          type: "thread.terminal.statusChanged",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: ThreadId.makeUnsafe(thread.id),
          terminalStatus: "dormant",
          claudeSessionId: thread.claudeSessionId,
          scrollbackSnapshot: thread.scrollbackSnapshot,
          updatedAt: new Date().toISOString(),
        }),
      { concurrency: 10 },
    );

    // Seed autoTitledThreads: any non-deleted thread that already has a title
    // other than the default "New thread" should not be re-titled.
    for (const thread of snapshot.threads) {
      if (thread.deletedAt === null && thread.title !== "New thread") {
        autoTitledThreads.add(thread.id);
      }
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to reset stale active terminal statuses on startup", {
        cause: error,
      }),
    ),
  );

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  if (autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const snapshot = yield* projectionReadModelQuery.getSnapshot();
      const existingProject = snapshot.projects.find(
        (project) => project.workspaceRoot === cwd && project.deletedAt === null,
      );
      let bootstrapProjectId: ProjectId;
      let bootstrapProjectDefaultModel: string;

      if (!existingProject) {
        const createdAt = new Date().toISOString();
        bootstrapProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(cwd) || "project";
        bootstrapProjectDefaultModel = "claude-opus-4-6";
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: bootstrapProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: cwd,
          defaultModel: bootstrapProjectDefaultModel,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModel = existingProject.defaultModel ?? "claude-opus-4-6";
      }

      const existingThread = snapshot.threads.find(
        (thread) => thread.projectId === bootstrapProjectId && thread.deletedAt === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: bootstrapProjectDefaultModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = threadId;
      } else {
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = existingThread.id;
      }
    }).pipe(
      Effect.mapError(
        (cause) => new ServerLifecycleError({ operation: "autoBootstrapProject", cause }),
      ),
    );
  }

  const runtimeServices = yield* Effect.services<
    ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const runPromise = Effect.runPromiseWith(runtimeServices);

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(onTerminalEvent(event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));

  const onClaudeSessionEvent = Effect.fnUntraced(function* (event: ClaudeSessionEvent) {
    yield* broadcastPush({
      type: "push",
      channel: WS_CHANNELS.claudeSessionEvent,
      data: event,
    });

    if (event.type === "started") {
      yield* orchestrationEngine.dispatch({
        type: "thread.terminal.statusChanged",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: ThreadId.makeUnsafe(event.threadId),
        terminalStatus: "active",
        claudeSessionId: null,
        scrollbackSnapshot: null,
        updatedAt: new Date().toISOString(),
      });
    }

    if (event.type === "sessionId") {
      yield* orchestrationEngine.dispatch({
        type: "thread.terminal.statusChanged",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: ThreadId.makeUnsafe(event.threadId),
        terminalStatus: "active",
        claudeSessionId: event.claudeSessionId,
        scrollbackSnapshot: null,
        updatedAt: new Date().toISOString(),
      });
    }

    if (event.type === "hibernated" || event.type === "exited") {
      const scrollbackResult = yield* claudeSessionManager.getScrollback(event.threadId);
      const claudeSessionId = yield* claudeSessionManager.getClaudeSessionId(event.threadId);
      yield* orchestrationEngine.dispatch({
        type: "thread.terminal.statusChanged",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: ThreadId.makeUnsafe(event.threadId),
        terminalStatus: "dormant",
        claudeSessionId: claudeSessionId,
        scrollbackSnapshot: scrollbackResult.scrollback,
        updatedAt: new Date().toISOString(),
      });
    }
  });

  const unsubscribeClaudeEvents = yield* claudeSessionManager.subscribe(
    (event) =>
      void Effect.runPromise(
        onClaudeSessionEvent(event).pipe(
          Effect.catch((error) =>
            Effect.logError("claude session event handler failed", { cause: error }),
          ),
        ),
      ),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeClaudeEvents()));

  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );

  // Phase 5: Graceful shutdown — hibernate all sessions BEFORE closing connections
  yield* Effect.addFinalizer(() =>
    claudeSessionManager.hibernateAll().pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to hibernate claude sessions on shutdown", { cause: error }),
      ),
      Effect.andThen(
        Effect.all([
          closeAllClients,
          closeWebSocketServer.pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to close web socket server", { cause: error }),
            ),
          ),
        ]),
      ),
    ),
  );

  const routeRequest = Effect.fnUntraced(function* (request: WebSocketRequest) {
    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        const result = yield* orchestrationEngine.dispatch(normalizedCommand);

        // Phase 5: Kill active PTY after thread deletion is committed
        if (normalizedCommand.type === "thread.delete") {
          yield* claudeSessionManager.destroySession(normalizedCommand.threadId);
        }

        return result;
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getWorkingTreeDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getWorkingTreeDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = request.body;
        return yield* Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((events) => Array.from(events)));
      }

      case ORCHESTRATION_WS_METHODS.getSlashCommands: {
        return { commands: [] };
      }

      case ORCHESTRATION_WS_METHODS.getCachedSlashCommands: {
        return { commands: [] };
      }

      case ORCHESTRATION_WS_METHODS.getSessionMetrics: {
        const { threadId } = request.body;
        return yield* projectionReadModelQuery.getSessionMetrics(threadId);
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => searchWorkspaceEntries(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search workspace entries: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsWriteFile: {
        const body = stripRequestTag(request.body);
        const writeGitRoot = yield* findGitRoot(body.cwd, path, fileSystem);
        const target = yield* resolveWorkspaceWritePath({
          workspaceRoot: writeGitRoot,
          relativePath: body.relativePath,
          path,
        });
        yield* fileSystem
          .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteRequestError({
                  message: `Failed to prepare workspace path: ${String(cause)}`,
                }),
            ),
          );
        yield* fileSystem.writeFileString(target.absolutePath, body.contents).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to write workspace file: ${String(cause)}`,
              }),
          ),
        );
        return { relativePath: target.relativePath };
      }

      case WS_METHODS.projectsReadFile: {
        const body = stripRequestTag(request.body);
        // Diff paths are relative to the git root, which may differ from the
        // project cwd (e.g. monorepo where project cwd is a subdirectory).
        // Try the provided cwd first, then fall back to the git root.
        const gitRoot = yield* findGitRoot(body.cwd, path, fileSystem);
        const target = yield* resolveWorkspaceWritePath({
          workspaceRoot: gitRoot,
          relativePath: body.relativePath,
          path,
        });
        const absolutePath = target.absolutePath;
        const fileStat = yield* fileSystem.stat(absolutePath).pipe(
          Effect.mapError(
            () =>
              new RouteRequestError({
                message: `File not found: ${body.relativePath}`,
              }),
          ),
        );
        if (fileStat.size > 1_048_576) {
          return yield* new RouteRequestError({
            message: "File too large to edit (max 1MB)",
          });
        }
        const contents = yield* fileSystem.readFileString(absolutePath).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to read workspace file: ${String(cause)}`,
              }),
          ),
        );
        // Check for binary content: if the first 8KB contains null bytes
        const checkSlice = contents.slice(0, 8192);
        if (checkSlice.includes("\0")) {
          return yield* new RouteRequestError({
            message: "Binary files cannot be edited",
          });
        }
        return {
          relativePath: target.relativePath,
          contents,
          language: inferLanguage(target.relativePath),
        };
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(request.body);
        return yield* git.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.runStackedAction(body);
      }

      case WS_METHODS.gitResolvePullRequest: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.resolvePullRequest(body);
      }

      case WS_METHODS.gitPreparePullRequestThread: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.preparePullRequestThread(body);
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(request.body);
        return yield* git.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.createWorktree(body);
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(request.body);
        return yield* git.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(request.body);
        return yield* Effect.scoped(git.checkoutBranch(body));
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(request.body);
        return yield* git.initRepo(body);
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.open(body);
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.write(body);
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.restart(body);
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.claudeStart: {
        const { threadId, cwd: requestedCwd, cols, rows, resumeSessionId, dangerouslySkipPermissions } = stripRequestTag(request.body);

        // Validate cwd is under the workspace root or the thread's registered worktree
        const resolvedCwd = path.resolve(requestedCwd);
        const resolvedRoot = path.resolve(cwd);
        const isUnderRoot = resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}/`);
        if (!isUnderRoot) {
          // Allow if the cwd matches the thread's registered worktree path
          const snapshot = yield* projectionReadModelQuery.getSnapshot();
          const thread = snapshot.threads.find((t) => t.id === threadId);
          const threadWorktree = thread?.worktreePath ? path.resolve(thread.worktreePath) : null;
          const isThreadWorktree = threadWorktree != null &&
            (resolvedCwd === threadWorktree || resolvedCwd.startsWith(`${threadWorktree}/`));
          if (!isThreadWorktree) {
            return yield* new RouteRequestError({
              message: `cwd must be within workspace root: ${cwd}`,
            });
          }
        }

        return yield* claudeSessionManager.startSession({
          threadId,
          cwd: resolvedCwd,
          cols,
          rows,
          ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
          ...(dangerouslySkipPermissions !== undefined ? { dangerouslySkipPermissions } : {}),
        });
      }

      case WS_METHODS.claudeHibernate: {
        const body = stripRequestTag(request.body);
        return yield* claudeSessionManager.hibernateSession(body.threadId);
      }

      case WS_METHODS.claudeGetScrollback: {
        const body = stripRequestTag(request.body);
        const result = yield* claudeSessionManager.getScrollback(body.threadId, body.sinceOffset);
        return { threadId: body.threadId, scrollback: result.scrollback, offset: result.offset, reset: result.reset };
      }

      case WS_METHODS.claudeWrite: {
        const { threadId, data } = stripRequestTag(request.body);
        return yield* claudeSessionManager.writeToSession(threadId, data);
      }

      case WS_METHODS.claudeResize: {
        const { threadId, cols, rows } = stripRequestTag(request.body);
        return yield* claudeSessionManager.resizeSession(threadId, cols, rows);
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        return {
          cwd,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: [],
          availableEditors,
        };

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
        return { keybindings: keybindingsConfig, issues: [] };
      }

      case WS_METHODS.serverPurgeInactiveSessions: {
        const body = stripRequestTag(request.body);
        const excludeSet = new Set(body.excludeThreadIds);

        logger.info("purge inactive sessions: starting", { excludeCount: excludeSet.size });

        // Kill dormant PTY sessions
        const sessionsKilled = yield* claudeSessionManager.purgeInactiveSessions(excludeSet);

        // Clear scrollback snapshots in SQLite
        const snapshotsCleared = yield* projectionThreadRepository.clearScrollbackSnapshotBulk({
          excludeThreadIds: body.excludeThreadIds,
        });

        logger.info("purge inactive sessions: completed", { sessionsKilled, snapshotsCleared });
        return { sessionsKilled, snapshotsCleared };
      }

      case MCP_WS_METHODS.mcpGetStatus: {
        return { servers: [] };
      }

      case MCP_WS_METHODS.mcpSetServers: {
        return {};
      }

      case MCP_WS_METHODS.mcpReconnectServer: {
        return {};
      }

      case MCP_WS_METHODS.mcpToggleServer: {
        return {};
      }

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));

    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: "Invalid request format: Failed to read message" },
      });
      ws.send(errorResponse);
      return;
    }

    const request = Schema.decodeExit(Schema.fromJsonString(WebSocketRequest))(messageText);
    if (request._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: `Invalid request format: ${messageFromCause(request.cause)}` },
      });
      ws.send(errorResponse);
      return;
    }

    const result = yield* Effect.exit(routeRequest(request.value));
    if (result._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: request.value.id,
        error: { message: messageFromCause(result.cause) },
      });
      ws.send(errorResponse);
      return;
    }

    const response = yield* encodeResponse({
      id: request.value.id,
      result: result.value,
    });

    ws.send(response);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    if (authToken) {
      let providedToken: string | null = null;
      try {
        const url = new URL(request.url ?? "/", `http://localhost:${port}`);
        providedToken = url.searchParams.get("token");
      } catch {
        rejectUpgrade(socket, 400, "Invalid WebSocket URL");
        return;
      }

      if (providedToken !== authToken) {
        rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    void runPromise(Ref.update(clients, (clients) => clients.add(ws)));

    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";

    const welcome: WsPush = {
      type: "push",
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd,
        projectName,
        ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
        ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
      },
    };
    logOutgoingPush(welcome, 1);
    ws.send(JSON.stringify(welcome));

    ws.on("message", (raw) => {
      void runPromise(
        handleMessage(ws, raw).pipe(
          Effect.catch((error) => Effect.logError("Error handling message", error)),
        ),
      );
    });

    ws.on("close", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });

    ws.on("error", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);

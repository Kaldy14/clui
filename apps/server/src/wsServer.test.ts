import * as Http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, PlatformError, Scope } from "effect";
import { describe, expect, it, afterEach, vi } from "vitest";
import { createServer } from "./wsServer";
import WebSocket from "ws";
import { ServerConfig, type ServerConfigShape } from "./config";
import { makeServerRuntimeServicesLayer } from "./serverLayers";
import { getServerSettingsPath } from "./serverSettings";

import {
  DEFAULT_ACTIVE_HARNESS_SESSION_CAP,
  DEFAULT_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS,
  DEFAULT_CLAUDE_CODE_BACKEND,
  DEFAULT_CLAUDE_CODE_PROXY_MODEL,
  DEFAULT_PREVENT_MACOS_SLEEP_WHEN_THREAD_IN_PROGRESS,
  DEFAULT_TERMINAL_ID,
  DEFAULT_TITLE_GENERATION_PROVIDER,
  EDITORS,
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WS_METHODS,
  type WebSocketResponse,
  type AgentActivityStatus,
  type ClaudeHookStatus,
  type ClaudeSessionEvent,
  type ClaudeCodeProxyStatus,
  type KeybindingsConfig,
  type OrchestrationReadModel,
  type PiSessionEvent,
  type ResolvedKeybindingsConfig,
  type WsPush,
} from "@clui/contracts";
import { compileResolvedKeybindingRule, DEFAULT_KEYBINDINGS } from "./keybindings";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "@clui/contracts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { Open, type OpenShape } from "./open";
import { GitManager, type GitManagerShape } from "./git/Services/GitManager.ts";
import type { GitCoreShape } from "./git/Services/GitCore.ts";
import { GitCore } from "./git/Services/GitCore.ts";
import { GitCommandError, GitManagerError } from "./git/Errors.ts";
import { MigrationError } from "@effect/sql-sqlite-bun/SqliteMigrator";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import {
  ClaudeSessionManager,
  type ClaudeSessionManagerShape,
} from "./terminal/Services/ClaudeSession.ts";
import { PiSessionManager, type PiSessionManagerShape } from "./terminal/Services/PiSession.ts";
import { MacosSleepPreventer, type MacosSleepPreventerShape } from "./macosSleepPreventer";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery";

interface PendingMessages {
  queue: unknown[];
  waiters: Array<(message: unknown) => void>;
}

const pendingBySocket = new WeakMap<WebSocket, PendingMessages>();

const defaultOpenService: OpenShape = {
  openBrowser: () => Effect.void,
  openInEditor: () => Effect.void,
};

const DEFAULT_TEST_CLAUDE_CODE_PROXY_STATUS = {
  available: false,
  authenticated: false,
  running: false,
  authInProgress: false,
} satisfies ClaudeCodeProxyStatus;

const DEFAULT_TEST_SERVER_SETTINGS = {
  titleGenerationProvider: DEFAULT_TITLE_GENERATION_PROVIDER,
  maxActiveHarnessSessions: DEFAULT_ACTIVE_HARNESS_SESSION_CAP,
  preventMacosSleepWhenThreadInProgress: DEFAULT_PREVENT_MACOS_SLEEP_WHEN_THREAD_IN_PROGRESS,
  autoArchiveInactiveThreadDays: DEFAULT_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS,
  defaultClaudeCodeBackend: DEFAULT_CLAUDE_CODE_BACKEND,
  defaultClaudeCodeProxyModel: DEFAULT_CLAUDE_CODE_PROXY_MODEL,
};

class MockTerminalManager implements TerminalManagerShape {
  private readonly sessions = new Map<string, TerminalSessionSnapshot>();
  private readonly listeners = new Set<(event: TerminalEvent) => void>();

  private key(threadId: string, terminalId: string): string {
    return `${threadId}\u0000${terminalId}`;
  }

  emitEvent(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscriptionCount(): number {
    return this.listeners.size;
  }

  readonly open: TerminalManagerShape["open"] = (input: TerminalOpenInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const snapshot: TerminalSessionSnapshot = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        status: "running",
        pid: 4242,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: now,
      };
      this.sessions.set(this.key(input.threadId, terminalId), snapshot);
      queueMicrotask(() => {
        this.emitEvent({
          type: "started",
          threadId: input.threadId,
          terminalId,
          createdAt: now,
          snapshot,
        });
      });
      return snapshot;
    });

  readonly write: TerminalManagerShape["write"] = (input: TerminalWriteInput) =>
    Effect.sync(() => {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const existing = this.sessions.get(this.key(input.threadId, terminalId));
      if (!existing) {
        throw new Error(`Unknown terminal thread: ${input.threadId}`);
      }
      queueMicrotask(() => {
        this.emitEvent({
          type: "output",
          threadId: input.threadId,
          terminalId,
          createdAt: new Date().toISOString(),
          data: input.data,
        });
      });
    });

  readonly resize: TerminalManagerShape["resize"] = (_input: TerminalResizeInput) => Effect.void;

  readonly clear: TerminalManagerShape["clear"] = (input: TerminalClearInput) =>
    Effect.sync(() => {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      queueMicrotask(() => {
        this.emitEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          createdAt: new Date().toISOString(),
        });
      });
    });

  readonly restart: TerminalManagerShape["restart"] = (input: TerminalOpenInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const snapshot: TerminalSessionSnapshot = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        status: "running",
        pid: 5252,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: now,
      };
      this.sessions.set(this.key(input.threadId, terminalId), snapshot);
      queueMicrotask(() => {
        this.emitEvent({
          type: "restarted",
          threadId: input.threadId,
          terminalId,
          createdAt: now,
          snapshot,
        });
      });
      return snapshot;
    });

  readonly close: TerminalManagerShape["close"] = (input: TerminalCloseInput) =>
    Effect.sync(() => {
      if (input.terminalId) {
        this.sessions.delete(this.key(input.threadId, input.terminalId));
        return;
      }
      for (const key of this.sessions.keys()) {
        if (key.startsWith(`${input.threadId}\u0000`)) {
          this.sessions.delete(key);
        }
      }
    });

  readonly subscribe: TerminalManagerShape["subscribe"] = (listener) =>
    Effect.sync(() => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    });

  readonly dispose: TerminalManagerShape["dispose"] = Effect.void;
}

const defaultClaudeSessionManager: ClaudeSessionManagerShape = {
  startSession: () => Effect.void,
  hibernateSession: () => Effect.void,
  getScrollback: () => Effect.succeed({ scrollback: null, offset: 0, reset: false }),
  writeToSession: () => Effect.void,
  resizeSession: () => Effect.void,
  getSessionStatus: () => Effect.succeed("new" as const),
  reconcileActiveSessions: () => Effect.void,
  setMaxActiveSessions: () => Effect.void,
  hibernateAll: () => Effect.void,
  hibernateActiveSessions: () => Effect.succeed([]),
  subscribe: () => Effect.succeed(() => {}),
  getClaudeSessionId: () => Effect.succeed(null),
  recordCodexSessionId: () => Effect.void,
  destroySession: () => Effect.void,
  purgeInactiveSessions: () => Effect.succeed(0),
  getClaudeCodeProxyStatus: () => Effect.succeed(DEFAULT_TEST_CLAUDE_CODE_PROXY_STATUS),
  startClaudeCodeProxyLogin: () =>
    Effect.succeed({
      available: true,
      authenticated: false,
      running: false,
      authInProgress: true,
    }),
  logoutClaudeCodeProxy: () =>
    Effect.succeed({
      available: true,
      authenticated: false,
      running: false,
      authInProgress: false,
    }),
  dispose: Effect.void,
};

const defaultMacosSleepPreventer: MacosSleepPreventerShape = {
  setEnabled: () => Effect.void,
  setThreadInProgress: () => Effect.void,
  clearThread: () => Effect.void,
  dispose: Effect.void,
};

const defaultPiSessionManager: PiSessionManagerShape = {
  startSession: () => Effect.void,
  hibernateSession: () => Effect.void,
  getScrollback: () => Effect.succeed({ scrollback: null, offset: 0, reset: false }),
  promptSession: () => Effect.void,
  abortSession: () => Effect.void,
  respondExtensionUi: () => Effect.void,
  getCommands: () => Effect.succeed([]),
  sendRpcSessionCommand: () => Effect.succeed(null),
  writeToSession: () => Effect.void,
  notifyPromptSubmitted: () => Effect.void,
  resizeSession: () => Effect.void,
  getSessionStatus: () => Effect.succeed("new" as const),
  getSessionFile: () => Effect.succeed(null),
  getSessionHookStatus: () => Effect.succeed(null),
  getSessionActivityStatus: () => Effect.succeed(null),
  getPendingExtensionUiRequest: () => Effect.succeed(null),
  getExtensionUiState: () => Effect.succeed({ statuses: {}, widgets: [] }),
  getSessionUsageStats: () => Effect.succeed(null),
  reconcileActiveSessions: () => Effect.void,
  setMaxActiveSessions: () => Effect.void,
  hibernateAll: () => Effect.void,
  hibernateActiveSessions: () => Effect.succeed([]),
  subscribe: () => Effect.succeed(() => {}),
  destroySession: () => Effect.void,
  purgeInactiveSessions: () => Effect.succeed(0),
  dispose: Effect.void,
};

function connectWs(port: number, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    const pending: PendingMessages = { queue: [], waiters: [] };
    pendingBySocket.set(ws, pending);

    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      const waiter = pending.waiters.shift();
      if (waiter) {
        waiter(parsed);
        return;
      }
      pending.queue.push(parsed);
    });

    ws.once("open", () => resolve(ws));
    ws.once("error", () => reject(new Error("WebSocket connection failed")));
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  const pending = pendingBySocket.get(ws);
  if (!pending) {
    return Promise.reject(new Error("WebSocket not initialized"));
  }

  const queued = pending.queue.shift();
  if (queued !== undefined) {
    return Promise.resolve(queued);
  }

  return new Promise((resolve) => {
    pending.waiters.push(resolve);
  });
}

function asWebSocketResponse(message: unknown): WebSocketResponse | null {
  if (typeof message !== "object" || message === null) return null;
  if (!("id" in message)) return null;
  const id = (message as { id?: unknown }).id;
  if (typeof id !== "string") return null;
  return message as WebSocketResponse;
}

async function sendRequest(
  ws: WebSocket,
  method: string,
  params?: unknown,
): Promise<WebSocketResponse> {
  const id = crypto.randomUUID();
  const body =
    method === ORCHESTRATION_WS_METHODS.dispatchCommand
      ? { _tag: method, command: params }
      : params && typeof params === "object" && !Array.isArray(params)
        ? { _tag: method, ...(params as Record<string, unknown>) }
        : { _tag: method };
  const message = JSON.stringify({ id, body });
  ws.send(message);

  // Wait for response with matching id
  while (true) {
    const parsed = asWebSocketResponse(await waitForMessage(ws));
    if (!parsed) {
      continue;
    }
    if (parsed.id === id) {
      return parsed;
    }
    if (parsed.id === "unknown") {
      return parsed;
    }
  }
}

/** Send a fire-and-forget message (no response expected from server). */
function sendFireAndForget(ws: WebSocket, method: string, params?: unknown): void {
  const id = crypto.randomUUID();
  const body =
    params && typeof params === "object" && !Array.isArray(params)
      ? { _tag: method, ...(params as Record<string, unknown>) }
      : { _tag: method };
  ws.send(JSON.stringify({ id, body }));
}

async function waitForAssertion(
  assertion: () => void | Promise<void>,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function waitForPush(
  ws: WebSocket,
  channel: string,
  predicate?: (push: WsPush) => boolean,
  maxMessages = 120,
): Promise<WsPush> {
  const take = async (remaining: number): Promise<WsPush> => {
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for push on ${channel}`);
    }
    const message = (await waitForMessage(ws)) as WsPush;
    if (message.type !== "push" || message.channel !== channel) {
      return take(remaining - 1);
    }
    if (!predicate || predicate(message)) {
      return message;
    }
    return take(remaining - 1);
  };
  return take(maxMessages);
}

async function expectNoMatchingPush(
  ws: WebSocket,
  channel: string,
  predicate: (push: WsPush) => boolean,
  timeoutMs = 50,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  const pending = pendingBySocket.get(ws);
  if (!pending) return;
  for (const message of pending.queue) {
    const push = message as WsPush;
    if (push.type === "push" && push.channel === channel && predicate(push)) {
      throw new Error(`Unexpected push on ${channel}`);
    }
  }
}

async function requestPath(
  port: number,
  requestPath: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = Http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function compileKeybindings(bindings: KeybindingsConfig): ResolvedKeybindingsConfig {
  const resolved: Array<ResolvedKeybindingsConfig[number]> = [];
  for (const binding of bindings) {
    const compiled = compileResolvedKeybindingRule(binding);
    if (!compiled) {
      throw new Error(`Unexpected invalid keybinding in test setup: ${binding.command}`);
    }
    resolved.push(compiled);
  }
  return resolved;
}

const DEFAULT_RESOLVED_KEYBINDINGS = compileKeybindings([...DEFAULT_KEYBINDINGS]);
const VALID_EDITOR_IDS = new Set(EDITORS.map((editor) => editor.id));

function expectAvailableEditors(value: unknown): void {
  expect(Array.isArray(value)).toBe(true);
  for (const editorId of value as unknown[]) {
    expect(typeof editorId).toBe("string");
    expect(VALID_EDITOR_IDS.has(editorId as (typeof EDITORS)[number]["id"])).toBe(true);
  }
}

function expectCliProviderStatuses(value: unknown): void {
  expect(Array.isArray(value)).toBe(true);
  const providers = value as Array<{ provider?: unknown; available?: unknown; message?: unknown }>;
  expect(providers.some((provider) => provider.provider === "claudeCode")).toBe(true);
  expect(providers.some((provider) => provider.provider === "codex")).toBe(true);
  for (const provider of providers) {
    expect(typeof provider.available).toBe("boolean");
    expect(typeof provider.message).toBe("string");
  }
}

describe("WebSocket Server", () => {
  let server: Http.Server | null = null;
  let serverScope: Scope.Closeable | null = null;
  const connections: WebSocket[] = [];
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function createTestServer(
    options: {
      persistenceLayer?: Layer.Layer<
        SqlClient.SqlClient,
        SqlError.SqlError | MigrationError | PlatformError.PlatformError
      >;
      cwd?: string;
      autoBootstrapProjectFromCwd?: boolean;
      logWebSocketEvents?: boolean;
      devUrl?: string;
      authToken?: string;
      stateDir?: string;
      staticDir?: string;
      open?: OpenShape;
      gitManager?: GitManagerShape;
      gitCore?: Pick<GitCoreShape, "listBranches" | "initRepo" | "pullCurrentBranch">;
      terminalManager?: TerminalManagerShape;
      claudeSessionManager?: ClaudeSessionManagerShape;
      piSessionManager?: PiSessionManagerShape;
      macosSleepPreventer?: MacosSleepPreventerShape;
      projectionSnapshotQuery?: ProjectionSnapshotQueryShape;
    } = {},
  ): Promise<Http.Server> {
    if (serverScope) {
      throw new Error("Test server is already running");
    }

    const stateDir = options.stateDir ?? makeTempDir("clui-ws-state-");
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const persistenceLayer = options.persistenceLayer ?? SqlitePersistenceMemory;
    const openLayer = Layer.succeed(Open, options.open ?? defaultOpenService);
    const serverConfigLayer = Layer.succeed(ServerConfig, {
      mode: "web",
      port: 0,
      host: undefined,
      cwd: options.cwd ?? "/test/project",
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      stateDir,
      staticDir: options.staticDir,
      devUrl: options.devUrl ? new URL(options.devUrl) : undefined,
      noBrowser: true,
      authToken: options.authToken,
      autoBootstrapProjectFromCwd: options.autoBootstrapProjectFromCwd ?? false,
      logWebSocketEvents: options.logWebSocketEvents ?? Boolean(options.devUrl),
      dangerouslySkipPermissions: false,
      claudeCodeProxyBinaryPath: undefined,
    } satisfies ServerConfigShape);
    const runtimeOverrides = Layer.mergeAll(
      options.gitManager ? Layer.succeed(GitManager, options.gitManager) : Layer.empty,
      options.gitCore
        ? Layer.succeed(GitCore, options.gitCore as unknown as GitCoreShape)
        : Layer.empty,
      options.terminalManager
        ? Layer.succeed(TerminalManager, options.terminalManager)
        : Layer.empty,
      options.projectionSnapshotQuery
        ? Layer.succeed(ProjectionSnapshotQuery, options.projectionSnapshotQuery)
        : Layer.empty,
      Layer.succeed(
        ClaudeSessionManager,
        options.claudeSessionManager ?? defaultClaudeSessionManager,
      ),
      options.piSessionManager
        ? Layer.succeed(PiSessionManager, options.piSessionManager)
        : Layer.empty,
      Layer.succeed(MacosSleepPreventer, options.macosSleepPreventer ?? defaultMacosSleepPreventer),
    );

    const runtimeLayer = Layer.merge(
      Layer.merge(
        makeServerRuntimeServicesLayer().pipe(Layer.provide(persistenceLayer)),
        persistenceLayer,
      ),
      runtimeOverrides,
    );
    const dependenciesLayer = Layer.empty.pipe(
      Layer.provideMerge(runtimeLayer),
      Layer.provideMerge(openLayer),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(AnalyticsService.layerTest),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtimeServices = await Effect.runPromise(
      Layer.build(dependenciesLayer).pipe(Scope.provide(scope)),
    );

    try {
      const runtime = await Effect.runPromise(
        createServer().pipe(Effect.provide(runtimeServices), Scope.provide(scope)),
      );
      serverScope = scope;
      return runtime;
    } catch (error) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    }
  }

  async function closeTestServer() {
    if (!serverScope) return;
    const scope = serverScope;
    serverScope = null;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }

  afterEach(async () => {
    for (const ws of connections) {
      ws.close();
    }
    connections.length = 0;
    await closeTestServer();
    server = null;
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("sends welcome message on connect", async () => {
    server = await createTestServer({ cwd: "/test/project" });
    // Get the actual port after listen
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);

    const message = (await waitForMessage(ws)) as WsPush;
    expect(message.type).toBe("push");
    expect(message.channel).toBe(WS_CHANNELS.serverWelcome);
    expect(message.data).toEqual({
      cwd: "/test/project",
      projectName: "project",
    });
  });

  it("serves persisted attachments from stateDir", async () => {
    const stateDir = makeTempDir("clui-state-attachments-");
    const attachmentPath = path.join(stateDir, "attachments", "thread-a", "message-a", "0.png");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("hello-attachment"));

    server = await createTestServer({ cwd: "/test/project", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${port}/attachments/thread-a/message-a/0.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(Buffer.from("hello-attachment"));
  });

  it("serves persisted attachments for URL-encoded paths", async () => {
    const stateDir = makeTempDir("clui-state-attachments-encoded-");
    const attachmentPath = path.join(
      stateDir,
      "attachments",
      "thread%20folder",
      "message%20folder",
      "file%20name.png",
    );
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("hello-encoded-attachment"));

    server = await createTestServer({ cwd: "/test/project", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(
      `http://127.0.0.1:${port}/attachments/thread%20folder/message%20folder/file%20name.png`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(Buffer.from("hello-encoded-attachment"));
  });

  it("persists pasted temporary images and returns an absolute file path", async () => {
    const stateDir = makeTempDir("clui-state-temp-image-");
    server = await createTestServer({ cwd: "/test/project", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws); // welcome

    const response = await sendRequest(ws, WS_METHODS.serverWriteTempImage, {
      threadId: "thread-temp-image",
      name: "clipboard.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,cG5n",
    });

    expect(response.error).toBeUndefined();
    const result = response.result as { filePath: string; sizeBytes: number };
    expect(result.sizeBytes).toBe(3);
    expect(result.filePath).toContain(path.join(stateDir, "attachments"));
    expect(fs.readFileSync(result.filePath)).toEqual(Buffer.from("png"));
  });

  it("serves static index for root path", async () => {
    const stateDir = makeTempDir("clui-state-static-root-");
    const staticDir = makeTempDir("clui-static-root-");
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>static-root</h1>", "utf8");

    server = await createTestServer({ cwd: "/test/project", stateDir, staticDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("static-root");
  });

  it("rejects static path traversal attempts", async () => {
    const stateDir = makeTempDir("clui-state-static-traversal-");
    const staticDir = makeTempDir("clui-static-traversal-");
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>safe</h1>", "utf8");

    server = await createTestServer({ cwd: "/test/project", stateDir, staticDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await requestPath(port, "/..%2f..%2fetc/passwd");
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe("Invalid static file path");
  });

  it("bootstraps the cwd project on startup when enabled", async () => {
    server = await createTestServer({
      cwd: "/test/bootstrap-workspace",
      autoBootstrapProjectFromCwd: true,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);
    const welcome = (await waitForMessage(ws)) as WsPush; // welcome
    expect(welcome.channel).toBe(WS_CHANNELS.serverWelcome);
    expect(welcome.data).toEqual(
      expect.objectContaining({
        cwd: "/test/bootstrap-workspace",
        projectName: "bootstrap-workspace",
        bootstrapProjectId: expect.any(String),
        bootstrapThreadId: expect.any(String),
      }),
    );

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    expect(snapshotResponse.error).toBeUndefined();
    const snapshot = snapshotResponse.result as {
      projects: Array<{
        id: string;
        workspaceRoot: string;
        title: string;
        defaultModel: string | null;
      }>;
      threads: Array<{
        id: string;
        projectId: string;
        title: string;
        model: string;
        branch: string | null;
        worktreePath: string | null;
      }>;
    };
    const bootstrapProjectId = (welcome.data as { bootstrapProjectId?: string }).bootstrapProjectId;
    const bootstrapThreadId = (welcome.data as { bootstrapThreadId?: string }).bootstrapThreadId;
    expect(bootstrapProjectId).toBeDefined();
    expect(bootstrapThreadId).toBeDefined();

    expect(snapshot.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bootstrapProjectId,
          workspaceRoot: "/test/bootstrap-workspace",
          title: "bootstrap-workspace",
          defaultModel: "claude-opus-4-6",
        }),
      ]),
    );
    expect(snapshot.threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bootstrapThreadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: "claude-opus-4-6",
          branch: null,
          worktreePath: null,
        }),
      ]),
    );
  });

  it("includes bootstrap ids in welcome when cwd project and thread already exist", async () => {
    const stateDir = makeTempDir("clui-state-bootstrap-existing-");
    const persistenceLayer = makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    ) as any;
    const cwd = "/test/bootstrap-existing";

    server = await createTestServer({
      cwd,
      stateDir,
      persistenceLayer,
      autoBootstrapProjectFromCwd: true,
    });
    let addr = server.address();
    let port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const firstWs = await connectWs(port);
    connections.push(firstWs);
    const firstWelcome = (await waitForMessage(firstWs)) as WsPush;
    const firstBootstrapProjectId = (firstWelcome.data as { bootstrapProjectId?: string })
      .bootstrapProjectId;
    const firstBootstrapThreadId = (firstWelcome.data as { bootstrapThreadId?: string })
      .bootstrapThreadId;
    expect(firstBootstrapProjectId).toBeDefined();
    expect(firstBootstrapThreadId).toBeDefined();

    firstWs.close();
    await closeTestServer();
    server = null;

    server = await createTestServer({
      cwd,
      stateDir,
      persistenceLayer,
      autoBootstrapProjectFromCwd: true,
    });
    addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const secondWs = await connectWs(port);
    connections.push(secondWs);
    const secondWelcome = (await waitForMessage(secondWs)) as WsPush;
    expect(secondWelcome.channel).toBe(WS_CHANNELS.serverWelcome);
    expect(secondWelcome.data).toEqual(
      expect.objectContaining({
        cwd,
        projectName: "bootstrap-existing",
        bootstrapProjectId: firstBootstrapProjectId,
        bootstrapThreadId: firstBootstrapThreadId,
      }),
    );
  });

  it("logs outbound websocket push events in dev mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      // Keep test output clean while verifying websocket logs.
    });

    server = await createTestServer({
      cwd: "/test/project",
      devUrl: "http://localhost:5173",
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    expect(
      logSpy.mock.calls.some(([message]) => {
        if (typeof message !== "string") return false;
        return (
          message.includes("[ws]") &&
          message.includes("outgoing push") &&
          message.includes(`channel="${WS_CHANNELS.serverWelcome}"`)
        );
      }),
    ).toBe(true);
  });

  it("responds to server.getConfig", async () => {
    const stateDir = makeTempDir("clui-state-get-config-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "[]", "utf8");

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome message
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      issues: [],
      providers: expect.any(Array),
      availableEditors: expect.any(Array),
      claudeCodeProxy: DEFAULT_TEST_CLAUDE_CODE_PROXY_STATUS,
      settings: DEFAULT_TEST_SERVER_SETTINGS,
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
    expectCliProviderStatuses((response.result as { providers: unknown }).providers);
  });

  it("reports CLI provider availability from PATH", async () => {
    const stateDir = makeTempDir("clui-state-provider-status-");
    const binDir = makeTempDir("clui-provider-bin-");
    const codexName = process.platform === "win32" ? "codex.cmd" : "codex";
    const codexPath = path.join(binDir, codexName);
    fs.writeFileSync(codexPath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
    if (process.platform !== "win32") {
      fs.chmodSync(codexPath, 0o755);
    }

    const previousPath = process.env.PATH;
    try {
      process.env.PATH = binDir;
      server = await createTestServer({ cwd: "/my/workspace", stateDir });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws);

      const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
      expect(response.error).toBeUndefined();
      const providers = (response.result as { providers: Array<Record<string, unknown>> })
        .providers;
      expect(providers.find((provider) => provider.provider === "codex")).toMatchObject({
        provider: "codex",
        available: true,
        status: "ready",
        authStatus: "unknown",
        message: expect.stringContaining("codex found on PATH"),
      });
      expect(providers.find((provider) => provider.provider === "claudeCode")).toMatchObject({
        provider: "claudeCode",
        available: false,
        status: "warning",
        authStatus: "unknown",
        message: expect.stringContaining("claude was not found on PATH"),
      });
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("bootstraps default keybindings file when missing", async () => {
    const stateDir = makeTempDir("clui-state-bootstrap-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    expect(fs.existsSync(keybindingsPath)).toBe(false);

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      issues: [],
      providers: expect.any(Array),
      availableEditors: expect.any(Array),
      claudeCodeProxy: DEFAULT_TEST_CLAUDE_CODE_PROXY_STATUS,
      settings: DEFAULT_TEST_SERVER_SETTINGS,
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);

    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    expect(persistedConfig).toEqual(DEFAULT_KEYBINDINGS);
  });

  it("falls back to defaults and reports malformed keybindings config issues", async () => {
    const stateDir = makeTempDir("clui-state-malformed-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "{ not-json", "utf8");

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      issues: [
        {
          kind: "keybindings.malformed-config",
          message: expect.stringContaining("expected JSON array"),
        },
      ],
      providers: expect.any(Array),
      availableEditors: expect.any(Array),
      claudeCodeProxy: DEFAULT_TEST_CLAUDE_CODE_PROXY_STATUS,
      settings: DEFAULT_TEST_SERVER_SETTINGS,
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
    expect(fs.readFileSync(keybindingsPath, "utf8")).toBe("{ not-json");
  });

  it("ignores invalid keybinding entries but keeps valid entries and reports issues", async () => {
    const stateDir = makeTempDir("clui-state-partial-invalid-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+d+o", command: "terminal.new" },
        { key: "mod+x", command: "not-a-real-command" },
      ]),
      "utf8",
    );

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    const result = response.result as {
      cwd: string;
      keybindingsConfigPath: string;
      keybindings: ResolvedKeybindingsConfig;
      issues: Array<{ kind: string; index?: number; message: string }>;
      providers: ReadonlyArray<unknown>;
      availableEditors: unknown;
      settings: {
        maxActiveHarnessSessions: number;
        preventMacosSleepWhenThreadInProgress: boolean;
        autoArchiveInactiveThreadDays: number;
      };
    };
    expect(result.cwd).toBe("/my/workspace");
    expect(result.keybindingsConfigPath).toBe(keybindingsPath);
    expect(result.issues).toEqual([
      {
        kind: "keybindings.invalid-entry",
        index: 1,
        message: expect.any(String),
      },
      {
        kind: "keybindings.invalid-entry",
        index: 2,
        message: expect.any(String),
      },
    ]);
    expect(result.keybindings).toHaveLength(DEFAULT_RESOLVED_KEYBINDINGS.length);
    expect(result.keybindings.some((entry) => entry.command === "terminal.toggle")).toBe(true);
    expect(result.keybindings.some((entry) => entry.command === "terminal.new")).toBe(true);
    expect(result.providers).toEqual(expect.any(Array));
    expect(result.settings).toEqual(DEFAULT_TEST_SERVER_SETTINGS);
    expectAvailableEditors(result.availableEditors);
  });

  it("reads persisted session cap from server settings", async () => {
    const stateDir = makeTempDir("clui-state-server-settings-");
    fs.writeFileSync(
      getServerSettingsPath(stateDir),
      JSON.stringify({ titleGenerationProvider: "codex", maxActiveHarnessSessions: 7 }),
      "utf8",
    );

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      settings: {
        titleGenerationProvider: "codex",
        maxActiveHarnessSessions: 7,
      },
    });
  });

  it("updates server settings and applies changed runtime settings", async () => {
    const stateDir = makeTempDir("clui-state-update-server-settings-");
    const claudeCaps: number[] = [];
    const piCaps: number[] = [];
    const sleepPreventionEnabled: boolean[] = [];

    server = await createTestServer({
      cwd: "/my/workspace",
      stateDir,
      claudeSessionManager: {
        ...defaultClaudeSessionManager,
        setMaxActiveSessions: (maxActive) => {
          claudeCaps.push(maxActive);
          return Effect.void;
        },
      },
      piSessionManager: {
        ...defaultPiSessionManager,
        setMaxActiveSessions: (maxActive) => {
          piCaps.push(maxActive);
          return Effect.void;
        },
      },
      macosSleepPreventer: {
        ...defaultMacosSleepPreventer,
        setEnabled: (enabled) => {
          sleepPreventionEnabled.push(enabled);
          return Effect.void;
        },
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
      titleGenerationProvider: "codex",
      maxActiveHarnessSessions: 7,
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      titleGenerationProvider: "codex",
      maxActiveHarnessSessions: 7,
      preventMacosSleepWhenThreadInProgress: DEFAULT_PREVENT_MACOS_SLEEP_WHEN_THREAD_IN_PROGRESS,
      autoArchiveInactiveThreadDays: DEFAULT_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS,
      defaultClaudeCodeBackend: DEFAULT_CLAUDE_CODE_BACKEND,
      defaultClaudeCodeProxyModel: DEFAULT_CLAUDE_CODE_PROXY_MODEL,
    });
    expect(claudeCaps).toEqual([7]);
    expect(piCaps).toEqual([7]);
    expect(sleepPreventionEnabled).toEqual([]);
    expect(
      JSON.parse(fs.readFileSync(getServerSettingsPath(stateDir), "utf8")) as {
        titleGenerationProvider: string;
        maxActiveHarnessSessions: number;
        preventMacosSleepWhenThreadInProgress: boolean;
        autoArchiveInactiveThreadDays: number;
      },
    ).toEqual({
      titleGenerationProvider: "codex",
      maxActiveHarnessSessions: 7,
      preventMacosSleepWhenThreadInProgress: DEFAULT_PREVENT_MACOS_SLEEP_WHEN_THREAD_IN_PROGRESS,
      autoArchiveInactiveThreadDays: DEFAULT_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS,
      defaultClaudeCodeBackend: DEFAULT_CLAUDE_CODE_BACKEND,
      defaultClaudeCodeProxyModel: DEFAULT_CLAUDE_CODE_PROXY_MODEL,
    });
  });

  it("updates the title generation provider without touching harness runtime settings", async () => {
    const stateDir = makeTempDir("clui-state-update-title-provider-");
    const claudeCaps: number[] = [];
    const piCaps: number[] = [];
    const sleepPreventionEnabled: boolean[] = [];

    server = await createTestServer({
      cwd: "/my/workspace",
      stateDir,
      claudeSessionManager: {
        ...defaultClaudeSessionManager,
        setMaxActiveSessions: (maxActive) => {
          claudeCaps.push(maxActive);
          return Effect.void;
        },
      },
      piSessionManager: {
        ...defaultPiSessionManager,
        setMaxActiveSessions: (maxActive) => {
          piCaps.push(maxActive);
          return Effect.void;
        },
      },
      macosSleepPreventer: {
        ...defaultMacosSleepPreventer,
        setEnabled: (enabled) => {
          sleepPreventionEnabled.push(enabled);
          return Effect.void;
        },
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverUpdateSettings, {
      titleGenerationProvider: "codex",
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ titleGenerationProvider: "codex" });
    expect(claudeCaps).toEqual([]);
    expect(piCaps).toEqual([]);
    expect(sleepPreventionEnabled).toEqual([]);
  });

  it("purges dormant sessions and hibernates eligible active sessions", async () => {
    const claudeCalls: Array<{ method: string; excludeThreadIds: string[] }> = [];
    const piCalls: Array<{ method: string; excludeThreadIds: string[] }> = [];

    server = await createTestServer({
      cwd: "/my/workspace",
      claudeSessionManager: {
        ...defaultClaudeSessionManager,
        hibernateActiveSessions: (excludeThreadIds) => {
          claudeCalls.push({
            method: "hibernateActiveSessions",
            excludeThreadIds: [...excludeThreadIds],
          });
          return Effect.succeed(["claude-old"]);
        },
        purgeInactiveSessions: (excludeThreadIds) => {
          claudeCalls.push({
            method: "purgeInactiveSessions",
            excludeThreadIds: [...excludeThreadIds],
          });
          return Effect.succeed(1);
        },
      },
      piSessionManager: {
        ...defaultPiSessionManager,
        hibernateActiveSessions: (excludeThreadIds) => {
          piCalls.push({
            method: "hibernateActiveSessions",
            excludeThreadIds: [...excludeThreadIds],
          });
          return Effect.succeed(["pi-old-1", "pi-old-2"]);
        },
        purgeInactiveSessions: (excludeThreadIds) => {
          piCalls.push({
            method: "purgeInactiveSessions",
            excludeThreadIds: [...excludeThreadIds],
          });
          return Effect.succeed(2);
        },
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverPurgeInactiveSessions, {
      excludeThreadIds: ["current-thread", "busy-thread"],
      hibernateActiveSessions: true,
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      sessionsHibernated: 3,
      sessionsKilled: 3,
      snapshotsCleared: 0,
    });
    expect(claudeCalls[0]).toEqual({
      method: "hibernateActiveSessions",
      excludeThreadIds: ["current-thread", "busy-thread"],
    });
    expect(piCalls[0]).toEqual({
      method: "hibernateActiveSessions",
      excludeThreadIds: ["current-thread", "busy-thread"],
    });
    expect(claudeCalls[1]).toEqual({
      method: "purgeInactiveSessions",
      excludeThreadIds: ["current-thread", "busy-thread", "claude-old", "pi-old-1", "pi-old-2"],
    });
    expect(piCalls[1]).toEqual({
      method: "purgeInactiveSessions",
      excludeThreadIds: ["current-thread", "busy-thread", "claude-old", "pi-old-1", "pi-old-2"],
    });
  });

  it("pushes server.configUpdated issues when keybindings file changes", async () => {
    const stateDir = makeTempDir("clui-state-keybindings-watch-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "[]", "utf8");

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    fs.writeFileSync(keybindingsPath, "{ not-json", "utf8");
    const malformedPush = await waitForPush(
      ws,
      WS_CHANNELS.serverConfigUpdated,
      (push) =>
        Array.isArray((push.data as { issues?: unknown[] }).issues) &&
        Boolean((push.data as { issues: Array<{ kind: string }> }).issues[0]) &&
        (push.data as { issues: Array<{ kind: string }> }).issues[0]!.kind ===
          "keybindings.malformed-config",
    );
    expect(malformedPush.data).toEqual({
      issues: [{ kind: "keybindings.malformed-config", message: expect.any(String) }],
      providers: expect.any(Array),
    });

    fs.writeFileSync(keybindingsPath, "[]", "utf8");
    const successPush = await waitForPush(
      ws,
      WS_CHANNELS.serverConfigUpdated,
      (push) =>
        Array.isArray((push.data as { issues?: unknown[] }).issues) &&
        (push.data as { issues: unknown[] }).issues.length === 0,
    );
    expect(successPush.data).toEqual({ issues: [], providers: expect.any(Array) });
  });

  it("routes shell.openInEditor through the injected open service", async () => {
    const openCalls: Array<{ cwd: string; editor: string }> = [];
    const openService: OpenShape = {
      openBrowser: () => Effect.void,
      openInEditor: (input) => {
        openCalls.push({ cwd: input.cwd, editor: input.editor });
        return Effect.void;
      },
    };

    server = await createTestServer({ cwd: "/my/workspace", open: openService });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.shellOpenInEditor, {
      cwd: "/my/workspace",
      editor: "cursor",
    });
    expect(response.error).toBeUndefined();
    expect(openCalls).toEqual([{ cwd: "/my/workspace", editor: "cursor" }]);
  });

  it("reads keybindings from the configured state directory", async () => {
    const stateDir = makeTempDir("clui-state-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([
        { key: "cmd+j", command: "terminal.toggle" },
        { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
        { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
      ]),
      "utf8",
    );
    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: compileKeybindings(persistedConfig),
      issues: [],
      providers: expect.any(Array),
      availableEditors: expect.any(Array),
      claudeCodeProxy: DEFAULT_TEST_CLAUDE_CODE_PROXY_STATUS,
      settings: DEFAULT_TEST_SERVER_SETTINGS,
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
  });

  it("upserts keybinding rules and updates cached server config", async () => {
    const stateDir = makeTempDir("clui-state-upsert-keybinding-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([{ key: "mod+j", command: "terminal.toggle" }]),
      "utf8",
    );

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const upsertResponse = await sendRequest(ws, WS_METHODS.serverUpsertKeybinding, {
      key: "mod+shift+r",
      command: "script.run-tests.run",
    });
    expect(upsertResponse.error).toBeUndefined();
    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    const persistedCommands = new Set(persistedConfig.map((entry) => entry.command));
    for (const defaultRule of DEFAULT_KEYBINDINGS) {
      expect(persistedCommands.has(defaultRule.command)).toBe(true);
    }
    expect(persistedCommands.has("script.run-tests.run")).toBe(true);
    expect(upsertResponse.result).toEqual({
      keybindings: compileKeybindings(persistedConfig),
      issues: [],
    });

    const configResponse = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(configResponse.error).toBeUndefined();
    expect(configResponse.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: compileKeybindings(persistedConfig),
      issues: [],
      providers: expect.any(Array),
      availableEditors: expect.any(Array),
      claudeCodeProxy: DEFAULT_TEST_CLAUDE_CODE_PROXY_STATUS,
      settings: DEFAULT_TEST_SERVER_SETTINGS,
    });
    expectAvailableEditors(
      (configResponse.result as { availableEditors: unknown }).availableEditors,
    );
  });

  it("returns error for unknown methods", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome push
    await waitForMessage(ws);

    const response = await sendRequest(ws, "nonexistent.method");
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Invalid request format");
  });

  it("returns error when requesting turn diff for unknown thread", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-missing",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Thread 'thread-missing' not found.");
  });

  it("returns error when requesting turn diff with an inverted range", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-any",
      fromTurnCount: 2,
      toTurnCount: 1,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "fromTurnCount must be less than or equal to toTurnCount",
    );
  });

  it("returns error when requesting full thread diff for unknown thread", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
      threadId: "thread-missing",
      toTurnCount: 2,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Thread 'thread-missing' not found.");
  });

  it("routes AI diff review generation through the backend diff-review service", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.generateDiffReview, {
      threadId: "thread-missing",
      scope: { type: "branch" },
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Diff review failed in DiffReview.resolveThreadCwd");
    expect(response.error?.message).toContain("Thread 'thread-missing' not found.");
  });

  it("routes AI diff review questions through the backend diff-review service", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.askDiffReview, {
      threadId: "thread-missing",
      filePath: "src/auth.ts",
      lineNumber: 1,
      prompt: "Explain this change.",
      contextPatch: "@@ -1 +1 @@\n-old\n+new",
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Diff review failed in DiffReview.resolveThreadCwd");
    expect(response.error?.message).toContain("Thread 'thread-missing' not found.");
  });

  it("returns retryable error when requested turn exceeds current checkpoint turn count", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const workspaceRoot = makeTempDir("clui-ws-diff-project-");
    const createdAt = new Date().toISOString();
    const createProjectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-diff-project-create",
      projectId: "project-diff",
      title: "Diff Project",
      workspaceRoot,
      defaultModel: "claude-opus-4-6",
      createdAt,
    });
    expect(createProjectResponse.error).toBeUndefined();
    const createThreadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-diff-thread-create",
      threadId: "thread-diff",
      projectId: "project-diff",
      title: "Diff Thread",
      model: "claude-opus-4-6",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    expect(createThreadResponse.error).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-diff",
      fromTurnCount: 0,
      toTurnCount: 1,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("exceeds current turn count");
  });

  it("routes terminal RPC methods and broadcasts terminal events", async () => {
    const cwd = makeTempDir("clui-ws-terminal-cwd-");
    const terminalManager = new MockTerminalManager();
    server = await createTestServer({
      cwd: "/test",
      terminalManager,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const open = await sendRequest(ws, WS_METHODS.terminalOpen, {
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
    });
    expect(open.error).toBeUndefined();
    expect((open.result as TerminalSessionSnapshot).threadId).toBe("thread-1");
    expect((open.result as TerminalSessionSnapshot).terminalId).toBe(DEFAULT_TERMINAL_ID);

    sendFireAndForget(ws, WS_METHODS.terminalWrite, {
      threadId: "thread-1",
      data: "echo hello\n",
    });

    sendFireAndForget(ws, WS_METHODS.terminalResize, {
      threadId: "thread-1",
      cols: 120,
      rows: 30,
    });

    const clear = await sendRequest(ws, WS_METHODS.terminalClear, {
      threadId: "thread-1",
    });
    expect(clear.error).toBeUndefined();

    const restart = await sendRequest(ws, WS_METHODS.terminalRestart, {
      threadId: "thread-1",
      cwd,
      cols: 120,
      rows: 30,
    });
    expect(restart.error).toBeUndefined();

    const close = await sendRequest(ws, WS_METHODS.terminalClose, {
      threadId: "thread-1",
      deleteHistory: true,
    });
    expect(close.error).toBeUndefined();

    const manualEvent: TerminalEvent = {
      type: "output",
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      createdAt: new Date().toISOString(),
      data: "manual test output\n",
    };
    terminalManager.emitEvent(manualEvent);

    const push = await waitForPush(ws, WS_CHANNELS.terminalEvent);
    expect((push.data as TerminalEvent).type).toBe("output");
  });

  it("detaches terminal event listener on stop for injected manager", async () => {
    const terminalManager = new MockTerminalManager();
    server = await createTestServer({
      cwd: "/test",
      terminalManager,
    });

    expect(terminalManager.subscriptionCount()).toBe(1);

    await closeTestServer();
    server = null;

    expect(terminalManager.subscriptionCount()).toBe(0);
  });

  it("returns validation errors for invalid terminal open params", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.terminalOpen, {
      threadId: "",
      cwd: "",
      cols: 1,
      rows: 1,
    });
    expect(response.error).toBeDefined();
  });

  it("handles invalid JSON gracefully", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome
    await waitForMessage(ws);

    // Send garbage
    ws.send("not json at all");

    let response: WebSocketResponse | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const message = asWebSocketResponse(await waitForMessage(ws));
      if (!message) {
        continue;
      }
      if (message.id === "unknown") {
        response = message;
        break;
      }
      if (message.error) {
        response = message;
        break;
      }
    }
    expect(response).toBeDefined();
    expect(response!.error).toBeDefined();
    expect(response!.error!.message).toContain("Invalid request format");
  });

  it("catches websocket message handler rejections and keeps the socket usable", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const brokenOpenService: OpenShape = {
      openBrowser: () => Effect.void,
      openInEditor: () =>
        Effect.sync(() => BigInt(1)).pipe(Effect.map((result) => result as unknown as void)),
    };

    try {
      server = await createTestServer({ cwd: "/test", open: brokenOpenService });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws);

      ws.send(
        JSON.stringify({
          id: "req-broken-open",
          body: {
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/tmp",
            editor: "cursor",
          },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandledRejections).toHaveLength(0);

      const workspace = makeTempDir("clui-ws-handler-still-usable-");
      fs.writeFileSync(path.join(workspace, "file.txt"), "ok\n", "utf8");
      const response = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
        cwd: workspace,
        query: "file",
        limit: 5,
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual(
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              path: "file.txt",
              kind: "file",
            }),
          ]),
        }),
      );
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("returns errors for removed projects CRUD methods", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const listResponse = await sendRequest(ws, WS_METHODS.projectsList);
    expect(listResponse.result).toBeUndefined();
    expect(listResponse.error?.message).toContain("Invalid request format");

    const addResponse = await sendRequest(ws, WS_METHODS.projectsAdd, {
      cwd: "/tmp/project-a",
    });
    expect(addResponse.result).toBeUndefined();
    expect(addResponse.error?.message).toContain("Invalid request format");

    const removeResponse = await sendRequest(ws, WS_METHODS.projectsRemove, {
      id: "project-a",
    });
    expect(removeResponse.result).toBeUndefined();
    expect(removeResponse.error?.message).toContain("Invalid request format");
  });

  it("supports projects.searchEntries", async () => {
    const workspace = makeTempDir("clui-ws-workspace-entries-");
    fs.mkdirSync(path.join(workspace, "src", "components"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "src", "components", "Composer.tsx"),
      "export {};",
      "utf8",
    );
    fs.writeFileSync(path.join(workspace, "README.md"), "# test", "utf8");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
      cwd: workspace,
      query: "comp",
      limit: 10,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "src/components", kind: "directory" }),
        expect.objectContaining({ path: "src/components/Composer.tsx", kind: "file" }),
      ]),
      truncated: false,
    });
  });

  it("supports projects.writeFile within the workspace root", async () => {
    const workspace = makeTempDir("clui-ws-write-file-");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "plans/effect-rpc.md",
      contents: "# Plan\n\n- step 1\n",
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      relativePath: "plans/effect-rpc.md",
    });
    expect(fs.readFileSync(path.join(workspace, "plans", "effect-rpc.md"), "utf8")).toBe(
      "# Plan\n\n- step 1\n",
    );
  });

  it("rejects projects.writeFile paths outside the workspace root", async () => {
    const workspace = makeTempDir("clui-ws-write-file-reject-");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "../escape.md",
      contents: "# no\n",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "Workspace file path must stay within the project root.",
    );
    expect(fs.existsSync(path.join(workspace, "..", "escape.md"))).toBe(false);
  });

  it("routes git core methods over websocket", async () => {
    const listBranches = vi.fn(() =>
      Effect.succeed({
        branches: [],
        isRepo: false,
      }),
    );
    const initRepo = vi.fn(() => Effect.void);
    const pullCurrentBranch = vi.fn(() =>
      Effect.fail(
        new GitCommandError({
          operation: "GitCore.test.pullCurrentBranch",
          detail: "No upstream configured",
          command: "git pull",
          cwd: "/repo/path",
        }),
      ),
    );

    server = await createTestServer({
      cwd: "/test",
      gitCore: {
        listBranches,
        initRepo,
        pullCurrentBranch,
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const listResponse = await sendRequest(ws, WS_METHODS.gitListBranches, { cwd: "/repo/path" });
    expect(listResponse.error).toBeUndefined();
    expect(listResponse.result).toEqual({ branches: [], isRepo: false });
    expect(listBranches).toHaveBeenCalledWith({ cwd: "/repo/path" });

    const initResponse = await sendRequest(ws, WS_METHODS.gitInit, { cwd: "/repo/path" });
    expect(initResponse.error).toBeUndefined();
    expect(initRepo).toHaveBeenCalledWith({ cwd: "/repo/path" });

    const pullResponse = await sendRequest(ws, WS_METHODS.gitPull, { cwd: "/repo/path" });
    expect(pullResponse.result).toBeUndefined();
    expect(pullResponse.error?.message).toContain("No upstream configured");
    expect(pullCurrentBranch).toHaveBeenCalledWith("/repo/path");
  });

  it("supports git.status over websocket", async () => {
    const statusResult = {
      branch: "feature/test",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/index.ts", insertions: 7, deletions: 2 }],
        insertions: 7,
        deletions: 2,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const status = vi.fn(() => Effect.succeed(statusResult));
    const runStackedAction = vi.fn(() => Effect.void as any);
    const resolvePullRequest = vi.fn(() => Effect.void as any);
    const preparePullRequestThread = vi.fn(() => Effect.void as any);
    const gitManager: GitManagerShape = {
      status,
      resolvePullRequest,
      preparePullRequestThread,
      runStackedAction,
    };

    server = await createTestServer({ cwd: "/test", gitManager });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.gitStatus, {
      cwd: "/test",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(statusResult);
    expect(status).toHaveBeenCalledWith({ cwd: "/test" });
  });

  it("supports git pull request routing over websocket", async () => {
    const resolvePullRequestResult = {
      pullRequest: {
        number: 42,
        title: "PR thread flow",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open" as const,
      },
    };
    const preparePullRequestThreadResult = {
      ...resolvePullRequestResult,
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    };

    const gitManager: GitManagerShape = {
      status: vi.fn(() => Effect.void as any),
      resolvePullRequest: vi.fn(() => Effect.succeed(resolvePullRequestResult)),
      preparePullRequestThread: vi.fn(() => Effect.succeed(preparePullRequestThreadResult)),
      runStackedAction: vi.fn(() => Effect.void as any),
    };

    server = await createTestServer({ cwd: "/test", gitManager });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const resolveResponse = await sendRequest(ws, WS_METHODS.gitResolvePullRequest, {
      cwd: "/test",
      reference: "#42",
    });
    expect(resolveResponse.error).toBeUndefined();
    expect(resolveResponse.result).toEqual(resolvePullRequestResult);

    const prepareResponse = await sendRequest(ws, WS_METHODS.gitPreparePullRequestThread, {
      cwd: "/test",
      reference: "42",
      mode: "worktree",
    });
    expect(prepareResponse.error).toBeUndefined();
    expect(prepareResponse.result).toEqual(preparePullRequestThreadResult);
    expect(gitManager.resolvePullRequest).toHaveBeenCalledWith({
      cwd: "/test",
      reference: "#42",
    });
    expect(gitManager.preparePullRequestThread).toHaveBeenCalledWith({
      cwd: "/test",
      reference: "42",
      mode: "worktree",
    });
  });

  it("returns errors from git.runStackedAction", async () => {
    const runStackedAction = vi.fn(() =>
      Effect.fail(
        new GitManagerError({
          operation: "GitManager.test.runStackedAction",
          detail: "Cannot push from detached HEAD.",
        }),
      ),
    );
    const gitManager: GitManagerShape = {
      status: vi.fn(() => Effect.void as any),
      resolvePullRequest: vi.fn(() => Effect.void as any),
      preparePullRequestThread: vi.fn(() => Effect.void as any),
      runStackedAction,
    };

    server = await createTestServer({ cwd: "/test", gitManager });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.gitRunStackedAction, {
      cwd: "/test",
      action: "commit_push",
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("detached HEAD");
    expect(runStackedAction).toHaveBeenCalledWith({
      cwd: "/test",
      action: "commit_push",
    });
  });

  it("rejects websocket connections without a valid auth token", async () => {
    server = await createTestServer({ cwd: "/test", authToken: "secret-token" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    await expect(connectWs(port)).rejects.toThrow("WebSocket connection failed");

    const authorizedWs = await connectWs(port, "secret-token");
    connections.push(authorizedWs);
    const welcome = (await waitForMessage(authorizedWs)) as WsPush;
    expect(welcome.channel).toBe(WS_CHANNELS.serverWelcome);
  });

  function makeStartupOnlyProjectionSnapshotQuery(): ProjectionSnapshotQueryShape {
    let snapshotReads = 0;
    const startupSnapshot = (): OrchestrationReadModel => ({
      snapshotSequence: 0,
      projects: [],
      threads: [],
      updatedAt: new Date().toISOString(),
    });
    return {
      getSnapshot: () =>
        Effect.sync(() => {
          snapshotReads++;
          if (snapshotReads > 2) {
            throw new Error("session start should not read full snapshot");
          }
          return startupSnapshot();
        }),
      getSessionMetrics: () => Effect.die(new Error("unused in this test")),
    };
  }

  function makeObservableClaudeSession() {
    const listeners = new Set<(event: ClaudeSessionEvent) => void>();
    const shape: ClaudeSessionManagerShape = {
      ...defaultClaudeSessionManager,
      subscribe: (listener) =>
        Effect.sync(() => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
    };
    return {
      shape,
      emit: (event: ClaudeSessionEvent) => {
        for (const listener of listeners) listener(event);
      },
    };
  }

  function makeObservablePiSession() {
    const listeners = new Set<(event: PiSessionEvent) => void>();
    const hookStatusByThreadId = new Map<string, ClaudeHookStatus | null>();
    const activityStatusByThreadId = new Map<string, AgentActivityStatus | null>();
    const shape: PiSessionManagerShape = {
      ...defaultPiSessionManager,
      getSessionHookStatus: (threadId) =>
        Effect.succeed(hookStatusByThreadId.get(threadId) ?? null),
      getSessionActivityStatus: (threadId) =>
        Effect.succeed(activityStatusByThreadId.get(threadId) ?? null),
      subscribe: (listener) =>
        Effect.sync(() => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
    };
    return {
      shape,
      setHookStatus: (threadId: string, hookStatus: ClaudeHookStatus | null) => {
        hookStatusByThreadId.set(threadId, hookStatus);
      },
      setActivityStatus: (threadId: string, activityStatus: AgentActivityStatus | null) => {
        activityStatusByThreadId.set(threadId, activityStatus);
      },
      emit: (event: PiSessionEvent) => {
        for (const listener of listeners) listener(event);
      },
    };
  }

  async function createProjectedThread(
    ws: WebSocket,
    input: {
      projectId: string;
      threadId: string;
      workspaceRoot: string;
      worktreePath: string | null;
      harness?: "claudeCode" | "codexCli" | "pi";
      claudeCodeBackend?: "anthropic" | "codex";
      model?: string;
    },
  ): Promise<void> {
    const createdAt = new Date().toISOString();
    const createProjectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: `cmd-project-${input.projectId}`,
      projectId: input.projectId,
      title: "Project",
      workspaceRoot: input.workspaceRoot,
      defaultModel: "claude-opus-4-6",
      createdAt,
    });
    expect(createProjectResponse.error).toBeUndefined();

    const createThreadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: `cmd-thread-${input.threadId}`,
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Thread",
      model: input.model ?? "claude-opus-4-6",
      harness: input.harness ?? "claudeCode",
      claudeCodeBackend: input.claudeCodeBackend ?? "anthropic",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: input.worktreePath,
      createdAt,
    });
    expect(createThreadResponse.error).toBeUndefined();
  }

  describe("harness output subscriptions", () => {
    it("sends Claude output only to clients subscribed to that thread", async () => {
      const claudeSession = makeObservableClaudeSession();
      server = await createTestServer({
        cwd: "/test/project",
        claudeSessionManager: claudeSession.shape,
      });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const subscribedWs = await connectWs(port);
      const unsubscribedWs = await connectWs(port);
      connections.push(subscribedWs, unsubscribedWs);
      await waitForMessage(subscribedWs); // welcome
      await waitForMessage(unsubscribedWs); // welcome

      const subscribeResponse = await sendRequest(
        subscribedWs,
        WS_METHODS.serverSetHarnessOutputSubscriptions,
        {
          claudeThreadIds: ["thread-1"],
          piThreadIds: [],
        },
      );
      expect(subscribeResponse.error).toBeUndefined();

      claudeSession.emit({
        type: "output",
        threadId: "thread-1",
        createdAt: new Date().toISOString(),
        data: "visible output",
        offset: 14,
      });

      await waitForPush(subscribedWs, WS_CHANNELS.claudeSessionEvent, (push) => {
        const event = push.data as ClaudeSessionEvent;
        return event.type === "output" && event.data === "visible output";
      });
      await expectNoMatchingPush(unsubscribedWs, WS_CHANNELS.claudeSessionEvent, (push) => {
        const event = push.data as ClaudeSessionEvent;
        return event.type === "output" && event.data === "visible output";
      });

      claudeSession.emit({
        type: "hookStatus",
        threadId: "thread-1",
        createdAt: new Date().toISOString(),
        hookStatus: "working",
      });

      await waitForPush(subscribedWs, WS_CHANNELS.claudeSessionEvent, (push) => {
        const event = push.data as ClaudeSessionEvent;
        return event.type === "hookStatus" && event.hookStatus === "working";
      });
      await waitForPush(unsubscribedWs, WS_CHANNELS.claudeSessionEvent, (push) => {
        const event = push.data as ClaudeSessionEvent;
        return event.type === "hookStatus" && event.hookStatus === "working";
      });
    });

    it("hydrates current pi hook and activity statuses into snapshots for clients that missed the live event", async () => {
      const workspaceRoot = makeTempDir("clui-ws-pi-hook-snapshot-");
      const piSession = makeObservablePiSession();
      server = await createTestServer({
        cwd: workspaceRoot,
        piSessionManager: piSession.shape,
      });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome

      await createProjectedThread(ws, {
        projectId: "project-1",
        threadId: "thread-1",
        workspaceRoot,
        worktreePath: null,
        harness: "pi",
      });

      piSession.setHookStatus("thread-1", "working");
      piSession.setActivityStatus("thread-1", "committing");
      piSession.emit({
        type: "started",
        threadId: "thread-1",
        createdAt: new Date().toISOString(),
      });

      await waitForAssertion(async () => {
        const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
        expect(response.error).toBeUndefined();
        const snapshot = response.result as OrchestrationReadModel;
        const thread = snapshot.threads.find((entry) => entry.id === "thread-1");
        expect(thread?.terminalStatus).toBe("active");
        expect(thread?.hookStatus).toBe("working");
        expect(thread?.activityStatus).toBe("committing");
      });
    });

    it("sends pi output only to clients subscribed to that thread", async () => {
      const piSession = makeObservablePiSession();
      server = await createTestServer({
        cwd: "/test/project",
        piSessionManager: piSession.shape,
      });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const subscribedWs = await connectWs(port);
      const unsubscribedWs = await connectWs(port);
      connections.push(subscribedWs, unsubscribedWs);
      await waitForMessage(subscribedWs); // welcome
      await waitForMessage(unsubscribedWs); // welcome

      const subscribeResponse = await sendRequest(
        subscribedWs,
        WS_METHODS.serverSetHarnessOutputSubscriptions,
        {
          claudeThreadIds: [],
          piThreadIds: ["thread-1"],
        },
      );
      expect(subscribeResponse.error).toBeUndefined();

      piSession.emit({
        type: "output",
        threadId: "thread-1",
        createdAt: new Date().toISOString(),
        data: "pi visible output",
        offset: 17,
      });

      await waitForPush(subscribedWs, WS_CHANNELS.piSessionEvent, (push) => {
        const event = push.data as PiSessionEvent;
        return event.type === "output" && event.data === "pi visible output";
      });
      await expectNoMatchingPush(unsubscribedWs, WS_CHANNELS.piSessionEvent, (push) => {
        const event = push.data as PiSessionEvent;
        return event.type === "output" && event.data === "pi visible output";
      });

      piSession.emit({
        type: "hookStatus",
        threadId: "thread-1",
        createdAt: new Date().toISOString(),
        hookStatus: "working",
      });

      await waitForPush(subscribedWs, WS_CHANNELS.piSessionEvent, (push) => {
        const event = push.data as PiSessionEvent;
        return event.type === "hookStatus" && event.hookStatus === "working";
      });
      await waitForPush(unsubscribedWs, WS_CHANNELS.piSessionEvent, (push) => {
        const event = push.data as PiSessionEvent;
        return event.type === "hookStatus" && event.hookStatus === "working";
      });
    });
  });

  describe("claude session routes", () => {
    function makeMockClaudeSession() {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const shape: ClaudeSessionManagerShape = {
        startSession: (input) => {
          calls.push({ method: "startSession", args: [input] });
          return Effect.void;
        },
        hibernateSession: (threadId) => {
          calls.push({ method: "hibernateSession", args: [threadId] });
          return Effect.void;
        },
        getScrollback: (threadId, _sinceOffset) => {
          calls.push({ method: "getScrollback", args: [threadId] });
          return Effect.succeed({ scrollback: "scrollback-data", offset: 42, reset: false });
        },
        writeToSession: (threadId, data) => {
          calls.push({ method: "writeToSession", args: [threadId, data] });
          return Effect.void;
        },
        resizeSession: (threadId, cols, rows) => {
          calls.push({ method: "resizeSession", args: [threadId, cols, rows] });
          return Effect.void;
        },
        getSessionStatus: () => Effect.succeed("new" as const),
        reconcileActiveSessions: () => Effect.void,
        setMaxActiveSessions: () => Effect.void,
        hibernateAll: () => Effect.void,
        hibernateActiveSessions: () => Effect.succeed([]),
        subscribe: () => Effect.succeed(() => {}),
        getClaudeSessionId: () => Effect.succeed(null),
        recordCodexSessionId: (threadId, sessionId) => {
          calls.push({ method: "recordCodexSessionId", args: [threadId, sessionId] });
          return Effect.void;
        },
        destroySession: () => Effect.void,
        purgeInactiveSessions: () => Effect.succeed(0),
        getClaudeCodeProxyStatus: () => {
          calls.push({ method: "getClaudeCodeProxyStatus", args: [] });
          return Effect.succeed(DEFAULT_TEST_CLAUDE_CODE_PROXY_STATUS);
        },
        startClaudeCodeProxyLogin: () => {
          calls.push({ method: "startClaudeCodeProxyLogin", args: [] });
          return Effect.succeed({
            available: true,
            authenticated: false,
            running: false,
            authInProgress: true,
          });
        },
        logoutClaudeCodeProxy: () => {
          calls.push({ method: "logoutClaudeCodeProxy", args: [] });
          return Effect.succeed({
            available: true,
            authenticated: false,
            running: false,
            authInProgress: false,
          });
        },
        dispose: Effect.void,
      };
      return { calls, shape };
    }

    it("claude.start calls startSession with correct params and returns success", async () => {
      const { calls, shape } = makeMockClaudeSession();
      const workspaceRoot = makeTempDir("clui-ws-claude-start-");
      server = await createTestServer({ cwd: workspaceRoot, claudeSessionManager: shape });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome

      await createProjectedThread(ws, {
        projectId: "project-1",
        threadId: "thread-1",
        workspaceRoot,
        worktreePath: null,
        claudeCodeBackend: "codex",
        model: "gpt-5.6-sol",
      });

      const response = await sendRequest(ws, WS_METHODS.claudeStart, {
        threadId: "thread-1",
        cwd: workspaceRoot,
        cols: 80,
        rows: 24,
      });

      expect(response.error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("startSession");
      expect(calls[0]!.args[0]).toMatchObject({
        threadId: "thread-1",
        cwd: workspaceRoot,
        harness: "claudeCode",
        cols: 80,
        rows: 24,
        claudeCodeBackend: "codex",
        model: "gpt-5.6-sol",
      });
    });

    it("claude.start launches the Codex CLI harness selected by the thread", async () => {
      const { calls, shape } = makeMockClaudeSession();
      const workspaceRoot = makeTempDir("clui-ws-codex-start-");
      server = await createTestServer({ cwd: workspaceRoot, claudeSessionManager: shape });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws);

      await createProjectedThread(ws, {
        projectId: "project-codex",
        threadId: "thread-codex",
        workspaceRoot,
        worktreePath: null,
        harness: "codexCli",
        model: "gpt-5.6-sol",
      });

      const response = await sendRequest(ws, WS_METHODS.claudeStart, {
        threadId: "thread-codex",
        cwd: workspaceRoot,
        cols: 100,
        rows: 30,
        executionMode: "exec",
        initialPrompt: "Advance the Journey graph",
      });

      expect(response.error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "startSession",
        args: [
          {
            threadId: "thread-codex",
            harness: "codexCli",
            model: "gpt-5.6-sol",
            executionMode: "exec",
            initialPrompt: "Advance the Journey graph",
          },
        ],
      });
    });

    it("routes managed Codex proxy login and logout", async () => {
      const { calls, shape } = makeMockClaudeSession();
      server = await createTestServer({ cwd: "/test/project", claudeSessionManager: shape });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws);

      const loginResponse = await sendRequest(ws, WS_METHODS.serverStartClaudeCodeProxyLogin);
      const logoutResponse = await sendRequest(ws, WS_METHODS.serverLogoutClaudeCodeProxy);

      expect(loginResponse.error).toBeUndefined();
      expect(loginResponse.result).toMatchObject({ authInProgress: true });
      expect(logoutResponse.error).toBeUndefined();
      expect(logoutResponse.result).toMatchObject({ authInProgress: false });
      expect(calls.map((call) => call.method)).toEqual([
        "startClaudeCodeProxyLogin",
        "logoutClaudeCodeProxy",
      ]);
    });

    it("claude.hibernate calls hibernateSession and returns no payload", async () => {
      const { calls, shape } = makeMockClaudeSession();
      server = await createTestServer({ cwd: "/test/project", claudeSessionManager: shape });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome

      const response = await sendRequest(ws, WS_METHODS.claudeHibernate, {
        threadId: "thread-1",
      });

      expect(response.error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("hibernateSession");
      expect(calls[0]!.args[0]).toBe("thread-1");
      expect(response.result).toBeUndefined();
    });

    it("claude.getScrollback calls getScrollback and returns scrollback data", async () => {
      const { calls, shape } = makeMockClaudeSession();
      server = await createTestServer({ cwd: "/test/project", claudeSessionManager: shape });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome

      const response = await sendRequest(ws, WS_METHODS.claudeGetScrollback, {
        threadId: "thread-1",
      });

      expect(response.error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("getScrollback");
      expect(calls[0]!.args[0]).toBe("thread-1");
      expect(response.result).toEqual({
        threadId: "thread-1",
        scrollback: "scrollback-data",
        offset: 42,
        reset: false,
      });
    });

    it("claude.write calls writeToSession with correct data", async () => {
      const { calls, shape } = makeMockClaudeSession();
      server = await createTestServer({ cwd: "/test/project", claudeSessionManager: shape });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome

      // claude.write is fire-and-forget — no response sent
      sendFireAndForget(ws, WS_METHODS.claudeWrite, {
        threadId: "thread-1",
        data: "hello world",
      });

      // Give the server a tick to process the message
      await new Promise((r) => setTimeout(r, 50));

      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("writeToSession");
      expect(calls[0]!.args[0]).toBe("thread-1");
      expect(calls[0]!.args[1]).toBe("hello world");
    });

    it("claude.resize calls resizeSession with correct dimensions", async () => {
      const { calls, shape } = makeMockClaudeSession();
      server = await createTestServer({ cwd: "/test/project", claudeSessionManager: shape });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome

      // claude.resize is fire-and-forget — no response sent
      sendFireAndForget(ws, WS_METHODS.claudeResize, {
        threadId: "thread-1",
        cols: 120,
        rows: 40,
      });

      // Give the server a tick to process the message
      await new Promise((r) => setTimeout(r, 50));

      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("resizeSession");
      expect(calls[0]!.args[0]).toBe("thread-1");
      expect(calls[0]!.args[1]).toBe(120);
      expect(calls[0]!.args[2]).toBe(40);
    });

    it("claude.start allows a registered worktree outside the server root", async () => {
      const { calls, shape } = makeMockClaudeSession();
      const workspaceRoot = makeTempDir("clui-ws-claude-root-");
      const worktreeRoot = makeTempDir("clui-ws-claude-worktree-");
      server = await createTestServer({
        cwd: workspaceRoot,
        claudeSessionManager: shape,
        projectionSnapshotQuery: makeStartupOnlyProjectionSnapshotQuery(),
      });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome
      await createProjectedThread(ws, {
        projectId: "project-claude-worktree",
        threadId: "thread-claude-worktree",
        workspaceRoot,
        worktreePath: worktreeRoot,
      });

      const startCwd = path.join(worktreeRoot, "subdir");
      const response = await sendRequest(ws, WS_METHODS.claudeStart, {
        threadId: "thread-claude-worktree",
        cwd: startCwd,
        cols: 80,
        rows: 24,
      });

      expect(response.error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("startSession");
      expect(calls[0]!.args[0]).toMatchObject({
        threadId: "thread-claude-worktree",
        cwd: startCwd,
      });
    });

    it("claude.start allows the thread project outside the server root", async () => {
      const { calls, shape } = makeMockClaudeSession();
      const serverRoot = makeTempDir("clui-ws-claude-server-root-");
      const projectRoot = makeTempDir("clui-ws-claude-project-root-");
      server = await createTestServer({
        cwd: serverRoot,
        claudeSessionManager: shape,
        projectionSnapshotQuery: makeStartupOnlyProjectionSnapshotQuery(),
      });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome
      await createProjectedThread(ws, {
        projectId: "project-claude-local",
        threadId: "thread-claude-local",
        workspaceRoot: projectRoot,
        worktreePath: null,
      });

      const startCwd = path.join(projectRoot, "packages", "api");
      const response = await sendRequest(ws, WS_METHODS.claudeStart, {
        threadId: "thread-claude-local",
        cwd: startCwd,
        cols: 80,
        rows: 24,
      });

      expect(response.error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0]).toMatchObject({
        threadId: "thread-claude-local",
        cwd: startCwd,
      });
    });

    it("claude.start rejects a directory outside the thread project and worktree", async () => {
      const { calls, shape } = makeMockClaudeSession();
      const serverRoot = makeTempDir("clui-ws-claude-server-root-");
      const projectRoot = makeTempDir("clui-ws-claude-project-root-");
      const unrelatedRoot = makeTempDir("clui-ws-claude-unrelated-root-");
      server = await createTestServer({ cwd: serverRoot, claudeSessionManager: shape });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome
      await createProjectedThread(ws, {
        projectId: "project-claude-contained",
        threadId: "thread-claude-contained",
        workspaceRoot: projectRoot,
        worktreePath: null,
      });

      const response = await sendRequest(ws, WS_METHODS.claudeStart, {
        threadId: "thread-claude-contained",
        cwd: unrelatedRoot,
        cols: 80,
        rows: 24,
      });

      expect(response.error?.message).toContain(
        "cwd must be within the server workspace, thread project, or worktree",
      );
      expect(calls).toHaveLength(0);
    });

    it("claude.start passes resumeSessionId when provided", async () => {
      const { calls, shape } = makeMockClaudeSession();
      const workspaceRoot = makeTempDir("clui-ws-claude-resume-");
      server = await createTestServer({ cwd: workspaceRoot, claudeSessionManager: shape });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome

      await createProjectedThread(ws, {
        projectId: "project-resume",
        threadId: "thread-resume",
        workspaceRoot,
        worktreePath: null,
      });

      const response = await sendRequest(ws, WS_METHODS.claudeStart, {
        threadId: "thread-resume",
        cwd: workspaceRoot,
        cols: 80,
        rows: 24,
        resumeSessionId: "existing-session-id",
      });

      expect(response.error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("startSession");
      expect(calls[0]!.args[0]).toMatchObject({
        threadId: "thread-resume",
        cwd: workspaceRoot,
        cols: 80,
        rows: 24,
        resumeSessionId: "existing-session-id",
        claudeCodeBackend: "anthropic",
        model: "claude-opus-4-6",
      });
    });
  });

  describe("pi session routes", () => {
    function makeMockPiSession() {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const shape: PiSessionManagerShape = {
        ...defaultPiSessionManager,
        startSession: (input) => {
          calls.push({ method: "startSession", args: [input] });
          return Effect.void;
        },
      };
      return { calls, shape };
    }

    it("pi.start forwards an initial prompt for pi to submit after startup", async () => {
      const { calls, shape } = makeMockPiSession();
      const workspaceRoot = makeTempDir("clui-ws-pi-initial-prompt-");
      server = await createTestServer({
        cwd: workspaceRoot,
        piSessionManager: shape,
      });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome

      const response = await sendRequest(ws, WS_METHODS.piStart, {
        threadId: "thread-pi-initial",
        cwd: workspaceRoot,
        cols: 80,
        rows: 24,
        fresh: true,
        initialPrompt: "fix the pi launch prompt",
        fastMode: true,
      });

      expect(response.error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("startSession");
      expect(calls[0]!.args[0]).toMatchObject({
        threadId: "thread-pi-initial",
        cwd: workspaceRoot,
        fresh: true,
        initialPrompt: "fix the pi launch prompt",
        fastMode: true,
      });
    });

    it("pi.start allows a registered worktree outside the server root", async () => {
      const { calls, shape } = makeMockPiSession();
      const workspaceRoot = makeTempDir("clui-ws-pi-root-");
      const worktreeRoot = makeTempDir("clui-ws-pi-worktree-");
      server = await createTestServer({
        cwd: workspaceRoot,
        piSessionManager: shape,
        projectionSnapshotQuery: makeStartupOnlyProjectionSnapshotQuery(),
      });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome
      await createProjectedThread(ws, {
        projectId: "project-pi-worktree",
        threadId: "thread-pi-worktree",
        workspaceRoot,
        worktreePath: worktreeRoot,
        harness: "pi",
      });

      const startCwd = path.join(worktreeRoot, "subdir");
      const response = await sendRequest(ws, WS_METHODS.piStart, {
        threadId: "thread-pi-worktree",
        cwd: startCwd,
        cols: 80,
        rows: 24,
        fresh: true,
      });

      expect(response.error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("startSession");
      expect(calls[0]!.args[0]).toMatchObject({
        threadId: "thread-pi-worktree",
        cwd: startCwd,
        fresh: true,
      });
    });

    it("pi.start allows the thread project outside the server root", async () => {
      const { calls, shape } = makeMockPiSession();
      const serverRoot = makeTempDir("clui-ws-pi-server-root-");
      const projectRoot = makeTempDir("clui-ws-pi-project-root-");
      server = await createTestServer({
        cwd: serverRoot,
        piSessionManager: shape,
        projectionSnapshotQuery: makeStartupOnlyProjectionSnapshotQuery(),
      });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws); // welcome
      await createProjectedThread(ws, {
        projectId: "project-pi-local",
        threadId: "thread-pi-local",
        workspaceRoot: projectRoot,
        worktreePath: null,
        harness: "pi",
      });

      const startCwd = path.join(projectRoot, "packages", "api");
      const response = await sendRequest(ws, WS_METHODS.piStart, {
        threadId: "thread-pi-local",
        cwd: startCwd,
        cols: 80,
        rows: 24,
        fresh: true,
      });

      expect(response.error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0]).toMatchObject({
        threadId: "thread-pi-local",
        cwd: startCwd,
        fresh: true,
      });
    });
  });
});

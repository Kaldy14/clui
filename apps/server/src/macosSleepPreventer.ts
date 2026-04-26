import { spawn, type ChildProcess } from "node:child_process";

import { Effect, Layer, ServiceMap } from "effect";

import { createLogger } from "./logger";
import { ServerConfig } from "./config";
import { loadServerSettings } from "./serverSettings";

const logger = createLogger("macos-sleep-preventer");
const CAFFEINATE_ARGS = ["-dims"] as const;

export interface MacosSleepPreventerShape {
  readonly setEnabled: (enabled: boolean) => Effect.Effect<void>;
  readonly setThreadInProgress: (threadId: string, inProgress: boolean) => Effect.Effect<void>;
  readonly clearThread: (threadId: string) => Effect.Effect<void>;
  readonly dispose: Effect.Effect<void>;
}

export class MacosSleepPreventer extends ServiceMap.Service<
  MacosSleepPreventer,
  MacosSleepPreventerShape
>()("clui/server/MacosSleepPreventer") {}

export interface MacosSleepPreventerRuntimeOptions {
  readonly enabled: boolean;
  readonly platform?: NodeJS.Platform;
  readonly spawnCaffeinate?: () => ChildProcess;
}

export class MacosSleepPreventerRuntime {
  private enabled: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly spawnCaffeinate: () => ChildProcess;
  private readonly inProgressThreadIds = new Set<string>();
  private caffeinateProcess: ChildProcess | null = null;
  private unavailable = false;

  constructor(options: MacosSleepPreventerRuntimeOptions) {
    this.enabled = options.enabled;
    this.platform = options.platform ?? process.platform;
    this.spawnCaffeinate =
      options.spawnCaffeinate ??
      (() => spawn("caffeinate", [...CAFFEINATE_ARGS], { stdio: "ignore" }));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.unavailable = false;
    }
    this.reconcile();
  }

  setThreadInProgress(threadId: string, inProgress: boolean): void {
    if (inProgress) {
      this.inProgressThreadIds.add(threadId);
    } else {
      this.inProgressThreadIds.delete(threadId);
    }
    this.reconcile();
  }

  clearThread(threadId: string): void {
    this.inProgressThreadIds.delete(threadId);
    this.reconcile();
  }

  dispose(): void {
    this.inProgressThreadIds.clear();
    this.stopCaffeinate();
  }

  private shouldPreventSleep(): boolean {
    return (
      this.enabled &&
      this.platform === "darwin" &&
      !this.unavailable &&
      this.inProgressThreadIds.size > 0
    );
  }

  private reconcile(): void {
    if (!this.shouldPreventSleep()) {
      this.stopCaffeinate();
      return;
    }

    if (!this.caffeinateProcess) {
      this.startCaffeinate();
    }
  }

  private startCaffeinate(): void {
    try {
      const child = this.spawnCaffeinate();
      this.caffeinateProcess = child;
      child.unref?.();

      child.once("error", (error) => {
        if (this.caffeinateProcess === child) {
          this.caffeinateProcess = null;
        }
        this.unavailable = true;
        logger.warn("failed to start caffeinate; macOS sleep prevention disabled", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      child.once("exit", (code, signal) => {
        if (this.caffeinateProcess !== child) return;
        this.caffeinateProcess = null;
        if (this.shouldPreventSleep()) {
          logger.warn("caffeinate exited while threads are still in progress", { code, signal });
        }
      });

      logger.info("preventing macOS sleep while threads are in progress", {
        pid: child.pid,
        threadCount: this.inProgressThreadIds.size,
      });
    } catch (error) {
      this.caffeinateProcess = null;
      this.unavailable = true;
      logger.warn("failed to spawn caffeinate; macOS sleep prevention disabled", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopCaffeinate(): void {
    const child = this.caffeinateProcess;
    if (!child) return;
    this.caffeinateProcess = null;
    try {
      child.kill("SIGTERM");
    } catch (error) {
      logger.warn("failed to stop caffeinate", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const MacosSleepPreventerLive = Layer.effect(
  MacosSleepPreventer,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const settings = yield* Effect.promise(() => loadServerSettings(serverConfig.stateDir));
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new MacosSleepPreventerRuntime({
            enabled: settings.preventMacosSleepWhenThreadInProgress,
          }),
      ),
      (runtime) => Effect.sync(() => runtime.dispose()),
    );

    return {
      setEnabled: (enabled) => Effect.sync(() => runtime.setEnabled(enabled)),
      setThreadInProgress: (threadId, inProgress) =>
        Effect.sync(() => runtime.setThreadInProgress(threadId, inProgress)),
      clearThread: (threadId) => Effect.sync(() => runtime.clearThread(threadId)),
      dispose: Effect.sync(() => runtime.dispose()),
    } satisfies MacosSleepPreventerShape;
  }),
);

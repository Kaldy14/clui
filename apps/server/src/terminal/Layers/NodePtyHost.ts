/**
 * NodePtyHost — PtyAdapter that delegates to a Node.js subprocess (pty-host.mjs)
 * running node-pty. This works around Bun's broken terminal pty support
 * (isatty() returns false in Bun.spawn terminal children) and node-pty's
 * native addon crashing under Bun (ENXIO).
 *
 * Architecture:
 *   Bun server  <—stdin/stdout JSON IPC—>  node pty-host.mjs  <—real pty—>  child process
 */
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Readable } from "node:stream";

import { Effect, Layer } from "effect";

import { PtyAdapter, type PtyAdapterShape, type PtyExitEvent, type PtyProcess } from "../Services/PTY";

const PTY_HOST_PATH = new URL("../pty-host.mjs", import.meta.url).pathname;

interface PtyHostMessage {
  type: "data" | "exit" | "pid" | "error";
  data?: string;
  exitCode?: number;
  signal?: number | null;
  pid?: number;
  message?: string;
}

class NodePtyHostProcess implements PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private didExit = false;
  private _pid = 0;
  private readonly subprocess: ReturnType<typeof Bun.spawn>;
  private readonly readline: ReadlineInterface;

  constructor(subprocess: ReturnType<typeof Bun.spawn>) {
    this.subprocess = subprocess;

    // Read JSON lines from the host's stdout
    const stdoutStream = Readable.fromWeb(subprocess.stdout as any);
    this.readline = createInterface({ input: stdoutStream });
    this.readline.on("line", (line: string) => {
      try {
        const msg: PtyHostMessage = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // Ignore malformed lines
      }
    });

    // If the host process dies unexpectedly, emit an exit event
    subprocess.exited.then((code) => {
      if (!this.didExit) {
        this.emitExit({ exitCode: code ?? 1, signal: null });
      }
    });
  }

  get pid(): number {
    return this._pid;
  }

  write(data: string): void {
    this.sendCommand({ type: "write", data });
  }

  resize(cols: number, rows: number): void {
    this.sendCommand({ type: "resize", cols, rows });
  }

  kill(signal?: string): void {
    this.sendCommand({ type: "kill", signal: signal || "SIGTERM" });
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  private handleMessage(msg: PtyHostMessage): void {
    switch (msg.type) {
      case "pid":
        this._pid = msg.pid ?? 0;
        break;
      case "data":
        if (msg.data) {
          for (const listener of this.dataListeners) {
            listener(msg.data);
          }
        }
        break;
      case "exit":
        this.emitExit({
          exitCode: msg.exitCode ?? 0,
          signal: msg.signal ?? null,
        });
        break;
      case "error":
        // Treat host-level errors as exit
        this.emitExit({ exitCode: 1, signal: null });
        break;
    }
  }

  private emitExit(event: PtyExitEvent): void {
    if (this.didExit) return;
    this.didExit = true;
    for (const listener of this.exitListeners) {
      listener(event);
    }
    this.readline.close();
  }

  private sendCommand(cmd: Record<string, unknown>): void {
    try {
      const stdin = this.subprocess.stdin;
      if (stdin && typeof stdin !== "number") {
        stdin.write(JSON.stringify(cmd) + "\n");
      }
    } catch {
      // stdin may be closed if host already exited
    }
  }
}

export const NodePtyHostAdapterLive = Layer.succeed(PtyAdapter, {
  spawn: (input) =>
    Effect.sync(() => {
      const envJson = JSON.stringify(input.env);

      const subprocess = Bun.spawn(
        [
          "node",
          PTY_HOST_PATH,
          input.shell,
          input.cwd,
          String(input.cols),
          String(input.rows),
          ...(input.args ?? []),
        ],
        {
          cwd: input.cwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
          env: {
            ...process.env,
            __PTY_HOST_ENV_JSON: envJson,
          },
        },
      );

      return new NodePtyHostProcess(subprocess);
    }),
} satisfies PtyAdapterShape);

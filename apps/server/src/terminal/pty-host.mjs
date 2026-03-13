#!/usr/bin/env node
/**
 * pty-host.mjs — Node.js subprocess that owns a real pseudo-terminal via node-pty.
 *
 * Bun's Bun.spawn({ terminal }) does NOT create a true tty (isatty() returns false),
 * and node-pty's native addon crashes under Bun with ENXIO. This host runs under
 * Node.js so node-pty works correctly, and the parent Bun process communicates
 * with it over stdin/stdout using newline-delimited JSON.
 *
 * Usage:
 *   node pty-host.mjs <shell> <cwd> <cols> <rows> [args...]
 *
 * Protocol (stdin → host, JSON per line):
 *   { "type": "write", "data": "<string>" }
 *   { "type": "resize", "cols": <number>, "rows": <number> }
 *   { "type": "kill", "signal": "<string>" }
 *
 * Protocol (host → stdout, JSON per line):
 *   { "type": "data", "data": "<string>" }
 *   { "type": "exit", "exitCode": <number>, "signal": <number|null> }
 *   { "type": "pid", "pid": <number> }
 *   { "type": "error", "message": "<string>" }
 */

import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { chmodSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);

// Ensure spawn-helper is executable (same logic as NodePTY.ts)
try {
  const packageJsonPath = require.resolve("node-pty/package.json");
  const packageDir = dirname(packageJsonPath);
  const candidates = [
    join(packageDir, "build", "Release", "spawn-helper"),
    join(packageDir, "build", "Debug", "spawn-helper"),
    join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        chmodSync(candidate, 0o755);
      } catch {}
      break;
    }
  }
} catch {}

const pty = require("node-pty");

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// Parse argv
const [, , shell, cwd, colsStr, rowsStr, ...args] = process.argv;
const cols = parseInt(colsStr, 10) || 120;
const rows = parseInt(rowsStr, 10) || 40;

// Parse env from stdin first line (sent as JSON object), or inherit cleaned env
let spawnEnv = undefined;

const envLine = process.env.__PTY_HOST_ENV_JSON;
if (envLine) {
  try {
    spawnEnv = JSON.parse(envLine);
  } catch {}
  delete process.env.__PTY_HOST_ENV_JSON;
}

try {
  const ptyProcess = pty.spawn(shell, args, {
    cwd,
    cols,
    rows,
    env: spawnEnv || process.env,
    name: process.platform === "win32" ? "xterm-color" : "xterm-256color",
  });

  send({ type: "pid", pid: ptyProcess.pid });

  ptyProcess.onData((data) => {
    send({ type: "data", data });
  });

  ptyProcess.onExit((event) => {
    send({
      type: "exit",
      exitCode: event.exitCode,
      signal: event.signal ?? null,
    });
    // Give a moment for the message to flush, then exit
    setTimeout(() => process.exit(0), 100);
  });

  // Read commands from stdin
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      switch (msg.type) {
        case "write":
          ptyProcess.write(msg.data);
          break;
        case "resize":
          ptyProcess.resize(msg.cols, msg.rows);
          break;
        case "kill":
          ptyProcess.kill(msg.signal || undefined);
          break;
      }
    } catch {}
  });

  rl.on("close", () => {
    // Parent closed stdin — kill the child
    ptyProcess.kill("SIGTERM");
  });
} catch (error) {
  send({ type: "error", message: error.message || "Failed to spawn" });
  process.exit(1);
}

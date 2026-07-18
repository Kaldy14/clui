#!/usr/bin/env bun

import { join } from "node:path";

import {
  CLAUDE_CODE_PROXY_VERSION,
  detectHostProxyTarget,
  stageClaudeCodeProxy,
} from "./lib/claude-code-proxy-release";

const target = detectHostProxyTarget();
const destinationDir = join(import.meta.dirname, "../apps/desktop/resources/claude-code-proxy");
const binaryPath = await stageClaudeCodeProxy({ ...target, destinationDir });
console.info(`Prepared claude-code-proxy v${CLAUDE_CODE_PROXY_VERSION} at ${binaryPath}`);

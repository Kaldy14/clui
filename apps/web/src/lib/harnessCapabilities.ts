import type { CodingHarness } from "@clui/contracts";

/** Pi and OMP share the same TUI input conventions and terminal modes. */
export function isPiDerivedHarness(harness: CodingHarness): boolean {
  return harness === "pi" || harness === "omp";
}

/** Harnesses whose model is selected by Clui instead of inside the TUI. */
export function hasCluiModelSelection(harness: CodingHarness): boolean {
  return harness === "claudeCode" || harness === "codexCli";
}

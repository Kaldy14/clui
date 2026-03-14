import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";

import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";

import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { ClaudeSessionManagerLive } from "./terminal/Layers/ClaudeSessionManager";
import { KeybindingsLive } from "./keybindings";
import { GitManagerLive } from "./git/Layers/GitManager";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { ClaudeCliTextGenerationLive } from "./git/Layers/ClaudeCliTextGeneration";
import { GitServiceLive } from "./git/Layers/GitService";
import { BunPtyAdapterLive } from "./terminal/Layers/BunPTY";
import { NodePtyAdapterLive } from "./terminal/Layers/NodePTY";
import { NodePtyHostAdapterLive } from "./terminal/Layers/NodePtyHost";

export function makeServerRuntimeServicesLayer() {
  const gitCoreLayer = GitCoreLive.pipe(Layer.provideMerge(GitServiceLive));
  const textGenerationLayer = ClaudeCliTextGenerationLive;

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );

  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(CheckpointStoreLive),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    orchestrationLayer,
    OrchestrationProjectionSnapshotQueryLive,
    CheckpointStoreLive,
    checkpointDiffQueryLayer,
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(checkpointReactorLayer),
    Layer.provideMerge(gitCoreLayer),
    Layer.provideMerge(textGenerationLayer),
  );

  // Bun.spawn({ terminal }) doesn't create a real tty (isatty() returns false),
  // and node-pty's native addon crashes under Bun with ENXIO. Use NodePtyHost
  // which delegates to a Node.js subprocess running node-pty for a real pty.
  const ptyAdapterLayer =
    typeof Bun !== "undefined" && process.platform !== "win32"
      ? NodePtyHostAdapterLive
      : NodePtyAdapterLive;

  const terminalLayer = TerminalManagerLive.pipe(Layer.provide(ptyAdapterLayer));

  const claudeSessionLayer = ClaudeSessionManagerLive.pipe(Layer.provide(ptyAdapterLayer));

  const gitManagerLayer = GitManagerLive.pipe(
    Layer.provideMerge(gitCoreLayer),
    Layer.provideMerge(GitHubCliLive),
    Layer.provideMerge(textGenerationLayer),
  );

  return Layer.mergeAll(
    orchestrationReactorLayer,
    gitCoreLayer,
    gitManagerLayer,
    textGenerationLayer,
    terminalLayer,
    claudeSessionLayer,
    KeybindingsLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

import { Option, Schema } from "effect";
import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ProviderKind } from "./orchestration";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type ServerProviderStatusState = typeof ServerProviderStatusState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderStatus = Schema.Struct({
  provider: ProviderKind,
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderStatus = typeof ServerProviderStatus.Type;

const ServerProviderStatuses = Schema.Array(ServerProviderStatus);

export const DEFAULT_ACTIVE_HARNESS_SESSION_CAP = 10;
export const MIN_ACTIVE_HARNESS_SESSION_CAP = 1;
export const MAX_ACTIVE_HARNESS_SESSION_CAP = 100;
export const DEFAULT_PREVENT_MACOS_SLEEP_WHEN_THREAD_IN_PROGRESS = true;

const MaxActiveHarnessSessions = PositiveInt.check(
  Schema.isLessThanOrEqualTo(MAX_ACTIVE_HARNESS_SESSION_CAP),
);

export const ServerSettings = Schema.Struct({
  maxActiveHarnessSessions: MaxActiveHarnessSessions.pipe(
    Schema.withDecodingDefault(() => DEFAULT_ACTIVE_HARNESS_SESSION_CAP),
    Schema.withConstructorDefault(() => Option.some(DEFAULT_ACTIVE_HARNESS_SESSION_CAP)),
  ),
  preventMacosSleepWhenThreadInProgress: Schema.Boolean.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PREVENT_MACOS_SLEEP_WHEN_THREAD_IN_PROGRESS),
    Schema.withConstructorDefault(() =>
      Option.some(DEFAULT_PREVENT_MACOS_SLEEP_WHEN_THREAD_IN_PROGRESS),
    ),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  availableEditors: Schema.Array(EditorId),
  settings: ServerSettings,
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpdateSettingsInput = Schema.Struct({
  maxActiveHarnessSessions: Schema.optional(MaxActiveHarnessSessions),
  preventMacosSleepWhenThreadInProgress: Schema.optional(Schema.Boolean),
});
export type ServerUpdateSettingsInput = typeof ServerUpdateSettingsInput.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const PurgeInactiveSessionsInput = Schema.Struct({
  excludeThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(500)),
});
export type PurgeInactiveSessionsInput = typeof PurgeInactiveSessionsInput.Type;

export const PurgeInactiveSessionsResult = Schema.Struct({
  sessionsKilled: Schema.Number,
  snapshotsCleared: Schema.Number,
});
export type PurgeInactiveSessionsResult = typeof PurgeInactiveSessionsResult.Type;

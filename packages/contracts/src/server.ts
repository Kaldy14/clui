import { Option, Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, ProviderKind } from "./orchestration";

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

export const TitleGenerationProvider = Schema.Literals(["claudeCode", "codex"]);
export type TitleGenerationProvider = typeof TitleGenerationProvider.Type;

export const DEFAULT_TITLE_GENERATION_PROVIDER: TitleGenerationProvider = "claudeCode";
export const DEFAULT_ACTIVE_HARNESS_SESSION_CAP = 10;
export const MIN_ACTIVE_HARNESS_SESSION_CAP = 1;
export const MAX_ACTIVE_HARNESS_SESSION_CAP = 100;
export const DEFAULT_PREVENT_MACOS_SLEEP_WHEN_THREAD_IN_PROGRESS = true;
export const DEFAULT_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS = 14;
export const MIN_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS = 0;
export const MAX_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS = 365;

const MaxActiveHarnessSessions = PositiveInt.check(
  Schema.isLessThanOrEqualTo(MAX_ACTIVE_HARNESS_SESSION_CAP),
);

const AutoArchiveInactiveThreadDays = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(MAX_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS),
);

export const ServerSettings = Schema.Struct({
  titleGenerationProvider: TitleGenerationProvider.pipe(
    Schema.withDecodingDefault(() => DEFAULT_TITLE_GENERATION_PROVIDER),
    Schema.withConstructorDefault(() => Option.some(DEFAULT_TITLE_GENERATION_PROVIDER)),
  ),
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
  autoArchiveInactiveThreadDays: AutoArchiveInactiveThreadDays.pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS),
    Schema.withConstructorDefault(() => Option.some(DEFAULT_AUTO_ARCHIVE_INACTIVE_THREAD_DAYS)),
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
  titleGenerationProvider: Schema.optional(TitleGenerationProvider),
  maxActiveHarnessSessions: Schema.optional(MaxActiveHarnessSessions),
  preventMacosSleepWhenThreadInProgress: Schema.optional(Schema.Boolean),
  autoArchiveInactiveThreadDays: Schema.optional(AutoArchiveInactiveThreadDays),
});
export type ServerUpdateSettingsInput = typeof ServerUpdateSettingsInput.Type;

export const ServerSetHarnessOutputSubscriptionsInput = Schema.Struct({
  claudeThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(100)),
  piThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(100)),
});
export type ServerSetHarnessOutputSubscriptionsInput =
  typeof ServerSetHarnessOutputSubscriptionsInput.Type;

const SERVER_WRITE_TEMP_IMAGE_MAX_DATA_URL_CHARS = 14_000_000;

export const ServerWriteTempImageInput = Schema.Struct({
  threadId: ThreadId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(SERVER_WRITE_TEMP_IMAGE_MAX_DATA_URL_CHARS),
  ),
});
export type ServerWriteTempImageInput = typeof ServerWriteTempImageInput.Type;

export const ServerWriteTempImageResult = Schema.Struct({
  filePath: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ServerWriteTempImageResult = typeof ServerWriteTempImageResult.Type;

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
  hibernateActiveSessions: Schema.optional(Schema.Boolean),
});
export type PurgeInactiveSessionsInput = typeof PurgeInactiveSessionsInput.Type;

export const PurgeInactiveSessionsResult = Schema.Struct({
  sessionsHibernated: Schema.Number,
  sessionsKilled: Schema.Number,
  snapshotsCleared: Schema.Number,
});
export type PurgeInactiveSessionsResult = typeof PurgeInactiveSessionsResult.Type;

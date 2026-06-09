import type {
  OrchestrationAskDiffReviewInput,
  OrchestrationAskDiffReviewResult,
  OrchestrationGenerateDiffReviewInput,
  OrchestrationGenerateDiffReviewResult,
} from "@clui/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

export class DiffReviewError extends Schema.TaggedErrorClass<DiffReviewError>()(
  "DiffReviewError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Diff review failed in ${this.operation}: ${this.detail}`;
  }
}

export interface DiffReviewShape {
  readonly generateDiffReview: (
    input: OrchestrationGenerateDiffReviewInput,
  ) => Effect.Effect<OrchestrationGenerateDiffReviewResult, DiffReviewError>;
  readonly askDiffReview: (
    input: OrchestrationAskDiffReviewInput,
  ) => Effect.Effect<OrchestrationAskDiffReviewResult, DiffReviewError>;
}

export class DiffReview extends ServiceMap.Service<DiffReview, DiffReviewShape>()(
  "clui/diffReview/Services/DiffReview",
) {}

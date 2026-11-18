import { buildReviewRequest, type ModelRunner, type ReviewContext } from "./review";
import { parseQuickReview, type QuickReview, type ModelUsage, type ScoreMeta } from "./schema";
import type { Clock } from "./repository";

export interface QuickResult extends QuickReview { usage: ModelUsage; latencyMs: number }
/** The quick path is the sole score producer. Runner and clock are injected at the composition root. */
export class FeedbackService {
  constructor(private readonly clock: Clock) {}
  async quick(draft: string, run: ModelRunner, profile: Omit<ScoreMeta, "scoredAt">, context: ReviewContext = {}, signal?: AbortSignal): Promise<QuickResult> {
    const started = this.clock.now();
    const response = await run(buildReviewRequest(draft, "quick", profile.model, context), signal);
    if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
    return { ...parseQuickReview(response.text, draft, { ...profile, scoredAt: new Date(this.clock.now()).toISOString() }),
      latencyMs: Math.max(0, this.clock.now() - started), usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens, costUsd: response.costUsd } };
  }
}

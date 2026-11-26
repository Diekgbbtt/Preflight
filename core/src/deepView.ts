// What the panel shows for a deep review (#47): one pure view model, so the webview only renders.
import { OMIT_REASONS, promptFileFacts, sourceName, type DeepReviewRecord, type Question } from "./deepFeedback";
import { ACTION_LABELS, feedbackMessage, type FeedbackAction, type FeedbackError } from "./errors";
import { openQuestions } from "./questions";
import type { Event } from "./repository";
import { canImprove, type ReviewIssue } from "./review";
import { hashPrompt } from "./schema";

/**
 * none: no review yet. running: a round is in progress. ready: the review matches the current draft.
 * stale: the draft changed since the review. error: the last round failed.
 */
export type DeepViewState = "none" | "running" | "ready" | "stale" | "error";

export interface ManifestRow {
  /** Plain name, e.g. "the referenced files" or "AGENTS.md (project instructions)". */
  label: string;
  tokens: number;
  status: "included" | "cut" | "left out";
  /** Why a source was left out, in plain words. */
  reason?: string;
  /** Extra facts, e.g. "1 referenced file was not found in the workspace". */
  facts: string[];
}

export interface QaItem {
  question: string;
  /** The answer text, or undefined when the user skipped the question. */
  answer?: string;
  skipped: boolean;
}

export interface DeepView {
  state: DeepViewState;
  /** When the shown review was made (ISO 8601); the webview formats its age. */
  madeAt?: string;
  issues: ReviewIssue[];
  /** Open questions of the shown review only, so earlier rounds do not show up twice. */
  openQuestions: Array<{ id: string; question: string; why: string; options: string[] }>;
  assumptions: string[];
  contextGaps: string[];
  /** Every answered or skipped question of the draft, oldest first. */
  qaHistory: QaItem[];
  /** "What the model saw"; null when there is no review. */
  manifest: { rows: ManifestRow[]; totalTokens: number; budget: number } | null;
  /** Answers, the rewrite and other actions are allowed only when the review matches the draft. */
  actionable: boolean;
  canImprove: boolean;
  /** Exactly one action for an error. */
  error?: { message: string; action: FeedbackAction; actionLabel: string };
}

function rowLabel(id: string): string {
  if (id.startsWith("instructions:")) return `${sourceName(id)} (project instructions)`;
  if (id.startsWith("docs:")) return `${sourceName(id)} (project description)`;
  return sourceName(id);
}

export function manifestRows(manifest: DeepReviewRecord["contextManifest"]): ManifestRow[] {
  return manifest.sources.map((s) => {
    const facts = s.source === "prompt-files" ? promptFileFacts(s.details ?? {}) : [];
    if (!s.included) return { label: rowLabel(s.source), tokens: 0, status: "left out", reason: OMIT_REASONS[s.omittedReason ?? "empty"], facts };
    return { label: rowLabel(s.source), tokens: s.tokens, status: s.truncated ? "cut" : "included", facts };
  });
}

export interface DeepViewInput {
  /** The latest review of the draft, from loadDeepSession. */
  review: Event<DeepReviewRecord> | null;
  /** Latest state of every question of the draft, from loadDeepSession. */
  questions: Array<Event<Question>>;
  /** The draft text in the editor now. */
  draft: string;
  running?: boolean;
  error?: FeedbackError;
}

export function deepReviewView(input: DeepViewInput): DeepView {
  const { review } = input;
  const stale = !!review && review.promptHash !== hashPrompt(input.draft);
  const state: DeepViewState = input.running ? "running" : input.error ? "error" : !review ? "none" : stale ? "stale" : "ready";
  const actionable = state === "ready";

  const qaHistory: QaItem[] = input.questions
    .filter((q) => q.answer?.text.trim() || q.skippedAt)
    .map((q) => (q.answer?.text.trim() ? { question: q.question, answer: q.answer.text, skipped: false } : { question: q.question, skipped: true }));

  let error: DeepView["error"];
  if (state === "error" && input.error) {
    const { message, action } = feedbackMessage(input.error);
    error = { message, action, actionLabel: ACTION_LABELS[action] };
  }

  return {
    state,
    ...(review ? { madeAt: review.ts } : {}),
    issues: review?.issues ?? [],
    openQuestions: review
      ? openQuestions(input.questions.filter((q) => q.reviewId === review.id)).map((q) => ({ id: q.id, question: q.question, why: q.why, options: q.options }))
      : [],
    assumptions: review?.assumptions ?? [],
    contextGaps: review?.contextGaps ?? [],
    qaHistory,
    manifest: review ? { rows: manifestRows(review.contextManifest), totalTokens: review.contextManifest.totalTokens, budget: review.contextManifest.budget } : null,
    actionable,
    canImprove: actionable && !!review && canImprove(review),
    ...(error ? { error } : {}),
  };
}

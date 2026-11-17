import type { Analysis, Range } from "./types";
import {
  IMPROVE_REPLY_SCHEMA,
  QUICK_REPLY_SCHEMA,
  RUBRIC_TEXT,
  extractJson,
  parseImprovedPrompt,
  type DeepReview,
  type ImprovedPrompt,
} from "./schema";

/**
 * Deprecated prototype reply schema. The control-plane contract is
 * `DEEP_REPLY_SCHEMA`, which has no score and no improved prompt. #46 removes
 * this legacy path when the panel consumes `DeepReview` and `ImprovedPrompt`.
 */
export const LEGACY_DEEP_REPLY_SCHEMA = `{"dimensions":{"target":0-25,"action":0-25,"scope":0-25,"done":0-25},"confidence":0-1,"issues":[{"quote":"exact words from the prompt or empty","problem":"what is missing and why it matters","suggestion":"how to fix it"}],"questions":[{"question":"...","why":"why the agent needs it","options":["max 3 choices"]}],"improvedPrompt":"...","assumptions":["..."],"contextGaps":["..."]}`;

export type ReviewMode = "quick" | "deep";

export interface ModelRequest {
  system: string;
  user: string;
  model: string;
}

export interface ModelResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Anything that can answer a prompt: the claude CLI, an API client, a test stub. */
export type ModelRunner = (req: ModelRequest, signal?: AbortSignal) => Promise<ModelResponse>;

export interface ReviewIssue {
  /** Exact words from the prompt the issue is about, if any. */
  quote?: string;
  range?: Range;
  problem: string;
  suggestion: string;
}

export interface Review {
  mode: ReviewMode;
  verdict: "ready" | "needs-work";
  issues: ReviewIssue[];
  questions: string[];
  /**
   * @deprecated Prototype path only. The control plane uses the separate
   * `ImprovedPrompt` action; #46 removes this field.
   */
  improvedPrompt?: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

const QUICK_SYSTEM = `You review prompts that a user is about to send to an AI coding agent. You do not do the task.
${RUBRIC_TEXT}

Find what is missing or ambiguous that would make the agent guess. Only flag real gaps; a short prompt can be complete.
Reply with JSON only, no prose, in this shape:
${QUICK_REPLY_SCHEMA}
At most 20 issues and 20 questions.`;

const DEEP_SYSTEM = `You coach a student on how to write prompts for an AI coding agent. You do not do the task.
${RUBRIC_TEXT}

Review the prompt. For each issue, explain briefly why it matters to the agent, so the user learns.
Then write an improved version of the prompt. Never invent facts the user did not give: put unknown details in square brackets as placeholders, e.g. [which page?] or [expected result]. Keep the user's intent and wording where possible.
Reply with JSON only, no prose, in this shape:
${LEGACY_DEEP_REPLY_SCHEMA}
At most 20 issues and 20 questions.`;

export interface ReviewContext {
  analysis?: Analysis;
  /** Short project facts, e.g. file names or recently changed files. */
  projectNotes?: string;
}

export function buildReviewRequest(prompt: string, mode: ReviewMode, model: string, ctx: ReviewContext = {}): ModelRequest {
  const parts = [`<prompt>\n${prompt}\n</prompt>`];
  if (ctx.analysis) {
    const rules = ctx.analysis.findings.map((f) => `- ${f.message}`).join("\n");
    parts.push(
      mode === "quick"
        ? `The user already sees these rule-based notes. Do NOT repeat them; report only other problems, or return "issues": [] if there are none:\n${rules || "- nothing"}`
        : `Rule-based checks already found:\n${rules || "- nothing"}`,
    );
  }
  if (ctx.projectNotes) parts.push(`Project context:\n${ctx.projectNotes}`);
  return { system: mode === "quick" ? QUICK_SYSTEM : DEEP_SYSTEM, user: parts.join("\n\n"), model };
}

/** Pull the first JSON object out of a model reply. Re-exported here for the review.ts public path; the single implementation lives in schema.ts. */
export { extractJson } from "./schema";

export function parseReview(prompt: string, mode: ReviewMode, res: ModelResponse): Review {
  const raw = extractJson(res.text) as Record<string, unknown>;
  const issues: ReviewIssue[] = (Array.isArray(raw.issues) ? raw.issues : [])
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => {
      const quote = typeof i.quote === "string" && i.quote.trim() ? i.quote.trim() : undefined;
      const at = quote ? prompt.indexOf(quote) : -1;
      return {
        quote,
        range: at >= 0 ? { start: at, end: at + quote!.length } : undefined,
        problem: String(i.problem ?? ""),
        suggestion: String(i.suggestion ?? ""),
      };
    })
    .filter((i) => i.problem);
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).map(String).slice(0, 3);
  return {
    mode,
    verdict: raw.verdict === "ready" ? "ready" : "needs-work",
    issues,
    questions,
    improvedPrompt: typeof raw.improvedPrompt === "string" ? raw.improvedPrompt : undefined,
    usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd },
  };
}

export async function review(
  prompt: string,
  mode: ReviewMode,
  run: ModelRunner,
  model: string,
  ctx: ReviewContext = {},
  signal?: AbortSignal,
): Promise<Review> {
  const res = await run(buildReviewRequest(prompt, mode, model, ctx), signal);
  return parseReview(prompt, mode, res);
}

/** The separate rewrite is enabled only after a deep review with a question. */
export function canImprove(review: DeepReview): boolean {
  return review.questions.length > 0;
}

const IMPROVE_SYSTEM = `You rewrite a coding-agent prompt. You do not do the task.
Keep the user's intent and wording where possible.
Use every answer the user gave.
For every detail the user has not given, write a [placeholder] such as [which page?] or [expected result].
Reply with JSON only, no prose, in this shape:
${IMPROVE_REPLY_SCHEMA}`;

/**
 * Builds the separate improved-prompt request. It is never part of the deep
 * review request and never carries the review rubric.
 */
export function buildImprovedPromptRequest(
  prompt: string,
  review: DeepReview,
  qa: Array<{ question: string; answer: string }> = [],
  model: string,
): ModelRequest {
  const parts = [`<prompt>\n${prompt}\n</prompt>`];
  if (review.issues.length > 0) {
    parts.push(
      `Issues found:\n${review.issues
        .map((issue) => `- ${issue.problem}${issue.suggestion ? ` Suggestion: ${issue.suggestion}` : ""}`)
        .join("\n")}`,
    );
  }
  if (review.questions.length > 0) {
    parts.push(
      `Questions:\n${review.questions
        .map((question) => {
          const options = question.options.length > 0 ? ` Options: ${question.options.join(", ")}.` : "";
          return `- ${question.question}${question.why ? ` Why: ${question.why}.` : ""}${options}`;
        })
        .join("\n")}`,
    );
  }
  if (review.assumptions.length > 0) parts.push(`Assumptions:\n${review.assumptions.map((item) => `- ${item}`).join("\n")}`);
  if (review.contextGaps.length > 0) parts.push(`Context gaps:\n${review.contextGaps.map((item) => `- ${item}`).join("\n")}`);
  parts.push(
    qa.length > 0
      ? `Answers:\n${qa.map((item) => `- ${item.question} ${item.answer}`).join("\n")}`
      : "No questions have been answered. Use [placeholders] for unknown details.",
  );
  return { system: IMPROVE_SYSTEM, user: parts.join("\n\n"), model };
}

/**
 * Runs the separate improved-prompt action. Gating is part of the contract:
 * without a deep question the model is not called. The caller supplies the
 * clock so latency stays deterministic in tests.
 */
export async function improvePrompt(
  prompt: string,
  review: DeepReview,
  qa: Array<{ question: string; answer: string }>,
  run: ModelRunner,
  model: string,
  clock: { now(): number },
  signal?: AbortSignal,
): Promise<ImprovedPrompt | null> {
  if (!canImprove(review)) return null;
  const started = clock.now();
  const res = await run(buildImprovedPromptRequest(prompt, review, qa, model), signal);
  const latency = clock.now() - started;
  return parseImprovedPrompt(res.text, { inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd }, latency);
}

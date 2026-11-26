import { createHash } from "node:crypto";
import type { Dimensions, Level } from "./types";
import type { ModelResponse, ReviewIssue } from "./review";

/** Version of the shared review rubric. Bump when the anchors change. */
export const RUBRIC_VERSION = "v1";

/** Version of the existing deep review prompt prose. */
export const PROMPT_VERSION = "v1";

/** Quick reviewer guardrails/examples, independent of the unchanged numeric rubric. */
export const QUICK_PROMPT_VERSION = "v2";

/** Version of the separate improved-prompt prose. Bump when that prose changes. */
export const IMPROVE_PROMPT_VERSION = "v1";

/** Shared scoring rubric with anchors for quick and deep review. The only copy of the rubric. */
export const RUBRIC_TEXT = `Score the prompt on four dimensions, 0-25 each, in steps of 5.

target (where): 0 = no target at all; 5 = only a vague area such as "the app"; 10 = a named area of the wrong kind; 15 = names a file, function or component but may not be the right one; 20 = names the right place with a small ambiguity; 25 = the exact file, function or component.
action (what): 0 = no action; 5 = only vague verbs such as "improve it"; 10 = a verb but no object; 15 = verb plus object but still ambiguous; 20 = a concrete change with one small gap; 25 = the exact change to make.
scope (how much): 0 = no bound at all; 5 = a whole-project rewrite; 10 = broad, several areas at once; 15 = one task with unclear edges; 20 = one task with mostly clear edges; 25 = one task, clear edges, and what must not change is stated.
done (how we know): 0 = no success criteria; 5 = only restates the problem; 10 = a hope such as "should work"; 15 = describes what is wrong but not the goal; 20 = the expected behaviour for the main case; 25 = the expected behaviour or a test that proves it is done.`;

/** Quick review reply shape. The rubric and this schema are the only scoring references in the system prompt. */
export const QUICK_REPLY_SCHEMA = `{"dimensions":{"target":0-25,"action":0-25,"scope":0-25,"done":0-25},"confidence":0-1,"issues":[{"quote":"exact words from the prompt or empty","problem":"max 15 words","suggestion":"max 20 words"}],"questions":["max 20 short questions to the user"]}`;

/** Deep review reply shape. Deep review never scores and never writes the improved prompt. */
export const DEEP_REPLY_SCHEMA = `{"issues":[{"quote":"exact words from the prompt or empty","problem":"what is missing and why it matters","suggestion":"how to fix it"}],"questions":[{"question":"...","why":"why the agent needs it","options":["max 3 choices"]}],"assumptions":["..."],"contextGaps":["..."]}`;

/** Improved-prompt reply shape. Unknown details stay as [placeholders]. */
export const IMPROVE_REPLY_SCHEMA = `{"improvedPrompt":"..."}`;

export function hashPrompt(text: string): string {
  return createHash("sha256").update(text.trim().replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export function levelForScore(score: number): Level {
  return score >= 80 ? "clear" : score >= 55 ? "needs-work" : "vague";
}

export interface ScoreReport {
  dimensions: Dimensions;
  /** 0-100, the sum of the four dimensions. Never clamped. */
  score: number;
  level: Level;
  provider: string;
  model: string;
  /** Provider-native effort value, passed through unchanged. */
  thinkingEffort: string;
  rubricVersion: string;
  promptHash: string;
  scoredAt: string;
  /** Present only when the model supplied a finite number in 0..1. */
  confidence?: number;
}

/** The caller-supplied part of a ScoreReport: everything except the parsed score itself. */
export interface ScoreMeta {
  provider: string;
  model: string;
  /** Provider-native effort value, passed through unchanged. */
  thinkingEffort: string;
  scoredAt: string;
}

export interface QuickReview {
  score: ScoreReport | null;
  issues: ReviewIssue[];
  questions: string[];
}

export type ModelUsage = Pick<ModelResponse, "inputTokens" | "outputTokens" | "costUsd">;

export interface DeepQuestion {
  question: string;
  /** Why the agent needs this detail. Empty when the model omits it. */
  why: string;
  options: string[];
}

export interface DeepReview {
  issues: ReviewIssue[];
  questions: DeepQuestion[];
  assumptions: string[];
  contextGaps: string[];
  usage: ModelUsage;
  latency: number;
  promptVersion: string;
}

/** The separate rewrite the user requests after a deep review with questions. */
export interface ImprovedPrompt {
  text: string;
  usage: ModelUsage;
  latency: number;
  promptVersion: string;
}

const DIMENSION_KEYS = ["target", "action", "scope", "done"] as const;

/** Pull the first JSON object out of a model reply (tolerates ```json fences and stray text).
 * Lives here so schema.ts stays a leaf module: review.ts imports it, not the other way round. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in model reply");
  return JSON.parse(body.slice(start, end + 1));
}
/**
 * The four dimensions must be present, finite integers, multiples of 5, in range 0..25.
 * Extra keys are ignored. Any invalid dimension rejects the whole score.
 */
function parseDimensions(raw: unknown): Dimensions | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const out = {} as Dimensions;
  for (const key of DIMENSION_KEYS) {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v % 5 !== 0 || v < 0 || v > 25) {
      return null;
    }
    out[key] = v;
  }
  return out;
}

function asObject(text: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return null;
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

export function parseScore(text: string, prompt: string, meta: ScoreMeta): ScoreReport | null {
  const raw = asObject(text);
  const dimensions = raw ? parseDimensions(raw.dimensions) : null;
  if (!dimensions) return null;
  const score = dimensions.target + dimensions.action + dimensions.scope + dimensions.done;
  const report: ScoreReport = {
    dimensions,
    score,
    level: levelForScore(score),
    provider: meta.provider,
    model: meta.model,
    thinkingEffort: meta.thinkingEffort,
    rubricVersion: RUBRIC_VERSION,
    promptHash: hashPrompt(prompt),
    scoredAt: meta.scoredAt,
  };
  if (typeof raw!.confidence === "number" && Number.isFinite(raw!.confidence) && raw!.confidence >= 0 && raw!.confidence <= 1) {
    report.confidence = raw!.confidence;
  }
  return report;
}

const MAX_ISSUES = 20;
const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 3;

/** Keep at most 20 issues with a non-empty problem. A quote survives only when it occurs in the prompt. */
function parseIssues(raw: unknown, prompt: string): ReviewIssue[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ReviewIssue[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const i = item as Record<string, unknown>;
    const problem = i.problem == null ? "" : String(i.problem);
    if (!problem) continue;
    const suggestion = i.suggestion == null ? "" : String(i.suggestion);
    const quote = typeof i.quote === "string" ? i.quote : "";
    const at = quote ? prompt.indexOf(quote) : -1;
    out.push({
      quote: at >= 0 ? quote : undefined,
      range: at >= 0 ? { start: at, end: at + quote.length } : undefined,
      problem,
      suggestion,
    });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

/** Keep only strings, at most max. */
function parseStringList(raw: unknown, max: number): string[] {
  return (Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === "string").slice(0, max);
}

export function parseQuickReview(text: string, prompt: string, meta: ScoreMeta): QuickReview {
  const raw = asObject(text);
  if (!raw) return { score: null, issues: [], questions: [] };
  return {
    score: parseScore(text, prompt, meta),
    issues: parseIssues(raw.issues, prompt),
    questions: parseStringList(raw.questions, MAX_QUESTIONS),
  };
}

export function parseDeepReview(text: string, prompt: string, meta: { usage: ModelUsage; latency: number }): DeepReview {
  const raw = asObject(text);
  if (!raw) {
    return { issues: [], questions: [], assumptions: [], contextGaps: [], usage: meta.usage, latency: meta.latency, promptVersion: PROMPT_VERSION };
  }
  const questions: DeepQuestion[] = [];
  for (const item of Array.isArray(raw.questions) ? raw.questions : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const q = item as Record<string, unknown>;
    const question = typeof q.question === "string" ? q.question : "";
    if (!question) continue;
    const why = typeof q.why === "string" ? q.why : "";
    const options = parseStringList(q.options, MAX_OPTIONS);
    questions.push({ question, why, options });
    if (questions.length >= MAX_QUESTIONS) break;
  }
  return {
    issues: parseIssues(raw.issues, prompt),
    questions,
    assumptions: parseStringList(raw.assumptions, Infinity),
    contextGaps: parseStringList(raw.contextGaps, Infinity),
    usage: meta.usage,
    latency: meta.latency,
    promptVersion: PROMPT_VERSION,
  };
}

/** Parses the separate improved-prompt reply. A blank or malformed rewrite is null. */
export function parseImprovedPrompt(text: string, usage: ModelUsage, latency: number): ImprovedPrompt | null {
  const raw = asObject(text);
  if (!raw) return null;
  const improved = typeof raw.improvedPrompt === "string" ? raw.improvedPrompt.trim() : "";
  if (improved === "") return null;
  return { text: improved, usage, latency, promptVersion: IMPROVE_PROMPT_VERSION };
}

import { createHash } from "node:crypto";
import type { Dimensions, Level } from "./types";
import type { ReviewIssue } from "./review";
import { extractJson } from "./review";

/** Version of the shared review rubric. Bump when the anchors change. */
export const RUBRIC_VERSION = "v1";

/** Version of the quick and deep review prompt prose. Bump when the prose changes. */
export const PROMPT_VERSION = "v1";

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
  source: "quick" | "deep";
  provider: string;
  model: string;
  thinkingEffort: "low" | "medium" | "high";
  rubricVersion: string;
  promptHash: string;
  scoredAt: string;
  /** Present only when the model supplied a finite number in 0..1. */
  confidence?: number;
}

/** The caller-supplied part of a ScoreReport: everything except the parsed score itself. */
export interface ScoreMeta {
  source: "quick" | "deep";
  provider: string;
  model: string;
  thinkingEffort: "low" | "medium" | "high";
  scoredAt: string;
}

export interface QuickReview {
  score: ScoreReport | null;
  issues: ReviewIssue[];
  questions: string[];
}

const DIMENSION_KEYS = ["target", "action", "scope", "done"] as const;

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
    source: meta.source,
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

const MAX_ISSUES = 3;
const MAX_QUESTIONS = 3;

/** Keep at most 3 issues with a non-empty problem. A quote survives only when it occurs in the prompt. */
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

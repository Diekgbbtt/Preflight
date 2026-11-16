import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDeepReview, parseQuickReview, type ModelUsage, type ScoreMeta } from "../src";

interface Expected {
  score: number | null;
  level: string | null;
  dimensions: Record<string, number> | null;
  issueCount: number;
  questionCount: number;
}

interface Case {
  id: string;
  mode: "quick" | "deep";
  prompt: string;
  response: string;
  expected: Expected;
  why: string;
}

const cases: Case[] = readFileSync(join(__dirname, "review-corpus.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => JSON.parse(l));

const meta: ScoreMeta = { source: "quick", provider: "stub", model: "stub-model", thinkingEffort: "low", scoredAt: "2026-01-01T00:00:00.000Z" };
const usage = { inputTokens: 100, outputTokens: 20, costUsd: 0.001 };
const deepMeta: ScoreMeta & { usage: ModelUsage; latency: number } = { ...meta, source: "deep", usage, latency: 42 };

describe("review corpus", () => {
  it.each(cases.map((c) => [c.id, c] as const))("%s", (id, c) => {
    if (c.mode === "quick") {
      const r = parseQuickReview(c.response, c.prompt, { ...meta, source: "quick" });
      expect(r.score?.score ?? null, `${id}: ${c.why}`).toBe(c.expected.score);
      expect(r.score?.level ?? null, `${id}: ${c.why}`).toBe(c.expected.level);
      expect(r.score?.dimensions ?? null, `${id}: ${c.why}`).toEqual(c.expected.dimensions);
      expect(r.issues.length, `${id}: ${c.why}`).toBe(c.expected.issueCount);
      expect(r.questions.length, `${id}: ${c.why}`).toBe(c.expected.questionCount);
    } else {
      const r = parseDeepReview(c.response, c.prompt, deepMeta);
      expect(r.score?.score ?? null, `${id}: ${c.why}`).toBe(c.expected.score);
      expect(r.score?.level ?? null, `${id}: ${c.why}`).toBe(c.expected.level);
      expect(r.score?.dimensions ?? null, `${id}: ${c.why}`).toEqual(c.expected.dimensions);
      expect(r.issues.length, `${id}: ${c.why}`).toBe(c.expected.issueCount);
      expect(r.questions.length, `${id}: ${c.why}`).toBe(c.expected.questionCount);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  deepReviewView,
  hashPrompt,
  manifestRows,
  mapError,
  SCHEMA_VERSION,
  type ContextSourceEntry,
  type DeepReviewRecord,
  type Event,
  type Question,
} from "../src/index";

const DRAFT = "fix the login";
const entry = (source: string, over: Partial<ContextSourceEntry> = {}): ContextSourceEntry => ({
  source,
  chars: 40,
  tokens: 10,
  included: true,
  truncated: false,
  redactions: 0,
  ...over,
});

const review = (id: string, over: Partial<DeepReviewRecord> = {}): Event<DeepReviewRecord> => ({
  schemaVersion: SCHEMA_VERSION,
  seq: 1,
  id,
  ts: "2026-11-26T10:00:00.000Z",
  issues: [{ quote: "fix the login", problem: "No page named", suggestion: "Name it" }],
  questions: [{ question: "Which login page?", why: "Several exist", options: ["admin"] }],
  assumptions: ["The bug is in the web app"],
  contextGaps: ["No error message given"],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  latency: 1,
  promptVersion: "deep-v2",
  draftId: "d1",
  promptHash: hashPrompt(DRAFT),
  contextManifest: { sources: [entry("draft", { tokens: 4 })], totalTokens: 4, budget: 1000 },
  ...over,
});

let seq = 0;
const question = (id: string, reviewId: string, over: Partial<Question> = {}): Event<Question> => ({
  schemaVersion: SCHEMA_VERSION,
  seq: ++seq,
  id,
  ts: "2026-11-26T10:00:00.000Z",
  draftId: "d1",
  reviewId,
  question: `question ${id}`,
  why: "why",
  options: [],
  ...over,
});

describe("deepReviewView states", () => {
  it("shows nothing before the first review", () => {
    expect(deepReviewView({ review: null, questions: [], draft: DRAFT })).toMatchObject({ state: "none", manifest: null, actionable: false, canImprove: false, openQuestions: [] });
  });

  it("is ready and actionable when the review matches the draft", () => {
    const v = deepReviewView({ review: review("r1"), questions: [question("q1", "r1")], draft: `  ${DRAFT}\r\n` });
    expect(v).toMatchObject({ state: "ready", actionable: true, canImprove: true, madeAt: "2026-11-26T10:00:00.000Z" });
    expect(v.assumptions).toEqual(["The bug is in the web app"]);
    expect(v.openQuestions.map((q) => q.id)).toEqual(["q1"]);
  });

  it("is stale and not actionable after the draft changed, but still shows the review", () => {
    const v = deepReviewView({ review: review("r1"), questions: [question("q1", "r1")], draft: "fix the admin login" });
    expect(v).toMatchObject({ state: "stale", actionable: false, canImprove: false });
    expect(v.issues).toHaveLength(1);
    expect(v.contextGaps).toEqual(["No error message given"]);
  });

  it("treats a review without a prompt hash as stale", () => {
    const { promptHash: _h, ...old } = review("r1");
    expect(deepReviewView({ review: old as Event<DeepReviewRecord>, questions: [], draft: DRAFT }).state).toBe("stale");
  });

  it("shows running over everything else and keeps actions off", () => {
    expect(deepReviewView({ review: review("r1"), questions: [], draft: DRAFT, running: true })).toMatchObject({ state: "running", actionable: false, canImprove: false });
  });

  it("shows an error with exactly one action", () => {
    const v = deepReviewView({ review: review("r1"), questions: [], draft: DRAFT, error: mapError(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })) });
    expect(v.state).toBe("error");
    expect(v.error).toEqual({ message: "The model provider did not answer in time.", action: "retry", actionLabel: "Retry" });
    expect(v.actionable).toBe(false);
  });

  it("does not offer the rewrite after a review without questions", () => {
    expect(deepReviewView({ review: review("r1", { questions: [] }), questions: [], draft: DRAFT }).canImprove).toBe(false);
  });
});

describe("questions and Q&A history", () => {
  it("shows only the latest round's open questions and every answered or skipped question as history", () => {
    const qs = [
      question("old-open", "r0"),
      question("old-answered", "r0", { answer: { text: "the admin login", answeredAt: "t" } }),
      question("old-skipped", "r0", { skippedAt: "t" }),
      question("new-open", "r1"),
      question("new-answered", "r1", { answer: { text: "  ", answeredAt: "t" } }),
    ];
    const v = deepReviewView({ review: review("r1"), questions: qs, draft: DRAFT });
    expect(v.openQuestions.map((q) => q.id)).toEqual(["new-open", "new-answered"]);
    expect(v.qaHistory).toEqual([
      { question: "question old-answered", answer: "the admin login", skipped: false },
      { question: "question old-skipped", skipped: true },
    ]);
  });
});

describe("manifestRows", () => {
  it("names every source in plain words with its size and status", () => {
    const rows = manifestRows({
      sources: [
        entry("draft", { tokens: 4 }),
        entry("qa", { included: false, omittedReason: "empty", tokens: 0 }),
        entry("prompt-files", { included: false, omittedReason: "empty", tokens: 0, details: { files: 0, missing: 1 } }),
        entry("git-diff", { included: false, omittedReason: "budget", tokens: 0 }),
        entry("symbols", { truncated: true, tokens: 120 }),
        entry("instructions:AGENTS.md", { tokens: 256 }),
        entry("docs:docs/ARCHITECTURE.md", { included: false, omittedReason: "budget", tokens: 0 }),
      ],
      totalTokens: 380,
      budget: 400,
    });
    expect(rows).toEqual([
      { label: "your draft", tokens: 4, status: "included", facts: [] },
      { label: "earlier answers", tokens: 0, status: "left out", reason: "nothing to include", facts: [] },
      { label: "the referenced files", tokens: 0, status: "left out", reason: "nothing to include", facts: ["1 referenced file was not found in the workspace"] },
      { label: "the uncommitted changes", tokens: 0, status: "left out", reason: "the context budget was full", facts: [] },
      { label: "the code outline", tokens: 120, status: "cut", facts: [] },
      { label: "AGENTS.md (project instructions)", tokens: 256, status: "included", facts: [] },
      { label: "docs/ARCHITECTURE.md (project description)", tokens: 0, status: "left out", reason: "the context budget was full", facts: [] },
    ]);
  });
});

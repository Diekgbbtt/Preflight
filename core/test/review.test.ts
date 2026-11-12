import { describe, expect, it } from "vitest";
import { analyze, buildReviewRequest, extractJson, mergeAnswers, parseCliOutput, parseReview, review, type ModelRunner } from "../src";

describe("review", () => {
  it("parses fenced JSON into gap-like objects", async () => {
    const prompt = "Improve the app";
    const run: ModelRunner = async () => ({
      text: '```json\n{"gaps":[{"category":"target","priority":"important","quote":"the app","question":"Which page?","reason":"The agent cannot tell which page.","suggestion":"the dashboard"},{"question":"","reason":"dropped: no question"}]}\n```',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
    });
    const r = await review(prompt, "deep", run, "sonnet", { analysis: analyze(prompt) });
    expect(r.gaps).toEqual([
      { category: "target", priority: "important", quote: "the app", question: "Which page?", reason: "The agent cannot tell which page.", suggestion: "the dashboard" },
    ]);
    expect(r).not.toHaveProperty("improvedPrompt");
    expect(r.usage.costUsd).toBe(0.001);
  });

  it("caps quick reviews at three gaps and tolerates missing fields", () => {
    const res = (gaps: unknown) => ({ text: JSON.stringify({ gaps }), inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const many = Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}?` }));
    expect(parseReview("quick", res(many)).gaps.length).toBe(3);
    expect(parseReview("deep", res(many)).gaps.length).toBe(4);
    expect(parseReview("quick", res(many)).gaps[0]).toMatchObject({ question: "Q0?", reason: "", quote: undefined });
    expect(parseReview("quick", res("nope")).gaps).toEqual([]);
  });

  it("asks both models for gaps, not an improved prompt", () => {
    for (const mode of ["quick", "deep"] as const) {
      const req = buildReviewRequest("Improve the app", mode, "m");
      expect(req.system).toContain('"gaps"');
      expect(req.system).not.toContain("improvedPrompt");
    }
  });

  it("throws on replies without JSON", () => {
    expect(() => extractJson("sorry, no")).toThrow();
  });
});

describe("parseCliOutput", () => {
  it("reads result, tokens and cost from claude -p JSON", () => {
    const r = parseCliOutput(
      JSON.stringify({ result: "{}", total_cost_usd: 0.0002, usage: { input_tokens: 2, cache_creation_input_tokens: 954, output_tokens: 9 } }),
    );
    expect(r).toEqual({ text: "{}", inputTokens: 956, outputTokens: 9, costUsd: 0.0002 });
  });
});

describe("mergeAnswers", () => {
  it("sends the answers and returns the rewritten prompt without fences", async () => {
    let seen = "";
    const run: ModelRunner = async (req) => {
      seen = req.user;
      return { text: "```\nImprove the dashboard's first load to under one second.\n```", inputTokens: 50, outputTokens: 12, costUsd: 0.0001 };
    };
    const r = await mergeAnswers("Improve the app's performance.", [{ question: "Which part?", answer: "The dashboard" }], run, "haiku");
    expect(seen).toContain("A: The dashboard");
    expect(r.text).toBe("Improve the dashboard's first load to under one second.");
    expect(r.usage.outputTokens).toBe(12);
  });

  it("rejects an empty rewrite", async () => {
    const run: ModelRunner = async () => ({ text: "  ", inputTokens: 1, outputTokens: 0, costUsd: 0 });
    await expect(mergeAnswers("x", [], run, "haiku")).rejects.toThrow();
  });
});

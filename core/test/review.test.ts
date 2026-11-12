import { describe, expect, it } from "vitest";
import { analyze, extractJson, mergeAnswers, parseCliOutput, review, type ModelRunner } from "../src";

describe("review", () => {
  it("parses fenced JSON and maps quotes to ranges", async () => {
    const prompt = "Improve the app";
    const run: ModelRunner = async () => ({
      text: '```json\n{"verdict":"needs-work","issues":[{"quote":"the app","question":"Which page?","problem":"Too broad","suggestion":"Name a page"}],"questions":["Which page?"],"improvedPrompt":"Improve [which page?]"}\n```',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
    });
    const r = await review(prompt, "deep", run, "sonnet", { analysis: analyze(prompt) });
    expect(r.verdict).toBe("needs-work");
    expect(r.issues[0].range).toEqual({ start: 8, end: 15 });
    expect(r.issues[0].question).toBe("Which page?");
    expect(r.improvedPrompt).toContain("[which page?]");
    expect(r.usage.costUsd).toBe(0.001);
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

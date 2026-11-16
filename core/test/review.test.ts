import { describe, expect, it } from "vitest";
import { analyze, extractJson, hashPrompt, parseCliOutput, parseScore, review, type ModelRunner, type ScoreMeta } from "../src";

describe("hashPrompt", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["hello", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"],
    ["  hello\r\nworld  ", "26c60a61d01db5836ca70fefd44a6a016620413c8ef5f259a6c5612d4f79d3b8"],
    ["Target: src/a.ts\nAction: add a test", "380c8cdb25423d97431861938064739609ddfdc729ab81fafa996983e36fbba8"],
  ])("hashes %j to the known vector", (text, expected) => {
    expect(hashPrompt(text)).toBe(expected);
  });
});

describe("parseScore", () => {
  const prompt = "Add a test for login";
  const meta: ScoreMeta = { source: "quick", provider: "stub", model: "sonnet", thinkingEffort: "low", scoredAt: "2026-01-01T00:00:00.000Z" };
  const res = (json: string) => json;

  it("sums the four dimensions and records versions", () => {
    const text = res('{"dimensions":{"target":20,"action":25,"scope":15,"done":20},"verdict":"ready","score":99}');
    const s = parseScore(text, prompt, meta);
    expect(s?.dimensions).toEqual({ target: 20, action: 25, scope: 15, done: 20 });
    expect(s?.score).toBe(80);
    expect(s?.level).toBe("clear");
    expect(s?.source).toBe("quick");
    expect(s?.provider).toBe("stub");
    expect(s?.model).toBe("sonnet");
    expect(s?.thinkingEffort).toBe("low");
    expect(s?.rubricVersion).toBe("v1");
    expect(s?.scoredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(s?.promptHash).toBe(hashPrompt(prompt));
  });

  it("ignores the model total and verdict", () => {
    const text = res('{"dimensions":{"target":5,"action":5,"scope":5,"done":5},"score":100,"verdict":"ready"}');
    const s = parseScore(text, prompt, meta);
    expect(s?.score).toBe(20);
    expect(s?.level).toBe("vague");
  });

  it.each([
    ["missing dimension", '{"dimensions":{"target":20,"action":25,"scope":15}}'],
    ["string number", '{"dimensions":{"target":"20","action":25,"scope":15,"done":20}}'],
    ["float", '{"dimensions":{"target":5.5,"action":25,"scope":15,"done":20}}'],
    ["negative", '{"dimensions":{"target":-5,"action":25,"scope":15,"done":20}}'],
    ["out of range", '{"dimensions":{"target":30,"action":25,"scope":15,"done":20}}'],
    ["not multiple of 5", '{"dimensions":{"target":22,"action":25,"scope":15,"done":20}}'],
    ["dimensions not an object", '{"dimensions":[20,25,15,20]}'],
    ["dimensions missing", '{"issues":[]}'],
    ["two JSON objects", '{"dimensions":{"target":20,"action":25,"scope":15,"done":20}} {"dimensions":{"target":5,"action":5,"scope":5,"done":5}}'],
    ["malformed JSON", '{"dimensions":{"target":20,'],
  ])("rejects %s", (_name, text) => {
    expect(parseScore(text, prompt, meta)).toBeNull();
  });

  it("ignores extra dimension keys and keeps confidence only in 0..1", () => {
    const good = res('{"dimensions":{"target":20,"action":25,"scope":15,"done":20,"style":25},"confidence":0.8}');
    expect(parseScore(good, prompt, meta)?.confidence).toBe(0.8);
    const badConfidence = res('{"dimensions":{"target":20,"action":25,"scope":15,"done":20},"confidence":1.5}');
    expect(parseScore(badConfidence, prompt, meta)?.confidence).toBeUndefined();
  });
});

describe("review", () => {
  it("parses fenced JSON and maps quotes to ranges", async () => {
    const prompt = "Improve the app";
    const run: ModelRunner = async () => ({
      text: '```json\n{"verdict":"needs-work","issues":[{"quote":"the app","problem":"Too broad","suggestion":"Name a page"}],"questions":["Which page?"],"improvedPrompt":"Improve [which page?]"}\n```',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.001,
    });
    const r = await review(prompt, "deep", run, "sonnet", { analysis: analyze(prompt) });
    expect(r.verdict).toBe("needs-work");
    expect(r.issues[0].range).toEqual({ start: 8, end: 15 });
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

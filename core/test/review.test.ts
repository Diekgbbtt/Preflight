import { describe, expect, it } from "vitest";
import { analyze, buildReviewRequest, extractJson, hashPrompt, parseCliOutput, parseDeepReview, parseQuickReview, parseScore, review, DEEP_REPLY_SCHEMA, QUICK_REPLY_SCHEMA, RUBRIC_TEXT, type ModelRunner, type ScoreMeta } from "../src";

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

describe("parseQuickReview", () => {
  const prompt = "Improve the app";
  const meta: ScoreMeta = { source: "quick", provider: "stub", model: "sonnet", thinkingEffort: "low", scoredAt: "2026-01-01T00:00:00.000Z" };

  it("keeps score, issues and questions from a valid reply", () => {
    const text = JSON.stringify({
      dimensions: { target: 5, action: 10, scope: 15, done: 5 },
      confidence: 0.9,
      issues: [{ quote: "the app", problem: "Too broad", suggestion: "Name a page" }],
      questions: ["Which page?"],
    });
    const r = parseQuickReview(text, prompt, meta);
    expect(r.score?.score).toBe(35);
    expect(r.score?.level).toBe("vague");
    expect(r.issues).toEqual([{ quote: "the app", range: { start: 8, end: 15 }, problem: "Too broad", suggestion: "Name a page" }]);
    expect(r.questions).toEqual(["Which page?"]);
  });

  it("drops a quote that is not a substring of the prompt but keeps the issue", () => {
    const text = JSON.stringify({
      dimensions: { target: 25, action: 25, scope: 25, done: 25 },
      issues: [{ quote: "not in the prompt", problem: "Missing", suggestion: "Fix" }],
    });
    const r = parseQuickReview(text, prompt, meta);
    expect(r.issues[0]).toEqual({ quote: undefined, range: undefined, problem: "Missing", suggestion: "Fix" });
  });

  it("caps issues and questions at 3 and drops empty problems", () => {
    const issue = (p: string) => ({ problem: p, suggestion: "Fix" });
    const text = JSON.stringify({
      dimensions: { target: 25, action: 25, scope: 25, done: 25 },
      issues: [issue("a"), issue(""), issue("c"), issue("d")],
      questions: ["1", 2, "3", "4"],
    });
    const r = parseQuickReview(text, prompt, meta);
    expect(r.issues.map((i) => i.problem)).toEqual(["a", "c", "d"]);
    expect(r.questions).toEqual(["1", "3", "4"]);
  });

  it("returns score null and empty lists without throwing on malformed text", () => {
    for (const text of ["sorry, no", '{"dimensions":{"target":30}}', "{", '{"dimensions":null}']) {
      const r = parseQuickReview(text, prompt, meta);
      expect(r, text).toEqual({ score: null, issues: [], questions: [] });
    }
  });

  it("keeps issues when only the score is invalid", () => {
    const text = JSON.stringify({
      dimensions: { target: "25", action: 25, scope: 25, done: 25 },
      issues: [{ problem: "Still an issue", suggestion: "Fix" }],
      questions: ["What?"],
    });
    const r = parseQuickReview(text, prompt, meta);
    expect(r.score).toBeNull();
    expect(r.issues.map((i) => i.problem)).toEqual(["Still an issue"]);
    expect(r.questions).toEqual(["What?"]);
  });
});

describe("parseDeepReview", () => {
  const prompt = "Fix the login bug";
  const usage = { inputTokens: 100, outputTokens: 20, costUsd: 0.001 };
  const meta = { source: "deep", provider: "stub", model: "sonnet", thinkingEffort: "high", scoredAt: "2026-01-01T00:00:00.000Z", usage, latency: 42 };

  it("builds a full DeepReview with versions and injected usage", () => {
    const text = JSON.stringify({
      dimensions: { target: 25, action: 20, scope: 20, done: 15 },
      confidence: 0.7,
      issues: [{ quote: "login bug", problem: "No expected result", suggestion: "Describe what should happen" }],
      questions: [{ question: "What should happen?", why: "Done needs a goal", options: ["Redirect", "Error message", ""] }],
      improvedPrompt: "Fix [which bug?]",
      assumptions: ["The bug is in the client"],
      contextGaps: ["No error text"],
    });
    const r = parseDeepReview(text, prompt, meta);
    expect(r.score?.score).toBe(80);
    expect(r.score?.level).toBe("clear");
    expect(r.score?.rubricVersion).toBe("v1");
    expect(r.score?.promptHash).toBe(hashPrompt(prompt));
    expect(r.issues).toHaveLength(1);
    expect(r.questions).toEqual([{ question: "What should happen?", why: "Done needs a goal", options: ["Redirect", "Error message", ""] }]);
    expect(r.improvedPrompt).toBe("Fix [which bug?]");
    expect(r.assumptions).toEqual(["The bug is in the client"]);
    expect(r.contextGaps).toEqual(["No error text"]);
    expect(r.usage).toEqual(usage);
    expect(r.latency).toBe(42);
    expect(r.promptVersion).toBe("v1");
  });

  it("drops a question with empty text and fills missing why and options", () => {
    const text = JSON.stringify({
      dimensions: { target: 25, action: 25, scope: 25, done: 25 },
      questions: [{ question: "", why: "x" }, { question: "Keep me" }, { why: "no question" }, "flat string"],
    });
    const r = parseDeepReview(text, prompt, meta);
    expect(r.questions).toEqual([{ question: "Keep me", why: "", options: [] }]);
  });

  it("caps questions and options at 3 and keeps only string options", () => {
    const q = (n: number) => ({ question: `q${n}`, options: ["a", 1, "b", "c"] });
    const text = JSON.stringify({ dimensions: { target: 25, action: 25, scope: 25, done: 25 }, questions: [q(1), q(2), q(3), q(4)] });
    const r = parseDeepReview(text, prompt, meta);
    expect(r.questions.map((x) => x.question)).toEqual(["q1", "q2", "q3"]);
    expect(r.questions[0].options).toEqual(["a", "b", "c"]);
  });

  it("keeps only strings in assumptions and contextGaps and defaults improvedPrompt", () => {
    const text = JSON.stringify({
      dimensions: { target: 25, action: 25, scope: 25, done: 25 },
      assumptions: ["ok", 5],
      contextGaps: [null, "gap"],
    });
    const r = parseDeepReview(text, prompt, meta);
    expect(r.improvedPrompt).toBe("");
    expect(r.assumptions).toEqual(["ok"]);
    expect(r.contextGaps).toEqual(["gap"]);
  });

  it("returns a safe empty review without throwing on malformed text", () => {
    for (const text of ["sorry, no", '{"dimensions":{"target":5.5}}', "[]", '{"questions":"no"}']) {
      const r = parseDeepReview(text, prompt, meta);
      expect(r, text).toEqual({ score: null, issues: [], questions: [], improvedPrompt: "", assumptions: [], contextGaps: [], usage, latency: 42, promptVersion: "v1" });
    }
  });

  it("keeps issues when only the dimensions are invalid", () => {
    const text = JSON.stringify({ dimensions: { target: 30, action: 25, scope: 25, done: 25 }, issues: [{ problem: "Still here", suggestion: "Fix" }] });
    const r = parseDeepReview(text, prompt, meta);
    expect(r.score).toBeNull();
    expect(r.issues.map((i) => i.problem)).toEqual(["Still here"]);
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

describe("buildReviewRequest", () => {
  const prompt = "Improve the app";

  it("includes the shared rubric and the mode reply schema once in the system prompt", () => {
    for (const mode of ["quick", "deep"] as const) {
      const req = buildReviewRequest(prompt, mode, "sonnet");
      expect(req.system.match(new RegExp(RUBRIC_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
      const schema = mode === "quick" ? QUICK_REPLY_SCHEMA : DEEP_REPLY_SCHEMA;
      expect(req.system.match(new RegExp(schema.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
      expect(req.system).toContain(schema);
    }
  });

  it("keeps the rubric out of the user message", () => {
    const req = buildReviewRequest(prompt, "quick", "sonnet");
    expect(req.user).not.toContain(RUBRIC_TEXT);
    expect(req.user).toContain(`<prompt>\n${prompt}\n</prompt>`);
  });

  it("keeps the analysis notes and project notes in the user message", () => {
    const req = buildReviewRequest(prompt, "deep", "sonnet", { analysis: analyze(prompt), projectNotes: "Files: a.ts" });
    expect(req.user).toContain("Rule-based checks already found:");
    expect(req.user).toContain("Files: a.ts");
  });
});

describe("analyze hardBlock", () => {
  it("is true only when a finding has severity error", () => {
    const a = analyze("Deploy with the API key sk-1234567890abcdefghij");
    expect(a.findings.some((f) => f.severity === "error")).toBe(true);
    expect(a.hardBlock).toBe(true);
    expect(analyze("Add a test for login in src/login.ts").hardBlock).toBe(false);
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

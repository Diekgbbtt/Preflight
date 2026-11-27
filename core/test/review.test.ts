import { describe, expect, it } from "vitest";
// Schema-first import: this file's first import evaluates schema.ts before review.ts.
// It reproduces the D1 schema/review import cycle: before extractJson moved into schema.ts
// this file failed with "ReferenceError: Cannot access 'RUBRIC_TEXT' before initialization".
import { DEEP_REPLY_SCHEMA, QUICK_REPLY_SCHEMA, RUBRIC_TEXT, hashPrompt, parseScore } from "../src/schema";
import { LEGACY_DEEP_REPLY_SCHEMA, analyze, buildImprovedPromptRequest, buildReviewRequest, extractJson, parseCliOutput, parseDeepReview, parseQuickReview, review, type ModelRunner, type ModelUsage, type ScoreMeta } from "../src";

describe("schema module standalone import", () => {
  it("exposes the rubric, hash and parser without review.ts evaluating first", () => {
    expect(RUBRIC_TEXT).toContain("target (where): 0 = no target at all");
    expect(hashPrompt("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    const s = parseScore('{"dimensions":{"target":25,"action":25,"scope":25,"done":25}}', "p", {
      provider: "p", model: "m", thinkingEffort: "low", scoredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(s?.score).toBe(100);
  });
});

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
  const meta: ScoreMeta = { provider: "stub", model: "sonnet", thinkingEffort: "low", scoredAt: "2026-01-01T00:00:00.000Z" };
  const res = (json: string) => json;

  it("sums the four dimensions and records versions", () => {
    const text = res('{"dimensions":{"target":20,"action":25,"scope":15,"done":20},"verdict":"ready","score":99}');
    const s = parseScore(text, prompt, meta);
    expect(s?.dimensions).toEqual({ target: 20, action: 25, scope: 15, done: 20 });
    expect(s?.score).toBe(80);
    expect(s?.level).toBe("clear");
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
  const meta: ScoreMeta = { provider: "stub", model: "sonnet", thinkingEffort: "low", scoredAt: "2026-01-01T00:00:00.000Z" };

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

  it("caps issues and questions at 20 and drops empty problems", () => {
    const issue = (p: string) => ({ problem: p, suggestion: "Fix" });
    const issues = Array.from({ length: 21 }, (_, i) => issue(`i${i}`));
    issues.splice(1, 0, issue(""));
    const questions: Array<string | number> = Array.from({ length: 22 }, (_, i) => `q${i}`);
    questions.splice(1, 0, 2);
    const text = JSON.stringify({
      dimensions: { target: 25, action: 25, scope: 25, done: 25 },
      issues,
      questions,
    });
    const r = parseQuickReview(text, prompt, meta);
    expect(r.issues.map((i) => i.problem)).toEqual(Array.from({ length: 20 }, (_, i) => `i${i}`));
    expect(r.questions).toEqual(Array.from({ length: 20 }, (_, i) => `q${i}`));
  });

  it("returns score null and empty lists without throwing on malformed text", () => {
    for (const text of ["sorry, no", '{"dimensions":{"target":30}}', "{", '{"dimensions":null}', '{"dimensions":{"target":20,"action":25,"scope":15,"done":20}} {"verdict":"ready"}']) {
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

  it("reads fenced JSON wrapped in prose and keeps duplicate quotes", () => {
    const text = 'Here you go:\n```json\n{"dimensions":{"target":25,"action":25,"scope":25,"done":25},"issues":[{"quote":"the app","problem":"First","suggestion":"Fix"},{"quote":"the app","problem":"Second","suggestion":"Fix"}]}\n```\nHope that helps!';
    const r = parseQuickReview(text, prompt, meta);
    expect(r.score?.score).toBe(100);
    expect(r.issues.map((i) => i.problem)).toEqual(["First", "Second"]);
    expect(r.issues[0].range).toEqual({ start: 8, end: 15 });
  });
});

describe("parseDeepReview", () => {
  const prompt = "Fix the login bug";
  const usage = { inputTokens: 100, outputTokens: 20, costUsd: 0.001 };
  const meta: { usage: ModelUsage; latency: number } = { usage, latency: 42 };

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
    expect(r).not.toHaveProperty("score");
    expect(r).not.toHaveProperty("improvedPrompt");
    expect(r.issues).toHaveLength(1);
    expect(r.questions).toEqual([{ question: "What should happen?", why: "Done needs a goal", options: ["Redirect", "Error message", ""] }]);
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

  it("caps questions at 20, options at 3, and keeps only string options", () => {
    const q = (n: number) => ({ question: `q${n}`, options: ["a", 1, "b", "c", "d"] });
    const text = JSON.stringify({
      dimensions: { target: 25, action: 25, scope: 25, done: 25 },
      questions: Array.from({ length: 21 }, (_, i) => q(i)),
    });
    const r = parseDeepReview(text, prompt, meta);
    expect(r.questions.map((x) => x.question)).toEqual(Array.from({ length: 20 }, (_, i) => `q${i}`));
    expect(r.questions[0].options).toEqual(["a", "b", "c"]);
  });

  it("keeps only strings in assumptions and contextGaps", () => {
    const text = JSON.stringify({
      assumptions: ["ok", 5],
      contextGaps: [null, "gap"],
    });
    const r = parseDeepReview(text, prompt, meta);
    expect(r.assumptions).toEqual(["ok"]);
    expect(r.contextGaps).toEqual(["gap"]);
  });

  it("returns a safe empty review without throwing on malformed text", () => {
    for (const text of ["sorry, no", '{"dimensions":{"target":5.5}}', "[]", '{"questions":"no"}', '{"dimensions":{"target":25,"action":25,"scope":25,"done":25}} {"dimensions":{"target":5,"action":5,"scope":5,"done":5}}']) {
      const r = parseDeepReview(text, prompt, meta);
      expect(r, text).toEqual({ issues: [], questions: [], assumptions: [], contextGaps: [], usage, latency: 42, promptVersion: "v1" });
    }
  });

  it("ignores dimensions and keeps issues", () => {
    const text = JSON.stringify({ dimensions: { target: 30, action: 25, scope: 25, done: 25 }, issues: [{ problem: "Still here", suggestion: "Fix" }] });
    const r = parseDeepReview(text, prompt, meta);
    expect(r).not.toHaveProperty("score");
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

  it("adapts structured deep questions for the legacy panel and ignores malformed entries", async () => {
    const run: ModelRunner = async () => ({
      text: JSON.stringify({
        questions: [
          { question: "Which file?", why: "Find the target", options: ["a.ts"] },
          null, {}, 42, { question: false }, { question: "   " },
          "What should happen?",
        ],
      }),
      inputTokens: 10, outputTokens: 5, costUsd: 0,
    });
    const result = await review("Fix login", "deep", run, "sonnet");
    expect(result.questions).toEqual(["Which file?", "What should happen?"]);
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
      const schema = mode === "quick" ? QUICK_REPLY_SCHEMA : LEGACY_DEEP_REPLY_SCHEMA;
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

  // Guard for the #56 privacy boundary (ADR 0001): the CLI mention parser is
  // only neutralized on stdin, so our own system prompts must never gain a
  // mention token. Flag values are not expanded today; this keeps it true.
  it("keeps @ mention tokens out of the built system prompts", () => {
    const emptyDeepReview = {
      issues: [],
      questions: [],
      assumptions: [],
      contextGaps: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      latency: 0,
      promptVersion: "v1",
    };
    const systems = [
      buildReviewRequest(prompt, "quick", "sonnet").system,
      buildReviewRequest(prompt, "deep", "sonnet").system,
      buildImprovedPromptRequest(prompt, emptyDeepReview, [], "sonnet").system,
    ];
    for (const system of systems) {
      expect(system).not.toMatch(/@[A-Za-z0-9_.~\\/-]/);
    }
  });
});

describe("rubric and reply schemas", () => {
  it("gives each dimension line all six anchor numbers", () => {
    const lines = RUBRIC_TEXT.split("\n").filter((l) => /^(target|action|scope|done)\b/.test(l));
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const dimension = line.split(/\s/)[0];
      for (const anchor of [0, 5, 10, 15, 20, 25]) {
        expect(line.match(new RegExp(`(^|[:;] )${anchor} =`)), `${dimension} anchor ${anchor}`).toBeTruthy();
      }
    }
  });

  it("pins the quick reply schema", () => {
    expect(QUICK_REPLY_SCHEMA).toMatchInlineSnapshot(
      `"{"dimensions":{"target":0-25,"action":0-25,"scope":0-25,"done":0-25},"confidence":0-1,"issues":[{"quote":"exact words from the prompt or empty","problem":"max 15 words","suggestion":"max 20 words"}],"questions":["max 20 short questions to the user"]}"`,
    );
  });

  it("pins the deep reply schema", () => {
    expect(DEEP_REPLY_SCHEMA).toMatchInlineSnapshot(
      `"{"issues":[{"quote":"exact words from the prompt or empty","problem":"what is missing and why it matters","suggestion":"how to fix it"}],"questions":[{"question":"...","why":"why the agent needs it","options":["max 3 choices"]}],"assumptions":["..."],"contextGaps":["..."]}"`,
    );
  });
});

describe("analyze hardBlock", () => {
  it("is true only when a finding has severity error", () => {
    const a = analyze("Deploy with the API key sk-1234567890abcdefghij");
    expect(a.findings.some((f) => f.severity === "error")).toBe(true);
    expect(a.hardBlock).toBe(true);
    expect(analyze("Add a test for login in src/login.ts").hardBlock).toBe(false);
  });

  it("derives levels from the shared levelForScore thresholds", () => {
    expect(analyze("Add a test for login in src/login.ts").level).toBe("clear");
    expect(analyze("Fix the bug in the payment module").level).toBe("needs-work");
    expect(analyze("Improve it").level).toBe("vague");
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

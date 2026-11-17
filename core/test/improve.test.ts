import { describe, expect, it, vi } from "vitest";
import {
  IMPROVE_PROMPT_VERSION,
  IMPROVE_REPLY_SCHEMA,
  RUBRIC_TEXT,
  buildImprovedPromptRequest,
  canImprove,
  improvePrompt,
  parseImprovedPrompt,
  type DeepReview,
  type ModelResponse,
  type ModelRunner,
} from "../src";

const usage = { inputTokens: 30, outputTokens: 10, costUsd: 0.0005 };

const review = (questions: DeepReview["questions"]): DeepReview => ({
  issues: [{ quote: "login", problem: "No expected result", suggestion: "State what should happen" }],
  questions,
  assumptions: ["The bug is in the client"],
  contextGaps: ["No error text"],
  usage,
  latency: 12,
  promptVersion: "v1",
});

describe("canImprove", () => {
  it("is false without a deep question", () => {
    expect(canImprove(review([]))).toBe(false);
  });

  it("is true with at least one deep question", () => {
    expect(canImprove(review([{ question: "What should happen?", why: "Done needs a goal", options: [] }]))).toBe(true);
  });
});

describe("parseImprovedPrompt", () => {
  it("parses a plain JSON reply and records the injected usage and latency", () => {
    const result = parseImprovedPrompt('{"improvedPrompt":"Fix the login bug so that [expected result]"}', usage, 34);
    expect(result).toEqual({
      text: "Fix the login bug so that [expected result]",
      usage,
      latency: 34,
      promptVersion: IMPROVE_PROMPT_VERSION,
    });
  });

  it("tolerates fences and prose", () => {
    const result = parseImprovedPrompt('Here:\n```json\n{"improvedPrompt":"Keep [which page?]"}\n```\nDone.', usage, 1);
    expect(result?.text).toBe("Keep [which page?]");
  });

  it.each([
    ["malformed JSON", '{"improvedPrompt":'],
    ["missing field", '{"text":"no"}'],
    ["empty text", '{"improvedPrompt":"   "}'],
    ["non-string field", '{"improvedPrompt":3}'],
    ["array reply", "[]"],
    ["prose only", "sorry, no"],
  ])("returns null for %s", (_name, text) => {
    expect(parseImprovedPrompt(text, usage, 1)).toBeNull();
  });
});

describe("buildImprovedPromptRequest", () => {
  const deep = review([{ question: "What should happen?", why: "Done needs a goal", options: ["Redirect", "Error"] }]);
  const prompt = "Fix the login bug";

  it("asks for a rewrite with placeholders and never includes the rubric", () => {
    const req = buildImprovedPromptRequest(prompt, deep, [], "sonnet");
    expect(req.system).toContain("placeholder");
    expect(req.system).toContain(IMPROVE_REPLY_SCHEMA);
    expect(req.system).not.toContain(RUBRIC_TEXT);
    expect(req.user).toContain(`<prompt>\n${prompt}\n</prompt>`);
    expect(req.user).toContain("No expected result");
    expect(req.user).toContain("What should happen?");
    expect(req.user).toContain("The bug is in the client");
    expect(req.user).toContain("No error text");
    expect(req.user).toContain("No questions have been answered");
  });

  it("includes answered questions when present", () => {
    const req = buildImprovedPromptRequest(prompt, deep, [{ question: "What should happen?", answer: "Redirect home" }], "sonnet");
    expect(req.user).toContain("Redirect home");
    expect(req.user).not.toContain("No questions have been answered");
  });

  it("is a separate model request with the selected model", () => {
    expect(buildImprovedPromptRequest(prompt, deep, [], "haiku").model).toBe("haiku");
  });
});

describe("improvePrompt", () => {
  const deep = review([{ question: "What should happen?", why: "Done needs a goal", options: [] }]);

  it("does not call the model when no deep question exists", async () => {
    const run = vi.fn<ModelRunner>();
    const result = await improvePrompt("p", review([]), [], run, "sonnet", { now: () => 100 });
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("calls the model and returns the parsed rewrite with measured latency", async () => {
    const response: ModelResponse = {
      text: '{"improvedPrompt":"Fix [which bug?] so that [expected result]"}',
      inputTokens: 3,
      outputTokens: 4,
      costUsd: 0.01,
    };
    const run = vi.fn<ModelRunner>(async () => response);
    let now = 1000;
    const clock = { now: () => (now += 25) };
    const result = await improvePrompt("Fix it", deep, [], run, "sonnet", clock);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      text: "Fix [which bug?] so that [expected result]",
      usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.01 },
      latency: 25,
      promptVersion: IMPROVE_PROMPT_VERSION,
    });
  });

  it("returns null on a malformed model reply", async () => {
    const run = vi.fn<ModelRunner>(async () => ({ text: "no json", inputTokens: 1, outputTokens: 1, costUsd: 0 }));
    const result = await improvePrompt("p", deep, [], run, "sonnet", { now: () => 0 });
    expect(result).toBeNull();
  });
});

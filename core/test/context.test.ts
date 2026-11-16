import { describe, expect, it } from "vitest";
import { assemble, estimateTokens, SOURCE_PRIORITIES } from "../src/context";
import type { ContextSource, ContextSourceResult } from "../src/context";

const fakeEstimate = estimateTokens;
const noRedact = (text: string) => ({ text, count: 0 });

/** A source that returns a fixed result; collect is a stub. */
function fixedSource(id: string, priority: number, result: ContextSourceResult, maxTokens?: number): ContextSource {
  return { id, priority, maxTokens, collect: async () => result };
}

describe("estimateTokens", () => {
  it("is 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("is 1 for four characters", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("is 2 for five characters", () => {
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("assemble", () => {
  it("records the draft and qa first as always-included, redacted manifest entries", async () => {
    const redact = (text: string) => ({ text: text.replaceAll("hunter2", "[redacted]"), count: text.includes("hunter2") ? 1 : 0 });
    const bundle = await assemble(
      {
        draft: "use hunter2 in api.ts",
        qa: [
          { question: "hunter2 file?", answer: "api.ts" },
          { question: "why?", answer: "auth" },
        ],
      },
      [],
      { budget: 1000, estimateTokens: fakeEstimate, redact },
    );
    expect(bundle.draft).toBe("use [redacted] in api.ts");
    expect(bundle.qa).toEqual([
      { question: "[redacted] file?", answer: "api.ts" },
      { question: "why?", answer: "auth" },
    ]);
    expect(bundle.fragments).toEqual([]);
    expect(bundle.manifest.budget).toBe(1000);
    expect(bundle.manifest.sources.map((s) => s.source)).toEqual(["draft", "qa"]);
    const draft = bundle.manifest.sources[0];
    expect(draft).toEqual({ source: "draft", chars: "use [redacted] in api.ts".length, tokens: 6, included: true, truncated: false, redactions: 1 });
    const qa = bundle.manifest.sources[1];
    // tokens = ceil(14/4) + ceil(5/4) + ceil(4/4) + ceil(4/4) = 4 + 2 + 1 + 1 = 8
    expect(qa).toEqual({ source: "qa", chars: 16 + 6 + 4 + 4, tokens: 8, included: true, truncated: false, redactions: 1 });
    expect(bundle.manifest.totalTokens).toBe(6 + 8);
  });

  it("reserves the draft and qa tokens before the workspace budget", async () => {
    const bundle = await assemble(
      { draft: "x".repeat(44), qa: [] },
      [fixedSource("git-diff", SOURCE_PRIORITIES["git-diff"], { fragments: [{ source: "wrong", priority: 0, content: "y".repeat(40), tokens: 10, provenance: { kind: "git-diff", truncated: false, chars: 40 } }] })],
      { budget: 10, estimateTokens: fakeEstimate, redact: noRedact },
    );
    const diff = bundle.manifest.sources.find((s) => s.source === "git-diff");
    expect(diff?.included).toBe(false);
    expect(diff?.omittedReason).toBe("budget");
    expect(bundle.manifest.totalTokens).toBe(11);
    expect(bundle.manifest.totalTokens).toBeGreaterThan(bundle.manifest.budget);
  });
});


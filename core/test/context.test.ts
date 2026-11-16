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

  it("orders by priority descending then id ascending and allocates the budget in that order", async () => {
    const frag = (content: string) => ({
      fragments: [{ source: "wrong", priority: 0, content, tokens: 0, provenance: { kind: "open-editor" as const, truncated: false, chars: 0 } }],
    });
    const a = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], frag("aaaa"));
    const b = fixedSource("selection", SOURCE_PRIORITIES.selection, frag("bbbb"));
    const c = fixedSource("git-diff", SOURCE_PRIORITIES["git-diff"], frag("cccc"));
    const bundle = await assemble({ draft: "", qa: [] }, [c, a, b], {
      budget: 5,
      estimateTokens: fakeEstimate,
      redact: noRedact,
    });
    // selection (80) first: 1 token, fits. open-editors (60) next: 1 token, fits, 2 remaining.
    // git-diff (50) last: 1 token, fits, 1 remaining... budget 5 - draft 0 = 5; each frag "aaaa" = 1 token.
    expect(bundle.fragments.map((f) => f.source)).toEqual(["selection", "open-editors", "git-diff"]);
    expect(bundle.manifest.sources.map((s) => s.source)).toEqual(["draft", "qa", "selection", "open-editors", "git-diff"]);
    // The assembler overwrites the fragment source and priority from the owning source.
    expect(bundle.fragments[0]).toMatchObject({ source: "selection", priority: 80 });
    expect(bundle.manifest.totalTokens).toBe(3);
  });

  it("truncates the last source that fits and omits later sources with budget", async () => {
    const frag = (content: string) => ({
      fragments: [{ source: "wrong", priority: 0, content, tokens: 0, provenance: { kind: "open-editor" as const, truncated: false, chars: 0 } }],
    });
    const big = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], frag("w".repeat(40)));
    const later = fixedSource("git-diff", SOURCE_PRIORITIES["git-diff"], frag("z".repeat(8)));
    const bundle = await assemble({ draft: "", qa: [] }, [later, big], {
      budget: 6,
      estimateTokens: fakeEstimate,
      redact: noRedact,
    });
    const editors = bundle.manifest.sources.find((s) => s.source === "open-editors");
    const diff = bundle.manifest.sources.find((s) => s.source === "git-diff");
    expect(editors?.included).toBe(true);
    expect(editors?.truncated).toBe(true);
    expect(editors?.tokens).toBe(6);
    expect(editors?.chars).toBe(24);
    expect(editors?.omittedReason).toBeUndefined();
    expect(bundle.fragments.find((f) => f.source === "open-editors")?.provenance.truncated).toBe(true);
    expect(diff?.included).toBe(false);
    expect(diff?.omittedReason).toBe("budget");
  });

  it("applies the per-source maxTokens cap across the source's fragments in order", async () => {
    const frag = (content: string) => ({
      fragments: [
        { source: "x", priority: 0, content, tokens: 0, provenance: { kind: "open-editor" as const, truncated: false, chars: 0 } },
        { source: "x", priority: 0, content: "second file body", tokens: 0, provenance: { kind: "open-editor" as const, truncated: false, chars: 0 } },
      ],
    });
    const source = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], frag("w".repeat(24)), 5);
    const bundle = await assemble({ draft: "", qa: [] }, [source], { budget: 100, estimateTokens: fakeEstimate, redact: noRedact });
    const entry = bundle.manifest.sources.find((s) => s.source === "open-editors");
    expect(entry?.included).toBe(true);
    expect(entry?.truncated).toBe(true);
    expect(entry?.tokens).toBe(5);
    // Second fragment is dropped because the source cap is spent.
    expect(bundle.fragments).toHaveLength(1);
    expect(bundle.fragments[0].content).toBe("w".repeat(20));
  });

  it("truncates a source exactly one token over its cap at a line boundary", async () => {
    const lines = ["short line", "another line", "third line\n"];
    const source = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], {
      fragments: [{ source: "x", priority: 0, content: lines.join("\n"), tokens: 99, provenance: { kind: "open-editor", truncated: false, chars: 0 } }],
    }, 4);
    const bundle = await assemble({ draft: "", qa: [] }, [source], { budget: 100, estimateTokens: fakeEstimate, redact: noRedact });
    const fragment = bundle.fragments.find((f) => f.source === "open-editors");
    // Whole lines that fit within 4 tokens (16 chars): "short line\nanother line" = 23 chars -> 6 tokens, too many.
    // "short line" alone = 10 chars -> 3 tokens. Next line would cross. Cut after the full line.
    expect(fragment?.content).toBe("short line");
    expect(fragment?.tokens).toBe(3);
    expect(fragment?.provenance.truncated).toBe(true);
    expect(fragment?.provenance.chars).toBe(10);
  });

  it("keeps CRLF endings when truncating at a line boundary", async () => {
    const source = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], {
      fragments: [{ source: "x", priority: 0, content: "first\r\nsecond\r\n", tokens: 99, provenance: { kind: "open-editor", truncated: false, chars: 0 } }],
    }, 3);
    const bundle = await assemble({ draft: "", qa: [] }, [source], { budget: 100, estimateTokens: fakeEstimate, redact: noRedact });
    // "first\r" -> "first\r" is 6 chars = 2 tokens; adding "second\r" would make 14 chars = 4 tokens, over the cap.
    expect(bundle.fragments[0].content).toBe("first\r");
    expect(bundle.fragments[0].tokens).toBe(2);
  });

  it("cuts mid-line when no line boundary fits, and omits a source whose cap is zero", async () => {
    const long = "x".repeat(100);
    const source = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], {
      fragments: [{ source: "x", priority: 0, content: long, tokens: 99, provenance: { kind: "open-editor", truncated: false, chars: 0 } }],
    }, 4);
    const bundle = await assemble({ draft: "", qa: [] }, [source], { budget: 100, estimateTokens: fakeEstimate, redact: noRedact });
    expect(bundle.fragments[0].content).toBe("x".repeat(16));
    expect(bundle.fragments[0].tokens).toBe(4);
    expect(bundle.fragments[0].provenance.truncated).toBe(true);

    const zero = fixedSource("git-diff", SOURCE_PRIORITIES["git-diff"], {
      fragments: [{ source: "x", priority: 0, content: "text", tokens: 1, provenance: { kind: "git-diff", truncated: false, chars: 4 } }],
    }, 0);
    const zeroBundle = await assemble({ draft: "", qa: [] }, [zero], { budget: 100, estimateTokens: fakeEstimate, redact: noRedact });
    const entry = zeroBundle.manifest.sources.find((s) => s.source === "git-diff");
    expect(entry?.included).toBe(false);
    expect(entry?.omittedReason).toBe("budget");
    expect(zeroBundle.fragments).toHaveLength(0);
  });

  it("truncates one token over the total budget", async () => {
    const source = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], {
      fragments: [{ source: "x", priority: 0, content: "y".repeat(20), tokens: 5, provenance: { kind: "open-editor", truncated: false, chars: 20 } }],
    });
    const bundle = await assemble({ draft: "", qa: [] }, [source], { budget: 5, estimateTokens: fakeEstimate, redact: noRedact });
    const entry = bundle.manifest.sources.find((s) => s.source === "open-editors");
    expect(entry?.tokens).toBe(5);
    expect(entry?.truncated).toBe(false);
    expect(bundle.fragments[0].content).toBe("y".repeat(20));

    const over = fixedSource("git-diff", SOURCE_PRIORITIES["git-diff"], {
      fragments: [{ source: "x", priority: 0, content: "z".repeat(24), tokens: 6, provenance: { kind: "git-diff", truncated: false, chars: 24 } }],
    });
    const overBundle = await assemble({ draft: "", qa: [] }, [over], { budget: 5, estimateTokens: fakeEstimate, redact: noRedact });
    const diffEntry = overBundle.manifest.sources.find((s) => s.source === "git-diff");
    expect(diffEntry?.included).toBe(true);
    expect(diffEntry?.truncated).toBe(true);
    expect(diffEntry?.tokens).toBe(5);
    expect(diffEntry?.chars).toBe(20);
  });

  it("records every omit reason and keeps a throwing source from failing the bundle", async () => {
    const empty = fixedSource("selection", SOURCE_PRIORITIES.selection, { fragments: [], omittedReason: "empty" });
    const excluded = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], { fragments: [], omittedReason: "excluded" });
    const unsupported = fixedSource("git-diff", SOURCE_PRIORITIES["git-diff"], { fragments: [], omittedReason: "unsupported" });
    const throwing = fixedSource("test-command", SOURCE_PRIORITIES["test-command"], undefined as unknown as ContextSourceResult);
    throwing.collect = async () => {
      throw new Error("boom");
    };
    const healthy = fixedSource("active-editor", SOURCE_PRIORITIES["active-editor"], {
      fragments: [{ source: "x", priority: 0, content: "ok", tokens: 1, provenance: { kind: "active-file", truncated: false, chars: 2 } }],
    });
    const noReason = fixedSource("definitions", SOURCE_PRIORITIES.definitions, { fragments: [] });
    const withDetails = fixedSource("references", SOURCE_PRIORITIES.references, { fragments: [], omittedReason: "excluded", details: { found: 3, stale: true } });

    const bundle = await assemble({ draft: "", qa: [] }, [empty, excluded, unsupported, throwing, healthy, noReason, withDetails], {
      budget: 100,
      estimateTokens: fakeEstimate,
      redact: noRedact,
    });
    const bySource = Object.fromEntries(bundle.manifest.sources.map((s) => [s.source, s]));
    expect(bySource["selection"].omittedReason).toBe("empty");
    expect(bySource["open-editors"].omittedReason).toBe("excluded");
    expect(bySource["git-diff"].omittedReason).toBe("unsupported");
    expect(bySource["test-command"]).toMatchObject({ included: false, omittedReason: "error", chars: 0, tokens: 0, redactions: 0 });
    expect(bySource["definitions"].omittedReason).toBe("empty");
    expect(bySource["references"]).toMatchObject({ included: false, omittedReason: "excluded", details: { found: 3, stale: true } });
    expect(bySource["active-editor"]).toMatchObject({ included: true, tokens: 1 });
    expect(bundle.fragments.map((f) => f.source)).toEqual(["active-editor"]);
    // The error source does not stop later sources.
    expect(bundle.manifest.sources.map((s) => s.source)).toEqual([
      "draft", "qa", "selection", "active-editor", "open-editors", "git-diff", "references", "definitions", "test-command",
    ]);
  });

  it("throws on duplicate source ids, reserved ids, and duplicate extra entries", async () => {
    const s = fixedSource("selection", 80, { fragments: [] });
    await expect(assemble({ draft: "", qa: [] }, [s, fixedSource("selection", 80, { fragments: [] })], { budget: 10, estimateTokens: fakeEstimate, redact: noRedact }))
      .rejects.toThrow(/duplicate context source id "selection"/);
    await expect(assemble({ draft: "", qa: [] }, [fixedSource("draft", 100, { fragments: [] })], { budget: 10, estimateTokens: fakeEstimate, redact: noRedact }))
      .rejects.toThrow(/reserved/);
    await expect(assemble({ draft: "", qa: [] }, [fixedSource("qa", 90, { fragments: [] })], { budget: 10, estimateTokens: fakeEstimate, redact: noRedact }))
      .rejects.toThrow(/reserved/);
    const extra = { source: "AGENTS.md", chars: 1, tokens: 1, included: true, truncated: false, redactions: 0 };
    await expect(assemble({ draft: "", qa: [] }, [], { budget: 10, estimateTokens: fakeEstimate, redact: noRedact, extraEntries: [extra, { ...extra }] }))
      .rejects.toThrow(/duplicate extra manifest entry source "AGENTS\.md"/);
  });

  it("merges extra entries after the source entries, sorted by id, without consuming the budget", async () => {
    const source = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], {
      fragments: [{ source: "x", priority: 0, content: "ok", tokens: 1, provenance: { kind: "open-editor", truncated: false, chars: 2 } }],
    });
    const bundle = await assemble({ draft: "", qa: [] }, [source], {
      budget: 1,
      estimateTokens: fakeEstimate,
      redact: noRedact,
      extraEntries: [
        { source: "CLAUDE.md", chars: 5, tokens: 2, included: true, truncated: false, redactions: 0 },
        { source: "AGENTS.md", chars: 5, tokens: 2, included: true, truncated: false, redactions: 0 },
      ],
    });
    expect(bundle.manifest.sources.map((s) => s.source)).toEqual(["draft", "qa", "open-editors", "AGENTS.md", "CLAUDE.md"]);
    expect(bundle.manifest.totalTokens).toBe(1);
    expect(bundle.manifest.sources.find((s) => s.source === "CLAUDE.md")?.tokens).toBe(2);
  });

  it("does not double count an already-redacted fragment and sums counts in the manifest", async () => {
    const already = fixedSource("selection", SOURCE_PRIORITIES.selection, {
      fragments: [{ source: "x", priority: 0, content: "secret[redacted]", tokens: 4, provenance: { kind: "selection", truncated: false, chars: 16, redactions: 2 } }],
    });
    const raw = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], {
      fragments: [{ source: "x", priority: 0, content: "hunter2", tokens: 2, provenance: { kind: "open-editor", truncated: false, chars: 7 } }],
    });
    const redact = (text: string) => ({ text: text.replaceAll("hunter2", "[redacted]"), count: text.includes("hunter2") ? 1 : 0 });
    const bundle = await assemble({ draft: "", qa: [] }, [already, raw], { budget: 100, estimateTokens: fakeEstimate, redact });
    const sel = bundle.manifest.sources.find((s) => s.source === "selection");
    const ed = bundle.manifest.sources.find((s) => s.source === "open-editors");
    expect(sel?.redactions).toBe(2);
    expect(sel?.chars).toBe(16);
    expect(ed?.redactions).toBe(1);
    expect(ed?.chars).toBe(10);
    expect(bundle.fragments.find((f) => f.source === "open-editors")?.content).toBe("[redacted]");
  });

  it("rejects on abort before, during and after collect, and never returns a partial bundle", async () => {
    const before = new AbortController();
    before.abort();
    // The spec allows either the cancelled error or signal.reason.
    const acceptsAbort = (error: unknown) => {
      const e = error as { code?: string; name?: string };
      return e.code === "cancelled" || e.name === "AbortError";
    };
    await expect(assemble({ draft: "d", qa: [] }, [], { budget: 10, estimateTokens: fakeEstimate, redact: noRedact, signal: before.signal }))
      .rejects.toSatisfy(acceptsAbort);

    const during = new AbortController();
    const neverReturns: ContextSource = {
      id: "selection",
      priority: 80,
      collect: async (signal) => {
        signal?.throwIfAborted();
        return { fragments: [] };
      },
    };
    during.abort();
    await expect(assemble({ draft: "d", qa: [] }, [neverReturns], { budget: 10, estimateTokens: fakeEstimate, redact: noRedact, signal: during.signal }))
      .rejects.toSatisfy(acceptsAbort);

    const after = new AbortController();
    const thenAbort: ContextSource = {
      id: "git-diff",
      priority: 50,
      collect: async () => {
        after.abort();
        return { fragments: [] };
      },
    };
    await expect(assemble({ draft: "d", qa: [] }, [thenAbort], { budget: 10, estimateTokens: fakeEstimate, redact: noRedact, signal: after.signal }))
      .rejects.toSatisfy(acceptsAbort);
  });

  it("produces identical fragments and manifest regardless of the input source order", async () => {
    const frag = (content: string) => ({
      fragments: [{ source: "x", priority: 0, content, tokens: 0, provenance: { kind: "open-editor" as const, truncated: false, chars: 0 } }],
    });
    const a = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], frag("aaaa"));
    const b = fixedSource("selection", SOURCE_PRIORITIES.selection, frag("bbbb"));
    const c = fixedSource("git-diff", SOURCE_PRIORITIES["git-diff"], frag("cccc"));
    const one = await assemble({ draft: "d", qa: [{ question: "q", answer: "a" }] }, [a, b, c], { budget: 4, estimateTokens: fakeEstimate, redact: noRedact });
    const two = await assemble({ draft: "d", qa: [{ question: "q", answer: "a" }] }, [c, b, a], { budget: 4, estimateTokens: fakeEstimate, redact: noRedact });
    expect(two.fragments).toEqual(one.fragments);
    expect(two.manifest).toEqual(one.manifest);
  });

  it("redacts before estimating, so redaction can save the budget", async () => {
    const source = fixedSource("open-editors", SOURCE_PRIORITIES["open-editors"], {
      fragments: [{ source: "x", priority: 0, content: "KEY-abcdefghijklmnop", tokens: 5, provenance: { kind: "open-editor", truncated: false, chars: 20 } }],
    });
    const redact = (text: string) => ({ text: text.replaceAll("KEY-abcdefghijklmnop", "[redacted]"), count: text.includes("KEY-abcdefghijklmnop") ? 1 : 0 });
    // Raw 20 chars = 5 tokens would cross a budget of 4; redacted 10 chars = 3 tokens fits.
    const bundle = await assemble({ draft: "", qa: [] }, [source], { budget: 4, estimateTokens: fakeEstimate, redact });
    const entry = bundle.manifest.sources.find((s) => s.source === "open-editors");
    expect(entry?.included).toBe(true);
    expect(entry?.truncated).toBe(false);
    expect(entry?.tokens).toBe(3);
    expect(entry?.redactions).toBe(1);
  });

  it("omits every workspace source with budget when the draft and qa exactly fill the budget", async () => {
    const draft = "d".repeat(32); // 8 tokens
    const qa = [{ question: "q".repeat(16), answer: "a".repeat(16) }]; // 4 + 4 = 8 tokens
    const source = fixedSource("selection", SOURCE_PRIORITIES.selection, {
      fragments: [{ source: "x", priority: 0, content: "code", tokens: 1, provenance: { kind: "selection", truncated: false, chars: 4 } }],
    });
    const bundle = await assemble({ draft, qa }, [source], { budget: 16, estimateTokens: fakeEstimate, redact: noRedact });
    const entry = bundle.manifest.sources.find((s) => s.source === "selection");
    expect(entry?.included).toBe(false);
    expect(entry?.omittedReason).toBe("budget");
    expect(bundle.fragments).toHaveLength(0);
    expect(bundle.manifest.totalTokens).toBe(16);
    expect(bundle.manifest.totalTokens).toBe(bundle.manifest.budget);
  });

  it("handles the empty edges: no sources, empty draft and qa, empty content", async () => {
    const none = await assemble({ draft: "", qa: [] }, [], { budget: 0, estimateTokens: fakeEstimate, redact: noRedact });
    expect(none.manifest.totalTokens).toBe(0);
    expect(none.manifest.sources.map((s) => s.source)).toEqual(["draft", "qa"]);
    expect(none.manifest.sources[0].tokens).toBe(0);

    const emptyFrag = fixedSource("selection", 80, {
      fragments: [{ source: "x", priority: 0, content: "", tokens: 0, provenance: { kind: "selection", truncated: false, chars: 0 } }],
    });
    const withEmpty = await assemble({ draft: "", qa: [] }, [emptyFrag], { budget: 0, estimateTokens: fakeEstimate, redact: noRedact });
    expect(withEmpty.fragments).toHaveLength(0);
    const entry = withEmpty.manifest.sources.find((s) => s.source === "selection");
    expect(entry?.omittedReason).toBe("budget");
  });
});


import { describe, expect, it, vi } from "vitest";
import { analyzeRules, GatePolicy, isFreshScore, parseScore, SessionService, type ScoreReport } from "../src";
const draft = "Add a passing test in src/login.ts";
const report = (value = 25): ScoreReport => parseScore(JSON.stringify({ dimensions: { target: value, action: value, scope: value, done: value } }), draft,
  { provider: "stub", model: "quick", thinkingEffort: "low", scoredAt: "2026-11-18T00:00:00Z" })!;

describe("shared gate policy", () => {
  it.each([
    [false, null, "secret sk-1234567890abcdefghij [value]", "send"],
    [false, 5, draft, "send"],
    [true, null, draft, "confirm"],
    [true, 5, draft, "confirm"],
    [true, 25, draft, "send"],
    [true, 25, "Use sk-1234567890abcdefghij", "confirm"],
    [true, 25, "Use [value]", "confirm"],
    [true, 25, "Delete production database", "confirm"],
  ] as const)("enabled=%s value=%s %s => %s", (enabled, value, text, action) => {
    expect(GatePolicy.decide(analyzeRules(text), value === null ? null : report(value), { gateSending: enabled, threshold: 65 }).action).toBe(action);
  });
  it("uses normalized draft identity and the current rubric", () => {
    expect(isFreshScore(report(), `  ${draft}\r\n`)).toBe(true);
    expect(isFreshScore(report(), "changed")).toBe(false);
    expect(isFreshScore({ ...report(), rubricVersion: "old" }, draft)).toBe(false);
  });
  it("never refreshes or confirms by default", async () => {
    const quick = vi.fn();
    const result = await new SessionService(quick).prepare(draft, analyzeRules(draft), null, { gateSending: false, threshold: 65 });
    expect(quick).not.toHaveBeenCalled(); expect(result.decision.action).toBe("send");
  });
  it("refreshes stale scores and revalidates returned identity", async () => {
    const quick = vi.fn(async () => report());
    const service = new SessionService(quick);
    const result = await service.prepare(draft, analyzeRules(draft), { ...report(), rubricVersion: "old" }, { gateSending: true, threshold: 65 });
    expect(quick).toHaveBeenCalledOnce(); expect(result.decision.action).toBe("send");
    const wrong = new SessionService(async () => ({ ...report(), promptHash: "wrong" }));
    expect((await wrong.prepare(draft, analyzeRules(draft), null, { gateSending: true, threshold: 65 })).decision.action).toBe("confirm");
  });
  it("asks after failures and enforces a deadline even if the provider ignores abort", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const service = new SessionService(async (_text, s) => { signal = s; return new Promise(() => {}); });
      const pending = service.prepare(draft, analyzeRules(draft), null, { gateSending: true, threshold: 65 });
      await vi.advanceTimersByTimeAsync(8000);
      expect((await pending).decision.action).toBe("confirm"); expect(signal?.aborted).toBe(true);
      const failed = new SessionService(async () => { throw new Error("offline"); });
      expect((await failed.prepare(draft, analyzeRules(draft), null, { gateSending: true, threshold: 65 })).score).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("does not refresh a current score", async () => {
    const quick = vi.fn();
    await new SessionService(quick).prepare(draft, analyzeRules(draft), report(), { gateSending: true, threshold: 65 });
    expect(quick).not.toHaveBeenCalled();
  });
});

describe("advisory extension rules", () => {
  it("has no model score or trivial/skip execution mode", () => {
    for (const text of ["continue", "yes", "fix it [preflight:skip]"]) {
      const rules = analyzeRules(text);
      expect(rules.skipped).toBe(false); expect(rules).not.toHaveProperty("score"); expect(rules).not.toHaveProperty("level");
      expect(rules.findings.length).toBeGreaterThan(0);
    }
  });
  it("keeps secret warning offsets and still checks the rest of the prompt", () => {
    const text = "Improve it with sk-1234567890abcdefghij";
    const rules = analyzeRules(text);
    expect(rules.hardBlock).toBe(false);
    expect(rules.findings.find(f => f.rule === "secret")?.severity).toBe("warning");
    expect(rules.findings.some(f => f.rule === "vague-verb")).toBe(true);
  });
});

it("local-only gating never needs a model score", () => {
  expect(GatePolicy.decide(analyzeRules("Add a test in src/login.ts that expects a 200 status"), null, { gateSending: true, threshold: 65, scoreRequired: false }).action).toBe("send");
  expect(GatePolicy.decide(analyzeRules("Improve it"), null, { gateSending: true, threshold: 65, scoreRequired: false }).action).toBe("confirm");
});

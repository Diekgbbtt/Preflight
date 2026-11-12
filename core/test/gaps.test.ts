import { describe, expect, it } from "vitest";
import { analyze, combineGaps, modelGaps, parseReview, resolveQuote, ruleGaps, type Gap, type ModelGap } from "../src";

const rules = (p: string) => ruleGaps(p, analyze(p));

describe("ruleGaps", () => {
  it("turns findings into open rule gaps with stable ids", () => {
    const p = "Improve the app's performance.";
    const gaps = rules(p);
    const vague = gaps.find((g) => g.id === "rules:vague-verb:Improve:0")!;
    expect(vague).toMatchObject({ source: "rules", status: "open", category: "action", priority: "important", question: "Improve what?" });
    expect(vague.span).toEqual({ start: 0, end: 7, text: "Improve" });
    expect(vague.reason).toContain("can mean many things");
  });

  it("keeps ids when the edit is elsewhere in the prompt", () => {
    const ids = (p: string) => rules(p).map((g) => g.id).filter((id) => id.startsWith("rules:vague-verb"));
    expect(ids("Improve the app")).toEqual(ids("Please improve the app".replace("improve", "Improve")));
  });

  it("numbers repeated words by occurrence", () => {
    const ids = rules("Fix it and then fix it again").map((g) => g.id).filter((id) => id.startsWith("rules:unclear-reference"));
    expect(ids).toEqual(["rules:unclear-reference:it:0", "rules:unclear-reference:it:1"]);
  });

  it("maps missing dimensions to one gap each", () => {
    const ids = rules("Improve the app").map((g) => g.id);
    expect(ids).toContain("rules:missing-done");
    expect(rules("Improve the app").find((g) => g.id === "rules:missing-done")!.priority).toBe("important");
  });

  it("uses default priorities: privacy blocks, info advises", () => {
    const secret = rules("Use password=hunter2secret in src/db.ts and make the tests pass").find((g) => g.category === "privacy")!;
    expect(secret.priority).toBe("blocking");
    const info = ruleGaps("x", {
      level: "clear", score: 100, dimensions: { target: 25, action: 25, scope: 25, done: 25 }, questions: [], shouldClarify: false, skipped: false,
      findings: [{ rule: "weak-target", category: "target", severity: "info", message: "Name the exact file.", short: "Which file?" }],
    });
    expect(info[0]).toMatchObject({ id: "rules:missing-target", priority: "advisory" });
  });
});

describe("resolveQuote", () => {
  const p = "Make the dashboard load faster. The dashboard is slow on first load.";
  it("finds an exact, unique quote", () => {
    expect(resolveQuote(p, "first load")).toEqual({ start: p.indexOf("first load"), end: p.indexOf("first load") + 10, text: "first load" });
  });
  it("falls back to a case- and whitespace-insensitive match", () => {
    expect(resolveQuote(p, "slow  ON\nfirst")?.text).toBe("slow on first");
  });
  it("drops ambiguous quotes", () => {
    expect(resolveQuote(p, "dashboard")).toBeUndefined(); // two exact matches
    expect(resolveQuote(p, "THE DASHBOARD")).toBeUndefined(); // no exact match, two fuzzy ones
    expect(resolveQuote(p, "the dashboard")?.start).toBe(5); // a unique exact match wins over fuzzy ones
  });
  it("drops missing, empty and too-long quotes", () => {
    expect(resolveQuote(p, "settings page")).toBeUndefined();
    expect(resolveQuote(p, "  ")).toBeUndefined();
    expect(resolveQuote(p, undefined)).toBeUndefined();
    expect(resolveQuote(p, p.slice(0, 50))).toBeUndefined();
  });
});

describe("modelGaps", () => {
  const p = "Improve the app's performance.";
  const item = (m: Partial<ModelGap>): ModelGap => ({ question: "Which page?", reason: "The agent can't tell.", ...m });

  it("normalizes quick and deep output with revision ids", () => {
    const quick = modelGaps(p, [item({ category: "target", priority: "important", quote: "the app" })], "quick", 7);
    expect(quick[0]).toMatchObject({ id: "quick:7:0", source: "quick", status: "open", category: "target", priority: "important" });
    expect(quick[0].span?.text).toBe("the app");
    const deep = modelGaps(p, [item({}), item({ question: "Fast enough when?", suggestion: "under one second" })], "deep", 3);
    expect(deep.map((g) => g.id)).toEqual(["deep:3:0", "deep:3:1"]);
    expect(deep[1].suggestion).toBe("under one second");
  });

  it("only lets privacy block and falls back on unknown values", () => {
    const [a, b, c] = modelGaps(p, [
      item({ category: "scope", priority: "blocking" }),
      item({ category: "privacy", priority: "blocking" }),
      item({ category: "vibes", priority: "urgent" }),
    ], "quick", 1);
    expect(a.priority).toBe("important");
    expect(b.priority).toBe("blocking");
    expect(c).toMatchObject({ category: "clarity", priority: "advisory" });
  });
});

describe("combineGaps", () => {
  const g = (id: string, source: Gap["source"], text?: string, category: Gap["category"] = "action"): Gap => ({
    id, source, category, priority: "important", status: "open", question: "q", reason: "r",
    span: text ? { start: 0, end: text.length, text } : undefined,
  });

  it("keeps the first gap per id", () => {
    expect(combineGaps([g("rules:a", "rules"), g("rules:a", "rules")]).length).toBe(1);
  });

  it("prefers the rules gap on the same category and words", () => {
    const out = combineGaps([g("rules:v", "rules", "Improve")], [g("quick:1:0", "quick", "Improve")], [g("deep:1:0", "deep", "Improve", "scope")]);
    expect(out.map((x) => x.id)).toEqual(["rules:v", "deep:1:0"]);
  });

  it("keeps model gaps without a span", () => {
    expect(combineGaps([g("rules:v", "rules", "Improve")], [g("quick:1:0", "quick")]).length).toBe(2);
  });
});

describe("all three stages into one list", () => {
  const prompt = "Improve the app's performance.";
  const reply = (gaps: object[]) => ({ text: JSON.stringify({ gaps }), inputTokens: 0, outputTokens: 0, costUsd: 0 });

  it("combines rules, quick and deep output with rules winning on shared words", () => {
    const rulesOut = ruleGaps(prompt, analyze(prompt));
    const quick = parseReview("quick", reply([
      { category: "action", priority: "important", quote: "Improve", question: "Improve how?", reason: "Vague verb." },
      { category: "done", priority: "advisory", quote: "", question: "How fast?", reason: "No target time." },
    ]));
    const deep = parseReview("deep", reply([
      { category: "target", priority: "important", quote: "the APP", question: "Which screen?", reason: "The app has many screens.", suggestion: "the dashboard" },
    ]));
    const all = combineGaps(rulesOut, modelGaps(prompt, quick.gaps, "quick", 4), modelGaps(prompt, deep.gaps, "deep", 4));

    expect(all.filter((g) => g.span?.text === "Improve").map((g) => g.source)).toEqual(["rules"]);
    expect(all.find((g) => g.id === "quick:4:1")).toMatchObject({ category: "done", priority: "advisory", span: undefined });
    expect(all.find((g) => g.id === "deep:4:0")).toMatchObject({ span: { start: 8, end: 15, text: "the app" }, suggestion: "the dashboard" });
    expect(new Set(all.map((g) => g.id)).size).toBe(all.length);
    expect(all.every((g) => g.status === "open")).toBe(true);
  });
});

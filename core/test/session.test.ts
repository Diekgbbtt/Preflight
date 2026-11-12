import { describe, expect, it } from "vitest";
import {
  gapKey,
  isSettled,
  markGap,
  newSession,
  normalizeQuestion,
  normalizeText,
  questionOverlap,
  recordGaps,
  textHash,
  type Gap,
} from "../src";

const gap = (question: string, category: Gap["category"] = "target", source: Gap["source"] = "quick"): Gap => ({
  id: `${source}:1:0`, category, priority: "important", question, reason: "r", source, status: "open",
});

describe("keys and normalization", () => {
  it("keys gaps by category and normalized question", () => {
    expect(normalizeQuestion("  Which  PAGE, exactly?! ")).toBe("which page exactly");
    expect(gapKey(gap("Which page?"))).toBe(gapKey(gap("which   page")));
    expect(gapKey(gap("Which page?", "target"))).not.toBe(gapKey(gap("Which page?", "scope")));
  });

  it("treats whitespace and trailing punctuation as the same text", () => {
    expect(normalizeText("  Fix the  login bug.\n")).toBe("Fix the login bug");
    expect(textHash("Fix the login bug")).toBe(textHash("Fix  the login bug!"));
    expect(textHash("Fix the login bug")).not.toBe(textHash("Fix the signup bug"));
  });
});

describe("isSettled", () => {
  it("matches answered or dismissed questions in the same category by word overlap", () => {
    const s = newSession("s1", 0);
    markGap(s, gap("Which page should change?"), "answered", "the dashboard");
    expect(isSettled(s, gap("Which page?"))).toBe(true); // all of the shorter question's words
    expect(isSettled(s, gap("What page needs to change?"))).toBe(true);
    expect(isSettled(s, gap("Which page?", "scope"))).toBe(false); // other category
    expect(isSettled(s, gap("Which file should change?"))).toBe(false); // 1 of 2 words
  });

  it("ignores gaps that are only open", () => {
    const s = newSession("s1", 0);
    recordGaps(s, [gap("Which page?")], 1);
    expect(isSettled(s, gap("Which page?"))).toBe(false);
    markGap(s, gap("Which page?"), "dismissed");
    expect(isSettled(s, gap("Which page?"))).toBe(true);
  });

  it("keeps the first sighting and the answer", () => {
    const s = newSession("s1", 0);
    recordGaps(s, [gap("Which page?")], 2);
    recordGaps(s, [gap("which page")], 5);
    markGap(s, gap("Which page?"), "answered", "settings");
    expect([...s.gapHistory.values()]).toEqual([
      { category: "target", question: "Which page?", status: "answered", answer: "settings", firstSeenRevision: 2, source: "quick", priority: "important" },
    ]);
  });

  it("scores overlap on the shorter question, ignoring filler words", () => {
    expect(questionOverlap("Which page?", "Which page should change?")).toBe(1);
    expect(questionOverlap("How fast?", "When is it fast enough?")).toBe(1); // the short question is contained
    expect(questionOverlap("Which page and button?", "Which page and field?")).toBe(0.5);
    expect(questionOverlap("What?", "Which?")).toBe(0);
  });
});

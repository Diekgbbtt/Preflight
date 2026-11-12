import { describe, expect, it } from "vitest";
import {
  gapKey,
  isSettled,
  markGap,
  newSession,
  normalizeQuestion,
  normalizeText,
  editRegion,
  retainedShare,
  sessionChange,
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

describe("session boundaries", () => {
  const active = () => newSession("s", 0);
  const ended = (by: "send" | "copy") => ({ ...newSession("s", 0), endedBy: by });
  const prompt = "Fix the login bug in src/auth.ts so the tests pass";

  it("starts a session on the first text", () => {
    expect(sessionChange(undefined, "", "F")).toEqual({ end: undefined, start: true });
    expect(sessionChange(undefined, "", "   ")).toEqual({ end: undefined, start: false });
  });

  it("keeps the session for ordinary edits", () => {
    expect(sessionChange(active(), prompt, prompt + " now")).toEqual({ end: undefined, start: false });
    expect(sessionChange(active(), prompt, prompt.replace("login", "signup"))).toEqual({ end: undefined, start: false });
  });

  it("ends on clear, without starting a new one", () => {
    expect(sessionChange(active(), prompt, "")).toEqual({ end: "clear", start: false });
    expect(sessionChange(active(), prompt, " \n ")).toEqual({ end: "clear", start: false });
  });

  it("ends and restarts when one edit keeps under 30% of the text", () => {
    expect(sessionChange(active(), prompt, "Add dark mode to the settings page")).toEqual({ end: "replace", start: true });
    expect(retainedShare(prompt, "Fix the login bug")).toBeCloseTo(17 / prompt.length);
    expect(sessionChange(active(), prompt, prompt.slice(0, 20))).toEqual({ end: undefined, start: false }); // 20/51 kept
  });

  it("starts a new session on the next edit after send or copy, even when the text is reused", () => {
    expect(sessionChange(ended("send"), "", "F")).toEqual({ end: undefined, start: true });
    expect(sessionChange(ended("copy"), prompt, prompt.replace("login", "signup"))).toEqual({ end: undefined, start: true });
    expect(sessionChange(ended("copy"), prompt, "")).toEqual({ end: undefined, start: false });
  });

  it("finds the single edit between two texts", () => {
    expect(editRegion("the app is slow", "the dashboard is slow")).toEqual({ at: 4, removed: 3, inserted: 9 });
    expect(editRegion("same", "same")).toEqual({ at: 4, removed: 0, inserted: 0 });
  });
});

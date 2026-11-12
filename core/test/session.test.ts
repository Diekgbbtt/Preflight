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
  changedWords,
  shiftGaps,
  planReview,
  reviewedGaps,
  type Reviewed,
  sessionSummary,
  buildReviewRequest,
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

describe("small edits", () => {
  const before = "Make the dashboard load faster on first visit";

  it("counts changed words, including partly edited ones", () => {
    expect(changedWords(before, before)).toBe(0);
    expect(changedWords(before, before + " ")).toBe(1); // touches the last word only
    expect(changedWords(before, before.replace("dashboard", "dashbaord"))).toBe(1);
    expect(changedWords(before, before.replace("faster", "much faster"))).toBe(2);
    expect(changedWords(before, before.replace("on first visit", "after login for new users"))).toBe(5);
  });

  it("shifts spans after the edit and drops the ones it touched", () => {
    const g = (id: string, text: string): Gap => ({
      id, category: "target", priority: "important", source: "quick", status: "open", question: "q", reason: "r",
      span: { start: before.indexOf(text), end: before.indexOf(text) + text.length, text },
    });
    const gaps = [g("a", "Make"), g("b", "dashboard"), g("c", "first visit"), { ...g("d", "x"), span: undefined }];
    const after = before.replace("dashboard", "admin dashboard").replace("load", "loads");
    const out = shiftGaps(gaps, before, after);
    expect(out.map((x) => x.id)).toEqual(["a", "c", "d"]); // b sits inside the edited region
    const c = out.find((x) => x.id === "c")!.span!;
    expect(after.slice(c.start, c.end)).toBe("first visit");
  });
});

describe("planReview", () => {
  const text = "Make the dashboard load faster on first visit";
  const last: Reviewed = { text, revision: 3, gaps: [{ category: "done", priority: "important", quote: "faster", question: "How fast?", reason: "r" }] };

  it("keeps the last review for trivial and small edits", () => {
    const s = newSession("s", 0);
    expect(planReview(s, last, text + ".  ")).toEqual({ kind: "keep" });
    expect(planReview(s, last, text.replace("faster", "much faster"))).toEqual({ kind: "keep" });
  });

  it("reviews again after 3 or more changed words, or with no review yet", () => {
    const s = newSession("s", 0);
    expect(planReview(s, last, text.replace("on first visit", "after login for new users"))).toEqual({ kind: "review" });
    expect(planReview(s, undefined, text)).toEqual({ kind: "review" });
  });

  it("reuses a cached review of the same normalized text", () => {
    const s = newSession("s", 0);
    s.reviewCache.set(textHash(text), last.gaps);
    expect(planReview(s, undefined, `  ${text}!`)).toEqual({ kind: "cached", gaps: last.gaps });
  });

  it("shows kept gaps on the edited text with their spans moved", () => {
    const edited = "Please make the dashboard load faster on first visit";
    const [g] = reviewedGaps(last, edited, "quick");
    expect(g.id).toBe("quick:3:0");
    expect(edited.slice(g.span!.start, g.span!.end)).toBe("faster");
  });
});

describe("history in model requests", () => {
  it("summarizes answered and dismissed questions, not open ones", () => {
    const s = newSession("s", 0);
    recordGaps(s, [gap("Which test should pass?", "done")], 1);
    markGap(s, gap("Which page?"), "answered", "the dashboard");
    markGap(s, gap("Plan first?", "risk"), "dismissed");
    expect(sessionSummary(s)).toBe("- Which page? Answer: the dashboard\n- Plan first? (dismissed by the user)");
    expect(sessionSummary(undefined)).toBe("");
  });

  it("puts the summary and the no-re-asking rule into quick and deep requests", () => {
    for (const mode of ["quick", "deep"] as const) {
      const req = buildReviewRequest("Improve the app", mode, "m", { history: "- Which page? Answer: the dashboard" });
      expect(req.user).toContain("Already settled with the user");
      expect(req.user).toContain("Which page? Answer: the dashboard");
      expect(req.system).toContain("Never ask again");
      expect(buildReviewRequest("Improve the app", mode, "m").user).not.toContain("Already settled");
    }
  });
});

describe("settled gaps after a re-review", () => {
  it("does not show a model gap again once its question was answered or dismissed", () => {
    const s = newSession("s", 0);
    markGap(s, gap("Which page should change?", "target"), "answered", "the dashboard");
    markGap(s, gap("Done when?", "done", "rules"), "dismissed");
    const text = "Improve the dashboard load time";
    const rereview: Reviewed = {
      text, revision: 9, gaps: [
        { category: "target", priority: "important", quote: "dashboard", question: "Which page needs to change?", reason: "r" },
        { category: "done", priority: "important", quote: "", question: "When is it done?", reason: "r" },
        { category: "scope", priority: "important", quote: "", question: "Mobile too?", reason: "r" },
      ],
    };
    expect(reviewedGaps(rereview, text, "quick", s).map((g) => g.question)).toEqual(["Mobile too?"]);
    expect(reviewedGaps(rereview, text, "quick").length).toBe(3); // no session, no filter
  });
});

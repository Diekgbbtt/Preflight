import { describe, expect, it } from "vitest";
import { analyze, findPathRefs } from "../src";

describe("analyze", () => {
  it("returns ranges that point at the flagged words", () => {
    const text = "Please improve the app";
    const f = analyze(text).findings.find((f) => f.rule === "vague-verb")!;
    expect(text.slice(f.range!.start, f.range!.end)).toBe("improve");
  });

  it("flags paths that don't exist in the workspace", () => {
    const a = analyze("Fix the date bug in src/utils/date.ts so that tests pass", {
      fileExists: (p) => p !== "src/utils/date.ts",
    });
    expect(a.findings.map((f) => f.rule)).toContain("missing-file");
  });

  it("offers recently changed files as candidates", () => {
    const a = analyze("fix the bug", { recentFiles: ["src/a.ts", "src/b.ts"] });
    expect(a.questions.join(" ")).toContain("`src/a.ts`");
  });

  it("asks at most three questions", () => {
    expect(analyze("Improve everything and deploy to production").questions.length).toBeLessThanOrEqual(3);
  });

  it("does not ask questions for clear prompts", () => {
    expect(analyze("Rename getUser to fetchUser in src/api.ts").questions).toEqual([]);
  });

  it("scores 0-100 from four dimensions", () => {
    const a = analyze("Improve the app");
    const d = a.dimensions;
    expect(a.score).toBe(d.target + d.action + d.scope + d.done);
  });
});

describe("findPathRefs", () => {
  it("finds files and folders but not framework names", () => {
    const refs = findPathRefs("Move src/auth/jwt.ts and ./lib/ into /api/users, using Node.js and and/or logic").map((r) => r.text);
    expect(refs).toEqual(expect.arrayContaining(["src/auth/jwt.ts", "./lib/", "/api/users"]));
    expect(refs).not.toContain("Node.js");
    expect(refs).not.toContain("and/or");
  });
});

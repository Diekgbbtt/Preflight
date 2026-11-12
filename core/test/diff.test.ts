import { describe, expect, it } from "vitest";
import { addedRanges } from "../src";

const added = (a: string, b: string) => addedRanges(a, b).map((r) => b.slice(r.start, r.end));

describe("addedRanges", () => {
  it("marks the words that replaced the vague part", () => {
    expect(added("Improve the app’s performance.", "Improve the dashboard’s first load to under one second.")).toEqual([
      "dashboard’s first load to under one second",
    ]);
  });

  it("returns nothing for unchanged or deleted-only text", () => {
    expect(added("Rename foo to bar", "Rename foo to bar")).toEqual([]);
    expect(added("Rename foo to bar now", "Rename foo to bar")).toEqual([]);
  });

  it("keeps separate insertions apart", () => {
    expect(added("Fix the bug", "Fix the login bug in auth.ts")).toEqual(["login", "in auth.ts"]);
  });
});

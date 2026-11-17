import { describe, expect, it } from "vitest";
import { findPromptFileRefs } from "../src/promptFiles";

describe("findPromptFileRefs", () => {
  it("finds @ file references in the prompt order", () => {
    const refs = findPromptFileRefs("Fix @src/app.ts and @lib/util.ts, then run tests.");
    expect(refs.map((ref) => ref.text)).toEqual(["src/app.ts", "lib/util.ts"]);
    expect(refs[0]).toEqual({ text: "src/app.ts", start: 5, end: 15 });
  });

  it("accepts a bare file name, ./, ../, and backslashes", () => {
    const refs = findPromptFileRefs("@app.ts @./src/app.ts @../outside.ts @src\\win.ts");
    expect(refs.map((ref) => ref.text)).toEqual(["app.ts", "./src/app.ts", "../outside.ts", "src\\win.ts"]);
  });

  it("accepts quoted paths with spaces", () => {
    const refs = findPromptFileRefs('Update @"src/my file.ts" and @\'docs/read me.md\'.');
    expect(refs.map((ref) => ref.text)).toEqual(["src/my file.ts", "docs/read me.md"]);
  });

  it("strips trailing punctuation", () => {
    const refs = findPromptFileRefs("See @src/app.ts, @src/util.ts; and @src/x.ts!");
    expect(refs.map((ref) => ref.text)).toEqual(["src/app.ts", "src/util.ts", "src/x.ts"]);
  });

  it("deduplicates repeated references", () => {
    const refs = findPromptFileRefs("@src/app.ts then @src/app.ts again");
    expect(refs.map((ref) => ref.text)).toEqual(["src/app.ts"]);
  });

  it.each([
    ["email", "mail me at dev@example.com"],
    ["decorator", "@Component({ selector: 'app' })"],
    ["npm scope without an extension", "install @types/node"],
    ["bare path without @", "fix src/app.ts"],
    ["directory reference", "look at @src/components"],
    ["empty mention", "@ then a space"],
  ])("ignores %s", (_name, text) => {
    expect(findPromptFileRefs(text)).toEqual([]);
  });

  it("does not match an @ inside a word", () => {
    expect(findPromptFileRefs("foo@bar.ts")).toEqual([]);
  });

  it("requires a file extension in the final segment", () => {
    expect(findPromptFileRefs("@src/app")).toEqual([]);
    expect(findPromptFileRefs("@src/app.ts")).toHaveLength(1);
    expect(findPromptFileRefs("@README.md")).toHaveLength(1);
  });
});

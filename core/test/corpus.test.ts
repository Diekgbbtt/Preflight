import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyze } from "../src";

interface Case {
  id: string;
  prompt: string;
  should_clarify: boolean;
  expected_level?: string;
  expected_rules?: string[];
}

const cases: Case[] = readFileSync(join(__dirname, "corpus.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => JSON.parse(l));

describe("corpus", () => {
  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const a = analyze(c.prompt, { fileExists: (ref) => !ref.includes("missing") });
    const summary = { score: a.score, level: a.level, dims: a.dimensions, rules: a.findings.map((f) => f.rule) };
    expect(a.shouldClarify, JSON.stringify(summary)).toBe(c.should_clarify);
    if (c.expected_level) expect(a.level, JSON.stringify(summary)).toBe(c.expected_level);
    for (const r of c.expected_rules ?? []) expect(summary.rules, JSON.stringify(summary)).toContain(r);
  });
});

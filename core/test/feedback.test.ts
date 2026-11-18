import { expect, it } from "vitest";
import { analyzeRules, presentFeedback } from "../src";
it("shows one reference gap across notes and questions, preserving raw highlight ranges", () => {
  const rules = analyzeRules("Improve this and fix it");
  const before = JSON.stringify(rules);
  const result = presentFeedback(rules, { score: null, issues: [{ problem: 'What does this refer to?', suggestion: 'Name the file' }], questions: ['What exactly do you mean by it or this?'] });
  expect(result.findings.filter(f => f.rule === "unclear-reference")).toHaveLength(1);
  expect(result.questions.join(" ")).not.toMatch(/mean by|refer to/);
  expect(result.issues).toEqual([]);
  expect(JSON.stringify(rules)).toBe(before);
});
it("keeps unrelated safety and task gaps", () => {
  const rules = analyzeRules("Improve it [target] with sk-1234567890abcdefghij");
  const result = presentFeedback(rules);
  expect(result.findings.some(f => f.rule === "secret")).toBe(true);
  expect(result.findings.some(f => f.rule === "placeholder")).toBe(true);
});

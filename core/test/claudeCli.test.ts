import { describe, expect, it } from "vitest";
import { buildClaudeArgs } from "../src/claudeCli";
import type { ModelProfile } from "../src/model";

const request = { system: "You review prompts.", user: "<prompt>\nhi\n</prompt>", model: "sonnet" };

describe("buildClaudeArgs", () => {
  it.each(["low", "medium", "high"] as const)("maps effort %s to the --effort argument", (effort) => {
    const profile: ModelProfile = { provider: "claude", model: "sonnet", thinkingEffort: effort };
    expect(buildClaudeArgs(request, profile)).toEqual([
      "-p",
      "--model", "sonnet",
      "--effort", effort,
      "--output-format", "json",
      "--tools", "",
      "--setting-sources", "",
      "--system-prompt", "You review prompts.",
    ]);
  });

  it("does not put the user prompt in the args", () => {
    const profile: ModelProfile = { provider: "claude", model: "haiku", thinkingEffort: "low" };
    const args = buildClaudeArgs(request, profile).join(" ");
    expect(args).not.toContain("hi");
    expect(args).not.toContain("prompt>");
  });

  it("never adds --json-schema", () => {
    const profile: ModelProfile = { provider: "claude", model: "opus", thinkingEffort: "high" };
    expect(buildClaudeArgs(request, profile)).not.toContain("--json-schema");
  });
});

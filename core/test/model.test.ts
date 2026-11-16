import { describe, expect, it } from "vitest";
import { resolveProfile, type Config } from "../src/model";

const base: Config = {
  provider: "claude",
  model: "sonnet",
  thinkingEffort: "medium",
  quickModel: "haiku",
  deepModel: "sonnet",
  claudePath: "claude",
};

describe("resolveProfile", () => {
  it("resolves the defaults to explicit profiles", () => {
    expect(resolveProfile(base, "quick")).toEqual({ provider: "claude", model: "haiku", thinkingEffort: "medium" });
    expect(resolveProfile(base, "deep")).toEqual({ provider: "claude", model: "sonnet", thinkingEffort: "medium" });
  });

  it("prefers the mode override over the global model", () => {
    expect(resolveProfile({ ...base, quickModel: "haiku", model: "opus" }, "quick").model).toBe("haiku");
    expect(resolveProfile({ ...base, deepModel: "opus" }, "deep").model).toBe("opus");
  });

  it("falls back to the global model when the mode override is empty", () => {
    expect(resolveProfile({ ...base, quickModel: "" }, "quick").model).toBe("sonnet");
    expect(resolveProfile({ ...base, deepModel: "" }, "deep").model).toBe("sonnet");
  });

  it("falls back to the global model when the override is whitespace only", () => {
    expect(resolveProfile({ ...base, quickModel: "   " }, "quick").model).toBe("sonnet");
  });

  it("falls back to the mode default when both the override and the global model are empty", () => {
    const settings = { ...base, model: "", quickModel: "", deepModel: "" };
    expect(resolveProfile(settings, "quick").model).toBe("haiku");
    expect(resolveProfile(settings, "deep").model).toBe("sonnet");
  });

  it("falls back to the mode default when the global model is whitespace only", () => {
    const settings = { ...base, model: "  ", quickModel: "", deepModel: "" };
    expect(resolveProfile(settings, "quick").model).toBe("haiku");
  });

  it("passes the provider and thinking effort through untouched", () => {
    const profile = resolveProfile({ ...base, provider: "codex", thinkingEffort: "high" }, "deep");
    expect(profile.provider).toBe("codex");
    expect(profile.thinkingEffort).toBe("high");
  });

  it("resolves independently of any VS Code scope: two plain Config objects stay separate", () => {
    const user: Config = { ...base, thinkingEffort: "low" };
    const workspace: Config = { ...base, thinkingEffort: "high", deepModel: "opus" };
    expect(resolveProfile(user, "deep").thinkingEffort).toBe("low");
    expect(resolveProfile(workspace, "deep")).toEqual({ provider: "claude", model: "opus", thinkingEffort: "high" });
  });
});

import { describe, expect, it } from "vitest";
import { createProvider, resolveProfile, type Config, type ModelProfile } from "../src/model";

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

describe("createProvider", () => {
  const claudeProfile: ModelProfile = { provider: "claude", model: "sonnet", thinkingEffort: "medium" };
  const codexProfile: ModelProfile = { provider: "codex", model: "gpt-5", thinkingEffort: "high" };
  const config: Config = { ...base };

  it("binds a Claude profile to the Claude adapter", () => {
    const provider = createProvider(claudeProfile, config);
    expect(provider.capabilities).toEqual({
      structuredOutput: true,
      thinkingEffort: true,
      maxContextTokens: 200_000,
      cost: { inputPerMTok: 2, outputPerMTok: 10 },
      supportsInstructionFiles: true,
    });
  });

  it.each([
    ["claude-3-5-haiku-latest", { inputPerMTok: 0.1, outputPerMTok: 0.5 }],
    ["sonnet", { inputPerMTok: 2, outputPerMTok: 10 }],
    ["opus-4-5", { inputPerMTok: 4, outputPerMTok: 20 }],
    ["mystery-model", { inputPerMTok: 0, outputPerMTok: 0 }],
  ])("prices model %s from the capability matrix", (model, cost) => {
    const provider = createProvider({ provider: "claude", model, thinkingEffort: "medium" }, config);
    expect(provider.capabilities.cost).toEqual(cost);
  });

  it("binds a Codex profile to the stub with unknown capabilities", () => {
    const provider = createProvider(codexProfile, config);
    expect(provider.capabilities).toEqual({
      structuredOutput: false,
      thinkingEffort: false,
      maxContextTokens: 0,
      cost: { inputPerMTok: 0, outputPerMTok: 0 },
      supportsInstructionFiles: false,
    });
  });

  it("accepts a valid Claude profile and never rejects the default profile for its effort", () => {
    const provider = createProvider(claudeProfile, config);
    expect(provider.validateProfile(claudeProfile)).toEqual({ ok: true });
    expect(provider.validateProfile({ provider: "claude", model: "haiku", thinkingEffort: "high" })).toEqual({ ok: true });
  });

  it("rejects a profile whose provider is not claude", () => {
    const provider = createProvider(claudeProfile, config);
    const result = provider.validateProfile(codexProfile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("claude");
  });

  it("rejects an empty model without throwing", () => {
    const provider = createProvider(claudeProfile, config);
    const result = provider.validateProfile({ provider: "claude", model: "   ", thinkingEffort: "medium" });
    expect(result.ok).toBe(false);
  });

  it("rejects a thinking effort outside the enum", () => {
    const provider = createProvider(claudeProfile, config);
    const result = provider.validateProfile({
      provider: "claude",
      model: "sonnet",
      thinkingEffort: "urgent" as ModelProfile["thinkingEffort"],
    });
    expect(result.ok).toBe(false);
  });

  it("always rejects the Codex stub with a clear message", () => {
    const provider = createProvider(codexProfile, config);
    expect(provider.validateProfile(codexProfile)).toEqual({
      ok: false,
      message: "Codex provider is not implemented; use Claude.",
    });
  });

  it("rejects complete() on the Codex stub with the exact clear message", async () => {
    const provider = createProvider(codexProfile, config);
    await expect(provider.complete({ system: "s", user: "u", model: "gpt-5" })).rejects.toThrow(
      "Codex provider is not implemented; use Claude.",
    );
  });

  it("throws for an unknown provider at runtime", () => {
    expect(() => createProvider({ ...claudeProfile, provider: "openai" as ModelProfile["provider"] }, config)).toThrow(/Unknown model provider/);
  });
});

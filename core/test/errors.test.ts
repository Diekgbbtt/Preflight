import { describe, expect, it } from "vitest";
import {
  ACTION_LABELS,
  exceedsBudget,
  exceedsContext,
  feedbackLogMessage,
  feedbackMessage,
  isFeedbackError,
  isRetryable,
  mapError,
} from "../src/errors";
import type { FeedbackError } from "../src/errors";

/** A raw error with an errno-style code, the way node emits them. */
function raw(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

describe("mapError", () => {
  it.each([
    ["ENOENT missing binary", raw('Claude Code CLI not found at "/no/such/claude".', { code: "ENOENT" }), "provider-missing", "install-cli"],
    ["EACCES permission denied", raw("permission denied", { code: "EACCES" }), "provider-missing", "fix-permissions"],
    ["EPERM operation not permitted", raw("operation not permitted", { code: "EPERM" }), "provider-missing", "fix-permissions"],
    ["status 429", raw("Too Many Requests", { code: 429 }), "quota", "open-settings"],
    ["quota message", raw("quota exceeded for this month"), "quota", "open-settings"],
    ["rate limit message", raw("You have hit the rate limit"), "quota", "open-settings"],
    ["status 401", raw("Unauthorized", { code: 401 }), "auth-missing", "open-settings"],
    ["status 403", raw("Forbidden", { code: 403 }), "auth-missing", "open-settings"],
    ["auth message", raw("authentication required"), "auth-missing", "open-settings"],
    ["api key message", raw("invalid api key"), "auth-missing", "open-settings"],
    ["killed timeout", raw("Command failed", { killed: true, signal: "SIGTERM" }), "timeout", "retry"],
    ["timeout message", raw("Request timed out after 120000 ms"), "timeout", "retry"],
    ["JSON parse failure", new SyntaxError("Unexpected end of JSON input"), "invalid-response", "retry"],
    ["empty output", raw("empty output from the model"), "invalid-response", "retry"],
    ["unparsable result", raw("could not parse the model result"), "invalid-response", "retry"],
    ["context overflow", raw("prompt is too large: 210000 tokens > maximum context 200000"), "context-too-large", "reduce-context"],
    ["token limit", raw("request exceeds the token limit"), "context-too-large", "reduce-context"],
    ["unknown provider", raw('Unknown model provider: "codex". Use "claude" or "codex".'), "provider-missing", "open-settings"],
    ["codex stub message", raw("Codex provider is not implemented; use Claude."), "provider-missing", "open-settings"],
    ["generic nonzero exit", raw("boom", { code: 1 }), "unknown", "dismiss"],
    ["plain error", raw("something odd happened"), "unknown", "dismiss"],
    ["null", null, "unknown", "dismiss"],
    ["undefined", undefined, "unknown", "dismiss"],
    ["string", "nope", "unknown", "dismiss"],
    ["number", 42, "unknown", "dismiss"],
  ])("%s -> %s/%s", (_name, err, code, action) => {
    const mapped = mapError(err);
    expect(mapped.code).toBe(code);
    expect(mapped.action).toBe(action);
  });

  it("maps a caller AbortError to cancelled, not timeout", () => {
    const err = raw("This operation was aborted", { name: "AbortError", code: "ABORT_ERR" });
    const mapped = mapError(err);
    expect(mapped.code).toBe("cancelled");
    expect(mapped.action).toBe("dismiss");
    expect(mapped.retryable).toBe(false);
  });

  it("respects the provider's own cancelled rejection", () => {
    const mapped = mapError(raw("cancelled", { code: "cancelled" }));
    expect(mapped.code).toBe("cancelled");
  });

  it("does not infer auth from a generic nonzero exit", () => {
    const mapped = mapError(raw("boom", { code: 1 }));
    expect(mapped.code).toBe("unknown");
    expect(mapped.code).not.toBe("auth-missing");
  });

  it("puts auth before timeout when a message contains both", () => {
    const mapped = mapError(raw("unauthorized: session timed out"));
    expect(mapped.code).toBe("auth-missing");
  });

  it("returns an already mapped FeedbackError unchanged (same reference)", () => {
    const already: FeedbackError = {
      code: "quota",
      message: "The model provider quota is exhausted. Check your plan or try again later.",
      action: "open-settings",
      retryable: false,
    };
    expect(mapError(already)).toBe(already);
  });

  it("never leaks a raw message that contains a secret into message or cause", () => {
    const mapped = mapError(raw("failed with ghp_theSecretToken123"));
    expect(mapped.message).not.toContain("ghp_theSecretToken123");
    expect(mapped.cause).toBeUndefined();
  });

  it("omits cause for mapped raw errors", () => {
    const mapped = mapError(raw("boom", { code: 1 }));
    expect(mapped.cause).toBeUndefined();
  });

  it("keeps retryable false everywhere except timeout", () => {
    const err = raw("Request timed out after 120000 ms");
    expect(mapError(err).retryable).toBe(true);
    expect(mapError(raw("boom", { code: 1 })).retryable).toBe(false);
  });
});

const allErrors: FeedbackError[] = [
  raw("x", { code: "ENOENT" }), // provider-missing
  raw("x", { code: 401 }), // auth-missing
  raw("x", { code: 429 }), // quota
  raw("x", { killed: true }), // timeout
  new SyntaxError("x"), // invalid-response
  raw("maximum context 1000 tokens"), // context-too-large
  raw("x", { name: "AbortError" }), // cancelled
  raw("x"), // unknown
].map((e) => mapError(e));

describe("isFeedbackError", () => {
  it("accepts a mapped FeedbackError", () => {
    expect(isFeedbackError(mapError(null))).toBe(true);
    expect(isFeedbackError(allErrors[0])).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["plain Error", new Error("boom")],
    ["string", "quota"],
    ["partial object", { code: "quota" }],
    ["wrong code", { code: "nope", message: "m", action: "retry", retryable: false }],
  ])("rejects %s", (_name, value) => {
    expect(isFeedbackError(value)).toBe(false);
  });
});

describe("isRetryable", () => {
  it("covers all eight codes exactly once", () => {
    expect(new Set(allErrors.map((e) => e.code)).size).toBe(8);
  });

  it("is true only for timeout, false for the other seven", () => {
    const byCode = new Map(allErrors.map((e) => [e.code, e] as const));
    expect(isRetryable(byCode.get("timeout")!)).toBe(true);
    for (const code of [
      "provider-missing", "auth-missing", "quota",
      "invalid-response", "context-too-large", "cancelled", "unknown",
    ] as const) {
      expect(isRetryable(byCode.get(code)!)).toBe(false);
    }
  });
});

describe("feedbackMessage", () => {
  const EXPECTED: Record<string, string> = {
    "provider-missing": "The selected model provider is not available. Install its CLI or choose another provider in settings.",
    "auth-missing": "The model provider rejected the login. Sign in again or check your credentials.",
    quota: "The model provider quota is exhausted. Check your plan or try again later.",
    timeout: "The model provider did not answer in time.",
    "invalid-response": "The model provider returned an unreadable answer.",
    "context-too-large": "The context is too large for the selected model. Reduce the included code and try again.",
    cancelled: "The request was cancelled.",
    unknown: "Something went wrong while asking the model provider.",
  };

  it.each(allErrors.map((e) => [e.code, e]) as [string, FeedbackError][])(
    "returns the fixed sentence and action for %s",
    (code, error) => {
      const { message, action } = feedbackMessage(error);
      expect(message).toBe(EXPECTED[code]);
      expect(action).toBe(error.action);
    },
  );

  it("never includes raw stderr in any fixed message", () => {
    for (const error of allErrors) {
      expect(feedbackMessage(error).message).not.toMatch(/stderr|boom|at /);
    }
  });
});

describe("ACTION_LABELS", () => {
  it("labels each action", () => {
    expect(ACTION_LABELS).toEqual({
      "open-settings": "Open Settings",
      "install-cli": "Install CLI",
      "fix-permissions": "Fix Permissions",
      retry: "Retry",
      "reduce-context": "Reduce Context",
      dismiss: "Dismiss",
    });
  });
});

describe("feedbackLogMessage", () => {
  it("contains only the correlation id and the code", () => {
    const error: FeedbackError = {
      code: "quota",
      message: "The model provider quota is exhausted. Check your plan or try again later.",
      action: "open-settings",
      retryable: false,
      cause: "internal detail",
    };
    expect(feedbackLogMessage(error, "abc-123")).toBe("[prompt-preflight] abc-123 quota");
  });

  it("never contains the message or cause", () => {
    const error = mapError(raw("boom", { code: 1 }));
    const line = feedbackLogMessage(error, "id-1");
    expect(line).not.toContain("boom");
    expect(line).not.toContain("Something went wrong");
  });
});

describe("exceedsContext", () => {
  it.each([
    ["exactly at the limit", 100, 100, false],
    ["one token over", 101, 100, true],
    ["unknown window, zero max", 999999, 0, false],
    ["unknown window, negative max", 999999, -5, false],
  ])("%s returns %j", (_name, totalTokens, max, expected) => {
    expect(exceedsContext(totalTokens, max)).toBe(expected);
  });
});

describe("exceedsBudget", () => {
  it("allows exactly at the budget and fails one over", () => {
    expect(exceedsBudget(100, 100)).toBe(false);
    expect(exceedsBudget(101, 100)).toBe(true);
    expect(exceedsBudget(50, 100)).toBe(false);
  });
});

import { checkHealth, type HealthExecutor } from "../src/errors";
import { createProvider, type ModelProvider as Provider } from "../src/model";

const config = {
  provider: "claude" as const,
  model: "sonnet",
  thinkingEffort: "medium" as const,
  quickModel: "haiku",
  deepModel: "sonnet",
  claudePath: "claude",
};
const profile = { provider: "claude" as const, model: "sonnet", thinkingEffort: "medium" as const };
const provider: Provider = createProvider(profile, config);

function execResult(err: Error | null): { exec: HealthExecutor; calls: Array<{ command: string; args: string[]; timeout: number }> } {
  const calls: Array<{ command: string; args: string[]; timeout: number }> = [];
  return {
    calls,
    exec: (command, args, options, callback) => {
      calls.push({ command, args, timeout: options.timeout });
      callback(err);
    },
  };
}

describe("checkHealth", () => {
  it("returns ok for a valid profile and a working CLI", async () => {
    const { exec, calls } = execResult(null);
    const result = await checkHealth(provider, profile, "/bin/claude", exec);
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ command: "/bin/claude", args: ["--version"], timeout: 2000 }]);
  });

  it("fails fast with provider-missing for the codex stub and never spawns", async () => {
    const { exec, calls } = execResult(null);
    const codexProfile = { provider: "codex" as const, model: "gpt", thinkingEffort: "low" as const };
    const codexProvider = createProvider(codexProfile, config);
    const result = await checkHealth(codexProvider, codexProfile, "claude", exec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("provider-missing");
      expect(result.error.action).toBe("open-settings");
      expect(result.error.cause).toBe("Codex provider is not implemented; use Claude.");
    }
    expect(calls).toEqual([]);
  });

  it("fails fast with provider-missing when the profile does not match the provider and never spawns", async () => {
    const { exec, calls } = execResult(null);
    const codexProfile = { provider: "codex" as const, model: "gpt", thinkingEffort: "low" as const };
    const result = await checkHealth(provider, codexProfile, "claude", exec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("provider-missing");
      expect(result.error.cause).toBe('Provider "codex" is not claude; the Claude adapter only accepts claude profiles.');
    }
    expect(calls).toEqual([]);
  });

  it("maps a permission-denied CLI probe to provider-missing with fix-permissions", async () => {
    const { exec } = execResult(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    const result = await checkHealth(provider, profile, "claude", exec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("provider-missing");
      expect(result.error.action).toBe("fix-permissions");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("maps a missing CLI to provider-missing with install-cli", async () => {
    const { exec } = execResult(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    const result = await checkHealth(provider, profile, "claude", exec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("provider-missing");
      expect(result.error.action).toBe("install-cli");
    }
  });

  it("maps a killed CLI probe to a retryable timeout", async () => {
    const { exec } = execResult(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }));
    const result = await checkHealth(provider, profile, "claude", exec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("timeout");
      expect(result.error.action).toBe("retry");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("catches a synchronous executor throw", async () => {
    const exec: HealthExecutor = () => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    };
    const result = await checkHealth(provider, profile, "claude", exec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provider-missing");
  });

  it("catches a throwing validateProfile without spawning", async () => {
    const { exec, calls } = execResult(null);
    const throwing: Provider = {
      capabilities: provider.capabilities,
      validateProfile: () => {
        throw new Error("validator exploded");
      },
      complete: provider.complete,
    };
    const result = await checkHealth(throwing as Provider, profile, "claude", exec);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

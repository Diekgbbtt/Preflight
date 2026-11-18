import { describe, expect, it, vi } from "vitest";
import type { ExecFileException } from "node:child_process";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: spawn }));
import { createClaudeProvider } from "../src/claudeCli";
import { isRetryable, mapError } from "../src/errors";

describe("CLI failure classification through the provider", () => {
  it.each([
    { killed: true, signal: "SIGTERM", stderr: "", expected: "timeout", retry: true },
    { killed: true, signal: "SIGTERM", stderr: "authentication failed", expected: "auth-missing", retry: false },
    { killed: false, signal: undefined, stderr: "ordinary failure", expected: "unknown", retry: false },
  ] as const)("maps killed=$killed and stderr=$stderr to $expected", async ({ killed, signal, stderr, expected, retry }) => {
    spawn.mockImplementation((_command, _args, _options, callback) => {
      const error: ExecFileException = Object.assign(new Error("Command failed: fake-claude"), { killed, signal });
      queueMicrotask(() => callback(error, "", stderr));
      return { stdin: { end() {} } };
    });
    const provider = createClaudeProvider(
      { provider: "claude", model: "sonnet", thinkingEffort: "medium" }, { claudePath: "fake-claude" },
    );
    const error = await provider.complete({ system: "review", user: "draft", model: "sonnet" }).catch((error) => error);
    const mapped = mapError(error);
    expect(mapped.code).toBe(expected);
    expect(isRetryable(mapped)).toBe(retry);
  });
});

import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildClaudeArgs, claudeCliRunner, createClaudeProvider, parseCliOutput } from "../src/claudeCli";
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

// Fake CLI harness: a tiny node script that reads stdin and prints JSON.
// No real CLI and no network in tests.
const FAKE_DIR = path.join(os.tmpdir(), "prompt-preflight-fake-cli");

afterAll(() => {
  fs.rmSync(FAKE_DIR, { recursive: true, force: true });
});

function makeCli(script: string): string {
  fs.mkdirSync(FAKE_DIR, { recursive: true });
  const cliPath = path.join(FAKE_DIR, `fake-claude-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(cliPath, `#!/usr/bin/env node\n${script}`);
  fs.chmodSync(cliPath, 0o755);
  return cliPath;
}

function removeCli(cliPath: string): void {
  fs.rmSync(cliPath, { force: true });
}

const OK_JSON = JSON.stringify({
  result: '{"verdict":"ready"}',
  usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 5 },
  total_cost_usd: 0.01,
});

const ECHO_STDIN_OK = `const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
if (process.env.MARKER) fs.writeFileSync(process.env.MARKER, input);
process.stdout.write(${JSON.stringify(OK_JSON)});`;

function expectCancelled(err: unknown): void {
  const e = err as Error & { code?: string };
  expect(e.message).toBe("cancelled");
  expect(e.code).toBe("cancelled");
}

/** Awaits rejection so the caught error can be asserted field by field. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected the promise to reject");
  } catch (err) {
    if ((err as Error).message === "expected the promise to reject") throw err;
    return err;
  }
}

describe("claude provider complete", () => {
  const profile: ModelProfile = { provider: "claude", model: "sonnet", thinkingEffort: "medium" };

  it("resolves the parsed ModelResponse and sends the user prompt on stdin", async () => {
    const marker = path.join(FAKE_DIR, "marker-success");
    fs.rmSync(marker, { force: true });
    const cliPath = makeCli(ECHO_STDIN_OK);
    process.env.MARKER = marker;
    try {
      const res = await createClaudeProvider(profile, { claudePath: cliPath }).complete(request);
      expect(res).toEqual({ text: '{"verdict":"ready"}', inputTokens: 8, outputTokens: 2, costUsd: 0.01 });
      expect(fs.readFileSync(marker, "utf8")).toBe(request.user);
    } finally {
      delete process.env.MARKER;
      removeCli(cliPath);
      fs.rmSync(marker, { force: true });
    }
  });

  it("succeeds when the CLI exits 0 with a stderr warning", async () => {
    const cliPath = makeCli(`process.stderr.write("deprecation warning\\n");
process.stdout.write(${JSON.stringify(OK_JSON)});`);
    try {
      const res = await createClaudeProvider(profile, { claudePath: cliPath }).complete(request);
      expect(res.text).toBe('{"verdict":"ready"}');
    } finally {
      removeCli(cliPath);
    }
  });

  it("rejects with the stderr text and the exit code on a nonzero exit", async () => {
    const cliPath = makeCli(`process.stderr.write("boom\\n");
process.exit(1);`);
    try {
      await expect(createClaudeProvider(profile, { claudePath: cliPath }).complete(request)).rejects.toMatchObject({
        message: "boom",
        code: 1,
      });
    } finally {
      removeCli(cliPath);
    }
  });

  it("rejects on invalid JSON output without crashing", async () => {
    const cliPath = makeCli(`process.stdout.write("not json");`);
    try {
      await expect(createClaudeProvider(profile, { claudePath: cliPath }).complete(request)).rejects.toBeInstanceOf(Error);
    } finally {
      removeCli(cliPath);
    }
  });

  it("rejects on empty output without crashing", async () => {
    const cliPath = makeCli(`process.exit(0);`);
    try {
      await expect(createClaudeProvider(profile, { claudePath: cliPath }).complete(request)).rejects.toBeInstanceOf(Error);
    } finally {
      removeCli(cliPath);
    }
  });

  it("returns zero tokens and cost when usage and total_cost_usd are missing", async () => {
    const cliPath = makeCli(`process.stdout.write(JSON.stringify({ result: "ok" }));`);
    try {
      const res = await createClaudeProvider(profile, { claudePath: cliPath }).complete(request);
      expect(res).toEqual({ text: "ok", inputTokens: 0, outputTokens: 0, costUsd: 0 });
    } finally {
      removeCli(cliPath);
    }
  });

  it("rejects a request whose model differs from the profile model without spawning", async () => {
    const marker = path.join(FAKE_DIR, "marker-mismatch");
    fs.rmSync(marker, { force: true });
    const cliPath = makeCli(ECHO_STDIN_OK);
    process.env.MARKER = marker;
    try {
      await expect(
        createClaudeProvider(profile, { claudePath: cliPath }).complete({ ...request, model: "haiku" }),
      ).rejects.toThrow(/does not match/);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      delete process.env.MARKER;
      removeCli(cliPath);
    }
  });

  it("rejects cancelled without spawning when the signal is already aborted", async () => {
    const marker = path.join(FAKE_DIR, "marker-pre-abort");
    fs.rmSync(marker, { force: true });
    const cliPath = makeCli(ECHO_STDIN_OK);
    process.env.MARKER = marker;
    try {
      const controller = new AbortController();
      controller.abort();
      const err = await rejectionOf(
        createClaudeProvider(profile, { claudePath: cliPath }).complete(request, controller.signal),
      );
      expectCancelled(err);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      delete process.env.MARKER;
      removeCli(cliPath);
    }
  });

  it("rejects cancelled when the signal aborts during the spawn", async () => {
    const marker = path.join(FAKE_DIR, "marker-mid-abort");
    fs.rmSync(marker, { force: true });
    const cliPath = makeCli(`const fs = require("fs");
fs.writeFileSync(process.env.MARKER, "started");
fs.readFileSync(0, "utf8");
setTimeout(() => {
  fs.writeFileSync(process.env.MARKER + "-done", "done");
  process.stdout.write(${JSON.stringify(OK_JSON)});
}, 5000);`);
    process.env.MARKER = marker;
    const controller = new AbortController();
    try {
      const pending = createClaudeProvider(profile, { claudePath: cliPath }).complete(request, controller.signal);
      const deadline = Date.now() + 2000;
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(fs.existsSync(marker)).toBe(true);
      controller.abort();
      expectCancelled(await rejectionOf(pending));
      expect(fs.existsSync(marker + "-done")).toBe(false);
    } finally {
      delete process.env.MARKER;
      controller.abort();
      removeCli(cliPath);
      fs.rmSync(marker, { force: true });
    }
  });
});

describe("parseCliOutput", () => {
  it("parses result, token sums including cache tokens, and cost", () => {
    const stdout = JSON.stringify({
      result: "ok",
      usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 4, cache_read_input_tokens: 5 },
      total_cost_usd: 0.02,
    });
    expect(parseCliOutput(stdout)).toEqual({ text: "ok", inputTokens: 12, outputTokens: 2, costUsd: 0.02 });
  });

  it("defaults missing usage and cost to zeros", () => {
    expect(parseCliOutput(JSON.stringify({ result: "ok" }))).toEqual({
      text: "ok", inputTokens: 0, outputTokens: 0, costUsd: 0,
    });
    expect(parseCliOutput(JSON.stringify({ result: "ok", usage: { output_tokens: 7 } }))).toEqual({
      text: "ok", inputTokens: 0, outputTokens: 7, costUsd: 0,
    });
  });

  it("throws on is_error and on invalid JSON", () => {
    expect(() => parseCliOutput(JSON.stringify({ result: "bad", is_error: true }))).toThrow("bad");
    expect(() => parseCliOutput("not json")).toThrow();
    expect(() => parseCliOutput("")).toThrow();
  });
});

describe("claudeCliRunner legacy path", () => {
  it("spawns the CLI with --effort medium and resolves the response", async () => {
    const marker = path.join(FAKE_DIR, "marker-legacy");
    fs.rmSync(marker, { force: true });
    const cliPath = makeCli(`const fs = require("fs");
fs.writeFileSync(process.env.MARKER, JSON.stringify(process.argv.slice(2)));
fs.readFileSync(0, "utf8");
process.stdout.write(${JSON.stringify(OK_JSON)});`);
    process.env.MARKER = marker;
    try {
      const res = await claudeCliRunner(cliPath)(request);
      expect(res).toEqual({ text: '{"verdict":"ready"}', inputTokens: 8, outputTokens: 2, costUsd: 0.01 });
      const args = JSON.parse(fs.readFileSync(marker, "utf8")) as string[];
      expect(args).toContain("--effort");
      expect(args[args.indexOf("--effort") + 1]).toBe("medium");
      expect(args).toContain("sonnet");
      expect(args).toContain("--setting-sources");
    } finally {
      delete process.env.MARKER;
      removeCli(cliPath);
      fs.rmSync(marker, { force: true });
    }
  });
});

describe("claude provider missing CLI", () => {
  it("rejects with the install hint for a missing CLI path", async () => {
    const profile: ModelProfile = { provider: "claude", model: "sonnet", thinkingEffort: "medium" };
    const err = await rejectionOf(
      createClaudeProvider(profile, { claudePath: "/no/such/claude" }).complete(request),
    ) as Error & { code?: string };
    expect(err.code).toBe("ENOENT");
    expect(err.message).toBe(
      'Claude Code CLI not found at "/no/such/claude". Install it or set promptPreflight.claudePath.',
    );
  });
});

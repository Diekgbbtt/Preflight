import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildClaudeArgs, claudeCliRunner, createClaudeProvider, neutralizeMentions, parseCliOutput } from "../src/claudeCli";
import type { ModelProfile } from "../src/model";
import type { LlmTrace } from "../src/observability";

const request = { system: "You review prompts.", user: "<prompt>\nhi\n</prompt>", model: "sonnet" };

describe("buildClaudeArgs", () => {
  it.each(["low", "medium", "high", "xhigh", "max", "provider-native"] as const)("maps effort %s to the --effort argument", (effort) => {
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

describe("neutralizeMentions", () => {
  it("leaves text without @ unchanged", () => {
    expect(neutralizeMentions("plain draft, no mentions")).toBe("plain draft, no mentions");
  });

  it("inserts exactly one zero-width space after every @", () => {
    expect(neutralizeMentions("a@b@c")).toBe("a@\u200bb@\u200bc");
  });

  it("neutralizes emails, a trailing @, tilde paths, and absolute paths", () => {
    expect(neutralizeMentions("user@example.com")).toBe("user@\u200bexample.com");
    expect(neutralizeMentions("ends with @")).toBe("ends with @\u200b");
    expect(neutralizeMentions("@~/.ssh/config")).toBe("@\u200b~/.ssh/config");
    expect(neutralizeMentions("@/etc/hosts")).toBe("@\u200b/etc/hosts");
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

interface RecordedTrace {
  name: string;
  args: unknown[];
}

function recordingTrace(): { trace: LlmTrace; events: RecordedTrace[] } {
  const events: RecordedTrace[] = [];
  const record = (name: string) => (...args: unknown[]) => {
    events.push({ name, args });
  };
  return {
    events,
    trace: {
      request: record("request"),
      process: record("process"),
      stdin: record("stdin"),
      stdout: record("stdout"),
      stderr: record("stderr"),
      response: record("response"),
      error: record("error"),
    },
  };
}

describe("claude provider complete", () => {
  const profile: ModelProfile = { provider: "claude", model: "sonnet", thinkingEffort: "medium" };

  it("resolves the parsed ModelResponse and leaves a draft without @ byte-identical on stdin", async () => {
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

  it("writes a stdin payload whose @ mentions are neutralized and leaves the request untouched", async () => {
    const marker = path.join(FAKE_DIR, "marker-neutralized");
    fs.rmSync(marker, { force: true });
    const cliPath = makeCli(ECHO_STDIN_OK);
    process.env.MARKER = marker;
    const mentionRequest = {
      system: "You review prompts.",
      user: "Check @probe.ts and @.env before @/etc/hosts and @~/.ssh/config.",
      model: "sonnet",
    };
    const snapshot = { ...mentionRequest };
    try {
      await createClaudeProvider(profile, { claudePath: cliPath }).complete(mentionRequest);
      const stdin = fs.readFileSync(marker, "utf8");
      // No unneutralized @ may reach the CLI: every @ is followed by U+200B,
      // so the CLI mention parser finds no mention (issue #56, ADR 0001).
      expect(stdin).not.toMatch(/@(?!\u200b)/);
      expect(stdin).toBe(
        "Check @\u200bprobe.ts and @\u200b.env before @\u200b/etc/hosts and @\u200b~/.ssh/config.",
      );
      // The caller's request object is unchanged: the UI draft, the stored
      // draft, and the prompt hash keep the original text.
      expect(mentionRequest).toEqual(snapshot);
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

  it("spawns the CLI in a fresh empty temporary directory", async () => {
    const marker = path.join(FAKE_DIR, "marker-spawn-cwd");
    fs.rmSync(marker, { force: true });
    const cliPath = makeCli(`const fs = require("fs");
fs.writeFileSync(process.env.MARKER, JSON.stringify({ cwd: process.cwd(), entries: fs.readdirSync(".") }));
fs.readFileSync(0, "utf8");
process.stdout.write(${JSON.stringify(OK_JSON)});`);
    process.env.MARKER = marker;
    try {
      // FAKE_DIR holds the fake CLI scripts, so the child must not see it.
      await claudeCliRunner(cliPath, FAKE_DIR)(request);
      const rec = JSON.parse(fs.readFileSync(marker, "utf8")) as { cwd: string; entries: string[] };
      expect(rec.cwd).not.toBe(FAKE_DIR);
      expect(rec.cwd).not.toBe(process.cwd());
      // The child resolves symlinks, so compare against the real tmp path.
      expect(rec.cwd.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
      expect(rec.entries).toEqual([]);
    } finally {
      delete process.env.MARKER;
      removeCli(cliPath);
      fs.rmSync(marker, { force: true });
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

  it("passes the optional third parameter as --effort high", async () => {
    const marker = path.join(FAKE_DIR, "marker-legacy-high");
    fs.rmSync(marker, { force: true });
    const cliPath = makeCli(`const fs = require("fs");
fs.writeFileSync(process.env.MARKER, JSON.stringify(process.argv.slice(2)));
fs.readFileSync(0, "utf8");
process.stdout.write(${JSON.stringify(OK_JSON)});`);
    process.env.MARKER = marker;
    try {
      await claudeCliRunner(cliPath, undefined, "high")(request);
      const args = JSON.parse(fs.readFileSync(marker, "utf8")) as string[];
      expect(args).toContain("--effort");
      expect(args[args.indexOf("--effort") + 1]).toBe("high");
    } finally {
      delete process.env.MARKER;
      removeCli(cliPath);
      fs.rmSync(marker, { force: true });
    }
  });

  it("resolves a relative claudePath against the caller cwd", async () => {
    const cliPath = makeCli(`const fs = require("fs");
fs.readFileSync(0, "utf8");
process.stdout.write(${JSON.stringify(OK_JSON)});`);
    try {
      // Node used to resolve a relative claudePath against opts.cwd; the
      // spawn cwd is now a temp dir, so the adapter must resolve it itself
      // against the caller cwd (issue #56, ADR 0002).
      const res = await claudeCliRunner("./" + path.basename(cliPath), FAKE_DIR)(request);
      expect(res.text).toBe('{"verdict":"ready"}');
    } finally {
      removeCli(cliPath);
    }
  });

  it("records request, process, stdin, stdout and response on success", async () => {
    const cliPath = makeCli(`const fs = require("fs");
fs.readFileSync(0, "utf8");
process.stdout.write(${JSON.stringify(OK_JSON)});`);
    const { trace, events } = recordingTrace();
    try {
      await claudeCliRunner(cliPath, undefined, "medium", trace)(request);
      expect(events.map((event) => event.name)).toEqual(["request", "process", "stdin", "stdout", "response"]);
      expect(events[0].args[0]).toEqual(request);
      expect(events[0].args[1]).toMatchObject({ provider: "claude", model: "sonnet", thinkingEffort: "medium" });
      const args = events[1].args[0] as string[];
      expect(args).toContain("--effort");
      expect(args[args.indexOf("--effort") + 1]).toBe("medium");
      // The spawn cwd is a fresh empty temp directory, never the workspace.
      expect(typeof events[1].args[1]).toBe("string");
      expect(events[1].args[1] as string).not.toBe(process.cwd());
      expect(typeof events[1].args[2]).toBe("number");
      expect(events[2].args[0]).toBe(request.user);
      expect(events[3].args[0]).toBe(OK_JSON);
      expect(events[4].args[0]).toEqual({ text: '{"verdict":"ready"}', inputTokens: 8, outputTokens: 2, costUsd: 0.01 });
      expect(events[4].args[1]).toBeGreaterThanOrEqual(0);
    } finally {
      removeCli(cliPath);
    }
  });

  it("removes the temporary spawn directory after the call settles", async () => {
    const cliPath = makeCli(`process.stdout.write(${JSON.stringify(OK_JSON)});`);
    const failingCli = makeCli(`process.stderr.write("boom\\n"); process.exit(1);`);
    const { trace, events } = recordingTrace();
    try {
      await claudeCliRunner(cliPath, undefined, "medium", trace)(request);
      const okCwd = events.find((e) => e.name === "process")!.args[1] as string;
      expect(fs.existsSync(okCwd)).toBe(false);
      await expect(claudeCliRunner(failingCli, undefined, "medium", trace)(request)).rejects.toMatchObject({
        message: "boom",
      });
      const failCwd = events.filter((e) => e.name === "process")[1].args[1] as string;
      expect(fs.existsSync(failCwd)).toBe(false);
    } finally {
      removeCli(cliPath);
      removeCli(failingCli);
    }
  });

  it("records the neutralized payload on the stdin trace event and the original on request", async () => {
    const cliPath = makeCli(`const fs = require("fs");
fs.readFileSync(0, "utf8");
process.stdout.write(${JSON.stringify(OK_JSON)});`);
    const { trace, events } = recordingTrace();
    const mentionRequest = { system: "You review prompts.", user: "Check @.env.", model: "sonnet" };
    try {
      await claudeCliRunner(cliPath, undefined, "medium", trace)(mentionRequest);
      // The stdin event is what the CLI receives; the request event is what
      // the user wrote.
      expect(events[0].args[0]).toEqual(mentionRequest);
      expect(events.find((e) => e.name === "stdin")!.args[0]).toBe("Check @\u200b.env.");
    } finally {
      removeCli(cliPath);
    }
  });

  it("records stderr and error facts on a nonzero exit", async () => {
    const cliPath = makeCli(`process.stderr.write("boom\\n");
process.exit(1);`);
    const { trace, events } = recordingTrace();
    try {
      await expect(claudeCliRunner(cliPath, undefined, "medium", trace)(request)).rejects.toMatchObject({
        message: "boom",
      });
      expect(events.map((event) => event.name)).toContain("stderr");
      const errorEvent = events.find((event) => event.name === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.args[0]).toMatchObject({ message: "boom" });
      expect(errorEvent!.args[2]).toMatchObject({ exitCode: 1 });
    } finally {
      removeCli(cliPath);
    }
  });

  it("records a missing CLI error", async () => {
    const { trace, events } = recordingTrace();
    await expect(claudeCliRunner("/no/such/claude", undefined, "medium", trace)(request)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const errorEvent = events.find((event) => event.name === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.args[2]).toMatchObject({ exitCode: "ENOENT" });
  });

  it("records an already-aborted call", async () => {
    const controller = new AbortController();
    controller.abort();
    const { trace, events } = recordingTrace();
    await expect(
      claudeCliRunner("claude", undefined, "medium", trace)(request, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "error",
      args: [expect.objectContaining({ code: "cancelled" }), 0, { aborted: true }],
    });
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

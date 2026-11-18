import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProfile, ModelRequest } from "@prompt-preflight/core";
import type { LogChannel } from "../src/debug/channel";
import { OtelDebugTrace } from "../src/debug/trace";

const dirs: string[] = [];
const profile: ModelProfile = { provider: "claude", model: "sonnet", thinkingEffort: "medium" };
const request: ModelRequest = { system: "You review prompts.", user: "Fix the login bug.", model: "sonnet" };

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-debug-trace-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

class FakeChannel implements LogChannel {
  readonly lines: Array<{ level: keyof LogChannel; message: string }> = [];

  debug(message: string): void {
    this.lines.push({ level: "debug", message });
  }

  info(message: string): void {
    this.lines.push({ level: "info", message });
  }

  warn(message: string): void {
    this.lines.push({ level: "warn", message });
  }

  error(message: string): void {
    this.lines.push({ level: "error", message });
  }
}

function createTrace(dir: string, channel: FakeChannel): OtelDebugTrace {
  return OtelDebugTrace.create({
    dir,
    channel,
    resourceAttributes: {
      "service.name": "prompt-preflight",
      "service.version": "0.1.0",
      "vscode.version": "1.90.0",
      "process.pid": process.pid,
    },
    sessionAttributes: {
      "prompt_preflight.workspace_roots": "file:///work",
      "prompt_preflight.debug_log_dir": dir,
    },
    version: "0.1.0",
  });
}

async function readRecords(dir: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(path.join(dir, "llm-trace.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("OtelDebugTrace", () => {
  it("writes correlated spans and logs with GenAI and domain attributes", async () => {
    const dir = await tempDir();
    const channel = new FakeChannel();
    const trace = createTrace(dir, channel);
    const review = trace.startReview({ mode: "quick", attempt: 0, prompt: "Fix the login bug.", profile });
    review.health("/fake/claude", { ok: true }, 4);
    const llm = review.llm({ mode: "quick", generationMethod: "cli", timeoutMs: 120_000 });
    llm.request(request, profile);
    llm.process(["-p", "--model", "sonnet"], "/work", 4321);
    llm.stdin(request.user);
    llm.stdout('{"result":"ok"}');
    llm.stderr("warning");
    llm.response({ text: '{"verdict":"ready"}', inputTokens: 3, outputTokens: 2, costUsd: 0.01 }, 12.5);
    review.parsed({ verdict: "ready", issues: [], questions: [], usage: { inputTokens: 3, outputTokens: 2 } });
    review.end("ok");
    await trace.dispose();

    const records = await readRecords(dir);
    const spans = records.filter((record) => record.recordType === "span");
    const logs = records.filter((record) => record.recordType === "log");
    const names = spans.map((span) => span.name);
    expect(names).toEqual(expect.arrayContaining(["session", "review.quick", "health.check", "llm.call"]));

    const reviewSpan = spans.find((span) => span.name === "review.quick")!;
    const llmSpan = spans.find((span) => span.name === "llm.call")!;
    expect(llmSpan.kind).toBe("CLIENT");
    expect(llmSpan.traceId).toBe(reviewSpan.traceId);
    expect(llmSpan.parentSpanId).toBe(reviewSpan.spanId);
    expect(llmSpan.status).toEqual({ code: "OK" });
    expect(llmSpan.attributes).toMatchObject({
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "sonnet",
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 2,
      "prompt_preflight.mode": "quick",
      "prompt_preflight.thinking_effort": "medium",
      "prompt_preflight.timeout_ms": 120000,
      "prompt_preflight.rtt_ms": 12.5,
    });
    expect((llmSpan.events as Array<{ name: string }>).map((event) => event.name)).toEqual(
      expect.arrayContaining(["request", "process", "stdin", "stdout", "stderr", "response"]),
    );

    const events = logs.map((log) => (log.attributes as Record<string, unknown>)["event.name"]);
    expect(events).toEqual(
      expect.arrayContaining([
        "session.start",
        "review.start",
        "review.health",
        "llm.request",
        "llm.process",
        "llm.stdin",
        "llm.stdout",
        "llm.stderr",
        "llm.response",
        "review.parsed",
        "session.end",
      ]),
    );
    const requestLog = logs.find((log) => (log.attributes as Record<string, unknown>)["event.name"] === "llm.request")!;
    expect(requestLog.traceId).toBe(reviewSpan.traceId);
    expect(requestLog.spanId).toBe(llmSpan.spanId);
    expect(requestLog.attributes).toMatchObject({
      "llm.request.system": request.system,
      "llm.request.user": request.user,
      "llm.request.user_chars": request.user.length,
    });
    const responseLog = logs.find((log) => (log.attributes as Record<string, unknown>)["event.name"] === "llm.response")!;
    expect(responseLog.attributes).toMatchObject({
      "llm.response.text": '{"verdict":"ready"}',
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 2,
      "prompt_preflight.rtt_ms": 12.5,
    });
    const errorLog = logs.find((log) => (log.attributes as Record<string, unknown>)["event.name"] === "llm.error");
    expect(errorLog).toBeUndefined();

    expect(channel.lines.some((line) => line.message.includes("[LLM REQ]"))).toBe(true);
    expect(channel.lines.some((line) => line.message.includes("[LLM RES]"))).toBe(true);
    expect(channel.lines.some((line) => line.message.includes("[SESSION]"))).toBe(true);
    expect(channel.lines.some((line) => line.level === "warn" && line.message.includes("[LLM STDERR]"))).toBe(true);
  });

  it("records a failed call and review without losing the error facts", async () => {
    const dir = await tempDir();
    const channel = new FakeChannel();
    const trace = createTrace(dir, channel);
    const review = trace.startReview({ mode: "deep", attempt: 1, prompt: "Fix the login bug.", profile });
    const llm = review.llm({ mode: "deep", generationMethod: "cli", timeoutMs: 120_000 });
    llm.request(request, profile);
    const error = new Error("Command failed: claude");
    llm.error(error, 9, { exitCode: 1, killed: true, signal: "SIGTERM", timedOut: true });
    review.error(error, { code: "provider-missing", action: "open-settings", retryable: false });
    review.end("error");
    await trace.dispose();

    const records = await readRecords(dir);
    const llmSpan = records.find((record) => record.recordType === "span" && record.name === "llm.call")!;
    expect(llmSpan.status).toEqual({ code: "ERROR", message: "Command failed: claude" });
    expect(llmSpan.attributes).toMatchObject({
      "prompt_preflight.exit_code": 1,
      "prompt_preflight.killed": true,
      "prompt_preflight.timed_out": true,
      "prompt_preflight.rtt_ms": 9,
    });
    const llmError = records.find(
      (record) =>
        record.recordType === "log" &&
        (record.attributes as Record<string, unknown>)["event.name"] === "llm.error",
    )!;
    expect(llmError.attributes).toMatchObject({
      "error.message": "Command failed: claude",
      "prompt_preflight.exit_code": 1,
      "prompt_preflight.killed": true,
      "prompt_preflight.timed_out": true,
    });
    const reviewError = records.find(
      (record) =>
        record.recordType === "log" &&
        (record.attributes as Record<string, unknown>)["event.name"] === "review.error",
    )!;
    expect(reviewError.attributes).toMatchObject({
      "prompt_preflight.error_code": "provider-missing",
      "prompt_preflight.error_action": "open-settings",
      "prompt_preflight.retryable": false,
    });
    expect(channel.lines.some((line) => line.level === "error" && line.message.includes("[LLM ERR]"))).toBe(true);
    expect(channel.lines.some((line) => line.level === "error" && line.message.includes("[REVIEW ERR]"))).toBe(true);
  });
});

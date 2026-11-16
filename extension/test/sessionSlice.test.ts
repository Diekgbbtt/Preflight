import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCandidates, parseClaudeSession, parseCodexSession } from "../src/sessionSlice";

const claudeFixture = readFileSync(new URL("./fixtures/claude/session-basic.jsonl", import.meta.url), "utf8");
const codexFixture = readFileSync(new URL("./fixtures/codex/session-basic.jsonl", import.meta.url), "utf8");

describe("parseClaudeSession", () => {
  it("extracts metadata from the public format", () => {
    const parsed = parseClaudeSession(claudeFixture);
    expect(parsed.sessionId).toBe("sess-claude-1");
    expect(parsed.startedAt).toBe("2026-01-02T10:00:00.000Z");
    expect(parsed.endedAt).toBe("2026-01-02T10:00:50.000Z");
    expect(parsed.folderUri).toBe("file:///Users/alice/proj");
  });

  it("extracts user and assistant text turns without thinking or results", () => {
    const parsed = parseClaudeSession(claudeFixture);
    const roles = parsed.turns.map((t) => t.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(parsed.turns[0]).toMatchObject({
      role: "user",
      text: "Please add a greeting helper to src/greet.ts and run the tests.",
      at: "2026-01-02T10:00:00.000Z",
    });
    expect(parsed.turns[1]).toMatchObject({ role: "assistant", at: "2026-01-02T10:00:05.000Z" });
    expect(parsed.turns[1].text).toContain("build error was fixed");
  });

  it("extracts fenced code into code with a workspace-relative path and removes it from text", () => {
    const parsed = parseClaudeSession(claudeFixture);
    const assistant = parsed.turns[1];    expect(assistant.code).toEqual(["export function greet(name: string): string {\n  return `Hello ${name}`;\n}"]);
    expect(assistant.codePath).toBe("src/greet.ts");
    expect(assistant.text).not.toContain("greet(name");
    expect(assistant.text).toContain("I will add the helper.");
  });

  it("links tool calls to their results and keeps one-line summaries", () => {
    const parsed = parseClaudeSession(claudeFixture);
    expect(parsed.toolCalls).toHaveLength(4);
    expect(parsed.toolCalls[0]).toMatchObject({ name: "Write", status: "ok", summary: "Write src/greet.ts" });
    expect(parsed.toolCalls[1]).toMatchObject({ name: "Bash", status: "ok", summary: "Bash npm test" });
    expect(parsed.toolCalls[2]).toMatchObject({ name: "Bash", status: "error", summary: "Bash npm run build" });
    expect(parsed.toolCalls[3]).toMatchObject({ name: "Edit", status: "ok", summary: "Edit src/app.ts" });
  });

  it("keeps the error and resolves it when the cause is later fixed", () => {
    const parsed = parseClaudeSession(claudeFixture);
    expect(parsed.errors).toEqual([
      { message: "Error: build failed", status: "resolved", at: "2026-01-02T10:00:35.000Z" },
    ]);
  });

  it("records test results with final status", () => {
    const parsed = parseClaudeSession(claudeFixture);
    expect(parsed.testResults).toEqual([{ name: "Bash npm test", status: "passed", at: "2026-01-02T10:00:20.000Z" }]);
  });

  it("collects changed files from write and edit inputs", () => {
    const parsed = parseClaudeSession(claudeFixture);
    expect(parsed.changedFiles).toEqual(["/Users/alice/proj/src/greet.ts", "/Users/alice/proj/src/app.ts"]);
  });

  it("never throws on corrupt, malformed or empty lines", () => {
    const text = [claudeFixture, "not json at all", "", "[]", "{\"type\":\"user\"}"].join("\n");
    const parsed = parseClaudeSession(text);
    expect(parsed.sessionId).toBe("sess-claude-1");
    expect(parsed.turns.length).toBeGreaterThanOrEqual(2);
  });

  it("returns an empty parse for text with no complete lines", () => {
    const parsed = parseClaudeSession("");
    expect(parsed).toEqual({ turns: [], toolCalls: [], errors: [], testResults: [], changedFiles: [] });
  });
});

describe("parseCodexSession", () => {
  it("extracts metadata from session_meta", () => {
    const parsed = parseCodexSession(codexFixture);
    expect(parsed.sessionId).toBe("sess-codex-1");
    expect(parsed.startedAt).toBe("2026-01-02T11:00:00.000Z");
    expect(parsed.endedAt).toBe("2026-01-02T11:00:40.000Z");
    expect(parsed.folderUri).toBe("file:///Users/alice/proj");
  });

  it("extracts message turns from input and output text", () => {
    const parsed = parseCodexSession(codexFixture);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]).toMatchObject({
      role: "user",
      text: "Fix the flaky test in src/app.test.ts",
      at: "2026-01-02T11:00:02.000Z",
    });
    expect(parsed.turns[1].role).toBe("assistant");
    expect(parsed.turns[1].code).toEqual(["expect(flaky()).toBe(true);"]);
    expect(parsed.turns[1].codePath).toBe("src/app.test.ts");
    expect(parsed.turns[1].text).not.toContain("flaky()).toBe(true);\n```");
  });

  it("links function calls and outputs, including structured failure output", () => {
    const parsed = parseCodexSession(codexFixture);
    expect(parsed.toolCalls).toHaveLength(3);
    expect(parsed.toolCalls[0]).toMatchObject({ name: "shell", status: "ok", summary: "shell npm test" });
    expect(parsed.toolCalls[1]).toMatchObject({ name: "apply_patch", status: "ok" });
    expect(parsed.toolCalls[2]).toMatchObject({ name: "shell", status: "error" });
  });

  it("records the test result and the build error", () => {
    const parsed = parseCodexSession(codexFixture);
    expect(parsed.testResults).toEqual([{ name: "shell npm test", status: "passed", at: "2026-01-02T11:00:10.000Z" }]);
    expect(parsed.errors).toEqual([{ message: "error: build failed", status: "error", at: "2026-01-02T11:00:35.000Z" }]);
  });

  it("collects changed files from apply_patch arguments", () => {
    const parsed = parseCodexSession(codexFixture);
    expect(parsed.changedFiles).toEqual(["src/app.test.ts"]);
  });

  it("skips unknown event types without throwing", () => {
    const text = [
      '{"type":"session_meta","payload":{"id":"s2","timestamp":"2026-01-02T12:00:00.000Z","cwd":"/Users/alice/proj"}}',
      '{"type":"totally_unknown","payload":{"weird":true}}',
      '{"type":"response_item","payload":{"type":"reasoning","summary":[]}}',
    ].join("\n");
    const parsed = parseCodexSession(text);
    expect(parsed.sessionId).toBe("s2");
    expect(parsed.turns).toEqual([]);
  });
});

describe("discoverCandidates", () => {
  let home: string | null = null;

  afterEach(async () => {
    if (home) await fs.rm(home, { recursive: true, force: true });
    home = null;
  });

  const setup = async (): Promise<string> => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-sess-"));
    return home;
  };

  it("finds Claude sessions under the encoded project directory", async () => {
    const dir = await setup();
    const projectDir = path.join(dir, ".claude", "projects", "-Users-alice-proj");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "sess-a.jsonl"), claudeFixture);
    await fs.writeFile(path.join(projectDir, "notes.txt"), "ignored");
    const candidates = await discoverCandidates("file:///Users/alice/proj", dir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sessionId: "sess-a", provider: "claude", folderUri: "file:///Users/alice/proj" });
    expect(candidates[0].filePath.endsWith("sess-a.jsonl")).toBe(true);
    expect(candidates[0].mtimeMs).toBeGreaterThan(0);
  });

  it("returns an empty list for a missing Claude project directory", async () => {
    const dir = await setup();
    expect(await discoverCandidates("file:///Users/alice/proj", dir)).toEqual([]);
  });

  it("finds Codex sessions nested under date directories by cwd metadata", async () => {
    const dir = await setup();
    const sessionDir = path.join(dir, ".codex", "sessions", "2026", "01", "02");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "rollout-2026-01-02T11-00-00-sess-codex-1.jsonl"), codexFixture);
    const candidates = await discoverCandidates("file:///Users/alice/proj", dir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sessionId: "sess-codex-1", provider: "codex", folderUri: "file:///Users/alice/proj" });
    expect(candidates[0].startedAt).toBe("2026-01-02T11:00:00.000Z");
  });

  it("skips Codex sessions whose cwd does not match the folder", async () => {
    const dir = await setup();
    const sessionDir = path.join(dir, ".codex", "sessions", "2026", "01", "02");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "rollout-other.jsonl"), codexFixture);
    expect(await discoverCandidates("file:///Users/alice/other", dir)).toEqual([]);
  });

  it("returns an empty list for a missing Codex sessions tree", async () => {
    const dir = await setup();
    expect(await discoverCandidates("file:///Users/alice/proj", dir)).toEqual([]);
  });

  it("returns an empty list for a non-file folder URI", async () => {
    const dir = await setup();
    expect(await discoverCandidates("untitled:Untitled-1", dir)).toEqual([]);
  });
});

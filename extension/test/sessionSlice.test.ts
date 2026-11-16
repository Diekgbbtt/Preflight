import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SESSION_CAPS, discoverCandidates, parseClaudeSession, parseCodexSession, readSlice } from "../src/sessionSlice";
import { redact } from "../src/privacy";

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

describe("readSlice", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
  });

  const setup = async (): Promise<string> => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-slice-"));
    return dir;
  };

  const write = async (name: string, text: string): Promise<string> => {
    const base = await setup();
    const file = path.join(base, name);
    await fs.writeFile(file, text);
    return file;
  };

  const CWD = "/Users/alice/proj";
  const at = (n: number) => `2026-01-02T10:00:${String(n).padStart(2, "0")}.000Z`;

  const claudeTurns = (turns: Array<{ role: "user" | "assistant"; text: string }>): string =>
    turns.map((t, i) => JSON.stringify({ type: t.role, sessionId: "sess-x", timestamp: at(i), cwd: CWD, message: { role: t.role, content: t.text } })).join("\n") + "\n";

  const options = { includeCode: "off" as const, redact };

  it("returns an empty slice with reason unsupported for an unknown provider", async () => {
    const file = await write("s.jsonl", claudeTurns([{ role: "user", text: "hello" }]));
    const slice = await readSlice(file, "gemini" as "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options);
    expect(slice.turns).toEqual([]);
    expect(slice.provenance.reason).toBe("unsupported");
  });

  it("returns an empty slice with reason error for a missing file", async () => {
    const slice = await readSlice(path.join(os.tmpdir(), "preflight-missing-xyz.jsonl"), "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options);
    expect(slice.turns).toEqual([]);
    expect(slice.provenance.reason).toBe("error");
  });

  it("returns an empty slice with reason empty for an empty or unparseable file", async () => {
    const empty = await write("empty.jsonl", "");
    expect((await readSlice(empty, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options)).provenance.reason).toBe("empty");
    const corrupt = await write("corrupt.jsonl", "not json\nnot json either\n");
    expect((await readSlice(corrupt, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options)).provenance.reason).toBe("empty");
  });

  it("builds a slice with session id from the basename and derived content", async () => {
    const file = await write("sess-x.jsonl", claudeTurns([{ role: "user", text: "hello" }, { role: "assistant", text: "hi there" }]));
    const slice = await readSlice(file, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options);
    expect(slice.sessionId).toBe("sess-x");
    expect(slice.provider).toBe("claude");
    expect(slice.folderUri).toBe("file:///Users/alice/proj");
    expect(slice.startedAt).toBe(at(0));
    expect(slice.endedAt).toBe(at(1));
    expect(slice.turns.map((t) => t.text)).toEqual(["hello", "hi there"]);
    expect(slice.tokens).toBeGreaterThan(0);
    expect(slice.truncated).toBe(false);
    expect(slice.provenance).toMatchObject({ turnsKept: 2, droppedTurns: 0, truncated: false });
  });

  it("keeps the last maxTurns turns and counts dropped ones", async () => {
    const turns = Array.from({ length: 11 }, (_, i) => ({ role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant", text: `turn ${i}` }));
    const file = await write("many.jsonl", claudeTurns(turns));
    const slice = await readSlice(file, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options);
    expect(slice.turns).toHaveLength(10);
    expect(slice.turns[0].text).toBe("turn 1");
    expect(slice.turns[9].text).toBe("turn 10");
    expect(slice.provenance.droppedTurns).toBe(1);
    expect(slice.truncated).toBe(true);
  });

  it("keeps exactly 10 turns without truncation", async () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant", text: `turn ${i}` }));
    const file = await write("ten.jsonl", claudeTurns(turns));
    const slice = await readSlice(file, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options);
    expect(slice.turns).toHaveLength(10);
    expect(slice.truncated).toBe(false);
  });

  it("drops the oldest turns until the token cap is met", async () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({ role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant", text: `turn ${i} `.repeat(40) }));
    const file = await write("big.jsonl", claudeTurns(turns));
    const slice = await readSlice(file, "claude", { ...DEFAULT_SESSION_CAPS, maxTokens: 100 }, { now: () => 0 }, options);
    expect(slice.tokens).toBeLessThanOrEqual(100);
    expect(slice.provenance.droppedTurns).toBeGreaterThan(0);
    expect(slice.truncated).toBe(true);
  });

  it("returns an empty truncated slice when one turn alone exceeds the token cap", async () => {
    const file = await write("huge-turn.jsonl", claudeTurns([{ role: "user", text: "word ".repeat(1000) }]));
    const slice = await readSlice(file, "claude", { ...DEFAULT_SESSION_CAPS, maxTokens: 10 }, { now: () => 0 }, options);
    expect(slice.turns).toEqual([]);
    expect(slice.truncated).toBe(true);
    expect(slice.provenance.droppedTurns).toBe(1);
  });

  it("reads at most the last maxBytes and drops the first partial line after the seek", async () => {
    const pad = "x".repeat(300);
    const lines = [
      JSON.stringify({ type: "user", sessionId: "sess-old", timestamp: at(0), cwd: CWD, message: { role: "user", content: `old turn ${pad}` } }),
      JSON.stringify({ type: "user", sessionId: "sess-x", timestamp: at(1), cwd: CWD, message: { role: "user", content: "fresh turn" } }),
      JSON.stringify({ type: "assistant", sessionId: "sess-x", timestamp: at(2), cwd: CWD, message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
    ];
    const text = lines.join("\n") + "\n";
    // Seek 100 bytes before the end of the first line, so the window opens mid-line.
    const firstLen = Buffer.byteLength(lines[0], "utf8") + 1;
    const maxBytes = Buffer.byteLength(text, "utf8") - (firstLen - 100);
    const file = await write("window.jsonl", text);
    const slice = await readSlice(file, "claude", { ...DEFAULT_SESSION_CAPS, maxBytes }, { now: () => 0 }, options);
    expect(slice.provenance.bytesRead).toBe(maxBytes);
    expect(slice.provenance.truncated).toBe(true);
    expect(slice.turns.map((t) => t.text)).toEqual(["fresh turn", "answer"]);
    expect(slice.sessionId).toBe("sess-x");
  });

  it("drops a trailing line without a newline instead of parsing it", async () => {
    const lines = [
      JSON.stringify({ type: "user", sessionId: "sess-x", timestamp: at(0), cwd: CWD, message: { role: "user", content: "complete turn" } }),
      JSON.stringify({ type: "user", sessionId: "sess-x", timestamp: at(1), cwd: CWD, message: { role: "user", content: "second turn" } }),
    ];
    const file = await write("partial.jsonl", lines.join("\n") + "\n" + '{"type":"user"');
    const slice = await readSlice(file, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options);
    // Both complete lines parse (consecutive same-role text merges); the
    // trailing fragment without a newline is dropped, never parsed.
    expect(slice.turns.map((t) => t.text)).toEqual(["complete turn\nsecond turn"]);
  });

  it("normalizes changed files to sorted workspace-relative paths and drops outside paths", async () => {
    const lines = [
      JSON.stringify({ type: "assistant", sessionId: "sess-x", timestamp: at(0), cwd: CWD, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: `${CWD}/src/b.ts` } }] } }),
      JSON.stringify({ type: "assistant", sessionId: "sess-x", timestamp: at(1), cwd: CWD, message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: `${CWD}/src/a.ts` } }] } }),
      JSON.stringify({ type: "assistant", sessionId: "sess-x", timestamp: at(2), cwd: CWD, message: { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "Write", input: { file_path: "/Users/other/evil.ts" } }] } }),
    ];
    const file = await write("changed.jsonl", lines.join("\n") + "\n");
    const slice = await readSlice(file, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options);
    expect(slice.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(slice.provenance.droppedFiles).toBe(1);
  });

  it("drops all code excerpts under includeCode off but keeps turn text", async () => {
    const text = "Here is the plan.\n\n```ts src/app.ts\nconst secretCode = 42;\n```";
    const file = await write("code-off.jsonl", claudeTurns([{ role: "assistant", text }]));
    const slice = await readSlice(file, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options);
    expect(slice.turns[0].code).toBeUndefined();
    expect(slice.turns[0].text).toContain("Here is the plan.");
    expect(slice.turns[0].text).not.toContain("secretCode");
  });

  it("keeps code only for the active file under includeCode active-file", async () => {
    const text = "```ts src/app.ts\nconst app = 1;\n```\n```ts src/other.ts\nconst other = 2;\n```";
    const file = await write("code-active.jsonl", claudeTurns([{ role: "assistant", text }]));
    const slice = await readSlice(file, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, {
      includeCode: "active-file",
      activeFileUri: "file:///Users/alice/proj/src/app.ts",
      redact,
    });
    expect(slice.turns[0].code).toEqual(["const app = 1;"]);
    expect(slice.turns[0].codePath).toBe("src/app.ts");
  });

  it("drops all code under active-file when no active file is known", async () => {
    const text = "Patching now.\n\n```ts src/app.ts\nconst app = 1;\n```";
    const file = await write("code-noactive.jsonl", claudeTurns([{ role: "assistant", text }]));
    const slice = await readSlice(file, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, { includeCode: "active-file", redact });
    expect(slice.turns[0].code).toBeUndefined();
    expect(slice.turns[0].text).toContain("Patching now.");
  });

  it("keeps workspace code except excluded paths under includeCode workspace", async () => {
    const text = "```ts src/app.ts\nconst app = 1;\n```\n```json node_modules/pkg/data.json\n{\"k\":1}\n```";
    const file = await write("code-ws.jsonl", claudeTurns([{ role: "assistant", text }]));
    const slice = await readSlice(file, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, { includeCode: "workspace", redact });
    expect(slice.turns[0].code).toEqual(["const app = 1;"]);
  });

  it("redacts secrets in turn text and counts redactions", async () => {
    const file = await write("secret.jsonl", claudeTurns([{ role: "user", text: "use sk-ant-0123456789abcdefghij please" }]));
    const slice = await readSlice(file, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options);
    expect(slice.turns[0].text).toContain("[redacted]");
    expect(slice.turns[0].text).not.toContain("sk-ant-");
    expect(slice.provenance.redactions).toBe(1);
  });

  it("keeps non-English turn text intact apart from redaction", async () => {
    const file = await write("i18n.jsonl", claudeTurns([{ role: "user", text: "認証を追加してください" }, { role: "assistant", text: "理解しました" }]));
    const slice = await readSlice(file, "claude", DEFAULT_SESSION_CAPS, { now: () => 0 }, options);
    expect(slice.turns.map((t) => t.text)).toEqual(["認証を追加してください", "理解しました"]);
  });
});

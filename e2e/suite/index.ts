// The VS Code extension-host e2e suite. The launcher mounts the built
// extension, copies the sample workspace, and runs this module.
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { checkHealth, createClaudeProvider, hashPrompt, mapError } from "@prompt-preflight/core";
import {
  assembleContext,
  canImproveDeep,
  createFakeCli,
  deepReview,
  folderUri,
  improvedPrompt,
  makeHome,
  promptHash,
  quickReview,
  readSeededSlice,
  repository,
  workspaceRoot,
  workspaceTools,
} from "../facade";

type Test = { name: string; run: () => Promise<void> };
const tests: Test[] = [];
const test = (name: string, run: () => Promise<void>): void => {
  tests.push({ name, run });
};

const FIXTURE_FOLDER = "file:///Users/alice/proj";
const repoRoot = (): string => process.env.PREFLIGHT_E2E_REPO ?? process.cwd();
const fixtureDir = (): string => path.join(repoRoot(), "extension", "test", "fixtures");
const env = (): NodeJS.ProcessEnv => process.env;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("mounts the built extension and declares its commands", async () => {
  const extension = vscode.extensions.getExtension("prompt-preflight.prompt-preflight");
  assert.ok(extension, "the extension is not mounted");
  assert.equal(path.resolve(extension.extensionPath), path.resolve(env().PREFLIGHT_E2E_EXTENSION ?? ""));
  const commands = (extension.packageJSON.contributes?.commands ?? []).map((command: { command: string }) => command.command);
  assert.deepEqual(commands.sort(), [
    "promptPreflight.checkSelection",
    "promptPreflight.clearDebugLog",
    "promptPreflight.clearHistory",
    "promptPreflight.focus",
    "promptPreflight.openDebugLog",
    "promptPreflight.openDebugLogFile",
    "promptPreflight.openStudyLog",
  ]);
});

test("E1: explicit @ file context reaches the bundle without an active editor", async () => {
  const draft = "Fix @src/greet.ts so greet returns Hello. Test: expect greet('A') === 'Hello A'.";
  const bundle = await assembleContext({ draft, qa: [], includeCode: "prompt-files" });
  const entry = bundle.manifest.sources.find((source) => source.source === "prompt-files");
  assert.ok(entry, "prompt-files manifest entry missing");
  assert.equal(entry.included, true);
  assert.equal(entry.omittedReason, undefined);
  const fragment = bundle.fragments.find((item) => item.source === "prompt-files");
  assert.ok(fragment, "prompt-files fragment missing");
  assert.equal(fragment.provenance.path, "src/greet.ts");
  assert.match(fragment.content, /export function greet/);
  for (const removed of ["active-editor", "selection", "open-editors"]) {
    assert.equal(bundle.fragments.some((item) => item.source === removed), false, `${removed} must not be a source`);
  }
});

test("E2: deep review has no score or improved prompt, and the separate action rewrites", async () => {
  const cli = await createFakeCli();
  const quick = await quickReview("Fix the login bug", cli);
  assert.equal(quick.score?.score, 90, "quick score");
  assert.equal("source" in (quick.score ?? {}), false, "score has no source field");
  const deep = await deepReview("Fix the login bug", cli);
  assert.equal(deep.questions.length, 1);
  assert.equal("score" in deep, false, "deep review must not score");
  assert.equal("improvedPrompt" in deep, false, "deep review must not carry the improved prompt");
  assert.equal(canImproveDeep(deep), true);
  const improved = await improvedPrompt("Fix the login bug", deep, cli);
  assert.ok(improved, "improved prompt missing");
  assert.match(improved.text, /\[expected result\]/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-e2e-reviews-"));
  const reviews = repository<Record<string, unknown>>(path.join(dir, "reviews.jsonl"));
  await reviews.append({
    id: "review-1",
    ts: new Date().toISOString(),
    draftId: "draft-1",
    folderUri: folderUri(),
    ...deep,
  });
  const listed = await reviews.list();
  assert.equal(listed.events.length, 1);
  assert.equal("score" in listed.events[0], false);
  assert.equal("improvedPrompt" in listed.events[0], false);
});

test("E3: consent off excludes @ files without reading them", async () => {
  let read = false;
  const bundle = await assembleContext({
    draft: "Fix @src/greet.ts",
    qa: [],
    includeCode: "off",
    readText: async () => {
      read = true;
      return "";
    },
  });
  assert.equal(read, false, "the source must not read an excluded file");
  const entry = bundle.manifest.sources.find((source) => source.source === "prompt-files");
  assert.ok(entry);
  assert.equal(entry.included, false);
  assert.equal(entry.omittedReason, "excluded");
  assert.equal(bundle.fragments.some((item) => item.source === "prompt-files"), false);
});

test("E4: send records carry the exact text and the shared prompt hash", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-e2e-sends-"));
  const sends = repository<Record<string, unknown>>(path.join(dir, "sends.jsonl"));
  const text = "Fix @src/greet.ts so greet returns Hello.";
  const sentAt = new Date().toISOString();
  await sends.append({
    id: "send-1",
    ts: sentAt,
    draftId: "draft-1",
    folderUri: folderUri(),
    text,
    promptHash: promptHash(text),
    target: "terminal",
  });
  const listed = await sends.list();
  assert.equal(listed.events.length, 1);
  assert.equal(listed.events[0].seq, 1);
  assert.equal(listed.events[0].schemaVersion, 1);
  assert.equal(listed.events[0].text, text);
  assert.equal(listed.events[0].promptHash, hashPrompt(text));
  assert.equal(listed.events[0].target, "terminal");
});

test("E5: Claude slice keeps code only for prompt-files", async () => {
  const home = await makeHome();
  const projectDir = path.join(home, ".claude", "projects", "-Users-alice-proj");
  await fs.mkdir(projectDir, { recursive: true });
  const lines = [
    { type: "user", sessionId: "sess-e2e", timestamp: "2026-01-02T10:00:00.000Z", cwd: "/Users/alice/proj", message: { role: "user", content: "Use sk-ant-0123456789abcdefghij and add the helper." } },
    { type: "assistant", sessionId: "sess-e2e", timestamp: "2026-01-02T10:00:05.000Z", cwd: "/Users/alice/proj", message: { role: "assistant", content: [{ type: "text", text: "I will add it.\n\n```ts src/greet.ts\nexport function greet(name: string) {\n  return `Hello ${name}`;\n}\n```\n\n```ts src/other.ts\nexport const other = 1;\n```" }] } },
    { type: "assistant", sessionId: "sess-e2e", timestamp: "2026-01-02T10:00:10.000Z", cwd: "/Users/alice/proj", message: { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "Write", input: { file_path: "/Users/alice/proj/src/greet.ts", content: "export function greet() {}" } }] } },
    { type: "user", sessionId: "sess-e2e", timestamp: "2026-01-02T10:00:12.000Z", cwd: "/Users/alice/proj", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "File written.", is_error: false }] } },
  ];
  await fs.writeFile(path.join(projectDir, "sess-e2e.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const slice = await readSeededSlice({
    homeDir: home,
    folderUri: FIXTURE_FOLDER,
    includeCode: "prompt-files",
    promptFiles: ["src/greet.ts"],
  });
  assert.equal(slice.provider, "claude");
  assert.equal(slice.changedFiles.join(","), "src/greet.ts");
  const coded = slice.turns.find((turn) => turn.code !== undefined);
  assert.ok(coded, "code turn missing");
  assert.equal(coded.codePath, "src/greet.ts");
  assert.match(coded.code?.join("\n") ?? "", /export function greet/);
  assert.equal(slice.provenance.redactions, 1, "the secret must be redacted once");
  assert.ok(slice.tokens <= 8000);
});

test("E6: real Codex events produce two calls, a failed test and one changed file", async () => {
  const home = await makeHome();
  const sessionDir = path.join(home, ".codex", "sessions", "2026", "04", "10");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.copyFile(path.join(fixtureDir(), "codex", "session-real-events.jsonl"), path.join(sessionDir, "rollout-e2e.jsonl"));
  const slice = await readSeededSlice({
    homeDir: home,
    folderUri: FIXTURE_FOLDER,
    includeCode: "prompt-files",
    promptFiles: ["src/app.ts"],
  });
  assert.equal(slice.provider, "codex");
  assert.equal(slice.toolCalls.length, 2);
  assert.equal(slice.toolCalls[0].name, "FileChange");
  assert.equal(slice.toolCalls[0].status, "ok");
  assert.equal(slice.toolCalls[1].name, "exec_command");
  assert.equal(slice.toolCalls[1].status, "error");
  assert.equal(slice.testResults[0]?.name, "exec_command npm test");
  assert.equal(slice.testResults[0]?.status, "failed");
  assert.equal(slice.errors[0]?.message, "1 failed, 1 passed");
  assert.equal(slice.changedFiles.join(","), "src/app.ts");
  const coded = slice.turns.find((turn) => turn.code !== undefined);
  assert.ok(coded);
  assert.equal(coded.codePath, "src/app.ts");
  assert.match(coded.code?.join("\n") ?? "", /export const app = 2/);
});

test("E7: the TypeScript language provider returns greet symbols", async () => {
  const uri = vscode.Uri.file(path.join(workspaceRoot(), "src", "greet.ts"));
  await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(uri);
  const { tools } = workspaceTools();
  let symbols = await tools.documentSymbols({ path: "src/greet.ts" });
  for (let attempt = 0; attempt < 40 && symbols.items.length === 0; attempt++) {
    await sleep(250);
    symbols = await tools.documentSymbols({ path: "src/greet.ts" });
  }
  assert.notEqual(symbols.items.length, 0, `no document symbols: ${JSON.stringify(symbols)}`);
  if (symbols.fallback) assert.fail("the TypeScript provider must not fall back to text search");
  assert.ok(symbols.items.some((symbol) => symbol.name === "greet"), "greet symbol missing");
});

test("E8: an absent workspace symbol falls over to the bundled rg", async () => {
  const { tools } = workspaceTools();
  const result = await tools.workspaceSymbols({ query: "MissingNeedle" });
  assert.equal(result.fallback, "text-search", `expected a text-search fallback, got ${JSON.stringify(result)}`);
  if (result.fallback === "text-search") {
    assert.ok(result.items.some((item) => item.path === "src/needle.ts"), `needle match missing: ${JSON.stringify(result)}`);
  }
});

test("E9: a missing CLI maps to provider-missing without a review event", async () => {
  const profile = { provider: "claude" as const, model: "sonnet", thinkingEffort: "high" };
  const provider = createClaudeProvider(profile, { claudePath: "/nonexistent/claude" });
  const health = await checkHealth(provider, profile, "/nonexistent/claude");
  assert.equal(health.ok, false);
  if (!health.ok) {
    assert.equal(health.error.code, "provider-missing");
    assert.equal(health.error.retryable, false);
  }
  try {
    await quickReview("Fix it", "/nonexistent/claude");
    assert.fail("the missing CLI must fail");
  } catch (error) {
    assert.equal(mapError(error).code, "provider-missing");
  }
});

test("E11: real Codex custom tool calls produce one apply_patch and two changed files", async () => {
  const home = await makeHome();
  const sessionDir = path.join(home, ".codex", "sessions", "2026", "05", "11");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.copyFile(
    path.join(fixtureDir(), "codex", "session-custom-tool.jsonl"),
    path.join(sessionDir, "rollout-e2e-custom.jsonl"),
  );
  const slice = await readSeededSlice({
    homeDir: home,
    folderUri: FIXTURE_FOLDER,
    includeCode: "workspace",
    promptFiles: [],
  });
  assert.equal(slice.provider, "codex");
  assert.equal(slice.toolCalls.length, 1);
  assert.equal(slice.toolCalls[0].name, "apply_patch");
  assert.equal(slice.toolCalls[0].status, "ok");
  assert.equal(slice.changedFiles.join(","), "src/app.ts,src/helper.ts");
});

test("E12: debug tracing writes OTel spans and full LLM packets for a real panel review", async () => {
  const extension = vscode.extensions.getExtension("prompt-preflight.prompt-preflight");
  assert.ok(extension, "the extension is not mounted");
  if (!extension.isActive) await extension.activate();
  const api = extension.exports as { debug?: { acceptNotice(): Promise<void> } } | undefined;
  assert.ok(api?.debug, "debug acceptNotice API missing");
  await api.debug.acceptNotice();

  const config = vscode.workspace.getConfiguration("promptPreflight");
  const before = {
    debug: config.get<boolean>("debug", false),
    debugLogDir: config.get<string>("debugLogDir", ""),
    claudePath: config.get<string>("claudePath", "claude"),
    pauseMs: config.get<number>("pauseMs", 1500),
    quickModel: config.get<string>("quickModel", "haiku"),
    provider: config.get<string>("provider", "claude"),
    thinkingEffort: config.get<string>("thinkingEffort", "medium"),
    quickReviewOnPause: config.get<boolean>("quickReviewOnPause", true),
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-e2e-debug-"));
  const cli = await createFakeCli();
  try {
    await config.update("provider", "claude", vscode.ConfigurationTarget.Global);
    await config.update("quickModel", "haiku", vscode.ConfigurationTarget.Global);
    await config.update("thinkingEffort", "medium", vscode.ConfigurationTarget.Global);
    await config.update("quickReviewOnPause", true, vscode.ConfigurationTarget.Global);
    await config.update("pauseMs", 500, vscode.ConfigurationTarget.Global);
    await config.update("claudePath", cli, vscode.ConfigurationTarget.Global);
    await config.update("debugLogDir", dir, vscode.ConfigurationTarget.Global);
    await config.update("debug", true, vscode.ConfigurationTarget.Global);
    await sleep(300);
    await vscode.commands.executeCommand("promptPreflight.focus");
    await sleep(800);

    const doc = await vscode.workspace.openTextDocument(path.join(workspaceRoot(), "src/greet.ts"));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), doc.positionAt(doc.getText().length));
    await vscode.commands.executeCommand("promptPreflight.checkSelection");
    await sleep(1800);

    const traceFile = path.join(dir, "llm-trace.jsonl");
    const text = await fs.readFile(traceFile, "utf8");
    const records = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const logs = records.filter((record) => record.recordType === "log");
    const request = logs.find(
      (record) => (record.attributes as Record<string, unknown>)["event.name"] === "llm.request",
    );
    const response = logs.find(
      (record) => (record.attributes as Record<string, unknown>)["event.name"] === "llm.response",
    );
    assert.ok(request, "llm.request log missing");
    assert.ok(response, "llm.response log missing");
    const requestAttributes = request.attributes as Record<string, unknown>;
    const responseAttributes = response.attributes as Record<string, unknown>;
    assert.equal(requestAttributes["gen_ai.request.model"], "haiku");
    assert.equal(requestAttributes["prompt_preflight.thinking_effort"], "medium");
    assert.equal(requestAttributes["prompt_preflight.generation_method"], "cli");
    assert.equal(requestAttributes["prompt_preflight.timeout_ms"], 120000);
    assert.equal(typeof requestAttributes["llm.request.user"], "string");
    assert.ok(request.traceId, "llm.request traceId missing");
    assert.ok(request.spanId, "llm.request spanId missing");
    assert.equal(responseAttributes["gen_ai.usage.input_tokens"], 10);
    assert.equal(responseAttributes["gen_ai.usage.output_tokens"], 5);
    assert.equal(typeof responseAttributes["llm.response.text"], "string");
    const llmSpan = records.find((record) => record.recordType === "span" && record.name === "llm.call");
    assert.ok(llmSpan, "llm.call span missing");
    assert.equal(llmSpan.kind, "CLIENT");
    assert.equal((llmSpan.status as { code?: string }).code, "OK");
    assert.equal(llmSpan.traceId, request.traceId);
    assert.equal(llmSpan.spanId, request.spanId);
  } finally {
    await config.update("debug", false, vscode.ConfigurationTarget.Global);
    await config.update("debugLogDir", before.debugLogDir, vscode.ConfigurationTarget.Global);
    await config.update("claudePath", before.claudePath, vscode.ConfigurationTarget.Global);
    await config.update("pauseMs", before.pauseMs, vscode.ConfigurationTarget.Global);
    await config.update("quickModel", before.quickModel, vscode.ConfigurationTarget.Global);
    await config.update("provider", before.provider, vscode.ConfigurationTarget.Global);
    await config.update("thinkingEffort", before.thinkingEffort, vscode.ConfigurationTarget.Global);
    await config.update("quickReviewOnPause", before.quickReviewOnPause, vscode.ConfigurationTarget.Global);
    await sleep(200);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.dirname(cli), { recursive: true, force: true });
  }
});

export async function run(): Promise<void> {
  const failures: Array<{ name: string; error: unknown }> = [];
  for (const item of tests) {
    try {
      await item.run();
      console.log(`ok - ${item.name}`);
    } catch (error) {
      failures.push({ name: item.name, error });
      console.error(`not ok - ${item.name}`);
      console.error(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} e2e test(s) failed: ${failures.map((failure) => failure.name).join(", ")}`);
  }
  console.log(`${tests.length} e2e tests passed`);
}

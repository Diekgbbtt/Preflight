import { mkdtemp, writeFile, chmod, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { hashPrompt } from "@prompt-preflight/core";
import { PromptPanel } from "../src/panel";
import type { WorkspaceIndex } from "../src/workspace";
import { StudyLog } from "../src/studyLog";
import type * as vscode from "vscode";

const platform = vi.hoisted(() => {
  const settings: Record<string, unknown> = {};
  const uri = (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` });
  return { settings, Uri: { file: uri, joinPath: (base: { fsPath: string }, ...parts: string[]) => uri([base.fsPath, ...parts].join("/")), parse: uri },
    workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }) },
    env: { clipboard: { writeText: vi.fn(async () => {}) }, openExternal: vi.fn() },
    commands: { executeCommand: vi.fn() },
    window: { showWarningMessage: vi.fn(async () => "Send anyway"), showInformationMessage: vi.fn() },
  };
});
vi.mock("vscode", () => ({ ...platform, default: platform }));
let dir: string;
let receive: (message: unknown) => Promise<void>;
let panel: PromptPanel;
let messages: any[];
let events: any[];
type TestPanel = { runReview(mode: "quick" | "deep"): Promise<unknown>; captureAgentUsage(links: { draftId: string; sendId: string; sessionId: string }): Promise<void> };
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "preflight-panel-"));
  platform.settings.gateSending = false;
  platform.settings.sendTo = "clipboard";
  platform.settings.quickReviewOnPause = true; // Even a legacy opt-in must not start inference.
  platform.env.clipboard.writeText.mockClear(); platform.window.showWarningMessage.mockClear();
  const cli = path.join(dir, "fake-claude");
  await writeFile(cli, '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({result:JSON.stringify(process.argv.join(" ").includes("improvedPrompt")?{improvedPrompt:"Add greet to [target]"}:process.argv.join(" ").includes("contextGaps")?{issues:[],questions:[{question:"Which target?",why:"Locate the change",options:[]}],assumptions:[],contextGaps:[]}:{dimensions:{target:25,action:25,scope:25,done:25},issues:[],questions:[]}),usage:{input_tokens:12,output_tokens:7},total_cost_usd:0.002})));\n');
  await chmod(cli, 0o755);
  platform.settings.claudePath = cli;
  events = []; messages = [];
  const log = { enabled: true, write: async (event: string, links: unknown, data: unknown) => { events.push({ event, ...links as object, ...data as object }); } } as unknown as StudyLog;
  const uri = platform.Uri.file(dir) as vscode.Uri;
  panel = new PromptPanel(uri, { root: dir, context: () => ({}), notes: () => "" } as unknown as WorkspaceIndex, log, uri, path.join(dir, "home"));
  panel.resolveWebviewView({ webview: { options: {}, cspSource: "", asWebviewUri: () => "", postMessage: (m: unknown) => messages.push(m), onDidReceiveMessage: (fn: typeof receive) => { receive = fn; } }, onDidChangeVisibility: () => {} } as unknown as vscode.WebviewView);
});
afterEach(async () => {
  panel.setText("");
  await rm(dir, { recursive: true, force: true });
});
it("sends exactly the typed draft without a default modal or rule score", async () => {
  const text = "  Improve it with sk-1234567890abcdefghij [value]\n";
  panel.setText(text);
  await receive({ type: "send" });
  expect(platform.window.showWarningMessage).not.toHaveBeenCalled();
  expect(platform.env.clipboard.writeText).toHaveBeenCalledWith(text);
  const send = events.find(e => e.event === "send");
  expect(send).toMatchObject({ firstScore: null, finalScore: null, scoreAvailable: false });
  expect(send).not.toHaveProperty("prompt");
  expect(JSON.parse((await readFile(path.join(dir, "sends.jsonl"), "utf8")).trim()).text).toBe(text);
});
it("keeps explicit model observations linked to later sends", async () => {
  platform.settings.gateSending = true;
  panel.setText("Add a test in src/login.ts that expects a 200 status");
  await (panel as unknown as TestPanel).runReview("quick");
  await receive({ type: "send" });
  expect(platform.window.showWarningMessage).not.toHaveBeenCalled();
  const send = events.find(e => e.event === "send");
  expect(send).toMatchObject({ firstScore: 100, finalScore: 100, scoreSource: "quick", preflightInputTokens: 12, preflightOutputTokens: 7, agentInputTokens: null });
  for (const event of events) expect(event.sendId).toBe(send.sendId);
  expect(events.map(e => e.event)).toEqual(["score", "review", "send"]);
  expect(messages.some(m => m.type === "score" && m.state === "scored")).toBe(true);
});
it("keeps typing advice quiet until a pause and ignores malformed bridge messages", async () => {
  vi.useFakeTimers();
  try {
    await receive(null); await receive({ type: "input", text: 3 }); await receive({ type: "unknown" });
    panel.setText("Improve it");
    expect(messages.filter(m => m.type === "analysis").at(-1).feedback).toBeNull();
    await vi.advanceTimersByTimeAsync(10000);
    expect(messages.filter(m => m.type === "analysis").at(-1).feedback.findings.length).toBeGreaterThan(0);
    expect(events).toHaveLength(0);
    expect(Object.keys((panel as unknown as { running: object }).running)).toEqual([]);
  } finally { vi.useRealTimers(); }
});
it("discards a completed review after the draft changes", async () => {
  panel.setText("Add greet to src/a.ts and test the result");
  const pending = (panel as unknown as TestPanel).runReview("quick");
  panel.setText("A different draft");
  await pending;
  expect(events).toHaveLength(0);
  expect(messages.some(m => m.type === "score" && m.state === "scored")).toBe(false);
});
it("Send does not wait for a running model review", async () => {
  platform.settings.gateSending = true;
  panel.setText("Add greet to src/a.ts and test the result");
  const pending = (panel as unknown as TestPanel).runReview("quick");
  await receive({ type: "send" }); await pending;
  expect(events.filter(e => e.event === "score")).toHaveLength(0);
  expect(events.filter(e => e.event === "send")).toHaveLength(1);
});
it("attaches separately accounted transcript usage to the exact send id", async () => {
  panel.setText("Add greet to src/a.ts and test the result");
  await (panel as unknown as TestPanel).runReview("quick");
  await receive({ type: "send" });
  const send = events.find(e => e.event === "send");
  const sessionId = "test-session";
  const project = dir.replace(/[^A-Za-z0-9_-]/g, "-");
  const folder = path.join(dir, "home", ".claude", "projects", project);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${sessionId}.jsonl`), JSON.stringify({ type: "assistant", sessionId, cwd: dir, message: { id: "msg-1", role: "assistant", usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }, content: [] } }) + "\n");
  await (panel as unknown as TestPanel).captureAgentUsage({ draftId: send.draftId, sendId: send.sendId, sessionId });
  expect(events.find(e => e.event === "agent-usage")).toMatchObject({ sendId: send.sendId, sessionId, agentInputTokens: 20, agentOutputTokens: 9, agentCacheReadTokens: 100, agentCacheCreationTokens: 50, agentCostUsd: null, usageAvailable: true });
  expect(send.preflightInputTokens).toBe(12);
});

it("preserves the separate rewrite workflow without a deep score", async () => {
  panel.setText("Add greet to an appropriate module");
  await receive({ type: "deepReview" });
  const deep = messages.find(m => m.type === "review" && m.mode === "deep").review;
  expect(deep).not.toHaveProperty("score"); expect(deep).not.toHaveProperty("improvedPrompt");
  await receive({ type: "improve" });
  expect(messages.find(m => m.type === "improved").improved).toBe("Add greet to [target]");
  await receive({ type: "useImproved" });
  expect(messages.filter(m => m.type === "setText").at(-1).text).toBe("Add greet to [target]");
});
it("uses local warnings for opt-in confirmation without calling the model", async () => {
  platform.settings.gateSending = true;
  await writeFile(platform.settings.claudePath as string, '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({result:"not json"})));\n');
  panel.setText("Improve it");
  await receive({ type: "send" });
  expect(platform.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("local checks"), { modal: true }, "Send anyway");
  expect(events.find(e => e.event === "send").finalScore).toBeNull();
  expect(events.some(e => e.event === "review" || e.event === "score")).toBe(false);
});
it("does not send a draft edited while confirmation is open", async () => {
  platform.settings.gateSending = true;
  panel.setText("Improve it");
  const pending = receive({ type: "send" });
  panel.setText("New draft while scoring");
  await pending;
  expect(platform.env.clipboard.writeText).not.toHaveBeenCalled();
  expect(events.some(e => e.event === "send")).toBe(false);
});
it("resumes legacy migration without importing the same line again", async () => {
  platform.settings["studyLog.enabled"] = true;
  await writeFile(path.join(dir, "study-log.jsonl"), JSON.stringify({ event: "send", ts: "2026-11-18T00:00:00Z", prompt: "old", finalScore: 95 }) + "\n");
  const links = { draftId: "d", sendId: "s", sessionId: null };
  await new StudyLog(platform.Uri.file(dir) as vscode.Uri).write("send", links, {});
  await new StudyLog(platform.Uri.file(dir) as vscode.Uri).write("outcome", links, { outcome: "passed" });
  const rows = (await readFile(path.join(dir, "study-events-v2.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(rows).toHaveLength(3);
  expect(rows.filter(row => row.id === "legacy-1")).toHaveLength(1);
  expect(rows[0]).toMatchObject({ firstScore: null, finalScore: null, legacyRuleScore: 95 });
});

it("Enhance explicitly reviews and rewrites without changing the draft until applied", async () => {
  panel.setText("Improve the greeting");
  await receive({ type: "enhance" });
  expect(events.filter(e => e.event === "review")).toHaveLength(2);
  expect(messages.find(m => m.type === "improved").improved).toBe("Add greet to [target]");
  expect(messages.filter(m => m.type === "setText").at(-1).text).toBe("Improve the greeting");
  await receive({ type: "useImproved" });
  expect(messages.filter(m => m.type === "setText").at(-1).text).toBe("Add greet to [target]");
});

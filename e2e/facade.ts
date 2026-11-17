// Test facade for the VS Code extension-host suite. It wires the real
// control-plane modules to the real VS Code APIs; only the model CLI and the
// fixture workspace are substituted.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  DEEP_REPLY_SCHEMA,
  QUICK_REPLY_SCHEMA,
  RUBRIC_TEXT,
  assemble,
  canImprove,
  claudeCliRunner,
  estimateTokens,
  findPromptFileRefs,
  hashPrompt,
  improvePrompt,
  parseDeepReview,
  parseQuickReview,
  type ContextBundle,
  type DeepReview,
  type QuickReview,
} from "@prompt-preflight/core";
import { createCodeTools, type CodebaseTools } from "../extension/src/codeTools";
import { createGitDiffSource, createPromptFilesSource, createTestCommandSource } from "../extension/src/contextSources";
import { resolvePromptFileRefs } from "../extension/src/promptFiles";
import { redact, type IncludeCode } from "../extension/src/privacy";
import { JsonlRepository } from "../extension/src/repository";
import { bundledRipgrepPath } from "../extension/src/ripgrep";
import { DEFAULT_SESSION_CAPS, discoverCandidates, readSlice, type SessionSlice } from "../extension/src/sessionSlice";
import { createVscodeLanguageApi } from "../extension/src/vscodeLanguageApi";

export function workspaceRoot(): string {
  return process.env.PREFLIGHT_E2E_WORKSPACE ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

export function folderUri(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? vscode.Uri.file(workspaceRoot()).toString();
}

export interface AssembleInput {
  draft: string;
  qa: Array<{ question: string; answer: string }>;
  includeCode: IncludeCode;
  readText?: (uri: vscode.Uri) => Promise<string>;
}

/** Assembles the real context sources for the opened workspace. */
export async function assembleContext(input: AssembleInput): Promise<ContextBundle> {
  const folders = [...(vscode.workspace.workspaceFolders ?? [])];
  const roots = folders.map((folder) => ({ uri: folder.uri.toString(), fsPath: folder.uri.fsPath }));
  const refs = findPromptFileRefs(input.draft).map((ref) => ref.text);
  const exists = async (fsPath: string): Promise<boolean> => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
      return true;
    } catch {
      return false;
    }
  };
  const resolution = await resolvePromptFileRefs(refs, roots, exists);
  const policy = { includeCode: input.includeCode, promptFiles: resolution.files.map((file) => file.path) };
  const sources = [
    createPromptFilesSource({
      folders,
      policy,
      draft: input.draft,
      ...(input.readText ? { readText: input.readText } : {}),
    }),
  ];
  if (folders[0]) {
    sources.push(createGitDiffSource({ folder: folders[0], policy }));
    sources.push(createTestCommandSource({ folder: folders[0], policy }));
  }
  return assemble({ draft: input.draft, qa: input.qa }, sources, {
    budget: 12_000,
    estimateTokens,
    redact,
  });
}

/** Runs the quick review through the fake CLI and parses the reply. */
export async function quickReview(draft: string, cliPath: string): Promise<QuickReview> {
  const runner = claudeCliRunner(cliPath, workspaceRoot(), "high");
  const res = await runner({
    system: `You review prompts. Reply with JSON only.\n${QUICK_REPLY_SCHEMA}`,
    user: `<prompt>\n${draft}\n</prompt>`,
    model: "sonnet",
  });
  return parseQuickReview(res.text, draft, {
    provider: "claude",
    model: "sonnet",
    thinkingEffort: "high",
    scoredAt: new Date().toISOString(),
  });
}

/** Runs the deep review through the fake CLI and parses the reply. */
export async function deepReview(draft: string, cliPath: string): Promise<DeepReview> {
  const runner = claudeCliRunner(cliPath, workspaceRoot(), "high");
  const res = await runner({
    system: `You coach a student on prompts. Reply with JSON only.\n${RUBRIC_TEXT}\n${DEEP_REPLY_SCHEMA}`,
    user: `<prompt>\n${draft}\n</prompt>`,
    model: "sonnet",
  });
  return parseDeepReview(res.text, draft, {
    usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd },
    latency: 0,
  });
}

/** Runs the separate improved-prompt action. */
export async function improvedPrompt(draft: string, review: DeepReview, cliPath: string) {
  const runner = claudeCliRunner(cliPath, workspaceRoot(), "high");
  return improvePrompt(draft, review, [], runner, "sonnet", { now: () => Date.now() });
}

export function canImproveDeep(review: DeepReview): boolean {
  return canImprove(review);
}

export function promptHash(draft: string): string {
  return hashPrompt(draft);
}

export interface WorkspaceTools {
  api: ReturnType<typeof createVscodeLanguageApi>;
  tools: CodebaseTools;
}

/** Creates the LSP tools for the opened workspace and the bundled rg binary. */
export function workspaceTools(): WorkspaceTools {
  const extensionPath = process.env.PREFLIGHT_E2E_EXTENSION;
  const rgPath = process.env.PREFLIGHT_E2E_RG ?? (extensionPath ? bundledRipgrepPath(extensionPath) : undefined);
  const api = createVscodeLanguageApi({ cwd: workspaceRoot(), rgPath });
  const tools = createCodeTools({
    protocol: api,
    textSearch: api,
    policy: { includeCode: "workspace" },
    cwd: workspaceRoot(),
  });
  return { api, tools };
}

/** Creates a JSONL repository at the given file path. */
export function repository<T>(filePath: string): JsonlRepository<T> {
  return new JsonlRepository<T>(filePath);
}

/** Creates a fake Claude CLI that answers quick, deep, and improve requests. */
export async function createFakeCli(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-e2e-cli-"));
  const file = path.join(dir, "fake-claude.mjs");
  const script = `#!/usr/bin/env node
const systemIndex = process.argv.indexOf("--system-prompt");
const system = systemIndex >= 0 ? process.argv[systemIndex + 1] : "";
const result = system.includes("improvedPrompt")
  ? JSON.stringify({ improvedPrompt: "Fix the login bug so that [expected result]" })
  : system.includes("assumptions") && system.includes("contextGaps")
    ? JSON.stringify({
        issues: [{ quote: "login", problem: "No expected result", suggestion: "State it" }],
        questions: [{ question: "What should happen?", why: "Done needs a goal", options: ["Redirect", "Error"] }],
        assumptions: [],
        contextGaps: [],
      })
    : JSON.stringify({
        dimensions: { target: 20, action: 25, scope: 20, done: 25 },
        confidence: 0.8,
        issues: [],
        questions: [],
      });
process.stdout.write(JSON.stringify({
  result,
  usage: { input_tokens: 10, output_tokens: 5 },
  total_cost_usd: 0.001,
}));
`;
  await fs.writeFile(file, script, "utf8");
  await fs.chmod(file, 0o755);
  return file;
}

/** Reads the first discovered session slice under a seeded home directory. */
export async function readSeededSlice(input: {
  homeDir: string;
  folderUri: string;
  includeCode: IncludeCode;
  promptFiles: string[];
}): Promise<SessionSlice> {
  const candidates = await discoverCandidates(input.folderUri, input.homeDir);
  if (candidates.length === 0) throw new Error("no seeded session candidate");
  return readSlice(candidates[0].filePath, candidates[0].provider, DEFAULT_SESSION_CAPS, { now: () => Date.now() }, {
    includeCode: input.includeCode,
    promptFiles: input.promptFiles,
    redact,
  });
}

/** Creates a temporary home directory for session fixtures. */
export async function makeHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "preflight-e2e-home-"));
}

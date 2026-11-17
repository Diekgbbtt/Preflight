// Bounded current-session slice reader (ticket #38).
// Discovers Claude and Codex session files, parses the public JSONL formats
// into a derived SessionSlice, and applies the privacy policy and redaction.
// No vscode import, no picker, and no raw transcript leaves this module.
import * as os from "node:os";
import * as path from "node:path";
import { open, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Event, ModelCapabilities, SendRecord } from "@prompt-preflight/core";
import { estimateTokens, SOURCE_PRIORITIES, type Clock, type ContextSource, type ContextSourceResult } from "@prompt-preflight/core";
import { canonicalFolderUri, locateSession, type SessionCandidate, type SessionProvider } from "./sessionLocator";
import { shouldInclude, type IncludeCode } from "./privacy";

/** Caps for one slice: turns kept, token budget, and the byte window. */
export interface SessionCaps {
  maxTurns: number;
  maxTokens: number;
  maxBytes: number;
}

export const DEFAULT_SESSION_CAPS: SessionCaps = { maxTurns: 10, maxTokens: 8000, maxBytes: 5000000 };

/** One retained conversation turn. Text stays; code is extracted for the policy. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
  at?: string;
  code?: string[];
  codePath?: string;
}

/** One tool call summary. Always one line. */
export interface ToolCall {
  name: string;
  status: "ok" | "error" | "unknown";
  summary: string;
  at?: string;
}

/** One error observed in the session, with its final status. */
export interface SessionError {
  message: string;
  status: "error" | "resolved" | "unknown";
  at?: string;
}

/** One test run observed in the session, with its final status. */
export interface TestResult {
  name: string;
  status: "passed" | "failed" | "skipped" | "unknown";
  at?: string;
}

/** Traceability record for one slice. */
export interface SessionProvenance {
  sourcePath: string;
  bytesRead: number;
  turnsKept: number;
  truncated: boolean;
  droppedTurns: number;
  droppedToolCalls: number;
  droppedFiles: number;
  redactions: number;
  reason?: "unsupported" | "empty" | "error";
}

/** The derived slice. This, never the transcript, leaves the reader. */
export interface SessionSlice {
  sessionId: string;
  provider: SessionProvider;
  folderUri: string;
  startedAt: string | null;
  endedAt: string | null;
  turns: Turn[];
  toolCalls: ToolCall[];
  errors: SessionError[];
  testResults: TestResult[];
  changedFiles: string[];
  tokens: number;
  truncated: boolean;
  provenance: SessionProvenance;
}

/** What a parser produced from complete lines only. */
export interface ParsedSession {
  sessionId?: string;
  folderUri?: string;
  startedAt?: string;
  endedAt?: string;
  turns: Turn[];
  toolCalls: ToolCall[];
  errors: SessionError[];
  testResults: TestResult[];
  changedFiles: string[];
}

const EMPTY_PARSED = (): ParsedSession => ({ turns: [], toolCalls: [], errors: [], testResults: [], changedFiles: [] });

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

/** Commands that look like a test run. */
const TEST_COMMAND_PATTERN = /\btest\b|\bpytest\b|\bvitest\b|\bjest\b|\bcargo test\b|\bgo test\b/i;

/** Tool input keys that name a changed file. */
const FILE_KEYS = ["file_path", "path", "notebook_path"] as const;

/** Collapses a summary to one bounded line. */
function oneLine(text: string, max = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** First line of a result, for error messages. */
function firstLine(text: string, max = 200): string {
  return oneLine(text.split("\n")[0] ?? "", max);
}

/** True when a command string looks like a test run. */
function looksLikeTest(command: string): boolean {
  return TEST_COMMAND_PATTERN.test(command);
}

/** Tool names that mutate files, never test runners. */
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

/** True when a tool call is a test run: decide from the command, never from a path in a summary. */
function isTestCall(name: string, input: Record<string, unknown>): boolean {
  if (FILE_TOOLS.has(name)) return false;
  const command = input.command;
  if (typeof command === "string" && command.trim()) return looksLikeTest(command);
  if (Array.isArray(command)) {
    const joined = command.filter((part) => typeof part === "string").join(" ");
    if (joined.trim()) return looksLikeTest(joined);
  }
  return false;
}

/** Parses an opaque arguments blob into an object when possible. */
function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/** A short human-readable description of a tool input, for the summary. */
function describeInput(input: Record<string, unknown>): string | undefined {
  const command = input.command;
  if (typeof command === "string" && command.trim()) return oneLine(command);
  if (Array.isArray(command)) {
    const joined = command.filter((part) => typeof part === "string").join(" ");
    if (joined.trim()) return oneLine(joined);
  }
  for (const key of FILE_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  return undefined;
}

/** Plain text of a tool result payload. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
          return (block as Record<string, unknown>).text as string;
        }
        return "";
      })
      .join("\n");
  }
  if (content && typeof content === "object" && typeof (content as Record<string, unknown>).output === "string") {
    return (content as Record<string, unknown>).output as string;
  }
  return "";
}

/** Extracts the workspace-relative path token from a fence info line, e.g. "ts src/greet.ts". */
function pathFromFenceInfo(info: string): string | undefined {
  for (const token of info.trim().split(/\s+/)) {
    if (!token) continue;
    if (token.includes("/") || /\.[A-Za-z0-9]+$/.test(token)) return token;
  }
  return undefined;
}

/** Splits fenced code blocks out of turn text; returns code items, their paths and the remaining text. */
function extractFences(text: string): { code: string[]; paths: Array<string | undefined>; rest: string } {
  const code: string[] = [];
  const paths: Array<string | undefined> = [];
  const rest = text.replace(/```[^\S\n]*([^\n]*)\n([\s\S]*?)```/g, (_all, info: string, body: string) => {
    code.push(body.replace(/\n$/, ""));
    paths.push(pathFromFenceInfo(info));
    return "";
  });
  return { code, paths, rest };
}

/** Extracts the first file path from an apply_patch-style patch body. */
function patchFileFrom(patch: string): string | undefined {
  const match = patch.match(/^\*\*\* (?:Update|Add) File: (.+)$/m);
  const file = match?.[1]?.trim();
  return file || undefined;
}

// ---------------------------------------------------------------------------
// Shared parse walk state
// ---------------------------------------------------------------------------

interface ParserState {
  sessionId?: string;
  cwd?: string;
  startedAt?: string;
  endedAt?: string;
  turns: Turn[];
  toolCalls: ToolCall[];
  pending: Map<string, number>;
  changedFiles: string[];
  /** Displayed file path observed inside each turn, parallel to turns. */
  turnFiles: string[][];
  testOrder: string[];
  testStatus: Map<string, { status: TestResult["status"]; at?: string }>;
  /** Per tool call: whether it is a test run, parallel to toolCalls. */
  isTestOf: boolean[];
  errors: SessionError[];
}

const newState = (): ParserState => ({
  turns: [],
  toolCalls: [],
  pending: new Map(),
  changedFiles: [],
  turnFiles: [],
  testOrder: [],
  testStatus: new Map(),
  isTestOf: [],
  errors: [],
});

/** Touches the started/ended timestamps with one line's timestamp. */
function stamp(state: ParserState, timestamp: unknown): void {
  if (typeof timestamp !== "string" || timestamp === "") return;
  if (!state.startedAt) state.startedAt = timestamp;
  state.endedAt = timestamp;
}

/** Shows a file path relative to the session cwd when it is inside it. */
function displayPath(raw: string, cwd: string | undefined): string {
  if (!cwd || !raw) return raw;
  if (!/^[A-Za-z]:[\\/]/.test(raw) && !raw.startsWith("/")) return raw;
  const rel = path.relative(cwd, raw);
  return rel === "" ? raw : rel;
}

/** Records changed file paths of one tool input; returns their displayed forms. */
function changedFromInput(input: Record<string, unknown>, state: ParserState): string[] {
  const shown: string[] = [];
  for (const key of FILE_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim() && !state.changedFiles.includes(value)) {
      state.changedFiles.push(value);
      shown.push(displayPath(value, state.cwd));
    }
  }
  return shown;
}

/** Records a patch-file change; returns its displayed form. */
function changedFromPatch(file: string, state: ParserState): string | undefined {
  if (!file || state.changedFiles.includes(file)) return undefined;
  state.changedFiles.push(file);
  return displayPath(file, state.cwd);
}

/** Marks a tool call's result; records errors and test results with final status. */
function applyResult(state: ParserState, callIndex: number, ok: boolean, output: string, at: string | undefined): void {
  const call = state.toolCalls[callIndex];
  if (!call) {
    // A failed result whose call is unknown (e.g. cut by the byte window)
    // still shows as an error; never invent a tool call for it.
    if (!ok) state.errors.push({ message: firstLine(output) || "tool call failed", status: "error", at });
    return;
  }
  call.status = ok ? "ok" : "error";
  if (state.isTestOf[callIndex]) {
    state.testStatus.set(call.summary, { status: ok ? "passed" : "failed", at: call.at });
  }
  if (ok) {
    // A later successful call means earlier errors were addressed.
    for (const error of state.errors) {
      if (error.status === "error") error.status = "resolved";
    }
  } else {
    state.errors.push({ message: firstLine(output) || `${call.name} failed`, status: "error", at });
  }
}

/** Adds a tool call with its pending-link index and test bookkeeping. Ownership is resolved later by timestamp. */
function registerCall(state: ParserState, call: ToolCall, isTest: boolean): void {
  state.toolCalls.push(call);
  state.isTestOf.push(isTest);
  if (isTest && !state.testStatus.has(call.summary)) {
    state.testOrder.push(call.summary);
    state.testStatus.set(call.summary, { status: "unknown", at: call.at });
  }
}

/** Extracts fenced code per turn and removes it from the turn text. */
function finalizeTurns(state: ParserState): void {
  const out: Turn[] = [];
  state.turns.forEach((turn, index) => {
    const { code, paths, rest } = extractFences(turn.text);
    if (code.length === 0) {
      out.push({ ...turn, text: turn.text.trim() });
      return;
    }
    // Group fences by path so every code item in a turn shares one codePath.
    const groups = new Map<string, string[]>();
    const order: string[] = [];
    code.forEach((body, i) => {
      const key = paths[i] ?? state.turnFiles[index]?.[0] ?? "";
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key)!.push(body);
    });
    const clean = rest.replace(/\n{3,}/g, "\n\n").trim();
    const firstKey = order[0];
    const firstCode = groups.get(firstKey)!;
    out.push({
      ...turn,
      text: clean,
      code: firstCode,
      ...(firstKey ? { codePath: firstKey } : {}),
    });
    // Fences bound for another file become code-only turns with their own path.
    for (const key of order.slice(1)) {
      out.push({
        role: turn.role,
        text: "",
        ...(turn.at ? { at: turn.at } : {}),
        code: groups.get(key)!,
        ...(key ? { codePath: key } : {}),
      });
    }
  });
  state.turns = out;
}

/** Fills a ParsedSession from the parse state. */
function finish(state: ParserState): ParsedSession {
  finalizeTurns(state);
  const parsed = EMPTY_PARSED();
  parsed.sessionId = state.sessionId;
  parsed.startedAt = state.startedAt;
  parsed.endedAt = state.endedAt;
  parsed.turns = state.turns;
  parsed.toolCalls = state.toolCalls;
  parsed.errors = state.errors;
  parsed.testResults = state.testOrder.map((name) => {
    const final = state.testStatus.get(name);
    return { name, status: final?.status ?? "unknown", at: final?.at };
  });
  parsed.changedFiles = state.changedFiles;
  if (state.cwd) {
    try {
      parsed.folderUri = canonicalFolderUri(pathToFileURL(state.cwd).href);
    } catch {
      parsed.folderUri = undefined;
    }
  }
  return parsed;
}

/** The turn index the next same-role message merges into, or would create. */
function nextTurnIndex(state: ParserState, role: Turn["role"]): { index: number; merges: boolean } {
  const previous = state.turns[state.turns.length - 1];
  if (previous && previous.role === role) return { index: state.turns.length - 1, merges: true };
  return { index: state.turns.length, merges: false };
}

/** Commits one message's text to its predicted turn. */
function commitTurn(state: ParserState, role: Turn["role"], text: string, at: string | undefined, plan: { index: number; merges: boolean }): void {
  if (plan.merges) {
    if (text) {
      const previous = state.turns[plan.index];
      previous.text = previous.text ? `${previous.text}\n${text}` : text;
    }
    return;
  }
  state.turns.push({ role, text, at });
  state.turnFiles.push([]);
}

// ---------------------------------------------------------------------------
// Claude format
// ---------------------------------------------------------------------------

/**
 * Parses a Claude Code session transcript (public JSONL format) into a
 * ParsedSession. Pure: takes complete-line text, skips corrupt and malformed
 * lines, and never throws.
 */
export function parseClaudeSession(text: string): ParsedSession {
  const state = newState();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    stamp(state, entry.timestamp);
    if (typeof entry.sessionId === "string" && entry.sessionId && !state.sessionId) state.sessionId = entry.sessionId;
    if (typeof entry.cwd === "string" && entry.cwd) state.cwd = entry.cwd;

    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    const content = msg.content;
    const role = entry.type as Turn["role"];

    if (!Array.isArray(content) && typeof content !== "string") continue;

    // User messages that carry tool results update call status; they never
    // create a turn and they separate assistant runs.
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_result") continue;
        const callIndex = typeof b.tool_use_id === "string" ? state.pending.get(b.tool_use_id) : undefined;
        applyResult(state, callIndex ?? -1, b.is_error !== true, resultText(b.content), state.endedAt);
        if (callIndex !== undefined && typeof b.tool_use_id === "string") state.pending.delete(b.tool_use_id);
      }
      if (role === "user" && !content.some((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text")) {
        continue;
      }
    }

    // The turn this message merges into, known before any tool bookkeeping.
    const plan = nextTurnIndex(state, role);

    // Extract the visible text and tool calls of this message.
    let text = "";
    const messageFiles: string[] = [];
    let hadCalls = false;
    if (typeof content === "string") {
      text = content;
    } else {
      const parts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        } else if (b.type === "tool_use") {
          const name = typeof b.name === "string" ? b.name : "tool";
          const input = asObject(b.input) ?? {};
          const described = describeInput(input);
          const call: ToolCall = {
            name,
            status: "unknown",
            summary: oneLine(`${name}${described ? ` ${displayPath(described, state.cwd)}` : ""}`),
            at: state.endedAt,
          };
          registerCall(state, call, isTestCall(name, input));
          if (typeof b.id === "string") state.pending.set(b.id, state.toolCalls.length - 1);
          // Only mutation tools contribute changed files; reads stay summary-only.
          if (FILE_TOOLS.has(name)) messageFiles.push(...changedFromInput(input, state));
          hadCalls = true;
        }
        // thinking blocks are ignored.
      }
      text = parts.join("\n");
    }
    text = text.trim();
    if (!text && !hadCalls) continue;
    commitTurn(state, role, text, state.endedAt, plan);
    for (const shown of messageFiles) state.turnFiles[plan.index]?.push(shown);
  }
  return finish(state);
}

// ---------------------------------------------------------------------------
// Codex format
// ---------------------------------------------------------------------------

/**
 * Parses a Codex session rollout (public JSONL event format) into a
 * ParsedSession. Pure and defensive, same guarantees as the Claude parser.
 */
export function parseCodexSession(text: string): ParsedSession {
  const state = newState();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    stamp(state, entry.timestamp);
    const payload = asObject(entry.payload);
    if (!payload) continue;

    if (entry.type === "session_meta") {
      if (typeof payload.id === "string" && payload.id && !state.sessionId) state.sessionId = payload.id;
      if (typeof payload.cwd === "string" && payload.cwd) state.cwd = payload.cwd;
      if (typeof payload.timestamp === "string" && !state.startedAt) state.startedAt = payload.timestamp;
      continue;
    }
    // Exec event messages carry command runs when the public format emits them.
    if (entry.type === "event_msg") {
      const eventType = payload.type;
      if (eventType === "exec_command_begin") {
        const name = typeof payload.name === "string" && payload.name ? payload.name : "exec";
        const input: Record<string, unknown> = { command: payload.command };
        const described = describeInput(input);
        const call: ToolCall = {
          name,
          status: "unknown",
          summary: oneLine(`${name}${described ? ` ${described}` : ""}`),
          at: state.endedAt,
        };
        registerCall(state, call, isTestCall(name, input));
        if (typeof payload.call_id === "string") state.pending.set(payload.call_id, state.toolCalls.length - 1);
        continue;
      }
      if (eventType === "exec_command_end") {
        const callIndex = typeof payload.call_id === "string" ? state.pending.get(payload.call_id) : undefined;
        const exit = typeof payload.exit_code === "number" ? payload.exit_code : undefined;
        const ok = exit === undefined ? payload.is_error !== true : exit === 0;
        const output = resultText(payload.output ?? payload.aggregated_output);
        applyResult(state, callIndex ?? -1, ok, output, state.endedAt);
        if (callIndex !== undefined && typeof payload.call_id === "string") state.pending.delete(payload.call_id);
        continue;
      }
      // Unknown event_msg types are skipped.
      continue;
    }
    if (entry.type !== "response_item") continue;

    const itemType = payload.type;
    if (itemType === "message") {
      const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : undefined;
      if (!role) continue;
      const parts: string[] = [];
      const content = payload.content;
      if (typeof content === "string") parts.push(content);
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
            parts.push((block as Record<string, unknown>).text as string);
          }
        }
      }
      const text = parts.join("\n").trim();
      if (!text) continue;
      commitTurn(state, role, text, state.endedAt, nextTurnIndex(state, role));
      continue;
    }
    if (itemType === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const argsRaw = payload.arguments;
      const input = asObject(argsRaw);
      const ownerIndex = Math.max(0, state.turns.length - 1);
      let described: string | undefined;
      if (input) {
        described = describeInput(input);
        // Only mutation tools contribute changed files; reads stay summary-only.
        if (FILE_TOOLS.has(name)) changedFromInput(input, state);
      } else if (typeof argsRaw === "string" && FILE_TOOLS.has(name)) {
        described = patchFileFrom(argsRaw);
        if (described) changedFromPatch(described, state);
      }
      const call: ToolCall = {
        name,
        status: "unknown",
        summary: oneLine(`${name}${described ? ` ${displayPath(described, state.cwd)}` : ""}`),
        at: state.endedAt,
      };
      registerCall(state, call, isTestCall(name, input ?? {}));
      if (described && FILE_TOOLS.has(name)) state.turnFiles[ownerIndex]?.push(displayPath(described, state.cwd));
      if (typeof payload.call_id === "string") state.pending.set(payload.call_id, state.toolCalls.length - 1);
      continue;
    }
    if (itemType === "function_call_output") {
      const callIndex = typeof payload.call_id === "string" ? state.pending.get(payload.call_id) : undefined;
      const output = resultText(payload.output);
      let ok = payload.is_error !== true;
      const structured = asObject(payload.output);
      if (structured) {
        const meta = asObject(structured.metadata);
        const exit = meta?.exit_code ?? structured.exit_code;
        if (typeof exit === "number" && exit !== 0) ok = false;
      }
      applyResult(state, callIndex ?? -1, ok, output, state.endedAt);
      if (callIndex !== undefined && typeof payload.call_id === "string") state.pending.delete(payload.call_id);
      continue;
    }
    // Unknown response_item and event_msg types are skipped.
  }
  return finish(state);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** True for a Node error meaning the path simply does not exist. */
function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Reads the session_meta payload of a Codex rollout from its first bytes. */
async function readCodexMeta(filePath: string): Promise<{ id?: string; timestamp?: string; cwd?: string }> {
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const head = buf.toString("utf8", 0, bytesRead);
    for (const line of head.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const value: unknown = JSON.parse(trimmed);
        if (value && typeof value === "object" && (value as Record<string, unknown>).type === "session_meta") {
          const payload = asObject((value as Record<string, unknown>).payload) ?? {};
          return {
            id: typeof payload.id === "string" ? payload.id : undefined,
            timestamp: typeof payload.timestamp === "string" ? payload.timestamp : undefined,
            cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
          };
        }
      } catch {
        // Corrupt first line: keep scanning within the head window.
      }
    }
  } finally {
    await handle.close();
  }
  return {};
}

/** Collects .jsonl files under a directory tree; a missing tree yields nothing. */
async function walkJsonl(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkJsonl(full)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/**
 * Discovers Claude and Codex session candidates for one workspace folder.
 * Claude sessions live under the encoded project directory; Codex sessions
 * are found recursively and matched by the cwd in their session metadata.
 * A missing provider directory yields nothing; a permission error throws.
 */
export async function discoverCandidates(folderUri: string, homeDir: string): Promise<SessionCandidate[]> {
  const folder = canonicalFolderUri(folderUri);
  if (!folder.startsWith("file:")) return [];
  let folderPath: string;
  try {
    folderPath = fileURLToPath(folder);
  } catch {
    return [];
  }

  const candidates: SessionCandidate[] = [];

  // Claude: one directory per workspace. Claude encodes the absolute path by
  // replacing path separators with "-" (POSIX: "/Users/x" -> "-Users-x",
  // verified against real directory names in ~/.claude/projects). The Windows
  // drive and separator encoding is a recorded gap, not guessed: discovery on
  // Windows stays unimplemented until verified there.
  const encoded = folderPath.split(path.sep).join("-");
  const claudeDir = path.join(homeDir, ".claude", "projects", encoded);
  let claudeEntries: Dirent[];
  try {
    claudeEntries = await readdir(claudeDir, { withFileTypes: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    claudeEntries = [];
  }
  for (const entry of claudeEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(claudeDir, entry.name);
    const st = await stat(filePath);
    candidates.push({
      sessionId: entry.name.slice(0, -".jsonl".length),
      provider: "claude",
      folderUri: folder,
      filePath,
      mtimeMs: st.mtimeMs,
    });
  }

  // Codex: rollout files nested under date directories, matched by cwd.
  const codexFiles = await walkJsonl(path.join(homeDir, ".codex", "sessions"));
  for (const filePath of codexFiles) {
    const meta = await readCodexMeta(filePath);
    if (!meta.cwd) continue;
    let uri: string;
    try {
      uri = canonicalFolderUri(pathToFileURL(meta.cwd).href);
    } catch {
      continue;
    }
    if (uri !== folder) continue;
    const st = await stat(filePath);
    candidates.push({
      sessionId: meta.id ?? path.basename(filePath, ".jsonl"),
      provider: "codex",
      folderUri: folder,
      filePath,
      mtimeMs: st.mtimeMs,
      ...(meta.timestamp ? { startedAt: meta.timestamp } : {}),
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Slice reading
// ---------------------------------------------------------------------------

/** Policy inputs for one slice read: code inclusion plus injected redaction. */
export interface SliceOptions {
  includeCode: IncludeCode;
  /** Workspace-relative POSIX paths explicitly referenced with @ in the draft. */
  promptFiles?: string[];
  redact(text: string): { text: string; count: number };
}

/** The workspace-relative POSIX path of a raw changed or code path, or null when it is outside. */
function relativeToWorkspace(raw: string, cwdPath: string | undefined): string | null {
  if (!raw) return null;
  let rel = raw;
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/")) {
    if (!cwdPath) return null;
    rel = path.relative(cwdPath, raw);
  }
  const posix = rel.split(path.sep).join("/").replace(/\\/g, "/");
  if (!posix || posix === "." || posix.startsWith("/") || /^[A-Za-z]:\//.test(posix) || posix === ".." || posix.startsWith("../")) return null;
  return posix;
}

/** Builds an empty slice with the given provenance facts. */
function emptySlice(
  filePath: string,
  provider: SessionProvider,
  reason: SessionProvenance["reason"],
  bytesRead: number,
  truncated: boolean,
  parsed?: ParsedSession,
  extra?: Partial<SessionProvenance>,
): SessionSlice {
  return {
    sessionId: parsed?.sessionId ?? path.basename(filePath, ".jsonl"),
    provider,
    folderUri: parsed?.folderUri ?? "",
    startedAt: parsed?.startedAt ?? null,
    endedAt: parsed?.endedAt ?? null,
    turns: [],
    toolCalls: [],
    errors: [],
    testResults: [],
    changedFiles: [],
    tokens: 0,
    truncated,
    provenance: {
      sourcePath: filePath,
      bytesRead,
      turnsKept: 0,
      truncated,
      droppedTurns: 0,
      droppedToolCalls: 0,
      droppedFiles: 0,
      redactions: 0,
      ...(reason ? { reason } : {}),
      ...extra,
    },
  };
}

/**
 * Reads at most the last `maxBytes` of one session file and derives the
 * bounded slice. Never reads the whole file with readFile; a seek that opens
 * mid-line drops the partial first line, a seek on a line boundary keeps it,
 * and a partial final line is dropped, never parsed.
 */
export async function readSlice(
  filePath: string,
  provider: SessionProvider,
  caps: SessionCaps,
  _clock: Clock,
  options: SliceOptions,
): Promise<SessionSlice> {
  void _clock;
  if (provider !== "claude" && provider !== "codex") {
    return emptySlice(filePath, provider, "unsupported", 0, false);
  }

  const st = await stat(filePath).catch(() => null);
  if (!st || !st.isFile()) return emptySlice(filePath, provider, "error", 0, false);
  const size = st.size;
  const start = Math.max(0, size - caps.maxBytes);
  const want = size - start;

  let windowText: string;
  let total = 0;
  try {
    const handle = await open(filePath, "r");
    try {
      // Short reads are possible: loop until the window is filled or EOF.
      const buf = Buffer.alloc(want);
      while (total < want) {
        const { bytesRead } = await handle.read(buf, total, want - total, start + total);
        if (bytesRead <= 0) break;
        total += bytesRead;
      }
      // When the window starts mid-line the byte before it is not a newline;
      // reading it keeps a seek that lands exactly on a line boundary intact.
      let boundaryIsNewline = false;
      if (start > 0) {
        const one = Buffer.alloc(1);
        const peek = await handle.read(one, 0, 1, start - 1);
        if (peek.bytesRead === 1) boundaryIsNewline = one[0] === 0x0a;
      }
      windowText = buf.toString("utf8", 0, total);
      if (start > 0 && !boundaryIsNewline) {
        const nl = windowText.indexOf("\n");
        if (nl < 0) return emptySlice(filePath, provider, "empty", total, true);
        windowText = windowText.slice(nl + 1);
      }
    } finally {
      await handle.close();
    }
  } catch {
    return emptySlice(filePath, provider, "error", 0, false);
  }

  // A final line without a trailing newline may be mid-write: drop, never parse.
  if (!windowText.endsWith("\n")) {
    const last = windowText.lastIndexOf("\n");
    windowText = last < 0 ? "" : windowText.slice(0, last + 1);
  }
  if (windowText.trim() === "") return emptySlice(filePath, provider, "empty", total, start > 0);

  const parsed = provider === "claude" ? parseClaudeSession(windowText) : parseCodexSession(windowText);
  if (parsed.turns.length === 0 && parsed.toolCalls.length === 0 && parsed.errors.length === 0 && parsed.testResults.length === 0) {
    return emptySlice(filePath, provider, "empty", total, start > 0, parsed);
  }

  const cwdPath = sessionCwdPath(parsed.folderUri);

  // Redact tool-call summaries first: they feed the budget, retention and
  // the formatted output, so no raw summary may survive anywhere downstream.
  let redactions = 0;
  const redactedCalls = parsed.toolCalls.map((call) => {
    const applied = options.redact(call.summary);
    redactions += applied.count;
    return { ...call, summary: applied.text };
  });

  // Which parsed turn owns which tool call (matched through timestamps).
  const owners = redactedCalls.map((call) => ownerTurnIndex(parsed, call));
  const ownerIndexes = new Set(owners);

  // Apply the code policy per turn, then redact everything that stays.
  const policyTurns: Turn[] = [];
  const originOf: number[] = [];
  parsed.turns.forEach((turn, index) => {
    const clean: Turn = { role: turn.role, text: turn.text };
    if (turn.at) clean.at = turn.at;
    if (turn.code && turn.code.length > 0 && turn.codePath) {
      const rel = relativeToWorkspace(turn.codePath, cwdPath);
      const keep =
        rel !== null &&
        shouldInclude(rel, "workspace", { includeCode: options.includeCode, promptFiles: options.promptFiles });
      if (keep && rel !== null) {
        clean.code = turn.code.map((item) => {
          const applied = options.redact(item);
          redactions += applied.count;
          return applied.text;
        });
        clean.codePath = rel;
      }
    }
    const appliedText = options.redact(clean.text);
    redactions += appliedText.count;
    clean.text = appliedText.text;
    // A turn without text or code still counts when it owns a tool call.
    if (clean.text || (clean.code && clean.code.length > 0) || ownerIndexes.has(index)) {
      policyTurns.push(clean);
      originOf.push(index);
    }
  });

  // Redact the one-line status records; they are kept regardless of turns.
  // Status records are global: the turn cap never drops them. They count
  // against the token budget through fixedTokens, so when the total exceeds
  // maxTokens the drop loop empties the window and the single-turn check
  // returns the empty truncated slice. A window with no turns at all keeps
  // only these records; there is no turn left to drop.
  const turnTokens = (turn: Turn): number =>
    estimateTokens(turn.text) + (turn.code ?? []).reduce((sum, code) => sum + estimateTokens(code), 0);
  const errors: SessionError[] = parsed.errors.map((error) => {
    const applied = options.redact(error.message);
    redactions += applied.count;
    return { ...error, message: applied.text };
  });
  const testResults: TestResult[] = parsed.testResults.map((result) => {
    const applied = options.redact(result.name);
    redactions += applied.count;
    return { ...result, name: applied.text };
  });
  const fixedTokens =
    errors.reduce((sum, error) => sum + estimateTokens(error.message), 0) +
    testResults.reduce((sum, result) => sum + estimateTokens(result.name), 0);
  const callTokens = (call: ToolCall): number => estimateTokens(call.summary);

  // Cap by turns and tokens across ALL retained content: dropping a turn
  // drops the tool calls it owns.
  const budgetFor = (keptTurns: Turn[]): { calls: ToolCall[]; tokens: number } => {
    const firstKept = keptTurns.length > 0 ? originOf[policyTurns.length - keptTurns.length] : parsed.turns.length;
    const calls = redactedCalls.filter((_call, index) => owners[index] >= firstKept);
    const tokens =
      keptTurns.reduce((sum, turn) => sum + turnTokens(turn), 0) +
      calls.reduce((sum, call) => sum + callTokens(call), 0) +
      fixedTokens;
    return { calls, tokens };
  };

  let kept = policyTurns.slice(-caps.maxTurns);
  let droppedTurns = parsed.turns.length - policyTurns.length + (policyTurns.length - kept.length);
  let retainedCalls: ToolCall[] = [];
  while (kept.length > 1) {
    const budget = budgetFor(kept);
    if (budget.tokens <= caps.maxTokens) {
      retainedCalls = budget.calls;
      break;
    }
    kept.shift();
    droppedTurns++;
  }
  if (kept.length === 1) {
    const budget = budgetFor(kept);
    if (budget.tokens > caps.maxTokens) {
      // One turn alone exceeds the cap: an empty bounded slice is the only safe answer.
      return emptySlice(filePath, provider, "empty", total, true, parsed, {
        droppedTurns: parsed.turns.length,
        droppedToolCalls: parsed.toolCalls.length,
        droppedFiles: 0,
        redactions,
      });
    }
    retainedCalls = budget.calls;
  }
  const droppedToolCalls = parsed.toolCalls.length - retainedCalls.length;
  // Truncation also covers dropped tool calls: a slice that lost calls but
  // kept every turn is still a partial view of the session.
  const truncated = start > 0 || droppedTurns > 0 || droppedToolCalls > 0;

  // Normalize changed files against the session cwd, POSIX, sorted.
  const changedFiles = new Set<string>();
  let droppedFiles = 0;
  for (const raw of parsed.changedFiles) {
    const rel = relativeToWorkspace(raw, cwdPath);
    if (rel === null) droppedFiles++;
    else changedFiles.add(rel);
  }

  const tokens =
    kept.reduce((sum, turn) => sum + turnTokens(turn), 0) +
    retainedCalls.reduce((sum, call) => sum + callTokens(call), 0) +
    errors.reduce((sum, error) => sum + estimateTokens(error.message), 0) +
    testResults.reduce((sum, result) => sum + estimateTokens(result.name), 0);

  return {
    sessionId: parsed.sessionId ?? path.basename(filePath, ".jsonl"),
    provider,
    folderUri: parsed.folderUri ?? "",
    startedAt: parsed.startedAt ?? null,
    endedAt: parsed.endedAt ?? null,
    turns: kept,
    toolCalls: retainedCalls,
    errors,
    testResults,
    changedFiles: [...changedFiles].sort(),
    tokens,
    truncated,
    provenance: {
      sourcePath: filePath,
      bytesRead: total,
      turnsKept: kept.length,
      truncated,
      droppedTurns,
      droppedToolCalls,
      droppedFiles,
      redactions,
    },
  };
}

/** The absolute cwd path behind a parsed folderUri, or undefined. */
function sessionCwdPath(folderUri: string | undefined): string | undefined {
  if (!folderUri || !folderUri.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(folderUri);
  } catch {
    return undefined;
  }
}

/** The parsed turn index a tool call belongs to, matched through timestamps; -1 when unknown. */
function ownerTurnIndex(parsed: ParsedSession, call: ToolCall): number {
  if (!call.at) return -1;
  const callTime = Date.parse(call.at);
  if (Number.isNaN(callTime)) return -1;
  let owner = -1;
  parsed.turns.forEach((turn, index) => {
    if (!turn.at) return;
    const turnTime = Date.parse(turn.at);
    if (Number.isNaN(turnTime) || turnTime > callTime) return;
    owner = index;
  });
  return owner;
}

// ---------------------------------------------------------------------------
// Formatting and the context source
// ---------------------------------------------------------------------------

/** Renders one bounded slice as stable plain text. One line per call, error and test. */
export function formatSessionSlice(slice: SessionSlice): string {
  const lines: string[] = [];
  lines.push(`session: ${slice.sessionId} (${slice.provider})`);
  if (slice.folderUri) lines.push(`folder: ${slice.folderUri}`);
  if (slice.startedAt || slice.endedAt) {
    lines.push(`window: ${slice.startedAt ?? "unknown"} to ${slice.endedAt ?? "unknown"}`);
  }
  if (slice.turns.length > 0) {
    lines.push("turns:");
    for (const turn of slice.turns) {
      const at = turn.at ? ` @${turn.at}` : "";
      lines.push(`- [${turn.role}]${at}${turn.text ? ` ${turn.text}` : ""}`);
      for (const code of turn.code ?? []) {
        lines.push(`  code (${turn.codePath ?? "unknown path"}):`);
        for (const line of code.split("\n")) lines.push(`  ${line}`);
      }
    }
  }
  if (slice.toolCalls.length > 0) {
    lines.push("tool calls:");
    for (const call of slice.toolCalls) {
      const at = call.at ? ` @${call.at}` : "";
      lines.push(`- ${call.name} [${call.status}] ${call.summary}${at}`);
    }
  }
  if (slice.errors.length > 0) {
    lines.push("errors:");
    for (const error of slice.errors) {
      const at = error.at ? ` @${error.at}` : "";
      lines.push(`- [${error.status}] ${error.message}${at}`);
    }
  }
  if (slice.testResults.length > 0) {
    lines.push("tests:");
    for (const result of slice.testResults) {
      const at = result.at ? ` @${result.at}` : "";
      lines.push(`- ${result.name} [${result.status}]${at}`);
    }
  }
  if (slice.changedFiles.length > 0) lines.push(`changed files: ${slice.changedFiles.join(", ")}`);
  return lines.join("\n");
}

/** Inputs of the session-slice context source. Everything impure is injected. */
export interface SessionSliceSourceDeps {
  folderUri: string;
  homeDir?: string;
  candidates?: SessionCandidate[];
  sends: Array<Event<SendRecord>>;
  sendId?: string;
  promptHash?: string;
  clock: Clock;
  caps?: SessionCaps;
  /** #39's model capabilities; the cap input is capabilities.maxContextTokens. */
  capabilities?: ModelCapabilities;
  includeCode: IncludeCode;
  /** Workspace-relative POSIX paths explicitly referenced with @ in the draft. */
  promptFiles?: string[];
  redact(text: string): { text: string; count: number };
}

/** Mirrors the core assembler's abort convention. */
function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

/**
 * The `session-slice` ContextSource at priority 85. Discovers candidates when
 * they are not supplied, locates one session, reads the bounded slice, and
 * returns it as one redacted fragment. Ambiguity is reported, never guessed.
 */
export function createSessionSliceSource(deps: SessionSliceSourceDeps): ContextSource {
  return {
    id: "session-slice",
    priority: SOURCE_PRIORITIES["session-slice"],
    async collect(signal?: AbortSignal): Promise<ContextSourceResult> {
      if (signal?.aborted) throw abortError(signal);
      const caps: SessionCaps = { ...(deps.caps ?? DEFAULT_SESSION_CAPS) };
      const maxContext = deps.capabilities?.maxContextTokens ?? 0;
      if (Number.isFinite(maxContext) && maxContext > 0) caps.maxTokens = Math.min(caps.maxTokens, maxContext);

      const candidates = deps.candidates ?? (await discoverCandidates(deps.folderUri, deps.homeDir ?? os.homedir()));
      const location = locateSession({
        sendId: deps.sendId,
        folderUri: deps.folderUri,
        promptHash: deps.promptHash,
        sends: deps.sends,
        candidates,
        clock: deps.clock,
      });

      if (location.kind === "none") {
        return { fragments: [], omittedReason: "empty", details: { resolved: "none" } };
      }
      if (location.kind === "ambiguous") {
        // The caller owns the picker; the source never guesses a session.
        return { fragments: [], omittedReason: "empty", details: { ambiguous: location.candidates.length } };
      }

      const slice = await readSlice(location.candidate.filePath, location.candidate.provider, caps, deps.clock, {
        includeCode: deps.includeCode,
        promptFiles: deps.promptFiles,
        redact: deps.redact,
      });
      const details: Record<string, string | number | boolean> = {
        sourcePath: slice.provenance.sourcePath,
        bytesRead: slice.provenance.bytesRead,
        turnsKept: slice.provenance.turnsKept,
        truncated: slice.truncated,
        redactions: slice.provenance.redactions,
        droppedTurns: slice.provenance.droppedTurns,
        droppedToolCalls: slice.provenance.droppedToolCalls,
        droppedFiles: slice.provenance.droppedFiles,
      };
      if (slice.provenance.reason) details.reason = slice.provenance.reason;
      const reason = slice.provenance.reason;
      if (reason === "unsupported") return { fragments: [], omittedReason: "unsupported", details };
      if (reason === "error") return { fragments: [], omittedReason: "error", details };
      if (reason === "empty") return { fragments: [], omittedReason: "empty", details };

      const content = formatSessionSlice(slice);
      return {
        fragments: [
          {
            source: "session-slice",
            priority: SOURCE_PRIORITIES["session-slice"],
            content,
            tokens: estimateTokens(content),
            provenance: {
              kind: "session",
              truncated: slice.truncated,
              chars: content.length,
              redactions: slice.provenance.redactions,
              folderUri: deps.folderUri,
            },
          },
        ],
        details,
      };
    },
  };
}

// Bounded current-session slice reader (ticket #38).
// Discovers Claude and Codex session files, parses the public JSONL formats
// into a derived SessionSlice, and applies the privacy policy and redaction.
// No vscode import, no picker, and no raw transcript leaves this module.
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ContextSource } from "@prompt-preflight/core";
import { canonicalFolderUri, type SessionCandidate, type SessionProvider } from "./sessionLocator";
import type { IncludeCode } from "./privacy";

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
function isTestCall(name: string, described: string | undefined, input: Record<string, unknown>): boolean {
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
  /** Owner turn index of each tool call, parallel to toolCalls. */
  ownerOf: number[];
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
  ownerOf: [],
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
  if (!call) return;
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

/** Adds a tool call with its owner turn, pending-link index and test bookkeeping. */
function registerCall(state: ParserState, call: ToolCall, ownerIndex: number, isTest: boolean): number {
  const callIndex = state.toolCalls.length;
  state.toolCalls.push(call);
  state.ownerOf.push(ownerIndex);
  state.isTestOf.push(isTest);
  if (isTest && !state.testStatus.has(call.summary)) {
    state.testOrder.push(call.summary);
    state.testStatus.set(call.summary, { status: "unknown", at: call.at });
  }
  return callIndex;
}

/** Extracts fenced code per turn and removes it from the turn text. */
function finalizeTurns(state: ParserState): void {
  state.turns.forEach((turn, index) => {
    const { code, paths, rest } = extractFences(turn.text);
    if (code.length === 0) return;
    turn.code = code;
    turn.codePath = paths.find((p) => p !== undefined) ?? state.turnFiles[index]?.[0];
    turn.text = rest.replace(/\n{3,}/g, "\n\n").trim();
  });
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
          registerCall(state, call, plan.index, isTestCall(name, described, input));
          if (typeof b.id === "string") state.pending.set(b.id, state.toolCalls.length - 1);
          messageFiles.push(...changedFromInput(input, state));
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
        changedFromInput(input, state);
      } else if (typeof argsRaw === "string") {
        described = patchFileFrom(argsRaw);
        if (described) changedFromPatch(described, state);
      }
      const call: ToolCall = {
        name,
        status: "unknown",
        summary: oneLine(`${name}${described ? ` ${displayPath(described, state.cwd)}` : ""}`),
        at: state.endedAt,
      };
      registerCall(state, call, ownerIndex, isTestCall(name, described, input ?? {}));
      if (described) state.turnFiles[ownerIndex]?.push(displayPath(described, state.cwd));
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

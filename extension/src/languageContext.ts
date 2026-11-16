// Language context providers (ticket #37): LSP-backed semantics without an
// AST service. Pure module: no vscode import, no child_process. The VS Code
// adapter lives in vscodeLanguageApi.ts and is the only platform seam.
import {
  SOURCE_PRIORITIES,
  estimateTokens,
  type ContextFragment,
  type ContextSource,
  type ContextSourceId,
} from "@prompt-preflight/core";
import { shouldInclude, type IncludePolicy } from "./privacy";

/** A 0-based editor position with VS Code semantics; display adds 1. */
export interface LanguagePosition {
  line: number;
  character: number;
}

/** A half-open editor range. */
export interface LanguageRange {
  start: LanguagePosition;
  end: LanguagePosition;
}

/** Where one language result points: the raw uri plus a workspace path when known. */
export interface LanguageAnchor {
  uri: string;
  /** Workspace-relative POSIX path, or undefined for untitled/virtual documents. */
  path?: string;
  range: LanguageRange;
}

export interface LanguageLocation extends LanguageAnchor {
  name?: string;
}

export interface LanguageSymbol {
  name: string;
  kind: string;
  uri?: string;
  path?: string;
  range?: LanguageRange;
  containerName?: string;
}

export interface LanguageDiagnostic extends LanguageAnchor {
  severity: string;
  source?: string;
  message: string;
}

export interface TextSearchMatch extends LanguageAnchor {
  preview?: string;
}

export interface TextSearchOptions {
  cwd?: string;
  maxResults: number;
}

/** The injected port the pure module calls; the adapter implements it over vscode. */
export interface LanguageApi {
  documentSymbols(uri: string): Promise<LanguageSymbol[]>;
  workspaceSymbols(query: string): Promise<LanguageSymbol[]>;
  definitions(uri: string, position: LanguagePosition): Promise<LanguageLocation[]>;
  references(uri: string, position: LanguagePosition): Promise<LanguageLocation[]>;
  diagnostics(uri: string): Promise<LanguageDiagnostic[]>;
  textSearch(query: string, options: TextSearchOptions): Promise<TextSearchMatch[]>;
}

/** Which language providers answered the probe. */
export interface LanguageCapabilities {
  documentSymbols: boolean;
  workspaceSymbols: boolean;
  definitions: boolean;
  references: boolean;
  diagnostics: boolean;
}

/** Per-source caps; every cap hit is recorded in provenance.truncated. */
export const MAX_DIAGNOSTICS = 200;
export const MAX_DOCUMENT_SYMBOLS = 100;
export const MAX_WORKSPACE_SYMBOLS = 50;
export const MAX_DEFINITIONS = 20;
export const MAX_REFERENCES = 50;
export const MAX_TEXT_SEARCH_MATCHES = 50;

const MAX_TIMEOUT_MS = 3000;

/** The assembler's own abort error, so every caller sees the same code. */
function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

/** Rejects when the caller aborted; a cancelled request never resolves. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

/**
 * Rejects after `ms` milliseconds or on abort, whichever comes first, and
 * always clears the timer and the abort listener. A timed-out call rejects
 * with a `code: "timeout"` error; an abort rejects with `code: "cancelled"`.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${ms} ms`), { code: "timeout" })), ms);
    const onAbort = () => reject(abortError(signal));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** One display position: 1-based `line:col` from the 0-based editor position. */
function positionLabel(position: LanguagePosition): string {
  return `${position.line + 1}:${position.character + 1}`;
}

/** `line:col` for the range start, plus `-endLine:endCol` when start and end differ. */
function rangeLabel(range: LanguageRange): string {
  const start = positionLabel(range.start);
  return range.start.line === range.end.line && range.start.character === range.end.character
    ? start
    : `${start}-${positionLabel(range.end)}`;
}

/** Newlines and carriage returns never survive into a fragment line. */
function collapse(text: string): string {
  return text.replace(/\r\n?|\n/g, " ").trim();
}

/** True when the path cannot be resolved inside a workspace folder. */
function isOutsideWorkspace(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..");
}

/** Shared fragment assembly: cap the input, render, and stamp provenance. */
function buildFragment(options: {
  source: ContextSourceId;
  kind: ContextFragment["provenance"]["kind"];
  lines: string[];
  capped: boolean;
  folderUri?: string;
  path?: string;
}): ContextFragment {
  const content = options.lines.join("\n");
  return {
    source: options.source,
    priority: SOURCE_PRIORITIES[options.source],
    content,
    tokens: estimateTokens(content),
    provenance: {
      kind: options.kind,
      ...(options.path !== undefined ? { path: options.path } : {}),
      truncated: options.capped,
      chars: content.length,
      ...(options.folderUri !== undefined ? { folderUri: options.folderUri } : {}),
    },
  };
}

/** The diagnostics line: `severity source path:range message` with 1-based positions. */
function diagnosticLine(diagnostic: LanguageDiagnostic): string {
  const location = `${diagnostic.path ?? diagnostic.uri}:${rangeLabel(diagnostic.range)}`;
  return `${diagnostic.severity} ${diagnostic.source ?? "-"} ${location} ${collapse(diagnostic.message)}`;
}

/** One line per diagnostic, capped at MAX_DIAGNOSTICS; null when nothing is left. */
export function buildDiagnosticsFragment(diagnostics: LanguageDiagnostic[], folderUri?: string): ContextFragment | null {
  if (diagnostics.length === 0) return null;
  const included = diagnostics.slice(0, MAX_DIAGNOSTICS);
  return buildFragment({
    source: "diagnostics",
    kind: "diagnostic",
    lines: included.map(diagnosticLine),
    capped: diagnostics.length > MAX_DIAGNOSTICS,
    folderUri,
  });
}

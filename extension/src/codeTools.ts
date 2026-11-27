// Read-only agent tools over LSP types, with a text-search fallback.
// The protocol port is implemented by the VS Code adapter; the pure tool
// layer owns policy, caps, timeouts, cancellation, and fallback decisions.
import { CancellationTokenSource, type CancellationToken } from "vscode-jsonrpc";
import {
  DiagnosticSeverity,
  SymbolKind,
  type Diagnostic,
  type DocumentSymbolParams,
  type DefinitionParams,
  type Location,
  type ReferenceParams,
  type Range,
  type SymbolInformation,
  type WorkspaceSymbolParams,
} from "vscode-languageserver-protocol";
import { shouldInclude, type IncludePolicy } from "./privacy";

/** One symbol item after LSP conversion. */
export interface ToolSymbol {
  name: string;
  /** Display name from SymbolKind, e.g. "Function". */
  kind: string;
  uri?: string;
  path?: string;
  range?: Range;
  containerName?: string;
}

/** One location item after LSP conversion. */
export interface ToolLocation {
  uri: string;
  path?: string;
  range: Range;
  name?: string;
}

/** One diagnostic item after LSP conversion. */
export interface ToolDiagnostic {
  uri: string;
  path?: string;
  range: Range;
  severity: string;
  source?: string;
  message: string;
}

/** One text-search match. */
export interface TextSearchMatch {
  uri: string;
  path?: string;
  range: Range;
  preview?: string;
}

/** Why a tool returned no items. */
export type ToolOmitReason = "empty" | "excluded" | "unsupported" | "error";

/** The common result envelope. */
export interface ToolResult<T> {
  items: T[];
  truncated: boolean;
  /** Items removed by the workspace boundary or the privacy policy. */
  dropped: number;
  omittedReason?: ToolOmitReason;
}

/** The facts every result carries for the manifest. */
export type ResultFacts = Pick<ToolResult<unknown>, "dropped" | "omittedReason"> & { fallback?: "text-search" };

/** A text-search result, always marked with its fallback discriminant. */
export type TextSearchToolResult = ToolResult<TextSearchMatch> & { fallback: "text-search" };

/** A result that may have switched to text search. */
export type FallbackResult<T> =
  | (ToolResult<T> & { fallback?: undefined })
  | TextSearchToolResult;

/** The file list result, which may have switched to text search. */
export type ListFilesResult = ToolResult<string> & { fallback?: "text-search" };

export interface CodeToolCaps {
  documentSymbols: number;
  workspaceSymbols: number;
  definitions: number;
  references: number;
  diagnostics: number;
  textSearch: number;
  listFiles: number;
}

export const CODE_TOOL_CAPS: CodeToolCaps = {
  documentSymbols: 100,
  workspaceSymbols: 50,
  definitions: 20,
  references: 50,
  diagnostics: 200,
  textSearch: 50,
  listFiles: 200,
};

/** The LSP-backed protocol port. The VS Code adapter is the only implementation. */
export interface LanguageProtocol {
  /** Workspace-relative POSIX path to a document URI, or undefined when outside. */
  uriOf(path: string): string | undefined;
  /** Workspace-relative POSIX path from a document URI, or undefined when outside. */
  pathOf(uri: string): string | undefined;
  documentSymbols(params: DocumentSymbolParams, token: CancellationToken): Promise<SymbolInformation[]>;
  workspaceSymbols(params: WorkspaceSymbolParams, token: CancellationToken): Promise<SymbolInformation[]>;
  definitions(params: DefinitionParams, token: CancellationToken): Promise<Location[]>;
  references(params: ReferenceParams, token: CancellationToken): Promise<Location[]>;
  diagnostics(uri: string, token: CancellationToken): Promise<Diagnostic[]>;
  /** Optional VS Code file list; the text-search port is the fallback. */
  workspaceFiles?(token: CancellationToken): Promise<string[]>;
}

/** The text-search port. The adapter binds the bundled rg binary. */
export interface TextSearchPort {
  search(query: string, options: { cwd?: string; maxResults: number; paths?: string[] }): Promise<TextSearchMatch[]>;
  listFiles?(options: { cwd?: string; maxResults: number }): Promise<string[]>;
}

export interface CodeToolsOptions {
  protocol: LanguageProtocol;
  textSearch: TextSearchPort;
  policy: IncludePolicy;
  cwd?: string;
  timeoutMs?: number;
  caps?: Partial<CodeToolCaps>;
}

export interface DocumentSymbolsInput {
  path: string;
  /** Query used only when the LSP result is empty. */
  query?: string;
}

export interface WorkspaceSymbolsInput {
  query: string;
}

export interface PositionInput {
  path: string;
  position: { line: number; character: number };
  /** Query used only when the LSP result is empty. */
  query?: string;
}

export interface ReferencesInput extends PositionInput {
  includeDeclaration?: boolean;
}

export interface DiagnosticsInput {
  paths: string[];
}

export interface TextSearchInput {
  query: string;
  maxResults?: number;
}

export interface ListFilesInput {
  maxResults?: number;
}

export interface CodebaseTools {
  documentSymbols(input: DocumentSymbolsInput, signal?: AbortSignal): Promise<FallbackResult<ToolSymbol>>;
  workspaceSymbols(input: WorkspaceSymbolsInput, signal?: AbortSignal): Promise<FallbackResult<ToolSymbol>>;
  definitions(input: PositionInput, signal?: AbortSignal): Promise<FallbackResult<ToolLocation>>;
  references(input: ReferencesInput, signal?: AbortSignal): Promise<FallbackResult<ToolLocation>>;
  diagnostics(input: DiagnosticsInput, signal?: AbortSignal): Promise<ToolResult<ToolDiagnostic>>;
  searchText(input: TextSearchInput, signal?: AbortSignal): Promise<ToolResult<TextSearchMatch>>;
  listFiles(input: ListFilesInput, signal?: AbortSignal): Promise<ListFilesResult>;
}

const DEFAULT_TIMEOUT_MS = 3000;

const SYMBOL_KIND_NAMES: Record<number, string> = {};
for (const [name, value] of Object.entries(SymbolKind)) {
  if (typeof value === "number") SYMBOL_KIND_NAMES[value] = name;
}
const SEVERITY_NAMES: Record<number, string> = {};
for (const [name, value] of Object.entries(DiagnosticSeverity)) {
  if (typeof value === "number") SEVERITY_NAMES[value] = name;
}

/** The abort error every cancelled call rejects with. */
function cancelledError(): Error {
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

function timeoutError(ms: number): Error {
  return Object.assign(new Error(`timed out after ${ms} ms`), { code: "timeout" });
}

/**
 * Runs one protocol call under the timeout and the caller signal. A timeout
 * cancels the token and rejects with code "timeout"; an abort rejects with
 * code "cancelled". The timer, listener, and token source are always released.
 */
export function withTimeout<T>(run: (token: CancellationToken) => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  const source = new CancellationTokenSource();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      source.cancel();
      reject(timeoutError(ms));
    }, ms);
  });
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => {
      source.cancel();
      reject(cancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  return Promise.race([run(source.token), timeout, aborted]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    source.dispose();
  });
}

function emptyResult(reason: ToolOmitReason, dropped = 0): ToolResult<never> {
  return { items: [], truncated: false, dropped, omittedReason: reason };
}

function cap<T>(items: T[], limit: number): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, limit), truncated: items.length > limit };
}

function isAllowed(path: string | undefined, policy: IncludePolicy, kind: "prompt-file" | "workspace" = "workspace"): path is string {
  return path !== undefined && path !== "" && shouldInclude(path, kind, policy);
}

/** Canonical result order: path, then start line, then start character. */
function byCanonicalOrder(
  a: { path?: string; range: Range },
  b: { path?: string; range: Range },
): number {
  const pa = a.path ?? "";
  const pb = b.path ?? "";
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
  return a.range.start.character - b.range.start.character;
}

function convertSymbol(symbol: SymbolInformation, protocol: LanguageProtocol): ToolSymbol {
  const path = protocol.pathOf(symbol.location.uri);
  return {
    name: symbol.name,
    kind: SYMBOL_KIND_NAMES[symbol.kind] ?? String(symbol.kind),
    uri: symbol.location.uri,
    ...(path !== undefined ? { path } : {}),
    range: symbol.location.range,
    ...(symbol.containerName !== undefined ? { containerName: symbol.containerName } : {}),
  };
}

function convertLocation(location: Location, protocol: LanguageProtocol): ToolLocation {
  const path = protocol.pathOf(location.uri);
  return {
    uri: location.uri,
    ...(path !== undefined ? { path } : {}),
    range: location.range,
  };
}

function convertDiagnostic(diagnostic: Diagnostic, uri: string, path: string | undefined): ToolDiagnostic {
  const severity = diagnostic.severity ?? DiagnosticSeverity.Information;
  const message = typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value;
  return {
    uri,
    ...(path !== undefined ? { path } : {}),
    range: diagnostic.range,
    severity: SEVERITY_NAMES[severity] ?? String(severity),
    ...(diagnostic.source !== undefined ? { source: diagnostic.source } : {}),
    message,
  };
}

function errorReason(error: unknown, signal?: AbortSignal): ToolOmitReason {
  if (signal?.aborted) throw cancelledError();
  if ((error as { code?: unknown } | null)?.code === "cancelled") throw cancelledError();
  return "error";
}

export function createCodeTools(options: CodeToolsOptions): CodebaseTools {
  const { protocol, textSearch, policy } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const caps = { ...CODE_TOOL_CAPS, ...options.caps };
  const cwd = options.cwd;

  /**
   * The workspace-relative paths the policy allows the search to open, deduped.
   * An empty list means nothing may be searched; undefined means the whole tree
   * under the workspace mode. The port receives a plain scope, never the policy.
   */
  const allowedPaths = (): string[] | undefined => {
    if (policy.includeCode === "off") return [];
    if (policy.includeCode === "prompt-files") {
      const seen = new Set<string>();
      const paths: string[] = [];
      for (const path of policy.promptFiles ?? []) {
        if (seen.has(path) || !isAllowed(path, policy, "prompt-file")) continue;
        seen.add(path);
        paths.push(path);
      }
      return paths;
    }
    return undefined;
  };

  const call = <T>(run: (token: CancellationToken) => Promise<T>, signal?: AbortSignal): Promise<T> =>
    withTimeout(run, timeoutMs, signal);

  const searchText = async (input: TextSearchInput, signal?: AbortSignal): Promise<ToolResult<TextSearchMatch>> => {
    if (input.query.trim() === "") return emptyResult("empty");
    const limit = Math.min(input.maxResults ?? caps.textSearch, caps.textSearch);
    const paths = allowedPaths();
    // An empty allowed set means the policy lets the search open nothing.
    if (paths !== undefined && paths.length === 0) return emptyResult("excluded");
    let matches: TextSearchMatch[];
    try {
      matches = await withTimeout(
        () => textSearch.search(input.query, { cwd, maxResults: limit, paths }),
        timeoutMs,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      if ((error as { code?: unknown } | null)?.code === "ENOENT") return emptyResult("unsupported");
      return emptyResult("error");
    }
    const filtered = matches.filter((match) => isAllowed(match.path, policy));
    const dropped = matches.length - filtered.length;
    // Determinism is a property of the result, not of rg arrival order: the
    // canonical order makes repeated searches return the same set and order.
    const sorted = [...filtered].sort(byCanonicalOrder);
    const capped = cap(sorted, limit);
    if (capped.items.length === 0) return emptyResult("empty", dropped);
    return { items: capped.items, truncated: capped.truncated, dropped };
  };

  const fallback = async (query: string, signal?: AbortSignal): Promise<TextSearchToolResult> => {
    const result = await searchText({ query }, signal);
    return { ...result, fallback: "text-search" };
  };

  const documentSymbols = async (input: DocumentSymbolsInput, signal?: AbortSignal): Promise<FallbackResult<ToolSymbol>> => {
    if (!isAllowed(input.path, policy, "prompt-file")) return emptyResult("excluded");
    const uri = protocol.uriOf(input.path);
    if (uri === undefined) return emptyResult("excluded");
    let raw: SymbolInformation[];
    try {
      raw = await call((token) => protocol.documentSymbols({ textDocument: { uri } }, token), signal);
    } catch (error) {
      return emptyResult(errorReason(error, signal));
    }
    const converted = raw.map((symbol) => convertSymbol(symbol, protocol));
    const filtered = converted.filter((symbol) => isAllowed(symbol.path, policy));
    const dropped = converted.length - filtered.length;
    const capped = cap(filtered, caps.documentSymbols);
    if (capped.items.length > 0) return { items: capped.items, truncated: capped.truncated, dropped };
    if (dropped > 0) return emptyResult("empty", dropped);
    if (input.query === undefined || input.query.trim() === "") return emptyResult("empty");
    return fallback(input.query, signal);
  };

  const workspaceSymbols = async (input: WorkspaceSymbolsInput, signal?: AbortSignal): Promise<FallbackResult<ToolSymbol>> => {
    if (input.query.trim() === "") return emptyResult("empty");
    let raw: SymbolInformation[];
    try {
      raw = await call((token) => protocol.workspaceSymbols({ query: input.query }, token), signal);
    } catch (error) {
      return emptyResult(errorReason(error, signal));
    }
    const converted = raw.map((symbol) => convertSymbol(symbol, protocol));
    const filtered = converted.filter((symbol) => isAllowed(symbol.path, policy));
    const dropped = converted.length - filtered.length;
    const capped = cap(filtered, caps.workspaceSymbols);
    if (capped.items.length > 0) return { items: capped.items, truncated: capped.truncated, dropped };
    if (dropped > 0) return emptyResult("empty", dropped);
    return fallback(input.query, signal);
  };

  const definitions = async (input: PositionInput, signal?: AbortSignal): Promise<FallbackResult<ToolLocation>> => {
    if (!isAllowed(input.path, policy, "prompt-file")) return emptyResult("excluded");
    const uri = protocol.uriOf(input.path);
    if (uri === undefined) return emptyResult("excluded");
    let raw: Location[];
    try {
      raw = await call(
        (token) =>
          protocol.definitions(
            { textDocument: { uri }, position: input.position },
            token,
          ),
        signal,
      );
    } catch (error) {
      return emptyResult(errorReason(error, signal));
    }
    const converted = raw.map((location) => convertLocation(location, protocol));
    const filtered = converted.filter((location) => isAllowed(location.path, policy));
    const dropped = converted.length - filtered.length;
    const capped = cap(filtered, caps.definitions);
    if (capped.items.length > 0) return { items: capped.items, truncated: capped.truncated, dropped };
    if (dropped > 0) return emptyResult("empty", dropped);
    if (input.query === undefined || input.query.trim() === "") return emptyResult("empty");
    return fallback(input.query, signal);
  };

  const references = async (input: ReferencesInput, signal?: AbortSignal): Promise<FallbackResult<ToolLocation>> => {
    if (!isAllowed(input.path, policy, "prompt-file")) return emptyResult("excluded");
    const uri = protocol.uriOf(input.path);
    if (uri === undefined) return emptyResult("excluded");
    let raw: Location[];
    try {
      raw = await call(
        (token) =>
          protocol.references(
            {
              textDocument: { uri },
              position: input.position,
              context: { includeDeclaration: input.includeDeclaration === true },
            },
            token,
          ),
        signal,
      );
    } catch (error) {
      return emptyResult(errorReason(error, signal));
    }
    const converted = raw.map((location) => convertLocation(location, protocol));
    const filtered = converted.filter((location) => isAllowed(location.path, policy));
    const dropped = converted.length - filtered.length;
    const capped = cap(filtered, caps.references);
    if (capped.items.length > 0) return { items: capped.items, truncated: capped.truncated, dropped };
    if (dropped > 0) return emptyResult("empty", dropped);
    if (input.query === undefined || input.query.trim() === "") return emptyResult("empty");
    return fallback(input.query, signal);
  };

  const diagnostics = async (input: DiagnosticsInput, signal?: AbortSignal): Promise<ToolResult<ToolDiagnostic>> => {
    const included = input.paths.filter((path) => isAllowed(path, policy, "prompt-file"));
    const dropped = input.paths.length - included.length;
    if (included.length === 0) return emptyResult("excluded", dropped);
    const collected: ToolDiagnostic[] = [];
    for (const path of included) {
      const uri = protocol.uriOf(path);
      if (uri === undefined) continue;
      try {
        const raw = await call((token) => protocol.diagnostics(uri, token), signal);
        for (const diagnostic of raw) {
          const converted = convertDiagnostic(diagnostic, uri, protocol.pathOf(uri));
          if (isAllowed(converted.path, policy)) collected.push(converted);
        }
      } catch (error) {
        return emptyResult(errorReason(error, signal), dropped);
      }
    }
    const capped = cap(collected, caps.diagnostics);
    if (capped.items.length === 0) return emptyResult("empty", dropped);
    return { items: capped.items, truncated: capped.truncated, dropped };
  };

  const listFiles = async (input: ListFilesInput, signal?: AbortSignal): Promise<ListFilesResult> => {
    const limit = Math.min(input.maxResults ?? caps.listFiles, caps.listFiles);
    if (protocol.workspaceFiles) {
      let files: string[];
      try {
        files = await call((token) => protocol.workspaceFiles!(token), signal);
      } catch (error) {
        return emptyResult(errorReason(error, signal));
      }
      const filtered = files.filter((path) => isAllowed(path, policy));
      const dropped = files.length - filtered.length;
      const capped = cap(filtered, limit);
      if (capped.items.length > 0) return { items: capped.items, truncated: capped.truncated, dropped };
      // The primary list answered. If it hid every path, never fall back to
      // text search: that would reveal paths the policy just rejected.
      if (files.length > 0) return emptyResult("empty", dropped);
    }
    if (!textSearch.listFiles) return emptyResult("unsupported");
    let files: string[];
    try {
      files = await withTimeout(() => textSearch.listFiles!({ cwd, maxResults: limit }), timeoutMs, signal);
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      if ((error as { code?: unknown } | null)?.code === "ENOENT") return emptyResult("unsupported");
      return emptyResult("error");
    }
    const filtered = files.filter((path) => isAllowed(path, policy));
    const capped = cap(filtered, limit);
    if (capped.items.length === 0) return emptyResult("empty", files.length - filtered.length);
    return { items: capped.items, truncated: capped.truncated, dropped: files.length - filtered.length, fallback: "text-search" };
  };

  return { documentSymbols, workspaceSymbols, definitions, references, diagnostics, searchText, listFiles };
}

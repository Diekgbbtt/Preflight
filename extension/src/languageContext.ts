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

/** Where one language result points: the raw uri plus a workspace path when known. */export interface LanguageAnchor {
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

/** Everything searchFallback needs to stand in for one LSP source. */
export interface SearchFallbackOptions {
  /** The LSP source id the fragment replaces; also the fragment's source. */
  sourceId: ContextSourceId;
  /** The LSP source priority the fragment keeps. */
  priority: number;
  cwd?: string;
  maxResults?: number;
  folderUri?: string;
  /** Extra privacy filter on workspace-relative paths; workspace boundary and #41 exclusions stay mandatory. */
  allowPath?: (path: string) => boolean;
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

/** The abort error every cancelled call rejects with, per the ticket contract. */
function cancelledError(): Error {
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

/** Rejects when the caller aborted; a cancelled request never resolves. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

/**
 * Rejects after `ms` milliseconds or on abort, whichever comes first, and
 * always clears the timer and the abort listener. A timed-out call rejects
 * with a `code: "timeout"` error; an abort rejects with `code: "cancelled"`.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${ms} ms`), { code: "timeout" })), ms);
    const onAbort = () => reject(cancelledError());
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

/** A document-symbol line: `kind name` or `kind Container.name`. */
function symbolLine(symbol: LanguageSymbol): string {
  const name = symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
  return `${symbol.kind} ${name}`;
}

/** Renders one symbol line per document symbol, capped at MAX_DOCUMENT_SYMBOLS. */
export function buildSymbolsFragment(symbols: LanguageSymbol[], folderUri?: string): ContextFragment | null {
  if (symbols.length === 0) return null;
  const included = symbols.slice(0, MAX_DOCUMENT_SYMBOLS);
  // provenance.path only when every capped symbol is in the same known file.
  const paths = new Set(included.map((symbol) => symbol.path));
  const sharedPath = paths.size === 1 && paths.values().next().value !== undefined ? paths.values().next().value : undefined;
  return buildFragment({
    source: "symbols",
    kind: "symbol",
    lines: included.map(symbolLine),
    capped: symbols.length > MAX_DOCUMENT_SYMBOLS,
    folderUri,
    ...(sharedPath !== undefined ? { path: sharedPath } : {}),
  });
}

/** A workspace-symbol line: `path:line:col kind name`. */
function workspaceSymbolLine(symbol: LanguageSymbol): string {
  const name = symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
  const start = (symbol.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }).start;
  const location = symbol.path ? `${symbol.path}:${positionLabel(start)}` : symbol.uri ?? "?";
  return `${location} ${symbol.kind} ${name}`;
}

/** Renders one workspace-symbol line per symbol, capped at MAX_WORKSPACE_SYMBOLS. */
export function buildWorkspaceSymbolsFragment(symbols: LanguageSymbol[], folderUri?: string): ContextFragment | null {
  if (symbols.length === 0) return null;
  const included = symbols.slice(0, MAX_WORKSPACE_SYMBOLS);
  return buildFragment({
    source: "workspace-symbols",
    kind: "workspace-symbol",
    lines: included.map(workspaceSymbolLine),
    capped: symbols.length > MAX_WORKSPACE_SYMBOLS,
    folderUri,
  });
}

/** A location line: `path:line:col` plus the target name when known. */
function locationLine(location: LanguageLocation): string {
  const base = `${location.path ?? location.uri}:${positionLabel(location.range.start)}`;
  return location.name !== undefined ? `${base} ${location.name}` : base;
}

/** Renders one definition location per line, capped at MAX_DEFINITIONS. */
export function buildDefinitionsFragment(definitions: LanguageLocation[], folderUri?: string): ContextFragment | null {
  if (definitions.length === 0) return null;
  const included = definitions.slice(0, MAX_DEFINITIONS);
  return buildFragment({
    source: "definitions",
    kind: "definition",
    lines: included.map(locationLine),
    capped: definitions.length > MAX_DEFINITIONS,
    folderUri,
  });
}

/** Renders one reference location per line, capped at MAX_REFERENCES. */
export function buildReferencesFragment(references: LanguageLocation[], folderUri?: string): ContextFragment | null {
  if (references.length === 0) return null;
  const included = references.slice(0, MAX_REFERENCES);
  return buildFragment({
    source: "references",
    kind: "reference",
    lines: included.map(locationLine),
    capped: references.length > MAX_REFERENCES,
    folderUri,
  });
}

/**
 * Text-search fallback that stands in for one LSP source: same source id,
 * same priority, provenance kind `text-search`. Never runs without a query.
 * An `rg` failure with code ENOENT rethrows so the source can omit with
 * `unsupported`; matches outside the workspace or rejected by `allowPath`
 * are dropped.
 */
export async function searchFallback(api: LanguageApi, query: string, options: SearchFallbackOptions, signal?: AbortSignal): Promise<ContextFragment | null> {
  if (query.trim() === "") return null;
  const cap = options.maxResults ?? MAX_TEXT_SEARCH_MATCHES;
  let matches: TextSearchMatch[];
  try {
    matches = await withTimeout(api.textSearch(query, { cwd: options.cwd, maxResults: cap }), MAX_TIMEOUT_MS, signal);
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    if ((error as { code?: unknown } | null)?.code === "ENOENT") {
      throw Object.assign(new Error("rg is not available"), { code: "ENOENT" });
    }
    throw error;
  }
  const allowed = matches.filter((m) => {
    const path = m.path;
    if (path === undefined || path === "" || isOutsideWorkspace(path)) return false;
    return options.allowPath === undefined || options.allowPath(path);
  });
  if (allowed.length === 0) return null;
  const included = allowed.slice(0, cap);
  const content = included.map((m) => {
    const base = `${m.path ?? m.uri}:${positionLabel(m.range.start)}`;
    const preview = m.preview !== undefined ? ` ${collapse(m.preview)}` : "";
    return `${base}${preview}`;
  });
  const joined = content.join("\n");
  return {
    source: options.sourceId,
    priority: options.priority,
    content: joined,
    tokens: estimateTokens(joined),
    provenance: {
      kind: "text-search",
      truncated: allowed.length > included.length,
      chars: joined.length,
      ...(options.folderUri !== undefined ? { folderUri: options.folderUri } : {}),
    },
  };
}

/** Everything the language sources need: the injected port, policy and per-request probe. */
export interface LanguageSourceDeps {
  api: LanguageApi;
  policy: IncludePolicy;
  folderUri?: string;
  cwd?: string;
  activeUri?: string;
  activePath?: string;
  activePosition?: LanguagePosition;
  openDocuments?: Array<{ uri: string; path: string }>;
  /** Workspace-symbol query: the selected identifier or a draft identifier. */
  query?: string;
  /** Per-request capability probe; the adapter caches per document version. */
  probe?: () => Promise<LanguageCapabilities | null>;
  timeoutMs?: number;
}

/** The provider timeout: a hung language call never blocks the bundle. */
const DEFAULT_PROVIDER_TIMEOUT_MS = MAX_TIMEOUT_MS;

/** True when the per-request probe is missing or says the provider is unavailable. */
async function unavailable(deps: LanguageSourceDeps, capability: keyof LanguageCapabilities, signal?: AbortSignal): Promise<boolean> {
  if (deps.probe === undefined) return false;
  const capabilities = await deps.probe();
  return capabilities === null || !capabilities[capability];
}

/** Runs one provider call under the timeout and the cancellation rules. */
async function providerCall<T>(deps: LanguageSourceDeps, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withTimeout(run(), deps.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS, signal);
}

/** Maps a failed provider call to an omit reason: an abort throws, everything else is error. */
function failureReason(error: unknown, signal?: AbortSignal): { omit: "error" } {
  if (signal?.aborted) throw cancelledError();
  throw new Error(`provider call failed: ${error instanceof Error ? error.message : String(error)}`);
}/** The fallback options shared by every LSP source. */
function fallbackOptions(deps: LanguageSourceDeps, sourceId: ContextSourceId): SearchFallbackOptions {
  return {
    sourceId,
    priority: SOURCE_PRIORITIES[sourceId],
    cwd: deps.cwd,
    folderUri: deps.folderUri,
    allowPath: (path) => shouldInclude(path, "workspace", deps.policy),
  };
}

/**
 * The diagnostics source: live diagnostics for every included open document,
 * flattened, capped at MAX_DIAGNOSTICS. #36 never calls getDiagnostics;
 * this source owns it. No cache: diagnostics are read fresh per request.
 */
export function createDiagnosticsSource(deps: LanguageSourceDeps): ContextSource {
  return {
    id: "diagnostics",
    priority: SOURCE_PRIORITIES.diagnostics,
    collect: async (signal?: AbortSignal) => {
      throwIfAborted(signal);
      const documents = deps.openDocuments ?? [];
      if (documents.length === 0) return { fragments: [], omittedReason: "empty" as const };
      const included = documents.filter((document) => shouldInclude(document.path, "diagnostic", deps.policy));
      if (included.length === 0) return { fragments: [], omittedReason: "excluded" as const };
      if (await unavailable(deps, "diagnostics", signal)) return { fragments: [], omittedReason: "unsupported" as const };
      let collected: LanguageDiagnostic[];
      try {
        const perDocument = await Promise.all(included.map((document) => providerCall(deps, () => deps.api.diagnostics(document.uri), signal)));
        collected = perDocument.flat();
      } catch (error) {
        if (signal?.aborted) throw cancelledError();
        return { fragments: [], omittedReason: "error" as const };
      }
      if (collected.length === 0) return { fragments: [], omittedReason: "empty" as const };
      const fragment = buildDiagnosticsFragment(collected, deps.folderUri);
      if (fragment === null) return { fragments: [], omittedReason: "empty" as const };
      return {
        fragments: [fragment],
        details: { files: included.length, count: fragment.content.split("\n").length },
      };
    },
  };
}

/**
 * Probes which language providers answer for one document. Runs every port
 * method under the timeout and turns each result into a boolean; a timeout
 * or a throw is false. The full lists are discarded: the probe never
 * collects symbols into a fragment. An empty uri means no document: null.
 */
export async function probeCapabilities(api: LanguageApi, uri: string, timeoutMs = MAX_TIMEOUT_MS, signal?: AbortSignal): Promise<LanguageCapabilities | null> {
  if (uri === "") return null;
  const answers: Array<[keyof LanguageCapabilities, Promise<unknown>]> = [
    ["documentSymbols", api.documentSymbols(uri)],
    ["workspaceSymbols", api.workspaceSymbols("probe")],
    ["definitions", api.definitions(uri, { line: 0, character: 0 })],
    ["references", api.references(uri, { line: 0, character: 0 })],
    ["diagnostics", api.diagnostics(uri)],
  ];
  const capabilities = { documentSymbols: false, workspaceSymbols: false, definitions: false, references: false, diagnostics: false };
  await Promise.all(
    answers.map(async ([key, pending]) => {
      try {
        const value = await withTimeout(pending, timeoutMs, signal);
        capabilities[key] = value !== null && value !== undefined;
      } catch {
        capabilities[key] = false; // a timeout or a throw means the provider is unavailable
      }
    }),
  );
  return capabilities;
}

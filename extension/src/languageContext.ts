// Language context sources (ticket #37) on top of the agent code tools.
// Pure module: no vscode import. The VS Code adapter implements the LSP
// protocol port; `codeTools.ts` owns policy, caps, fallback, and conversion.
import {
  SOURCE_PRIORITIES,
  estimateTokens,
  type ContextFragment,
  type ContextSource,
  type ContextSourceId,
  type ContextSourceResult,
} from "@prompt-preflight/core";
import type { Position, Range } from "vscode-languageserver-types";
import {
  CODE_TOOL_CAPS,
  type CodebaseTools,
  type TextSearchMatch,
  type ToolDiagnostic,
  type ToolLocation,
  type ResultFacts,
  type ToolResult,
  type ToolSymbol,
} from "./codeTools";
import { shouldInclude, type IncludePolicy } from "./privacy";

/** A 0-based editor position with VS Code semantics; display adds 1. */
export type LanguagePosition = Position;

/** A half-open editor range. */
export type LanguageRange = Range;

/** One symbol result. */
export type LanguageSymbol = ToolSymbol;

/** One location result. */
export type LanguageLocation = ToolLocation;

/** One diagnostic result. */
export type LanguageDiagnostic = ToolDiagnostic;

export type { TextSearchMatch };

/** Per-source caps; every cap hit is recorded in provenance.truncated. */
export const MAX_DIAGNOSTICS = CODE_TOOL_CAPS.diagnostics;
export const MAX_DOCUMENT_SYMBOLS = CODE_TOOL_CAPS.documentSymbols;
export const MAX_WORKSPACE_SYMBOLS = CODE_TOOL_CAPS.workspaceSymbols;
export const MAX_DEFINITIONS = CODE_TOOL_CAPS.definitions;
export const MAX_REFERENCES = CODE_TOOL_CAPS.references;
export const MAX_TEXT_SEARCH_MATCHES = CODE_TOOL_CAPS.textSearch;

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

/** A document-symbol line: `kind name`, or `path:line:col kind name` when the location is known. */
function symbolLine(symbol: LanguageSymbol): string {
  const name = symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name;
  const label = `${symbol.kind} ${name}`;
  if (symbol.path !== undefined && symbol.range !== undefined) {
    return `${symbol.path}:${positionLabel(symbol.range.start)} ${label}`;
  }
  return label;
}

/** Renders one symbol line per document symbol, capped at MAX_DOCUMENT_SYMBOLS. */
export function buildSymbolsFragment(symbols: LanguageSymbol[], folderUri?: string): ContextFragment | null {
  if (symbols.length === 0) return null;
  const included = symbols.slice(0, MAX_DOCUMENT_SYMBOLS);
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

/** Renders one text-search match per line, capped at MAX_TEXT_SEARCH_MATCHES. */
export function buildTextSearchFragment(
  matches: TextSearchMatch[],
  source: ContextSourceId,
  folderUri?: string,
): ContextFragment | null {
  if (matches.length === 0) return null;
  const included = matches.slice(0, MAX_TEXT_SEARCH_MATCHES);
  return buildFragment({
    source,
    kind: "text-search",
    lines: included.map((match) => {
      const base = `${match.path ?? match.uri}:${positionLabel(match.range.start)}`;
      return match.preview !== undefined ? `${base} ${collapse(match.preview)}` : base;
    }),
    capped: matches.length > MAX_TEXT_SEARCH_MATCHES,
    folderUri,
  });
}

/** Everything the language sources need: the tools, the policy, and the inputs. */
export interface LanguageSourceDeps {
  tools: CodebaseTools;
  policy: IncludePolicy;
  folderUri?: string;
  /** Workspace-relative path of the active document, when one exists. */
  activePath?: string;
  /** Cursor position in the active document, for definitions and references. */
  activePosition?: LanguagePosition;
  /** Open file documents, for diagnostics. */
  openDocuments?: Array<{ uri: string; path: string }>;
  /** Workspace-symbol query: the selected identifier or a draft identifier. */
  query?: string;
}

/** Maps one tool result to the source's omitted reason. */
function omittedReason(result: { omittedReason?: string }): "empty" | "excluded" | "unsupported" | "error" {
  const reason = result.omittedReason;
  return reason === "excluded" || reason === "unsupported" || reason === "error" ? reason : "empty";
}

/** The manifest details shared by the language sources. */
function detailsOf(result: ResultFacts, count: number): Record<string, number | boolean> {
  return {
    count,
    dropped: result.dropped,
    ...(result.fallback === "text-search" ? { textSearch: true } : {}),
  };
}

/** The empty result with the tool's facts. */
function emptyResult(result: ResultFacts, extra: Record<string, number | boolean> = {}): ContextSourceResult {
  return {
    fragments: [],
    omittedReason: omittedReason(result),
    details: { count: 0, dropped: result.dropped, ...extra, ...(result.fallback === "text-search" ? { textSearch: true } : {}) },
  };
}

/** Builds the fallback or LSP fragment for a symbol-like result. */
function symbolFragment(
  result: Awaited<ReturnType<CodebaseTools["documentSymbols"]>>,
  source: "symbols" | "workspace-symbols",
  folderUri?: string,
): ContextFragment | null {
  if (result.fallback === "text-search") return buildTextSearchFragment(result.items, source, folderUri);
  return source === "symbols" ? buildSymbolsFragment(result.items, folderUri) : buildWorkspaceSymbolsFragment(result.items, folderUri);
}

/** Builds the fallback or LSP fragment for a location-like result. */
function locationFragment(
  result: Awaited<ReturnType<CodebaseTools["definitions"]>>,
  source: "definitions" | "references",
  folderUri?: string,
): ContextFragment | null {
  if (result.fallback === "text-search") return buildTextSearchFragment(result.items, source, folderUri);
  return source === "definitions" ? buildDefinitionsFragment(result.items, folderUri) : buildReferencesFragment(result.items, folderUri);
}

/**
 * The diagnostics source: live diagnostics for every included open document,
 * flattened and capped. It never falls back to text search because text
 * search cannot produce diagnostics.
 */
export function createDiagnosticsSource(deps: LanguageSourceDeps): ContextSource {
  return {
    id: "diagnostics",
    priority: SOURCE_PRIORITIES.diagnostics,
    collect: async (signal?: AbortSignal) => {
      const documents = deps.openDocuments ?? [];
      if (documents.length === 0) return { fragments: [], omittedReason: "empty" as const };
      const included = documents.filter((document) => shouldInclude(document.path, "prompt-file", deps.policy));
      if (included.length === 0) return { fragments: [], omittedReason: "excluded" as const };
      const result = await deps.tools.diagnostics({ paths: included.map((document) => document.path) }, signal);
      if (result.items.length === 0) {
        return emptyResult(result, { files: included.length, dropped: documents.length - included.length + result.dropped });
      }
      const fragment = buildDiagnosticsFragment(result.items, deps.folderUri);
      if (fragment === null) return emptyResult(result, { files: included.length });
      return {
        fragments: [fragment],
        details: {
          files: included.length,
          count: fragment.content.split("\n").length,
          dropped: documents.length - included.length + result.dropped,
        },
      };
    },
  };
}

/** The symbols source: document symbols of the active file. */
export function createSymbolsSource(deps: LanguageSourceDeps): ContextSource {
  return {
    id: "symbols",
    priority: SOURCE_PRIORITIES.symbols,
    collect: async (signal?: AbortSignal) => {
      if (deps.activePath === undefined) return { fragments: [], omittedReason: "empty" as const };
      if (!shouldInclude(deps.activePath, "prompt-file", deps.policy)) return { fragments: [], omittedReason: "excluded" as const };
      const result = await deps.tools.documentSymbols({ path: deps.activePath, query: deps.query }, signal);
      if (result.items.length === 0) return emptyResult(result);
      const fragment = symbolFragment(result, "symbols", deps.folderUri);
      if (fragment === null) return emptyResult(result);
      return { fragments: [fragment], details: detailsOf(result, fragment.content.split("\n").length) };
    },
  };
}

/** The workspace-symbols source: never searches with an empty query. */
export function createWorkspaceSymbolsSource(deps: LanguageSourceDeps): ContextSource {
  return {
    id: "workspace-symbols",
    priority: SOURCE_PRIORITIES["workspace-symbols"],
    collect: async (signal?: AbortSignal) => {
      if (deps.query === undefined || deps.query.trim() === "") return { fragments: [], omittedReason: "empty" as const };
      const result = await deps.tools.workspaceSymbols({ query: deps.query }, signal);
      if (result.items.length === 0) return emptyResult(result);
      const fragment = symbolFragment(result, "workspace-symbols", deps.folderUri);
      if (fragment === null) return emptyResult(result);
      return { fragments: [fragment], details: detailsOf(result, fragment.content.split("\n").length) };
    },
  };
}

/** The definitions source: where the active identifier is declared. */
export function createDefinitionsSource(deps: LanguageSourceDeps): ContextSource {
  return {
    id: "definitions",
    priority: SOURCE_PRIORITIES.definitions,
    collect: async (signal?: AbortSignal) => {
      if (deps.activePath === undefined) return { fragments: [], omittedReason: "empty" as const };
      if (deps.activePosition === undefined) return { fragments: [], omittedReason: "empty" as const };
      if (!shouldInclude(deps.activePath, "prompt-file", deps.policy)) return { fragments: [], omittedReason: "excluded" as const };
      const result = await deps.tools.definitions(
        { path: deps.activePath, position: deps.activePosition, query: deps.query },
        signal,
      );
      if (result.items.length === 0) return emptyResult(result);
      const fragment = locationFragment(result, "definitions", deps.folderUri);
      if (fragment === null) return emptyResult(result);
      return { fragments: [fragment], details: detailsOf(result, fragment.content.split("\n").length) };
    },
  };
}

/** The references source: where the active identifier is used. */
export function createReferencesSource(deps: LanguageSourceDeps): ContextSource {
  return {
    id: "references",
    priority: SOURCE_PRIORITIES.references,
    collect: async (signal?: AbortSignal) => {
      if (deps.activePath === undefined) return { fragments: [], omittedReason: "empty" as const };
      if (deps.activePosition === undefined) return { fragments: [], omittedReason: "empty" as const };
      if (!shouldInclude(deps.activePath, "prompt-file", deps.policy)) return { fragments: [], omittedReason: "excluded" as const };
      const result = await deps.tools.references(
        { path: deps.activePath, position: deps.activePosition, query: deps.query },
        signal,
      );
      if (result.items.length === 0) return emptyResult(result);
      const fragment = locationFragment(result, "references", deps.folderUri);
      if (fragment === null) return emptyResult(result);
      return { fragments: [fragment], details: detailsOf(result, fragment.content.split("\n").length) };
    },
  };
}

/** The five language sources in reserved order: diagnostics first. */
export function createLanguageSources(deps: LanguageSourceDeps): ContextSource[] {
  return [
    createDiagnosticsSource(deps),
    createSymbolsSource(deps),
    createWorkspaceSymbolsSource(deps),
    createDefinitionsSource(deps),
    createReferencesSource(deps),
  ];
}

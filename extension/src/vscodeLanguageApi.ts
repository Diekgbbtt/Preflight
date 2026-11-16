// The thin VS Code adapter for the LanguageApi port (ticket #37). This is
// the only file in the ticket that imports vscode; the pure module stays
// platform-free. The adapter converts vscode values to plain objects and
// caches capability probes per document version.
import * as path from "node:path";
import * as vscode from "vscode";
import {
  MAX_TEXT_SEARCH_MATCHES,
  probeCapabilities,
  type LanguageApi,
  type LanguageCapabilities,
  type LanguageDiagnostic,
  type LanguageLocation,
  type LanguagePosition,
  type LanguageRange,
  type LanguageSymbol,
  type TextSearchMatch,
  type TextSearchOptions,
} from "./languageContext";
import { rg, type ExecResult } from "./exec";

export interface VscodeLanguageApiOptions {
  cwd?: string;
  rg?: typeof rg;
}

/** True when the path cannot be resolved inside a workspace folder. */
function isOutsideWorkspace(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..");
}

export function createVscodeLanguageApi(options: VscodeLanguageApiOptions = {}): LanguageApi & {
  probe(uri: string, signal?: AbortSignal): Promise<LanguageCapabilities | null>;
  openDocuments(): Array<{ uri: string; path: string }>;
} {
  const rgCommand = options.rg ?? rg;
  // One entry per uri, replaced on every computed probe: bounded by the
  // number of open documents, never by the number of edits.
  const probeCache = new Map<string, { version: number; capabilities: LanguageCapabilities | null }>();

  const toUri = (uri: string): vscode.Uri => vscode.Uri.parse(uri);
  const toPosition = (position: LanguagePosition): vscode.Position => new vscode.Position(position.line, position.character);

  /** Workspace-relative POSIX path, or undefined for untitled and virtual documents. */
  const relativePath = (uri: vscode.Uri): string | undefined => {
    if (uri.scheme !== "file") return undefined;
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
  };

  const toRange = (range: vscode.Range): LanguageRange => ({
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  });

  const convertSymbol = (symbol: vscode.SymbolInformation | vscode.DocumentSymbol, uri: vscode.Uri, containerName?: string): LanguageSymbol => {
    if ("location" in symbol) {
      return {
        name: symbol.name,
        kind: vscode.SymbolKind[symbol.kind] ?? String(symbol.kind),
        uri: symbol.location.uri.toString(),
        path: relativePath(symbol.location.uri),
        range: toRange(symbol.location.range),
        ...(symbol.containerName !== undefined ? { containerName: symbol.containerName } : {}),
      };
    }
    return {
      name: symbol.name,
      kind: vscode.SymbolKind[symbol.kind] ?? String(symbol.kind),
      uri: uri.toString(),
      path: relativePath(uri),
      range: toRange(symbol.range),
      ...(containerName !== undefined ? { containerName } : {}),
    };
  };

  /** Flattens a document-symbol tree into the plain LanguageSymbol list. */
  const flattenDocumentSymbols = (symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[], uri: vscode.Uri, containerName?: string): LanguageSymbol[] => {
    const result: LanguageSymbol[] = [];
    for (const symbol of symbols) {
      result.push(convertSymbol(symbol, uri, containerName));
      if ("children" in symbol && Array.isArray(symbol.children)) {
        result.push(...flattenDocumentSymbols(symbol.children, uri, symbol.name));
      }
    }
    return result;
  };

  const convertLocation = (location: vscode.Location | vscode.LocationLink): LanguageLocation => {
    if ("targetUri" in location) {
      const range = location.targetSelectionRange ?? location.targetRange;
      return { uri: location.targetUri.toString(), path: relativePath(location.targetUri), range: toRange(range) };
    }
    return { uri: location.uri.toString(), path: relativePath(location.uri), range: toRange(location.range) };
  };

  /** Accepts Location, Location | Location[], LocationLink[], or undefined. */
  const toLocations = (result: unknown): LanguageLocation[] => {
    if (result === null || result === undefined) return [];
    const list = Array.isArray(result) ? result : [result];
    return list
      .filter((item): item is vscode.Location | vscode.LocationLink => item !== null && item !== undefined)
      .map(convertLocation);
  };

  const api: LanguageApi = {
    async documentSymbols(uri: string): Promise<LanguageSymbol[]> {
      const target = toUri(uri);
      const result = (await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", target)) as
        | readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]
        | undefined;
      if (!Array.isArray(result)) return [];
      return flattenDocumentSymbols(result, target);
    },

    async workspaceSymbols(query: string): Promise<LanguageSymbol[]> {
      const result = (await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", query)) as readonly vscode.SymbolInformation[] | undefined;
      if (!Array.isArray(result)) return [];
      return result.map((symbol) => convertSymbol(symbol, toUri(symbol.location.uri.toString())));
    },

    async definitions(uri: string, position: LanguagePosition): Promise<LanguageLocation[]> {
      const result = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", toUri(uri), toPosition(position));
      return toLocations(result);
    },

    async references(uri: string, position: LanguagePosition): Promise<LanguageLocation[]> {
      const result = await vscode.commands.executeCommand("vscode.executeReferenceProvider", toUri(uri), toPosition(position));
      return toLocations(result);
    },

    async diagnostics(uri: string): Promise<LanguageDiagnostic[]> {
      const target = toUri(uri);
      const diagnostics = vscode.languages.getDiagnostics(target);
      const base = { uri: target.toString(), path: relativePath(target) };
      return diagnostics.map((diagnostic) => ({
        ...base,
        range: toRange(diagnostic.range),
        severity: vscode.DiagnosticSeverity[diagnostic.severity] ?? String(diagnostic.severity),
        ...(diagnostic.source !== undefined ? { source: diagnostic.source } : {}),
        message: diagnostic.message,
      }));
    },

    async textSearch(query: string, textOptions: TextSearchOptions): Promise<TextSearchMatch[]> {
      const cwd = textOptions.cwd ?? options.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const max = textOptions.maxResults ?? MAX_TEXT_SEARCH_MATCHES;
      const result: ExecResult = await rgCommand(["--json", "--max-count", String(max), "--", query], cwd);
      if (!result.ok) {
        if (result.code === "ENOENT") throw Object.assign(new Error("rg is not available"), { code: "ENOENT" });
        throw Object.assign(new Error(result.stderr || "rg failed"), { code: result.code });
      }
      const matches: TextSearchMatch[] = [];
      for (const line of result.stdout.split("\n")) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // not a JSON line: skip it
        }
        if (typeof parsed !== "object" || parsed === null || (parsed as { type?: unknown }).type !== "match") continue;
        const data = (parsed as { data?: Record<string, unknown> }).data ?? {};
        const relative = (data.path as { text?: unknown } | undefined)?.text;
        if (typeof relative !== "string" || isOutsideWorkspace(relative)) continue;
        const submatch = (data.submatches as Array<{ start?: unknown; end?: unknown }> | undefined)?.[0];
        const lineNumber = typeof data.line_number === "number" ? data.line_number - 1 : 0;
        const start = typeof submatch?.start === "number" ? submatch.start : 0;
        const end = typeof submatch?.end === "number" ? submatch.end : start;
        const preview = (data.lines as { text?: unknown } | undefined)?.text;
        matches.push({
          uri: vscode.Uri.file(path.join(cwd, relative)).toString(),
          path: relative.replace(/\\/g, "/"),
          range: { start: { line: lineNumber, character: start }, end: { line: lineNumber, character: end } },
          ...(typeof preview === "string" ? { preview } : {}),
        });
        if (matches.length >= max) break;
      }
      return matches;
    },
  };

  return {
    ...api,
    /**
     * The per-request probe: null with no open document for the uri; cached
     * by `uri@documentVersion` so repeated requests skip the provider calls.
     * The activation probe is the caller's non-blocking job, never this.
     */
    async probe(uri: string, signal?: AbortSignal): Promise<LanguageCapabilities | null> {
      const target = toUri(uri);
      const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === target.toString());
      if (!document) return null;
      const cached = probeCache.get(uri);
      if (cached !== undefined && cached.version === document.version) return cached.capabilities;
      const capabilities = await probeCapabilities(api, uri, 3000, signal);
      probeCache.set(uri, { version: document.version, capabilities });
      return capabilities;
    },

    /** The open file documents, for the diagnostics source's input list. */
    openDocuments(): Array<{ uri: string; path: string }> {
      return vscode.workspace.textDocuments
        .filter((document) => document.uri.scheme === "file")
        .map((document) => ({ uri: document.uri.toString(), path: relativePath(document.uri) ?? "" }));
    },
  };
}

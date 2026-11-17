// The thin VS Code adapter for the LSP protocol port and the text-search port
// (ticket #37). This is the only file in this layer that imports vscode.
// It converts editor values to LSP types and delegates policy to the tools.
import * as nodePath from "node:path";
import * as vscode from "vscode";
import {
  DiagnosticSeverity,
  SymbolKind,
  type Diagnostic,
  type DefinitionParams,
  type DocumentSymbolParams,
  type Location,
  type Position,
  type Range,
  type ReferenceParams,
  type SymbolInformation,
  type WorkspaceSymbolParams,
} from "vscode-languageserver-protocol";
import type { CancellationToken } from "vscode-jsonrpc";
import type { LanguageProtocol, TextSearchMatch, TextSearchPort } from "./codeTools";
import { EXCLUDE_GLOB, isOutsideWorkspace } from "./privacy";
import { parseRipgrepFiles, parseRipgrepJson, runRipgrep } from "./ripgrep";

export interface VscodeCodeToolsOptions {
  /** Workspace root for uriOf and rg. Defaults to the first workspace folder. */
  cwd?: string;
  /** The bundled rg binary. */
  rgPath?: string;
  /** Injectable executor for tests. */
  runRipgrep?: typeof runRipgrep;
}

export function createVscodeCodeTools(options: VscodeCodeToolsOptions = {}): LanguageProtocol & TextSearchPort {
  const toUri = (uri: string): vscode.Uri => vscode.Uri.parse(uri);
  const toPosition = (position: Position): vscode.Position => new vscode.Position(position.line, position.character);
  const toRange = (range: vscode.Range): Range => ({
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  });

  const rootPath = (): string | undefined => options.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  /** Workspace-relative POSIX path, or undefined for virtual and outside documents. */
  const relativePath = (uri: vscode.Uri): string | undefined => {
    if (uri.scheme !== "file") return undefined;
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/").replace(/^\.\//, "");
    if (relative === "" || isOutsideWorkspace(relative)) return undefined;
    return relative;
  };

  const pathOf = (uri: string): string | undefined => {
    try {
      return relativePath(toUri(uri));
    } catch {
      return undefined;
    }
  };

  const uriOf = (path: string): string | undefined => {
    if (isOutsideWorkspace(path)) return undefined;
    const root = rootPath();
    if (!root) return undefined;
    return vscode.Uri.file(nodePath.join(root, path)).toString();
  };

  const cancelledError = (): Error => Object.assign(new Error("cancelled"), { code: "cancelled" });
  const checkToken = (token: CancellationToken): void => {
    if (token.isCancellationRequested) throw cancelledError();
  };

  /** VS Code SymbolKind values are one lower than LSP values; map by name. */
  const lspSymbolKind = (kind: vscode.SymbolKind): SymbolKind => {
    const name = vscode.SymbolKind[kind];
    return ((SymbolKind as unknown as Record<string, number>)[name] ?? SymbolKind.Variable) as SymbolKind;
  };

  /** VS Code DiagnosticSeverity values are one lower than LSP values; map by name. */
  const lspSeverity = (severity: vscode.DiagnosticSeverity): DiagnosticSeverity => {
    const name = vscode.DiagnosticSeverity[severity];
    return ((DiagnosticSeverity as unknown as Record<string, number>)[name] ?? DiagnosticSeverity.Information) as DiagnosticSeverity;
  };

  const toSymbolInformation = (
    symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
    documentUri: vscode.Uri,
    containerName?: string,
  ): SymbolInformation => {
    if ("location" in symbol) {
      return {
        name: symbol.name,
        kind: lspSymbolKind(symbol.kind),
        location: { uri: symbol.location.uri.toString(), range: toRange(symbol.location.range) },
        ...(symbol.containerName !== undefined ? { containerName: symbol.containerName } : {}),
      };
    }
    return {
      name: symbol.name,
      kind: lspSymbolKind(symbol.kind),
      location: { uri: documentUri.toString(), range: toRange(symbol.range) },
      ...(containerName !== undefined ? { containerName } : {}),
    };
  };

  /** Flattens a DocumentSymbol tree into LSP SymbolInformation records. */
  const flattenSymbols = (
    symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
    uri: vscode.Uri,
    containerName?: string,
  ): SymbolInformation[] => {
    const out: SymbolInformation[] = [];
    for (const symbol of symbols) {
      out.push(toSymbolInformation(symbol, uri, containerName));
      if ("children" in symbol && Array.isArray(symbol.children)) {
        out.push(...flattenSymbols(symbol.children, uri, symbol.name));
      }
    }
    return out;
  };

  const toLocations = (value: unknown): Location[] => {
    if (value === null || value === undefined) return [];
    const list = Array.isArray(value) ? value : [value];
    const out: Location[] = [];
    for (const item of list) {
      if (item === null || item === undefined) continue;
      if ("targetUri" in item) {
        const link = item as vscode.LocationLink;
        out.push({ uri: link.targetUri.toString(), range: toRange(link.targetSelectionRange ?? link.targetRange) });
      } else {
        const location = item as vscode.Location;
        out.push({ uri: location.uri.toString(), range: toRange(location.range) });
      }
    }
    return out;
  };

  const rgPath = options.rgPath;
  const rg = options.runRipgrep ?? runRipgrep;
  const requireRg = (): string => {
    if (!rgPath) throw Object.assign(new Error("rg is not available"), { code: "ENOENT" });
    return rgPath;
  };

  return {
    uriOf,
    pathOf,

    async documentSymbols(params: DocumentSymbolParams, token: CancellationToken): Promise<SymbolInformation[]> {
      checkToken(token);
      const target = toUri(params.textDocument.uri);
      const result = (await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", target)) as
        | readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]
        | undefined;
      if (!Array.isArray(result)) return [];
      return flattenSymbols(result, target);
    },

    async workspaceSymbols(params: WorkspaceSymbolParams, token: CancellationToken): Promise<SymbolInformation[]> {
      checkToken(token);
      const result = (await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", params.query)) as
        | readonly vscode.SymbolInformation[]
        | undefined;
      if (!Array.isArray(result)) return [];
      return result.map((symbol) => toSymbolInformation(symbol, toUri(symbol.location.uri.toString())));
    },

    async definitions(params: DefinitionParams, token: CancellationToken): Promise<Location[]> {
      checkToken(token);
      const result = await vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider",
        toUri(params.textDocument.uri),
        toPosition(params.position),
      );
      return toLocations(result);
    },

    async references(params: ReferenceParams, token: CancellationToken): Promise<Location[]> {
      checkToken(token);
      const result = await vscode.commands.executeCommand(
        "vscode.executeReferenceProvider",
        toUri(params.textDocument.uri),
        toPosition(params.position),
      );
      return toLocations(result);
    },

    async diagnostics(uri: string, token: CancellationToken): Promise<Diagnostic[]> {
      checkToken(token);
      return vscode.languages.getDiagnostics(toUri(uri)).map((diagnostic) => ({
        range: toRange(diagnostic.range),
        severity: lspSeverity(diagnostic.severity),
        ...(diagnostic.source !== undefined ? { source: diagnostic.source } : {}),
        message: diagnostic.message,
      }));
    },

    async workspaceFiles(token: CancellationToken): Promise<string[]> {
      checkToken(token);
      const uris = await vscode.workspace.findFiles("**/*", EXCLUDE_GLOB, 2000);
      const files: string[] = [];
      for (const uri of uris) {
        const relative = relativePath(uri);
        if (relative !== undefined) files.push(relative);
      }
      return files;
    },

    async search(query: string, textOptions: { cwd?: string; maxResults: number }): Promise<TextSearchMatch[]> {
      const cwd = textOptions.cwd ?? rootPath() ?? process.cwd();
      const max = textOptions.maxResults;
      const result = await rg(requireRg(), ["--json", "--max-count", String(max), "--", query], cwd);
      if (!result.ok) {
        if (result.code === "ENOENT") throw Object.assign(new Error("rg is not available"), { code: "ENOENT" });
        throw Object.assign(new Error(result.stderr || "rg failed"), { code: result.code });
      }
      return parseRipgrepJson(result.stdout, cwd, max);
    },

    async listFiles(fileOptions: { cwd?: string; maxResults: number }): Promise<string[]> {
      const cwd = fileOptions.cwd ?? rootPath() ?? process.cwd();
      const result = await rg(requireRg(), ["--files"], cwd);
      if (!result.ok) {
        if (result.code === "ENOENT") throw Object.assign(new Error("rg is not available"), { code: "ENOENT" });
        throw Object.assign(new Error(result.stderr || "rg failed"), { code: result.code });
      }
      return parseRipgrepFiles(result.stdout, fileOptions.maxResults);
    },
  };
}

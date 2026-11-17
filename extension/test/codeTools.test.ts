import { describe, expect, it, vi } from "vitest";
import {
  DiagnosticSeverity,
  SymbolKind,
  type Diagnostic,
  type Location,
  type SymbolInformation,
} from "vscode-languageserver-protocol";
import { createCodeTools, CODE_TOOL_CAPS, type LanguageProtocol, type TextSearchPort } from "../src/codeTools";

const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 5 } });
const uri = (path: string) => `file:///w/${path}`;

const symbol = (name: string, path: string, kind: SymbolInformation["kind"] = SymbolKind.Function): SymbolInformation => ({
  name,
  kind,
  location: { uri: uri(path), range: at(1) },
});

const location = (path: string): Location => ({ uri: uri(path), range: at(2) });
const diagnostic = (message: string): Diagnostic => ({ range: at(0), severity: DiagnosticSeverity.Error, source: "tsc", message });

const protocol = (over: Partial<LanguageProtocol> = {}): LanguageProtocol => ({
  uriOf: (path) => uri(path),
  pathOf: (value) => (value.startsWith("file:///w/") ? value.slice("file:///w/".length) : undefined),
  documentSymbols: async () => [symbol("greet", "src/a.ts")],
  workspaceSymbols: async () => [symbol("Thing", "src/a.ts", SymbolKind.Class)],
  definitions: async () => [location("src/a.ts")],
  references: async () => [location("src/a.ts")],
  diagnostics: async () => [diagnostic("boom")],
  ...over,
});

const textSearch = (over: Partial<TextSearchPort> = {}): TextSearchPort => ({
  search: async (query) => [{ uri: uri("src/a.ts"), path: "src/a.ts", range: at(3), preview: query }],
  listFiles: async () => ["src/a.ts"],
  ...over,
});

const tools = (over: { protocol?: Partial<LanguageProtocol>; textSearch?: Partial<TextSearchPort>; policy?: { includeCode: "off" | "prompt-files" | "workspace"; promptFiles?: string[] } } = {}) =>
  createCodeTools({
    protocol: protocol(over.protocol),
    textSearch: textSearch(over.textSearch),
    policy: over.policy ?? { includeCode: "workspace" },
  });

describe("documentSymbols tool", () => {
  it("converts LSP symbols to display symbols and filters by policy", async () => {
    const result = await tools().documentSymbols({ path: "src/a.ts" });
    if (result.fallback) throw new Error("unexpected fallback");
    expect(result.items).toEqual([{ name: "greet", kind: "Function", uri: uri("src/a.ts"), path: "src/a.ts", range: at(1) }]);
    expect(result).toMatchObject({ truncated: false, dropped: 0 });
  });

  it("drops pathless symbols and excluded paths", async () => {
    const result = await tools({
      protocol: {
        documentSymbols: async () => [
          symbol("keep", "src/a.ts"),
          { name: "orphan", kind: SymbolKind.Function, location: { uri: "untitled:1", range: at(1) } },
          symbol("secret", "credentials.json"),
        ],
      },
    }).documentSymbols({ path: "src/a.ts" });
    if (result.fallback) throw new Error("unexpected fallback");
    expect(result.items.map((item) => item.name)).toEqual(["keep"]);
    expect(result.dropped).toBe(2);
  });

  it("caps at 100 and marks truncated", async () => {
    const many = Array.from({ length: 101 }, (_, i) => symbol(`s${i}`, "src/a.ts"));
    const result = await tools({ protocol: { documentSymbols: async () => many } }).documentSymbols({ path: "src/a.ts" });
    expect(result.items).toHaveLength(CODE_TOOL_CAPS.documentSymbols);
    expect(result.truncated).toBe(true);
  });

  it("falls back to text search when the LSP result is empty and a query exists", async () => {
    const result = await tools({ protocol: { documentSymbols: async () => [] } }).documentSymbols({ path: "src/a.ts", query: "greet" });
    expect(result.fallback).toBe("text-search");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].path).toBe("src/a.ts");
  });

  it("does not fall back when the LSP result is non-empty", async () => {
    const search = vi.fn();
    const result = await tools({ textSearch: { search } }).documentSymbols({ path: "src/a.ts", query: "greet" });
    expect(result.items).toHaveLength(1);
    expect(search).not.toHaveBeenCalled();
  });

  it("does not fall back when policy hid every result", async () => {
    const search = vi.fn();
    const result = await tools({
      protocol: { documentSymbols: async () => [symbol("secret", "credentials.json")] },
      textSearch: { search },
    }).documentSymbols({ path: "src/a.ts", query: "secret" });
    expect(result.items).toEqual([]);
    expect(result.dropped).toBe(1);
    expect(result.fallback).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });

  it("omits empty without a query and does not mark a fallback", async () => {
    const result = await tools({ protocol: { documentSymbols: async () => [] } }).documentSymbols({ path: "src/a.ts" });
    expect(result.items).toEqual([]);
    expect(result.omittedReason).toBe("empty");
    expect(result.fallback).toBeUndefined();
  });

  it("omits excluded when the input path is outside the policy", async () => {
    const result = await tools({ policy: { includeCode: "prompt-files", promptFiles: [] } }).documentSymbols({ path: "src/a.ts" });
    expect(result.items).toEqual([]);
    expect(result.omittedReason).toBe("excluded");
  });
});

describe("workspaceSymbols tool", () => {
  it("converts and caps at 50", async () => {
    const many = Array.from({ length: 55 }, (_, i) => symbol(`s${i}`, "src/a.ts"));
    const result = await tools({ protocol: { workspaceSymbols: async () => many } }).workspaceSymbols({ query: "s" });
    expect(result.items).toHaveLength(CODE_TOOL_CAPS.workspaceSymbols);
    expect(result.truncated).toBe(true);
  });

  it("falls back to text search on an empty result", async () => {
    const result = await tools({ protocol: { workspaceSymbols: async () => [] } }).workspaceSymbols({ query: "Thing" });
    expect(result.fallback).toBe("text-search");
    expect(result.items).toHaveLength(1);
  });

  it("omits empty without a query", async () => {
    const result = await tools().workspaceSymbols({ query: "   " });
    expect(result.omittedReason).toBe("empty");
  });
});

describe("definitions and references tools", () => {
  it("converts locations, caps definitions at 20 and references at 50", async () => {
    const many = Array.from({ length: 60 }, () => location("src/a.ts"));
    const defs = await tools({ protocol: { definitions: async () => many } }).definitions({ path: "src/a.ts", position: { line: 1, character: 0 } });
    const refs = await tools({ protocol: { references: async () => many } }).references({ path: "src/a.ts", position: { line: 1, character: 0 } });
    expect(defs.items).toHaveLength(CODE_TOOL_CAPS.definitions);
    expect(refs.items).toHaveLength(CODE_TOOL_CAPS.references);
  });

  it("falls back to text search on empty and a query", async () => {
    const defs = await tools({ protocol: { definitions: async () => [] } }).definitions({ path: "src/a.ts", position: { line: 1, character: 0 }, query: "greet" });
    expect(defs.fallback).toBe("text-search");
    const refs = await tools({ protocol: { references: async () => [] } }).references({ path: "src/a.ts", position: { line: 1, character: 0 }, query: "greet" });
    expect(refs.fallback).toBe("text-search");
  });

  it("does not fall back on a policy-hidden result", async () => {
    const search = vi.fn();
    const defs = await tools({
      protocol: { definitions: async () => [location("credentials.json")] },
      textSearch: { search },
    }).definitions({ path: "src/a.ts", position: { line: 1, character: 0 }, query: "greet" });
    expect(defs.items).toEqual([]);
    expect(defs.dropped).toBe(1);
    expect(search).not.toHaveBeenCalled();
  });

  it("passes the includeDeclaration flag through", async () => {
    const references = vi.fn(async () => [location("src/a.ts")]);
    await tools({ protocol: { references } }).references({ path: "src/a.ts", position: { line: 1, character: 2 }, includeDeclaration: true });
    expect(references).toHaveBeenCalledWith(expect.objectContaining({ context: { includeDeclaration: true } }), expect.anything());
  });
});

describe("diagnostics tool", () => {
  it("flattens documents, filters and caps at 200", async () => {
    const many = Array.from({ length: 210 }, (_, i) => diagnostic(`m${i}`));
    const result = await tools({ protocol: { diagnostics: async () => many } }).diagnostics({ paths: ["src/a.ts"] });
    expect(result.items).toHaveLength(CODE_TOOL_CAPS.diagnostics);
    expect(result.truncated).toBe(true);
    expect(result.items[0]).toMatchObject({ path: "src/a.ts", severity: "Error", source: "tsc", message: "m0" });
  });

  it("never falls back to text search", async () => {
    const search = vi.fn();
    const result = await tools({ protocol: { diagnostics: async () => [] }, textSearch: { search } }).diagnostics({ paths: ["src/a.ts"] });
    expect(result.items).toEqual([]);
    expect(result.omittedReason).toBe("empty");
    expect(search).not.toHaveBeenCalled();
  });

  it("drops excluded documents before calling the provider", async () => {
    const diagnostics = vi.fn(async () => [diagnostic("boom")]);
    const result = await tools({ protocol: { diagnostics } }).diagnostics({ paths: ["credentials.json", "src/a.ts"] });
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(1);
    expect(result.dropped).toBe(1);
  });
});

describe("searchText and listFiles tools", () => {
  it("caps text search at 50 and filters outside paths", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ uri: uri(`f${i}.ts`), path: `f${i}.ts`, range: at(0) }));
    const result = await tools({ textSearch: { search: async () => many } }).searchText({ query: "x" });
    expect(result.items).toHaveLength(CODE_TOOL_CAPS.textSearch);
    expect(result.truncated).toBe(true);
  });

  it("maps a missing rg to unsupported", async () => {
    const result = await tools({
      textSearch: {
        search: async () => {
          throw Object.assign(new Error("rg is not available"), { code: "ENOENT" });
        },
      },
    }).searchText({ query: "x" });
    expect(result.omittedReason).toBe("unsupported");
  });

  it("uses the LSP file list first and falls back to rg --files", async () => {
    const listFiles = vi.fn(async () => ["src/a.ts"]);
    const primary = await tools({ protocol: { workspaceFiles: listFiles } }).listFiles({});
    expect(primary.items).toEqual(["src/a.ts"]);
    expect(primary.fallback).toBeUndefined();

    const fallback = await tools({
      protocol: { workspaceFiles: async () => [] },
      textSearch: { listFiles: async () => ["src/b.ts"] },
    }).listFiles({});
    expect(fallback.items).toEqual(["src/b.ts"]);
    expect(fallback.fallback).toBe("text-search");
  });

  it("omits unsupported when neither file list exists", async () => {
    const result = await tools({
      protocol: { workspaceFiles: undefined },
      textSearch: { listFiles: undefined, search: async () => [] },
    }).listFiles({});
    expect(result.omittedReason).toBe("unsupported");
  });

  it("does not fall back when the primary list hid every path", async () => {
    const searchFiles = vi.fn(async () => ["src/secret.ts"]);
    const result = await tools({
      protocol: { workspaceFiles: async () => ["credentials.json"] },
      textSearch: { listFiles: searchFiles },
    }).listFiles({});
    expect(result.items).toEqual([]);
    expect(result.omittedReason).toBe("empty");
    expect(searchFiles).not.toHaveBeenCalled();
  });
});

describe("tool failure and cancellation", () => {
  it("returns error when the protocol throws", async () => {
    const result = await tools({
      protocol: {
        documentSymbols: async () => {
          throw new Error("boom");
        },
      },
    }).documentSymbols({ path: "src/a.ts" });
    expect(result.omittedReason).toBe("error");
  });

  it("returns error when the provider times out", async () => {
    const result = await createCodeTools({
      protocol: protocol({ documentSymbols: () => new Promise(() => undefined) }),
      textSearch: textSearch(),
      policy: { includeCode: "workspace" },
      timeoutMs: 5,
    }).documentSymbols({ path: "src/a.ts" });
    expect(result.omittedReason).toBe("error");
  });

  it("rejects with cancelled when the signal aborts", async () => {
    const controller = new AbortController();
    const promise = createCodeTools({
      protocol: protocol({
        documentSymbols: () => new Promise(() => undefined),
      }),
      textSearch: textSearch(),
      policy: { includeCode: "workspace" },
    }).documentSymbols({ path: "src/a.ts" }, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });
});

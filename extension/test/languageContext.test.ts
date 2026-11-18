// Ticket #37: language context on top of the agent code tools. No vscode import here.
import { describe, expect, it, vi } from "vitest";
import { gitChangedFiles, gitStatus, type ExecFileLike } from "../src/exec";
import type {
  CodebaseTools,
  TextSearchMatch,
  ToolDiagnostic,
  ToolLocation,
  ToolResult,
  ToolSymbol,
} from "../src/codeTools";
import {
  buildDefinitionsFragment,
  buildDiagnosticsFragment,
  buildReferencesFragment,
  buildSymbolsFragment,
  buildTextSearchFragment,
  buildWorkspaceSymbolsFragment,
  createDefinitionsSource,
  createDiagnosticsSource,
  createLanguageSources,
  createReferencesSource,
  createSymbolsSource,
  createWorkspaceSymbolsSource,
  type LanguageSourceDeps,
} from "../src/languageContext";

const at = (line: number, character = 0) => ({ start: { line, character }, end: { line, character: character + 5 } });
const uri = (path: string) => `file:///w/${path}`;
const result = <T>(items: T[], over: Partial<ToolResult<T>> = {}): ToolResult<T> => ({ items, truncated: false, dropped: 0, ...over });
const fallback = (items: TextSearchMatch[], over: Partial<ToolResult<TextSearchMatch>> = {}) =>
  ({ ...result(items, over), fallback: "text-search" as const });

const sym = (name: string, path?: string): ToolSymbol => ({
  name,
  kind: "function",
  ...(path !== undefined ? { uri: uri(path), path, range: at(0) } : {}),
});
const loc = (path?: string, name?: string): ToolLocation => ({
  uri: path !== undefined ? uri(path) : uri("src/a.ts"),
  ...(path !== undefined ? { path } : {}),
  range: at(2),
  ...(name !== undefined ? { name } : {}),
});
const diag = (path: string, message = "boom"): ToolDiagnostic => ({
  uri: uri(path),
  path,
  range: at(0, 2),
  severity: "error",
  source: "tsc",
  message,
});
const match = (path: string, preview = "hit"): TextSearchMatch => ({ uri: uri(path), path, range: at(3), preview });

const tools = (over: Partial<CodebaseTools> = {}): CodebaseTools => ({
  documentSymbols: async () => result([sym("makeThing", "src/a.ts")]),
  workspaceSymbols: async () => result([sym("Thing", "src/a.ts")]),
  definitions: async () => result([loc("src/a.ts", "makeThing")]),
  references: async () => result([loc("src/a.ts")]),
  diagnostics: async () => result([diag("a.ts")]),
  searchText: async () => result([match("src/a.ts")]),
  listFiles: async () => result(["src/a.ts"]),
  ...over,
});

const deps = (over: Partial<LanguageSourceDeps> = {}): LanguageSourceDeps => ({
  tools: tools(),
  policy: { includeCode: "workspace" },
  folderUri: "file:///w",
  ...over,
});

const options = { cwd: "/repo", timeout: 5000, maxBuffer: 1024 * 1024 };

describe("gitStatus", () => {
  it("requests porcelain v1 with -z and keeps spaces in paths", async () => {
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(null, "M  a.ts\0?? my new file.ts\0", ""));
    const result = await gitStatus("/repo", exec);
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain=v1", "-z"], options, expect.any(Function));
    expect(result).toEqual({ ok: true, entries: [{ status: "M ", path: "a.ts" }, { status: "??", path: "my new file.ts" }], truncated: false });
  });
});

describe("gitChangedFiles", () => {
  it("unions status paths with the last 5 commits' names, unique and sorted", async () => {
    const exec = vi.fn<ExecFileLike>((_c, args, _o, cb) => {
      if (args[0] === "status") cb(null, "M  b.ts\0?? a.ts\0", "");
      else cb(null, "c.ts\0a.ts\0", "");
    });
    const result = await gitChangedFiles("/repo", exec);
    if (!result.ok) throw new Error("expected ok");
    expect(result.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("fragment builders", () => {
  it("builds one diagnostic line per item and caps at 200", () => {
    const fragment = buildDiagnosticsFragment([diag("src/a.ts"), diag("src/b.ts", "line one\nline two")], "file:///w");
    expect(fragment?.content.split("\n")).toEqual([
      "error tsc src/a.ts:1:3-1:8 boom",
      "error tsc src/b.ts:1:3-1:8 line one line two",
    ]);
    expect(fragment?.source).toBe("diagnostics");
    expect(fragment?.priority).toBe(45);
    const many = Array.from({ length: 201 }, (_, i) => diag(`f${i}.ts`));
    expect(buildDiagnosticsFragment(many)?.provenance.truncated).toBe(true);
    expect(buildDiagnosticsFragment(many)?.content.split("\n")).toHaveLength(200);
  });

  it("builds symbol lines with containers and caps at 100", () => {
    const fragment = buildSymbolsFragment([sym("makeThing", "src/a.ts"), { ...sym("build", "src/a.ts"), containerName: "Thing" }]);
    expect(fragment?.content.split("\n")).toEqual(["src/a.ts:1:1 function makeThing", "src/a.ts:1:1 function Thing.build"]);
    expect(fragment?.provenance.path).toBe("src/a.ts");
    expect(buildSymbolsFragment(Array.from({ length: 101 }, (_, i) => sym(`s${i}`, "src/a.ts")))?.provenance.truncated).toBe(true);
  });

  it("builds workspace-symbol lines and caps at 50", () => {
    const fragment = buildWorkspaceSymbolsFragment([sym("Thing", "src/a.ts")]);
    expect(fragment?.content).toBe("src/a.ts:1:1 function Thing");
    expect(buildWorkspaceSymbolsFragment(Array.from({ length: 51 }, (_, i) => sym(`s${i}`, "src/a.ts")))?.provenance.truncated).toBe(true);
  });

  it("builds definition and reference lines and caps at 20 and 50", () => {
    expect(buildDefinitionsFragment([loc("src/a.ts", "makeThing")])?.content).toBe("src/a.ts:3:1 makeThing");
    expect(buildReferencesFragment([loc("src/a.ts")])?.content).toBe("src/a.ts:3:1");
    expect(buildDefinitionsFragment(Array.from({ length: 21 }, (_, i) => loc(`f${i}.ts`)))?.provenance.truncated).toBe(true);
    expect(buildReferencesFragment(Array.from({ length: 51 }, (_, i) => loc(`f${i}.ts`)))?.provenance.truncated).toBe(true);
  });

  it("builds text-search lines and caps at 50", () => {
    const fragment = buildTextSearchFragment([match("src/a.ts", "const thing = 1;")], "symbols", "file:///w");
    expect(fragment?.content).toBe("src/a.ts:4:1 const thing = 1;");
    expect(fragment?.provenance.kind).toBe("text-search");
    expect(fragment?.source).toBe("symbols");
    expect(fragment?.priority).toBe(40);
    expect(buildTextSearchFragment(Array.from({ length: 51 }, (_, i) => match(`f${i}.ts`)), "symbols")?.provenance.truncated).toBe(true);
  });
});

describe("createDiagnosticsSource", () => {
  it("has the diagnostics source id and priority", () => {
    expect(createDiagnosticsSource(deps()).id).toBe("diagnostics");
    expect(createDiagnosticsSource(deps()).priority).toBe(45);
  });

  it("omits with empty when there are no open documents", async () => {
    expect((await createDiagnosticsSource(deps()).collect()).omittedReason).toBe("empty");
  });

  it("collects diagnostics for included documents with details", async () => {
    const result = await createDiagnosticsSource(
      deps({ openDocuments: [{ uri: uri("a.ts"), path: "a.ts" }] }),
    ).collect();
    expect(result.fragments[0]?.content).toBe("error tsc a.ts:1:3-1:8 boom");
    expect(result.details).toEqual({ files: 1, count: 1, dropped: 0 });
  });

  it("skips excluded documents and counts the drop", async () => {
    const result = await createDiagnosticsSource(
      deps({
        openDocuments: [
          { uri: uri("a.ts"), path: "a.ts" },
          { uri: uri("node_modules/n/x.ts"), path: "node_modules/n/x.ts" },
        ],
      }),
    ).collect();
    expect(result.details).toEqual({ files: 1, count: 1, dropped: 1 });
  });

  it("omits with excluded when every document is excluded", async () => {
    const result = await createDiagnosticsSource(
      deps({ openDocuments: [{ uri: uri("credentials.json"), path: "credentials.json" }] }),
    ).collect();
    expect(result.omittedReason).toBe("excluded");
  });

  it("passes an empty diagnostics result through as empty", async () => {
    const result = await createDiagnosticsSource(
      deps({ tools: tools({ diagnostics: async () => ({ items: [], truncated: false, dropped: 0, omittedReason: "empty" }) }), openDocuments: [{ uri: uri("a.ts"), path: "a.ts" }] }),
    ).collect();
    expect(result.omittedReason).toBe("empty");
  });

  it("maps a tool error to error", async () => {
    const result = await createDiagnosticsSource(
      deps({ tools: tools({ diagnostics: async () => ({ items: [], truncated: false, dropped: 0, omittedReason: "error" }) }), openDocuments: [{ uri: uri("a.ts"), path: "a.ts" }] }),
    ).collect();
    expect(result.omittedReason).toBe("error");
  });
});

describe("createSymbolsSource", () => {
  it("omits with empty without an active path, and excluded when the path is excluded", async () => {
    expect((await createSymbolsSource(deps()).collect()).omittedReason).toBe("empty");
    expect((await createSymbolsSource(deps({ activePath: "node_modules/n/x.ts" })).collect()).omittedReason).toBe("excluded");
  });

  it("collects document symbols with details", async () => {
    const result = await createSymbolsSource(deps({ activePath: "src/a.ts" })).collect();
    expect(result.fragments[0]?.content).toBe("src/a.ts:1:1 function makeThing");
    expect(result.details).toEqual({ count: 1, dropped: 0 });
  });

  it("marks a text-search fallback in the fragment and details", async () => {
    const result = await createSymbolsSource(
      deps({ tools: tools({ documentSymbols: async () => fallback([match("src/a.ts")]) }), activePath: "src/a.ts", query: "makeThing" }),
    ).collect();
    expect(result.fragments[0]?.provenance.kind).toBe("text-search");
    expect(result.fragments[0]?.source).toBe("symbols");
    expect(result.details).toEqual({ count: 1, dropped: 0, textSearch: true });
  });

  it("passes the tool omission reason through", async () => {
    const error = await createSymbolsSource(
      deps({ tools: tools({ documentSymbols: async () => ({ items: [], truncated: false, dropped: 0, omittedReason: "error" }) }), activePath: "src/a.ts" }),
    ).collect();
    expect(error.omittedReason).toBe("error");
    const unsupported = await createSymbolsSource(
      deps({ tools: tools({ documentSymbols: async () => ({ items: [], truncated: false, dropped: 0, omittedReason: "unsupported" }) }), activePath: "src/a.ts", query: "x" }),
    ).collect();
    expect(unsupported.omittedReason).toBe("unsupported");
  });
});

describe("createWorkspaceSymbolsSource", () => {
  it("omits with empty on a blank query without calling the tool", async () => {
    const documentSymbols = vi.fn();
    const result = await createWorkspaceSymbolsSource(deps({ tools: tools({ workspaceSymbols: documentSymbols }), query: "  " })).collect();
    expect(result.omittedReason).toBe("empty");
    expect(documentSymbols).not.toHaveBeenCalled();
  });

  it("collects workspace symbols and falls back to text search", async () => {
    const result = await createWorkspaceSymbolsSource(deps({ query: "Thing" })).collect();
    expect(result.fragments[0]?.content).toBe("src/a.ts:1:1 function Thing");
    const fallbacked = await createWorkspaceSymbolsSource(
      deps({ tools: tools({ workspaceSymbols: async () => fallback([match("src/a.ts", "class Thing")]) }), query: "Thing" }),
    ).collect();
    expect(fallbacked.fragments[0]?.provenance.kind).toBe("text-search");
    expect(fallbacked.details).toEqual({ count: 1, dropped: 0, textSearch: true });
  });
});

describe("createDefinitionsSource and createReferencesSource", () => {
  it("omits with empty without a position", async () => {
    expect((await createDefinitionsSource(deps({ activePath: "src/a.ts" })).collect()).omittedReason).toBe("empty");
    expect((await createReferencesSource(deps({ activePath: "src/a.ts" })).collect()).omittedReason).toBe("empty");
  });

  it("collects definitions and references with details", async () => {
    const definitions = await createDefinitionsSource(deps({ activePath: "src/a.ts", activePosition: { line: 1, character: 0 } })).collect();
    expect(definitions.fragments[0]?.content).toBe("src/a.ts:3:1 makeThing");
    expect(definitions.details).toEqual({ count: 1, dropped: 0 });
    const references = await createReferencesSource(deps({ activePath: "src/a.ts", activePosition: { line: 1, character: 0 } })).collect();
    expect(references.fragments[0]?.content).toBe("src/a.ts:3:1");
  });

  it("falls back to text search for both", async () => {
    const fallbackTools = tools({
      definitions: async () => fallback([match("src/a.ts", "makeThing")]),
      references: async () => fallback([match("src/a.ts", "makeThing")]),
    });
    const definitions = await createDefinitionsSource(
      deps({ tools: fallbackTools, activePath: "src/a.ts", activePosition: { line: 1, character: 0 }, query: "makeThing" }),
    ).collect();
    expect(definitions.fragments[0]?.provenance.kind).toBe("text-search");
    const references = await createReferencesSource(
      deps({ tools: fallbackTools, activePath: "src/a.ts", activePosition: { line: 1, character: 0 }, query: "makeThing" }),
    ).collect();
    expect(references.fragments[0]?.provenance.kind).toBe("text-search");
  });
});

describe("createLanguageSources", () => {
  it("returns the five language sources in reserved order", () => {
    const sources = createLanguageSources(deps());
    expect(sources.map((source) => source.id)).toEqual(["diagnostics", "symbols", "workspace-symbols", "definitions", "references"]);
    expect(sources.map((source) => source.priority)).toEqual([45, 40, 37, 38, 39]);
  });
});

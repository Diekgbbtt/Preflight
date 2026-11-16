// Ticket #37: the thin VS Code adapter. This is the only test allowed to
// mock the vscode platform module.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "../src/exec";
import { createVscodeLanguageApi } from "../src/vscodeLanguageApi";

type FakeUri = { scheme: string; fsPath: string; toString: () => string };

const fileUri = (fsPath: string): FakeUri => ({ scheme: "file", fsPath, toString: () => `file://${fsPath}` });

const vscodeMock = vi.hoisted(() => {
  const SymbolKind = { Namespace: 1, Class: 4, Method: 6, Function: 12, Variable: 13 } as Record<number | string, string | number>;
  for (const [name, value] of Object.entries({ Namespace: 1, Class: 4, Method: 6, Function: 12, Variable: 13 })) SymbolKind[value as number] = name;
  const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as Record<number | string, string | number>;
  for (const [name, value] of Object.entries({ Error: 0, Warning: 1, Information: 2, Hint: 3 })) DiagnosticSeverity[value as number] = name;
  return {
    Uri: {
      parse: (value: string): FakeUri => {
        const fsPath = decodeURIComponent(value.replace(/^file:\/\//, ""));
        return { scheme: value.startsWith("file:") ? "file" : value.split(":")[0], fsPath, toString: () => value };
      },
      file: (fsPath: string): FakeUri => fileUri(fsPath),
    },
    Position: class {
      line: number;
      character: number;
      constructor(line: number, character: number) {
        this.line = line;
        this.character = character;
      }
    },
    workspace: {
      asRelativePath: (uri: FakeUri): string => uri.fsPath.replace(/^\/w\//, ""),
      textDocuments: [] as Array<{ uri: FakeUri; version: number }>,
      workspaceFolders: undefined as Array<{ uri: FakeUri }> | undefined,
    },
    commands: { executeCommand: vi.fn() },
    languages: { getDiagnostics: vi.fn() },
    SymbolKind,
    DiagnosticSeverity,
  };
});

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));

const range = { start: { line: 2, character: 0 }, end: { line: 9, character: 1 } };
const mockRange = { start: { line: 2, character: 0 }, end: { line: 9, character: 1 } };

beforeEach(() => {
  vscodeMock.commands.executeCommand.mockReset();
  vscodeMock.languages.getDiagnostics.mockReset();
  vscodeMock.workspace.textDocuments = [];
});

describe("createVscodeLanguageApi documentSymbols", () => {
  it("flattens DocumentSymbols with kind names and relative paths", async () => {
    vscodeMock.commands.executeCommand.mockResolvedValue([
      {
        name: "Thing",
        kind: 4,
        range: mockRange,
        selectionRange: mockRange,
        children: [{ name: "build", kind: 6, range: mockRange, selectionRange: mockRange, children: [] }],
      },
    ]);
    const api = createVscodeLanguageApi();
    const symbols = await api.documentSymbols("file:///w/src/a.ts");
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith("vscode.executeDocumentSymbolProvider", expect.objectContaining({ fsPath: "/w/src/a.ts" }));
    expect(symbols).toEqual([
      { name: "Thing", kind: "Class", uri: "file:///w/src/a.ts", path: "src/a.ts", range },
      { name: "build", kind: "Method", uri: "file:///w/src/a.ts", path: "src/a.ts", range, containerName: "Thing" },
    ]);
  });

  it("converts SymbolInformation results", async () => {
    vscodeMock.commands.executeCommand.mockResolvedValue([
      { name: "helper", kind: 12, containerName: "Thing", location: { uri: fileUri("/w/src/b.ts"), range: mockRange } },
    ]);
    const api = createVscodeLanguageApi();
    const symbols = await api.documentSymbols("file:///w/src/a.ts");
    expect(symbols).toEqual([
      { name: "helper", kind: "Function", uri: "file:///w/src/b.ts", path: "src/b.ts", range, containerName: "Thing" },
    ]);
  });

  it("returns an empty list when the provider answers nothing", async () => {
    vscodeMock.commands.executeCommand.mockResolvedValue(undefined);
    const api = createVscodeLanguageApi();
    await expect(api.documentSymbols("file:///w/src/a.ts")).resolves.toEqual([]);
  });
});

describe("createVscodeLanguageApi workspaceSymbols", () => {
  it("runs the workspace symbol provider with the query", async () => {
    vscodeMock.commands.executeCommand.mockResolvedValue([
      { name: "Thing", kind: 4, location: { uri: fileUri("/w/src/a.ts"), range: mockRange } },
    ]);
    const api = createVscodeLanguageApi();
    const symbols = await api.workspaceSymbols("Thing");
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith("vscode.executeWorkspaceSymbolProvider", "Thing");
    expect(symbols).toEqual([{ name: "Thing", kind: "Class", uri: "file:///w/src/a.ts", path: "src/a.ts", range }]);
  });
});

describe("createVscodeLanguageApi definitions", () => {
  it("converts Location results", async () => {
    vscodeMock.commands.executeCommand.mockResolvedValue([{ uri: fileUri("/w/src/a.ts"), range: mockRange }]);
    const api = createVscodeLanguageApi();
    const locations = await api.definitions("file:///w/src/b.ts", { line: 4, character: 6 });
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith("vscode.executeDefinitionProvider", expect.anything(), { line: 4, character: 6 });
    expect(locations).toEqual([{ uri: "file:///w/src/a.ts", path: "src/a.ts", range }]);
  });

  it("converts a single Location result", async () => {
    vscodeMock.commands.executeCommand.mockResolvedValue({ uri: fileUri("/w/src/a.ts"), range: mockRange });
    const api = createVscodeLanguageApi();
    const locations = await api.definitions("file:///w/src/b.ts", { line: 0, character: 0 });
    expect(locations).toEqual([{ uri: "file:///w/src/a.ts", path: "src/a.ts", range }]);
  });

  it("converts LocationLink results using the selection range", async () => {
    const targetRange = { start: { line: 10, character: 0 }, end: { line: 20, character: 0 } };
    const selectionRange = { start: { line: 10, character: 6 }, end: { line: 10, character: 15 } };
    vscodeMock.commands.executeCommand.mockResolvedValue([
      { targetUri: fileUri("/w/src/a.ts"), targetRange, targetSelectionRange: selectionRange },
    ]);
    const api = createVscodeLanguageApi();
    const locations = await api.definitions("file:///w/src/b.ts", { line: 0, character: 0 });
    expect(locations).toEqual([{ uri: "file:///w/src/a.ts", path: "src/a.ts", range: selectionRange }]);
  });
});

describe("createVscodeLanguageApi references", () => {
  it("converts Location arrays", async () => {
    vscodeMock.commands.executeCommand.mockResolvedValue([
      { uri: fileUri("/w/src/a.ts"), range: mockRange },
      { uri: fileUri("/w/src/c.ts"), range: mockRange },
    ]);
    const api = createVscodeLanguageApi();
    const references = await api.references("file:///w/src/a.ts", { line: 1, character: 2 });
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith("vscode.executeReferenceProvider", expect.anything(), { line: 1, character: 2 });
    expect(references).toHaveLength(2);
    expect(references[1]).toEqual({ uri: "file:///w/src/c.ts", path: "src/c.ts", range });
  });
});

describe("createVscodeLanguageApi diagnostics", () => {
  it("reads live diagnostics with severity names", async () => {
    vscodeMock.languages.getDiagnostics.mockReturnValue([
      { severity: 0, source: "tsc", range: mockRange, message: "boom" },
      { severity: 1, range: mockRange, message: "careful" },
    ]);
    const api = createVscodeLanguageApi();
    const diagnostics = await api.diagnostics("file:///w/src/a.ts");
    expect(vscodeMock.languages.getDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ fsPath: "/w/src/a.ts" }));
    expect(diagnostics).toEqual([
      { uri: "file:///w/src/a.ts", path: "src/a.ts", range, severity: "Error", source: "tsc", message: "boom" },
      { uri: "file:///w/src/a.ts", path: "src/a.ts", range, severity: "Warning", message: "careful" },
    ]);
  });
});

describe("createVscodeLanguageApi textSearch", () => {
  const jsonLine = (data: object): string => `${JSON.stringify({ type: "match", data })}\n`;

  it("runs rg with --json, the max count and the query, and parses match lines", async () => {
    const rg = vi.fn(async (): Promise<ExecResult> => ({
      ok: true,
      stdout:
        jsonLine({ path: { text: "src/a.ts" }, line_number: 5, submatches: [{ start: 2, end: 10 }], lines: { text: "  const x = makeThing();\n" } }) +
        jsonLine({ path: { text: "src/b.ts" }, line_number: 1, submatches: [{ start: 0, end: 9 }], lines: { text: "makeThing()" } }),
    }));
    const api = createVscodeLanguageApi({ cwd: "/w", rg });
    const matches = await api.textSearch("makeThing", { maxResults: 50 });
    expect(rg).toHaveBeenCalledWith(["--json", "--max-count", "50", "--", "makeThing"], "/w");
    expect(matches).toEqual([
      { uri: "file:///w/src/a.ts", path: "src/a.ts", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } }, preview: "  const x = makeThing();\n" },
      { uri: "file:///w/src/b.ts", path: "src/b.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }, preview: "makeThing()" },
    ]);
  });

  it("drops absolute paths and paths outside the workspace", async () => {
    const rg = vi.fn(async (): Promise<ExecResult> => ({
      ok: true,
      stdout:
        jsonLine({ path: { text: "/etc/hosts" }, line_number: 1, submatches: [{ start: 0, end: 1 }], lines: { text: "x" } }) +
        jsonLine({ path: { text: "../outside.ts" }, line_number: 1, submatches: [{ start: 0, end: 1 }], lines: { text: "x" } }) +
        jsonLine({ path: { text: "kept.ts" }, line_number: 1, submatches: [{ start: 0, end: 1 }], lines: { text: "x" } }),
    }));
    const api = createVscodeLanguageApi({ cwd: "/w", rg });
    const matches = await api.textSearch("x", { maxResults: 50 });
    expect(matches.map((m) => m.path)).toEqual(["kept.ts"]);
  });

  it("skips non-match lines and malformed lines", async () => {
    const rg = vi.fn(async (): Promise<ExecResult> => ({
      ok: true,
      stdout: `${JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } })}\nnot json\n${jsonLine({ path: { text: "a.ts" }, line_number: 2, submatches: [{ start: 0, end: 1 }], lines: { text: "x" } })}`,
    }));
    const api = createVscodeLanguageApi({ cwd: "/w", rg });
    const matches = await api.textSearch("x", { maxResults: 50 });
    expect(matches).toHaveLength(1);
  });

  it("throws with code ENOENT when rg is missing", async () => {
    const rg = vi.fn(async (): Promise<ExecResult> => ({ ok: false, code: "ENOENT", stderr: "spawn rg ENOENT" }));
    const api = createVscodeLanguageApi({ cwd: "/w", rg });
    await expect(api.textSearch("x", { maxResults: 50 })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws with the code and stderr on other rg failures", async () => {
    const rg = vi.fn(async (): Promise<ExecResult> => ({ ok: false, code: undefined, stderr: "unrecognized flag" }));
    const api = createVscodeLanguageApi({ cwd: "/w", rg });
    await expect(api.textSearch("x", { maxResults: 50 })).rejects.toThrow("unrecognized flag");
  });
});

describe("createVscodeLanguageApi probe and openDocuments", () => {
  const openDoc = { uri: fileUri("/w/src/a.ts"), version: 1 };

  it("returns null with no open document for the uri", async () => {
    const api = createVscodeLanguageApi();
    await expect(api.probe("file:///w/src/a.ts")).resolves.toBeNull();
  });

  it("probes every provider once and caches by uri@version", async () => {
    vscodeMock.workspace.textDocuments = [openDoc];
    vscodeMock.commands.executeCommand.mockResolvedValue([]);
    vscodeMock.languages.getDiagnostics.mockReturnValue([]);
    const api = createVscodeLanguageApi();
    const capabilities = await api.probe("file:///w/src/a.ts");
    expect(capabilities).toEqual({ documentSymbols: true, workspaceSymbols: true, definitions: true, references: true, diagnostics: true });
    const firstCalls = vscodeMock.commands.executeCommand.mock.calls.length;
    await api.probe("file:///w/src/a.ts");
    expect(vscodeMock.commands.executeCommand.mock.calls.length).toBe(firstCalls);
    // A new document version invalidates the cache entry.
    vscodeMock.workspace.textDocuments = [{ ...openDoc, version: 2 }];
    await api.probe("file:///w/src/a.ts");
    expect(vscodeMock.commands.executeCommand.mock.calls.length).toBeGreaterThan(firstCalls);
  });

  it("threads the signal through the probe and treats a null probe as unavailable", async () => {
    vscodeMock.workspace.textDocuments = [openDoc];
    vscodeMock.commands.executeCommand.mockResolvedValue([]);
    vscodeMock.languages.getDiagnostics.mockReturnValue([]);
    const controller = new AbortController();
    controller.abort();
    const api = createVscodeLanguageApi();
    await expect(api.probe("file:///w/src/a.ts", controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("lists open file documents with POSIX relative paths", () => {
    vscodeMock.workspace.textDocuments = [openDoc, { uri: { scheme: "untitled", fsPath: "Untitled-1", toString: () => "untitled:Untitled-1" }, version: 3 }];
    const api = createVscodeLanguageApi();
    expect(api.openDocuments()).toEqual([{ uri: "file:///w/src/a.ts", path: "src/a.ts" }]);
  });
});

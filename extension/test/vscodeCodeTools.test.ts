// Ticket #37: the thin VS Code adapter. This is the only test allowed to
// mock the vscode platform module.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecResult } from "../src/exec";
import { createVscodeCodeTools } from "../src/vscodeCodeTools";

type FakeUri = { scheme: string; fsPath: string; toString: () => string };
const fileUri = (fsPath: string): FakeUri => ({ scheme: "file", fsPath, toString: () => `file://${fsPath}` });

const vscodeMock = vi.hoisted(() => {
  const SymbolKind = { File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13 } as Record<number | string, string | number>;
  for (const [name, value] of Object.entries({ File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13 })) SymbolKind[value as number] = name;
  const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as Record<number | string, string | number>;
  for (const [name, value] of Object.entries({ Error: 0, Warning: 1, Information: 2, Hint: 3 })) DiagnosticSeverity[value as number] = name;
  return {
    Uri: {
      parse: (value: string): FakeUri => ({ scheme: value.split(":")[0], fsPath: decodeURIComponent(value.replace(/^file:\/\//, "")), toString: () => value }),
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
      workspaceFolders: [{ uri: { scheme: "file", fsPath: "/w", toString: () => "file:///w" } }] as Array<{ uri: FakeUri }> | undefined,
      findFiles: vi.fn(),
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
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };

beforeEach(() => {
  vscodeMock.commands.executeCommand.mockReset();
  vscodeMock.languages.getDiagnostics.mockReset();
  vscodeMock.workspace.findFiles.mockReset();
});

describe("createVscodeCodeTools documentSymbols", () => {
  it("flattens DocumentSymbols into LSP SymbolInformation records with mapped kinds", async () => {
    vscodeMock.commands.executeCommand.mockResolvedValue([
      {
        name: "Thing",
        kind: 4,
        range: mockRange,
        selectionRange: mockRange,
        children: [{ name: "build", kind: 5, range: mockRange, selectionRange: mockRange, children: [] }],
      },
    ]);
    const api = createVscodeCodeTools({ cwd: "/w" });
    const symbols = await api.documentSymbols({ textDocument: { uri: "file:///w/src/a.ts" } }, token);
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith("vscode.executeDocumentSymbolProvider", expect.objectContaining({ fsPath: "/w/src/a.ts" }));
    expect(symbols).toEqual([
      { name: "Thing", kind: 5, location: { uri: "file:///w/src/a.ts", range } },
      { name: "build", kind: 6, location: { uri: "file:///w/src/a.ts", range }, containerName: "Thing" },
    ]);
  });

  it("converts SymbolInformation results and returns empty for undefined", async () => {
    vscodeMock.commands.executeCommand.mockResolvedValue([
      { name: "helper", kind: 11, containerName: "Thing", location: { uri: fileUri("/w/src/b.ts"), range: mockRange } },
    ]);
    const api = createVscodeCodeTools({ cwd: "/w" });
    const symbols = await api.documentSymbols({ textDocument: { uri: "file:///w/src/a.ts" } }, token);
    expect(symbols).toEqual([{ name: "helper", kind: 12, location: { uri: "file:///w/src/b.ts", range }, containerName: "Thing" }]);

    vscodeMock.commands.executeCommand.mockResolvedValue(undefined);
    await expect(api.documentSymbols({ textDocument: { uri: "file:///w/src/a.ts" } }, token)).resolves.toEqual([]);
  });
});

describe("createVscodeCodeTools workspaceSymbols and locations", () => {
  it("converts workspace symbols", async () => {
    vscodeMock.commands.executeCommand.mockResolvedValue([{ name: "Thing", kind: 4, location: { uri: fileUri("/w/src/a.ts"), range: mockRange } }]);
    const api = createVscodeCodeTools({ cwd: "/w" });
    const symbols = await api.workspaceSymbols({ query: "Thing" }, token);
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith("vscode.executeWorkspaceSymbolProvider", "Thing");
    expect(symbols).toEqual([{ name: "Thing", kind: 5, location: { uri: "file:///w/src/a.ts", range } }]);
  });

  it("normalizes Location, arrays, and LocationLink results", async () => {
    const api = createVscodeCodeTools({ cwd: "/w" });
    vscodeMock.commands.executeCommand.mockResolvedValue({ uri: fileUri("/w/src/a.ts"), range: mockRange });
    await expect(api.definitions({ textDocument: { uri: "file:///w/src/b.ts" }, position: { line: 0, character: 0 } }, token)).resolves.toEqual([
      { uri: "file:///w/src/a.ts", range },
    ]);

    const selection = { start: { line: 10, character: 6 }, end: { line: 10, character: 15 } };
    vscodeMock.commands.executeCommand.mockResolvedValue([{ targetUri: fileUri("/w/src/a.ts"), targetRange: mockRange, targetSelectionRange: selection }]);
    await expect(api.definitions({ textDocument: { uri: "file:///w/src/b.ts" }, position: { line: 0, character: 0 } }, token)).resolves.toEqual([
      { uri: "file:///w/src/a.ts", range: selection },
    ]);
  });

  it("passes the reference context and returns locations", async () => {
    vscodeMock.commands.executeCommand.mockResolvedValue([{ uri: fileUri("/w/src/a.ts"), range: mockRange }]);
    const api = createVscodeCodeTools({ cwd: "/w" });
    const references = await api.references(
      { textDocument: { uri: "file:///w/src/a.ts" }, position: { line: 1, character: 2 }, context: { includeDeclaration: true } },
      token,
    );
    expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith("vscode.executeReferenceProvider", expect.anything(), { line: 1, character: 2 });
    expect(references).toEqual([{ uri: "file:///w/src/a.ts", range }]);
  });
});

describe("createVscodeCodeTools diagnostics and files", () => {
  it("maps VS Code diagnostics to LSP severities", async () => {
    vscodeMock.languages.getDiagnostics.mockReturnValue([
      { severity: 0, source: "tsc", range: mockRange, message: "boom" },
      { severity: 1, range: mockRange, message: "careful" },
    ]);
    const api = createVscodeCodeTools({ cwd: "/w" });
    const diagnostics = await api.diagnostics("file:///w/src/a.ts", token);
    expect(vscodeMock.languages.getDiagnostics).toHaveBeenCalledWith(expect.objectContaining({ fsPath: "/w/src/a.ts" }));
    expect(diagnostics).toEqual([
      { range, severity: 1, source: "tsc", message: "boom" },
      { range, severity: 2, message: "careful" },
    ]);
  });

  it("lists workspace files through findFiles", async () => {
    vscodeMock.workspace.findFiles.mockResolvedValue([fileUri("/w/src/a.ts"), fileUri("/w/credentials.json")]);
    const api = createVscodeCodeTools({ cwd: "/w" });
    if (!api.workspaceFiles) throw new Error("workspaceFiles missing");
    await expect(api.workspaceFiles(token)).resolves.toEqual(["src/a.ts", "credentials.json"]);
  });

  it("resolves paths and URIs inside the root", () => {
    const api = createVscodeCodeTools({ cwd: "/w" });
    expect(api.uriOf("src/a.ts")).toBe("file:///w/src/a.ts");
    expect(api.pathOf("file:///w/src/a.ts")).toBe("src/a.ts");
    expect(api.uriOf("/etc/passwd")).toBeUndefined();
    expect(api.pathOf("untitled:1")).toBeUndefined();
  });
});

describe("createVscodeCodeTools text search", () => {
  const jsonLine = (data: object): string => `${JSON.stringify({ type: "match", data })}\n`;

  it("scopes rg to the existing paths and returns the complete match list", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-rg-"));
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src/a.ts"), "needle a\n");
    await fs.writeFile(path.join(dir, "src/b.ts"), "needle b\n");
    const matchesIn = (file: string, count: number): string =>
      Array.from({ length: count }, (_, i) =>
        jsonLine({ path: { text: file }, line_number: i + 1, submatches: [{ start: 0, end: 6 }], lines: { text: "needle" } }),
      ).join("");
    // 30 matches in src/a.ts and 21 in src/b.ts: 51 in total, one path stale.
    const stdout = matchesIn("src/a.ts", 30) + matchesIn("src/b.ts", 21);
    const rg = vi.fn(async (): Promise<ExecResult> => ({ ok: true, stdout }));
    const api = createVscodeCodeTools({ cwd: dir, rgPath: "/rg", runRipgrep: rg });
    const matches = await api.search("needle", { paths: ["src/a.ts", "src/gone.ts", "src/b.ts"] });
    expect(rg).toHaveBeenCalledWith("/rg", ["--json", "--max-count", "50", "--", "needle", "src/a.ts", "src/b.ts"], dir);
    expect(matches).toHaveLength(51);
  });

  it("runs the bundled binary with --json and parses matches", async () => {
    const rg = vi.fn(async (): Promise<ExecResult> => ({
      ok: true,
      stdout:
        jsonLine({ path: { text: "src/a.ts" }, line_number: 5, submatches: [{ start: 2, end: 10 }], lines: { text: "  const x = makeThing();\n" } }) +
        jsonLine({ path: { text: "src/b.ts" }, line_number: 1, submatches: [{ start: 0, end: 9 }], lines: { text: "makeThing()" } }),
    }));
    const api = createVscodeCodeTools({ cwd: "/w", rgPath: "/w/dist/rg", runRipgrep: rg });
    const matches = await api.search("makeThing", {});
    expect(rg).toHaveBeenCalledWith("/w/dist/rg", ["--json", "--max-count", "50", "--", "makeThing", "."], "/w");
    expect(matches).toEqual([
      { uri: "file:///w/src/a.ts", path: "src/a.ts", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } }, preview: "  const x = makeThing();\n" },
      { uri: "file:///w/src/b.ts", path: "src/b.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } }, preview: "makeThing()" },
    ]);
  });

  it("maps a missing binary to ENOENT", async () => {
    const rg = vi.fn(async (): Promise<ExecResult> => ({ ok: false, code: "ENOENT", stderr: "spawn rg ENOENT" }));
    const api = createVscodeCodeTools({ cwd: "/w", rgPath: "/w/dist/rg", runRipgrep: rg });
    await expect(api.search("x", {})).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists files through rg --files", async () => {
    const rg = vi.fn(async (): Promise<ExecResult> => ({ ok: true, stdout: "src/a.ts\nsrc/b.ts\n" }));
    const api = createVscodeCodeTools({ cwd: "/w", rgPath: "/w/dist/rg", runRipgrep: rg });
    if (!api.listFiles) throw new Error("listFiles missing");
    await expect(api.listFiles({})).resolves.toEqual(["src/a.ts", "src/b.ts"]);
    expect(rg).toHaveBeenCalledWith("/w/dist/rg", ["--files"], "/w");
  });
});
